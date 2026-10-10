import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolHooks } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { PolicyEngine } from "../src/policy/engine.ts";
import { usageView } from "../src/protocol/translate.ts";
import { perimeterExtension } from "../src/runtime/perimeter-extension.ts";
import { RUNTIME_SETTINGS } from "../src/runtime/harness-host.ts";
import { fixture } from "./fixtures/durable.ts";

function extension(deny: boolean) {
	return perimeterExtension({ repo: "repo", team: "team", policy: PolicyEngine.fromYaml(JSON.stringify({ rules: deny ? [{ name: "secret", tool: "write", deny_paths: ["private/**"] }] : [] })),
		actor: async () => "alice", approvals: () => { throw new Error("不应请求审批"); }, approvalTimeoutMs: 1, audit: () => {}, emit: () => {} });
}
test("缓存守卫 1/4：连续轮次与 reopen 的系统前缀、工具序列和会话亲和逐字稳定", async () => {
	await fixture([{ text: "a" }, { text: "b" }, { text: "c" }], async (host, dir, reopen) => {
		await (await host.submit("第一轮", "a")).wait(BACKGROUND_CONTEXT);
		await (await host.submit("第二轮", "b")).wait(BACKGROUND_CONTEXT);
		await (await (await reopen()).submit("重启", "c")).wait(BACKGROUND_CONTEXT);
		const requests = readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(requests.length, 3);
		assert.ok(requests[0].sessionId);
		for (const request of requests.slice(1)) {
			assert.equal(request.sessionId, requests[0].sessionId);
			assert.deepEqual(request.body.tools, requests[0].body.tools);
			assert.deepEqual(request.body.messages.filter((message: { role: string }) => message.role === "system"), requests[0].body.messages.filter((message: { role: string }) => message.role === "system"));
		}
	});
});
test("缓存守卫 2：策略变化只在 hook 拦截，不增删 offered tools", async () => {
	for (const deny of [true, false]) {
		const guard = extension(deny);
		assert.equal(guard.tools, undefined);
		assert.deepEqual(CodingTools.tools!.map((tool) => tool.name), ["read", "write", "edit", "bash"]);
	}
});
test("缓存守卫 3：拒绝结果确定，带 parent 的调用同样受拦", async () => {
	const hooks = extension(true).hooks![0]!.handlers as ToolHooks;
	const call = { type: "toolCall" as const, id: "c", name: "write", arguments: { path: "private/a", content: "x" }, parent: "outer" };
	const first = await hooks.beforeTool(call, {} as never, BACKGROUND_CONTEXT);
	const second = await hooks.beforeTool({ ...call, id: "different" }, {} as never, BACKGROUND_CONTEXT);
	assert.ok(first?.block);
	assert.deepEqual(second, first);
});
test("缓存守卫 5：后台压缩开启，不覆盖默认进度间隔", () => {
	assert.ok(RUNTIME_SETTINGS.compaction!.backgroundTokens! > 0);
	assert.equal(RUNTIME_SETTINGS.progress, undefined);
});
test("缓存守卫 6：命中率使用输入+读缓存+写缓存，零分母为 null", () => {
	assert.equal(usageView({ models: {}, tools: {} }).cacheHitRate, null);
	assert.equal(usageView({ models: { model: { input: 20, output: 1, cacheRead: 70, cacheWrite: 10, totalTokens: 101, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }, tools: {} }).cacheHitRate, 0.7);
});
