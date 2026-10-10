import type { AssistantMessage } from "@earendil-works/pi-ai";
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

function thinking(message: { content: unknown }): string {
	if (!Array.isArray(message.content)) return "";
	return message.content.filter((block) => block.type === "thinking").map((block) => block.thinking).join("");
}

export function usageView(raw: SnapshotEvent["usage"]): Usage {
	const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, cacheHitRate: null };
	for (const u of [...Object.values(raw.models), ...Object.values(raw.tools)]) {
		usage.input += u.input; usage.output += u.output; usage.cacheRead += u.cacheRead; usage.cacheWrite += u.cacheWrite;
		usage.total += u.totalTokens; usage.cost += u.cost.total;
	}
	const denominator = usage.input + usage.cacheRead + usage.cacheWrite;
	usage.cacheHitRate = denominator === 0 ? null : usage.cacheRead / denominator;
	return usage;
}

export function snapshotView(snapshot: SnapshotEvent, sessionId: string): SessionView {
	const messages: SessionView["messages"] = [];
	const tools: SessionView["tools"] = [];
	const intents = new Map<string, ActionDescriptor>();
	for (const entry of snapshot.entries) for (const message of entry.model ?? []) if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") intents.set(block.id, forClient(toActionDescriptor(block.name, block.arguments)));
	for (const entry of snapshot.entries) for (const message of entry.model ?? []) {
		if (message.role === "user" || message.role === "assistant") messages.push({ id: String(entry.id), order: Number(entry.id), role: message.role, text: text(message), thinking: thinking(message) });
		if (message.role === "toolResult") tools.push({ callId: message.toolCallId, order: Number(entry.id), action: intents.get(message.toolCallId) ?? { tool: message.toolName }, output: text(message), ok: !message.isError });
	}
	if (snapshot.generation?.message) messages.push({ id: "live", order: Number.MAX_SAFE_INTEGER - 1, role: "assistant", text: text(snapshot.generation.message), thinking: thinking(snapshot.generation.message) });
	for (const tool of snapshot.tools) if (!tools.some((item) => item.callId === tool.callId)) tools.push({ callId: tool.callId, order: Number.MAX_SAFE_INTEGER, action: intents.get(tool.callId) ?? { tool: tool.name }, output: tool.output ?? "" });
	return { sessionId, model: snapshot.agent.model?.modelId ?? null, streaming: !!snapshot.run, messages, tools,
		inbox: snapshot.inbox.map((item) => ({ id: String(item.id), mode: item.mode })), approvals: [], participants: [], usage: usageView(snapshot.usage), audit: [], role: "owner" };
}

export interface TranslateState {
	messageId: string;
	content: AssistantMessage["content"];
	outputs: Map<string, string>;
	intents: Map<string, ActionDescriptor>;
}
export function newTranslateState(snapshot?: SnapshotEvent): TranslateState {
	const state: TranslateState = { messageId: "live", content: structuredClone(snapshot?.generation?.message?.content ?? []), outputs: new Map<string, string>(), intents: new Map<string, ActionDescriptor>() };
	for (const entry of snapshot?.entries ?? []) for (const message of entry.model ?? []) rememberIntents(message, state);
	if (snapshot?.generation?.message) rememberIntents(snapshot.generation.message, state);
	for (const tool of snapshot?.tools ?? []) state.outputs.set(tool.callId, tool.output ?? "");
	return state;
}

function rememberIntents(message: { content: unknown }, state: TranslateState): void {
	if (!Array.isArray(message.content)) return;
	for (const block of message.content) if (block.type === "toolCall") {
		state.intents.set(block.id, forClient(toActionDescriptor(block.name, block.arguments)));
	}
}

