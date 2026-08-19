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
	memory?: string;
	cpus?: string;
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
}

/**
 * 容器执行后端。
 *
 * 安全设置与 deploy/sandbox.yaml 一一对应，两处必须同步改：
 * 只读根、非 root、丢弃全部 capability、禁止提权、独占工作区。
 *
 * **挂载的只有工作区与 HOME**，宿主机其余部分（含网关自身的代码、
 * 审计日志、策略文件）在容器里根本不存在 —— 这正是 local 后端给不了的。
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
		const name = containerName(ctx.sessionId);

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
			"10001:10001",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
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
			// 只读根意味着这些可写目录要显式给
			"--tmpfs",
			"/tmp:rw,size=2g",
			"-w",
			workdir,
			"-e",
			`HOME=${home}`,
		];

		// 容器内的策略文件路径。ctx.env 里若带了宿主机路径，必须被覆盖掉 ——
		// 扩展会在容器里 readFileSync 它，宿主机路径在容器里不存在。
		const containerEnv = {
			...this.#opts.env,
			...ctx.env,
			PERIMETER_POLICY_FILE: `${mountRoot}/config/policy.yaml`,
		};
		for (const [k, v] of Object.entries(containerEnv)) {
			if (v !== undefined) args.push("-e", `${k}=${v}`);
		}
		if (this.#opts.memory) args.push("--memory", this.#opts.memory);
		if (this.#opts.cpus) args.push("--cpus", this.#opts.cpus);
		args.push(...(this.#opts.extraArgs ?? []));
		args.push(this.#opts.image, "pi");

		return {
			bin: "docker",
			argsPrefix: args,
			// 环境变量已经经 -e 进了容器，宿主机侧的 docker 客户端不需要
			env: {},
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
			await exec("docker", ["rm", "-f", containerName(sessionId)]);
		} catch {
			// 容器已不存在是正常路径（正常退出时 --rm 已经收掉了）
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

/** 容器名必须可预测，才能在 pi 意外退出后找回来清理 */
export function containerName(sessionId: string): string {
	return `perimeter-${sessionId}`;
}
