import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { upstreamUrl } from "../src/modelgw/server.ts";
import { authorizeUpstream, clearTokenCache, gcpAccessToken } from "../src/modelgw/upstream-auth.ts";

/**
 * 三条企业模型通道的认证。策略文档把 Bedrock / Vertex / Azure / vLLM
 * 列为必须支持 —— 它们是企业唯一能过审的通道。
 */

// 测试用的一次性密钥对，不是任何真实凭据
const privateKey = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

test("static：默认 Bearer，Azure 用自定义 header", async () => {
	const bearer = await authorizeUpstream({ kind: "static", apiKey: "sk-1" }, { method: "POST", url: "https://x/", body: "{}" });
	assert.equal(bearer.headers.authorization, "Bearer sk-1");

	const azure = await authorizeUpstream(
		{ kind: "static", apiKey: "sk-2", header: "api-key" },
		{ method: "POST", url: "https://x/", body: "{}" },
	);
	assert.equal(azure.headers["api-key"], "sk-2");
	assert.equal(azure.headers.authorization, undefined, "Azure 不该同时发 Bearer");
});

test("sigv4：Bedrock 请求带签名与 content hash", async () => {
	const signed = await authorizeUpstream(
		{ kind: "sigv4", accessKeyId: "AKIA", secretAccessKey: "secret", region: "us-east-1" },
		{ method: "POST", url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/m/invoke", body: '{"a":1}' },
	);
	assert.match(signed.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=AKIA\/\d{8}\/us-east-1\/bedrock\/aws4_request/);
	assert.ok(signed.headers["x-amz-content-sha256"]);
	assert.ok(signed.headers["x-amz-date"]);
});

test("gcp：service account 换 access token 并缓存", async () => {
	clearTokenCache();
	let calls = 0;
	const fakeFetch = (async () => {
		calls += 1;
		return new Response(JSON.stringify({ access_token: "ya29.fake", expires_in: 3600 }), {
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;

	const auth = { kind: "gcp" as const, clientEmail: "sa@p.iam.gserviceaccount.com", privateKey };
	assert.equal(await gcpAccessToken(auth, fakeFetch), "ya29.fake");
	// Vertex 的 token 只有 1 小时有效期，每次请求都换会把延迟打上去
	assert.equal(await gcpAccessToken(auth, fakeFetch), "ya29.fake");
	assert.equal(calls, 1, "第二次应当命中缓存");
});

test("gcp：换 token 失败要带上上游的响应，而不是只说失败", async () => {
	clearTokenCache();
	const failing = (async () =>
		new Response("invalid_grant: account not found", { status: 400 })) as unknown as typeof fetch;
	await assert.rejects(
		gcpAccessToken({ kind: "gcp", clientEmail: "sa@x", privateKey }, failing),
		/400.*invalid_grant/s,
	);
});

test("gcp：发出的是 RS256 签名的 JWT bearer 断言", async () => {
	clearTokenCache();
	let body = "";
	const capture = (async (_url: string, init: { body: string }) => {
		body = init.body;
		return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
	}) as unknown as typeof fetch;
	await gcpAccessToken({ kind: "gcp", clientEmail: "sa@x", privateKey }, capture);

	const params = new URLSearchParams(body);
	assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
	const [header, payload] = params.get("assertion")!.split(".");
	assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), { alg: "RS256", typ: "JWT" });
	const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
	assert.equal(claims.iss, "sa@x");
	assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
	assert.equal(claims.scope, "https://www.googleapis.com/auth/cloud-platform");
});

test("上游路径：默认 OpenAI 兼容，Bedrock 从 body 取模型 id", () => {
	assert.equal(
		upstreamUrl({ id: "a", baseUrl: "https://api.openai.com/v1" }, "{}"),
		"https://api.openai.com/v1/chat/completions",
	);
	assert.equal(
		upstreamUrl(
			{ id: "b", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com", path: "/model/{model}/invoke" },
			'{"model":"anthropic.claude-sonnet-4-20250514-v1:0"}',
		),
		"https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-sonnet-4-20250514-v1%3A0/invoke",
	);
});

test("上游路径：body 不是 JSON 时不崩 —— 网关刻意不解析 body", () => {
	assert.equal(
		upstreamUrl({ id: "b", baseUrl: "https://x", path: "/model/{model}/invoke" }, "not json"),
		"https://x/model//invoke",
	);
});

test("provider 前缀被剥掉 —— 选路用 `<provider>/<model>`，上游要的是不带前缀的 id", () => {
	// 不剥的话 URL 里会多一段 provider 名，上游 404
	assert.equal(
		upstreamUrl(
			{ id: "bedrock", baseUrl: "https://b.amazonaws.com", path: "/model/{model}/invoke" },
			'{"model":"bedrock/anthropic.claude-x:0"}',
		),
		"https://b.amazonaws.com/model/anthropic.claude-x%3A0/invoke",
	);
});

test("model 来自沙箱：路径穿越与非法字符被拒", () => {
	const u = { id: "b", baseUrl: "https://x", path: "/model/{model}/invoke" };
	// `.` 不在 encodeURIComponent 的转义集里，`..` 能穿越一层
	assert.throws(() => upstreamUrl(u, '{"model":".."}'), /路径穿越/);
	assert.throws(() => upstreamUrl(u, '{"model":"a/../../b"}'), /路径穿越/);
	assert.throws(() => upstreamUrl(u, '{"model":"a b"}'), /非法的 model/);
	assert.throws(() => upstreamUrl(u, '{"model":"a?x=1"}'), /非法的 model/);
	// 合法的模型 id 与 ARN 不受影响
	assert.ok(upstreamUrl(u, '{"model":"anthropic.claude-sonnet-4-20250514-v1:0"}'));
	assert.ok(upstreamUrl(u, '{"model":"arn:aws:bedrock:us-east-1:1/inference-profile/x"}'));
});

test("并发换 token 只打一次 —— 否则整个团队的出口会同时惊群", async () => {
	clearTokenCache();
	let calls = 0;
	const slow = (async () => {
		calls += 1;
		await new Promise((r) => setTimeout(r, 30));
		return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
	}) as unknown as typeof fetch;
	const auth = { kind: "gcp" as const, clientEmail: "sa@x", privateKey };
	await Promise.all(Array.from({ length: 12 }, () => gcpAccessToken(auth, slow)));
	assert.equal(calls, 1, "12 个并发请求应当共用一次换取");
});

test("刷新失败时回退到尚未过期的旧 token，而不是直接 502", async () => {
	clearTokenCache();
	// 先拿到一个只剩 30 秒的 token（会触发下一次刷新，但仍未过期）
	const first = (async () =>
		new Response(JSON.stringify({ access_token: "old", expires_in: 30 }))) as unknown as typeof fetch;
	const auth = { kind: "gcp" as const, clientEmail: "sa@x", privateKey };
	assert.equal(await gcpAccessToken(auth, first), "old");

	// Google 抖一下：刷新失败，但旧 token 还能用 30 秒
	const failing = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
	assert.equal(await gcpAccessToken(auth, failing), "old");
});

test("私钥轮换后不复用旧 token", async () => {
	clearTokenCache();
	let n = 0;
	const counting = (async () =>
		new Response(JSON.stringify({ access_token: `t${++n}`, expires_in: 3600 }))) as unknown as typeof fetch;
	const other = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	}).privateKey;

	assert.equal(await gcpAccessToken({ kind: "gcp", clientEmail: "sa@x", privateKey }, counting), "t1");
	assert.equal(await gcpAccessToken({ kind: "gcp", clientEmail: "sa@x", privateKey: other }, counting), "t2");
});

test("发出的 JWT 是密码学有效的 RS256 签名 —— 用公钥验签，不是格式检查", async () => {
	// 前面那条只解析了 header 与 claims，签名本身没验过。
	// Google 拒绝一个签名无效的断言时只回 invalid_grant，不会说是签错了。
	clearTokenCache();
	const pair = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	let assertion = "";
	const capture = (async (_u: string, init: { body: string }) => {
		assertion = new URLSearchParams(init.body).get("assertion") ?? "";
		return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
	}) as unknown as typeof fetch;
	await gcpAccessToken({ kind: "gcp", clientEmail: "sa@x", privateKey: pair.privateKey }, capture);

	const [header, payload, signature] = assertion.split(".");
	const ok = createVerify("RSA-SHA256")
		.update(`${header}.${payload}`)
		.verify(pair.publicKey, Buffer.from(signature!, "base64url"));
	assert.ok(ok, "签名必须能被对应公钥验证通过");

	// 用**另一个密钥对**的公钥验必须失败。这才钉住「签名用的是
	// auth.privateKey 而不是某个硬编码或串号的 key」—— 那是能真实发生的 bug。
	// （改数据后验签失败是 RSA 的性质，测的是 Node crypto 不是本项目。）
	const other = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	assert.equal(
		createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(other.publicKey, Buffer.from(signature!, "base64url")),
		false,
		"必须用配置里那把私钥签，不能是别的",
	);
});

test("JWT 的有效期不超过 Google 允许的上限", async () => {
	// exp - iat 超过 1 小时会被拒，而错误信息同样只是 invalid_grant
	clearTokenCache();
	let assertion = "";
	const capture = (async (_u: string, init: { body: string }) => {
		assertion = new URLSearchParams(init.body).get("assertion") ?? "";
		return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
	}) as unknown as typeof fetch;
	await gcpAccessToken({ kind: "gcp", clientEmail: "sa@x", privateKey }, capture);

	const claims = JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString());
	assert.ok(claims.exp - claims.iat <= 3600, "Google 拒绝有效期超过 1 小时的断言");
});
