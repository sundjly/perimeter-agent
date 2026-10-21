import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AuditLog } from "../src/audit/log.ts";
import { ModelGateway, assertAllowed } from "../src/modelgw/server.ts";
import { decodeStrictUtf8, redact, scanJsonDecoded, scanSecrets } from "../src/modelgw/secrets.ts";
import { GCP_TOKEN_HOST, clearTokenCache } from "../src/modelgw/upstream-auth.ts";

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups) await c();
});

/** 假上游：记录收到的请求，按 SSE 回一段带 usage 的响应 */
async function startUpstream(): Promise<{
	url: string;
	host: string;
	seen: { headers: Record<string, unknown>; body: string; url: string }[];
}> {
	const seen: { headers: Record<string, unknown>; body: string; url: string }[] = [];
	const srv = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			seen.push({ headers: req.headers, body, url: req.url ?? "" });
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

test("命中凭据只告警不改写请求体 —— audit 模式（显式获批低敏部署）下的语义", async () => {
	// B3：audit 已不再是默认；仅显式获批（dlp.auditApproved）的低敏部署可以 audit。
	const { url, up, auditFile } = await startGateway({ dlp: { mode: "audit", auditApproved: true } });
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

// ── B3：出站 DLP（生产默认 block） ──────────────────────

test("B3：dlp.mode 非法值启动即炸（fail-fast，不静默回退）", async () => {
	const up = await startUpstream();
	assert.throws(
		() => new ModelGateway({
			port: 0, host: "127.0.0.1", token: "t",
			upstreams: [{ id: "x", baseUrl: up.url, apiKey: "k" }],
			egressAllowlist: [up.host],
			dlp: { mode: "off" as never },
		}),
		/dlp\.mode 非法/,
	);
});

test("B3：audit 模式无显式批准 → 启动即炸（audit 仅限获批低敏部署）", async () => {
	const up = await startUpstream();
	assert.throws(
		() => new ModelGateway({
			port: 0, host: "127.0.0.1", token: "t",
			upstreams: [{ id: "x", baseUrl: up.url, apiKey: "k" }],
			egressAllowlist: [up.host],
			dlp: { mode: "audit" },
		}),
		/auditApproved/,
	);
	// 显式批准后可启动
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "t",
		upstreams: [{ id: "x", baseUrl: up.url, apiKey: "k" }],
		egressAllowlist: [up.host],
		dlp: { mode: "audit", auditApproved: true },
	});
	cleanups.push(() => gw.close());
	assert.equal(gw.dlpMode, "audit");
});

test("B3：未配置 dlp = 生产默认 block；命中凭据 403 + 固定类别 + 上游零调用", async () => {
	const up = await startUpstream();
	const auditFile = join(mkdtempSync(join(tmpdir(), "mgw-")), "audit.jsonl");
	const audit = AuditLog.open(auditFile);
	cleanups.push(() => audit.close());
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "upstream-secret-key" }],
		egressAllowlist: [up.host],
		audit,
	});
	cleanups.push(() => gw.close());
	assert.equal(gw.dlpMode, "block", "缺省必须是 block（生产默认）");
	const port = await gw.listen();
	const res = await call(`http://127.0.0.1:${port}/v1/chat/completions`, {
		messages: [{ role: "user", content: "deploy key: AKIAIOSFODNN7EXAMPLE" }],
	});
	assert.equal(res.status, 403);
	const text = await res.text();
	assert.match(text, /dlp_block/);
	assert.match(text, /aws-access-key/, "回给沙箱的是固定类别");
	assert.ok(!text.includes("AKIAIOSFODNN7EXAMPLE"), "不得回原文");
	assert.ok(!JSON.stringify(text).includes("***"), "不得回 hint 余文");
	assert.equal(up.seen.length, 0, "block 命中后上游调用必须为零");
	// 审计（私有面）有记录且脱敏
	const entries = [];
	for await (const e of AuditLog.replay(auditFile)) entries.push(e);
	const alert = entries.find((e) => e.summary.includes("命中凭据特征"));
	assert.ok(alert, "审计应留痕");
	assert.ok(!alert!.summary.includes("AKIAIOSFODNN7EXAMPLE"));
});

