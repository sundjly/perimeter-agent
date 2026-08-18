/**
 * pi RPC 格式 ↔ 自有协议 的唯一转换点。
 *
 * Phase 2 迁到 AgentHarness 直连时，只有这个文件被替换。
 * 任何 pi 特有的字段名（assistantMessageEvent / toolCallId / partialResult /
 * stopReason / totalTokens …）都不允许泄漏到这个文件之外。
 */

import type { ActionDescriptor, ClientCommand, ClientEvent, Usage } from "./types.ts";

/** 一个 pi RPC 事件 —— 结构在本文件内按需窄化，网关其余部分不感知 */
export type PiEvent = { type: string; [k: string]: unknown };

/** 一个 pi RPC 命令响应 */
export type PiResponse = { type: "response"; command: string; success: boolean; [k: string]: unknown };

/** 一个 pi RPC 命令 */
export type PiCommand = { type: string; [k: string]: unknown };

/** 流式转换所需的最小状态：pi 不再下发累积 message，需本地重建 */
export interface TranslateState {
	messageSeq: number;
	currentMessageId: string | null;
	textBuffer: string;
	/** usage 是每条 message_update 都带的累计快照，只在变化时下发 */
	lastUsageTotal: number;
}

export function newTranslateState(): TranslateState {
	return { messageSeq: 0, currentMessageId: null, textBuffer: "", lastUsageTotal: -1 };
}

/**
 * 一个 pi 事件映射为 0..n 个客户端事件。
 * 未知事件返回空数组而不是抛错 —— pi 升级新增事件不应打断会话。
 */
export function toClientEvent(ev: PiEvent, st: TranslateState): ClientEvent[] {
	switch (ev.type) {
		case "agent_start":
			return [{ type: "agent.start" }];

		case "agent_end":
			return [{ type: "agent.end", willRetry: ev.willRetry === true }];

		case "agent_settled":
			return [{ type: "agent.settled" }, { type: "agent.status", phase: "idle", detail: "" }];

		case "message_start": {
			// pi 对 user / assistant / toolResult 三种消息都发生命周期事件。
			// 工具结果已由 tool.* 事件表达，再作为消息透传会重复渲染。
			const role = readRole(ev.message);
			if (role === null) return [];
			st.messageSeq += 1;
			st.currentMessageId = `m${st.messageSeq}`;
			st.textBuffer = "";
			return [{ type: "message.start", messageId: st.currentMessageId, role }];
		}

		case "message_update":
			return translateUpdate(ev, st);

		case "message_end": {
			if (readRole(ev.message) === null) return [];
			const id = st.currentMessageId ?? `m${st.messageSeq}`;
			const text = readText(ev.message) ?? st.textBuffer;
			st.currentMessageId = null;
			st.textBuffer = "";
			const out: ClientEvent[] = [{ type: "message.end", messageId: id, text }];
			// 运行失败与用户中止不发 error 事件，而是一条 stopReason 异常的空 assistant 消息
			const failure = readFailure(ev.message);
			if (failure) out.push(failure);
			return out;
		}

		case "tool_execution_start": {
			const action = toActionDescriptor(String(ev.toolName ?? ""), ev.args);
			return [
				{ type: "tool.start", callId: String(ev.toolCallId ?? ""), action: forClient(action), summary: summarizeAction(action) },
			];
		}

		case "tool_execution_update":
			return [{ type: "tool.progress", callId: String(ev.toolCallId ?? ""), output: readContentText(ev.partialResult) }];

		case "tool_execution_end":
			return [
				{ type: "tool.end", callId: String(ev.toolCallId ?? ""), ok: ev.isError !== true, output: readContentText(ev.result) },
			];

		case "auto_retry_start":
			return [
				{
					type: "agent.status",
					phase: "retrying",
					detail: `第 ${ev.attempt ?? "?"}/${ev.maxAttempts ?? "?"} 次重试，${ev.delayMs ?? "?"}ms 后开始：${ev.errorMessage ?? ""}`,
				},
			];

		case "auto_retry_end":
			return [{ type: "agent.status", phase: "idle", detail: "" }];

		case "compaction_start":
			return [{ type: "agent.status", phase: "compacting", detail: "正在压缩上下文" }];

		case "compaction_end":
			return [{ type: "agent.status", phase: "idle", detail: String(ev.errorMessage ?? "") }];

		case "extension_error":
			return [{ type: "error", code: "extension_error", message: String(ev.error ?? "extension failed") }];

		// turn_start / turn_end / queue_update / summarization_* 对操作面无信息增量，刻意不透传。
		default:
			return [];
	}
}

/**
 * pi 的命令响应帧 → 客户端事件。
 * session.state 只能从 get_state 的响应里拿，没有这个函数网关就得自己去读
 * data.model.id / data.isStreaming，那等于把 pi 的字段名泄漏出转换层。
 */
