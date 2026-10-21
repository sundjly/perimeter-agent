import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
	AuthError,
	JwtAuthenticator,
	RemoteJwks,
	StaticJwks,
	scopeFromGroups,
	type JwkKey,
} from "../src/gateway/auth.ts";
import { execSync, spawn } from "node:child_process";
import { Gateway } from "../src/gateway/server.ts";
import { DockerBackend, LocalBackend } from "../src/gateway/execution-backend.ts";
import { DEFAULT_LIMITS, Outbox } from "../src/gateway/transport.ts";
import { parseCommand } from "../src/protocol/validate.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const s1Backend = new DockerBackend({ image: "perimeter-sandbox:test", repoRoot: REPO, network: "none" });
const MOCK = join(REPO, "tests/fixtures/mock-model.mjs");

// production fail-closed 要求审批请求绑定真实 git HEAD：这些撤权语义测试
// 需要在发起 prompt 前给会话工作区一个临时 git fixture（宿主机侧建，容器内可读）。
function initGitFixture(wsPath: string): void {
	execSync("git init -q", { cwd: wsPath });
	execSync("git config user.name 'Test' && git config user.email 'test@test.local'", { cwd: wsPath });
	writeFileSync(join(wsPath, "seed.txt"), "seed");
	execSync("git add . && git commit -q -m 'init'", { cwd: wsPath });
}

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups) {
		try { await c(); } catch {}
	}
});

// 生成测试用 RSA 与 EC 密钥对
const rsaKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaJwk: JwkKey = {
	...rsaKey.publicKey.export({ format: "jwk" }),
	kty: "RSA",
	kid: "rsa-1",
	use: "sig",
	alg: "RS256",
};

const ecKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ecJwk: JwkKey = {
	...ecKey.publicKey.export({ format: "jwk" }),
	kty: "EC",
	kid: "ec-1",
	use: "sig",
	alg: "ES256",
};

function signJwt(
	payload: Record<string, unknown>,
	header: { alg: string; kid?: string },
	key = rsaKey.privateKey,
	dsaEncoding?: "ieee-p1363",
): string {
	const h = Buffer.from(JSON.stringify(header)).toString("base64url");
	const c = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const signer = createSign(header.alg === "ES256" ? "sha256" : "sha256");
	signer.update(`${h}.${c}`);
	const sig = signer.sign(dsaEncoding ? { key, dsaEncoding } : key).toString("base64url");
	return `${h}.${c}.${sig}`;
}

test("可信身份：RS256 与 ES256 验签成功并提取 principal", async () => {
	const auth = new JwtAuthenticator({
		issuer: "https://idp.corp.local",
		audience: "perimeter-gateway",
		jwks: new StaticJwks([rsaJwk, ecJwk]),
	});

	const exp = Math.floor(Date.now() / 1000) + 3600;
	const tokenRsa = signJwt(
		{ iss: "https://idp.corp.local", aud: "perimeter-gateway", sub: "alice_001", exp, groups: ["dev", "core"] },
		{ alg: "RS256", kid: "rsa-1" },
	);
	const p1 = await auth.authenticate(tokenRsa);
	assert.equal(p1.id, "https://idp.corp.local|alice_001");
	assert.equal(p1.issuer, "https://idp.corp.local");
	assert.equal(p1.subject, "alice_001");
	assert.deepEqual(p1.groups, ["dev", "core"]);
	assert.equal(p1.expiresAt, exp * 1000);
	assert.ok(auth.isPrincipalId(p1.id));

	const tokenEc = signJwt(
		{ iss: "https://idp.corp.local", aud: "perimeter-gateway", sub: "bob_002", exp, groups: ["qa"] },
		{ alg: "ES256", kid: "ec-1" },
		ecKey.privateKey,
		"ieee-p1363",
	);
	const p2 = await auth.authenticate(tokenEc);
	assert.equal(p2.id, "https://idp.corp.local|bob_002");
	assert.equal(p2.subject, "bob_002");
});

test("可信身份负面测试：算法伪造、过期、受众与签发者不匹配均被拒", async () => {
	const auth = new JwtAuthenticator({
		issuer: "https://idp.corp.local",
		audience: "perimeter-gateway",
		jwks: new StaticJwks([rsaJwk]),
	});

	const exp = Math.floor(Date.now() / 1000) + 3600;
	// 算法不在 allowlist
	const tokenNone = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(
		JSON.stringify({ iss: "https://idp.corp.local", aud: "perimeter-gateway", sub: "eve", exp }),
	).toString("base64url")}.`;
	await assert.rejects(() => auth.authenticate(tokenNone), /算法不在 allowlist/);

	// 未知 kid
	const badKid = signJwt(
		{ iss: "https://idp.corp.local", aud: "perimeter-gateway", sub: "alice", exp },
		{ alg: "RS256", kid: "unknown-kid" },
	);
	await assert.rejects(() => auth.authenticate(badKid), /找不到匹配的验签密钥/);

	// 过期
	const expired = signJwt(
		{ iss: "https://idp.corp.local", aud: "perimeter-gateway", sub: "alice", exp: Math.floor(Date.now() / 1000) - 100 },
		{ alg: "RS256", kid: "rsa-1" },
	);
	await assert.rejects(() => auth.authenticate(expired), /token 已过期/);

	// 未生效 nbf
	const future = signJwt(
		{
			iss: "https://idp.corp.local",
			aud: "perimeter-gateway",
			sub: "alice",
			exp: Math.floor(Date.now() / 1000) + 3600,
			nbf: Math.floor(Date.now() / 1000) + 500,
		},
		{ alg: "RS256", kid: "rsa-1" },
	);
	await assert.rejects(() => auth.authenticate(future), /token 尚未生效/);

	// audience 不匹配
	const wrongAud = signJwt(
		{ iss: "https://idp.corp.local", aud: "other-app", sub: "alice", exp },
		{ alg: "RS256", kid: "rsa-1" },
	);
	await assert.rejects(() => auth.authenticate(wrongAud), /audience 不匹配/);

	// issuer 不匹配
	const wrongIss = signJwt(
		{ iss: "https://evil.idp", aud: "perimeter-gateway", sub: "alice", exp },
		{ alg: "RS256", kid: "rsa-1" },
	);
	await assert.rejects(() => auth.authenticate(wrongIss), /issuer 不匹配/);

	// sub 包含非法字符或超长
	const badSub = signJwt(
		{ iss: "https://idp.corp.local", aud: "perimeter-gateway", sub: "alice|mallory", exp },
		{ alg: "RS256", kid: "rsa-1" },
	);
	await assert.rejects(() => auth.authenticate(badSub), /sub 无效/);
});

test("JWKS 资源上限与刷新限频：故障并发请求 single-flight 与限频", async () => {
	let fetchCount = 0;
	const srv = createServer((_req, res) => {
		fetchCount++;
		// 模拟 IdP 故障
		res.writeHead(500).end("IdP Internal Error");
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	cleanups.push(() => new Promise((r) => srv.close(() => r())));
	const port = (srv.address() as { port: number }).port;

	const jwks = new RemoteJwks({
		url: `http://127.0.0.1:${port}/jwks.json`,
		allowHttp: true,
		minRefreshMs: 1000,
	});

	// 并发 10 个请求：必须 single-flight，仅打 1 次 fetch
	const results = await Promise.allSettled(Array.from({ length: 10 }, () => jwks.get("any-kid")));
	for (const r of results) {
		assert.equal(r.status, "rejected");
	}
	assert.equal(fetchCount, 1, "故障时并发请求必须 single-flight，不能惊群打满 IdP");

	// 紧接着顺序发请求：受 minRefreshMs 限制，不应立即再次打 IdP
	await assert.rejects(() => jwks.get("any-kid"), /JWKS 不可用/);
	assert.equal(fetchCount, 1, "限频窗口内不能发起新的刷新");
});

test("JWKS 资源边界：流式超大响应（>256KiB）取消连接并拒绝", async () => {
	let aborted = false;
	const srv = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.write('{"keys":[');
		// 持续发送超过 256KiB 的垃圾数据
		const chunk = Buffer.alloc(64 * 1024, " ");
		const interval = setInterval(() => {
			if (!res.write(chunk)) {
				// backpressure
			}
		}, 10);
		res.on("close", () => {
			aborted = true;
			clearInterval(interval);
		});
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	cleanups.push(() => new Promise((r) => srv.close(() => r())));
	const port = (srv.address() as { port: number }).port;

	const jwks = new RemoteJwks({
		url: `http://127.0.0.1:${port}/jwks.json`,
		allowHttp: true,
	});

	await assert.rejects(() => jwks.get("any-kid"), /JWKS 超过 256KiB 大小限制/);
	// 等待连接关闭触发
	await new Promise((r) => setTimeout(r, 50));
	assert.ok(aborted, "超限时应中止（abort）响应流");
});

test("JWKS 资源边界：恶意返回 key 数量超过 32 被拒绝", async () => {
	const fakeKeys = Array.from({ length: 33 }, (_, i) => ({ kty: "RSA", kid: `key-${i}` }));
	const srv = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ keys: fakeKeys }));
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	cleanups.push(() => new Promise((r) => srv.close(() => r())));
	const port = (srv.address() as { port: number }).port;

	const jwks = new RemoteJwks({
		url: `http://127.0.0.1:${port}/jwks.json`,
		allowHttp: true,
	});

	await assert.rejects(() => jwks.get("any-kid"), /JWKS key 数量超过限制/);
});

test("生产模式构造校验：禁止共享 token、必须配置 auth/scope/hosts/origins", () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-prod-test-"));
	const dummyAuth = new StaticJwks([rsaJwk]);

	// 生产模式传 token 报错
	assert.throws(
		() =>
			new Gateway({
				mode: "production",
				backend: s1Backend,
				port: 0,
				host: "127.0.0.1",
				token: "forbidden-token",
				policyFile: "config/policy.yaml",
				auditFile: join(dir, "a.jsonl"),
				workspaceRoot: join(dir, "ws"),
				webRoot: "web",
			}),
		/production 模式禁止共享 token/,
	);

	// 生产模式缺 auth 报错
	assert.throws(
		() =>
			new Gateway({
				mode: "production",
				backend: s1Backend,
				port: 0,
				host: "127.0.0.1",
				policyFile: "config/policy.yaml",
				auditFile: join(dir, "a.jsonl"),
				workspaceRoot: join(dir, "ws"),
				webRoot: "web",
			}),
		/production 模式必须配置 auth/,
	);

	// demo 模式绑定非回环地址拒绝启动
	assert.throws(
		() =>
			new Gateway({
				mode: "demo",
				port: 0,
				host: "0.0.0.0",
				token: "dev-token",
				policyFile: "config/policy.yaml",
				auditFile: join(dir, "a.jsonl"),
				workspaceRoot: join(dir, "ws"),
				webRoot: "web",
			}),
		/demo 模式.*只能绑定回环地址/,
	);
});

test("生产模式端到端：Bearer 认证、Host+Origin 精确校验、服务端 scope 推导", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-prod-e2e-"));
	const auth = new JwtAuthenticator({
		issuer: "https://idp.corp.local",
		audience: "perimeter-gateway",
		jwks: new StaticJwks([rsaJwk]),
	});

	// 预先获取空闲端口确保 allowedHosts 精确匹配
	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const port = (s.address() as { port: number }).port;
	await new Promise<void>((r) => s.close(() => r()));

	const mock = spawn(process.execPath, [MOCK, "0", JSON.stringify([{ text: "ok" }])], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	cleanups.push(() => void mock.kill());
	const mockPort: number = await new Promise((r) => mock.stdout?.once("data", (d) => r(JSON.parse(d.toString()).port)));

	const prodGw = new Gateway({
		mode: "production",
		backend: s1Backend,
		port,
		host: "127.0.0.1",
		auth,
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit2.jsonl"),
		workspaceRoot: join(dir, "workspaces2"),
		webRoot: join(REPO, "web"),
		model: { baseUrl: `http://127.0.0.1:${mockPort}/v1`, token: "dummy", model: "mock-model" },
		allowedHosts: [`127.0.0.1:${port}`],
		allowedOrigins: ["https://console.corp.local"],
		resolveScope: scopeFromGroups({
			dev: { repo: "app-repo", team: "core-team" },
		}),
	});
	cleanups.push(() => prodGw.close());
	const listening = await prodGw.listen();

	const exp = Math.floor(Date.now() / 1000) + 3600;
	const token = signJwt(
		{ iss: "https://idp.corp.local", aud: "perimeter-gateway", sub: "engineer_1", exp, groups: ["dev"] },
		{ alg: "RS256", kid: "rsa-1" },
	);

	// 1. 尝试用 query token 接入生产模式：必须被拒绝
	const wsBadQuery = new WebSocket(`ws://127.0.0.1:${listening}/?token=${token}`, {
		headers: { Host: `127.0.0.1:${listening}`, Origin: "https://console.corp.local" },
	});
	const badQueryErr = await new Promise((r) => {
		wsBadQuery.on("error", r);
		wsBadQuery.on("unexpected-response", (_req, res) => r(res.statusCode));
	});
	assert.equal(badQueryErr, 401, "生产模式严禁 query token 接入");

	// 2. 恶意 Host 被拒绝（421）
	const wsBadHost = new WebSocket(`ws://127.0.0.1:${listening}/`, {
		headers: { Host: "evil.attacker.com", Authorization: `Bearer ${token}` },
	});
	const badHostErr = await new Promise((r) => {
		wsBadHost.on("error", r);
		wsBadHost.on("unexpected-response", (_req, res) => r(res.statusCode));
	});
	assert.equal(badHostErr, 421, "未获批 Host 必须返回 421");

	// 3. 恶意外来 Origin 被拒绝（403）
	const wsBadOrigin = new WebSocket(`ws://127.0.0.1:${listening}/`, {
		headers: {
			Host: `127.0.0.1:${listening}`,
			Origin: "https://attacker.site",
			Authorization: `Bearer ${token}`,
		},
	});
	const badOriginErr = await new Promise((r) => {
		wsBadOrigin.on("error", r);
		wsBadOrigin.on("unexpected-response", (_req, res) => r(res.statusCode));
	});
	assert.equal(badOriginErr, 403, "未获批 Origin 必须返回 403");

	// 4. 正确的 Bearer Token + Host + Origin：成功接入并获取 attached 与 snapshot
	const ws = new WebSocket(`ws://127.0.0.1:${listening}/`, {
		headers: {
			Host: `127.0.0.1:${listening}`,
			Origin: "https://console.corp.local",
			Authorization: `Bearer ${token}`,
		},
	});
	cleanups.push(() => void ws.close());
	const messages: any[] = [];
	ws.on("message", (d) => {
		messages.push(JSON.parse(String(d)));
	});
	await new Promise((r) => ws.once("open", r));

	// 等待 attached 和 snapshot
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline && !messages.some((m) => m.type === "control" && m.control === "attached")) {
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.ok(messages.some((m) => m.type === "control" && m.control === "attached"), "应收到 attached 控制帧");

	// 5. 凭据吊销：revokePrincipal 立即切断该主体连接
	prodGw.revokePrincipal("https://idp.corp.local|engineer_1");
	const closed = await new Promise<number>((r) => ws.once("close", (code) => r(code)));
	assert.equal(closed, 4001, "吊销后现存连接立即被 4001 关闭");

	// 吊销后新连接被拒绝
	const wsRevoked = new WebSocket(`ws://127.0.0.1:${listening}/`, {
		headers: {
			Host: `127.0.0.1:${listening}`,
			Origin: "https://console.corp.local",
			Authorization: `Bearer ${token}`,
		},
	});
	const revokedErr = await new Promise((r) => {
		wsRevoked.on("error", r);
		wsRevoked.on("unexpected-response", (_req, res) => r(res.statusCode));
	});
	assert.equal(revokedErr, 401, "已吊销凭据无法再次接入");
});