test("B3：block 模式下认证副作用也不发生（GCP 换 token 在扫描之后）", async () => {
	clearTokenCache();
	const key = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	}).privateKey;
	const up = await startUpstream();
	const fetchCalls: { url: string; init?: RequestInit }[] = [];
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "vertex", baseUrl: up.url, auth: { kind: "gcp", clientEmail: "sa@x", privateKey: key } }],
		egressAllowlist: [up.host, GCP_TOKEN_HOST],
		fetchImpl: (async (u: string, init?: RequestInit) => {
			fetchCalls.push({ url: String(u), init });
			if (String(u).includes("oauth2.googleapis.com")) {
				return new Response(JSON.stringify({ access_token: "tk", expires_in: 3600 }));
			}
			return fetch(u, init);
		}) as unknown as typeof fetch,
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	const res = await call(`http://127.0.0.1:${port}/v1/chat/completions`, {
		messages: [{ role: "user", content: "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789" }],
	});
	assert.equal(res.status, 403);
	assert.equal(fetchCalls.length, 0, "扫描命中后连换 token 的认证副作用都不得发生");
	assert.equal(up.seen.length, 0);
});

test("B3：扫描器故障 fail-closed（audit 模式也不例外）", async () => {
	const up = await startUpstream();
	for (const mode of ["block", "audit"] as const) {
		const gw = new ModelGateway({
			port: 0, host: "127.0.0.1", token: "gw-token",
			upstreams: [{ id: "x", baseUrl: up.url, apiKey: "k" }],
			egressAllowlist: [up.host],
			dlp: mode === "audit" ? { mode, auditApproved: true } : { mode },
			scanSecretsImpl: () => {
				throw new Error("scan exploded");
			},
		});
		cleanups.push(() => gw.close());
		const port = await gw.listen();
		const res = await call(`http://127.0.0.1:${port}/v1/chat/completions`, { messages: [] });
		assert.equal(res.status, 503, `${mode} 模式下扫描器故障必须 fail-closed`);
		await res.text();
		assert.equal(up.seen.length, 0, `${mode} 模式下扫描器故障不得放行到上游`);
	}
});

test("B3：超过 body 上限 413 fail-closed，上游零调用，不新增无界 buffer", async () => {
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "x", baseUrl: up.url, apiKey: "k" }],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	const big = "x".repeat(8 * 1024 * 1024 + 1);
	const res = await call(`http://127.0.0.1:${port}/v1/chat/completions`, { messages: [{ role: "user", content: big }] });
	assert.equal(res.status, 413);
	await res.text();
	assert.equal(up.seen.length, 0, "超限请求不得到达上游");
});

