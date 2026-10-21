import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { AuditLog } from "../src/audit/log.ts";
import { DockerBackend } from "../src/gateway/execution-backend.ts";
import { Gateway } from "../src/gateway/server.ts";
import { ModelGateway } from "../src/modelgw/server.ts";
import { mintScopedToken } from "../src/modelgw/scoped-token.ts";
import type { ClientEvent } from "../src/protocol/types.ts";

// S4c：网关按会话签发 scoped 模型凭证 + S4b 复审 note①③ 修复验收。
// 真实网关 + 真实 ModelGateway + mock 上游（127.0.0.1 + 临时目录）；不 mock 被测语义。
// (c)「未配置 modelScopedKey 行为不变」的依据：S4b 基线全量 65 文件 844/844 全绿
//（该基线不含本轮改动），叠加本文件的静态路径对照用例钉住 wiring 路径。

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MOCK = join(REPO, "tests/fixtures/mock-model.mjs");
const GATEWAY_TOKEN = "test-gateway-token";
const PROXY_TOKEN = "test-static-proxy-token";

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups) await c();
});

// ── 夹具 ───────────────────────────────────────────────────

async function startMock(script: unknown[]): Promise<number> {
	const mock: ChildProcess = spawn(process.execPath, [MOCK, "0", JSON.stringify(script)], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	cleanups.push(() => void mock.kill());
	return new Promise((r, j) => {
		mock.stdout?.once("data", (d) => {
			try { r(JSON.parse(d.toString()).port); } catch (e) { j(e as Error); }
		});
	});
}

interface FakeUpstream {
	url: string;
	host: string;
}

/** modelgw 单元面用的可编程假上游：缺省回标准 SSE + usage 100/20/120 */
async function startFakeUpstream(handler?: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<FakeUpstream> {
	const srv = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			if (handler) {
				handler(req, res, body);
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "up-req-1" });
			res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "上游回复" } }] })}\n\n`);
			res.write(`data: ${JSON.stringify({ choices: [{}], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
	const port = (srv.address() as { port: number }).port;
	return { url: `http://127.0.0.1:${port}/v1`, host: "127.0.0.1" };
}

interface Stack {
	url: string;
	gateway: Gateway;
	modelGw: ModelGateway;
	/** modelgw 监听地址（wiring.modelGatewayUrl 的来源） */
	mgwUrl: string;
	gwAuditFile: string;
	mgwAuditFile: string;
	scopedKey: Buffer;
}

/** 全栈：浏览器/WS → 网关（wiring + 可选 modelScopedKey）→ 真实 ModelGateway → mock 模型 */
async function startStack(opts: { scoped?: boolean; defaultTeam?: string } = {}): Promise<Stack> {
	const scopedKey = randomBytes(32);
	const mockPort = await startMock([{ text: "第一个回复" }, { text: "第二个回复" }, { text: "第三个回复" }]);
	const dir = mkdtempSync(join(tmpdir(), "s4c-"));
	const mgwAuditFile = join(dir, "modelgw-audit.jsonl");
	const mgwAudit = AuditLog.open(mgwAuditFile);
	cleanups.push(() => mgwAudit.close());
	const modelGw = new ModelGateway({
		port: 0,
		host: "127.0.0.1",
		token: PROXY_TOKEN,
		upstreams: [{ id: "upstream", baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "UPSTREAM-SECRET-KEY" }],
		egressAllowlist: ["127.0.0.1"],
		scopedTokenKey: scopedKey,
		ledgerFile: join(dir, "budget.sqlite"),
		audit: mgwAudit,
		...(opts.defaultTeam ? { defaultTeam: opts.defaultTeam } : {}),
	});
	cleanups.push(() => modelGw.close());
	const mgwPort = await modelGw.listen();

	const gwAuditFile = join(dir, "gateway-audit.jsonl");
	const gateway = new Gateway({
		mode: "demo",
		port: 0,
		host: "127.0.0.1",
		token: GATEWAY_TOKEN,
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: gwAuditFile,
		workspaceRoot: join(dir, "workspaces"),
		webRoot: join(REPO, "web"),
		wiring: { proxyToken: PROXY_TOKEN, modelGatewayUrl: `http://127.0.0.1:${mgwPort}/v1`, model: "mock-model" },
		resolveScope: () => ({ repo: "demo-app", team: "platform" }),
		approvalTimeoutMs: 30_000,
		...(opts.scoped ? { modelScopedKey: scopedKey } : {}),
	});
	cleanups.push(() => gateway.close());
	const port = await gateway.listen();
	return { url: `http://127.0.0.1:${port}`, gateway, modelGw, mgwUrl: `http://127.0.0.1:${mgwPort}/v1`, gwAuditFile, mgwAuditFile, scopedKey };
}

interface Client {
	ws: WebSocket;
	events: ClientEvent[];
	waitFor: (pred: () => boolean, ms?: number) => Promise<void>;
	find: <T extends ClientEvent["type"]>(type: T) => Extract<ClientEvent, { type: T }> | undefined;
	send: (cmd: unknown) => void;
}

async function connect(env: Stack, query = ""): Promise<Client> {
	const ws = new WebSocket(`${env.url.replace("http", "ws")}/?token=${GATEWAY_TOKEN}${query}`);
	const events: ClientEvent[] = [];
	ws.on("message", (raw) => {
		const msg = JSON.parse(String(raw));
		if (msg.type !== "control") events.push(msg.event);
	});
	await new Promise((r, j) => {
		ws.once("open", r);
		ws.once("error", j);
	});
	cleanups.push(() => void ws.close());
	const waitFor = async (pred: () => boolean, ms = 20_000) => {
		const deadline = Date.now() + ms;
		while (!pred()) {
			if (Date.now() > deadline) throw new Error(`waitFor 超时；已收到 ${events.map((e) => e.type).join(",")}`);
			await new Promise((r) => setTimeout(r, 20));
		}
	};
	return {
		ws,
		events,
		waitFor,
		find: (type) => events.find((e) => e.type === type) as never,
		send: (cmd) => {
			if (cmd && typeof cmd === "object" && ["prompt", "steer"].includes((cmd as { type: string }).type)) cmd = { requestId: randomUUID(), ...cmd };
			ws.send(JSON.stringify(cmd));
		},
	};
}

function call(url: string, body: unknown, headers: Record<string, string> = {}) {
	return fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

async function auditEntries(file: string): Promise<import("../src/audit/log.ts").AuditEntry[]> {
	const out: import("../src/audit/log.ts").AuditEntry[] = [];
	for await (const e of AuditLog.replay(file)) out.push(e);
	return out;
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 20));
	}
	return cond();
}

