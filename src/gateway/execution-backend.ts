import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface LaunchContext {
	sessionId: string;
	/** 宿主机上的工作区路径 */
	workspace: string;
	/**
	 * 宿主机上的沙箱 HOME（接线生成的，在 workspace 之外）。
	 * 没有接线时为 undefined —— 那种情况下不该覆盖调用方给的 HOME。
	 */
	home?: string;
	/** 宿主机上的策略扩展路径 */
	extensionPath: string;
	/** 宿主机上的策略文件路径 */
	policyFile: string;
	/** 要传进沙箱的环境变量（策略上下文等） */
	env: NodeJS.ProcessEnv;
}

export interface Launch {
	bin: string;
	/** 排在 pi 自身参数之前的前缀，如 `docker run … image pi` */
	argsPrefix: string[];
	/** pi 进程可见的环境变量。容器后端里由 -e 传入，这里返回空 */
	env: NodeJS.ProcessEnv;
	/** 容器内的工作区路径。策略引擎的路径规则按它来 */
	cwd: string;
	/** 容器内的 HOME */
	homeInContainer: string;
	/** 容器内的策略扩展路径 */
	extensionPath: string;
	/** 容器内的策略文件路径 */
	policyFile: string;
}

/**
 * 「pi 进程在哪儿跑」的抽象。
 *
 * PiSession 早就把 bin 与参数前缀设计成可替换的，这一层把那个口子用起来：
 * - `local`：直接 spawn，**没有任何隔离**。开发与 demo 默认，不是生产形态。
 * - `docker`：容器隔离，本机可验证（文件系统、身份、能力、网络）。
 * - `kubectl`：生产形态，`kubectl exec` 进预先创建的 Pod。
 *
 * 三者的差别只在「怎么启动一个 pi」，因此上层（策略、审批、审计、协议）
 * 完全不感知。
 */
export interface ExecutionBackend {
	readonly kind: "local" | "docker" | "kubectl";
	launch(ctx: LaunchContext): Launch;
	/** 会话结束后的清理。local 无需清理；docker 要收容器 */
	cleanup?(sessionId: string): Promise<void>;
}

/** 直接在网关宿主机上跑。**没有隔离** —— agent 与网关同一个 OS 用户。 */
export class LocalBackend implements ExecutionBackend {
	readonly kind = "local" as const;
	#env: NodeJS.ProcessEnv;

	constructor(env: NodeJS.ProcessEnv = {}) {
		this.#env = env;
	}