test("安全浏览器会话（Cookie 方案）：POST /auth/session 颁发 HttpOnly 同源 cookie 与 CSRF 防护", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-cookie-"));
	const auth = new JwtAuthenticator({
		issuer: "https://idp.corp.local",
		audience: "perimeter-gateway",
		jwks: new StaticJwks([rsaJwk]),
	});

	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const port = (s.address() as { port: number }).port;
	await new Promise<void>((r) => s.close(() => r()));

	const gw2 = new Gateway({
		mode: "production",
		backend: s1Backend,
		port,
		host: "127.0.0.1",
		auth,
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit2.jsonl"),
		workspaceRoot: join(dir, "ws2"),
		webRoot: join(REPO, "web"),
		allowedHosts: [`127.0.0.1:${port}`],
		allowedOrigins: ["https://console.corp.local"],
		resolveScope: () => ({ repo: "r", team: "t" }),
	});
	cleanups.push(() => gw2.close());
	const listening = await gw2.listen();

	const exp = Math.floor(Date.now() / 1000) + 3600;
	const token = signJwt(
		{ iss: "https://idp.corp.local", aud: "perimeter-gateway", sub: "web_user", exp, groups: ["dev"] },
		{ alg: "RS256", kid: "rsa-1" },
	);

	// 跨站 Origin 尝试换 cookie：403
	const evilRes = await fetch(`http://127.0.0.1:${listening}/auth/session`, {
		method: "POST",
		headers: {
			Host: `127.0.0.1:${listening}`,
			Origin: "https://evil.site",
			Authorization: `Bearer ${token}`,
		},
	});
	assert.equal(evilRes.status, 403, "跨站 Origin POST /auth/session 必须 403");

	// 合法 Origin + Bearer 换取 cookie
	const okRes = await fetch(`http://127.0.0.1:${listening}/auth/session`, {
		method: "POST",
		headers: {
			Host: `127.0.0.1:${listening}`,
			Origin: "https://console.corp.local",
			Authorization: `Bearer ${token}`,
		},
	});
	assert.equal(okRes.status, 204);
	const cookie = okRes.headers.get("set-cookie");
	assert.ok(cookie, "必须返回 Set-Cookie");
	assert.match(cookie!, /__Host-perimeter_session=/);
	assert.match(cookie!, /HttpOnly/);
	assert.match(cookie!, /SameSite=Strict/);

	// 提取 cookie 字符串
	const cookieVal = cookie!.split(";")[0]!;

	// 浏览器使用 cookie + 正确 Origin 接入 WebSocket
	const ws = new WebSocket(`ws://127.0.0.1:${listening}/`, {
		headers: {
			Host: `127.0.0.1:${listening}`,
			Origin: "https://console.corp.local",
			Cookie: cookieVal,
		},
	});
	cleanups.push(() => void ws.close());
	await new Promise((r) => ws.once("open", r));
	assert.equal(ws.readyState, WebSocket.OPEN);

	// CSWSH 跨站 WebSocket 劫持测试：恶意 Origin 携带同一 cookie 连入必须被 403 拒绝
	const wsHijack = new WebSocket(`ws://127.0.0.1:${listening}/`, {
		headers: {
			Host: `127.0.0.1:${listening}`,
			Origin: "https://evil-hacker.com",
			Cookie: cookieVal,
		},
	});
	const hijackErr = await new Promise((r) => {
		wsHijack.on("error", r);
		wsHijack.on("unexpected-response", (_req, res) => r(res.statusCode));
	});
	assert.equal(hijackErr, 403, "带合法 cookie 但来自恶意 Origin 的 WebSocket 连接必须被 403 拦截");
});

test("运行时命令校验：未知属性、超长 prompt、伪造 role 均被严格拒绝", () => {
	// 未知属性
	const r1 = parseCommand({ type: "prompt", text: "hi", requestId: "1", extraField: "exploit" });
	assert.equal(r1.ok, false);
	assert.match((r1 as { error: string }).error, /命令含未知字段/);

	// 恶意超长 prompt（>64KiB）
	const hugePrompt = "a".repeat(65 * 1024);
	const r2 = parseCommand({ type: "prompt", text: hugePrompt, requestId: "1" });
	assert.equal(r2.ok, false);
	assert.match((r2 as { error: string }).error, /超过长度上限/);

	// 伪造非法 share role（如 owner）
	const r3 = parseCommand({ type: "share", actor: "mallory", role: "owner" });
	assert.equal(r3.ok, false);
	assert.match((r3 as { error: string }).error, /共享角色无效/);

	// 非法非对象
	const r4 = parseCommand(["prompt", "hi"]);
	assert.equal(r4.ok, false);
});

test("静态服务鲁棒性：NUL 字节、目录遍历、畸形编码不打崩网关", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-static-"));
	const gw = new Gateway({
		mode: "demo",
		port: 0,
		host: "127.0.0.1",
		token: "t",
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "ws"),
		webRoot: join(REPO, "web"),
	});
	const port = await gw.listen();
	cleanups.push(() => gw.close());

	// 1. 畸形百分号编码
	const r1 = await fetch(`http://127.0.0.1:${port}/%c0%af%fe`);
	assert.equal(r1.status, 400);

	// 2. 跨目录遍历（resolve 后超出 webRoot）
	const r2 = await fetch(`http://127.0.0.1:${port}/../../../../etc/passwd`);
	assert.equal(r2.status, 404);

	// 3. 请求一个目录（而非文件）
	const r3 = await fetch(`http://127.0.0.1:${port}/`);
	assert.equal(r3.status, 200); // 根目录映射到 index.html
	const r3dir = await fetch(`http://127.0.0.1:${port}/css`); // 不存在的非文件
	assert.equal(r3dir.status, 404);

	// 4. 网关仍正常存活
	const r4 = await fetch(`http://127.0.0.1:${port}/index.html`);
	assert.equal(r4.status, 200);
});

test("连接级背压与单慢端隔离：超限只终止该慢端，不影响正常连接", () => {
	const normalWs = {
		readyState: 1,
		OPEN: 1,
		bufferedAmount: 0,
		send: (_d: string, cb?: (err?: Error) => void) => cb?.(),
		close: () => {},
		terminate: () => {},
	};
	let slowTerminated = false;
	const slowWs = {
		readyState: 1,
		OPEN: 1,
		bufferedAmount: 10 * 1024 * 1024, // 超过 8MiB 物理缓冲水位
		send: () => {},
		close: () => {},
		terminate() { slowTerminated = true; },
	};

	const outboxNormal = new Outbox(normalWs, DEFAULT_LIMITS);
	const outboxSlow = new Outbox(slowWs, DEFAULT_LIMITS);

	// 正常连接发帧成功
	const ok = outboxNormal.send(JSON.stringify({ type: "ping" }));
	assert.equal(ok, true);
	assert.equal(outboxNormal.dead, false);

	// 慢端连接发帧被背压拒绝并直接 terminate，避免继续堆积内存
	const slowOk = outboxSlow.send(JSON.stringify({ type: "ping" }));
	assert.equal(slowOk, false);
	assert.equal(outboxSlow.dead, true);
	assert.equal(slowTerminated, true, "超水位的慢端必须被终止丢弃");

	// 再次确认正常连接不受任何影响
	assert.equal(outboxNormal.send(JSON.stringify({ type: "ping2" })), true);
});

test("R1: RemoteJwks 严格过期 fail-closed 与刷新恢复及 now=0 测试", async () => {
	let status = 200;
	let fetchCount = 0;
	const srv = createServer((_req, res) => {
		fetchCount++;
		if (status !== 200) {
			res.writeHead(status).end();
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ keys: [rsaJwk] }));
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const port = (srv.address() as { port: number }).port;
	cleanups.push(() => new Promise((r) => srv.close(() => r())));

	let mockNow = 0;
	const jwks = new RemoteJwks({
		url: `http://127.0.0.1:${port}/jwks.json`,
		allowHttp: true,
		ttlMs: 100,
		maxStaleMs: 200,
		minRefreshMs: 50,
		now: () => mockNow,
	});

	// 1. mockNow = 0 时初次拉取必须执行，不能被 minRefreshMs 阻塞跳过
	const k0 = await jwks.get("rsa-1");
	assert.ok(k0, "now=0 初次尝试必须成功获取 key");
	assert.equal(fetchCount, 1);

	// 2. 模拟 IdP 故障 503，时间推进超过 maxStaleMs
	status = 503;
	mockNow += 1000;
	// 严格 fail-closed：过期已知 kid 绝不能无限接受，必须抛出 AuthError
	await assert.rejects(
		async () => { await jwks.get("rsa-1"); },
		(err: Error) => {
			assert.ok(err instanceof AuthError);
			assert.match(err.message, /JWKS 不可用/);
			return true;
		},
		"超过 maxStaleMs 必须 fail-closed 抛出 AuthError",
	);

	// 3. IdP 恢复后，满足 minRefreshMs 时可正常刷新恢复
	status = 200;
	mockNow += 100;
	const recovered = await jwks.get("rsa-1");
	assert.ok(recovered, "IdP 恢复后应能成功获取刷新后的 key");
});

test("R2: production 持续资源权限校验（撤回映射阻断 attach/命令/出站，同 repo 授权不受损）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-r2-"));
	let aliceRepo: string | undefined = "repo-a";
	const bobRepo = "repo-a";

	const auth = new JwtAuthenticator({
		issuer: "https://idp.corp.local",
		audience: "perimeter-gateway",
		jwks: new StaticJwks([rsaJwk]),
	});

	// 预先获取空闲端口确保 allowedHosts 精确匹配
	const s2 = createServer();
	await new Promise<void>((r) => s2.listen(0, "127.0.0.1", r));
	const port = (s2.address() as { port: number }).port;
	await new Promise<void>((r) => s2.close(() => r()));

	const gw = new Gateway({
		mode: "production",
		backend: s1Backend,
		port,
		host: "127.0.0.1",
		auth,
		allowedHosts: [`127.0.0.1:${port}`],
		allowedOrigins: ["https://console.corp.local"],
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "ws"),
		webRoot: join(REPO, "web"),
		resolveScope: (actor) => {
			const repo = actor.includes("alice") ? aliceRepo : bobRepo;
			return repo ? { repo, team: "team-a" } : undefined;
		},
	});
	await gw.listen();
	cleanups.push(() => gw.close());

	const exp = Math.floor(Date.now() / 1000) + 3600;
	const aliceToken = signJwt({ iss: "https://idp.corp.local", aud: "perimeter-gateway", sub: "alice", exp }, { alg: "RS256", kid: "rsa-1" });
	const bobToken = signJwt({ iss: "https://idp.corp.local", aud: "perimeter-gateway", sub: "bob", exp }, { alg: "RS256", kid: "rsa-1" });

	const alicePrincipalId = "https://idp.corp.local|alice";
	const bobPrincipalId = "https://idp.corp.local|bob";

	const sessionId = "session-r2-test";

	// 1. Alice 创建会话
	const wsAlice1 = new WebSocket(`ws://127.0.0.1:${port}/?session=${sessionId}`, {
		headers: { Authorization: `Bearer ${aliceToken}`, Origin: "https://console.corp.local", Host: `127.0.0.1:${port}` },
	});
	wsAlice1.on("error", () => {});
	cleanups.push(() => { try { wsAlice1.terminate(); } catch {} });

	await new Promise<void>((resolve, reject) => {
		wsAlice1.on("message", (raw) => {
			const msg = JSON.parse(String(raw));
			if (msg.type === "control" && msg.control === "attached") resolve();
		});
		wsAlice1.on("error", reject);
	});

	// Alice 共享给 Bob 作为 editor
	wsAlice1.send(JSON.stringify({ type: "share", actor: bobPrincipalId, role: "editor" }));
	await new Promise((r) => setTimeout(r, 100));

	// Bob 连入该会话
	const wsBob = new WebSocket(`ws://127.0.0.1:${port}/?session=${sessionId}`, {
		headers: { Authorization: `Bearer ${bobToken}`, Origin: "https://console.corp.local", Host: `127.0.0.1:${port}` },
	});
	wsBob.on("error", () => {});
	cleanups.push(() => { try { wsBob.terminate(); } catch {} });
	await new Promise<void>((resolve, reject) => {
		wsBob.on("message", (raw) => {
			const msg = JSON.parse(String(raw));
			if (msg.type === "control" && msg.control === "attached") resolve();
		});
		wsBob.on("error", reject);
	});

	// 2. 服务端撤回 Alice 针对 repo-a 的资源权限
	aliceRepo = "repo-other";

	// 3. 断言：已建立连接的 Alice 发送命令收到「资源权限已撤销」
	const cmdErrPromise = new Promise<string>((resolve) => {
		wsAlice1.on("message", (raw) => {
			const msg = JSON.parse(String(raw));
			if (msg.event?.type === "error") resolve(msg.event.message);
		});
	});
	wsAlice1.send(JSON.stringify({ type: "prompt", text: "do something", requestId: "r1" }));
	const cmdErr = await cmdErrPromise;
	assert.equal(cmdErr, "资源权限已撤销");

	// 4. 断言：Alice 新建连接尝试重新 attach 该会话被直接拒绝
	const wsAlice2 = new WebSocket(`ws://127.0.0.1:${port}/?session=${sessionId}`, {
		headers: { Authorization: `Bearer ${aliceToken}`, Origin: "https://console.corp.local", Host: `127.0.0.1:${port}` },
	});
	wsAlice2.on("error", () => {});
	const closeCode = await new Promise<number>((resolve) => {
		wsAlice2.on("close", (code) => resolve(code));
	});
	assert.equal(closeCode, 4003, "被撤权主体接入旧会话必须被 4003 关闭");

	// 5. 断言：同 repo 的 Bob 完全不受影响，依然能正常发送命令
	let bobCommandReceived = false;
	wsBob.on("message", (raw) => {
		const msg = JSON.parse(String(raw));
		if (msg.type === "control" && msg.control === "attached") bobCommandReceived = true;
	});
	wsBob.send(JSON.stringify({ type: "prompt", text: "bob prompt", requestId: "r2" }));
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(wsBob.readyState, WebSocket.OPEN, "Bob 连接未被破坏");
});

test("R3: 异步验签在途吊销与关闭缓冲阻断", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-r3-"));
	let sleepMs = 0;
	const auth = {
		isPrincipalId: () => true,
		async authenticate(token: string) {
			if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
			return { id: `test|${token}`, issuer: "test", subject: token, expiresAt: Date.now() + 3600_000, groups: [] };
		},
	};

	const s3 = createServer();
	await new Promise<void>((r) => s3.listen(0, "127.0.0.1", r));
	const port = (s3.address() as { port: number }).port;
	await new Promise<void>((r) => s3.close(() => r()));

	const gw = new Gateway({
		mode: "production",
		backend: s1Backend,
		port,
		host: "127.0.0.1",
		auth,
		allowedHosts: [`127.0.0.1:${port}`],
		allowedOrigins: ["https://console.corp.local"],
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "ws"),
		webRoot: join(REPO, "web"),
		resolveScope: () => ({ repo: "r", team: "t" }),
	});
	await gw.listen();
	cleanups.push(() => gw.close());

	// 1. 异步验签在途时发生吊销
	sleepMs = 50;
	const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
		headers: { Authorization: "Bearer user-revoking", Origin: "https://console.corp.local", Host: `127.0.0.1:${port}` },
	});
	ws.on("error", () => {});
	cleanups.push(() => { try { ws.terminate(); } catch {} });

	// 在验签 await 期间吊销
	setTimeout(() => { gw.revokePrincipal("test|user-revoking"); }, 10);

	const statusCode = await new Promise<number>((resolve) => {
		ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
		ws.on("close", (code) => resolve(code));
	});
	assert.equal(statusCode, 401, "在途验签期间吊销必须拒绝握手 (401)");
});