test("B3：上游 fetch 一律 redirect:error（含 GCP 换 token），302 被拒不跟随", async () => {
	clearTokenCache();
	// 真实重定向负控：上游 302 → Location 指向另一台本地服务器；redirect:error 下网关必须 502 且跳转目标零请求
	const redirectedToSeen: string[] = [];
	const target = createServer((_req, res) => {
		redirectedToSeen.push("hit");
		res.writeHead(200).end("leaked");
	});
	await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
	cleanups.push(() => new Promise<void>((r) => target.close(() => r())));
	const targetPort = (target.address() as { port: number }).port;

	const redirector = createServer((_req, res) => {
		res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/v1/chat/completions` });
		res.end();
	});
	await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
	cleanups.push(() => new Promise<void>((r) => redirector.close(() => r())));
	const redirectPort = (redirector.address() as { port: number }).port;

	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "r", baseUrl: `http://127.0.0.1:${redirectPort}`, apiKey: "k" }],
		egressAllowlist: ["127.0.0.1"],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	const res = await call(`http://127.0.0.1:${port}/v1/chat/completions`, { messages: [] });
	assert.equal(res.status, 502, "redirect:error 下 302 必须失败而非跟随");
	await res.text();
	assert.equal(redirectedToSeen.length, 0, "重定向目标必须零请求（跨 host/同 host 多跳都拒）");
});

test("B3：fetch init 携带 redirect:'error'（上游与换 token 的每次调用都被注入点观测）", async () => {
	clearTokenCache();
	const key = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	}).privateKey;
	const inits: (RequestInit | undefined)[] = [];
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "vertex", baseUrl: up.url, auth: { kind: "gcp", clientEmail: "sa@x", privateKey: key } }],
		egressAllowlist: [up.host, GCP_TOKEN_HOST],
		fetchImpl: (async (u: string, init?: RequestInit) => {
			inits.push(init);
			if (String(u).includes("oauth2.googleapis.com")) {
				return new Response(JSON.stringify({ access_token: "tk", expires_in: 3600 }));
			}
			return new Response("data: x\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch,
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	await (await call(`http://127.0.0.1:${port}/v1/chat/completions`, { model: "m", messages: [] })).text();
	assert.ok(inits.length >= 2, "换 token + 上游至少两次 fetch");
	for (const init of inits) assert.equal(init?.redirect, "error", "每个携带凭据的 fetch 都必须 redirect:error");
});

test("B3 对照集：真阳性全检出；历史误报源（commit SHA/base64/UUID/占位符）不误报（不宣称零误报）", () => {
	// 真阳性（高置信类别）
	const tps = scanSecrets([
		"AKIAIOSFODNN7EXAMPLE",
		"ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
		"-----BEGIN RSA PRIVATE KEY-----",
		"Authorization: Bearer abcdef1234567890abcdef",
		"password = \"supersecret123456\"",
	].join("\n"));
	assert.ok(tps.length >= 5, `真阳性必须全检出: ${JSON.stringify(tps.map((t) => t.kind))}`);
	// 历史误报源：不误报（但样本有限，不宣称零误报 —— 真实误报率要靠真实流量数据）
	const fps = scanSecrets([
		"commit 3f2a9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b",
		"const blob = atob('SGVsbG8gV29ybGQhIVIQ==');",
		"id: 550e8400-e29b-41d4-a716-446655440000",
		"password=your-password-here",
		"api_key: changeme",
	].join("\n"));
	assert.deepEqual(fps, [], `历史误报源不得命中: ${JSON.stringify(fps)}`);
});

test("B3 对照集：JSON 转义形态的凭据赋值可检出（转义引号不致漏检）", () => {
	// JSON.stringify 后 password 前后的引号变成 \" —— 旧字符类不容忍反斜杠会漏检
	const body = JSON.stringify({ messages: [{ role: "user", content: 'password = "hunter2hunter2"' }] });
	assert.ok(body.includes("\\\""), "夹具必须真实含转义引号");
	const hits = scanSecrets(body);
	assert.ok(hits.some((h) => h.kind === "credential-assignment"), `JSON 转义凭据必须检出: ${JSON.stringify(hits)}`);
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

// ── 企业模型通道：走完整的 ModelGateway，而不只是认证函数 ──────────
// 这些不等于「对真实 Bedrock/Vertex 验证过」—— 上游是假的。
// 它们验证的是网关这一侧：签名头真的发出去了、token 真的换了、错误不外泄。

test("Bedrock 通道：上游收到 SigV4 签名头，且密钥不出现在请求里", async () => {
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0,
		host: "127.0.0.1",
		token: "gw-token",
		upstreams: [
			{
				id: "bedrock",
				baseUrl: up.url,
				path: "/model/{model}/invoke",
				auth: { kind: "sigv4", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "SECRET", region: "us-east-1" },
			},
		],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();

	const res = await call(
		`http://127.0.0.1:${port}/v1/chat/completions`,
		{ model: "bedrock/anthropic.claude-x:0", messages: [] },
		{ authorization: "Bearer gw-token" },
	);
	assert.equal(res.status, 200);
	await res.text();

	const seen = up.seen.at(-1)!;
	assert.match(String(seen.headers.authorization), /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//, "上游必须收到 SigV4 签名");

	// 签名覆盖的 payload 必须就是实际发出去的 body。对不上的话 AWS 只回
	// 一个 403，不会说是 body 变了还是签名算错了。
	assert.equal(
		seen.headers["x-amz-content-sha256"],
		createHash("sha256").update(seen.body).digest("hex"),
		"content hash 必须是实际 body 的 sha256",
	);

	// 「签的 URI == 发的 URI」这个跨函数不变量：provider 前缀在 upstreamUrl
	// 里被剥掉、模型 id 里的 `:` 被编码，签名必须覆盖替换后的那个路径
	assert.equal(seen.url, "/v1/model/anthropic.claude-x%3A0/invoke");
});

test("Vertex 通道：换到的 access token 作为 Bearer 发给上游", async () => {
	clearTokenCache();
	const key = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	}).privateKey;
	const up = await startUpstream();
	const audit = AuditLog.open(join(mkdtempSync(join(tmpdir(), "mgw-")), "a.jsonl"));
	cleanups.push(() => audit.close());
	const gw = new ModelGateway({
		port: 0,
		host: "127.0.0.1",
		token: "gw-token",
		upstreams: [{ id: "vertex", baseUrl: up.url, auth: { kind: "gcp", clientEmail: "sa@x", privateKey: key } }],
		// 配了 gcp 上游就必须把 token 端点也写进 allowlist —— 构造期会校验
		egressAllowlist: [up.host, GCP_TOKEN_HOST],
		audit,
		// 注入假的 token 端点：真打 Google 会让测试依赖外网与真实凭据
		fetchImpl: (async (u: string, init?: RequestInit) => {
			if (String(u).includes("oauth2.googleapis.com")) {
				return new Response(JSON.stringify({ access_token: "ya29.injected", expires_in: 3600 }));
			}
			return fetch(u, init);
		}) as unknown as typeof fetch,
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();

	const res = await call(`http://127.0.0.1:${port}/v1/chat/completions`, { model: "m", messages: [] }, {
		authorization: "Bearer gw-token",
	});
	assert.equal(res.status, 200);
	await res.text();
	assert.equal(up.seen.at(-1)!.headers.authorization, "Bearer ya29.injected");
});

test("换 token 失败：沙箱只看到固定文案，上游正文只进审计", async () => {
	clearTokenCache();
	const key = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	}).privateKey;
	const up = await startUpstream();
	const auditFile = join(mkdtempSync(join(tmpdir(), "mgw-")), "a.jsonl");
	const audit = AuditLog.open(auditFile);
	let closed = false;
	cleanups.push(() => {
		if (!closed) audit.close();
	});
	const gw = new ModelGateway({
		port: 0,
		host: "127.0.0.1",
		token: "gw-token",
		upstreams: [{ id: "vertex", baseUrl: up.url, auth: { kind: "gcp", clientEmail: "sa-internal@proj", privateKey: key } }],
		egressAllowlist: [up.host, GCP_TOKEN_HOST],
		audit,
		fetchImpl: (async (u: string) => {
			if (String(u).includes("oauth2.googleapis.com")) {
				return new Response("invalid_grant: sa-internal@proj not found in org-12345", { status: 400 });
			}
			return new Response("{}");
		}) as unknown as typeof fetch,
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();

	const res = await call(`http://127.0.0.1:${port}/v1/chat/completions`, { model: "m", messages: [] }, {
		authorization: "Bearer gw-token",
	});
	assert.equal(res.status, 502);
	const text = await res.text();
	// 上游正文长度无界、内容由上游控制，还会暴露内部拓扑
	assert.ok(!text.includes("org-12345"), "上游正文不得回给沙箱");
	assert.ok(!text.includes("sa-internal"), "SA 邮箱不得回给沙箱");

	audit.close();
	closed = true;
	const summaries: string[] = [];
	for await (const e of AuditLog.replay(auditFile)) summaries.push(e.summary);
	assert.ok(summaries.some((s) => s.includes("org-12345")), "详情必须留在审计里，否则无从排查");
});

test("新增的 auth 字段不会绕过上游 baseUrl 的 allowlist 校验", () => {
	// 新增的认证方式不该成为绕过出口控制的口子
	assert.throws(
		() =>
			new ModelGateway({
				port: 0,
				host: "127.0.0.1",
				token: "t",
				upstreams: [
					{
						id: "b",
						baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
						auth: { kind: "sigv4", accessKeyId: "A", secretAccessKey: "S", region: "us-east-1" },
					},
				],
				egressAllowlist: ["model-gateway.internal"],
			}),
		/不在 egress allowlist 内/,
	);
});

test("配了 gcp 上游就必须把 token 端点写进 allowlist —— 否则出口名单不是唯一事实来源", () => {
	// 换 token 是网关自身的一条硬编码出口，不像 baseUrl 那样天然过校验。
	// 不强制的话，锁死出口的生产环境里 Vertex 会在无人预期的地方 fail。
	const key = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	}).privateKey;
	assert.throws(
		() =>
			new ModelGateway({
				port: 0,
				host: "127.0.0.1",
				token: "t",
				upstreams: [{ id: "v", baseUrl: "https://vertex.internal", auth: { kind: "gcp", clientEmail: "sa@x", privateKey: key } }],
				egressAllowlist: ["vertex.internal"],
			}),
		/GCP token 端点 oauth2\.googleapis\.com 不在 egress allowlist/,
	);
});

test("上游的错误正文有意透传给沙箱 —— 与换 token 失败的处理刻意不同", async () => {
	// agent 要据此判断是 rate limit、context 超长还是参数错误，并决定重试
	// 还是改写请求。而换 token 失败的正文对 agent 毫无用处，纯粹是内部拓扑
	// 泄漏（见上一条测试）。同一份威胁模型下的两种取舍，差别在「这条信息
	// 对被隔离的一方有没有用」。
	//
	// ⚠️ 代价：上游正文长度无界、内容由上游控制。上游若某天不可信
	// （比如换成共享的第三方网关），这条透传要重新评估。
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0,
		host: "127.0.0.1",
		token: "gw-token",
		upstreams: [{ id: "u", baseUrl: up.url, apiKey: "k" }],
		egressAllowlist: [up.host],
		fetchImpl: (async () =>
			new Response('{"error":{"message":"context_length_exceeded: 8192 > 4096"}}', {
				status: 400,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch,
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();

	const res = await call(`http://127.0.0.1:${port}/v1/chat/completions`, { model: "u/m", messages: [] }, {
		authorization: "Bearer gw-token",
	});
	assert.equal(res.status, 400, "上游状态码要原样透传");
	assert.match(await res.text(), /context_length_exceeded/, "agent 需要知道具体是哪种错误才能自行纠正");
});

test("签名覆盖的头集合 ⊆ 实际发出的头集合，且取值相同", async () => {
	// 这是唯一跑在真 undici 上的检查点。「签了但没发」AWS 会直接拒，
	// 而单元测试看不到 undici 对 host / content-length 的改写。
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0,
		host: "127.0.0.1",
		token: "gw-token",
		upstreams: [
			{
				id: "b",
				baseUrl: up.url,
				auth: { kind: "sigv4", accessKeyId: "AKIAX", secretAccessKey: "S", region: "us-east-1" },
			},
		],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	await (await call(`http://127.0.0.1:${port}/v1/chat/completions`, { model: "b/m", messages: [] }, {
		authorization: "Bearer gw-token",
	})).text();

	const seen = up.seen.at(-1)!;
	const signedHeaders = /SignedHeaders=([^,]+)/.exec(String(seen.headers.authorization))![1]!.split(";");
	for (const name of signedHeaders) {
		assert.ok(seen.headers[name] !== undefined, `签了 ${name} 却没发出去 —— AWS 会直接拒`);
	}
	// host 尤其要紧：undici 会丢弃显式传的 host，改用 URL 推出的值
	assert.ok(signedHeaders.includes("host"));
	assert.equal(seen.headers.host, up.host.includes(":") ? up.host : seen.headers.host);
});

test("缓存亲和头与 cache_control 请求体原样转发，审计使用 sessionId", async () => {
	const env = await startGateway();
	const body = { model: "azure/model", prompt_cache_key: "stable", messages: [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }] };
	const response = await call(env.url, body, { session_id: "stable", "x-session-affinity": "stable" });
	await response.text();
	assert.deepEqual(JSON.parse(env.up.seen[0]!.body), body);
	assert.equal(env.up.seen[0]!.headers.session_id, "stable");
	const entries = [];
	for await (const entry of AuditLog.replay(env.auditFile)) entries.push(entry);
	assert.ok(entries.some((entry) => entry.sessionId === "stable" && entry.kind === "usage"));
});

// ── R41 修复2负控：完整 body 语义解码扫描（unicode 逃逸/非法JSON/非法UTF8/无界嵌套/扫描器非法返回）──
// 语义红判定口径：负控断言的是「状态码+上游零调用」的产品语义，非 TypeError/hash/setup 失败。

const ESC = (s: string) => s.split("").map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
// AWS 官方文档公开示例 key（非真实凭据；拼接构造避免展示层掩码歧义）：满足 aws-access-key 规则
const EXAMPLE_AKIA = "AKIA" + "IOSFODNN7EXAMPLE";

test("R41负控：unicode 逃逸的凭据赋值必须被语义解码后拦截（当前裸扫描漏检=红）", async () => {
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "upstream-secret-key" }],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	// JSON 转义后 raw 扫描不可见，但上游 JSON.parse 后会收到明文 password = "AKIA..."
	const plain = `password = "${EXAMPLE_AKIA}"`;
	const body = `{"messages":[{"role":"user","content":"${ESC(plain)}"}]}`;
	assert.ok(!body.includes("password ="), "夹具必须真实全转义（raw 裸扫描不可见）");
	const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
		method: "POST", headers: { authorization: "Bearer gw-token", "content-type": "application/json" }, body,
	});
	assert.equal(res.status, 403, `语义逃逸必须拦截，实际=${res.status}`);
	await res.text();
	assert.equal(up.seen.length, 0, "拦截前上游零调用");
});

