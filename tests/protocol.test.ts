import assert from "node:assert/strict";
import { test } from "node:test";
import {
	newTranslateState,
	toActionDescriptor,
	toClientEvent,
	toClientEventFromResponse,
	toPiCommand,
} from "../src/protocol/translate.ts";

function startedState() {
	const st = newTranslateState();
	toClientEvent({ type: "message_start", message: { role: "assistant" } }, st);
	return st;
}

test("文本增量被翻译为 message.text 并本地累积", () => {
	const st = startedState();
	const out = toClientEvent(
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" } },
		st,
	);
	assert.deepEqual(out, [{ type: "message.text", messageId: "m1", delta: "Hello" }]);
	assert.equal(st.textBuffer, "Hello");
});

test("message_end 缺少 content 时回落到本地累积的文本", () => {
	const st = startedState();
	toClientEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ab" } }, st);
	toClientEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "cd" } }, st);
	assert.deepEqual(toClientEvent({ type: "message_end", message: { role: "assistant" } }, st), [
		{ type: "message.end", messageId: "m1", text: "abcd" },
	]);
});

test("message_end 优先采用权威 message.content，多个 text block 按序拼接", () => {
	const st = startedState();
	toClientEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "部分" } }, st);
	const out = toClientEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "第一段" },
					{ type: "toolCall", id: "c1" },
					{ type: "text", text: "第二段" },
				],
			},
		},
		st,
	);
	assert.deepEqual(out, [{ type: "message.end", messageId: "m1", text: "第一段第二段" }]);
});

test("工具结果消息不作为对话消息透传，也不推进消息编号", () => {
	const st = startedState();
	const tr = { role: "toolResult", content: [{ type: "text", text: "total 48" }] };
	assert.deepEqual(toClientEvent({ type: "message_start", message: tr }, st), []);
	assert.deepEqual(toClientEvent({ type: "message_end", message: tr }, st), []);
	assert.equal(st.messageSeq, 1);
	assert.equal(st.currentMessageId, "m1");
});

test("user 消息也走消息生命周期", () => {
	const st = newTranslateState();
	assert.deepEqual(toClientEvent({ type: "message_start", message: { role: "user" } }, st), [
		{ type: "message.start", messageId: "m1", role: "user" },
	]);
});

test("运行失败表现为 stopReason=error 的空消息，必须翻译成 error 事件", () => {
	const st = startedState();
	const out = toClientEvent(
		{
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "429 rate limited" },
		},
		st,
	);
	assert.deepEqual(out, [
		{ type: "message.end", messageId: "m1", text: "" },
		{ type: "error", code: "agent_error", message: "429 rate limited" },
	]);
});

test("用户中止有独立错误码，不与运行失败混淆", () => {
	const st = startedState();
	const out = toClientEvent(
		{ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Aborted" } },
		st,
	);
	assert.equal(out[1]?.type, "error");
	assert.deepEqual(out[1], { type: "error", code: "aborted", message: "已中止" });
});

test("thinking 增量走独立通道，不污染文本缓冲", () => {
	const st = startedState();
	const out = toClientEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "推理中" } }, st);
	assert.deepEqual(out, [{ type: "message.thinking", messageId: "m1", delta: "推理中" }]);
	assert.equal(st.textBuffer, "");
});

test("usage 含 cache 字段，且 total 与 input+output 的差额可被解释", () => {
	const st = startedState();
	const out = toClientEvent(
		{
			type: "message_update",
			usage: { input: 100, output: 5, cacheRead: 4000, cacheWrite: 20, totalTokens: 4125, cost: { total: 0.002 } },
			assistantMessageEvent: { type: "text_delta", delta: "x" },
		},
		st,
	);
	assert.deepEqual(out[1], {
		type: "usage",
		usage: { input: 100, output: 5, cacheRead: 4000, cacheWrite: 20, total: 4125, cost: 0.002 },
	});
});