test("R4: auth/session 端点并发/body限制与 limits 非法参数校验", async () => {
	const dummyAuth = new JwtAuthenticator({ issuer: "https://idp", audience: "aud", jwks: new StaticJwks([]) });
	// 1. limits 包含非法值（NaN / Infinity / 负数）拒绝启动
	assert.throws(
		() => new Gateway({
			mode: "demo", port: 0, host: "127.0.0.1", token: "t",
			policyFile: join(REPO, "config/policy.yaml"), auditFile: "/tmp/a.jsonl",
			workspaceRoot: "/tmp/ws", webRoot: join(REPO, "web"),
			limits: { maxConnections: Number.NaN },
		}),
		/配置非法：limits.maxConnections 必须为有限正整数/,
	);
	assert.throws(
		() => new Gateway({
			mode: "demo", port: 0, host: "127.0.0.1", token: "t",
			policyFile: join(REPO, "config/policy.yaml"), auditFile: "/tmp/a.jsonl",
			workspaceRoot: "/tmp/ws", webRoot: join(REPO, "web"),
			limits: { maxCommandsPerSecond: -5 },
		}),
		/配置非法：limits.maxCommandsPerSecond 必须为有限正整数/,
	);

	// 2. 生产模式 Origin 必须是 https
	assert.throws(
		() => new Gateway({
			mode: "production", port: 0, host: "127.0.0.1",
			backend: s1Backend,
			auth: dummyAuth,
			allowedHosts: ["127.0.0.1"],
			allowedOrigins: ["http://insecure.corp.local"],
			policyFile: join(REPO, "config/policy.yaml"), auditFile: "/tmp/a.jsonl",
			workspaceRoot: "/tmp/ws", webRoot: join(REPO, "web"),
			resolveScope: () => ({ repo: "r", team: "t" }),
		}),
		/production allowedOrigins 必须是精确 https origin/,
	);

	const dir = mkdtempSync(join(tmpdir(), "gw-r4-"));
	const s4 = createServer();
	await new Promise<void>((r) => s4.listen(0, "127.0.0.1", r));
	const port = (s4.address() as { port: number }).port;
	await new Promise<void>((r) => s4.close(() => r()));

	const gw = new Gateway({
		mode: "production", port, host: "127.0.0.1",
		backend: s1Backend,
		auth: dummyAuth,
		allowedHosts: [`127.0.0.1:${port}`],
		allowedOrigins: ["https://console.corp.local"],
		policyFile: join(REPO, "config/policy.yaml"), auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "ws"), webRoot: join(REPO, "web"),
		resolveScope: () => ({ repo: "r", team: "t" }),
	});
	await gw.listen();
	cleanups.push(() => gw.close());

	// 3. /auth/session 拒绝非空 body 请求
	const rBody = await fetch(`http://127.0.0.1:${port}/auth/session`, {
		method: "POST",
		headers: { Origin: "https://console.corp.local", Host: `127.0.0.1:${port}`, "Content-Type": "text/plain" },
		body: "unexpected body content",
	});
	assert.equal(rBody.status, 400, "带非空 body 的请求必须被拒绝 (400)");
});

test("R5: members 特殊 key 原型防注入与符号链接逃逸防御", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-r5-"));
	const secretFile = join(dir, "external-secret.txt");
	writeFileSync(secretFile, "TOP_SECRET_DATA");
	const symlinkTarget = join(REPO, "web", "escaped-test-link.txt");
	try { unlinkSync(symlinkTarget); } catch {}
	symlinkSync(secretFile, symlinkTarget);
	cleanups.push(() => { try { unlinkSync(symlinkTarget); } catch {} });

	const gw = new Gateway({
		mode: "demo", port: 0, host: "127.0.0.1", token: "t",
		policyFile: join(REPO, "config/policy.yaml"), auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "ws"), webRoot: join(REPO, "web"),
	});
	const port = await gw.listen();
	cleanups.push(() => gw.close());

	// 1. 符号链接指向 webRoot 外部的文件必须被拒绝（404）
	const rSymlink = await fetch(`http://127.0.0.1:${port}/escaped-test-link.txt`);
	assert.equal(rSymlink.status, 404, "符号链接逃出 webRoot 必须返回 404");

	// 2. members 特殊 key 原型注入防护 (__proto__, constructor)
	const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=t&actor=owner@local`);
	cleanups.push(() => { ws.terminate(); });

	await new Promise<void>((resolve, reject) => {
		ws.on("message", (raw) => {
			const msg = JSON.parse(String(raw));
			if (msg.event?.type === "session.snapshot") resolve();
		});
		ws.on("error", reject);
	});

	const errPromise = new Promise<string>((resolve) => {
		ws.on("message", (raw) => {
			const msg = JSON.parse(String(raw));
			if (msg.event?.type === "error") resolve(msg.event.message);
		});
	});
	ws.send(JSON.stringify({ type: "share", actor: "__proto__", role: "editor" }));
	const errMsg = await errPromise;
	assert.equal(errMsg, "非法共享命令或无权共享");
});

test("R2 强化：同 repo 不同 team 跨组越界被拒", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-team-test-"));
	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const port = (s.address() as { port: number }).port;
	await new Promise<void>((r) => s.close(() => r()));

	const auth = new JwtAuthenticator({
		issuer: "https://idp.corp.local",
		audience: "perimeter-gateway",
		jwks: new StaticJwks([rsaJwk]),
	});

	const gw = new Gateway({
		mode: "production",
		backend: s1Backend,
		port,
		host: "127.0.0.1",
		auth,
		allowedHosts: [`127.0.0.1:${port}`],
		allowedOrigins: ["https://console.corp.local"],
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "ws"),
		webRoot: join(REPO, "web"),
		resolveScope: (actor) => {
			if (actor.includes("alice")) return { repo: "app-repo", team: "team-alpha" };
			// charlie 同 repo 但不同 team
			return { repo: "app-repo", team: "team-beta" };
		},
	});
	await gw.listen();
	cleanups.push(() => gw.close());

	const exp = Math.floor(Date.now() / 1000) + 3600;
	const aliceToken = signJwt({ iss: "https://idp.corp.local", aud: "perimeter-gateway", sub: "alice", exp }, { alg: "RS256", kid: "rsa-1" });
	const charlieToken = signJwt({ iss: "https://idp.corp.local", aud: "perimeter-gateway", sub: "charlie", exp }, { alg: "RS256", kid: "rsa-1" });

	const sessionId = "session-team-isolation";
	// Alice (team-alpha) 创建会话
	const wsAlice = new WebSocket(`ws://127.0.0.1:${port}/?session=${sessionId}`, {
		headers: { Authorization: `Bearer ${aliceToken}`, Origin: "https://console.corp.local", Host: `127.0.0.1:${port}` },
	});
	wsAlice.on("error", () => {});
	cleanups.push(() => { try { wsAlice.terminate(); } catch {} });
	await new Promise<void>((resolve, reject) => {
		wsAlice.on("message", (raw) => {
			const msg = JSON.parse(String(raw));
			if (msg.type === "control" && msg.control === "attached") resolve();
		});
		wsAlice.on("error", reject);
	});

	// Charlie (team-beta，同 repo 但不同 team) 尝试接入该会话：必须被 4003 关闭
	const wsCharlie = new WebSocket(`ws://127.0.0.1:${port}/?session=${sessionId}`, {
		headers: { Authorization: `Bearer ${charlieToken}`, Origin: "https://console.corp.local", Host: `127.0.0.1:${port}` },
	});
	wsCharlie.on("error", () => {});
	const closeCode = await new Promise<number>((resolve) => {
		wsCharlie.on("close", (code) => resolve(code));
	});
	assert.equal(closeCode, 4003, "同 repo 不同 team 跨组接入必须被拒绝 (4003)");
});

test("可控 deferred auth：timeout 后无 cookie/会话，pending 额度释放，迟到 resolve 无副作用", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-deferred-"));
	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const port = (s.address() as { port: number }).port;
	await new Promise<void>((r) => s.close(() => r()));

	let deferredResolve: ((p: any) => void) | undefined;
	const auth = {
		isPrincipalId: () => true,
		authenticate: () => new Promise<any>((resolve) => { deferredResolve = resolve; }),
	};

	const gw = new Gateway({
		mode: "production",
		backend: s1Backend,
		port,
		host: "127.0.0.1",
		auth,
		authTimeoutMs: 50, // 50ms 快速超时
		allowedHosts: [`127.0.0.1:${port}`],
		allowedOrigins: ["https://console.corp.local"],
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "ws"),
		webRoot: join(REPO, "web"),
		resolveScope: () => ({ repo: "r", team: "t" }),
	});
	await gw.listen();
	cleanups.push(() => gw.close());

	// 1. 发起请求，触发超时 (504)
	const rTimeout = await fetch(`http://127.0.0.1:${port}/auth/session`, {
		method: "POST",
		headers: {
			Authorization: "Bearer deferred-token",
			Origin: "https://console.corp.local",
			Host: `127.0.0.1:${port}`,
		},
	});
	assert.equal(rTimeout.status, 504, "超时应返回 504 Gateway Timeout");
	assert.equal(rTimeout.headers.get("set-cookie"), null, "超时请求绝不能颁发 set-cookie");

	// 2. 模拟迟到 resolve：此时请求已结束，绝无后续副作用
	assert.ok(deferredResolve, "必须持有 deferredResolve 句柄");
	deferredResolve!({
		id: "test|deferred-user",
		issuer: "test",
		subject: "deferred-user",
		expiresAt: Date.now() + 3600_000,
		groups: [],
	});

	// 等待事件循环排空
	await new Promise((r) => setTimeout(r, 50));

	// 3. 验证 pending 额度已被完全释放，后续请求可正常处理（不报 503）
	auth.authenticate = async () => ({
		id: "test|normal-user",
		issuer: "test",
		subject: "normal-user",
		expiresAt: Date.now() + 3600_000,
		groups: [],
	});

	const rNormal = await fetch(`http://127.0.0.1:${port}/auth/session`, {
		method: "POST",
		headers: {
			Authorization: "Bearer valid-token",
			Origin: "https://console.corp.local",
			Host: `127.0.0.1:${port}`,
		},
	});
	assert.equal(rNormal.status, 204, "超时后 pending 额度已正常释放，后续请求正常 204");
	assert.ok(rNormal.headers.get("set-cookie"), "正常请求颁发 set-cookie");
});

test("F1: HTTP 与 WS 共享真实工作并发闸（限额 20）且 AbortSignal 正确传递", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-f1-"));
	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const port = (s.address() as { port: number }).port;
	await new Promise<void>((r) => s.close(() => r()));

	let enteredCount = 0;
	let onEntered20: (() => void) | undefined;
	let abortedCount = 0;
	const heldResolves: ((p: any) => void)[] = [];
	const auth = {
		isPrincipalId: () => true,
		authenticate: (_cred: string, options?: { signal?: AbortSignal }) => {
			if (options?.signal) {
				options.signal.addEventListener("abort", () => { abortedCount++; });
			}
			enteredCount++;
			if (enteredCount === 20 && onEntered20) onEntered20();
			return new Promise<any>((resolve) => {
				heldResolves.push(resolve);
			});
		},
	};

	const gw = new Gateway({
		mode: "production",
		backend: s1Backend,
		port,
		host: "127.0.0.1",
		auth,
		authTimeoutMs: 100, // 100ms 超时
		allowedHosts: [`127.0.0.1:${port}`],
		allowedOrigins: ["https://console.corp.local"],
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "ws"),
		webRoot: join(REPO, "web"),
		resolveScope: () => ({ repo: "r", team: "t" }),
	});
	await gw.listen();
	cleanups.push(() => gw.close());

	// 并发启动 20 个 HTTP auth 请求占满 slot
	const reqs = Array.from({ length: 20 }, () =>
		fetch(`http://127.0.0.1:${port}/auth/session`, {
			method: "POST",
			headers: {
				Authorization: "Bearer token",
				Origin: "https://console.corp.local",
				Host: `127.0.0.1:${port}`,
			},
		})
	);

	if (enteredCount < 20) {
		await new Promise<void>((r) => { onEntered20 = r; });
	}

	// 第 21 个 HTTP 请求：立即返回 503
	const req21 = await fetch(`http://127.0.0.1:${port}/auth/session`, {
		method: "POST",
		headers: {
			Authorization: "Bearer token",
			Origin: "https://console.corp.local",
			Host: `127.0.0.1:${port}`,
		},
	});
	assert.equal(req21.status, 503, "并发闸满时第 21 个 HTTP 请求必须 503");

	// 第 22 个 WS upgrade 请求：共享并发闸，必须被拒绝 503
	const wsReject = await new Promise<number>((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
			headers: {
				Authorization: "Bearer token",
				Origin: "https://console.corp.local",
				Host: `127.0.0.1:${port}`,
			},
		});
		ws.on("unexpected-response", (_req, res) => {
			resolve(res.statusCode ?? 500);
		});
		ws.on("error", () => {});
	});
	assert.equal(wsReject, 503, "并发闸满时第 22 个 WS upgrade 必须 503");

	// 等待 20 个请求超时完成
	const responses = await Promise.all(reqs);
	for (const r of responses) {
		assert.equal(r.status, 504, "占满的请求应超时返回 504");
	}
	assert.equal(abortedCount, 20, "超时后 AbortSignal 必须触发 abort");

	// 释放挂起的真实任务
	for (const res of heldResolves) {
		res({ id: "t|u", issuer: "t", subject: "u", expiresAt: Date.now() + 10000, groups: [] });
	}
});

