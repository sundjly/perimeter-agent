import assert from "node:assert/strict";
import { test } from "node:test";
import { initialState, reduce } from "../web/view-model.js";

test("共享 reducer：增量不修改旧状态，快照替换漂移状态", () => {
	const empty = initialState();
	const started = reduce(empty, { type: "message.start", messageId: "m", role: "assistant" });
	const changed = reduce(started, { type: "message.text", messageId: "m", delta: "hello" });
	assert.equal(started.messages[0]!.text, "");
	assert.equal(changed.messages[0]!.text, "hello");
	assert.equal(empty.messages.length, 0);
	const canonical = reduce(changed, { type: "session.snapshot", view: { ...empty, sessionId: "shared", role: "viewer" } });
	assert.equal(canonical.messages.length, 0);
	assert.equal(canonical.role, "viewer");
});
test("网页、第二标签与 CLI 从同一快照和事件得到相同状态", () => {
	const state = initialState();
	const events = [{ type: "session.snapshot" as const, view: { ...state, sessionId: "shared" } }, { type: "agent.start" as const }, { type: "agent.settled" as const }];
	const states = [1, 2, 3].map(() => events.reduce(reduce, initialState()));
	assert.deepEqual(states[0], states[1]);
	assert.deepEqual(states[1], states[2]);
});

test("已接入的 editor 降级 viewer 时，presence 立即更新自己的角色", () => {
	const editor = { ...initialState(), role: "editor" as const };
	const viewer = reduce(editor, { type: "session.presence", participants: [], role: "viewer" });
	assert.equal(viewer.role, "viewer");
	assert.equal(editor.role, "editor");
});

test("attach 已有 entry 时，晚到的增量合并最终 ID，不重复 transcript", () => {
	const snapshot = { ...initialState(), messages: [
		{ id: "2", order: 2, role: "user" as const, text: "输入", thinking: "", actor: "alice" },
		{ id: "3", order: 3, role: "assistant" as const, text: "结果", thinking: "" },
	] };
	let state = reduce(initialState(), { type: "session.snapshot", view: snapshot });
	state = reduce(state, { type: "message.start", messageId: "user-live", role: "user", actor: "alice" });
	state = reduce(state, { type: "message.end", messageId: "user-live", entryId: "2", order: 2, text: "输入", thinking: "" });
	state = reduce(state, { type: "message.start", messageId: "live", role: "assistant" });
	state = reduce(state, { type: "message.end", messageId: "live", entryId: "3", order: 3, text: "结果", thinking: "" });
	assert.deepEqual(state.messages, snapshot.messages);
});

test("审批期间 attach 的工具卡在执行开始后保留累计输出且不重复", () => {
	const tool = { callId: "c", order: Number.MAX_SAFE_INTEGER, action: { tool: "bash" }, output: "已有输出" };
	const snapshot = { ...initialState(), tools: [tool] };
	const state = reduce(reduce(initialState(), { type: "session.snapshot", view: snapshot }), {
		type: "tool.start", callId: "c", action: tool.action, summary: "bash",
	});
	assert.deepEqual(state.tools, [tool]);
});
