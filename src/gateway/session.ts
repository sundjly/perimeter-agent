import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AuditInput, AuditLog } from "../audit/log.ts";
import { contentHash } from "../audit/log.ts";
import type { ActionDescriptor, ClientCommand, ClientEvent } from "../protocol/types.ts";
import {
	type PiEvent,
	type PiResponse,
	type TranslateState,
	newTranslateState,
	summarizeAction,
	toActionDescriptor,
	toClientEvent,
	toClientEventFromResponse,
	toPiCommand,
} from "../protocol/translate.ts";
import { PiSession } from "../rpc/pi-session.ts";
import { type ExecutionBackend, type LaunchContext, LocalBackend } from "./execution-backend.ts";
import { type SandboxWiring, writeSandboxConfig } from "./sandbox-config.ts";
import { APPROVE, AUDIT_PREFIX, REJECT } from "./policy-extension.ts";

export interface SessionOptions {
	sessionId: string;
	actor: string;
	repo: string;
	team: string;
	workspace: string;
	policyFile: string;
	audit: AuditLog;
	piBin?: string;
	piArgs?: string[];
	/** pi 进程在哪儿跑。不给则直接在宿主机 spawn（无隔离） */
	backend?: ExecutionBackend;
	piEnv?: NodeJS.ProcessEnv;
	approvalTimeoutMs?: number;
	/**
	 * 沙箱侧接线：模型网关与 git 代理的地址 + 会话 token。
	 * 给了就为本会话生成隔离的 pi HOME，让 agent 只能经这两个代理出网。
	 */
	wiring?: SandboxWiring;
	/** 沙箱 HOME 的位置。必须在 workspace 之外，否则含 token 的配置会被 commit 进仓库 */
	sandboxHome?: string;
	/**
	 * 会话启动时要 clone 的仓库（上游真实地址，由 insteadOf 重写到凭据代理）。
	 * 这是策略文档 §4.3 时序里的 `GW->SBX: git clone（经凭据代理，token 不落沙箱）`。
	 */
	repoUrl?: string;
	/** clone 超时。卡住的 clone 会让会话永远停在启动中 */
	cloneTimeoutMs?: number;
	/** 断线续接的事件缓存条数 */
	backlogSize?: number;
	/** target 非空时只投递给该传输（resume 的重放不该洪泛给其他标签页） */
	send: (event: ClientEvent, seq: number, target?: unknown) => void;
}

interface PendingApproval {
	callId: string;
	action: ActionDescriptor;
	rule: string;
	reason: string;
	/** 用于续接时重发对话框 —— 没有它就算不出倒计时 */
	expiresAt?: number;
	/** 同上：重发时要用同一个 id，否则前端会开出第二个框 */
	approvalId?: string;
}

/**
 * 一个浏览器会话：把 pi 进程、策略引擎、审批门、审计日志串成一条链路。
 *
 * 三条纪律：
 * - 出口只有 ClientEvent。pi 的事件格式一律经 translate 转换，
 *   本文件之外（尤其是前端）看不到 pi 的字段名。
 * - 审计日志只有网关一个写入者。策略扩展跑在 pi 进程内，它的判决经
 *   扩展 UI 的 notify 通道回传到这里再落盘，而不是自己开一个 fd。
 * - **钩子未确认挂上之前不跑任何 prompt**。扩展加载失败是 fail-closed 的
 *   （pi 直接退出），但「注册了一个 pi 不认识的事件名」是静默失败 ——
 *   那种状态下 agent 会在完全无策略保护的情况下执行工具。
 */
export class Session {
	#opts: SessionOptions;
	#pi!: PiSession;
	/** 构造期算好、start() 里用的启动参数 */
	#launch: ReturnType<ExecutionBackend["launch"]>;
	#backend: ExecutionBackend;
	#launchCtx!: LaunchContext;
	#piStarted = false;
	#tstate: TranslateState = newTranslateState();
	/** 已发出的事件，供断线续接重放 */
	#backlog: ClientEvent[] = [];
	#seq = 0;
	#model: string | null = null;
	#alive = true;
	#lastActivity = Date.now();