test("R41负控：string value 逐字符 unicode 逃逸的独立凭据 token 同样拦截", async () => {
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "k" }],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	const body = `{"messages":[{"role":"user","content":"${ESC(EXAMPLE_AKIA)}"}]}`;
	assert.ok(!body.includes("AKIA"), "夹具必须真实全转义");
	const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
		method: "POST", headers: { authorization: "Bearer gw-token", "content-type": "application/json" }, body,
	});
	assert.equal(res.status, 403);
	await res.text();
	assert.equal(up.seen.length, 0);
});

test("R41负控：非法 JSON body → fail-closed 403（不得透传上游）", async () => {
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "k" }],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
		method: "POST", headers: { authorization: "Bearer gw-token", "content-type": "application/json" },
		body: '{"messages":[{"role":"user","content":"hi"}}',
	});
	assert.equal(res.status, 403, `非法 JSON 必须 fail-closed，实际=${res.status}`);
	await res.text();
	assert.equal(up.seen.length, 0);
});

test("R41负控：非法 UTF-8 序列 → fail-closed（不得经有损解码放行）", async () => {
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "k" }],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	const bad = Buffer.from('{"messages":[{"role":"user","content":"\xff\xfe\x80"}]}', "latin1");
	const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
		method: "POST", headers: { authorization: "Bearer gw-token", "content-type": "application/json" }, body: bad,
	});
	assert.equal(res.status, 403, `非法 UTF-8 必须 fail-closed，实际=${res.status}`);
	await res.text();
	assert.equal(up.seen.length, 0);
});