// ── (a) scoped 接线：按服务端会话归属到达 modelgw ──────────

test("S4c(a)：配置 modelScopedKey 后，模型调用以服务端会话归属到达 modelgw（两会话分别归属）", async () => {
	const env = await startStack({ scoped: true });
	const alice = await connect(env, "&actor=alice@corp");
	await alice.waitFor(() => alice.find("session.ready") !== undefined);
	const aliceSession = alice.find("session.ready")!.sessionId;
	alice.send({ type: "prompt", text: "修复 alice 的问题" });
	await alice.waitFor(() => alice.events.some((e) => e.type === "agent.end" && !e.willRetry));

	const bob = await connect(env, "&actor=bob@corp");
	await bob.waitFor(() => bob.find("session.ready") !== undefined);
	const bobSession = bob.find("session.ready")!.sessionId;
	bob.send({ type: "prompt", text: "修复 bob 的问题" });
	await bob.waitFor(() => bob.events.some((e) => e.type === "agent.end" && !e.willRetry));

	assert.ok(await waitFor(() => env.modelGw.ledger.listEntries().some((e) => e.sessionId === bobSession)), "账本应已落行");
	const entries = env.modelGw.ledger.listEntries();
	const bySession = new Map(entries.map((e) => [e.sessionId, e]));
	assert.ok(bySession.has(aliceSession), `alice 会话应有账本记录：${entries.map((e) => e.sessionId).join(",")}`);
	assert.ok(bySession.has(bobSession), "bob 会话应有账本记录");
	const a = bySession.get(aliceSession)!;
	const b = bySession.get(bobSession)!;
	// 归属三元组 = 服务端会话归属：tenant=owner principal，team=resolveScope 配置的 team，
	// sessionId=网关 sessionId —— 客户端头/输入零参与（归属只可能来自网关签发的 scoped token）
	assert.equal(a.tenant, "alice@corp");
	assert.equal(a.team, "platform");
	assert.equal(b.tenant, "bob@corp");
	assert.equal(b.team, "platform");
	assert.notEqual(a.sessionId, b.sessionId);
	// operationId = jti:服务端 UUID（note-1 新格式），且两会话互不相同
	for (const e of entries) assert.ok(e.operationId.includes(":"), `operationId 应带 jti:uuid 形态：${e.operationId}`);
	assert.notEqual(a.operationId, b.operationId);
});