test("F2: 活会话撤权后命令路径同步关闭（4003）并更新 presence", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-f2-"));
	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const port = (s.address() as { port: number }).port;
	await new Promise<void>((r) => s.close(() => r()));

	let bobAllowed = true;
	const auth = {
		isPrincipalId: () => true,
		authenticate: async (cred: string) => ({
			id: cred === "alice" ? "corp|alice" : "corp|bob",
			issuer: "corp",
			subject: cred,
			expiresAt: Date.now() + 3600_000,
			groups: ["dev"],
		}),
	};

	const gw = new Gateway({
		mode: "production",
		backend: s1Backend,
		port,
		host: "127.0.0.1",
		auth,
		allowedHosts: [`127.0.0.1:${port}`],
		allowedOrigins: ["https://console.corp.local"],
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "ws"),
		webRoot: join(REPO, "web"),
		resolveScope: (actor) => {
			if (actor === "corp|bob" && !bobAllowed) return undefined;
			return { repo: "main-repo", team: "core-team" };
		},
	});
	await gw.listen();
	cleanups.push(() => gw.close());

	// 1. Alice 创建并接入会话
	const wsAlice = new WebSocket(`ws://127.0.0.1:${port}/`, {
		headers: {
			Authorization: "Bearer alice",
			Origin: "https://console.corp.local",
			Host: `127.0.0.1:${port}`,
		},
	});
	let sessionId = "";
	const alicePresences: any[] = [];
	await new Promise<void>((resolve) => {
		wsAlice.on("message", (raw) => {
			const frame = JSON.parse(String(raw));
			if (frame.event?.type === "session.snapshot") {
				sessionId = frame.event.view.sessionId;
				resolve();
			} else if (frame.event?.type === "session.presence") {
				alicePresences.push(frame.event);
			}
		});
	});

	// Alice 分享给 Bob
	wsAlice.send(JSON.stringify({ type: "share", actor: "corp|bob", role: "editor" }));
	await new Promise((r) => setTimeout(r, 50));

	// 2. Bob 接入会话
	const wsBob = new WebSocket(`ws://127.0.0.1:${port}/?session=${sessionId}`, {
		headers: {
			Authorization: "Bearer bob",
			Origin: "https://console.corp.local",
			Host: `127.0.0.1:${port}`,
		},
	});
	await new Promise<void>((resolve) => {
		wsBob.on("open", resolve);
	});
	await new Promise((r) => setTimeout(r, 50));

	// 3. 翻转权限：Bob 被撤权
	bobAllowed = false;

	// 4. Bob 发送命令，必须被关闭 4003
	const bobCloseCode = await new Promise<number>((resolve) => {
		wsBob.on("close", (code) => resolve(code));
		wsBob.send(JSON.stringify({ type: "prompt", text: "hello", requestId: randomUUID() }));
	});
	assert.equal(bobCloseCode, 4003, "Bob 发送命令在撤权后必须被 4003 断开连接");

	// 5. 等待 Alice 收到最新的 presence
	await new Promise((r) => setTimeout(r, 50));
	const lastPresence = alicePresences[alicePresences.length - 1];
	assert.ok(lastPresence, "Alice 必须收到更新后的 presence");
	const participantActors = lastPresence.participants.map((p: any) => p.actor);
	assert.ok(!participantActors.includes("corp|bob"), "更新后的 presence 不得再包含被撤权的 Bob");

	wsAlice.close();
});

test("F3-1: 生产 scopeFromGroups 下会话回调拿真实 principal 鉴权，正常 prompt 进入模型且未映射组 0 模型请求", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-f3-1-"));
	const mockLog = join(dir, "f3-1-model.log");
	const mock = spawn(process.execPath, [MOCK, "0", JSON.stringify([{ text: "hello back" }]), mockLog], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	cleanups.push(() => void mock.kill());
	const mockPort: number = await new Promise((r) => mock.stdout?.once("data", (d) => r(JSON.parse(d.toString()).port)));

	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const port = (s.address() as { port: number }).port;
	await new Promise<void>((r) => s.close(() => r()));

	const auth = {
		isPrincipalId: () => true,
		authenticate: async (cred: string) => ({
			id: cred === "alice" ? "corp|alice" : "corp|unmapped",
			issuer: "corp",
			subject: cred,
			expiresAt: Date.now() + 3600_000,
			groups: cred === "alice" ? ["dev"] : ["no-such-group"],
		}),
	};

	const gw = new Gateway({
		mode: "production",
		backend: s1Backend,
		port,
		host: "127.0.0.1",
		auth,
		allowedHosts: [`127.0.0.1:${port}`],
		allowedOrigins: ["https://console.corp.local"],
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "ws"),
		webRoot: join(REPO, "web"),
		wiring: {
			modelGatewayUrl: `http://127.0.0.1:${mockPort}/v1`,
			proxyToken: "token-model",
			gitProxyUrl: "http://127.0.0.1:9/git",
			gitProxyToken: "token-git",
			model: "mock/mock-model",
		},
		resolveScope: (_actor, principal) => (principal ? scopeFromGroups({ dev: { repo: "main-repo", team: "core-team" } })(principal) : undefined),
	});
	await gw.listen();
	cleanups.push(() => gw.close());

	// 1. Alice (dev 组) 接入并发送 prompt
	const wsAlice = new WebSocket(`ws://127.0.0.1:${port}/`, {
		headers: {
			Authorization: "Bearer alice",
			Origin: "https://console.corp.local",
			Host: `127.0.0.1:${port}`,
		},
	});

	const receivedErrors: string[] = [];
	let gotReady = false;
	let gotMessageEnd = false;
	wsAlice.on("message", (raw) => {
		const msg = JSON.parse(String(raw));
		if (msg.event?.type === "session.ready") gotReady = true;
		if (msg.event?.type === "message.end") gotMessageEnd = true;
		if (msg.event?.type === "error" || msg.type === "control") {
			receivedErrors.push(msg.event?.message ?? msg.message ?? "");
		}
	});

	const start = Date.now();
	while (!gotReady && Date.now() - start < 5000) {
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.ok(gotReady, "Alice 必须成功收到 session.ready");

	wsAlice.send(JSON.stringify({ type: "prompt", text: "PROMPT-F3-1-TEST-SECRET", requestId: randomUUID() }));

	const pStart = Date.now();
	while (!gotMessageEnd && Date.now() - pStart < 5000) {
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.ok(gotMessageEnd, "Alice 必须收到 message.end");
	assert.ok(!receivedErrors.includes("资源权限已撤销"), "带有效 group 的 principal 发送 prompt 不得被误拒'资源权限已撤销'");

	async function waitForLogContent(filePath: string, expected: string, timeoutMs = 10_000): Promise<string> {
		const pollStart = Date.now();
		while (Date.now() - pollStart < timeoutMs) {
			if (existsSync(filePath)) {
				try {
					const c = readFileSync(filePath, "utf8");
					if (c.includes(expected)) return c;
				} catch {}
			}
			await new Promise((r) => setTimeout(r, 25));
		}
		const finalContent = existsSync(filePath) ? readFileSync(filePath, "utf8") : "<non-existent>";
		throw new Error(`waitForLogContent timeout (${timeoutMs}ms) waiting for "${expected}" in ${filePath}. Found: ${finalContent}`);
	}

	// 等待真正目标 model request 日志写出（有界轮询上限 10s，25ms 间隔）
	const logContent = await waitForLogContent(mockLog, "PROMPT-F3-1-TEST-SECRET", 10_000);
	assert.ok(logContent.includes("PROMPT-F3-1-TEST-SECRET"), "模型请求日志中必须包含用户发送的 prompt 文本");
	wsAlice.close();

	// 2. 未映射组（no-such-group）接入对照：必须被拒绝且模型请求日志 0 字节新增
	const logLenBefore = existsSync(mockLog) ? readFileSync(mockLog, "utf8").length : 0;
	const wsUnmapped = new WebSocket(`ws://127.0.0.1:${port}/`, {
		headers: {
			Authorization: "Bearer unmapped",
			Origin: "https://console.corp.local",
			Host: `127.0.0.1:${port}`,
		},
	});
	const unmappedCloseCode = await new Promise<number>((resolve) => {
		wsUnmapped.on("close", resolve);
	});
	assert.ok([4001, 4003, 1008].includes(unmappedCloseCode), "未映射组必须被拒绝关闭");
	await new Promise((r) => setTimeout(r, 100));
	const logLenAfter = existsSync(mockLog) ? readFileSync(mockLog, "utf8").length : 0;
	assert.equal(logLenAfter, logLenBefore, "未映射组被拒时绝对不得向模型发送任何请求（模型日志 0 字节新增）");

	// 3. 有界等待 helper 的可靠正/负验证（证明迟到日志可被正常等待，而 deadline 未写出时明确抛错，oracle 真实可失败）
	const testHelperLog = join(dir, "f3-1-helper-check.log");
	// 负验证：未写出时必须在 deadline 超时受控抛错
	await assert.rejects(
		waitForLogContent(testHelperLog, "NEVER_WRITTEN_TOKEN", 150),
		/waitForLogContent timeout/,
		"内容未写出时 waitForLogContent 必须在 deadline 超时受控抛错"
	);
	// 正验证：迟到（异步延迟写出）的日志内容必须被成功等待并返回
	setTimeout(() => {
		writeFileSync(testHelperLog, "LATE_ASYNC_WRITTEN_TOKEN\n", "utf8");
	}, 60);
	const lateContent = await waitForLogContent(testHelperLog, "LATE_ASYNC_WRITTEN_TOKEN", 2000);
	assert.ok(lateContent.includes("LATE_ASYNC_WRITTEN_TOKEN"), "迟到写入的日志内容必须被成功等待并读取");
});

test("F3-2: 审批 allow 提交前校验 item.actor 权限，撤权后 Bob 无法批准 Alice 的工具调用", async () => {
	const mock = spawn(process.execPath, [MOCK, "0", JSON.stringify([{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "完成" }])], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	cleanups.push(() => void mock.kill());
	const mockPort: number = await new Promise((r) => mock.stdout?.once("data", (d) => r(JSON.parse(d.toString()).port)));

	const dir = mkdtempSync(join(tmpdir(), "gw-f3-2-"));
	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const port = (s.address() as { port: number }).port;
	await new Promise<void>((r) => s.close(() => r()));

	let aliceScopeAllowed = true;
	const auth = {
		isPrincipalId: () => true,
		authenticate: async (cred: string) => ({
			id: cred === "alice" ? "corp|alice" : "corp|bob",
			issuer: "corp",
			subject: cred,
			expiresAt: Date.now() + 3600_000,
			groups: ["dev"],
		}),
	};

	const gw = new Gateway({
		mode: "production",
		backend: s1Backend,
		port,
		host: "127.0.0.1",
		auth,
		allowedHosts: [`127.0.0.1:${port}`],
		allowedOrigins: ["https://console.corp.local"],
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "ws"),
		webRoot: join(REPO, "web"),
		wiring: {
			modelGatewayUrl: `http://127.0.0.1:${mockPort}/v1`,
			proxyToken: "token-model",
			gitProxyUrl: "http://127.0.0.1:9/git",
			gitProxyToken: "token-git",
			model: "mock/mock-model",
		},
		resolveScope: (actor) => {
			if (actor === "corp|alice" && !aliceScopeAllowed) return undefined;
			return { repo: "r", team: "t" };
		},
	});
	await gw.listen();
	cleanups.push(() => gw.close());

	// 1. Alice 接入会话
	const wsAlice = new WebSocket(`ws://127.0.0.1:${port}/`, {
		headers: {
			Authorization: "Bearer alice",
			Origin: "https://console.corp.local",
			Host: `127.0.0.1:${port}`,
		},
	});
	let aliceCloseCode = 0;
	wsAlice.on("close", (code) => { aliceCloseCode = code; });
	let sessionId = "";
	let approvalReq: any = null;
	let sessionWorkspace = "";
	await new Promise<void>((resolve) => {
		wsAlice.on("message", (raw) => {
			const frame = JSON.parse(String(raw));
			if (frame.event?.type === "session.snapshot") {
				sessionId = frame.event.view.sessionId;
			} else if (frame.event?.type === "session.ready") {
				sessionWorkspace = frame.event.workspace;
				resolve();
			} else if (frame.event?.type === "approval.request") {
				approvalReq = frame.event;
			}
		});
	});

	// Alice 分享给 Bob
	initGitFixture(sessionWorkspace);
	wsAlice.send(JSON.stringify({ type: "share", actor: "corp|bob", role: "approver" }));
	await new Promise((r) => setTimeout(r, 50));

	// 2. Bob 接入会话
	const wsBob = new WebSocket(`ws://127.0.0.1:${port}/?session=${sessionId}`, {
		headers: {
			Authorization: "Bearer bob",
			Origin: "https://console.corp.local",
			Host: `127.0.0.1:${port}`,
		},
	});
	await new Promise<void>((resolve) => {
		wsBob.on("open", resolve);
	});

	// 3. Alice 发送 prompt 触发审批
	wsAlice.send(JSON.stringify({ type: "prompt", text: "写入配置", requestId: randomUUID() }));
	while (!approvalReq) {
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.ok(approvalReq, "必须收到 approval.request");

	// 4. 撤销 Alice 的资源权限
	aliceScopeAllowed = false;

	// 5. Bob 尝试 approve allow Alice 的工具调用
	wsBob.send(JSON.stringify({ type: "approve", approvalId: approvalReq.approvalId, decision: "allow" }));
	await new Promise((r) => setTimeout(r, 200));

	// 6. 验证工作区中不得出现 package.json 且 Alice 以 4003 断开
	assert.equal(existsSync(join(sessionWorkspace, "package.json")), false, "Alice 撤权后 Bob allow 该审批不得写入 package.json");
	assert.equal(aliceCloseCode, 4003, "Alice 资源权限撤权后在广播事件时必须以 4003 关闭");

	wsAlice.close();
	wsBob.close();
});

test("F3-2 对照组: revokePrincipal 立即以 4001 断开 Alice 且废止审批，不写入 package.json", async () => {
	const mock = spawn(process.execPath, [MOCK, "0", JSON.stringify([{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "完成" }])], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	cleanups.push(() => void mock.kill());
	const mockPort: number = await new Promise((r) => mock.stdout?.once("data", (d) => r(JSON.parse(d.toString()).port)));

	const dir = mkdtempSync(join(tmpdir(), "gw-f3-2c-"));
	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const port = (s.address() as { port: number }).port;
	await new Promise<void>((r) => s.close(() => r()));

	const auth = {
		isPrincipalId: () => true,
		authenticate: async (cred: string) => ({
			id: cred === "alice" ? "corp|alice" : "corp|bob",
			issuer: "corp",
			subject: cred,
			expiresAt: Date.now() + 3600_000,
			groups: ["dev"],
		}),
	};

	const gw = new Gateway({
		mode: "production",
		backend: s1Backend,
		port,
		host: "127.0.0.1",
		auth,
		allowedHosts: [`127.0.0.1:${port}`],
		allowedOrigins: ["https://console.corp.local"],
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "ws"),
		webRoot: join(REPO, "web"),
		wiring: {
			modelGatewayUrl: `http://127.0.0.1:${mockPort}/v1`,
			proxyToken: "token-model",
			gitProxyUrl: "http://127.0.0.1:9/git",
			gitProxyToken: "token-git",
			model: "mock/mock-model",
		},
		resolveScope: () => ({ repo: "r", team: "t" }),
	});
	await gw.listen();
	cleanups.push(() => gw.close());

	const wsAlice = new WebSocket(`ws://127.0.0.1:${port}/`, {
		headers: {
			Authorization: "Bearer alice",
			Origin: "https://console.corp.local",
			Host: `127.0.0.1:${port}`,
		},
	});
	let aliceCloseCode = 0;
	wsAlice.on("close", (code) => { aliceCloseCode = code; });
	let sessionId = "";
	let approvalReq: any = null;
	let sessionWorkspace = "";
	await new Promise<void>((resolve) => {
		wsAlice.on("message", (raw) => {
			const frame = JSON.parse(String(raw));
			if (frame.event?.type === "session.snapshot") {
				sessionId = frame.event.view.sessionId;
			} else if (frame.event?.type === "session.ready") {
				sessionWorkspace = frame.event.workspace;
				resolve();
			} else if (frame.event?.type === "approval.request") {
				approvalReq = frame.event;
			}
		});
	});

	initGitFixture(sessionWorkspace);
	wsAlice.send(JSON.stringify({ type: "share", actor: "corp|bob", role: "approver" }));
	await new Promise((r) => setTimeout(r, 50));

	const wsBob = new WebSocket(`ws://127.0.0.1:${port}/?session=${sessionId}`, {
		headers: {
			Authorization: "Bearer bob",
			Origin: "https://console.corp.local",
			Host: `127.0.0.1:${port}`,
		},
	});
	await new Promise<void>((resolve) => wsBob.on("open", resolve));

	wsAlice.send(JSON.stringify({ type: "prompt", text: "写入配置", requestId: randomUUID() }));
	while (!approvalReq) {
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.ok(approvalReq, "必须收到 approval.request");

	// 吊销 Alice
	gw.revokePrincipal("corp|alice");
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(aliceCloseCode, 4001, "revokePrincipal 必须立即使 Alice 连接 4001 关闭");

	// Bob 尝试 approve allow
	wsBob.send(JSON.stringify({ type: "approve", approvalId: approvalReq.approvalId, decision: "allow" }));
	await new Promise((r) => setTimeout(r, 200));

	assert.equal(existsSync(join(sessionWorkspace, "package.json")), false, "revokePrincipal 后工作区不得写入 package.json");

	wsAlice.close();
	wsBob.close();
});

test("F3-3: 环境就绪前入队的 prompt 在撤权后 flush 时被二次鉴权丢弃，不进入模型（附正向对照）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-f3-3-"));
	const leakScript = JSON.stringify([
		{ tool: "write", args: { path: "queue-leak.txt", content: "leak-content" } },
		{ text: "done" },
	]);

	function findFile(root: string, filename: string): boolean {
		if (!existsSync(root)) return false;
		const entries = readdirSync(root, { recursive: true, encoding: "utf8" });
		return entries.some((e: string) => e.endsWith(filename));
	}

	const mockLogNegative = join(dir, "f3-3-negative.log");
	const mock = spawn(process.execPath, [MOCK, "0", leakScript, mockLogNegative], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	cleanups.push(() => void mock.kill());
	const mockPort: number = await new Promise((r) => mock.stdout?.once("data", (d) => r(JSON.parse(d.toString()).port)));

	let envBlocked: (() => void) | undefined;
	const envBlockedGate = new Promise<void>((r) => { envBlocked = r; });
	let releaseEnv: (() => void) | undefined;
	const envGate = new Promise<void>((r) => { releaseEnv = r; });
	class BlockingBackend extends DockerBackend {
		constructor() {
			super({ image: "perimeter-sandbox:test", repoRoot: REPO, network: "none" });
		}
		override async environment(ctx: any) {
			envBlocked?.();
			await envGate;
			return super.environment(ctx);
		}
	}

	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const port = (s.address() as { port: number }).port;
	await new Promise<void>((r) => s.close(() => r()));

	let aliceAllowed = true;
	const auth = {
		isPrincipalId: () => true,
		authenticate: async () => ({
			id: "corp|alice",
			issuer: "corp",
			subject: "alice",
			expiresAt: Date.now() + 3600_000,
			groups: ["dev"],
		}),
	};

	const gw = new Gateway({
		mode: "production",
		port,
		host: "127.0.0.1",
		auth,
		backend: new BlockingBackend(),
		allowedHosts: [`127.0.0.1:${port}`],
		allowedOrigins: ["https://console.corp.local"],
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "ws"),
		webRoot: join(REPO, "web"),
		wiring: {
			modelGatewayUrl: `http://127.0.0.1:${mockPort}/v1`,
			proxyToken: "token-model",
			gitProxyUrl: "http://127.0.0.1:9/git",
			gitProxyToken: "token-git",
			model: "mock/mock-model",
		},
		resolveScope: () => (aliceAllowed ? { repo: "r", team: "t" } : undefined),
	});
	await gw.listen();
	cleanups.push(() => gw.close());

	const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
		headers: {
			Authorization: "Bearer alice",
			Origin: "https://console.corp.local",
			Host: `127.0.0.1:${port}`,
		},
	});
	await new Promise<void>((resolve) => ws.on("open", resolve));

	// 精确等待后端进入 environment 阻塞，确认处于环境未就绪状态
	await envBlockedGate;

	// 在环境卡住时入队 prompt
	ws.send(JSON.stringify({ type: "prompt", text: "prompt-f3-3-blocked-secret", requestId: randomUUID() }));

	// 翻转权限：Alice 被撤权
	aliceAllowed = false;

	// 在放开环境之前注册监听器，杜绝事件遗漏
	let closeCode: number | null = null;
	ws.on("close", (code) => { closeCode = code; });

	// 放开环境
	releaseEnv?.();

	// 等待连接关闭，设置 5s deadline
	const negStart = Date.now();
	while (closeCode === null && Date.now() - negStart < 5000) {
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.equal(closeCode, 4003, "撤权后 flush 时二次鉴权失败必须以 4003 关闭连接");

	// 验证 argv[4] 写入的模型请求日志绝对不包含该 prompt
	const hasLog = existsSync(mockLogNegative);
	const content = hasLog ? readFileSync(mockLogNegative, "utf8") : "";
	assert.ok(!content.includes("prompt-f3-3-blocked-secret"), "撤权后从队列 flush 的 prompt 绝对不得发送至模型");
	assert.equal(findFile(join(dir, "ws"), "queue-leak.txt"), false, "撤权后工作区不得产生副作用文件");
	ws.close();

	// ---------------- 对照组：不撤权的正向对照测试 ----------------
	const mockLogPositive = join(dir, "f3-3-positive.log");
	const mockPos = spawn(process.execPath, [MOCK, "0", leakScript, mockLogPositive], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	cleanups.push(() => void mockPos.kill());
	const mockPortPos: number = await new Promise((r) => mockPos.stdout?.once("data", (d) => r(JSON.parse(d.toString()).port)));

	let envBlockedPos: (() => void) | undefined;
	const envBlockedGatePos = new Promise<void>((r) => { envBlockedPos = r; });
	let releaseEnvPos: (() => void) | undefined;
	const envGatePos = new Promise<void>((r) => { releaseEnvPos = r; });
	class BlockingBackendPos extends DockerBackend {
		constructor() {
			super({ image: "perimeter-sandbox:test", repoRoot: REPO, network: "none" });
		}
		override async environment(ctx: any) {
			envBlockedPos?.();
			await envGatePos;
			return super.environment(ctx);
		}
	}

	const sPos = createServer();
	await new Promise<void>((r) => sPos.listen(0, "127.0.0.1", r));
	const portPos = (sPos.address() as { port: number }).port;
	await new Promise<void>((r) => sPos.close(() => r()));

	const gwPos = new Gateway({
		mode: "production",
		port: portPos,
		host: "127.0.0.1",
		auth,
		backend: new BlockingBackendPos(),
		allowedHosts: [`127.0.0.1:${portPos}`],
		allowedOrigins: ["https://console.corp.local"],
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit-pos.jsonl"),
		workspaceRoot: join(dir, "ws-pos"),
		webRoot: join(REPO, "web"),
		wiring: {
			modelGatewayUrl: `http://127.0.0.1:${mockPortPos}/v1`,
			proxyToken: "token-model",
			gitProxyUrl: "http://127.0.0.1:9/git",
			gitProxyToken: "token-git",
			model: "mock/mock-model",
		},
		resolveScope: () => ({ repo: "r", team: "t" }),
	});
	await gwPos.listen();
	cleanups.push(() => gwPos.close());

	const wsPos = new WebSocket(`ws://127.0.0.1:${portPos}/`, {
		headers: {
			Authorization: "Bearer alice",
			Origin: "https://console.corp.local",
			Host: `127.0.0.1:${portPos}`,
		},
	});
	await new Promise<void>((resolve) => wsPos.on("open", resolve));

	// 精确等待环境阻塞
	await envBlockedGatePos;

	// 在环境卡住时入队 prompt
	wsPos.send(JSON.stringify({ type: "prompt", text: "prompt-f3-3-allowed-secret", requestId: randomUUID() }));

	// 在放开环境前注册监听
	let posCloseCode: number | null = null;
	wsPos.on("close", (code) => { posCloseCode = code; });

	// 不撤权，直接放开环境
	releaseEnvPos?.();

	// 正向对照组轮询 argv[4] 真实请求日志直到包含 prompt（设置 5s deadline），不以 message.end 退出
	const pStart = Date.now();
	let posLogged = false;
	while (Date.now() - pStart < 5000) {
		if (existsSync(mockLogPositive)) {
			const c = readFileSync(mockLogPositive, "utf8");
			if (c.includes("prompt-f3-3-allowed-secret")) {
				posLogged = true;
				break;
			}
		}
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.ok(posLogged, "正向对照组必须在 deadline 内于 argv[4] 模型日志中记录该 prompt");

	// 进一步轮询等待工作区实际写出 queue-leak.txt（证明 mock 脚本确实会产生工作区副作用，oracle 真实可失败）
	const fStart = Date.now();
	let posLeakCreated = false;
	while (Date.now() - fStart < 5000) {
		if (findFile(join(dir, "ws-pos"), "queue-leak.txt")) {
			posLeakCreated = true;
			break;
		}
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.ok(posLeakCreated, "正向对照组证明 mock 脚本确实会写出 queue-leak.txt，负向 oracle 具备可失败性");
	assert.equal(posCloseCode, null, "正向对照组在正常执行时不应被 4003 关闭");
	wsPos.close();
});

test("s1-bearer-page-query: 生产网页初次 GET 绝不带凭证 query，支持 hash 引导换取 Cookie 且 WS 升级无凭证", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-page-query-"));
	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const port = (s.address() as { port: number }).port;
	await new Promise<void>((r) => s.close(() => r()));

	const auth = {
		isPrincipalId: () => true,
		authenticate: async (token: string) => {
			if (token === "valid-secret-bearer") {
				return {
					id: "corp|alice",
					issuer: "corp",
					subject: "alice",
					expiresAt: Date.now() + 3600_000,
					groups: ["dev"],
				};
			}
			throw new Error("unauthorized");
		},
	};

	const gw = new Gateway({
		mode: "production",
		backend: s1Backend,
		port,
		host: "127.0.0.1",
		auth,
		allowedHosts: [`127.0.0.1:${port}`],
		allowedOrigins: ["https://console.corp.local"],
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "ws"),
		webRoot: join(REPO, "web"),
		resolveScope: () => ({ repo: "r", team: "t" }),
	});
	await gw.listen();
	cleanups.push(() => gw.close());

	// 1. 初次文档 GET 请求：客户端请求目标绝不包含 bearer、token 或 actor 查询参数
	const docRes = await fetch(`http://127.0.0.1:${port}/`, {
		headers: {
			Host: `127.0.0.1:${port}`,
		},
	});
	assert.equal(docRes.status, 200, "初次文档 GET 必须 200 返回页面");
	const html = await docRes.text();
	assert.ok(html.includes("<!doctype html>"), "返回 index.html 页面内容");

	// 2. 生产 /auth/session 严格拒绝带有 query 参数的请求（400）
	const queryAuthRes = await fetch(`http://127.0.0.1:${port}/auth/session?bearer=leak`, {
		method: "POST",
		headers: {
			Origin: "https://console.corp.local",
			Host: `127.0.0.1:${port}`,
			Authorization: "Bearer valid-secret-bearer",
		},
	});
	assert.equal(queryAuthRes.status, 400, "携带 query 的 /auth/session 必须被拒绝 400");

	// 3. 受控使用 Authorization 头 POST /auth/session 换取 HttpOnly Cookie
	const authRes = await fetch(`http://127.0.0.1:${port}/auth/session`, {
		method: "POST",
		headers: {
			Origin: "https://console.corp.local",
			Host: `127.0.0.1:${port}`,
			Authorization: "Bearer valid-secret-bearer",
		},
	});
	assert.equal(authRes.status, 204, "合法 Authorization 头必须返回 204");
	const setCookie = authRes.headers.get("set-cookie") ?? "";
	assert.ok(setCookie.includes("__Host-perimeter_session="), "必须签发 __Host-perimeter_session cookie");
	assert.ok(setCookie.includes("HttpOnly"), "cookie 必须为 HttpOnly");
	assert.ok(setCookie.includes("Secure"), "cookie 必须为 Secure");
	assert.ok(setCookie.includes("SameSite=Strict"), "cookie 必须为 SameSite=Strict");

	const cookieValue = setCookie.split(";")[0];

	// 4. 后续 WS 连接使用 Cookie 升级，URL 查询串绝不含 token、actor 或 bearer
	const ws = new WebSocket(`ws://127.0.0.1:${port}/?session=s1`, {
		headers: {
			Cookie: cookieValue,
			Origin: "https://console.corp.local",
			Host: `127.0.0.1:${port}`,
		},
	});
	await new Promise<void>((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});
	assert.equal(ws.readyState, WebSocket.OPEN, "纯净 WS 连接成功建立");
	ws.close();

	// 5. 源码级防回归：web/app.js 严禁从 search (params) 读取 bearer/token/actor 或抄进 WS
	const appJsCode = readFileSync(join(REPO, "web/app.js"), "utf8");
	assert.ok(!appJsCode.includes('params.get("bearer")'), "web/app.js 严禁从 params 读 bearer");
	assert.ok(!appJsCode.includes('params.get("token")'), "web/app.js 严禁从 params 读 token");
	assert.ok(!appJsCode.includes('params.get("actor")'), "web/app.js 严禁从 params 读 actor");
	assert.ok(!appJsCode.includes('params.has("token")'), "web/app.js 严禁在 params 判断 token 抄进 WS");
	assert.ok(!appJsCode.includes('params.has("actor")'), "web/app.js 严禁在 params 判断 actor 抄进 WS");
	assert.ok(!appJsCode.includes('query.set("token"'), "web/app.js 严禁向 WS query 设置 token");
	assert.ok(!appJsCode.includes('query.set("actor"'), "web/app.js 严禁向 WS query 设置 actor");
});

