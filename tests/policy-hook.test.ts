import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fixture } from "./fixtures/durable.ts";

for (const [name, command, allowed] of [
	["allow：普通命令有判决记录", "echo ok > result.txt", true],
	["审批超时按拒绝处理", "git push; echo bypass > result.txt", false],
] as const) test(name, async () => {
	await fixture([{ tool: "bash", args: { command } }, { text: "done" }], async (host, dir) => {
		await (await host.submit("执行", "r")).wait(BACKGROUND_CONTEXT);
		assert.equal(existsSync(join(dir, "workspace/result.txt")), allowed);
		assert.ok(readFileSync(join(dir, "audit.jsonl"), "utf8").includes('"kind":"policy.verdict"'));
	});
});
test("deny：策略拒绝的写入不会落盘", async () => {
	await fixture([{ tool: "write", args: { path: ".github/workflows/ci.yml", content: "bad" } }, { text: "done" }], async (host, dir) => {
		await (await host.submit("写", "r")).wait(BACKGROUND_CONTEXT);
		assert.equal(existsSync(join(dir, "workspace/.github/workflows/ci.yml")), false);
	});
});
for (const decision of ["allow", "deny"] as const) test(`审批 ${decision}：决定之前不执行，批准人留痕`, async () => {
	await fixture([{ tool: "bash", args: { command: "git push; echo approved > result.txt" } }, { text: "done" }], async (host, dir, _reopen, events) => {
		const submission = await host.submit("推送", "r");
		while (!events.some((event) => event.type === "approval.request")) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(existsSync(join(dir, "workspace/result.txt")), false);
		const request = events.find((event) => event.type === "approval.request")!;
		if (request.type !== "approval.request") throw new Error("缺少审批");
		await host.approvals.decide(request.approvalId, decision, "bob");
		await submission.wait(BACKGROUND_CONTEXT);
		assert.equal(existsSync(join(dir, "workspace/result.txt")), decision === "allow");
		assert.ok(readFileSync(join(dir, "audit.jsonl"), "utf8").includes('"approver":"bob"'));
	}, 2000);
});
test("取消挂起审批时工具不执行", async () => {
	await fixture([{ tool: "bash", args: { command: "git push; touch bypass" } }, { text: "done" }], async (host, dir, _reopen, events) => {
		const submission = await host.submit("推送", "r");
		while (!events.some((event) => event.type === "approval.request")) await new Promise((resolve) => setTimeout(resolve, 5));
		await host.abort();
		await submission.wait(BACKGROUND_CONTEXT);
		assert.equal(existsSync(join(dir, "workspace/bypass")), false);
	}, 2000);
});
test("移除扩展拒绝 prompt，守卫不依赖旧握手", async () => {
	await fixture([], async (host) => {
		await host.root.configure({ extensions: [] }, BACKGROUND_CONTEXT);
		await assert.rejects(host.submit("执行", "r"), /策略扩展未选中/);
	});
});

test("参数校验先于 beforeTool，非法模型调用仍有策略意图审计且不执行", async () => {
	await fixture([{ tool: "write", args: { path: ".github/workflows/ci.yml" } }, { text: "done" }], async (host, dir) => {
		await (await host.submit("非法参数", "r")).wait(BACKGROUND_CONTEXT);
		assert.equal(existsSync(join(dir, "workspace/.github/workflows/ci.yml")), false);
		const audit = readFileSync(join(dir, "audit.jsonl"), "utf8");
		assert.ok(audit.includes("工具意图预检 write"));
		assert.ok(audit.includes('"verdict":"deny"'));
	});
});