// ── (b) 静态 proxyToken 退出模型通道；密钥不泄漏 ──────────

test("S4c(b)：scoped 模式下静态 proxyToken 不再是模型通道的 Authorization；密钥字节不进审计/客户端事件", async () => {
	const env = await startStack({ scoped: true });
	const c = await connect(env, "&actor=carol@corp");
	await c.waitFor(() => c.find("session.ready") !== undefined);
	c.send({ type: "prompt", text: "跑一次模型调用" });
	await c.waitFor(() => c.events.some((e) => e.type === "agent.end" && !e.willRetry));
	assert.ok(await waitFor(() => env.modelGw.ledger.listEntries().length > 0));

	// 若 Authorization 仍是静态 proxyToken，账本会记 modelgw 的 defaultTeam（"default"）；
	// 记到 resolveScope 的 team 即证明上行的是网关签发的 scoped token。
	const entries = env.modelGw.ledger.listEntries();
	assert.ok(entries.length > 0);
	for (const e of entries) assert.equal(e.team, "platform", `scoped 模式的账本归属必须是会话 team，实际 ${e.team}`);

	// modelgw 的静态 token 面未被放宽：直接持静态 proxyToken 仍可用、归属 default
	const st = await call(`${env.mgwUrl}/chat/completions`, { messages: [] }, { authorization: `Bearer ${PROXY_TOKEN}` });
	assert.equal(st.status, 200);
	await st.text();
	assert.ok(env.modelGw.ledger.listEntries().some((e) => e.team === "default"), "静态 token 直连仍归属 defaultTeam（既有行为未放宽）");

	// 密钥字节（hex/base64 两种文本形态）与静态 proxyToken 都不得进审计文件与客户端事件
	const keyHex = env.scopedKey.toString("hex");
	const keyB64 = env.scopedKey.toString("base64url");
	for (const [name, raw] of [["gateway-audit", readFileSync(env.gwAuditFile, "utf8")], ["modelgw-audit", readFileSync(env.mgwAuditFile, "utf8")], ["client-events", JSON.stringify(c.events)]] as const) {
		assert.ok(!raw.includes(keyHex), `${name} 不得含 scoped 密钥 hex`);
		assert.ok(!raw.includes(keyB64), `${name} 不得含 scoped 密钥 base64url`);
		assert.ok(!raw.includes(PROXY_TOKEN), `${name} 不得含静态 proxyToken 原文`);
	}
});

// ── (c) 未配置 modelScopedKey：行为不变 ────────────────────

test("S4c(c)：未配置 modelScopedKey 时模型通道行为不变（静态 proxyToken 归属 defaultTeam）", async () => {
	const env = await startStack({ defaultTeam: "legacy-static" });
	const c = await connect(env, "&actor=dave@corp");
	await c.waitFor(() => c.find("session.ready") !== undefined);
	c.send({ type: "prompt", text: "普通会话" });
	await c.waitFor(() => c.events.some((e) => e.type === "agent.end" && !e.willRetry));
	assert.ok(await waitFor(() => env.modelGw.ledger.listEntries().length > 0));

	const entries = env.modelGw.ledger.listEntries();
	assert.ok(entries.length > 0);
	for (const e of entries) {
		assert.equal(e.team, "legacy-static", "无 scoped 密钥时走静态 token，归属 modelgw defaultTeam");
		assert.equal(e.sessionId, "unknown", "静态 token 的 sessionId 仍是 modelgw 既有缺省");
	}
});

