import assert from "node:assert/strict";
import { test } from "node:test";
import { newTranslateState, toActionDescriptor, forClient, summarizeAction, toClientEvent, snapshotView } from "../src/protocol/translate.ts";

test("durable 工具参数留在服务端，自有协议不带源码", () => {
	const state = newTranslateState();
	const result = toClientEvent({ type: "tool_execution_start", toolCallId: "c", toolName: "write", args: { path: "a.ts", content: "secret-code" } }, state);
	assert.deepEqual(result, [{ type: "tool.start", callId: "c", action: { tool: "write", path: "a.ts" }, summary: "write: a.ts" }]);
	assert.ok(!JSON.stringify(result).includes("secret-code"));
});
test("durable 输出 trim/append/set 都转换为累计快照", () => {
	const state = newTranslateState();
	toClientEvent({ type: "tool_execution_update", toolCallId: "c", toolName: "bash", output: { set: "abc" } }, state);
	assert.deepEqual(toClientEvent({ type: "tool_execution_update", toolCallId: "c", toolName: "bash", output: { trimStart: 1, append: "d" } }, state), [{ type: "tool.progress", callId: "c", output: "bcd" }]);
});
test("run_end 同时结束 agent 和 settle，压缩与重试有文案", () => {
	assert.deepEqual(toClientEvent({ type: "run_end", inputs: [] }, newTranslateState()), [{ type: "agent.end", willRetry: false }, { type: "agent.settled" }]);
	assert.equal(toClientEvent({ type: "auto_retry_start", attempt: 1, at: 0, errorMessage: "retry" }, newTranslateState())[0]?.type, "agent.status");
});
test("动作摘要有上限，原始参数只在内部保留", () => {
	const action = toActionDescriptor("bash", { command: "x".repeat(500) });
	assert.ok(summarizeAction(action).length < 140);
	assert.equal(forClient(action).args, undefined);
});
test("当前快照包含自有模型与空状态，零 durable doc 下发", () => {
	const view = snapshotView({ type: "snapshot", entries: [], tools: [], compactions: [], inbox: [], agent: {}, usage: { models: {}, tools: {} } }, "s");
	assert.equal(view.sessionId, "s");
	assert.equal(view.streaming, false);
	assert.ok(!JSON.stringify(view).includes("pi."));
});

test("durable 初始内容、块替换与文本增量无需快照也完整", () => {
	const state = newTranslateState();
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const events = toClientEvent({ type: "message_update", usage, changes: [
		{ type: "text_start", contentIndex: 0, block: { type: "text", text: "开始" } },
		{ type: "text_delta", contentIndex: 0, delta: "继续" },
	] }, state);
	assert.deepEqual(events, [
		{ type: "message.text", messageId: "live", delta: "开始" },
		{ type: "message.text", messageId: "live", delta: "继续" },
	]);
	assert.deepEqual(toClientEvent({ type: "message_update", usage, changes: [
		{ type: "block", contentIndex: 0, block: { type: "text", text: "修正" } },
	] }, state), [{ type: "message.end", messageId: "live", text: "修正", thinking: "" }]);
});
