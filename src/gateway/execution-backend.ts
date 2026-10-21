import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { k8sNameFragment, renderPodManifest } from "../deploy/pod-template.ts";
import { promisify } from "node:util";

import { openEnvironment, type EnvironmentHandle, type EnvironmentPlan } from "../runtime/execution-env.ts";

const exec = promisify(execFile);

/** 容器内的 HOME。必须与 deploy/sandbox.yaml 里 sandbox-home 的 mountPath 一致 */
const CONTAINER_HOME = "/home/agent";

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
	/** 执行环境可见的环境变量。容器后端里由 -e 传入，这里返回空 */
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
 * 「执行环境在哪儿跑」的抽象。
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
	environment?(ctx: LaunchContext): Promise<EnvironmentHandle>;
	/** 会话结束后的清理。local 无需清理；docker 要收容器 */
	cleanup?(sessionId: string): Promise<void>;
	/** 启动时回收上次遗留的容器，返回被回收的 id。local/kubectl 无需实现 */
	reapOrphans?(): Promise<string[]>;
	/**
	 * 会话启动前把沙箱配置送进执行环境。
	 *
	 * local/docker 用不到 —— 它们直接读宿主机目录（bind mount）。
	 * kubectl 必须实现：Pod 的 HOME 是 emptyDir，创建时为空，
	 * 网关没法从外部写它，不送进去就没有 git 代理配置。
	 */
	prepare?(ctx: LaunchContext): Promise<void>;
	/**
	 * 在会话的执行环境里跑一条 shell 命令，返回退出码与输出。
	 *
	 * Golden task suite 的验收步骤靠它。验收命令跑的是 **agent 刚写进工作区的
	 * 代码**，走后端换来的是**隔离** —— docker/kubectl 下它落在沙箱里，
	 * 而不是网关的 OS 用户身份上。
	 *
	 * ⚠️ **这条路径不过策略引擎、不进审计、不受 egress allowlist 约束。**
	 * 它是一个「在沙箱里跑任意 shell」的通用能力，挂在网关自己也持有的接口上。
	 * 今天只有评测的验收步骤调它；再多一处调用方，就要先想清楚那处是不是
	 * 在给 agent 开策略旁路。
	 *
	 * 不抛异常：命令失败（非零退出）是验收的正常结果，不是错误。
	 */
	exec?(sessionId: string, workspace: string, command: string, timeoutMs?: number): Promise<ExecResult>;
}

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * 交给验收命令的环境变量白名单。
 *
 * **不能直接继承 process.env**，主要理由只有一个，但它足够硬：
 *
 * node 的 test runner 会给子进程注入 `NODE_TEST_CONTEXT` 等变量。验收命令里的
 * `node --test` 看到它就以为自己是被托管的子进程，输出改走 IPC、退出码不再
 * 反映测试结果 —— 于是**验收恒真**。任何在 test runner 里跑评测的场合都会
 * 撞上（`npm test` 也算），本机单独手跑 CLI 才看不见。
 *
 * 顺带挡掉网关环境里的上游凭据（模型 key、SCM token），但**别把这当成安全
 * 边界**：白名单里就有 `HOME`，而凭据大多住在 `$HOME` 下；local 后端里验收
 * 命令以网关的 OS 用户身份无隔离运行，`cat ~/.aws/credentials` 一句话的事。
 * 环境变量挡得住，磁盘挡不住。真正的边界是换成 docker / kubectl 后端。
 */
const EXEC_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TZ"] as const;

function minimalEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const merged = { ...process.env, ...base };
	const out: NodeJS.ProcessEnv = {};
	for (const k of EXEC_ENV_KEYS) {
		const v = merged[k];
		if (v !== undefined) out[k] = v;
	}
	return out;
}

/** 超时的退出码。与 GNU timeout 对齐 —— 命令自身极少用到这个值 */
export const TIMEOUT_EXIT = 124;

/**
 * 把 execFile 的失败归一成退出码。
 * 命令返回非零时 execFile 会 reject，而对验收来说那只是「没通过」。
 * 超时另算 —— 它没有有意义的退出码，用 124 与 GNU timeout 对齐。
 */
const OUTPUT_CAP = 8 * 1024 * 1024;

