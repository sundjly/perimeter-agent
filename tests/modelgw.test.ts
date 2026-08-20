import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AuditLog } from "../src/audit/log.ts";
import { ModelGateway, assertAllowed } from "../src/modelgw/server.ts";
import { redact, scanSecrets } from "../src/modelgw/secrets.ts";
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