export function toClientEventFromResponse(res: PiResponse): ClientEvent[] {
	if (!res.success) {
		return [{ type: "error", code: "command_failed", message: `${res.command}: ${String(res.error ?? "failed")}` }];
	}
	if (res.command === "get_state") {
		const d = (res.data ?? {}) as Record<string, unknown>;
		return [
			{
				type: "session.state",
				streaming: d.isStreaming === true,
				messageCount: typeof d.messageCount === "number" ? d.messageCount : 0,
				model: readModelId(d.model),
			},
		];
	}
	return [];
}

function translateUpdate(ev: PiEvent, st: TranslateState): ClientEvent[] {
	const out: ClientEvent[] = [];
	const id = st.currentMessageId ?? `m${st.messageSeq}`;
	const delta = ev.assistantMessageEvent as { type?: string; delta?: string } | undefined;

	if (delta?.type === "text_delta" && delta.delta) {
		st.textBuffer += delta.delta;
		out.push({ type: "message.text", messageId: id, delta: delta.delta });
	} else if (delta?.type === "thinking_delta" && delta.delta) {
		out.push({ type: "message.thinking", messageId: id, delta: delta.delta });
	}

	const usage = readUsage(ev.usage);
	if (usage && usage.total !== st.lastUsageTotal) {
		st.lastUsageTotal = usage.total;
		out.push({ type: "usage", usage });
	}
	return out;
}

/** 浏览器命令 → pi 命令。返回 null 表示该命令由网关自行消费，不下发。 */
export function toPiCommand(cmd: ClientCommand): PiCommand | null {
	switch (cmd.type) {
		case "prompt":
			return { type: "prompt", message: cmd.text, streamingBehavior: "steer" };
		case "steer":
			return { type: "steer", message: cmd.text };
		case "abort":
			return { type: "abort" };
		// approve / resume 是边界层语义，pi 不认识
		case "approve":
		case "resume":
			return null;
	}
}

/**
 * 从工具调用抽出与执行后端无关的动作描述。
 * 策略引擎与审计日志都只认这个结构，不认 pi 的参数形状。
 */
export function toActionDescriptor(toolName: string, args: unknown): ActionDescriptor {
	const a = (args ?? {}) as Record<string, unknown>;
	const action: ActionDescriptor = { tool: toolName, args };
	if (typeof a.command === "string") action.command = a.command;
	if (typeof a.path === "string") action.path = a.path;
	return action;
}

/** 下发浏览器前剥掉原始参数：write/edit 的参数含整份文件内容 */
export function forClient(a: ActionDescriptor): ActionDescriptor {
	const { args: _args, ...rest } = a;
	return rest;
}

export function summarizeAction(a: ActionDescriptor): string {
	if (a.command) return `${a.tool}: ${truncate(a.command, 120)}`;
	if (a.path) return `${a.tool}: ${a.path}`;
	return a.tool;
}

/** 返回 null 表示这条消息不该作为对话消息呈现（如工具结果） */
function readRole(message: unknown): "user" | "assistant" | null {
	const r = (message as { role?: unknown } | undefined)?.role;
	if (r === "user") return "user";
	if (r === "assistant") return "assistant";
	return null;
}

/** 失败与中止表现为一条 stopReason 异常的 assistant 消息，而非 error 事件 */
function readFailure(message: unknown): ClientEvent | null {
	const m = message as { stopReason?: unknown; errorMessage?: unknown } | undefined;
	if (m?.stopReason === "aborted") return { type: "error", code: "aborted", message: "已中止" };
	if (m?.stopReason === "error") {
		return { type: "error", code: "agent_error", message: String(m.errorMessage ?? "agent run failed") };
	}
	return null;
}

function readText(message: unknown): string | null {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	return content
		.filter(isTextBlock)
		.map((c) => c.text)
		.join("");
}

/** tool result / partialResult 的 content 数组 → 纯文本 */
function readContentText(result: unknown): string {
	const content = (result as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isTextBlock)
		.map((c) => c.text)
		.join("");
}

function readUsage(raw: unknown): Usage | null {
	const u = raw as Record<string, unknown> | undefined;
	if (!u || typeof u.totalTokens !== "number" || u.totalTokens <= 0) return null;
	const cost = u.cost as { total?: number } | undefined;
	return {
		input: numberOf(u.input),
		output: numberOf(u.output),
		cacheRead: numberOf(u.cacheRead),
		cacheWrite: numberOf(u.cacheWrite),
		total: u.totalTokens,
		cost: numberOf(cost?.total),
	};
}

function readModelId(model: unknown): string | null {
	const id = (model as { id?: unknown } | undefined)?.id;
	return typeof id === "string" && id !== "unknown" ? id : null;
}

function isTextBlock(c: unknown): c is { type: "text"; text: string } {
	const b = c as { type?: unknown; text?: unknown };
	return b?.type === "text" && typeof b.text === "string";
}

function numberOf(v: unknown): number {
	return typeof v === "number" ? v : 0;
}

function truncate(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n)}…`;
}
