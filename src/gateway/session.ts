import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
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
	#pi: PiSession;
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
	#queuedWhileDisarmed: ClientCommand[] = [];

	#toolNames = new Map<string, string>();
	#sandboxHome: string | undefined;

	constructor(opts: SessionOptions) {
		this.#opts = opts;
		mkdirSync(opts.workspace, { recursive: true });

		// 接线：沙箱只拿到指向两个代理的配置，真凭据留在代理进程里
		const wired =
			opts.wiring && opts.sandboxHome ? writeSandboxConfig(opts.sandboxHome, opts.wiring) : null;
		this.#sandboxHome = wired?.home;

		this.#pi = new PiSession({
			cwd: opts.workspace,
			bin: opts.piBin,
			args: [...(opts.piArgs ?? []), ...(wired?.piArgs ?? []), "-e", extensionPath()],
			// 只传显式给定的环境变量。继承 process.env 会把网关的共享 token
			// 与模型 key 一起交给 pi，而 pi 会执行 agent 的 bash 工具 ——
			// agent 跑一句 env 就拿到了，与「凭据不进沙箱」正面冲突。
			env: {
				...(opts.piEnv ?? {}),
				// 接线生成的 HOME 覆盖调用方给的：pi 从这里读 models.json 与 .gitconfig
				...(wired ? { HOME: wired.home } : {}),
				PERIMETER_POLICY_FILE: opts.policyFile,
				PERIMETER_REPO: opts.repo,
				PERIMETER_TEAM: opts.team,
				PERIMETER_APPROVAL_TIMEOUT_MS: String(opts.approvalTimeoutMs ?? 120_000),
			},
			onEvent: (e) => this.#onPiEvent(e),
			onResponse: (r) => this.#onPiResponse(r),
			onExit: (info) => this.#onExit(info),
			// pi 的致命错误（扩展加载失败等）只出现在 stderr。不接就等于
			// 「会话起不来，日志里什么都没有」。
			onStderr: (text) => this.#onStderr(text),
			onProtocolError: (line, err) =>
				this.#emit({ type: "error", code: "command_failed", message: `协议错误：${String(err)}（${line.slice(0, 80)}）` }),
		});
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
		if (this.#opts.repoUrl && !(await this.#cloneRepo(this.#opts.repoUrl))) return;
		try {
			const res = await this.#pi.request({ type: "get_state" });
			for (const ev of toClientEventFromResponse(res)) {
				if (ev.type === "session.state") this.#model = ev.model;
				this.#emit(ev);
			}
		} catch (err) {
			// 起不来就别宣告 ready：前端显示「就绪」而 pi 已死是最难排查的状态
			this.#alive = false;
			this.#emit({ type: "error", code: "agent_error", message: `会话启动失败：${String(err)}` });
			return;
		}
		this.#emit({
			type: "session.ready",
			sessionId: this.#opts.sessionId,
			workspace: this.#opts.workspace,
			model: this.#model,
		});
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
		// 钩子未确认挂上之前，prompt 先排队：此时执行工具等于无策略保护
		if (!this.#hookArmed && (cmd.type === "prompt" || cmd.type === "steer")) {
			this.#queuedWhileDisarmed.push(cmd);
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

		const home = this.#sandboxHome;
		const started = Date.now();
		try {
			await new Promise<void>((resolve, reject) => {
				// `--` 分隔：repoUrl 来自配置而非客户端，但以 `-` 开头的值会被
				// git 当成选项（如 --upload-pack=<cmd>），这是一条命令注入路径
				const proc = spawn("git", ["clone", "-q", "--", repoUrl, "."], {
					cwd: this.#opts.workspace,
					env: { PATH: process.env.PATH ?? "", HOME: home ?? this.#opts.workspace, GIT_TERMINAL_PROMPT: "0" },
					stdio: ["ignore", "ignore", "pipe"],
				});
				// 卡住的 clone（上游无响应）会让会话永远停在启动中，前端只看到一片空白
				const timer = setTimeout(() => {
					proc.kill("SIGKILL");
					reject(new Error(`clone 超时（${this.#opts.cloneTimeoutMs ?? 120_000}ms）`));
				}, this.#opts.cloneTimeoutMs ?? 120_000);
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
			this.#alive = false;
			this.#audit({ kind: "error", summary: `clone 失败：${String(err).slice(0, 200)}` });
			this.#emit({ type: "error", code: "agent_error", message: `仓库 clone 失败：${String(err).slice(0, 300)}` });
			return false;
		}
		// 冷启动打点：Week 3 的目标是含 clone < 5s
		this.#audit({ kind: "session.start", summary: `clone 完成（${Date.now() - started}ms）`, durationMs: Date.now() - started });
		return true;
	}

	async stop(): Promise<void> {
		if (this.#alive) this.#audit({ kind: "session.end", summary: "会话结束" });
		this.#alive = false;
		await this.#pi.stop();
	}

	/** 重放 since 之后的事件。只回发起方，避免洪泛给其他标签页。 */
	#replay(since: number, to?: unknown): void {
		const firstSeq = this.#seq - this.#backlog.length + 1;
		for (let i = 0; i < this.#backlog.length; i++) {
			const seq = firstSeq + i;
			if (seq > since) this.#opts.send(this.#backlog[i]!, seq, to);
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
			for (const cmd of this.#queuedWhileDisarmed.splice(0)) this.handle(cmd);
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
			return typeof c.since === "number" && Number.isFinite(c.since) ? null : "resume 的 since 必须是数字";
		default:
			return `未知命令：${String(c.type)}`;
	}
}

function extensionPath(): string {
	return join(import.meta.dirname, "policy-extension.ts");
}