export function safeDockerCmd(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", args, {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { PATH: process.env.PATH, ...dockerClientEnv() },
		});
		let stdout = "";
		let stderr = "";
		let exited = false;
		let timedOut = false;

		child.stdout?.on("data", (d) => { if (stdout.length < OUTPUT_CAP) stdout += d; });
		child.stderr?.on("data", (d) => { if (stderr.length < OUTPUT_CAP) stderr += d; });

		const timer = setTimeout(() => {
			timedOut = true;
			try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch {}
			const killTimer = setTimeout(() => {
				if (!exited) {
					try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {}
				}
			}, 1000);
			killTimer.unref();
		}, timeoutMs);

		child.on("error", (err) => {
			clearTimeout(timer);
			if (!exited) {
				exited = true;
				reject(err);
			}
		});

		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			if (!exited) {
				exited = true;
				if (timedOut) {
					reject(new Error(`docker 调用超时 (${timeoutMs}ms) 强制终结: docker ${args.join(" ")} (signal: ${signal})`));
				} else if (code !== 0) {
					const err = new Error(`docker 调用非零退出 (${code}): ${stderr.trim() || stdout.trim()}`);
					(err as any).code = code;
					(err as any).stdout = stdout;
					(err as any).stderr = stderr;
					reject(err);
				} else {
					resolve({ stdout, stderr });
				}
			}
		});
	});
}

function runCapturing(
	bin: string,
	args: string[],
	timeoutMs: number,
	cwd?: string,
	env?: NodeJS.ProcessEnv,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		// `detached` 把命令放进独立进程组，超时时才能整组杀掉。
		// execFile 的 timeout 只杀直接子进程（这里是 /bin/sh），验收命令
		// fork 出来的孙进程 —— `node --test` 的每个 worker —— 会全部活下来。
		// 评测是反复跑的，每次超时泄漏一批，攒起来能把机器拖垮。
		const child = spawn(bin, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		// 输出要设上限：这条路径上跑的是 agent 写的代码，一个死循环里的
		// console.log 就能把网关的内存吃光
		child.stdout.on("data", (d) => {
			if (stdout.length < OUTPUT_CAP) stdout += d;
		});
		child.stderr.on("data", (d) => {
			if (stderr.length < OUTPUT_CAP) stderr += d;
		});
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				// 负号 = 整个进程组。pid 取不到时退回只杀直接子进程
				if (child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ code: 1, stdout, stderr: stderr || String(err) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: timedOut ? TIMEOUT_EXIT : (code ?? 1), stdout, stderr });
		});
	});
}

/** 直接在网关宿主机上跑。**没有隔离** —— agent 与网关同一个 OS 用户。 */
export class LocalBackend implements ExecutionBackend {
	readonly kind = "local" as const;
	#env: NodeJS.ProcessEnv;

	constructor(env: NodeJS.ProcessEnv = {}) {
		this.#env = env;
	}

	environment(ctx: LaunchContext): Promise<EnvironmentHandle> {
		return openEnvironment({ cwd: ctx.workspace, home: ctx.home });
	}