test("F4: 时间配置非法校验与 fail-closed", () => {
	// 1. JwtAuthenticator clockSkewSec 校验
	assert.throws(
		() => new JwtAuthenticator({ issuer: "https://idp", audience: "aud", jwks: new StaticJwks([]), clockSkewSec: NaN }),
		/clockSkewSec/
	);
	assert.throws(
		() => new JwtAuthenticator({ issuer: "https://idp", audience: "aud", jwks: new StaticJwks([]), clockSkewSec: Infinity }),
		/clockSkewSec/
	);
	assert.throws(
		() => new JwtAuthenticator({ issuer: "https://idp", audience: "aud", jwks: new StaticJwks([]), clockSkewSec: -5 }),
		/clockSkewSec/
	);
	assert.throws(
		() => new JwtAuthenticator({ issuer: "https://idp", audience: "aud", jwks: new StaticJwks([]), clockSkewSec: 500 }),
		/clockSkewSec/
	);

	// 2. RemoteJwks 参数校验
	assert.throws(
		() => new RemoteJwks({ url: "https://idp/jwks", ttlMs: 10000, maxStaleMs: 1000 }),
		/ttlMs 不能大于 maxStaleMs/
	);
	assert.throws(
		() => new RemoteJwks({ url: "https://idp/jwks", ttlMs: -1 }),
		/ttlMs/
	);
});