test("R41负控：超过深度上限的无界嵌套 → fail-closed 403", async () => {
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "k" }],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	let body = '{"x":'.repeat(200) + '1' + "}".repeat(200);
	const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
		method: "POST", headers: { authorization: "Bearer gw-token", "content-type": "application/json" }, body,
	});
	assert.equal(res.status, 403, `超深嵌套必须 fail-closed，实际=${res.status}`);
	await res.text();
	assert.equal(up.seen.length, 0);
});

test("R41负控：扫描器返回 null / 非数组 / 未知 kind / 超长 hint → 一律 503 fail-closed（双模式）", async () => {
	const up = await startUpstream();
	const badReturns: unknown[] = [null, 42, [{ kind: "totally-unknown-kind", hint: "x" }], [{ kind: "aws-access-key", hint: "x".repeat(4096) }], [{ kind: "aws-access-key" }]];
	for (const mode of ["block", "audit"] as const) {
		for (const bad of badReturns) {
			const gw = new ModelGateway({
				port: 0, host: "127.0.0.1", token: "gw-token",
				upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "k" }],
				egressAllowlist: [up.host],
				dlp: mode === "audit" ? { mode, auditApproved: true } : { mode },
				scanSecretsImpl: (() => bad) as unknown as typeof scanSecrets,
			});
			cleanups.push(() => gw.close());
			const port = await gw.listen();
			const res = await call(`http://127.0.0.1:${port}/v1/chat/completions`, { messages: [] });
			assert.equal(res.status, 503, `mode=${mode} bad=${JSON.stringify(bad)} 必须fail-closed，实际=${res.status}`);
			await res.text();
			assert.equal(up.seen.length, 0, "扫描器非法返回不得放行到上游");
		}
	}
});