	launch(ctx: LaunchContext): Launch {
		return {
			bin: "pi-env",
			argsPrefix: [],
			// 只在接线真的生成了 HOME 时才覆盖：没有接线时调用方给的 HOME
			// 才是工具的 HOME
			// 策略文件路径由后端决定：扩展在 执行环境里 readFileSync 它，
			// 传宿主机路径进容器就是 ENOENT
			env: { ...this.#env, ...ctx.env, PERIMETER_POLICY_FILE: ctx.policyFile, ...(ctx.home ? { HOME: ctx.home } : {}) },
			cwd: ctx.workspace,
			homeInContainer: ctx.home ?? ctx.workspace,
			extensionPath: ctx.extensionPath,
			policyFile: ctx.policyFile,
		};
	}

	/**
	 * ⚠️ 在网关宿主机上直接跑 agent 写的代码，**没有任何隔离**。
	 * 与 launch 的处境一样，但后果更集中：评测会反复触发它。
	 * 评测报告因此必须带上 backend 字段，让「这个数字是在无隔离环境下跑的」
	 * 跟着数据走 —— 一个开关拦不住，标注跟得住。
	 */
	async exec(_sessionId: string, workspace: string, command: string, timeoutMs = 120_000): Promise<ExecResult> {
		// cwd 必须是工作区。漏了它，验收命令就在网关自己的仓库根上跑 ——
		// `node --test` 会去跑 perimeter-agent 的测试套件然后报告「任务通过」
		return runCapturing("/bin/sh", ["-c", command], timeoutMs, workspace, minimalEnv(this.#env));
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
	extraArgs?: readonly string[] | string[];
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
	 * 仓库根。策略扩展跑在 执行环境内，而 pi 在容器里 —— 扩展代码必须
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
 * 只读根、非 root、丢弃全部 capability、禁止提权、独占工作区。
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
 * 因此容器身份默认取网关自己的 uid/gid，见 DockerBackendOptions.user。
 */
function isRootUser(u: string): boolean {
	const trimmed = u.trim().toLowerCase();
	if (trimmed === "0" || trimmed === "root") return true;
	const parts = trimmed.split(":");
	return parts.some((p) => p === "0" || p === "root");
}

function validateDockerSecurity(opts: DockerBackendOptions): void {
	if (opts.user && isRootUser(opts.user)) {
		throw new Error("docker 隔离后端绝不能以 root 用户运行");
	}
	if (opts.network === "host") {
		throw new Error("docker 隔离后端禁止使用 host 网络");
	}
	if (opts.extraArgs && opts.extraArgs.length > 0) {
		for (let i = 0; i < opts.extraArgs.length; i++) {
			const arg = opts.extraArgs[i]!;
			const next = opts.extraArgs[i + 1];

			// 1. 特权
			if (arg === "--privileged" || arg.startsWith("--privileged=")) {
				throw new Error("docker extraArgs 包含破坏隔离的安全敏感参数: 禁止 --privileged 特权模式");
			}

			// 2. cap-add
			if (arg === "--cap-add" || arg.startsWith("--cap-add=")) {
				throw new Error("docker extraArgs 包含破坏隔离的安全敏感参数: 禁止 --cap-add 增加 Linux capabilities");
			}

			// 3. 用户身份 (-u, --user)
			let userVal: string | undefined;
			if (arg === "-u" || arg === "--user") {
				userVal = next;
			} else if (arg.startsWith("-u=")) {
				userVal = arg.slice(3);
			} else if (arg.startsWith("--user=")) {
				userVal = arg.slice(7);
			} else if (arg.startsWith("-u") && arg.length > 2 && !arg.includes("=")) {
				userVal = arg.slice(2);
			}
			if (userVal !== undefined && isRootUser(userVal)) {
				throw new Error("docker extraArgs 包含破坏隔离的安全敏感参数: 禁止通过 extraArgs 指定 root 身份");
			}

			// 4. 网络覆盖 (--net, --network)
			if (arg === "--net" || arg === "--network" || arg.startsWith("--net=") || arg.startsWith("--network=")) {
				throw new Error("docker extraArgs 包含破坏隔离的安全敏感参数: 禁止通过 extraArgs 覆盖网络配置");
			}

			// 5. 命名空间 (--pid, --ipc, --uts, --userns)
			for (const ns of ["--pid", "--ipc", "--uts", "--userns"]) {
				let val: string | undefined;
				if (arg === ns) val = next;
				else if (arg.startsWith(`${ns}=`)) val = arg.slice(ns.length + 1);
				if (val && val.toLowerCase() === "host") {
					throw new Error(`docker extraArgs 包含破坏隔离的安全敏感参数: 禁止使用 host ${ns.slice(2).toUpperCase()} 命名空间`);
				}
			}

			// 6. 只读根覆盖 (--read-only=false)
			if (arg === "--read-only=false" || (arg === "--read-only" && next === "false")) {
				throw new Error("docker extraArgs 包含破坏隔离的安全敏感参数: 禁止通过 extraArgs 禁用只读根文件系统");
			}

			// 7. security-opt 削弱
			let secVal: string | undefined;
			if (arg === "--security-opt") secVal = next;
			else if (arg.startsWith("--security-opt=")) secVal = arg.slice(15);
			if (secVal) {
				const lower = secVal.toLowerCase();
				if (lower.includes("no-new-privileges=false") || lower.includes("label=disable") || lower.includes("seccomp=unconfined") || lower.includes("apparmor=unconfined")) {
					throw new Error("docker extraArgs 包含破坏隔离的安全敏感参数: 禁止禁用安全策略或 seccomp/apparmor");
				}
			}

			// 8. 挂载禁用 (-v, --volume, --mount)：挂载面只能由 backend 内部从受信任的 LaunchContext 构造
			if (
				arg === "-v" ||
				arg.startsWith("-v=") ||
				(arg.startsWith("-v") && arg.length > 2 && !arg.startsWith("--")) ||
				arg === "--volume" ||
				arg.startsWith("--volume=") ||
				arg === "--mount" ||
				arg.startsWith("--mount=")
			) {
				throw new Error("docker extraArgs 包含破坏隔离的安全敏感参数: 禁止通过 extraArgs 指定任何自定义挂载 (-v, --volume, --mount)");
			}

			// 9. 容器名覆盖 (--name)
			if (arg === "--name" || arg.startsWith("--name=")) {
				throw new Error("docker extraArgs 包含破坏隔离的安全敏感参数: 禁止通过 extraArgs 覆盖容器名称");
			}
		}
	}
}

export class DockerBackend implements ExecutionBackend {
	readonly kind = "docker" as const;
	readonly #opts: Readonly<DockerBackendOptions>;

	#gatewayId: string;
	#verifiedNetworkId?: string;

	constructor(opts: DockerBackendOptions) {
		validateDockerSecurity(opts);
		this.#opts = Object.freeze({
			...opts,
			extraArgs: Object.freeze([...(opts.extraArgs ?? [])]),
			env: Object.freeze({ ...(opts.env ?? {}) }),
		});
		// 必须可区分到实例。恒为 "default" 的话，reapOrphans 会按 label
		// 扫掉另一个网关**正在跑**的容器 —— 正是 gatewayId 要防的那件事。
		this.#gatewayId = this.#opts.gatewayId ?? `${hostname()}-${process.pid}`;
	}

	bindVerifiedNetwork(id: string): void {
		if (!id || typeof id !== "string" || !id.trim()) {
			throw new Error("绑定网络失败: networkId 必须为有效非空字符串");
		}
		this.#verifiedNetworkId = id.trim();
	}

	get verifiedNetworkId(): string | undefined {
		return this.#verifiedNetworkId;
	}

	get network(): string {
		return this.#opts.network ?? "bridge";
	}

	get options(): DockerBackendOptions {
		return this.#opts;
	}

	environmentPlan(ctx: LaunchContext): EnvironmentPlan {
		const launch = this.launch({ ...ctx, env: {} });
		const args = [...launch.argsPrefix];
		args[args.indexOf("-i")] = "-d";
		for (let i = args.length - 1; i >= 0; i--) {
			if (args[i] === "-v" && args[i + 1]?.includes(":/opt/perimeter/")) args.splice(i, 2);
			if (args[i] === "-e" && !args[i + 1]?.startsWith("HOME=")) args.splice(i, 2);
		}
		args.splice(-1, 1, "/bin/sh", "-c", "while :; do sleep 3600; done");
		return { cwd: this.#opts.workdir ?? "/workspace", command: ["docker", "exec", "-i", containerName(ctx.sessionId, this.#gatewayId), "pi-env"],
			// 与 safeDockerCmd 同口径：client 需 PATH 才能解析 docker 可执行文件（仅限 host 侧 client 环境；
			// 容器内环境仍由 args 严格构造，不继承网关进程环境）。
			start: { bin: "docker", args, env: { PATH: process.env.PATH, ...dockerClientEnv() } } };
	}

	environment(ctx: LaunchContext): Promise<EnvironmentHandle> {
		return openEnvironment(this.environmentPlan(ctx));
	}

	launch(ctx: LaunchContext): Launch {
		const workdir = this.#opts.workdir ?? "/workspace";
		const home = CONTAINER_HOME;
		const name = containerName(ctx.sessionId, this.#gatewayId);
		const targetNetwork = this.#verifiedNetworkId ?? (this.#opts.network === "none" ? "none" : (this.#opts.network ?? "bridge"));

		const mountRoot = "/opt/perimeter";
		const args = [
			"run",
			"--rm",
			// -i 保持 stdin 打开：RPC 协议全靠它喂命令
			"-i",
			"--name",
			name,
			"--network",
			targetNetwork,
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
			`perimeter.gateway=${this.#gatewayId}`,
			// 只挂工作区与 HOME；宿主机其余部分在容器里不存在
			"-v",
			`${ctx.workspace}:${workdir}`,
			...(ctx.home ? ["-v", `${ctx.home}:${home}`] : []),
			"-v",
			`${join(this.#opts.repoRoot, "src")}:${mountRoot}/src:ro`,
			"-v",
			`${join(this.#opts.repoRoot, "config")}:${mountRoot}/config:ro`,
			"-v",
			`${join(this.#opts.repoRoot, "node_modules")}:${mountRoot}/node_modules:ro`,
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
		// docker CLI 自己那几个变量不允许被当作容器 env 下发：调用方若传了
		// HOME/DOCKER_HOST，既会顶掉容器里显式设定的 HOME，也会让客户端
		// 去连错的 daemon。两组 key 今天恰好不相交，但那是巧合不是约束。
		for (const k of DOCKER_CLIENT_KEYS) delete containerEnv[k];
		// 用 `-e KEY`（不带值）而不是 `-e KEY=VALUE`：后者把值写进 argv，
		// 同机其他用户 `ps aux` 就能看到。当前这五个变量都不敏感，但
		// K8s 那侧的等价配置里是有会话 token 的（secretKeyRef），
		// 这个写法能保证以后有人往里加 token 时不会静默泄漏。
		// 注意：`docker inspect` 仍会留存值，要彻底避免必须避免把敏感值注入容器。
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
		args.push(this.#opts.image, "pi-env");

		return {
			bin: "docker",
			argsPrefix: args,
			// 两部分：① `-e KEY` 要从 docker 客户端自己的环境取值，所以
			// containerEnv 必须给出来；② docker CLI 本身需要的宿主机变量。
			// 后者容易漏 —— PiSession 的 spawn **不继承** process.env，
			// 而 docker CLI 靠 HOME 定位 ~/.docker/config.json（registry 认证、
			// 自定义 context、代理配置都在那儿）。漏了它在默认 socket 的机器上
			// 看不出问题，换成私有 registry 或自定义 context 就连不上 daemon。
			env: { ...dockerClientEnv(), ...containerEnv },
			cwd: ctx.workspace,
			homeInContainer: home,
			extensionPath: "",
			policyFile: `${mountRoot}/config/policy.yaml`,
		};
	}

	/**
	 * 杀掉容器。**这是必需的，不是兜底**：`--rm` 只负责容器退出后删除记录，
	 * 而杀掉宿主机上的 docker 客户端进程并不会让容器内的进程收到信号 ——
	 * 容器会继续跑、stdio 管道不关，等它的一方就永远等下去。
	 */
	/**
	 * `docker exec` 的 argv。抽成纯函数是为了在没有 daemon 的机器上也能
	 * 断言命令形状 —— 直接测 exec() 只能拿到「连不上 daemon」，
	 * 那种断言对任何 argv 都成立。
	 */
	execArgs(sessionId: string, command: string): string[] {
		// 容器内的工作区路径是固定挂载点，与宿主机路径无关，
		// 所以 exec() 的 workspace 参数在本后端里被忽略
		const workdir = this.#opts.workdir ?? "/workspace";
		return ["exec", "-w", workdir, containerName(sessionId, this.#gatewayId), "/bin/sh", "-c", command];
	}

	async exec(sessionId: string, _workspace: string, command: string, timeoutMs = 120_000): Promise<ExecResult> {
		// docker 客户端自身的环境也要收窄：不传的话 DOCKER_* 之外的一切
		// 都跟着进来，`launch` 路径上那套客户端变量消毒在这条路上就不成立了
		return runCapturing("docker", this.execArgs(sessionId, command), timeoutMs, undefined, { PATH: process.env.PATH, ...dockerClientEnv(), ...minimalEnv(this.#opts.env ?? {}) });
	}

	#unconfirmedResources = new Set<string>();

	get unconfirmedResources(): readonly string[] {
		return Array.from(this.#unconfirmedResources);
	}

	async cleanup(sessionId: string): Promise<void> {
		const name = containerName(sessionId, this.#gatewayId);
		try {
			// 必须带超时与精确退出：daemon 卡住时超时强杀子进程，防 live work 悬挂
			await safeDockerCmd(["rm", "-f", name], 5_000);
			this.#unconfirmedResources.delete(name);
		} catch (err) {
			// 「容器已不存在」是正常路径（正常退出时 --rm 已经收掉了）；
			// 其余情况意味着容器可能泄漏或清理未能完成，标记为 unknown 待 reconcile，绝不虚称 0
			const msg = err instanceof Error ? err.message : String(err);
			if (!/No such container/i.test(msg)) {
				this.#unconfirmedResources.add(name);
				const report = this.#opts.onCleanupError ?? ((id, e) => console.error(`容器清理失败 (待reconcile) ${id}:`, e));
				report(sessionId, err);
			}
		}
	}

	/**
	 * 回收本网关遗留的孤儿容器。启动时调一次。
	 * 网关被 SIGKILL 时来不及走 cleanup，容器会一直跑下去。
	 */
	async reapOrphans(): Promise<string[]> {
		const label = `perimeter.gateway=${this.#gatewayId}`;
		try {
			// 快速探测超时 (2500ms)：若 daemon 挂死或不可用，快速失败不阻塞网关启动
			const { stdout } = await safeDockerCmd(["ps", "-aq", "--filter", `label=${label}`], 2_500);
			const ids = stdout.split("\n").map((x) => x.trim()).filter(Boolean);
			if (ids.length > 0) {
				await safeDockerCmd(["rm", "-f", ...ids], 5_000);
				for (const id of ids) this.#unconfirmedResources.delete(id);
			}
			return ids;
		} catch (err) {
			const report = this.#opts.onCleanupError ?? ((id, e) => console.error(`孤儿容器扫描快速失败 (待reconcile) ${id}:`, e));
			report("<orphan-scan>", err);
			return [];
		}
	}
}

export interface KubectlBackendOptions {
	/** 预先创建好的 Pod 名模板，`{session}` 会被替换 */
	podTemplate: string;
	namespace?: string;
	container?: string;
	/** 等 Pod Ready 的超时。默认 60s —— 验收指标是冷启动 < 5s，别让前端白等几分钟 */
	readyTimeoutMs?: number;
	/** 会话结束时是否删除 Pod。默认 true：不删的话代理 token 会一直躺在 Pod 里 */
	deletePodOnCleanup?: boolean;
	/**
	 * Pod 模板路径。给了就由本后端**创建** Pod（每会话一个）；
	 * 不给则沿用旧行为：假设 Pod 已由外部编排器创建好。
	 */
	templatePath?: string;
	/** 沙箱镜像。生产上是客户自带的构建镜像 */
	image?: string;
	/** runtimeClass。传 null 显式去掉 —— 集群没装 gVisor 时留着会让 Pod 一直 pending */
	runtimeClass?: string | null;
	/** 网关实例标识。默认 hostname+pid —— 见 DockerBackendOptions.gatewayId */
	gatewayId?: string;
}


/**
 * 生产形态：K8s Pod。
 *
 * 给了 templatePath 就由本后端按会话创建 Pod（从 deploy/sandbox.yaml 渲染）；
 * 不给则沿用「Pod 已由外部编排器建好」的假设。
 *
 * **未在真实集群验证过** —— 本地只验证了渲染产物与命令行形状。
 * 给了 templatePath 时，本后端负责 Pod 的创建（provision）、配置注入
 * （prepare）、销毁（cleanup）与孤儿回收（reapOrphans）；
 * 不给则只负责「在已存在的 Pod 里起 pi」。
 *
 * 会话配置为什么走 `kubectl cp` 而不是 Secret 卷：Secret 要按会话创建、
 * 按会话回收，多一套生命周期要管；而且 sandbox.yaml 的开头就声明了
 * 「不挂任何 secret」—— 沙箱被攻陷时 Secret 卷里的东西是直接可读的。
 * cp 进 emptyDir 的东西同样可读，但它本来就是给沙箱用的代理 token，
 * 不是上游凭据，且不会在 K8s API 里留一份副本。
 *
 * ⚠️ **kubectl cp 要求容器镜像里有 tar**（它用 exec+tar 传文件）。参考镜像是
 * alpine（busybox tar 可用），但生产上是「客户自带构建镜像」—— 客户给一个
 * distroless 镜像，整条会话路径就断在这里，且错误信息离原因很远。
 * 这一条必须进部署前置条件清单。
 *
 * ⚠️ 安全论证依赖 **Pod 被及时销毁**：代理 token 就躺在 Pod 的 emptyDir 里。
 * cleanup() 会删 Pod；部署侧若关掉它，兜底只有 activeDeadlineSeconds（4 小时）。
 */
export class KubectlBackend implements ExecutionBackend {
	readonly kind = "kubectl" as const;
	#opts: KubectlBackendOptions;
	#gatewayId: string;

	constructor(opts: KubectlBackendOptions) {
		this.#opts = opts;
		// 与 docker 侧同理：两个网关共用一个集群时，A 的 reap 不该删掉 B 的 Pod
		this.#gatewayId = opts.gatewayId ?? `${hostname()}-${process.pid}`;
	}

	/**
	 * 把网关生成的沙箱 HOME 送进 Pod。
	 * 不做这一步，Pod 里的 HOME 是空的 emptyDir，git 读不到代理配置。
	 */
	/**
	 * prepare 会执行的两条命令。抽成纯函数是为了可测 —— 直接测 prepare()
	 * 只能断言「它失败了」，而 execFile 的错误消息对任何 argv 都长一个样，
	 * 那种断言恒真。
	 */
	prepareArgs(ctx: LaunchContext): [string[], string[]] {
		const pod = this.#podName(ctx.sessionId);
		const ns = this.#opts.namespace ? ["-n", this.#opts.namespace] : [];
		const container = this.#opts.container ? ["-c", this.#opts.container] : [];
		const readyMs = this.#opts.readyTimeoutMs ?? 60_000;
		return [
			// `--for=create` 是必需的：Pod 由外部编排器创建，两边并发时不加它
			// 会在「资源还不存在」上立即失败，而不是等待。
			["wait", "--for=create", "--for=condition=Ready", `pod/${pod}`, `--timeout=${Math.round(readyMs / 1000)}s`, ...ns],
			// 尾部的 `/.` 让 cp 复制目录内容而不是目录本身。
			// --no-preserve：宿主机的属主/权限在 Pod 里没有意义。
			["cp", "--no-preserve", `${ctx.home}/.`, `${pod}:${CONTAINER_HOME}`, ...ns, ...container],
		];
	}

	/**
	 * 创建这个会话的 Pod。templatePath 没给就跳过 —— 那种部署里 Pod
	 * 由外部编排器负责，本后端只管进去执行。
	 */
	/** provision 会写出的 manifest 与要执行的 argv。抽出来是为了可测 */
	provisionPlan(ctx: LaunchContext): { manifest: string; args: string[] } | null {
		if (!this.#opts.templatePath) return null;
		if (!this.#opts.image) throw new Error("配置了 templatePath 就必须同时给 image");
		// namespace 不能省：NetworkPolicy 是 namespace-scoped 的，Pod 落到
		// 别的 ns 就完全不受 egress 约束，而且 Pod 照常起来 —— 静默失去一条真边界
		if (!this.#opts.namespace) throw new Error("配置了 templatePath 就必须同时给 namespace，否则 NetworkPolicy 不生效");
		const manifest = renderPodManifest(this.#opts.templatePath, {
			name: this.#podName(ctx.sessionId),
			sessionId: ctx.sessionId,
			image: this.#opts.image,
			repo: String(ctx.env.PERIMETER_REPO ?? ""),
			team: String(ctx.env.PERIMETER_TEAM ?? ""),
			namespace: this.#opts.namespace,
			runtimeClass: this.#opts.runtimeClass,
			gatewayId: this.#gatewayId,
		});
		// create 而非 apply：Pod 的 spec 大部分字段不可变，同名 Pod 存在时
		// apply 要么报错要么是 no-op —— 后者会把上一个会话遗留的 Pod
		// （emptyDir 里还有它的 HOME 与 workspace）交给这次会话用。
		// sessionId 由客户端指定，这是可被主动触发的。先删再建，快失败。
		return { manifest, args: ["create", "-f", "PLACEHOLDER", "-n", this.#opts.namespace] };
	}

	async provision(ctx: LaunchContext): Promise<void> {
		const plan = this.provisionPlan(ctx);
		if (!plan) return;
		const ns = ["-n", this.#opts.namespace!];
		// 走临时文件而不是 stdin：复用 promisified exec 就白拿超时、stderr
		// 与完整错误消息。stdin 那条路要自己接 EPIPE，否则 kubectl 先退出时
		// 一个未处理的 socket error 就能打崩整个网关进程。
		const file = join(mkdtempSync(join(tmpdir(), "perimeter-pod-")), "pod.yaml");
		try {
			writeFileSync(file, plan.manifest);
			await exec("kubectl", ["delete", "pod", this.#podName(ctx.sessionId), "--ignore-not-found", ...ns], {
				timeout: 30_000,
			});
			await exec("kubectl", ["create", "-f", file, ...ns], { timeout: 30_000 });
		} catch (err) {
			// execFile 的错误消息里带 stderr，直接透出去 —— 这条路径没在真实
			// 集群验证过，第一个用户不该只看到一个退出码
			throw new Error(`创建 Pod 失败：${err instanceof Error ? err.message : String(err)}`);
		} finally {
			rmSync(dirname(file), { recursive: true, force: true });
		}
	}

	async prepare(ctx: LaunchContext): Promise<void> {
		// 先把 Pod 建出来，再等它 Ready，最后送配置进去
		await this.provision(ctx);
		// 自建 Pod 时必须等 Ready：刚 create 出来还在 ContainerCreating，
		// launch() 的 kubectl exec 会直接打空
		const selfProvisioned = Boolean(this.#opts.templatePath);
		if (!ctx.home && !selfProvisioned) return;
		// 等 Pod 就绪：刚创建的 Pod 还在 ContainerCreating 时 cp 会失败
		const [waitArgs, cpArgs] = this.prepareArgs(ctx);
		const readyMs = this.#opts.readyTimeoutMs ?? 60_000;
		// `--for=create` 是必需的：Pod 由外部编排器创建，两边并发时不加它
		// 会在「资源还不存在」上立即失败，而不是等待。
		await exec("kubectl", waitArgs, { timeout: readyMs + 10_000 });
		if (ctx.home) await exec("kubectl", cpArgs, { timeout: 60_000 });
	}

	environmentPlan(ctx: LaunchContext): EnvironmentPlan {
		const launch = this.launch(ctx);
		return { cwd: "/workspace", command: [launch.bin, ...launch.argsPrefix.slice(0, -1), "pi-env"] };
	}

	async environment(ctx: LaunchContext): Promise<EnvironmentHandle> {
		await this.prepare(ctx);
		return openEnvironment(this.environmentPlan(ctx));
	}

	launch(ctx: LaunchContext): Launch {
		const pod = this.#podName(ctx.sessionId);
		const args = ["exec", "-i", pod];
		if (this.#opts.namespace) args.push("-n", this.#opts.namespace);
		if (this.#opts.container) args.push("-c", this.#opts.container);
		// `--` 之后才是要在 Pod 里执行的命令
		args.push("--", "pi-env");
		return {
			bin: "kubectl",
			argsPrefix: args,
			// 与 docker 同理：spawn 不继承 process.env，而 kubectl 靠 HOME
			// 找 ~/.kube/config。缺了它每次 exec 都是
			// "no configuration has been provided"。
			env: kubectlClientEnv(),
			cwd: ctx.workspace,
			homeInContainer: CONTAINER_HOME,
			// 扩展由镜像提供（sandbox.Dockerfile 的 COPY），策略走 configMap
			extensionPath: "",
			policyFile: "/etc/perimeter/policy.yaml",
		};
	}

	/**
	 * 删除 Pod。**不是可选的清理**：代理 token 就在 Pod 的 emptyDir 里，
	 * Pod 不删它就一直在（兜底只有 4 小时的 activeDeadlineSeconds）。
	 */
	/** 回收本网关遗留的 Pod。与 docker 侧的 reapOrphans 对称 */
	async reapOrphans(): Promise<string[]> {
		if (!this.#opts.templatePath || !this.#opts.namespace) return [];
		try {
			const sel = `perimeter.dev/gateway=${this.#gatewayId}`;
			const { stdout } = await exec(
				"kubectl",
				["get", "pods", "-l", sel, "-o", "name", "-n", this.#opts.namespace],
				{ timeout: 15_000 },
			);
			const names = stdout.split("\n").map((x) => x.trim()).filter(Boolean);
			if (names.length > 0) {
				await exec("kubectl", ["delete", "-l", sel, "pod", "-n", this.#opts.namespace], { timeout: 60_000 });
			}
			return names;
		} catch (err) {
			console.error("孤儿 Pod 扫描失败（带 token 的 Pod 可能仍在运行）:", err);
			return [];
		}
	}

	/**
	 * `kubectl exec` 的 argv。同样抽成纯函数 —— 没有集群时只能断言形状。
	 *
	 * kubectl exec 没有 docker 那样的 `-w`，工作目录只能靠 `cd`。
	 * 因此 workspace 必须是 **Pod 内**的路径（launch 里 cwd 就是原样的
	 * ctx.workspace，两处是同一个约定）。
	 */
	execArgs(sessionId: string, workspace: string, command: string): string[] {
		const args = ["exec", this.#podName(sessionId)];
		if (this.#opts.namespace) args.push("-n", this.#opts.namespace);
		if (this.#opts.container) args.push("-c", this.#opts.container);
		// `--` 之后的内容不再被 kubectl 解析，验收命令里的 -flag 才不会被它吃掉
		args.push("--", "/bin/sh", "-c", `cd ${JSON.stringify(workspace)} && ${command}`);
		return args;
	}

	async exec(sessionId: string, workspace: string, command: string, timeoutMs = 120_000): Promise<ExecResult> {
		return runCapturing("kubectl", this.execArgs(sessionId, workspace, command), timeoutMs, undefined, minimalEnv({}));
	}

	async cleanup(sessionId: string): Promise<void> {
		if (this.#opts.deletePodOnCleanup === false) return;
		const ns = this.#opts.namespace ? ["-n", this.#opts.namespace] : [];
		try {
			await exec("kubectl", ["delete", "pod", this.#podName(sessionId), "--ignore-not-found", ...ns], { timeout: 30_000 });
		} catch (err) {
			console.error(`Pod 删除失败 ${this.#podName(sessionId)}（会话配置仍留在 Pod 内）:`, err);
		}
	}

	#podName(sessionId: string): string {
		// 必须规范化：sessionId 客户端可指定，允许大写与下划线，
		// 而 Pod 名要符合 DNS-1123。不转的话 `?session=Fix_Bug` 直接被 K8s 拒，
		// 且 schema 校验看不出来（name 在官方 schema 里是裸 string）
		return this.#opts.podTemplate.replace("{session}", k8sNameFragment(sessionId));
	}
}

/**
 * docker CLI 自己需要的宿主机环境。
 * 这些**不会**进容器 —— 进容器的只有 argsPrefix 里 `-e` 列出的那些。
 */
const DOCKER_CLIENT_KEYS = ["HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"];

/** kubectl 同理：靠 HOME 找 ~/.kube/config，缺了每次 exec 都会失败 */
function kubectlClientEnv(): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const k of ["HOME", "KUBECONFIG", "KUBERNETES_SERVICE_HOST", "KUBERNETES_SERVICE_PORT"]) {
		if (process.env[k] !== undefined) out[k] = process.env[k];
	}
	return out;
}

export function dockerClientEnv(): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const k of DOCKER_CLIENT_KEYS) {
		if (process.env[k] !== undefined) out[k] = process.env[k];
	}
	return out;
}

/**
 * 容器内的默认运行身份：网关自己的 uid/gid。
 * 见 DockerBackendOptions.user 里关于 bind mount 属主的说明。
 */
export function defaultContainerUser(): string {
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	// 拿不到 uid（Windows）时退回镜像里的固定非 root 用户
	if (uid === undefined || gid === undefined) return "10001:10001";
	// 网关以 root 跑时不能把 0:0 传下去（那等于放弃非 root），但退回 10001
	// 也写不进 root 建的工作区 —— 这种部署必须显式指定 user 或修属主，
	// 与其给一个第一次写文件才炸的默认值，不如现在就说清楚。
	if (uid === 0) {
		throw new Error(
			"网关以 root 运行时必须显式指定 DockerBackendOptions.user，并保证工作区属主与之匹配；" +
				"否则容器要么以 root 跑（放弃非 root），要么写不进 bind mount",
		);
	}
	return `${uid}:${gid}`;
}

/**
 * 容器名必须可预测，才能在 pi 意外退出后找回来清理。
 * 带 gatewayId 是为了让共用一个 docker daemon 的两个网关互不干扰 ——
 * sessionId 由客户端指定，不加前缀的话 A 的 cleanup 会杀掉 B 的容器。
 */
export function containerName(sessionId: string, gatewayId?: string): string {
	return gatewayId ? `perimeter-${gatewayId}-${sessionId}` : `perimeter-${sessionId}`;
}
