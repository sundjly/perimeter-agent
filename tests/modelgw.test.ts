import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AuditLog } from "../src/audit/log.ts";
import { ModelGateway, assertAllowed } from "../src/modelgw/server.ts";
import { redact, scanSecrets } from "../src/modelgw/secrets.ts";

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups) await c();
});

/** 假上游：记录收到的请求，按 SSE 回一段带 usage 的响应 */
async function startUpstream(): Promise<{ url: string; host: string; seen: { headers: Record<string, unknown>; body: string }[] }> {
	const seen: { headers: Record<string, unknown>; body: string }[] = [];
	const srv = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			seen.push({ headers: req.headers, body });
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "上游回复" } }] })}\n\n`);
			res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
	const port = (srv.address() as { port: number }).port;
	return { url: `http://127.0.0.1:${port}/v1`, host: "127.0.0.1", seen };
}

async function startGateway(opts: Partial<ConstructorParameters<typeof ModelGateway>[0]> = {}) {
	const up = await startUpstream();
	const auditFile = join(mkdtempSync(join(tmpdir(), "mgw-")), "audit.jsonl");
	const audit = AuditLog.open(auditFile);
	cleanups.push(() => audit.close());
	const gw = new ModelGateway({
		port: 0,
		host: "127.0.0.1",
		token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "upstream-secret-key" }],
		egressAllowlist: [up.host],
		audit,
		...opts,
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	return { gw, up, auditFile, url: `http://127.0.0.1:${port}/v1/chat/completions` };
}

