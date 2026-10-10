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

async function fixture(script: unknown[], run: (host: HarnessHost, dir: string, reopen: () => Promise<HarnessHost>, events: ClientEvent[]) => Promise<void>, timeout = 200) {
	const dir = mkdtempSync(join(tmpdir(), "durable-"));
	const mock = spawn(process.execPath, ["tests/fixtures/mock-model.mjs", "0", JSON.stringify(script)]);
	const [chunk] = await once(mock.stdout!, "data");
	const port = JSON.parse(String(chunk)).port;
	const audit = AuditLog.open(join(dir, "audit.jsonl"));
	const mgw = new ModelGateway({ port: 0, host: "127.0.0.1", token: "model-token", egressAllowlist: ["127.0.0.1"],
		upstreams: [{ id: "mock", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "upstream-secret" }], audit });
	const mp = await mgw.listen();
	const events: ClientEvent[] = [];
	const opts = { sessionId: "test", file: join(dir, "state/session.sqlite"), workspace: join(dir, "workspace"), actor: "alice", repo: "default", team: "default",
		policyFile: "config/policy.yaml", audit, model: { baseUrl: `http://127.0.0.1:${mp}/v1`, token: "model-token", model: "mock-model" }, approvalTimeoutMs: timeout, emit: (event: ClientEvent) => events.push(event) };
	let host: HarnessHost | undefined;
	try {
		host = await HarnessHost.open(opts);
		await run(host, dir, async () => { await host!.close(); host = await HarnessHost.open(opts); return host; }, events);
	} finally {
		try { await host?.close(); } finally {
			try { await mgw.close(); } finally {
				try { audit.close(); } finally {
					mock.kill();
					rmSync(dir, { recursive: true, force: true });
				}
			}
		}
	}
}

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
