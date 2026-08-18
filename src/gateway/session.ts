import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AuditLog, contentHash } from "../audit/log.ts";
import type { ClientCommand, ClientEvent } from "../protocol/types.ts";
import {
	type PiEvent,
	type PiResponse,
	type TranslateState,
	newTranslateState,
	toActionDescriptor,
	toClientEvent,
	toClientEventFromResponse,
	toPiCommand,
	summarizeAction,
} from "../protocol/translate.ts";
import { PiSession } from "../rpc/pi-session.ts";
import { AUDIT_PREFIX } from "./policy-extension.ts";

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
	/** 断线续接的事件缓存条数 */
	backlogSize?: number;
	send: (event: ClientEvent, seq: number) => void;
}

/**
 * 一个浏览器会话：把 pi 进程、策略引擎、审批门、审计日志串成一条链路。
 *
 * 两条纪律：
 * - 出口只有 ClientEvent。pi 的事件格式一律经 translate 转换，
 *   本文件之外（尤其是前端）看不到 pi 的字段名。
 * - 审计日志只有网关一个写入者。策略扩展跑在 pi 进程内，它的判决经
 *   扩展 UI 的 notify 通道回传到这里再落盘，而不是自己开一个 fd。
 */
export class Session {
	#opts: SessionOptions;
	#pi: PiSession;
	#tstate: TranslateState = newTranslateState();
	/** 已发出的事件，供断线续接重放 */
	#backlog: ClientEvent[] = [];
	#seq = 0;
	#model: string | null = null;
	/** 待人工审批的对话：approvalId → 尚未回答 */
	#pendingApprovals = new Set<string>();
	#toolNames = new Map<string, string>();