	/** 待人工审批的对话：approvalId → 它对应的工具调用 */
	#pendingApprovals = new Map<string, PendingApproval>();
	/**
	 * 最近一条尚未配上对话框的 approval.request。
	 * 扩展在 select 之前紧邻发出它，据此把 callId 与对话框 id 绑定 ——
	 * 不靠「同时只有一个挂起审批」这种外部不变量去反推。那个假设当前成立
	 * （pi 串行 preflight，实测确认），但它是 pi 的内部行为，不该被正确性依赖。
	 */
	#awaitingDialog: PendingApproval | null = null;
	/** callId → 已回答的对话框 id 与实际审批人，供判决回传时对上号 */
	#resolved = new Map<string, { approvalId: string; actor: string }>();

	/** 钩子存活握手 */
	#hookArmed = false;
	/**
	 * 工作区就绪。现在 clone 排在 #spawnPi 之前，所以 #piStarted 成立时
	 * 它必然也成立 —— 这道门退化成了廉价兜底。保留它是因为启动顺序一旦
	 * 再变（比如为了缩短冷启动而并行化），它就是唯一挡住「agent 在半个
	 * 工作区里开工」的东西。
	 */
	#workspaceReady = false;
	#queuedWhileDisarmed: ClientCommand[] = [];

	#toolNames = new Map<string, string>();
	#piArgs: string[] = [];
	#launchEnv: NodeJS.ProcessEnv = {};
	#sandboxHome: string | undefined;
	#startedAt = Date.now();

	constructor(opts: SessionOptions) {
		this.#opts = opts;
		mkdirSync(opts.workspace, { recursive: true });

		// 接线：沙箱只拿到指向两个代理的配置，真凭据留在代理进程里
		const wired =
			opts.wiring && opts.sandboxHome ? writeSandboxConfig(opts.sandboxHome, opts.wiring) : null;
		this.#sandboxHome = wired?.home;
		// 不需要 clone 的会话，工作区从一开始就是就绪的
		this.#workspaceReady = !opts.repoUrl;

		// 执行后端决定 pi 跑在哪儿（宿主机 / 容器 / Pod）。
		// 上层的策略、审批、审计、协议都不感知这个差别。
		const sandboxEnv: NodeJS.ProcessEnv = {
			PERIMETER_REPO: opts.repo,
			PERIMETER_TEAM: opts.team,
			PERIMETER_APPROVAL_TIMEOUT_MS: String(opts.approvalTimeoutMs ?? 120_000),
		};
		const backend = opts.backend ?? new LocalBackend(opts.piEnv ?? {});
		const launchCtx = {
			sessionId: opts.sessionId,
			workspace: opts.workspace,
			home: wired?.home,
			extensionPath: extensionPath(),
			policyFile: opts.policyFile,
			// 刻意不在这里传 PERIMETER_POLICY_FILE：它的值取决于 pi 进程
			// 看到的文件系统，只有后端知道（容器里是挂载点）
			env: sandboxEnv,
		};
		this.#launchCtx = launchCtx;
		const launch = backend.launch(launchCtx);
		// 扩展路径与策略路径都必须是 pi 进程视角的路径：
		// 容器里是挂载点，本机是仓库路径。两者都由后端给出。
		const launchEnv = launch.env;

		this.#backend = backend;
		this.#launch = launch;
		this.#piArgs = [...launch.argsPrefix, ...(opts.piArgs ?? []), ...(wired?.piArgs ?? []), "-e", launch.extensionPath];
		this.#launchEnv = launchEnv;
	}