test("R41正控：跨字段不得误拼误报 —— key 与另一字段的值各自独立不构成命中", async () => {
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "k" }],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	// "password" 与 12+ 字符值分属不同字段：独立扫描均不命中；拼接才会假阳
	const res = await call(`http://127.0.0.1:${port}/v1/chat/completions`, {
		field_a: "password", field_b: "totally-innocent-value-123456", messages: [],
	});
	assert.equal(res.status, 200, `跨字段不得误拼误报，实际=${res.status}`);
	await res.text();
	assert.equal(up.seen.length, 1, "正常 body 必须逐字节透传上游");
});

test("R41正控：decoded 扫描不得改写上游收到的 body（语义扫描、字节透传）", async () => {
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "k" }],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	const body = `{"messages":[{"role":"user","content":"${ESC("please review commit 3f2a9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b")}"}]}`;
	const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
		method: "POST", headers: { authorization: "Bearer gw-token", "content-type": "application/json" }, body,
	});
	assert.equal(res.status, 200);
	await res.text();
	assert.equal(up.seen.length, 1);
	assert.equal(up.seen[0]!.body, body, "上游收到的必须逐字节等于原始 body（含转义序列原文）");
});

// ── R43 修复负控：同条目 key→value 语义赋值判定 + 重复键不塌缩丢失（R-Q42-1）──
// 口径：A1–A5/A9b 形态（逃逸 key + 同条目凭据值）真实 HTTP 403 + 上游/认证副作用零调用；
// A7/A8 干净形态保持 200 + 逐字节透传；重复键（含转义重复键）经 JSON.parse 塌缩后
// 前条真实 secret 不得丢失。原始 body 串直接 POST，不经 JS 预解析。

/** R43 夹具值：拼接构造（避免字面 secret token 形态；≥12 类内字符、非占位前缀） */
const R43_VAL = "fixture" + "CredentialValue4R43";

/** 原始串 POST（body 即字面字节） */
async function postRaw43(port: number, body: string): Promise<{ status: number; text: string }> {
	const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
		method: "POST", headers: { authorization: "Bearer gw-token", "content-type": "application/json" }, body,
	});
	return { status: res.status, text: await res.text() };
}