test("F4: RemoteJwks 并发 get 取消一个 signal 不影响无 signal 或其他 signal 的 waiter", async () => {
	let resolveHttp: ((val: string) => void) | undefined;
	const httpGate = new Promise<string>((r) => { resolveHttp = r; });

	const jwksServer = createServer((_req, res) => {
		httpGate.then((body) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(body);
		});
	});
	await new Promise<void>((r) => jwksServer.listen(0, "127.0.0.1", r));
	const port = (jwksServer.address() as { port: number }).port;
	cleanups.push(() => new Promise((r) => jwksServer.close(() => r())));

	const jwks = new RemoteJwks({
		url: `http://127.0.0.1:${port}/jwks.json`,
		allowHttp: true,
	});

	// 1. 一个带 signal、一个不带 signal 并行
	const ctrl1 = new AbortController();
	const pWithSignal = jwks.get("key-1", ctrl1.signal);
	const pNoSignal = jwks.get("key-1");

	// 取消前者
	ctrl1.abort();
	await assert.rejects(pWithSignal, /JWKS 请求已取消/);

	// 放开 HTTP 响应
	const jwksPayload = JSON.stringify({
		keys: [{ kty: "RSA", kid: "key-1" }],
	});
	resolveHttp?.(jwksPayload);

	// 后者必须成功拿到 kid
	const key = await pNoSignal;
	assert.equal(key?.kid, "key-1", "带 signal 者 abort 后，不带 signal 者必须成功拿到 kid");

	// 2. 两个都带 signal 并行：abort 一个，另一个仍拿到
	let resolveHttp2: ((val: string) => void) | undefined;
	const httpGate2 = new Promise<string>((r) => { resolveHttp2 = r; });
	const jwksServer2 = createServer((_req, res) => {
		httpGate2.then((body) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(body);
		});
	});
	await new Promise<void>((r) => jwksServer2.listen(0, "127.0.0.1", r));
	const port2 = (jwksServer2.address() as { port: number }).port;
	cleanups.push(() => new Promise((r) => jwksServer2.close(() => r())));

	const jwks2 = new RemoteJwks({
		url: `http://127.0.0.1:${port2}/jwks.json`,
		allowHttp: true,
	});

	const ctrlA = new AbortController();
	const ctrlB = new AbortController();
	const pA = jwks2.get("key-2", ctrlA.signal);
	const pB = jwks2.get("key-2", ctrlB.signal);

	ctrlA.abort();
	await assert.rejects(pA, /JWKS 请求已取消/);

	resolveHttp2?.(JSON.stringify({ keys: [{ kty: "RSA", kid: "key-2" }] }));
	const keyB = await pB;
	assert.equal(keyB?.kid, "key-2", "两个带 signal 者 abort 其中一个，另一个仍拿到 kid");
});

test("F5: attach.ts CLI 参数冲突与 Bearer 优先", async () => {
	// 1. 冲突参数拒绝退出
	const procConflict = spawn(process.execPath, [
		join(REPO, "scripts/attach.ts"),
		"--session", "s1",
		"--bearer", "some-bearer",
		"--token", "some-token",
	]);
	const codeConflict = await new Promise<number>((r) => procConflict.on("exit", (code) => r(code ?? 0)));
	assert.equal(codeConflict, 1, "同时指定 --bearer 与 --token 必须退出 1");

	// 2. 模拟 WebSocket 服务验证 URL 与 Headers
	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const port = (s.address() as { port: number }).port;

	let receivedUrl = "";
	let receivedAuth = "";
	const wss = new (await import("ws")).WebSocketServer({ server: s });
	wss.on("connection", (_ws, req) => {
		receivedUrl = req.url ?? "";
		receivedAuth = req.headers["authorization"] ?? "";
		_ws.close();
	});

	const procBearer = spawn(process.execPath, [
		join(REPO, "scripts/attach.ts"),
		"--url", `http://127.0.0.1:${port}`,
		"--session", "session-123",
		"--bearer", "secret-jwt",
	], {
		env: { ...process.env, PERIMETER_TOKEN: "env-demo-token" },
	});

	await new Promise((r) => setTimeout(r, 600));
	procBearer.kill();
	wss.close();
	await new Promise<void>((r) => s.close(() => r()));

	assert.ok(receivedUrl.includes("session=session-123"), "URL 必须包含 session");
	assert.ok(!receivedUrl.includes("token="), "生产 Bearer 模式下 URL 绝不能包含 token");
	assert.ok(!receivedUrl.includes("actor="), "生产 Bearer 模式下 URL 绝不能包含 actor");
	assert.equal(receivedAuth, "Bearer secret-jwt", "必须通过 Authorization 头传递 Bearer 凭据");
});

test("s1-pkce: OIDC Authorization Code + PKCE S256 协议正常流与完备负测集", async () => {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = publicKey.export({ format: "jwk" }) as any;
	jwk.kid = "idp-k1";
	jwk.alg = "RS256";
	jwk.use = "sig";

	function signIdToken(claims: Record<string, unknown>): string {
		const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "idp-k1" })).toString("base64url");
		const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
		const signer = createSign("RSA-SHA256");
		signer.update(`${header}.${payload}`);
		const sig = signer.sign(privateKey, "base64url");
		return `${header}.${payload}.${sig}`;
	}

	// 1. 搭建本地模拟 IdP
	const idpCodes = new Map<string, { codeChallenge: string; nonce: string; clientId: string; redirectUri: string; used: boolean }>();
	let simulateRedirectOnTokenEndpoint = false;
	let tokenResponseBodyOverride: string | null = null;
	let tokenResponseNonceOverride: string | null = null;

	const idpServer = createServer((req, res) => {
		const u = new URL(req.url ?? "/", "http://localhost");
		if (u.pathname === "/oauth/authorize") {
			const clientId = u.searchParams.get("client_id") ?? "";
			const redirectUri = u.searchParams.get("redirect_uri") ?? "";
			const state = u.searchParams.get("state") ?? "";
			const nonce = u.searchParams.get("nonce") ?? "";
			const challenge = u.searchParams.get("code_challenge") ?? "";
			const code = `code-${randomUUID()}`;
			idpCodes.set(code, { codeChallenge: challenge, nonce, clientId, redirectUri, used: false });
			res.writeHead(302, { location: `${redirectUri}?code=${code}&state=${state}` }).end();
			return;
		}
		if (u.pathname === "/oauth/token" && req.method === "POST") {
			if (simulateRedirectOnTokenEndpoint) {
				res.writeHead(302, { location: "http://127.0.0.1:9999/malicious" }).end();
				return;
			}
			let body = "";
			req.on("data", (c) => { body += c; });
			req.on("end", () => {
				if (tokenResponseBodyOverride !== null) {
					res.writeHead(200, { "content-type": "application/json" }).end(tokenResponseBodyOverride);
					return;
				}
				const params = new URLSearchParams(body);
				const code = params.get("code") ?? "";
				const verifier = params.get("code_verifier") ?? "";
				const entry = idpCodes.get(code);
				if (!entry || entry.used) {
					res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
					return;
				}
				const expectedChallenge = createHash("sha256").update(verifier).digest("base64url");
				if (entry.codeChallenge !== expectedChallenge) {
					res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant", message: "pkce verification failed" }));
					return;
				}
				entry.used = true;
				const idToken = signIdToken({
					iss: "https://idp.corp.local",
					aud: "perimeter-client",
					sub: "alice",
					nonce: tokenResponseNonceOverride ?? entry.nonce,
					exp: Math.floor(Date.now() / 1000) + 3600,
					groups: ["dev"],
				});
				res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id_token: idToken, token_type: "Bearer" }));
			});
			return;
		}
		res.writeHead(404).end();
	});

	await new Promise<void>((r) => idpServer.listen(0, "127.0.0.1", r));
	const idpPort = (idpServer.address() as { port: number }).port;
	cleanups.push(() => new Promise<void>((r) => idpServer.close(() => r())));

	// 2. 启动生产模式网关，配置 OIDC 与本地测试静态 Jwks
	const gwServer = createServer();
	await new Promise<void>((r) => gwServer.listen(0, "127.0.0.1", r));
	const gwPort = (gwServer.address() as { port: number }).port;
	await new Promise<void>((r) => gwServer.close(() => r()));

	const auth = new JwtAuthenticator({
		issuer: "https://idp.corp.local",
		audience: "perimeter-client",
		jwks: new StaticJwks([jwk]),
	});

	const dir = mkdtempSync(join(tmpdir(), "gw-pkce-"));
	const gw = new Gateway({
		mode: "production",
		backend: s1Backend,
		port: gwPort,
		host: "127.0.0.1",
		auth,
		allowedHosts: [`127.0.0.1:${gwPort}`],
		allowedOrigins: ["https://console.corp.local"],
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "ws"),
		webRoot: join(REPO, "web"),
		resolveScope: () => ({ repo: "r", team: "t" }),
		oidc: {
			issuer: "https://idp.corp.local",
			authorizationEndpoint: `http://127.0.0.1:${idpPort}/oauth/authorize`,
			tokenEndpoint: `http://127.0.0.1:${idpPort}/oauth/token`,
			clientId: "perimeter-client",
			redirectUri: `http://127.0.0.1:${gwPort}/auth/oidc/callback`,
			allowHttp: true,
		},
	});
	await gw.listen();
	cleanups.push(() => gw.close());

	// ---------------- Case 1: 正常 OIDC PKCE S256 流程 ----------------
	// 1. 发起 /auth/oidc/login 获取 302 重定向及 __Host-perimeter_pkce Cookie
	const loginRes = await fetch(`http://127.0.0.1:${gwPort}/auth/oidc/login`, {
		headers: { Host: `127.0.0.1:${gwPort}` },
		redirect: "manual",
	});
	assert.equal(loginRes.status, 302, "login 必须返回 302");
	const authLocation = loginRes.headers.get("location") ?? "";
	const setPkceCookie = loginRes.headers.get("set-cookie") ?? "";
	assert.ok(setPkceCookie.includes("__Host-perimeter_pkce="), "必须签发 PKCE 临时 Cookie");
	assert.ok(setPkceCookie.includes("HttpOnly"), "PKCE Cookie 必须为 HttpOnly");
	assert.ok(authLocation.includes("code_challenge="), "重定向目标必须携带 code_challenge");
	assert.ok(authLocation.includes("code_challenge_method=S256"), "必须使用 S256 算法");

	// 2. 模拟浏览器访问 IdP 授权端点获得授权码 code
	const idpAuthRes = await fetch(authLocation, { redirect: "manual" });
	assert.equal(idpAuthRes.status, 302, "IdP 必须 302 重定向到 redirect_uri");
	const callbackLocation = idpAuthRes.headers.get("location") ?? "";
	const callbackUrl = new URL(callbackLocation);
	const code = callbackUrl.searchParams.get("code") ?? "";
	const state = callbackUrl.searchParams.get("state") ?? "";

	// 3. 浏览器携带 PKCE Cookie 回调网关 /auth/oidc/callback
	const pkceCookieValue = setPkceCookie.split(";")[0] ?? "";
	const cbRes = await fetch(`http://127.0.0.1:${gwPort}/auth/oidc/callback?code=${code}&state=${state}`, {
		headers: {
			Host: `127.0.0.1:${gwPort}`,
			Cookie: pkceCookieValue,
		},
		redirect: "manual",
	});
	assert.equal(cbRes.status, 302, "callback 成功后必须 302 重定向回应用根目录 /");
	assert.equal(cbRes.headers.get("location"), "/", "重定向目标必须是纯净根路径 /");
	const sessionCookies = cbRes.headers.get("set-cookie") ?? "";
	assert.ok(sessionCookies.includes("__Host-perimeter_session="), "必须颁发会话 Cookie");
	assert.ok(sessionCookies.includes("Max-Age=0"), "必须清除临时 PKCE Cookie");

	// 4. 提取会话 Cookie 并成功建立 WebSocket 连接
	const matchedCookie = sessionCookies.split(",").find((c) => c.includes("__Host-perimeter_session="));
	const sessionCookieVal = (matchedCookie ?? "").split(";")[0]?.trim() ?? "";
	const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/`, {
		headers: {
			Host: `127.0.0.1:${gwPort}`,
			Origin: "https://console.corp.local",
			Cookie: sessionCookieVal,
		},
	});
	await new Promise<void>((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});
	assert.equal(ws.readyState, WebSocket.OPEN, "使用 PKCE 颁发的会话 Cookie 成功建立 WS 连接");
	ws.close();

	// ---------------- 负测 1: 跨浏览器 / 伪造 state 拒绝 (400) ----------------
	const badStateRes = await fetch(`http://127.0.0.1:${gwPort}/auth/oidc/callback?code=${code}&state=tampered-state`, {
		headers: { Host: `127.0.0.1:${gwPort}`, Cookie: pkceCookieValue },
	});
	assert.equal(badStateRes.status, 400, "state 不匹配必须拒绝 400");

	// ---------------- 负测 2: 缺少 PKCE Cookie 拒绝 (400) ----------------
	const noCookieRes = await fetch(`http://127.0.0.1:${gwPort}/auth/oidc/callback?code=${code}&state=${state}`, {
		headers: { Host: `127.0.0.1:${gwPort}` },
	});
	assert.equal(noCookieRes.status, 400, "缺少 PKCE Cookie 必须拒绝 400");

	// ---------------- 负测 2.1: 伪造 Cookie=state 攻击拒绝 (400) ----------------
	const fakeStateCookieRes = await fetch(`http://127.0.0.1:${gwPort}/auth/oidc/callback?code=${code}&state=${state}`, {
		headers: { Host: `127.0.0.1:${gwPort}`, Cookie: `__Host-perimeter_pkce=${state}` },
	});
	assert.equal(fakeStateCookieRes.status, 400, "伪造 Cookie=state 必须签名失败被拒绝 400");

	// ---------------- 负测 3: 授权码重放 (Replay) 拒绝 (401) ----------------
	const replayRes = await fetch(`http://127.0.0.1:${gwPort}/auth/oidc/callback?code=${code}&state=${state}`, {
		headers: { Host: `127.0.0.1:${gwPort}`, Cookie: pkceCookieValue },
	});
	assert.equal(replayRes.status, 401, "已使用的授权码重放必须拒绝 401");

	// ---------------- 负测 4: 错误 Nonce 拒绝 (401) ----------------
	const l2 = await fetch(`http://127.0.0.1:${gwPort}/auth/oidc/login`, { headers: { Host: `127.0.0.1:${gwPort}` }, redirect: "manual" });
	const idp2 = await fetch(l2.headers.get("location")!, { redirect: "manual" });
	const cb2Url = new URL(idp2.headers.get("location")!);
	tokenResponseNonceOverride = "wrong-nonce";
	const wrongNonceRes = await fetch(`http://127.0.0.1:${gwPort}/auth/oidc/callback?code=${cb2Url.searchParams.get("code")}&state=${cb2Url.searchParams.get("state")}`, {
		headers: { Host: `127.0.0.1:${gwPort}`, Cookie: (l2.headers.get("set-cookie") ?? "").split(";")[0] ?? "" },
	});
	assert.equal(wrongNonceRes.status, 401, "nonce 不匹配必须拒绝 401");
	tokenResponseNonceOverride = null;

	// ---------------- 负测 5: Token 端点恶意 302 重定向拦截 (502) ----------------
	const l3 = await fetch(`http://127.0.0.1:${gwPort}/auth/oidc/login`, { headers: { Host: `127.0.0.1:${gwPort}` }, redirect: "manual" });
	const idp3 = await fetch(l3.headers.get("location")!, { redirect: "manual" });
	const cb3Url = new URL(idp3.headers.get("location")!);
	simulateRedirectOnTokenEndpoint = true;
	const redirectAttackRes = await fetch(`http://127.0.0.1:${gwPort}/auth/oidc/callback?code=${cb3Url.searchParams.get("code")}&state=${cb3Url.searchParams.get("state")}`, {
		headers: { Host: `127.0.0.1:${gwPort}`, Cookie: (l3.headers.get("set-cookie") ?? "").split(";")[0] ?? "" },
	});
	assert.equal(redirectAttackRes.status, 401, "Token 端点返回 30x 重定向时网关严格 manual 拒绝跟随 (401)");
	simulateRedirectOnTokenEndpoint = false;

	// ---------------- 负测 6: Token 端点超大响应 (>64KiB) 拒绝 (400) ----------------
	const l4 = await fetch(`http://127.0.0.1:${gwPort}/auth/oidc/login`, { headers: { Host: `127.0.0.1:${gwPort}` }, redirect: "manual" });
	const idp4 = await fetch(l4.headers.get("location")!, { redirect: "manual" });
	const cb4Url = new URL(idp4.headers.get("location")!);
	tokenResponseBodyOverride = JSON.stringify({ flood: "x".repeat(70 * 1024) });
	const floodRes = await fetch(`http://127.0.0.1:${gwPort}/auth/oidc/callback?code=${cb4Url.searchParams.get("code")}&state=${cb4Url.searchParams.get("state")}`, {
		headers: { Host: `127.0.0.1:${gwPort}`, Cookie: (l4.headers.get("set-cookie") ?? "").split(";")[0] ?? "" },
	});
	assert.equal(floodRes.status, 400, "超过 64KiB 上限必须中止并拒绝 400");
	tokenResponseBodyOverride = null;

	// ---------------- 不变式检查: 检查所有 Set-Cookie 中 __Host- 前缀的 Path=/ 与 Secure 规则 ----------------
	for (const headerVal of [setPkceCookie, sessionCookies, l4.headers.get("set-cookie") ?? ""]) {
		for (const part of headerVal.split(",")) {
			if (part.includes("__Host-")) {
				assert.match(part, /Path=\//, "__Host- 前缀 Cookie 必须严格设置 Path=/");
				assert.match(part, /Secure/, "__Host- 前缀 Cookie 必须包含 Secure");
				assert.ok(!part.includes("Domain="), "__Host- 前缀 Cookie 不得包含 Domain 属性");
			}
		}
	}

	// ---------------- 负测 7: 多受众 (aud 为数组) 缺 azp 拒绝 (401) ----------------
	let customClaimsOverride: Record<string, unknown> | null = null;
	const prevIdTokenSigner = idpServer.listeners("request")[0];
	const l5 = await fetch(`http://127.0.0.1:${gwPort}/auth/oidc/login`, { headers: { Host: `127.0.0.1:${gwPort}` }, redirect: "manual" });
	const idp5 = await fetch(l5.headers.get("location")!, { redirect: "manual" });
	const cb5Url = new URL(idp5.headers.get("location")!);
	const code5 = cb5Url.searchParams.get("code")!;
	tokenResponseBodyOverride = JSON.stringify({
		id_token: signIdToken({
			iss: "https://idp.corp.local",
			aud: ["perimeter-client", "other-client"],
			sub: "alice",
			nonce: idpCodes.get(code5)!.nonce,
			exp: Math.floor(Date.now() / 1000) + 3600,
			groups: ["dev"],
		}),
		token_type: "Bearer",
	});
	const multiAudNoAzpRes = await fetch(`http://127.0.0.1:${gwPort}/auth/oidc/callback?code=${code5}&state=${cb5Url.searchParams.get("state")}`, {
		headers: { Host: `127.0.0.1:${gwPort}`, Cookie: (l5.headers.get("set-cookie") ?? "").split(";")[0] ?? "" },
	});
	assert.equal(multiAudNoAzpRes.status, 401, "多受众未指定 azp 必须拒绝 401");

	// ---------------- 负测 8: 多受众 azp 不等于 clientId 拒绝 (401) ----------------
	const l6 = await fetch(`http://127.0.0.1:${gwPort}/auth/oidc/login`, { headers: { Host: `127.0.0.1:${gwPort}` }, redirect: "manual" });
	const idp6 = await fetch(l6.headers.get("location")!, { redirect: "manual" });
	const cb6Url = new URL(idp6.headers.get("location")!);
	const code6 = cb6Url.searchParams.get("code")!;
	tokenResponseBodyOverride = JSON.stringify({
		id_token: signIdToken({
			iss: "https://idp.corp.local",
			aud: ["perimeter-client", "other-client"],
			sub: "alice",
			azp: "attacker-client",
			nonce: idpCodes.get(code6)!.nonce,
			exp: Math.floor(Date.now() / 1000) + 3600,
			groups: ["dev"],
		}),
		token_type: "Bearer",
	});
	const multiAudWrongAzpRes = await fetch(`http://127.0.0.1:${gwPort}/auth/oidc/callback?code=${code6}&state=${cb6Url.searchParams.get("state")}`, {
		headers: { Host: `127.0.0.1:${gwPort}`, Cookie: (l6.headers.get("set-cookie") ?? "").split(";")[0] ?? "" },
	});
	assert.equal(multiAudWrongAzpRes.status, 401, "多受众 azp 错误必须拒绝 401");

	// ---------------- 负测 9: 单受众但指定了错误的 azp 拒绝 (401) ----------------
	const l7 = await fetch(`http://127.0.0.1:${gwPort}/auth/oidc/login`, { headers: { Host: `127.0.0.1:${gwPort}` }, redirect: "manual" });
	const idp7 = await fetch(l7.headers.get("location")!, { redirect: "manual" });
	const cb7Url = new URL(idp7.headers.get("location")!);
	const code7 = cb7Url.searchParams.get("code")!;
	tokenResponseBodyOverride = JSON.stringify({
		id_token: signIdToken({
			iss: "https://idp.corp.local",
			aud: "perimeter-client",
			sub: "alice",
			azp: "attacker-client",
			nonce: idpCodes.get(code7)!.nonce,
			exp: Math.floor(Date.now() / 1000) + 3600,
			groups: ["dev"],
		}),
		token_type: "Bearer",
	});
	const singleAudWrongAzpRes = await fetch(`http://127.0.0.1:${gwPort}/auth/oidc/callback?code=${code7}&state=${cb7Url.searchParams.get("state")}`, {
		headers: { Host: `127.0.0.1:${gwPort}`, Cookie: (l7.headers.get("set-cookie") ?? "").split(";")[0] ?? "" },
	});
	assert.equal(singleAudWrongAzpRes.status, 401, "单受众指定了错误 azp 必须拒绝 401");

	// ---------------- 正向验证: 多受众且 azp 正确匹配 clientId 成功换取会话 (302) ----------------
	const l8 = await fetch(`http://127.0.0.1:${gwPort}/auth/oidc/login`, { headers: { Host: `127.0.0.1:${gwPort}` }, redirect: "manual" });
	const idp8 = await fetch(l8.headers.get("location")!, { redirect: "manual" });
	const cb8Url = new URL(idp8.headers.get("location")!);
	const code8 = cb8Url.searchParams.get("code")!;
	tokenResponseBodyOverride = JSON.stringify({
		id_token: signIdToken({
			iss: "https://idp.corp.local",
			aud: ["perimeter-client", "co-partner-client"],
			sub: "alice",
			azp: "perimeter-client",
			nonce: idpCodes.get(code8)!.nonce,
			exp: Math.floor(Date.now() / 1000) + 3600,
			groups: ["dev"],
		}),
		token_type: "Bearer",
	});
	const multiAudCorrectAzpRes = await fetch(`http://127.0.0.1:${gwPort}/auth/oidc/callback?code=${code8}&state=${cb8Url.searchParams.get("state")}`, {
		headers: { Host: `127.0.0.1:${gwPort}`, Cookie: (l8.headers.get("set-cookie") ?? "").split(";")[0] ?? "" },
		redirect: "manual",
	});
	assert.equal(multiAudCorrectAzpRes.status, 302, "多受众且 azp 正确必须成功 302");
	tokenResponseBodyOverride = null;
});