	/**
	 * 真正拉起 pi。刻意不在构造函数里做：
	 * kubectl 后端要先把沙箱配置 cp 进 Pod（prepare），pi 启动时就要能读到
	 * models.json；在构造函数里 spawn 的话配置根本来不及到位。
	 */
	#spawnPi(): void {
		const opts = this.#opts;
		this.#pi = new PiSession({
			cwd: opts.workspace,
			bin: this.#launch.bin,
			args: this.#piArgs,
			// 只传显式给定的环境变量。继承 process.env 会把网关的共享 token
			// 与模型 key 一起交给 pi，而 pi 会执行 agent 的 bash 工具 ——
			// agent 跑一句 env 就拿到了，与「凭据不进沙箱」正面冲突。
			// 容器后端下环境变量已由后端经 -e 注入容器，这里只剩 docker
			// 客户端自己需要的 PATH；local 后端则拿到完整的一份。
			env: { PATH: process.env.PATH, ...this.#launchEnv },
			onEvent: (e) => this.#onPiEvent(e),
			onResponse: (r) => this.#onPiResponse(r),
			onExit: (info) => this.#onExit(info),
			// pi 的致命错误（扩展加载失败等）只出现在 stderr。不接就等于
			// 「会话起不来，日志里什么都没有」。
			onStderr: (text) => this.#onStderr(text),
			onProtocolError: (line, err) =>
				this.#emit({ type: "error", code: "command_failed", message: `协议错误：${String(err)}（${line.slice(0, 80)}）` }),
		});
		// 构造成功之后才置真：构造抛错时留下 piStarted=true 而 #pi 未定义，
		// 会让 handle()/stop() 的守卫全部失效，正好放回它们要防的场景
		this.#piStarted = true;
	}

	get sessionId(): string {
		return this.#opts.sessionId;
	}

	get lastSeq(): number {
		return this.#seq;
	}

	get alive(): boolean {
		return this.#alive;
	}

	get idleMs(): number {
		return Date.now() - this.#lastActivity;
	}

	/**
	 * 会话建立后先取一次状态，拿到模型名再宣告 ready。
	 * 事件与审计一律从这里开始发 —— 构造函数里发事件会在调用方拿到实例之前
	 * 就回调 send()，那时 send 闭包引用的变量还没初始化。
	 */
	async start(): Promise<void> {
		this.#audit({ kind: "session.start", summary: `会话开始 workspace=${this.#opts.workspace}` });

		// 配置先到位，再拉起 agent。kubectl 后端的 Pod HOME 是空 emptyDir，
		// 不 cp 进去就没有 models.json，pi 起来也读不到 provider。
		try {
			// 与构造期传给 launch() 的是同一个 ctx：两者不一致的话，
			// 哪个后端的 prepare 读了 ctx.env 就会静默拿到空对象
			await this.#backend.prepare?.(this.#launchCtx);
		} catch (err) {
			this.#audit({ kind: "error", summary: `沙箱准备失败：${String(err).slice(0, 200)}` });
			this.#emit({ type: "error", code: "agent_error", message: `沙箱准备失败：${String(err).slice(0, 300)}` });
			// 走 stop() 而不是只置 #alive —— 后者会让这个会话永远没有
			// session.end 记录（理由见 stop() 上方的注释）
			await this.stop();
			return;
		}

		// clone 也要在 pi 之前：agent 拿到控制权时工作区就该是就绪的
		if (this.#opts.repoUrl && !(await this.#cloneRepo(this.#opts.repoUrl))) return;
		this.#spawnPi();
		try {
			const res = await this.#pi.request({ type: "get_state" });
			for (const ev of toClientEventFromResponse(res)) {
				if (ev.type === "session.state") this.#model = ev.model;
				this.#emit(ev);
			}
		} catch (err) {
			// 起不来就别宣告 ready：前端显示「就绪」而 pi 已死是最难排查的状态
			this.#emit({ type: "error", code: "agent_error", message: `会话启动失败：${String(err)}` });
			await this.stop();
			return;
		}
		this.#emit({
			type: "session.ready",
			sessionId: this.#opts.sessionId,
			workspace: this.#opts.workspace,
			model: this.#model,
		});
		// 这才是验收项里的「会话冷启动（含 clone）< 5s」：
		// 含 clone、spawn pi、get_state 与 ready 的全过程
		this.#audit({
			kind: "session.start",
			summary: `会话就绪（冷启动 ${Date.now() - this.#startedAt}ms，含 clone）`,
			durationMs: Date.now() - this.#startedAt,
		});
	}

	/**
	 * 排队上限：kubectl 后端把「pi 未就绪」的窗口从约 1 秒拉到最坏几分钟，
	 * 期间客户端可以一直 push。满了就丢最早的并告知。
	 */
	#enqueue(cmd: ClientCommand): void {
		if (this.#queuedWhileDisarmed.length >= 32) {
			this.#queuedWhileDisarmed.shift();
			this.#emit({ type: "error", code: "command_failed", message: "会话尚未就绪，排队消息过多，最早的一条已被丢弃" });
		}
		this.#queuedWhileDisarmed.push(cmd);
	}

	/** 两道门都开了才放行排队的 prompt */
	#flushQueued(): void {
		if (!(this.#hookArmed && this.#workspaceReady)) return;
		for (const cmd of this.#queuedWhileDisarmed.splice(0)) this.handle(cmd);
	}

	/** actor 是发出这条命令的连接身份；from 用于把 resume 的重放只回给发起方 */
	handle(cmd: ClientCommand, actor = this.#opts.actor, from?: unknown): void {
		this.#lastActivity = Date.now();

		const invalid = validate(cmd);
		if (invalid) {
			// 不校验就用的话，一条畸形消息能打死整个网关进程，连带杀掉所有其他会话
			this.#emit({ type: "error", code: "command_failed", message: invalid });
			return;
		}
		if (!this.#alive) {
			this.#emit({ type: "error", code: "agent_error", message: "会话已终止，请新建会话" });
			return;
		}

		if (cmd.type === "resume") {
			this.#replay(cmd.since, from);
			return;
		}
		if (cmd.type === "approve") {
			this.#resolveApproval(cmd.approvalId, cmd.decision, actor);
			return;
		}
		// pi 还没起来（还在 prepare / clone 阶段）。走到这里的只剩 prompt /
		// steer / abort —— resume 与 approve 在上面已经 return。
		// abort 必须在这里挡住：它不走下面那道 hookArmed 门，打到未初始化的
		// #pi 上会把整个网关进程带崩（连带杀掉所有其他会话）。
		if (!this.#piStarted) {
			if (cmd.type === "abort") {
				// 用户按了停止，排队的 prompt 就不该在启动完成后照样跑
				this.#queuedWhileDisarmed.length = 0;
			} else {
				this.#enqueue(cmd);
			}
			return;
		}

		// 两道门都过了才放行 prompt：钩子未挂 = 无策略保护，工作区未就绪 = 在空目录里瞎改
		if (!(this.#hookArmed && this.#workspaceReady) && (cmd.type === "prompt" || cmd.type === "steer")) {
			this.#enqueue(cmd);
			return;
		}
		if (cmd.type === "prompt") {
			this.#audit({ kind: "prompt", summary: `prompt（${cmd.text.length} 字符）`, argsHash: contentHash(cmd.text) });
		}
		const piCmd = toPiCommand(cmd);
		if (piCmd) this.#pi.send(piCmd);
	}

	/**
	 * 由**网关**执行 clone，而不是让 agent 自己 clone。
	 * 两个原因：工作区在 agent 拿到控制权之前就该是就绪状态；
	 * 而且 clone 用的是网关生成的 HOME 配置，凭据仍然只在代理那一侧。
	 */
	async #cloneRepo(repoUrl: string): Promise<boolean> {
		// 网关重启后同一 sessionId 重连时，workspace 里已经有上次 clone 的内容。
		// 不跳过的话 git 会以「目标目录非空」失败，会话再也起不来。
		if (existsSync(join(this.#opts.workspace, ".git"))) {
			this.#audit({ kind: "session.start", summary: "工作区已存在，跳过 clone" });
			return true;
		}

		// 没有 wiring 就没有 insteadOf 规则，clone 会直接打到上游而绕过凭据代理。
		// 退化到「HOME 指向 workspace」既违反 sandbox-config 里写明的纪律，
		// 也让这次 clone 失去意义 —— 直接拒绝。
		const home = this.#sandboxHome;
		if (!home) {
			this.#audit({ kind: "error", summary: "配置了 repoUrl 但没有 wiring：clone 会绕过凭据代理" });
			this.#emit({ type: "error", code: "agent_error", message: "配置了 repoUrl 但没有 wiring，拒绝在无凭据代理的情况下 clone" });
			await this.stop();
			return false;
		}
		const started = Date.now();
		try {
			await new Promise<void>((resolve, reject) => {
				// `--` 分隔：repoUrl 来自配置而非客户端，但以 `-` 开头的值会被
				// git 当成选项（如 --upload-pack=<cmd>），这是一条命令注入路径
				const proc = spawn("git", ["clone", "-q", "--", repoUrl, "."], {
					cwd: this.#opts.workspace,
					env: { PATH: process.env.PATH ?? "", HOME: home, GIT_TERMINAL_PROMPT: "0" },
					stdio: ["ignore", "ignore", "pipe"],
				});
				// 卡住的 clone（上游无响应）会让会话永远停在启动中，前端只看到一片空白
				const timer = setTimeout(() => {
					proc.kill("SIGKILL");
					reject(new Error(`clone 超时（${this.#opts.cloneTimeoutMs ?? 30_000}ms）`));
				}, this.#opts.cloneTimeoutMs ?? 30_000);
				let stderr = "";
				proc.stderr.on("data", (c: Buffer) => {
					stderr += c.toString();
				});
				proc.on("error", (e) => {
					clearTimeout(timer);
					reject(e);
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					code === 0 ? resolve() : reject(new Error(stderr.trim() || `git clone exit ${code}`));
				});
			});
		} catch (err) {
			// clone 失败就别让会话跑起来：agent 会在一个空目录里瞎猜
			this.#audit({ kind: "error", summary: `clone 失败：${String(err).slice(0, 200)}` });
			this.#emit({ type: "error", code: "agent_error", message: `仓库 clone 失败：${String(err).slice(0, 300)}` });
			// 超时是 SIGKILL 打断的，git 来不及自清理，会留下半个 .git；
			// 不清掉的话下次会话会误判「工作区已存在」而跳过 clone，
			// 把一个残缺仓库交给 agent
			try {
				rmSync(join(this.#opts.workspace, ".git"), { recursive: true, force: true });
			} catch {
				// 清理失败不改变结论：会话本来就要终止
			}
			// 直接收掉 pi 并补上 session.end —— 只置 #alive=false 的话，
			// 进程要等 30s 的 reaper 才被收，而那时 stop() 里的 if (#alive)
			// 已不成立，这个会话永远不会有结束记录。审计里「有 start 无 end」
			// 对一个以审计完整性为卖点的运行时是个洞。
			await this.stop();
			return false;
		}
		// clone 打点。注意它测的**不是**验收项里的「会话冷启动（含 clone）」——
		// 那一项还包含 spawn pi、get_state 与 ready，见 start() 末尾的打点。
		this.#audit({ kind: "repo.clone", summary: `clone 完成（${Date.now() - started}ms）`, durationMs: Date.now() - started });
		this.#workspaceReady = true;
		this.#flushQueued();
		return true;
	}

	async stop(): Promise<void> {
		if (this.#alive) this.#audit({ kind: "session.end", summary: "会话结束" });
		this.#alive = false;
		if (!this.#piStarted) {
			await this.#opts.backend?.cleanup?.(this.#opts.sessionId);
			return;
		}
		// **先杀容器再收客户端**。顺序反过来会挂住：SIGTERM 发给的是宿主机上的
		// docker 客户端进程，容器内的 pi 收不到，容器继续跑、stdio 管道不关，
		// pi.stop() 就一直等下去 —— 实测表现为测试进程挂死且容器泄漏。
		await this.#opts.backend?.cleanup?.(this.#opts.sessionId);
		await this.#pi.stop();
	}

	/** 重放 since 之后的事件。只回发起方，避免洪泛给其他标签页。 */
	#replay(since: number, to?: unknown): void {
		const firstSeq = this.#seq - this.#backlog.length + 1;
		// 缓冲是有上限的，断线久了最老的事件已经被挤掉。这时**必须告诉客户端**：
		// 它不知道自己丢了东西的话，会以为界面是完整的 —— 而丢掉的可能正是
		// 那条 policy.denied 或一个还等着人批的审批请求。
		if (since < firstSeq - 1) {
			// seq 必须是 firstSeq-1，**不能是 #seq**：前端按 `seq <= state.seq` 去重，
			// 带最新 seq 的 gap 先到会把游标顶到最新，随后重放的事件全部被丢掉 ——
			// 那比不报缺口更糟（告诉用户丢了 10 条，然后把本来救得回来的 3 条也丢了）。
			// 也不能用 since：那会被 `<=` 判定丢弃。
			// 语义上 gap 正好"顶替"了缺失区间，终点就是 missedTo。
			this.#opts.send({ type: "session.gap", missedFrom: since + 1, missedTo: firstSeq - 1 }, firstSeq - 1, to);
		}
		for (let i = 0; i < this.#backlog.length; i++) {
			const seq = firstSeq + i;
			if (seq > since) this.#opts.send(this.#backlog[i]!, seq, to);
		}

		// 挂起的审批必须重发。它一旦滚出缓冲，客户端永远看不到对话框，
		// 而服务端 agent 还阻塞在那儿等到超时按拒绝 —— 用户只看到一句
		// 「丢了 N 条记录」，不会想到有个东西正等着他批。
		// 放在重放之后并用 #seq：早于重放的话会踩到与 gap 同样的去重坑。
		for (const [approvalId, p] of this.#pendingApprovals) {
			this.#opts.send(
				{
					type: "approval.request",
					approvalId,
					action: p.action,
					reason: p.reason,
					expiresAt: p.expiresAt ?? Date.now() + (this.#opts.approvalTimeoutMs ?? 120_000),
				},
				this.#seq,
				to,
			);
		}
	}

	#onPiEvent(ev: PiEvent): void {
		if (ev.type === "extension_ui_request") {
			this.#onExtensionUi(ev);
			return;
		}
		// 工具调用的兜底留痕：即便扩展上报失败，也不会出现完全无记录的调用
		if (ev.type === "tool_execution_start") {
			const action = toActionDescriptor(String(ev.toolName ?? ""), ev.args);
			const callId = String(ev.toolCallId ?? "");
			this.#toolNames.set(callId, action.tool);
			this.#audit({
				kind: "tool.call",
				summary: summarizeAction(action),
				callId,
				tool: action.tool,
				path: action.path,
				command: action.command,
				argsHash: contentHash(ev.args),
			});
		}
		if (ev.type === "tool_execution_end") {
			const callId = String(ev.toolCallId ?? "");
			this.#audit({
				kind: "tool.result",
				summary: `${this.#toolNames.get(callId) ?? "tool"} ${ev.isError === true ? "失败" : "完成"}`,
				callId,
				ok: ev.isError !== true,
			});
			this.#toolNames.delete(callId);
		}
		for (const out of toClientEvent(ev, this.#tstate)) {
			if (out.type === "usage") {
				this.#audit({
					kind: "usage",
					summary: `token ${out.usage.total}`,
					tokensInput: out.usage.input,
					tokensOutput: out.usage.output,
					tokensCacheRead: out.usage.cacheRead,
					tokensCacheWrite: out.usage.cacheWrite,
					tokensTotal: out.usage.total,
					cost: out.usage.cost,
				});
			}
			this.#emit(out);
		}
	}

	#onPiResponse(res: PiResponse): void {
		for (const ev of toClientEventFromResponse(res)) {
			if (ev.type === "session.state") this.#model = ev.model;
			this.#emit(ev);
		}
	}

	#onStderr(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		// 扩展加载失败会让 pi 直接退出（fail-closed，方向是对的），
		// 但错误只在 stderr —— 不透出来，现场就只剩一个「起不来」
		this.#emit({ type: "error", code: "agent_error", message: `pi: ${trimmed.slice(0, 500)}` });
	}

	/**
	 * 扩展 UI 子协议是策略扩展与网关之间的唯一通道：
	 * select 是审批门，带 AUDIT_PREFIX 的 notify 是判决上报。
	 */
	#onExtensionUi(ev: PiEvent): void {
		const method = String(ev.method ?? "");
		if (method === "notify") {
			const msg = String(ev.message ?? "");
			if (msg.startsWith(AUDIT_PREFIX)) this.#onVerdict(msg.slice(AUDIT_PREFIX.length));
			return;
		}
		if (method !== "select") return;

		const approvalId = String(ev.id ?? "");
		const pending = this.#awaitingDialog ?? { callId: "", action: { tool: "unknown" }, rule: "", reason: "" };
		this.#awaitingDialog = null;
		this.#pendingApprovals.set(approvalId, pending);

		const timeout = typeof ev.timeout === "number" ? ev.timeout : (this.#opts.approvalTimeoutMs ?? 120_000);
		// 存下来，续接时要按同一个 id 与到期时间重发
		pending.approvalId = approvalId;
		pending.expiresAt = Date.now() + timeout;
		this.#emit({
			type: "approval.request",
			approvalId,
			// 审批人必须看得到批的是什么：只给规则模式的话，
			// `git push --force origin main` 与 `git push origin feature` 长得一样
			action: pending.action,
			reason: pending.reason || String(ev.title ?? "需要人工确认"),
			expiresAt: Date.now() + timeout,
		});
	}

	#onVerdict(json: string): void {
		let v: Record<string, unknown>;
		try {
			v = JSON.parse(json);
		} catch {
			return;
		}
		const action = (v.action ?? { tool: "unknown" }) as ActionDescriptor;
		const kind = String(v.kind ?? "");
		const callId = String(v.callId ?? "");

		if (kind === "hook-armed") {
			this.#hookArmed = true;
			this.#audit({ kind: "session.start", summary: `策略钩子已挂载（${String(v.rules)} 条规则）` });
			this.#flushQueued();
			return;
		}

		if (kind === "deny") {
			this.#audit({
				kind: "policy.verdict",
				summary: `拒绝：${summarizeAction(action)}`,
				callId,
				tool: action.tool,
				path: action.path,
				command: action.command,
				verdict: "deny",
				rule: String(v.rule ?? ""),
			});
			this.#emit({ type: "policy.denied", action, rule: String(v.rule ?? ""), reason: String(v.reason ?? "") });
			return;
		}

		if (kind === "allow") {
			this.#audit({ kind: "policy.verdict", summary: `放行：${summarizeAction(action)}`, callId, tool: action.tool, verdict: "allow" });
			return;
		}

		if (kind === "approval.request") {
			// 记下来，等紧随其后的 select 把它与对话框 id 绑定
			this.#awaitingDialog = { callId, action, rule: String(v.rule ?? ""), reason: String(v.reason ?? "") };
			this.#audit({
				kind: "approval.request",
				summary: `待审批：${summarizeAction(action)}`,
				callId,
				tool: action.tool,
				path: action.path,
				command: action.command,
				rule: String(v.rule ?? ""),
			});
			return;
		}

		if (kind === "approval.decision") {
			const approved = v.approved === true;
			const timedOut = v.timedOut === true;
			const resolved = this.#resolved.get(callId);
			this.#resolved.delete(callId);
			const approvalId = resolved?.approvalId ?? this.#findPendingByCallId(callId) ?? "";
			this.#pendingApprovals.delete(approvalId);

			this.#audit({
				kind: "approval.decision",
				summary: `${approved ? "已批准" : timedOut ? "超时拒绝" : "已拒绝"}：${summarizeAction(action)}`,
				callId,
				tool: action.tool,
				verdict: approved ? "allow" : "deny",
				rule: String(v.rule ?? ""),
				// 超时不是任何人做的决定，此时不该记一个审批人
				approver: timedOut ? undefined : resolved?.actor,
			});
			this.#emit({
				type: "approval.resolved",
				approvalId,
				decision: approved ? "allow" : "deny",
				actor: timedOut ? "system(timeout)" : (resolved?.actor ?? "unknown"),
			});
		}
	}

	#resolveApproval(approvalId: string, decision: "allow" | "deny", actor: string): void {
		const pending = this.#pendingApprovals.get(approvalId);
		if (!pending) return;
		this.#pendingApprovals.delete(approvalId);
		this.#resolved.set(pending.callId, { approvalId, actor });
		this.#pi.send({ type: "extension_ui_response", id: approvalId, value: decision === "allow" ? APPROVE : REJECT });
	}

	#findPendingByCallId(callId: string): string | undefined {
		for (const [id, p] of this.#pendingApprovals) if (p.callId === callId) return id;
		return undefined;
	}

	#onExit(info: { code: number | null; signal: NodeJS.Signals | null }): void {
		// 在途审批随进程一起消失，不能让前端一直挂着对话框
		for (const id of this.#pendingApprovals.keys()) {
			this.#emit({ type: "approval.resolved", approvalId: id, decision: "deny", actor: "system(session-exit)" });
		}
		this.#pendingApprovals.clear();
		if (this.#alive) {
			this.#alive = false;
			this.#audit({ kind: "session.end", summary: `pi 进程退出 code=${info.code} signal=${info.signal}` });
			this.#emit({ type: "error", code: "agent_error", message: `会话已终止（code=${info.code}）` });
		}
	}

	#emit(ev: ClientEvent): void {
		this.#seq += 1;
		this.#backlog.push(ev);
		const limit = this.#opts.backlogSize ?? 2000;
		if (this.#backlog.length > limit) this.#backlog.shift();
		this.#opts.send(ev, this.#seq);
	}

	#audit(input: Omit<AuditInput, "sessionId" | "actor" | "repo" | "team">): void {
		const entry = this.#opts.audit.append({
			...input,
			sessionId: this.#opts.sessionId,
			actor: this.#opts.actor,
			repo: this.#opts.repo,
			team: this.#opts.team,
		});
		this.#emit({
			type: "audit.entry",
			entry: { seq: entry.seq, at: entry.at, kind: entry.kind, summary: entry.summary, verdict: entry.verdict },
		});
	}
}

/** 客户端命令的最小校验。返回错误说明，或 null 表示通过。 */
function validate(cmd: unknown): string | null {
	if (typeof cmd !== "object" || cmd === null) return "命令必须是对象";
	const c = cmd as Record<string, unknown>;
	switch (c.type) {
		case "prompt":
		case "steer":
			return typeof c.text === "string" && c.text.length > 0 ? null : `${String(c.type)} 缺少 text`;
		case "abort":
			return null;
		case "approve":
			if (typeof c.approvalId !== "string") return "approve 缺少 approvalId";
			return c.decision === "allow" || c.decision === "deny" ? null : "approve 的 decision 只能是 allow/deny";
		case "resume":
			// 非负整数：负数会算出 missedFrom 为负的虚构缺口，
			// 前端照着 missedTo-missedFrom+1 会报"有 5 条未恢复"，纯属假警报
			return typeof c.since === "number" && Number.isInteger(c.since) && c.since >= 0
				? null
				: "resume 的 since 必须是非负整数";
		default:
			return `未知命令：${String(c.type)}`;
	}
}

function extensionPath(): string {
	return join(import.meta.dirname, "policy-extension.ts");
}
