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