	constructor(opts: SessionOptions) {
		this.#opts = opts;
		mkdirSync(opts.workspace, { recursive: true });

		this.#pi = new PiSession({
			cwd: opts.workspace,
			bin: opts.piBin,
			args: [...(opts.piArgs ?? []), "-e", extensionPath()],
			env: {
				...(opts.piEnv ?? process.env),
				PERIMETER_POLICY_FILE: opts.policyFile,
				PERIMETER_REPO: opts.repo,
				PERIMETER_TEAM: opts.team,
				PERIMETER_APPROVAL_TIMEOUT_MS: String(opts.approvalTimeoutMs ?? 120_000),
			},
			onEvent: (e) => this.#onPiEvent(e),
			onResponse: (r) => this.#onPiResponse(r),
			onExit: (info) => this.#onExit(info),
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

	/**
	 * 会话建立后先取一次状态，拿到模型名再宣告 ready。
	 * 事件与审计一律从这里开始发 —— 构造函数里发事件会在调用方拿到实例之前
	 * 就回调 send()，那时 send 闭包引用的变量还没初始化。
	 */
	async start(): Promise<void> {
		this.#audit({ kind: "session.start", summary: `会话开始 workspace=${this.#opts.workspace}` });
		try {
			const res = await this.#pi.request({ type: "get_state" });
			for (const ev of toClientEventFromResponse(res)) {
				if (ev.type === "session.state") this.#model = ev.model;
				this.#emit(ev);
			}
		} catch (err) {
			this.#emit({ type: "error", code: "command_failed", message: `会话启动失败：${String(err)}` });
		}
		this.#emit({
			type: "session.ready",
			sessionId: this.#opts.sessionId,
			workspace: this.#opts.workspace,
			model: this.#model,
		});
	}

	handle(cmd: ClientCommand): void {
		if (cmd.type === "resume") {
			this.#replay(cmd.since);
			return;
		}
		if (cmd.type === "approve") {
			this.#resolveApproval(cmd.approvalId, cmd.decision);
			return;
		}
		if (cmd.type === "prompt") {
			this.#audit({ kind: "prompt", summary: `prompt（${cmd.text.length} 字符）`, argsHash: contentHash(cmd.text) });
		}
		const piCmd = toPiCommand(cmd);
		if (piCmd) this.#pi.send(piCmd);
	}

	async stop(): Promise<void> {
		this.#audit({ kind: "session.end", summary: "会话结束" });
		await this.#pi.stop();
	}

	/** 重放 since 之后的事件。pi 侧的 transcript 另有 session 文件，这里只补事件流。 */
	#replay(since: number): void {
		const start = Math.max(0, since - (this.#seq - this.#backlog.length));
		for (let i = start; i < this.#backlog.length; i++) {
			this.#opts.send(this.#backlog[i]!, this.#seq - this.#backlog.length + i + 1);
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
		this.#pendingApprovals.add(approvalId);
		const timeout = typeof ev.timeout === "number" ? ev.timeout : (this.#opts.approvalTimeoutMs ?? 120_000);
		this.#emit({
			type: "approval.request",
			approvalId,
			action: { tool: "unknown" },
			reason: String(ev.title ?? "需要人工确认"),
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
		const action = (v.action ?? { tool: "unknown" }) as { tool: string; path?: string; command?: string };
		const kind = String(v.kind ?? "");

		if (kind === "deny") {
			this.#audit({
				kind: "policy.verdict",
				summary: `拒绝：${summarizeAction(action)}`,
				callId: String(v.callId ?? ""),
				tool: action.tool,
				path: action.path,
				command: action.command,
				verdict: "deny",
				rule: String(v.rule ?? ""),
			});
			this.#emit({ type: "policy.denied", action, rule: String(v.rule ?? ""), reason: String(v.reason ?? "") });
		} else if (kind === "allow") {
			this.#audit({
				kind: "policy.verdict",
				summary: `放行：${summarizeAction(action)}`,
				callId: String(v.callId ?? ""),
				tool: action.tool,
				verdict: "allow",
			});
		} else if (kind === "approval.request") {
			this.#audit({
				kind: "approval.request",
				summary: `待审批：${summarizeAction(action)}`,
				callId: String(v.callId ?? ""),
				tool: action.tool,
				path: action.path,
				command: action.command,
				rule: String(v.rule ?? ""),
			});
		} else if (kind === "approval.decision") {
			const approved = v.approved === true;
			const timedOut = v.timedOut === true;
			this.#audit({
				kind: "approval.decision",
				summary: `${approved ? "已批准" : timedOut ? "超时拒绝" : "已拒绝"}：${summarizeAction(action)}`,
				callId: String(v.callId ?? ""),
				tool: action.tool,
				verdict: approved ? "allow" : "deny",
				rule: String(v.rule ?? ""),
				// 超时不是任何人做的决定，此时不该记一个审批人
				approver: approved || !timedOut ? this.#opts.actor : undefined,
			});
			// pi 对同一批工具调用是串行 preflight 的，因此同时最多挂起一个审批对话，
			// 判决上报（只带 callId）与对话（只带 UI id）可以据此对上。
			const approvalId = [...this.#pendingApprovals][0] ?? "";
			this.#pendingApprovals.delete(approvalId);
			this.#emit({
				type: "approval.resolved",
				approvalId,
				decision: approved ? "allow" : "deny",
				actor: timedOut ? "system(timeout)" : this.#opts.actor,
			});
		}
	}

	#resolveApproval(approvalId: string, decision: "allow" | "deny"): void {
		if (!this.#pendingApprovals.delete(approvalId)) return;
		this.#pi.send({ type: "extension_ui_response", id: approvalId, value: decision === "allow" ? "批准" : "拒绝" });
	}

	#onExit(info: { code: number | null; signal: NodeJS.Signals | null }): void {
		// 在途审批随进程一起消失，不能让前端一直挂着对话框
		for (const id of this.#pendingApprovals) {
			this.#emit({ type: "approval.resolved", approvalId: id, decision: "deny", actor: "system(session-exit)" });
		}
		this.#pendingApprovals.clear();
		this.#audit({ kind: "session.end", summary: `pi 进程退出 code=${info.code} signal=${info.signal}` });
		this.#emit({ type: "error", code: "agent_error", message: `会话已终止（code=${info.code}）` });
	}

	#emit(ev: ClientEvent): void {
		this.#seq += 1;
		this.#backlog.push(ev);
		const limit = this.#opts.backlogSize ?? 2000;
		if (this.#backlog.length > limit) this.#backlog.shift();
		this.#opts.send(ev, this.#seq);
	}

	#audit(input: Omit<Parameters<AuditLog["append"]>[0], "sessionId" | "actor" | "repo" | "team">): void {
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

function extensionPath(): string {
	return join(import.meta.dirname, "policy-extension.ts");
}