/** 跨 chunk 原始写入（中停 80ms；读路径聚合后扫描必须与整包一致） */
async function postRawChunked43(port: number, body: string, splitAt: number): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", headers: { authorization: "Bearer gw-token", "content-type": "application/json" } },
			(res) => {
				let text = "";
				res.on("data", (c) => (text += c));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
			},
		);
		req.on("error", reject);
		req.write(body.slice(0, splitAt));
		setTimeout(() => {
			req.write(body.slice(splitAt));
			req.end();
		}, 80);
	});
}

test("R43负控A1：同条目逃逸 key → 真实凭据值 必须 403 + 上游零调用（coor 指定夹具）", async () => {
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "k" }],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	const body = `{"messages":[{"role":"user","content":"clean"}],"metadata":{"${ESC("password")}":"LongRealCredential12345"}}`;
	assert.ok(body.includes("\\u0077"), "夹具必须真实含逃逸 key（raw 裸扫描不可见）");
	const { status, text } = await postRaw43(port, body);
	assert.equal(status, 403, `同条目逃逸 key→凭据值必须拦截，实际=${status}`);
	assert.match(text, /dlp_block/);
	assert.ok(!text.includes("LongRealCredential12345"), "公共面不得回原文");
	assert.equal(up.seen.length, 0, "拦截前上游零调用");
});

test("R43负控A2/A3：api_key 与 token 的同条目逃逸 key 同样 403", async () => {
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "k" }],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	for (const key of [ESC("api_key"), ESC("token")]) {
		const body = `{"messages":[],"metadata":{"${key}":"${R43_VAL}"}}`;
		const { status } = await postRaw43(port, body);
		assert.equal(status, 403, `逃逸 key=${key} 必须拦截，实际=${status}`);
	}
	assert.equal(up.seen.length, 0, "上游零调用");
});

test("R43负控A4：任意嵌套（对象套数组）中的同条目逃逸赋值 403", async () => {
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "k" }],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	const body = `{"a":{"b":[{"note":"x"},{"${ESC("password")}":"longvalue1234567"}]}}`;
	const { status } = await postRaw43(port, body);
	assert.equal(status, 403, `任意嵌套同条目逃逸赋值必须拦截，实际=${status}`);
	assert.equal(up.seen.length, 0, "上游零调用");
});

test("R43负控A5：同 A1 夹具跨 chunk 原始写入（中停 80ms）聚合后同样 403", async () => {
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "k" }],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	const body = `{"messages":[{"role":"user","content":"clean"}],"metadata":{"${ESC("password")}":"LongRealCredential12345"}}`;
	const { status } = await postRawChunked43(port, body, Math.floor(body.length / 2));
	assert.equal(status, 403, `跨 chunk 聚合扫描必须拦截，实际=${status}`);
	assert.equal(up.seen.length, 0, "上游零调用");
});

test("R43负控A9b：转义重复键 先真实 secret 后 placeholder —— 重复键保守拒（fail-closed 403）", async () => {
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "k" }],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	const body = `{"${ESC("password")}":"real-secret-value-1","${ESC("password")}":"placeholder-value"}`;
	const { status } = await postRaw43(port, body);
	assert.equal(status, 403, `重复键塌缩前条真实 secret 必须保守拒，实际=${status}`);
	assert.equal(up.seen.length, 0, "上游零调用");
});

test("R43负控：未转义重复键 先真实 secret 后 clean 占位 —— 同样 403（不得按塌缩后文档放行）", async () => {
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "k" }],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	const body = `{"password":"${R43_VAL}","password":"your-password-here"}`;
	const { status } = await postRaw43(port, body);
	assert.equal(status, 403, `重复键前条真实 secret 必须 403，实际=${status}`);
	assert.equal(up.seen.length, 0, "上游零调用");
});

test("R43负控：逃逸 key + 逃逸值（值整串 unicode 转义）同条目赋值 403", async () => {
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "k" }],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	const body = `{"${ESC("password")}":"${ESC(R43_VAL)}","note":"clean"}`;
	const { status } = await postRaw43(port, body);
	assert.equal(status, 403, `逃逸 key+逃逸值必须拦截，实际=${status}`);
	assert.equal(up.seen.length, 0, "上游零调用");
});

test("R43保守拒：重复键（含 clean 值）一律 fail-closed 403 —— 不把塌缩后文档当完整扫描证明", async () => {
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "k" }],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	const body = `{"${ESC("password")}":"your-password-here","${ESC("password")}":"placeholder-value"}`;
	const { status } = await postRaw43(port, body);
	assert.equal(status, 403, `重复解码 key 必须保守拒，实际=${status}`);
	assert.equal(up.seen.length, 0, "上游零调用");
});