test("usage 是累计快照，未变化时不重复下发", () => {
	const st = startedState();
	const usage = { input: 100, output: 5, totalTokens: 105, cost: { total: 0.001 } };
	const first = toClientEvent({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", delta: "a" } }, st);
	const second = toClientEvent({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", delta: "b" } }, st);
	assert.equal(first.length, 2);
	assert.equal(second.length, 1);
});

test("usage 为 0 时不下发计量事件", () => {
	const st = startedState();
	const out = toClientEvent(
		{ type: "message_update", usage: { input: 0, output: 0, totalTokens: 0 }, assistantMessageEvent: { type: "text_delta", delta: "x" } },
		st,
	);
	assert.equal(out.length, 1);
});

test("工具生命周期三事件被翻译，且原始参数不下发浏览器", () => {
	const st = newTranslateState();
	const start = toClientEvent(
		{ type: "tool_execution_start", toolCallId: "c1", toolName: "write", args: { path: "a.ts", content: "整份文件内容" } },
		st,
	);
	assert.deepEqual(start, [
		{ type: "tool.start", callId: "c1", action: { tool: "write", path: "a.ts" }, summary: "write: a.ts" },
	]);

	assert.deepEqual(
		toClientEvent({ type: "tool_execution_update", toolCallId: "c1", partialResult: { content: [{ type: "text", text: "部分" }] } }, st),
		[{ type: "tool.progress", callId: "c1", output: "部分" }],
	);

	assert.deepEqual(
		toClientEvent({ type: "tool_execution_end", toolCallId: "c1", result: { content: [{ type: "text", text: "err" }] }, isError: true }, st),
		[{ type: "tool.end", callId: "c1", ok: false, output: "err" }],
	);
});

test("重试与压缩的静默期被解释给操作面", () => {
	const st = newTranslateState();
	const retry = toClientEvent(
		{ type: "auto_retry_start", attempt: 2, maxAttempts: 5, delayMs: 4000, errorMessage: "overloaded" },
		st,
	);
	assert.equal(retry[0]?.type, "agent.status");
	assert.match(JSON.stringify(retry[0]), /retrying.*2\/5.*4000.*overloaded/);
	assert.deepEqual(toClientEvent({ type: "compaction_start" }, st), [
		{ type: "agent.status", phase: "compacting", detail: "正在压缩上下文" },
	]);
});

test("未知 pi 事件被静默丢弃而不是抛错", () => {
	const st = newTranslateState();
	assert.deepEqual(toClientEvent({ type: "some_future_event", data: 1 }, st), []);
	assert.deepEqual(toClientEvent({ type: "queue_update" }, st), []);
});

test("get_state 响应被翻译成自有的 session.state", () => {
	assert.deepEqual(
		toClientEventFromResponse({
			type: "response",
			command: "get_state",
			success: true,
			data: { isStreaming: true, messageCount: 5, model: { id: "claude-opus-5", name: "Opus" } },
		}),
		[{ type: "session.state", streaming: true, messageCount: 5, model: "claude-opus-5" }],
	);
});

test("未配置模型时 model 为 null 而非 pi 的占位串", () => {
	const out = toClientEventFromResponse({
		type: "response",
		command: "get_state",
		success: true,
		data: { isStreaming: false, messageCount: 0, model: { id: "unknown" } },
	});
	assert.deepEqual(out, [{ type: "session.state", streaming: false, messageCount: 0, model: null }]);
});

test("命令失败的响应不被吞掉", () => {
	assert.deepEqual(
		toClientEventFromResponse({ type: "response", command: "prompt", success: false, error: "agent is streaming" }),
		[{ type: "error", code: "command_failed", message: "prompt: agent is streaming" }],
	);
});

test("其余成功响应不产生客户端事件", () => {
	assert.deepEqual(toClientEventFromResponse({ type: "response", command: "abort", success: true }), []);
});

test("命令转换：prompt 默认带 steer 行为，避免流式中被拒", () => {
	assert.deepEqual(toPiCommand({ type: "prompt", text: "hi" }), {
		type: "prompt",
		message: "hi",
		streamingBehavior: "steer",
	});
	assert.deepEqual(toPiCommand({ type: "abort" }), { type: "abort" });
});

test("审批与续接命令不下发给 pi", () => {
	assert.equal(toPiCommand({ type: "approve", approvalId: "a1", decision: "allow" }), null);
	assert.equal(toPiCommand({ type: "resume", since: 0 }), null);
});

test("动作描述与执行后端无关：bash 取 command，文件工具取 path", () => {
	assert.deepEqual(toActionDescriptor("bash", { command: "git push" }), {
		tool: "bash",
		args: { command: "git push" },
		command: "git push",
	});
	assert.deepEqual(toActionDescriptor("noargs", undefined), { tool: "noargs", args: undefined });
});