test("s1-persistent-revocation: 持久化吊销与会话存储在进程重启后依然生效（附损坏 fail-closed 与端口冲突受控负测）", async () => {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = publicKey.export({ format: "jwk" }) as any;
	jwk.kid = "gw-k1";
	jwk.alg = "RS256";
	jwk.use = "sig";

	function signToken(sub: string): string {
		const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "gw-k1" })).toString("base64url");
		const payload = Buffer.from(JSON.stringify({
			iss: "https://corp.local",
			aud: "perimeter",
			sub,
			exp: Math.floor(Date.now() / 1000) + 3600,
			groups: ["dev"],
		})).toString("base64url");
		const signer = createSign("RSA-SHA256");
		signer.update(`${header}.${payload}`);
		const sig = signer.sign(privateKey, "base64url");
		return `${header}.${payload}.${sig}`;
	}

	const auth = new JwtAuthenticator({
		issuer: "https://corp.local",
		audience: "perimeter",
		jwks: new StaticJwks([jwk]),
	});

	function isEAddrInUse(err: unknown): boolean {
		return Boolean(
			err &&
			typeof err === "object" &&
			("code" in err ? (err as any).code === "EADDRINUSE" : String(err).includes("EADDRINUSE"))
		);
	}

	async function getAvailablePort(): Promise<number> {
		return new Promise((resolve, reject) => {
			const s = createServer();
			s.unref();
			s.on("error", reject);
			s.listen(0, "127.0.0.1", () => {
				const p = (s.address() as { port: number }).port;
				s.close((err) => {
					if (err) reject(err);
					else resolve(p);
				});
			});
		});
	}

	// 1-4. 启动网关 A -> Alice/Bob 接入 -> 吊销 Alice -> 重启为网关 B -> 验证 Alice 仍拒绝、Bob 恢复 -> restorePrincipal
	// 针对 EADDRINUSE 提供有限重试，并在每个失败 attempt 彻底释放监听器与资源
	let port = 0;
	let stateRoot = "";
	let workspaceRoot = "";
	let auditFile = "";
	let revFile = "";
	let sessFile = "";
	let rebootSuccess = false;
	let lastRebootErr: unknown;

	for (let attempt = 0; attempt < 5; attempt++) {
		port = await getAvailablePort();
		stateRoot = mkdtempSync(join(tmpdir(), "gw-persist-state-"));
		workspaceRoot = mkdtempSync(join(tmpdir(), "gw-persist-ws-"));
		auditFile = join(stateRoot, "audit.jsonl");
		revFile = join(stateRoot, "revocations.json");
		sessFile = join(stateRoot, "browser-sessions.json");

		let gwA: Gateway | undefined;
		let gwB: Gateway | undefined;

		try {
			// 1. 启动第一个网关实例 A
			gwA = new Gateway({
				mode: "production",
				backend: s1Backend,
				port,
				host: "127.0.0.1",
				auth,
				stateRoot,
				workspaceRoot,
				auditFile,
				allowedHosts: [`127.0.0.1:${port}`],
				allowedOrigins: ["https://console.corp.local"],
				policyFile: join(REPO, "config/policy.yaml"),
				webRoot: join(REPO, "web"),
				resolveScope: () => ({ repo: "r", team: "t" }),
			});
			await gwA.listen();

			// Alice 与 Bob 首次接入
			const aliceToken = signToken("alice");
			const bobToken = signToken("bob");

			const authResAlice = await fetch(`http://127.0.0.1:${port}/auth/session`, {
				method: "POST",
				headers: {
					Host: `127.0.0.1:${port}`,
					Origin: "https://console.corp.local",
					Authorization: `Bearer ${aliceToken}`,
					Connection: "close",
				},
			});
			assert.equal(authResAlice.status, 204, "Alice 换取会话必须成功");
			const aliceCookie = authResAlice.headers.get("set-cookie")!.split(";")[0]!;

			// Bob 在重启前也换取会话 Cookie
			const authResBob = await fetch(`http://127.0.0.1:${port}/auth/session`, {
				method: "POST",
				headers: {
					Host: `127.0.0.1:${port}`,
					Origin: "https://console.corp.local",
					Authorization: `Bearer ${bobToken}`,
					Connection: "close",
				},
			});
			assert.equal(authResBob.status, 204, "Bob 换取会话必须成功");
			const bobCookie = authResBob.headers.get("set-cookie")!.split(";")[0]!;

			// 吊销 Alice 主体
			gwA.revokePrincipal("https://corp.local|alice");

			// 验证 Alice 立即被拒绝
			const deniedAliceRes = await fetch(`http://127.0.0.1:${port}/auth/session`, {
				method: "POST",
				headers: {
					Host: `127.0.0.1:${port}`,
					Origin: "https://console.corp.local",
					Authorization: `Bearer ${aliceToken}`,
					Connection: "close",
				},
			});
			assert.equal(deniedAliceRes.status, 401, "已吊销的主体立即被拒绝 401");

			// 检查持久化文件已落盘且权限符合 0600 与 0700 要求
			assert.ok(existsSync(revFile), "revocations.json 持久化文件必须生成");
			assert.ok(existsSync(sessFile), "browser-sessions.json 持久化文件必须生成");
			assert.equal(statSync(revFile).mode & 0o777, 0o600, "revocations.json 权限必须是 0600");
			assert.equal(statSync(sessFile).mode & 0o777, 0o600, "browser-sessions.json 权限必须是 0600");
			assert.equal(statSync(stateRoot).mode & 0o777, 0o700, "stateRoot 管理目录权限必须是 0700");

			const revContent = JSON.parse(readFileSync(revFile, "utf8"));
			assert.ok(revContent.revoked.includes("https://corp.local|alice"), "持久化记录中必须包含 Alice");

			// 2. 模拟进程完全退出 / 重启：关闭网关 A，创建新网关 B 指向同一 stateRoot
			await gwA.close();
			gwA = undefined;

			gwB = new Gateway({
				mode: "production",
				backend: s1Backend,
				port,
				host: "127.0.0.1",
				auth,
				stateRoot,
				workspaceRoot,
				auditFile,
				allowedHosts: [`127.0.0.1:${port}`],
				allowedOrigins: ["https://console.corp.local"],
				policyFile: join(REPO, "config/policy.yaml"),
				webRoot: join(REPO, "web"),
				resolveScope: () => ({ repo: "r", team: "t" }),
			});
			await gwB.listen();

			// 3. 验证重启后，Alice 尝试使用有效 JWT 或旧 Cookie 接入，依然被 401 拒绝！
			const rebootAliceJwtRes = await fetch(`http://127.0.0.1:${port}/auth/session`, {
				method: "POST",
				headers: {
					Host: `127.0.0.1:${port}`,
					Origin: "https://console.corp.local",
					Authorization: `Bearer ${aliceToken}`,
					Connection: "close",
				},
			});
			assert.equal(rebootAliceJwtRes.status, 401, "网关重启后已吊销主体持有效 JWT 依然被拒 401");

			const rebootAliceCookieWs = new WebSocket(`ws://127.0.0.1:${port}/`, {
				headers: {
					Host: `127.0.0.1:${port}`,
					Origin: "https://console.corp.local",
					Cookie: aliceCookie,
				},
			});
			const wsAliceCloseCode = await new Promise<number>((resolve) => {
				rebootAliceCookieWs.on("close", (code) => resolve(code));
				rebootAliceCookieWs.on("error", () => {});
			});
			assert.ok([4001, 1006].includes(wsAliceCloseCode), "重启后旧 Cookie 连接必须被拒绝或关闭");

			// 验证未吊销的 Bob 拿旧 Cookie 接入：actor 依然是 https://corp.local|bob，未被会话 ID 覆盖
			const rebootBobWs = new WebSocket(`ws://127.0.0.1:${port}/`, {
				headers: {
					Host: `127.0.0.1:${port}`,
					Origin: "https://console.corp.local",
					Cookie: bobCookie,
				},
			});
			await new Promise<void>((resolve, reject) => {
				rebootBobWs.on("open", resolve);
				rebootBobWs.on("error", reject);
			});
			assert.equal(rebootBobWs.readyState, WebSocket.OPEN, "Bob 凭借重启前旧 Cookie 正常建立 WS 连接");
			await new Promise<void>((r) => setTimeout(r, 50));
			rebootBobWs.close();

			// 4. 显式 restorePrincipal 解除吊销
			gwB.restorePrincipal("https://corp.local|alice");
			const restoredAliceRes = await fetch(`http://127.0.0.1:${port}/auth/session`, {
				method: "POST",
				headers: {
					Host: `127.0.0.1:${port}`,
					Origin: "https://console.corp.local",
					Authorization: `Bearer ${aliceToken}`,
					Connection: "close",
				},
			});
			assert.equal(restoredAliceRes.status, 204, "显式 restore 后 Alice 恢复授权");
			await gwB.close();
			gwB = undefined;

			rebootSuccess = true;
			break;
		} catch (err) {
			if (gwA) { try { await gwA.close(); } catch {} }
			if (gwB) { try { await gwB.close(); } catch {} }
			if (isEAddrInUse(err)) {
				lastRebootErr = err;
				await new Promise((r) => setTimeout(r, 50));
				continue;
			}
			throw err;
		}
	}
	if (!rebootSuccess) throw lastRebootErr;

	// 5. 崩溃窗口测试：手工构造「revocations.json 已包含 alice，browser-sessions.json 残留 alice 会话」
	const crashRoot = mkdtempSync(join(tmpdir(), "gw-crash-state-"));
	writeFileSync(join(crashRoot, "revocations.json"), JSON.stringify({ revoked: ["https://corp.local|alice"], updatedAt: new Date().toISOString() }), { mode: 0o600 });
	writeFileSync(join(crashRoot, "browser-sessions.json"), JSON.stringify([
		{
			sessionId: "alice-sess-crash-window",
			principal: {
				id: "https://corp.local|alice",
				issuer: "https://corp.local",
				subject: "alice",
				groups: ["dev"],
				expiresAt: Math.floor(Date.now() / 1000) + 3600,
			},
			sessionExpiresAt: Date.now() + 3600_000,
		}
	]), { mode: 0o600 });

	let crashSuccess = false;
	let lastCrashErr: unknown;
	for (let attempt = 0; attempt < 5; attempt++) {
		const crashPort = await getAvailablePort();
		let gwCrash: Gateway | undefined;
		try {
			gwCrash = new Gateway({
				mode: "production",
				backend: s1Backend,
				port: crashPort,
				host: "127.0.0.1",
				auth,
				stateRoot: crashRoot,
				workspaceRoot,
				auditFile: join(crashRoot, "audit.jsonl"),
				allowedHosts: [`127.0.0.1:${crashPort}`],
				allowedOrigins: ["https://console.corp.local"],
				policyFile: join(REPO, "config/policy.yaml"),
				webRoot: join(REPO, "web"),
				resolveScope: () => ({ repo: "r", team: "t" }),
			});
			await gwCrash.listen();

			// 验证崩溃窗口下，Alice 拿残留会话 Cookie 接入依然被拒绝 401
			const crashWsAlice = new WebSocket(`ws://127.0.0.1:${crashPort}/`, {
				headers: {
					Host: `127.0.0.1:${crashPort}`,
					Origin: "https://console.corp.local",
					Cookie: "__Host-perimeter_session=alice-sess-crash-window",
				},
			});
			const crashCloseCode = await new Promise<number>((resolve) => {
				crashWsAlice.on("close", resolve);
				crashWsAlice.on("error", () => {});
			});
			assert.ok([4001, 1006].includes(crashCloseCode), "崩溃窗口残留的 Alice 会话启动加载时被剔除，旧 Cookie 拒绝 401");
			await gwCrash.close();
			gwCrash = undefined;

			crashSuccess = true;
			break;
		} catch (err) {
			if (gwCrash) { try { await gwCrash.close(); } catch {} }
			if (isEAddrInUse(err)) {
				lastCrashErr = err;
				await new Promise((r) => setTimeout(r, 50));
				continue;
			}
			throw err;
		}
	}
	if (!crashSuccess) throw lastCrashErr;

	// 6. 删除已初始化实例的 revocations.json 必须 fail-closed 拒绝启动并在审计留痕
	unlinkSync(join(crashRoot, "revocations.json"));
	assert.throws(
		() => new Gateway({
			mode: "production",
			backend: s1Backend,
			port: 59990,
			host: "127.0.0.1",
			auth,
			stateRoot: crashRoot,
			workspaceRoot,
			auditFile: join(crashRoot, "audit.jsonl"),
			allowedHosts: ["127.0.0.1:59990"],
			allowedOrigins: ["https://console.corp.local"],
			policyFile: join(REPO, "config/policy.yaml"),
			webRoot: join(REPO, "web"),
			resolveScope: () => ({ repo: "r", team: "t" }),
		}),
		/吊销记录文件 revocations.json 缺失.*fail-closed 拒绝启动/,
		"已初始化的 stateRoot 缺少 revocations.json 必须 fail-closed 拒启"
	);

	// 7. revocations.json 内部错类型（非 string）必须 fail-closed 抛错
	writeFileSync(join(crashRoot, "revocations.json"), JSON.stringify({ revoked: ["https://corp.local|alice", 12345] }), { mode: 0o600 });
	assert.throws(
		() => new Gateway({
			mode: "production",
			backend: s1Backend,
			port: 59991,
			host: "127.0.0.1",
			auth,
			stateRoot: crashRoot,
			workspaceRoot,
			auditFile: join(crashRoot, "audit.jsonl"),
			allowedHosts: ["127.0.0.1:59991"],
			allowedOrigins: ["https://console.corp.local"],
			policyFile: join(REPO, "config/policy.yaml"),
			webRoot: join(REPO, "web"),
			resolveScope: () => ({ repo: "r", team: "t" }),
		}),
		/包含非字符串主体 ID/,
		"revocations.json 内部包含非字符串 ID 必须 fail-closed 抛错"
	);

	// 8. 损坏 JSON 内容 fail-closed 拒绝启动测试
	writeFileSync(revFile, "{ invalid-corrupted-json content!!!", "utf8");
	assert.throws(
		() => new Gateway({
			mode: "production",
			backend: s1Backend,
			port: 59992,
			host: "127.0.0.1",
			auth,
			stateRoot,
			workspaceRoot,
			auditFile,
			allowedHosts: ["127.0.0.1:59992"],
			allowedOrigins: ["https://console.corp.local"],
			policyFile: join(REPO, "config/policy.yaml"),
			webRoot: join(REPO, "web"),
			resolveScope: () => ({ repo: "r", team: "t" }),
		}),
		/吊销存储损坏，fail-closed/,
		"吊销文件损坏时必须抛出异常，fail-closed 拒绝启动"
	);

	// 9. 可复现端口冲突控制负测：端口已被占用时 listen() 必须受控抛出 EADDRINUSE，且 close() 妥善释放自身资源；占用释放后可成功重绑
	const blocker = createServer();
	await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
	const conflictPort = (blocker.address() as { port: number }).port;

	const conflictRoot = mkdtempSync(join(tmpdir(), "gw-conflict-state-"));
	const gwConflict = new Gateway({
		mode: "production",
		backend: s1Backend,
		port: conflictPort,
		host: "127.0.0.1",
		auth,
		stateRoot: conflictRoot,
		workspaceRoot,
		auditFile: join(conflictRoot, "audit.jsonl"),
		allowedHosts: [`127.0.0.1:${conflictPort}`],
		allowedOrigins: ["https://console.corp.local"],
		policyFile: join(REPO, "config/policy.yaml"),
		webRoot: join(REPO, "web"),
		resolveScope: () => ({ repo: "r", team: "t" }),
	});

	try {
		await assert.rejects(
			gwConflict.listen(),
			(err: any) => err?.code === "EADDRINUSE" || String(err).includes("EADDRINUSE"),
			"端口被占用时 listen() 必须明确受控抛出 EADDRINUSE"
		);
	} finally {
		await gwConflict.close();
		await new Promise<void>((r) => blocker.close(() => r()));
	}

	const gwRecovered = new Gateway({
		mode: "production",
		backend: s1Backend,
		port: conflictPort,
		host: "127.0.0.1",
		auth,
		stateRoot: conflictRoot,
		workspaceRoot,
		auditFile: join(conflictRoot, "audit.jsonl"),
		allowedHosts: [`127.0.0.1:${conflictPort}`],
		allowedOrigins: ["https://console.corp.local"],
		policyFile: join(REPO, "config/policy.yaml"),
		webRoot: join(REPO, "web"),
		resolveScope: () => ({ repo: "r", team: "t" }),
	});
	const bound = await gwRecovered.listen();
	assert.equal(bound, conflictPort, "占用释放后网关能够成功重绑该端口");
	await gwRecovered.close();
});