// ── 启动期 fail-closed：归属字段不可签发 ──────────────────

test("S4c：归属字段非法（不可 mint）时会话启动即 fail-closed，不拖到首次模型调用", async () => {
	const env = await startStack({ scoped: true });
	const c = await connect(env, "&actor=bad%20actor"); // 空格不在归属字段字符集内
	await c.waitFor(() => c.find("error") !== undefined);
	const err = c.find("error")!;
	assert.match(err.message, /modelScopedKey 归属字段非法/, `实际：${err.message}`);
	assert.equal(env.modelGw.ledger.listEntries().length, 0, "坏归属会话不得产生任何模型调用/账本记录");
});

// ── (d) note①：重启后同一 scoped token 不撞账本主键 ───────

test("S4c/note-1：重启后同一 scoped token 复用不再撞账本主键，旧记录不被覆盖", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s4c-note1-"));
	const ledgerFile = join(dir, "budget.sqlite");
	const key = randomBytes(32);
	// 显式固定 jti：重启前后用同一枚 token（jti 复用），正是 note-1 描述的撞键形态
	const token = mintScopedToken(key, { tenant: "t1", team: "team-j", sessionId: "s-1", ttlMs: 600_000, jti: "fixed-jti-1" });
	const up1 = await startFakeUpstream();
	const mk = (up: FakeUpstream) =>
		new ModelGateway({
			port: 0, host: "127.0.0.1", token: "gw-token",
			upstreams: [{ id: "u", baseUrl: up.url, apiKey: "k" }],
			egressAllowlist: [up.host], scopedTokenKey: key, ledgerFile, maxOutputTokens: 100,
		});
	const gw1 = mk(up1);
	cleanups.push(() => gw1.close());
	const p1 = await gw1.listen();
	const res1 = await call(`http://127.0.0.1:${p1}/v1/chat/completions`, { messages: [] }, { authorization: `Bearer ${token}` });
	assert.equal(res1.status, 200);
	await res1.text();
	const firstOp = gw1.ledger.listEntries()[0]!.operationId;
	assert.equal(gw1.ledger.listEntries()[0]!.status, "settled");
	await gw1.close(); // 正常关停（无崩溃残留；cleanups 二次 close 幂等）

	const up2 = await startFakeUpstream();
	const gw2 = mk(up2); // 同一 ledgerFile + 同一 scopedTokenKey 重开（模拟网关重启）
	cleanups.push(() => gw2.close());
	const p2 = await gw2.listen();
	const res2 = await call(`http://127.0.0.1:${p2}/v1/chat/completions`, { messages: [] }, { authorization: `Bearer ${token}` });
	assert.equal(res2.status, 200, "重启后同一 jti 复用必须成功（旧实现进程内序号从 1 重来 → jti:1 撞 PRIMARY KEY → 502）");
	await res2.text();

	const entries = gw2.ledger.listEntries();
	assert.equal(entries.length, 2, "两次请求各一行，不覆盖");
	assert.ok(entries.every((e) => e.operationId.startsWith("fixed-jti-1:")), "operationId 保留 jti 前缀归因");
	assert.notEqual(entries[0]!.operationId, entries[1]!.operationId);
	const original = gw2.ledger.entry(firstOp)!;
	assert.equal(original.status, "settled");
	assert.equal(original.input, 100, "旧记录数值不被覆盖");
	assert.equal(original.output, 20);
});

// ── (d) note③：4xx 恰逢中止 → release 口径不变 + 补中止审计 ──