test("R43边界：own value 判定——数组兄弟元素/数组值/number/bool/null 都不是 key 自己的字符串 value → 200", async () => {
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "k" }],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	const bodies = [
		`[{"password":null},"${R43_VAL}"]`, // 数组兄弟元素不得配给前对象 key（token 序相邻≠own value）
		`{"password":["${R43_VAL}"]}`, // 数组值不是字符串赋值（仅直接字符串 value）
		`{"${ESC("password")}":${R43_VAL.length}00000}`, // number 值
		`{"${ESC("password")}":true}`, // bool 值
		`{"${ESC("password")}":null}`, // null 值
		`{"password":"short"}`, // own value 但短于 12 字符 → 不命中
		`{"note":"${R43_VAL}","other":["more","clean"]}`, // innocent key 承载长值 → 不误拼
	];
	for (const body of bodies) {
		const { status } = await postRaw43(port, body);
		assert.equal(status, 200, `非 own-value 形态不得误报，实际=${status} body=${body}`);
	}
	assert.equal(up.seen.length, bodies.length, "干净 body 全部透传");
});

test("R43正控：干净 body 含逃逸 key（值=clean 占位）→ 200 不误伤", async () => {
	const up = await startUpstream();
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "k" }],
		egressAllowlist: [up.host],
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	const body = `{"messages":[],"metadata":{"${ESC("api_key")}":"placeholder-value","note":"hello"}}`;
	const { status } = await postRaw43(port, body);
	assert.equal(status, 200, `逃逸 key+占位值不得误伤，实际=${status}`);
	assert.equal(up.seen[0]!.body, body, "逐字节透传");
});

test("R43负控：block 403 时 GCP 换 token 认证副作用也为零（逃逸 key 形态）", async () => {
	clearTokenCache();
	const key = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	}).privateKey;
	const up = await startUpstream();
	const fetchCalls: string[] = [];
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "vertex", baseUrl: up.url, auth: { kind: "gcp", clientEmail: "sa@x", privateKey: key } }],
		egressAllowlist: [up.host, GCP_TOKEN_HOST],
		fetchImpl: (async (u: string, init?: RequestInit) => {
			fetchCalls.push(String(u));
			if (String(u).includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "tk", expires_in: 3600 }));
			return fetch(u, init);
		}) as unknown as typeof fetch,
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	const body = `{"messages":[],"metadata":{"${ESC("token")}":"longvalue123456789"}}`;
	const { status } = await postRaw43(port, body);
	assert.equal(status, 403);
	assert.equal(fetchCalls.length, 0, "扫描命中后换 token 的认证副作用不得发生");
	assert.equal(up.seen.length, 0);
});

test("R43单元：scanJsonDecoded 同条目语义 / 重复键保留 / 跨字段不拼接 / 有界不变式", () => {
	// 同条目逃逸 key → 凭据值：语义赋值命中
	const hits1 = scanJsonDecoded(`{"messages":[],"metadata":{"${ESC("password")}":"value-with-your-secret-123456"}}`);
	assert.ok(hits1.some((h) => h.kind === "credential-assignment"), `同条目逃逸赋值必须命中: ${JSON.stringify(hits1)}`);
	// 重复键：保守拒（fail-closed），无论值是否 clean
	assert.throws(() => scanJsonDecoded(`{"password":"REALTOK123456","password":"your-clean-value"}`), /json_duplicate_key/);
	assert.throws(() => scanJsonDecoded(`{"${ESC("password")}":"ghp_REAL...36","${ESC("password")}":"your-clean-value"}`), /json_duplicate_key/);
	// 跨字段绝不拼接：innocent key 承载别条目的凭据形态值；数组兄弟元素不是 own value
	const hits4 = scanJsonDecoded(`{"field_a":"password","field_b":"{{SECRET_c9xdwq2p}}","note":"clean"}`);
	assert.deepEqual(hits4, [], `跨字段不得误拼误报: ${JSON.stringify(hits4)}`);
	assert.deepEqual(scanJsonDecoded(`[{"password":null},"{{SECRET_c9xdwq2p}}"]`), [], "数组兄弟元素不得配给前对象 key");
	assert.deepEqual(scanJsonDecoded(`{"password":["{{SECRET_c9xdwq2p}}"]}`), [], "数组值不是字符串赋值");
	// 有界遍历不变式保持：超深 → fail-closed；非法 JSON → fail-closed
	assert.throws(() => scanJsonDecoded(`{"x":`.repeat(200) + "1" + "}".repeat(200)), /json_bounds_exceeded/);
	assert.throws(() => scanJsonDecoded('{"messages":[突破'), /invalid_json/);
	// 严格 UTF-8 不变式保持
	assert.throws(() => decodeStrictUtf8(Buffer.from([0xff, 0xfe, 0x80])), /invalid_utf8/);
});