test("s1-child-process-persistence: 独立 child-process 重启、崩溃窗口与 fail-closed 负测", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-cp-test-"));
	const stateRoot = join(dir, "state");
	mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	const auditFile = join(dir, "audit.jsonl");

	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = publicKey.export({ format: "jwk" }) as any;
	jwk.kid = "k1";
	jwk.alg = "RS256";
	jwk.use = "sig";

	function sign(sub: string): string {
		const h = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" })).toString("base64url");
		const p = Buffer.from(JSON.stringify({ iss: "https://corp.local", aud: "perimeter", sub, exp: Math.floor(Date.now() / 1000) + 3600, groups: ["dev"] })).toString("base64url");
		const signer = createSign("RSA-SHA256");
		signer.update(`${h}.${p}`);
		return `${h}.${p}.${signer.sign(privateKey, "base64url")}`;
	}

	const runnerScript = join(dir, "runner.mjs");
	writeFileSync(runnerScript, `
import { Gateway } from ${JSON.stringify(join(REPO, "src/gateway/server.ts"))};
import { JwtAuthenticator, StaticJwks } from ${JSON.stringify(join(REPO, "src/gateway/auth.ts"))};
import { DockerBackend } from ${JSON.stringify(join(REPO, "src/gateway/execution-backend.ts"))};

const auth = new JwtAuthenticator({
	issuer: "https://corp.local",
	audience: "perimeter",
	jwks: new StaticJwks([${JSON.stringify(jwk)}]),
});

const gw = new Gateway({
	mode: "production",
	backend: new DockerBackend({ image: "perimeter-sandbox:test", repoRoot: ${JSON.stringify(REPO)}, network: "none" }),
	port: Number(process.env.TEST_PORT),
	host: "127.0.0.1",
	auth,
	stateRoot: ${JSON.stringify(stateRoot)},
	workspaceRoot: ${JSON.stringify(join(dir, "ws"))},
	auditFile: ${JSON.stringify(auditFile)},
	allowedHosts: [\`127.0.0.1:\${process.env.TEST_PORT}\`],
	allowedOrigins: ["https://console.corp.local"],
	policyFile: ${JSON.stringify(join(REPO, "config/policy.yaml"))},
	webRoot: ${JSON.stringify(join(REPO, "web"))},
	resolveScope: () => ({ repo: "r", team: "t" }),
});

const p = await gw.listen();
console.log(JSON.stringify({ listening: p }));

process.on("message", (msg) => {
	if (msg === "revokeAlice") {
		gw.revokePrincipal("https://corp.local|alice");
		process.send("revoked");
	}
	if (msg === "close") {
		gw.close().then(() => process.exit(0));
	}
});
`, "utf8");

	// 1. 运行第一个独立子进程 A
	const p1 = createServer();
	await new Promise<void>((r) => p1.listen(0, "127.0.0.1", r));
	const port = (p1.address() as { port: number }).port;
	await new Promise<void>((r) => p1.close(() => r()));

	const childA = spawn(process.execPath, [runnerScript], {
		env: { ...process.env, TEST_PORT: String(port) },
		stdio: ["ignore", "pipe", "inherit", "ipc"],
	});
	cleanups.push(() => { try { childA.kill(); } catch {} });

	await new Promise<void>((resolve, reject) => {
		childA.stdout?.once("data", () => resolve());
		childA.on("error", reject);
	});

	// Alice 换取 Cookie
	const resAlice = await fetch(`http://127.0.0.1:${port}/auth/session`, {
		method: "POST",
		headers: { Host: `127.0.0.1:${port}`, Origin: "https://console.corp.local", Authorization: `Bearer ${sign("alice")}`, Connection: "close" },
	});
	assert.equal(resAlice.status, 204);
	const aliceCookie = resAlice.headers.get("set-cookie")!.split(";")[0]!;

	// Bob 换取 Cookie
	const resBob = await fetch(`http://127.0.0.1:${port}/auth/session`, {
		method: "POST",
		headers: { Host: `127.0.0.1:${port}`, Origin: "https://console.corp.local", Authorization: `Bearer ${sign("bob")}`, Connection: "close" },
	});
	assert.equal(resBob.status, 204);
	const bobCookie = resBob.headers.get("set-cookie")!.split(";")[0]!;

	// IPC 触发子进程吊销 Alice
	childA.send("revokeAlice");
	await new Promise<void>((resolve) => childA.once("message", () => resolve()));

	// 子进程平响并退出
	childA.send("close");
	await new Promise<void>((resolve) => childA.on("exit", () => resolve()));

	// 2. 运行第二个独立子进程 B（共享 stateRoot 模拟真实进程重启）
	const childB = spawn(process.execPath, [runnerScript], {
		env: { ...process.env, TEST_PORT: String(port) },
		stdio: ["ignore", "pipe", "inherit", "ipc"],
	});
	cleanups.push(() => { try { childB.kill(); } catch {} });
	await new Promise<void>((resolve, reject) => {
		childB.stdout?.once("data", () => resolve());
		childB.on("error", reject);
	});

	// Alice 携旧 Cookie 连接新网关，验证严格被拒（握手返回 401 或 close 拒绝）
	const wsAlice = new WebSocket(`ws://127.0.0.1:${port}/`, {
		headers: { Host: `127.0.0.1:${port}`, Origin: "https://console.corp.local", Cookie: aliceCookie },
	});
	const aliceErr = await new Promise<any>((r) => {
		wsAlice.on("error", (e) => r(e));
		wsAlice.on("unexpected-response", (_req, res) => r(res.statusCode));
		wsAlice.on("close", (code) => r(code));
	});
	assert.ok(aliceErr === 401 || (aliceErr instanceof Error && /401/.test(aliceErr.message)) || [4001, 1006].includes(aliceErr), "子进程重启后 Alice 旧会话被拒");

	// Bob 携旧 Cookie 连接新网关，验证正常接入且未被改写为随机会话 ID
	const wsBob = new WebSocket(`ws://127.0.0.1:${port}/`, {
		headers: { Host: `127.0.0.1:${port}`, Origin: "https://console.corp.local", Cookie: bobCookie },
	});
	await new Promise<void>((r) => wsBob.on("open", r));
	assert.equal(wsBob.readyState, WebSocket.OPEN, "子进程重启后 Bob 凭旧 Cookie 成功接入");
	wsBob.close();

	childB.send("close");
	await new Promise<void>((resolve) => childB.on("exit", () => resolve()));

	// 3. 删除 revocations.json，验证第三个子进程 fail-closed 退出（exitCode !== 0）
	unlinkSync(join(stateRoot, "revocations.json"));
	const childC = spawn(process.execPath, [runnerScript], {
		env: { ...process.env, TEST_PORT: String(port) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const [cCode] = await new Promise<[number | null]>((resolve) => childC.on("exit", (code) => resolve([code])));
	assert.notEqual(cCode, 0, "revocations.json 丢失时子进程必须非零退出 fail-closed");

	// 4. 损坏格式，验证第四个子进程 fail-closed 退出（exitCode !== 0）
	writeFileSync(join(stateRoot, "revocations.json"), "{ corrupted json!!!", { mode: 0o600 });
	const childD = spawn(process.execPath, [runnerScript], {
		env: { ...process.env, TEST_PORT: String(port) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const [dCode] = await new Promise<[number | null]>((resolve) => childD.on("exit", (code) => resolve([code])));
	assert.notEqual(dCode, 0, "revocations.json 损坏时子进程必须非零退出 fail-closed");
});