export function toClientEvent(event: AgentEvent, state: TranslateState): ClientEvent[] {
	switch (event.type) {
		case "run_start": return [{ type: "agent.start" }];
		case "run_end": return [{ type: "agent.end", willRetry: false }, { type: "agent.settled" }];
		case "inbox_update": return [{ type: "inbox.update", items: event.items.map((item) => ({ id: String(item.id), mode: item.mode })) }];
		case "message_start": {
			if (event.message.role === "toolResult" || event.message.role === "system") return [];
			rememberIntents(event.message, state);
			state.content = Array.isArray(event.message.content) ? structuredClone(event.message.content) as AssistantMessage["content"] : [];
			state.messageId = event.message.role === "assistant" ? "live" : "user-live";
			return [
				{ type: "message.start", messageId: state.messageId, role: event.message.role, order: Number.MAX_SAFE_INTEGER - 1 },
				{ type: "message.text", messageId: state.messageId, delta: text(event.message) },
				{ type: "message.thinking", messageId: state.messageId, delta: thinking(event.message) },
			];
		}
		case "message_update": return event.changes.flatMap((change): ClientEvent[] => {
			const before = { text: text({ content: state.content }), thinking: thinking({ content: state.content }) };
			if (change.type === "message") state.content = structuredClone(change.message.content);
			else if (change.type === "text_delta" || change.type === "thinking_delta") {
				const block = state.content[change.contentIndex];
				if (block?.type === "text" && change.type === "text_delta") block.text += change.delta;
				if (block?.type === "thinking" && change.type === "thinking_delta") block.thinking += change.delta;
			} else if ("block" in change) state.content[change.contentIndex] = structuredClone(change.block);
			rememberIntents({ content: state.content }, state);
			const after = { text: text({ content: state.content }), thinking: thinking({ content: state.content }) };
			if (!after.text.startsWith(before.text) || !after.thinking.startsWith(before.thinking)) {
				return [{ type: "message.end", messageId: state.messageId, ...after }];
			}
			const events: ClientEvent[] = [];
			if (after.text !== before.text) events.push({ type: "message.text", messageId: state.messageId, delta: after.text.slice(before.text.length) });
			if (after.thinking !== before.thinking) events.push({ type: "message.thinking", messageId: state.messageId, delta: after.thinking.slice(before.thinking.length) });
			return events;
		});
		case "message_end": {
			const message = event.entry.model?.[0];
			if (!message || message.role === "system" || message.role === "toolResult") return [];
			rememberIntents(message, state);
			const events: ClientEvent[] = [{
				type: "message.end", messageId: state.messageId, entryId: String(event.entry.id), order: Number(event.entry.id),
				text: text(message), thinking: thinking(message),
			}];
			if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
				events.push({ type: "error", code: message.stopReason === "aborted" ? "aborted" : "agent_error", message: message.errorMessage ?? message.stopReason });
			}
			return events;
		}
		case "tool_execution_start": {
			const action = forClient(toActionDescriptor(event.toolName, event.args));
			state.intents.set(event.toolCallId, action);
			return [{ type: "tool.start", callId: event.toolCallId, action, summary: summarizeAction(action) }];
		}
		case "tool_execution_update": {
			let output = state.outputs.get(event.toolCallId) ?? "";
			if (event.output) output = "set" in event.output ? event.output.set : output.slice(event.output.trimStart ?? 0) + (event.output.append ?? "");
			state.outputs.set(event.toolCallId, output);
			return [{ type: "tool.progress", callId: event.toolCallId, output }];
		}
		case "tool_execution_end": {
			const result = event.entry?.model?.[0];
			state.outputs.delete(event.toolCallId);
			return [{
				type: "tool.end", callId: event.toolCallId, ok: result?.role === "toolResult" && !result.isError,
				output: result ? text(result) : "工具任务中断", action: state.intents.get(event.toolCallId) ?? { tool: event.toolName },
				order: event.entry ? Number(event.entry.id) : Number.MAX_SAFE_INTEGER,
			}];
		}
		case "usage_changed": return [{ type: "usage", usage: usageView(event.usage) }];
		case "auto_retry_start": return [{ type: "agent.status", phase: "retrying", detail: "模型请求重试" }];
		case "compaction_start": return [{ type: "agent.status", phase: "compacting", detail: "压缩上下文" }];
		case "task_failed": return [{ type: "error", code: "agent_error", message: event.message }];
		default: return [];
	}
}