	launch(ctx: LaunchContext): Launch {
		return {
			bin: "pi",
			argsPrefix: [],
			// 只在接线真的生成了 HOME 时才覆盖：没有接线时调用方给的 HOME
			// 才是 pi 读 models.json 的地方
			// 策略文件路径由后端决定：扩展在 pi 进程里 readFileSync 它，
			// 传宿主机路径进容器就是 ENOENT
			env: { ...this.#env, ...ctx.env, PERIMETER_POLICY_FILE: ctx.policyFile, ...(ctx.home ? { HOME: ctx.home } : {}) },
			cwd: ctx.workspace,
			homeInContainer: ctx.home ?? ctx.workspace,
			extensionPath: ctx.extensionPath,
			policyFile: ctx.policyFile,
		};
	}
}

export interface DockerBackendOptions {
	image: string;
	/**
	 * 容器网络。默认 `bridge` —— 这样容器能访问宿主机上的模型网关与 git 代理。
	 *
	 * **要真正落地「egress 默认 deny」，生产上应当用一个 internal 网络**
	 * （`docker network create --internal`）并把两个代理也放进去：
	 * internal 网络禁止出公网，容器只能访问网络内的服务。
	 * 传 `none` 则完全无网络 —— 可以用来验证阻断确实生效，但那样连模型
	 * 网关也访问不到，只适合做隔离性验证而非跑真实会话。
	 */
	network?: string;
	/** 容器内的工作区挂载点 */
	workdir?: string;
	/** 额外的 docker run 参数 */
	extraArgs?: string[];
	/** 默认 4g。不设上限等于把宿主机内存交给 agent */
	memory?: string;
	/** 默认 2 */
	cpus?: string;
	/** 默认 512，挡 fork bomb */
	pidsLimit?: number;
	/**
	 * 容器内的运行身份，形如 "1000:1000"。
	 *
	 * 默认取**网关自己的 uid/gid**，而不是镜像里那个固定的 10001。原因：
	 * Linux 的 bind mount 保留宿主机属主，而工作区与沙箱 HOME 是网关以
	 * 自己的身份创建的 —— 容器里换成 10001 就写不进去，pi 起不来或第一次
	 * 写文件就 EACCES。macOS 的 Docker Desktop / OrbStack 做属主重映射，
	 * 所以这个坑在本机测不出来，只在真实部署的 Linux 上炸。
	 *
	 * K8s 那侧不存在这个问题：用的是 emptyDir + fsGroup，见 deploy/sandbox.yaml。
	 *
	 * 网关以 root 运行时会回退到 10001 —— root 建的目录 10001 同样写不了，
	 * 那种部署必须由部署侧保证属主（或让网关别用 root 跑）。
	 */
	user?: string;
	env?: NodeJS.ProcessEnv;
	/**
	 * 仓库根。策略扩展跑在 pi 进程内，而 pi 在容器里 —— 扩展代码必须
	 * 进得去，否则整个钩子级拦截失效。只挂它需要的三个子树，**只读**：
	 * src/（扩展与它 import 的策略引擎、协议层）、config/（策略文件）、
	 * node_modules/（yaml 依赖）。
	 *
	 * 刻意不整仓挂载：audit-data/ 与 workspaces/ 都在仓库里，
	 * 挂进去等于让 agent 读到审计日志和别的会话的工作区。
	 */
	repoRoot: string;
	/**
	 * 本网关实例的标识，进容器名与 label。
	 *
	 * 两个作用：① 容器名去重 —— sessionId 由客户端指定，两个网关共用一个
	 * docker daemon 时，A 的 cleanup 会杀掉 B 的同名容器；② 孤儿回收 ——
	 * 网关被 SIGKILL 时容器会残留（--rm 只保证退出后删记录，不保证退出），
	 * 下次启动按 label 一次扫净。
	 */
	gatewayId?: string;
	/** 清理失败时的告警通道。吞掉错误等于让容器静默泄漏 */
	onCleanupError?: (sessionId: string, err: unknown) => void;
}

/**
 * 容器执行后端。
 *
 * 与 deploy/sandbox.yaml 对应的是**下列五项**，改动要同步：
 * 只读根、非 root(10001)、丢弃全部 capability、禁止提权、独占工作区。
 * 两侧刻意不同的部分：gVisor runtimeClass（K8s 有、docker 没有）、
 * 资源上限的表达方式、会话生命周期上限、以及挂载面 ——
 * K8s 只挂一个 policy configMap，docker 这边为了让扩展跑起来挂了三个子树。
 *
 * 挂进容器的是：工作区、沙箱 HOME，以及策略扩展所需的 src/、config/、
 * node_modules/（只读）。宿主机其余部分 —— 尤其是**审计日志与其他会话的
 * 工作区** —— 在容器里不存在，这是 local 后端给不了的。
 *
 * ⚠️ **bind mount 的属主语义在 Linux 与 macOS 上不同**：Linux 保留宿主机
 * 属主，而网关是以自己的 uid 建的工作区与 HOME，容器里的 10001 会写不进去；
 * macOS 的 Docker Desktop / OrbStack 做属主重映射所以本机看不出来。
 * 因此工作区与 HOME 在创建后要 chown 到容器 uid（见 CONTAINER_UID）。
 */
export class DockerBackend implements ExecutionBackend {
	readonly kind = "docker" as const;
	#opts: DockerBackendOptions;

	constructor(opts: DockerBackendOptions) {
		this.#opts = opts;
	}

