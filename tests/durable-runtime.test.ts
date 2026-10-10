import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AuditLog } from "../src/audit/log.ts";
import { ModelGateway } from "../src/modelgw/server.ts";
import type { ClientEvent } from "../src/protocol/types.ts";
import { HarnessHost } from "../src/runtime/harness-host.ts";

import { fixture } from "./fixtures/durable.ts";

test("Durable：模型经网关，放行、拒绝与超时审批均在执行前生效", async () => {
	await fixture([
		{ tool: "write", args: { path: "src/ok.ts", content: "ok" } },
		{ tool: "write", args: { path: ".github/workflows/ci.yml", content: "bad" } },
		{ tool: "bash", args: { command: "git push; touch bypass" } },
		{ text: "完成" },
	], async (host, dir) => {
		assert.equal((await (await host.submit("修复", "r1")).wait(BACKGROUND_CONTEXT)).status, "done");
		assert.equal(readFileSync(join(dir, "workspace/src/ok.ts"), "utf8"), "ok");
		assert.equal(existsSync(join(dir, "workspace/.github/workflows/ci.yml")), false);
		assert.equal(existsSync(join(dir, "workspace/bypass")), false);
		const records = readFileSync(join(dir, "audit.jsonl"), "utf8");
		assert.ok(records.includes('"kind":"policy.verdict"'));
		assert.ok(records.includes('"kind":"usage"'));
		assert.ok(records.includes('"kind":"approval.decision"'));
		assert.ok(records.includes('"summary":"审批 expired"'));
		assert.ok(!records.includes('"content":"bad"'));
	});
});

test("Durable：重启保留 transcript 与 requestId 幂等，移除守卫拒绝提交", async () => {
	await fixture([{ text: "答案" }], async (host, _dir, reopen) => {
		const first = await host.submit("你好", "same");
		await first.wait(BACKGROUND_CONTEXT);
		const next = await reopen();
		assert.equal((await next.submit("你好", "same")).id, first.id);
		const entries = (await next.root.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items;
		assert.ok(entries.some((entry) => entry.kind === "pi.assistant"));
		await next.root.configure({ extensions: [] }, BACKGROUND_CONTEXT);
		await assert.rejects(next.submit("危险", "bad"), /策略扩展未选中/);
	});
});

test("Durable 审批：先到先得，批准人和超时决定进入审计", async () => {
	await fixture([], async (host, dir, _reopen, events) => {
		const pending = host.approvals.request("call", { tool: "bash", command: "git push" }, "push", "不可逆", "alice", 1000, new AbortController().signal);
		while (!events.some((event) => event.type === "approval.request")) await new Promise((resolve) => setTimeout(resolve, 5));
		const request = events.find((event) => event.type === "approval.request")!;
		assert.equal(request.type, "approval.request");
		if (request.type !== "approval.request") return;
		const results = await Promise.all([host.approvals.decide(request.approvalId, "allow", "bob"), host.approvals.decide(request.approvalId, "deny", "eve")]);
		assert.equal(results.filter(Boolean).length, 1);
		assert.equal(await pending, true);
		const records = readFileSync(join(dir, "audit.jsonl"), "utf8");
		assert.ok(records.includes('"approver":"bob"'));
		assert.ok(!records.includes('"approver":"eve"'));
	});
});

test("真实 bash 不继承网关或模型环境凭据", async () => {
	process.env.PERIMETER_TEST_MODEL_SECRET = "gateway-only-secret-negative-guard";
	try {
		await fixture([{ tool: "bash", args: { command: "env > environment.txt" } }, { text: "done" }], async (host, dir) => {
			await (await host.submit("环境", "r")).wait(BACKGROUND_CONTEXT);
			const output = readFileSync(join(dir, "workspace/environment.txt"), "utf8");
			assert.ok(!output.includes("gateway-only-secret-negative-guard"));
			assert.ok(!output.includes("NODE_TEST_CONTEXT"));
		});
	} finally { delete process.env.PERIMETER_TEST_MODEL_SECRET; }
});