function call(url: string, body: unknown, headers: Record<string, string> = {}) {
	return fetch(url, {
		method: "POST",
		headers: { authorization: "Bearer gw-token", "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

// ── 出口 allowlist ──────────────────────────────────────────

test("上游不在 egress allowlist 内时拒绝启动", () => {
	assert.throws(
		() => assertAllowed("https://api.openai.com/v1", ["model-gateway.internal"]),
		/不在 egress allowlist 内/,
	);
	assert.doesNotThrow(() => assertAllowed("https://model-gateway.internal/v1", ["model-gateway.internal"]));
});

test("非 ASCII 凭据在启动时就报错，而不是变成运行时 502", async () => {
	const up = await startUpstream();
	assert.throws(
		() =>
			new ModelGateway({
				port: 0, host: "127.0.0.1", token: "t",
				upstreams: [{ id: "x", baseUrl: up.url, apiKey: "含中文的密钥" }],
				egressAllowlist: [up.host],
			}),
		/含非 ASCII 字符/,
	);
});

test("构造网关时就校验全部上游", async () => {
	const up = await startUpstream();
	assert.throws(
		() =>
			new ModelGateway({
				port: 0,
				host: "127.0.0.1",
				token: "t",
				upstreams: [{ id: "bad", baseUrl: up.url }],
				egressAllowlist: ["only-this.internal"],
			}),
		/不在 egress allowlist 内/,
	);
});

// ── 鉴权与凭据隔离 ──────────────────────────────────────────

test("无 token 被拒", async () => {
	const { url } = await startGateway();
	const res = await fetch(url, { method: "POST", body: "{}" });
	assert.equal(res.status, 401);
});

test("模型凭据只在网关注入，调用方从未持有它", async () => {
	const { url, up } = await startGateway();
	const res = await call(url, { model: "azure/gpt-4o", messages: [] });
	assert.equal(res.status, 200);
	await res.text();

	const seen = up.seen[0]!;
	assert.equal(seen.headers.authorization, "Bearer upstream-secret-key");
	// 调用方发的是网关 token，上游拿到的是上游密钥 —— 两者不同
	assert.notEqual(seen.headers.authorization, "Bearer gw-token");
});

test("Azure 风格的 api-key 认证头", async () => {
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0,
		host: "127.0.0.1",
		token: "t",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "azure-key", authHeader: "api-key" }],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	await (await call(`http://127.0.0.1:${port}/v1/chat/completions`, { messages: [] }, { authorization: "Bearer t" })).text();
	assert.equal(up.seen[0]?.headers["api-key"], "azure-key");
});

// ── 流式与计量 ──────────────────────────────────────────────

test("流式转发上游 SSE 并按 usage 计量", async () => {
	const { url, gw } = await startGateway();
	const res = await call(url, { model: "azure/gpt-4o", messages: [] }, { "x-perimeter-team": "platform" });
	const text = await res.text();
	assert.match(text, /上游回复/);
	assert.match(text, /\[DONE\]/);
	assert.equal(gw.usedTokens("platform"), 120);
});

test("计量按团队累计", async () => {
	const { url, gw } = await startGateway();
	await (await call(url, { messages: [] }, { "x-perimeter-team": "a" })).text();
	await (await call(url, { messages: [] }, { "x-perimeter-team": "a" })).text();
	await (await call(url, { messages: [] }, { "x-perimeter-team": "b" })).text();
	assert.equal(gw.usedTokens("a"), 240);
	assert.equal(gw.usedTokens("b"), 120);
});

test("配额用尽后拒绝，且留下审计", async () => {
	const { url, auditFile } = await startGateway({ quotas: [{ team: "small", maxTotalTokens: 100 }] });
	const first = await call(url, { messages: [] }, { "x-perimeter-team": "small" });
	await first.text();
	const second = await call(url, { messages: [] }, { "x-perimeter-team": "small" });
	assert.equal(second.status, 429);

	const entries = [];
	for await (const e of AuditLog.replay(auditFile)) entries.push(e);
	assert.ok(entries.some((e) => e.summary.includes("配额耗尽")));
});

test("上游不可达时返回 502 而不是崩溃", async () => {
	const { url } = await startGateway({
		fetchImpl: (() => Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof fetch,
	});
	const res = await call(url, { messages: [] });
	assert.equal(res.status, 502);
	assert.match(await res.text(), /上游失败/);
});

// ── 凭据检测（audit-only） ──────────────────────────────────

test("检出常见凭据形态", () => {
	const hits = scanSecrets(`
		AWS_KEY=AKIAIOSFODNN7EXAMPLE
		token: ghp_abcdefghijklmnopqrstuvwxyz0123456789
		-----BEGIN RSA PRIVATE KEY-----
	`);
	const kinds = hits.map((h) => h.kind);
	assert.ok(kinds.includes("aws-access-key"));
	assert.ok(kinds.includes("github-token"));
	assert.ok(kinds.includes("private-key"));
});

test("告警本身不得成为泄漏源", () => {
	const hits = scanSecrets("AKIAIOSFODNN7EXAMPLE");
	assert.ok(!JSON.stringify(hits).includes("AKIAIOSFODNN7EXAMPLE"));
	assert.equal(redact("AKIAIOSFODNN7EXAMPLE"), "AKIA***MPLE（20 字符）");
	assert.equal(redact("short"), "sh***");
});

test("占位符不误报", () => {
	assert.deepEqual(scanSecrets("password=your-password-here"), []);
	assert.deepEqual(scanSecrets("api_key: changeme"), []);
});

test("命中凭据只告警不改写请求体 —— 改写代码流的误伤率无法接受", async () => {
	const { url, up, auditFile } = await startGateway();
	const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
	const res = await call(url, { messages: [{ role: "user", content: `修一下这段：token = "${secret}"` }] });
	await res.text();

	// 请求原样到达上游
	assert.ok(up.seen[0]!.body.includes(secret));
	// 但留下了告警，且告警里没有完整凭据
	const entries = [];
	for await (const e of AuditLog.replay(auditFile)) entries.push(e);
	const alert = entries.find((e) => e.summary.includes("命中凭据特征"));
	assert.ok(alert, "应有告警");
	assert.ok(!alert!.summary.includes(secret));
});

// ── 路由 ────────────────────────────────────────────────────

test("按 model 前缀与显式 header 选择上游", async () => {
	const upA = await startUpstream();
	const upB = await startUpstream();
	const gw = new ModelGateway({
		port: 0,
		host: "127.0.0.1",
		token: "t",
		upstreams: [
			{ id: "a", baseUrl: upA.url },
			{ id: "b", baseUrl: upB.url },
		],
		egressAllowlist: [upA.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	const url = `http://127.0.0.1:${port}/v1/chat/completions`;

	await (await call(url, { model: "b/x" }, { authorization: "Bearer t" })).text();
	assert.equal(upB.seen.length, 1);

	await (await call(url, { model: "b/x" }, { authorization: "Bearer t", "x-perimeter-provider": "a" })).text();
	assert.equal(upA.seen.length, 1);
});

test("健康检查与未知路径", async () => {
	const { url } = await startGateway();
	const base = url.replace("/v1/chat/completions", "");
	assert.equal((await fetch(`${base}/healthz`)).status, 200);
	assert.equal((await fetch(`${base}/v1/embeddings`, { method: "POST", headers: { authorization: "Bearer gw-token" }, body: "{}" })).status, 404);
});