	launch(ctx: LaunchContext): Launch {
		const workdir = this.#opts.workdir ?? "/workspace";
		const home = "/home/agent";
		const name = containerName(ctx.sessionId, this.#opts.gatewayId);

		const mountRoot = "/opt/perimeter";
		const args = [
			"run",
			"--rm",
			// -i 保持 stdin 打开：RPC 协议全靠它喂命令
			"-i",
			"--name",
			name,
			"--network",
			this.#opts.network ?? "bridge",
			// 与 deploy/sandbox.yaml 对齐的收紧项
			"--read-only",
			"--user",
			this.#opts.user ?? defaultContainerUser(),
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			// 孤儿回收的抓手：网关被 SIGKILL 后容器会残留，下次启动按它扫净
			"--label",
			`perimeter.gateway=${this.#opts.gatewayId ?? "default"}`,
			// 只挂工作区与 HOME；宿主机其余部分在容器里不存在
			"-v",
			`${ctx.workspace}:${workdir}`,
			...(ctx.home ? ["-v", `${ctx.home}:${home}`] : []),
			// 策略扩展与它的依赖，只读。没有这三个挂载，容器里就没有
			// tool_call 钩子 —— 钩子级拦截是产品的核心卖点。
			"-v",
			`${this.#opts.repoRoot}/src:${mountRoot}/src:ro`,
			"-v",
			`${this.#opts.repoRoot}/config:${mountRoot}/config:ro`,
			"-v",
			`${this.#opts.repoRoot}/node_modules:${mountRoot}/node_modules:ro`,
			// 只读根意味着这些可写目录要显式给。
			// noexec/nosuid/nodev 与 no-new-privileges 配套；size 不能太大 ——
			// tmpfs 写入直接算宿主机内存，没有 memory 上限时是一条 DoS 路径。
			"--tmpfs",
			"/tmp:rw,noexec,nosuid,nodev,size=512m",
			// 没有 wiring 时不挂 HOME，而根是只读的 —— 镜像里的 /home/agent
			// 写不进去，pi 写自身状态就失败。给一块 tmpfs 兜住。
			...(ctx.home ? [] : ["--tmpfs", `${home}:rw,nosuid,nodev,size=64m`]),
			"-w",
			workdir,
			"-e",
			`HOME=${home}`,
		];

		// 容器内的策略文件路径。ctx.env 里若带了宿主机路径，必须被覆盖掉 ——
		// 扩展会在容器里 readFileSync 它，宿主机路径在容器里不存在。
		const containerEnv: NodeJS.ProcessEnv = {
			...this.#opts.env,
			...ctx.env,
			PERIMETER_POLICY_FILE: `${mountRoot}/config/policy.yaml`,
		};
		// 用 `-e KEY`（不带值）而不是 `-e KEY=VALUE`：后者把值写进 argv，
		// 同机其他用户 `ps aux` 就能看到。当前这五个变量都不敏感，但
		// K8s 那侧的等价配置里是有会话 token 的（secretKeyRef），
		// 这个写法能保证以后有人往里加 token 时不会静默泄漏。
		// 注意：`docker inspect` 仍会留存值，要彻底避免只能走文件（如 models.json）。
		for (const k of Object.keys(containerEnv)) {
			if (containerEnv[k] !== undefined) args.push("-e", k);
		}
		// 上限必须有默认值。做成「可选项、不传就无限制」的话，一句
		// `dd if=/dev/zero of=/tmp/x` 就能吃掉宿主机内存，把网关和其他
		// 所有会话一起 OOM 掉 —— 对照 sandbox.yaml 是写死了 limits 的。
		args.push("--memory", this.#opts.memory ?? "4g");
		args.push("--cpus", this.#opts.cpus ?? "2");
		args.push("--pids-limit", String(this.#opts.pidsLimit ?? 512));
		args.push("--ulimit", "nofile=4096:8192");
		args.push(...(this.#opts.extraArgs ?? []));
		args.push(this.#opts.image, "pi");

		return {
			bin: "docker",
			argsPrefix: args,
			// `-e KEY` 从 docker 客户端自己的环境取值，所以这里必须把它们给出来
			env: containerEnv,
			cwd: ctx.workspace,
			homeInContainer: home,
			extensionPath: `${mountRoot}/src/gateway/policy-extension.ts`,
			policyFile: `${mountRoot}/config/policy.yaml`,
		};
	}

	/**
	 * 杀掉容器。**这是必需的，不是兜底**：`--rm` 只负责容器退出后删除记录，
	 * 而杀掉宿主机上的 docker 客户端进程并不会让容器内的进程收到信号 ——
	 * 容器会继续跑、stdio 管道不关，等它的一方就永远等下去。
	 */
	async cleanup(sessionId: string): Promise<void> {
		try {
			// 必须带超时：daemon 卡住时没有超时会让 Gateway.close() 永久挂起
			await exec("docker", ["rm", "-f", containerName(sessionId, this.#opts.gatewayId)], { timeout: 10_000 });
		} catch (err) {
			// 「容器已不存在」是正常路径（正常退出时 --rm 已经收掉了）；
			// 其余情况意味着容器可能泄漏了，不能和前者一样静默吞掉
			const msg = err instanceof Error ? err.message : String(err);
			if (!/No such container/i.test(msg)) {
				this.#opts.onCleanupError?.(sessionId, err);
			}
		}
	}

	/**
	 * 回收本网关遗留的孤儿容器。启动时调一次。
	 * 网关被 SIGKILL 时来不及走 cleanup，容器会一直跑下去。
	 */
	async reapOrphans(): Promise<string[]> {
		const label = `perimeter.gateway=${this.#opts.gatewayId ?? "default"}`;
		try {
			const { stdout } = await exec("docker", ["ps", "-aq", "--filter", `label=${label}`], { timeout: 10_000 });
			const ids = stdout.split("\n").map((x) => x.trim()).filter(Boolean);
			if (ids.length > 0) await exec("docker", ["rm", "-f", ...ids], { timeout: 30_000 });
			return ids;
		} catch (err) {
			this.#opts.onCleanupError?.("<orphan-scan>", err);
			return [];
		}
	}
}

export interface KubectlBackendOptions {
	/** 预先创建好的 Pod 名模板，`{session}` 会被替换 */
	podTemplate: string;
	namespace?: string;
	container?: string;
}

/**
 * 生产形态：进预先创建的 Pod 执行。
 *
 * **未在真实集群验证过** —— 本地只验证了生成的命令行形状。
 * Pod 的创建/回收（含 gVisor runtimeClass 与 NetworkPolicy 绑定）
 * 由部署侧或后续的编排器负责，本后端只负责「在已存在的 Pod 里起 pi」。
 */
export class KubectlBackend implements ExecutionBackend {
	readonly kind = "kubectl" as const;
	#opts: KubectlBackendOptions;

	constructor(opts: KubectlBackendOptions) {
		this.#opts = opts;
	}

	launch(ctx: LaunchContext): Launch {
		const pod = this.#opts.podTemplate.replace("{session}", ctx.sessionId);
		const args = ["exec", "-i", pod];
		if (this.#opts.namespace) args.push("-n", this.#opts.namespace);
		if (this.#opts.container) args.push("-c", this.#opts.container);
		// `--` 之后才是要在 Pod 里执行的命令
		args.push("--", "pi");
		return {
			bin: "kubectl",
			argsPrefix: args,
			env: {},
			cwd: ctx.workspace,
			homeInContainer: "/home/agent",
			// Pod 里这两个由 deploy/sandbox.yaml 的 configMap 与镜像提供
			extensionPath: "/opt/perimeter/src/gateway/policy-extension.ts",
			policyFile: "/etc/perimeter/policy.yaml",
		};
	}
}

/**
 * 容器内的默认运行身份：网关自己的 uid/gid。
 * 见 DockerBackendOptions.user 里关于 bind mount 属主的说明。
 */
export function defaultContainerUser(): string {
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	// root 或拿不到 uid（Windows）时退回镜像里的固定非 root 用户
	if (uid === undefined || uid === 0) return "10001:10001";
	return `${uid}:${gid ?? uid}`;
}

/**
 * 容器名必须可预测，才能在 pi 意外退出后找回来清理。
 * 带 gatewayId 是为了让共用一个 docker daemon 的两个网关互不干扰 ——
 * sessionId 由客户端指定，不加前缀的话 A 的 cleanup 会杀掉 B 的容器。
 */
export function containerName(sessionId: string, gatewayId?: string): string {
	return gatewayId ? `perimeter-${gatewayId}-${sessionId}` : `perimeter-${sessionId}`;
}