test("S4c/note-3：4xx 到达恰逢超时中止 → 额度仍 release，且补上中止审计", async () => {
	const up = await startFakeUpstream((_req, res) => {
		// 只回 4xx 响应头、body 悬挂 —— 迫使 first_token deadline 与 4xx 状态并存到达。
		// 必须显式 flushHeaders：Node 不会自动冲出响应头（S4a deadline 例2 同款教训），
		// 不冲的话网关的 fetch 永远等不到头 → 变成 connect 超时，测不到 note-3 竞态。
		res.writeHead(400, { "content-type": "application/json" });
		res.flushHeaders();
	});
	const auditFile = join(mkdtempSync(join(tmpdir(), "s4c-note3-")), "n3.jsonl");
	const audit = AuditLog.open(auditFile);
	cleanups.push(() => audit.close());
	const key = randomBytes(32);
	const gw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "u", baseUrl: up.url, apiKey: "k" }],
		egressAllowlist: [up.host], scopedTokenKey: key, maxOutputTokens: 100,
		deadlines: { connectMs: 2_000, firstTokenMs: 150, idleMs: 5_000, totalMs: 10_000 },
		audit,
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	const token = mintScopedToken(key, { tenant: "t1", team: "team-n3", sessionId: "s", ttlMs: 60_000 });
	const res = await call(`http://127.0.0.1:${port}/v1/chat/completions`, { messages: [] }, { authorization: `Bearer ${token}` });
	await res.text().catch(() => "aborted");

	// 客户端看到截断先于网关收尾落账：轮询收敛再断言
	assert.ok(await waitFor(() => gw.ledger.listEntries()[0]?.status === "released"), "4xx=上游明确未接受 → release（额度口径不变）");
	const e = gw.ledger.listEntries()[0]!;
	assert.equal(gw.usedTokens("team-n3"), 0);
	const entries = await auditEntries(auditFile);
	assert.ok(
		entries.some((ev) => ev.summary.includes("上游 deadline 超时中止（segment=first_token）")),
		`note-3：竞态组合必须留下中止审计，实际：${entries.map((ev) => ev.summary).join(" | ")}`,
	);
});

// ── production 态势：缺 modelScopedKey 留痕（不拒启） ─────

test("S4c：production 缺 modelScopedKey 启动留固定类别态势审计；配置后不留", async () => {
	const mkProduction = async (modelScopedKey?: Buffer) => {
		const dir = mkdtempSync(join(tmpdir(), "s4c-prod-"));
		const auditFile = join(dir, "audit.jsonl");
		const gw = new Gateway({
			mode: "production",
			port: 0,
			host: "127.0.0.1",
			auth: {
				authenticate: async () => ({ id: "https://idp|u", issuer: "https://idp", subject: "u", groups: [], expiresAt: Date.now() + 3_600_000 }),
			},
			allowedHosts: ["gw.internal"],
			allowedOrigins: ["https://gw.internal"],
			resolveScope: () => ({ repo: "r", team: "t" }),
			backend: new DockerBackend({ image: "test-image", repoRoot: REPO, network: "none", user: "10001:10001" }),
			policyFile: join(REPO, "config/policy.yaml"),
			auditFile,
			workspaceRoot: join(dir, "workspaces"),
			webRoot: join(REPO, "web"),
			wiring: { proxyToken: PROXY_TOKEN, modelGatewayUrl: "http://127.0.0.1:1/v1", model: "m" },
			...(modelScopedKey ? { modelScopedKey } : {}),
		});
		// 不进 cleanups：用例内显式 close 恰一次（Gateway.close 无重入门闩，避免双重 close）
		return { gw, auditFile };
	};

	const missing = await mkProduction();
	await missing.gw.close();
	const entriesMissing = await auditEntries(missing.auditFile);
	assert.ok(
		entriesMissing.some((e) => e.summary.includes("production 未配置 modelScopedKey")),
		"缺失必须留痕（选择「明确记录」而非启动即拒；理由见实现注释）",
	);

	const configured = await mkProduction(randomBytes(32));
	await configured.gw.close();
	const entriesConfigured = await auditEntries(configured.auditFile);
	assert.ok(!entriesConfigured.some((e) => e.summary.includes("production 未配置 modelScopedKey")), "配置后不得误报");
});
