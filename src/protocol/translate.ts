import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";
import type { ActionDescriptor, ClientEvent, SessionView, Usage } from "./types.ts";

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


function truncate(s: string, n: number): string { return s.length <= n ? s : s.slice(0, n) + "…"; }

function text(message: { content: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

export function usageView(raw: SnapshotEvent["usage"]): Usage {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
	for (const u of [...Object.values(raw.models), ...Object.values(raw.tools)]) {
		usage.input += u.input; usage.output += u.output; usage.cacheRead += u.cacheRead; usage.cacheWrite += u.cacheWrite;
		usage.total += u.totalTokens; usage.cost += u.cost.total;
	}
	return usage;
}

export function snapshotView(snapshot: SnapshotEvent, sessionId: string): SessionView {
	const messages: SessionView["messages"] = [];
	const tools: SessionView["tools"] = [];
	for (const entry of snapshot.entries) for (const message of entry.model ?? []) {
		if (message.role === "user" || message.role === "assistant") messages.push({ id: String(entry.id), role: message.role, text: text(message), thinking: "" });
		if (message.role === "toolResult") tools.push({ callId: message.toolCallId, action: { tool: message.toolName }, output: text(message), ok: !message.isError });
	}
	if (snapshot.generation?.message) messages.push({ id: "live", role: "assistant", text: text(snapshot.generation.message), thinking: "" });
	for (const tool of snapshot.tools) if (!tools.some((item) => item.callId === tool.callId)) tools.push({ callId: tool.callId, action: { tool: tool.name }, output: tool.output ?? "" });
	return { sessionId, model: snapshot.agent.model?.modelId ?? null, streaming: !!snapshot.run, messages, tools,
		inbox: snapshot.inbox.map((item) => ({ id: String(item.id), mode: item.mode })), approvals: [], participants: [], usage: usageView(snapshot.usage), audit: [], role: "owner" };
}

export interface TranslateState { messageId: string; outputs: Map<string, string> }
export function newTranslateState(): TranslateState { return { messageId: "live", outputs: new Map() }; }

export function toClientEvent(event: AgentEvent, state: TranslateState): ClientEvent[] {
	switch (event.type) {
		case "run_start": return [{ type: "agent.start" }];
		case "run_end": return [{ type: "agent.end", willRetry: false }, { type: "agent.settled" }];
		case "message_start":
			if (event.message.role === "toolResult" || event.message.role === "system") return [];
			state.messageId = event.message.role === "assistant" ? "live" : "user-live";
			return [{ type: "message.start", messageId: state.messageId, role: event.message.role }, ...(event.message.role === "user" ? [{ type: "message.text" as const, messageId: state.messageId, delta: text(event.message) }] : [])];
		case "message_update": return event.changes.flatMap((change): ClientEvent[] => change.type === "text_delta" || change.type === "thinking_delta" ? [{ type: change.type === "text_delta" ? "message.text" : "message.thinking", messageId: state.messageId, delta: change.delta }] : []);
		case "message_end": {
			const message = event.entry.model?.[0];
			if (!message || message.role === "system" || message.role === "toolResult") return [];
			const events: ClientEvent[] = [{ type: "message.end", messageId: state.messageId, text: text(message) }];
			if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) events.push({ type: "error", code: message.stopReason === "aborted" ? "aborted" : "agent_error", message: message.errorMessage ?? message.stopReason });
			return events;
		}
		case "tool_execution_start": { const action = forClient(toActionDescriptor(event.toolName, event.args)); return [{ type: "tool.start", callId: event.toolCallId, action, summary: summarizeAction(action) }]; }
		case "tool_execution_update": {
			let output = state.outputs.get(event.toolCallId) ?? "";
			if (event.output) output = "set" in event.output ? event.output.set : output.slice(event.output.trimStart ?? 0) + (event.output.append ?? "");
			state.outputs.set(event.toolCallId, output);
			return [{ type: "tool.progress", callId: event.toolCallId, output }];
		}
		case "tool_execution_end": { const result = event.entry?.model?.[0]; state.outputs.delete(event.toolCallId); return [{ type: "tool.end", callId: event.toolCallId, ok: result?.role === "toolResult" && !result.isError, output: result ? text(result) : "工具任务中断" }]; }
		case "usage_changed": return [{ type: "usage", usage: usageView(event.usage) }];
		case "auto_retry_start": return [{ type: "agent.status", phase: "retrying", detail: "模型请求重试" }];
		case "compaction_start": return [{ type: "agent.status", phase: "compacting", detail: "压缩上下文" }];
		case "task_failed": return [{ type: "error", code: "agent_error", message: event.message }];
		default: return [];
	}
}
