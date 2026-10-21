import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BudgetLedger } from "../src/modelgw/budget-ledger.ts";
import { ModelGateway } from "../src/modelgw/server.ts";
import {
	mintScopedToken,
	SCOPED_TOKEN_AUDIENCE,
	verifyScopedToken,
} from "../src/modelgw/scoped-token.ts";

// S4b：持久预算账本 + 可信归属验收（handoff §4.3、coverage s4-persistent-budget）。
// 上游全部是真实本地 http fake（127.0.0.1），账本用临时目录文件；不 mock 掉被测语义。

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups) await c();
});

const KEY = randomBytes(32);

function mint(team: string, sessionId = "s", opts: { ttlMs?: number; now?: number; key?: Buffer } = {}): string {
	return mintScopedToken(opts.key ?? KEY, { tenant: "tenant-1", team, sessionId, ttlMs: opts.ttlMs ?? 60_000, now: opts.now });
}

async function sleep(ms: number): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (cond()) return true;
		await sleep(10);
	}
	return cond();
}

interface FakeUpstream {
	url: string;
	host: string;
	readonly seen: { body: string }[];
}

/** 可编程假上游：缺省回标准 SSE + usage 100/20/120，并带 x-request-id */
async function startFake(handler?: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<FakeUpstream> {
	const seen: { body: string }[] = [];
	const srv = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			seen.push({ body });
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
	return { url: `http://127.0.0.1:${port}/v1`, host: "127.0.0.1", seen };
}

async function startGateway(
	up: FakeUpstream,
	opts: Partial<ConstructorParameters<typeof ModelGateway>[0]> = {},
): Promise<{ gw: ModelGateway; ledgerFile: string; url: string }> {
	const ledgerFile = join(mkdtempSync(join(tmpdir(), "mgwb-")), "budget.sqlite");
	const gw = new ModelGateway({
		port: 0,
		host: "127.0.0.1",
		token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up.url, apiKey: "upstream-secret-key" }],
		egressAllowlist: [up.host],
		scopedTokenKey: KEY,
		ledgerFile,
		...opts,
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();
	return { gw, ledgerFile, url: `http://127.0.0.1:${port}/v1/chat/completions` };
}

function call(url: string, body: unknown, headers: Record<string, string> = {}) {
	return fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

/** 预留估算口径复刻（测试预期用；真口径在 server.ts：ceil(bodyBytes/4) + maxOutput） */
function estimate(body: string, maxOutput: number): number {
	return Math.ceil(Buffer.byteLength(body, "utf8") / 4) + maxOutput;
}

const BODY = { messages: [] };
const BODY_JSON = JSON.stringify(BODY); // '{"messages":[]}' — 15 字节

// ── scoped token：可信归属 ─────────────────────────────────

test("S4b 单元：mintScopedToken/verifyScopedToken 往返与固定类别", () => {
	const key = randomBytes(32);
	const token = mintScopedToken(key, { tenant: "t", team: "dev", sessionId: "sess|9", ttlMs: 1_000 });
	const v = verifyScopedToken(token, key);
	assert.ok(v.ok, "合法 token 必须通过");
	if (v.ok) {
		assert.equal(v.identity.tenant, "t");
		assert.equal(v.identity.team, "dev");
		assert.equal(v.identity.sessionId, "sess|9");
		assert.ok(v.identity.jti.length > 0);
	}
	const wrongKey = verifyScopedToken(token, randomBytes(32));
	assert.equal(wrongKey.ok, false);
	if (!wrongKey.ok) assert.equal(wrongKey.reason, "bad_signature");
	const expired = verifyScopedToken(
		mintScopedToken(key, { tenant: "t", team: "d", sessionId: "s", ttlMs: 1_000, now: Date.now() - 60_000 }),
		key,
	);
	assert.equal(expired.ok, false);
	if (!expired.ok) assert.equal(expired.reason, "expired");
	// 弱密钥/坏归属字段：签发侧就拒绝，不把坏 token 留给验签去报
	assert.throws(() => mintScopedToken(randomBytes(16), { tenant: "t", team: "d", sessionId: "s", ttlMs: 1000 }), /scopedTokenKey/);
	assert.throws(() => mintScopedToken(key, { tenant: "t team", team: "d", sessionId: "s", ttlMs: 1000 }), /tenant/);
});

test("S4b 负控：过期 / aud 错 / 篡改 / 错误 key / 格式错 一律 401 + 上游零调用", async () => {
	const up = await startFake();
	const { url } = await startGateway(up, { scopedTokenKey: KEY });

	const payload = (aud: string) =>
		Buffer.from(JSON.stringify({ aud, tenant: "t", team: "x", sessionId: "s", exp: Math.floor(Date.now() / 1000) + 60, jti: "j" }), "utf8").toString(
			"base64url",
		);
	const sign = (body: string, key: Buffer) => `${body}.${createHmac("sha256", key).update(body, "utf8").digest("base64url")}`;
	const good = payload(SCOPED_TOKEN_AUDIENCE);

	const cases: [string, string][] = [
		["过期", mint("x", "s", { ttlMs: 60_000, now: Date.now() - 120_000 })],
		["aud 错", sign(payload("other-service"), KEY)],
		["篡改 payload", `${good.slice(0, -2)}xx.${createHmac("sha256", KEY).update(good, "utf8").digest("base64url")}`],
		["错误 key", mint("x", "s", { key: randomBytes(32) })],
		["格式错（JWT 三段）", `${sign(good, KEY)}.${good}`],
		["完全不是 token", "some-static-looking-string"],
	];
	for (const [name, token] of cases) {
		const res = await call(url, BODY, { authorization: `Bearer ${token}` });
		assert.equal(res.status, 401, `${name} 必须 401`);
		assert.match(await res.text(), /未授权/, `${name} 公共响应只有固定文案`);
	}
	assert.equal(up.seen.length, 0, "任何负控都不得到达上游");
});

test("S4b 正控：scoped token 归属 + 完整流按真实 usage settle（替换预留）", async () => {
	const up = await startFake();
	const { gw, url } = await startGateway(up, { maxOutputTokens: 100 });
	const res = await call(url, BODY, { authorization: `Bearer ${mint("team-a", "sess-1")}` });
	assert.equal(res.status, 200);
	await res.text();

	assert.equal(up.seen.length, 1, "上游恰被调用一次");
	// 结算替换预留：占用 = 真实 usage 120，而不是预留估计
	assert.equal(gw.usedTokens("team-a"), 120);
	assert.equal(gw.settledTokens("team-a"), 120);
	const entries = gw.ledger.listEntries();
	assert.equal(entries.length, 1);
	const e = entries[0]!;
	assert.equal(e.status, "settled");
	assert.equal(e.tenant, "tenant-1");
	assert.equal(e.team, "team-a");
	assert.equal(e.sessionId, "sess-1");
	assert.equal(e.input, 100);
	assert.equal(e.output, 20);
	assert.equal(e.priceVersion, "0", "价格版本字段必须落库（本轮价格为 0）");
	assert.equal(e.providerRequestId, "up-req-1", "上游请求 id 入账");
	assert.equal(e.reservedTokens, estimate(BODY_JSON, 100), "预留 = 输入估计 + 最大输出");
});

// ── 并发预留：不超卖 ─────────────────────────────────────

test("S4b：并发 N 个请求预留不超卖 —— 配额恰够 2 个 → 恰 2 个转发、其余 429", async () => {
	let forwarded = 0;
	const up = await startFake((_req, res, _body) => {
		forwarded++;
		// 上游慢 150ms：让全部 6 个请求都先完成预留，再开始结算
		setTimeout(() => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(`data: ${JSON.stringify({ choices: [{}], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`);
			res.end("data: [DONE]\n\n");
		}, 150);
	});
	// 预留 = ceil(15/4)+100 = 104；配额 208 = 恰好两个请求
	const { gw, url } = await startGateway(up, {
		quotas: [{ team: "cap", maxTotalTokens: 2 * estimate(BODY_JSON, 100) }],
		maxOutputTokens: 100,
	});
	const token = mint("cap");
	const responses = await Promise.all(Array.from({ length: 6 }, () => call(url, BODY, { authorization: `Bearer ${token}` })));
	const statuses = responses.map((r) => r.status).sort();
	await Promise.all(responses.map((r) => r.text()));

	assert.deepEqual(statuses, [200, 200, 429, 429, 429, 429]);
	assert.equal(forwarded, 2, "上游 fake 计数：只有 2 个请求真正转发");
	// 全部结算后：占用 = 2 × 真实 10；在途预留曾顶满配额（由 4 个 429 证明）
	assert.equal(gw.usedTokens("cap"), 20);
});

// ── usage_unknown：不写成 0，额度仍被占 ───────────────────

test("S4b：上游中途断流（idle 超时中止）→ usage_unknown，预留继续占额度；对账释放后归还", async () => {
	const up = await startFake((_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "首块" } }] })}\n\n`);
		// 之后静默：等网关 idle deadline 中止
	});
	const { gw, url } = await startGateway(up, {
		maxOutputTokens: 100,
		deadlines: { connectMs: 2000, firstTokenMs: 2000, idleMs: 200, totalMs: 10_000 },
	});
	const res = await call(url, BODY, { authorization: `Bearer ${mint("team-u")}` });
	const text = await res.text().catch(() => "aborted");
	assert.ok(!text.includes("[DONE]"), "流必须被截断而非正常结束");
	assert.ok(await waitFor(() => gw.ledger.listEntries()[0]?.status === "usage_unknown"), "应记 usage_unknown");
	const e = gw.ledger.listEntries()[0]!;
	assert.equal(e.input, 0, "usage_unknown 不写假 usage");
	const hold = estimate(BODY_JSON, 100);
	assert.equal(gw.usedTokens("team-u"), hold, "usage_unknown 保守保留预留");
	assert.equal(gw.settledTokens("team-u"), 0, "中止不得按 0 假成功结算");
	// 对账确认未计费 → 释放归还
	assert.ok(gw.ledger.reconcile(e.operationId, "release"));
	assert.equal(gw.usedTokens("team-u"), 0);
});

test("S4b：connect 超时（上游永不响应）→ 504 + usage_unknown 保留预留", async () => {
	const up = await startFake(() => {
		// 接受连接但永不回响应头
	});
	const { gw, url } = await startGateway(up, {
		maxOutputTokens: 100,
		deadlines: { connectMs: 150, firstTokenMs: 5000, idleMs: 5000, totalMs: 10_000 },
	});
	const res = await call(url, BODY, { authorization: `Bearer ${mint("team-c")}` });
	assert.equal(res.status, 504);
	await res.text();
	assert.ok(await waitFor(() => gw.ledger.listEntries()[0]?.status === "usage_unknown"));
	assert.equal(gw.usedTokens("team-c"), estimate(BODY_JSON, 100), "预留保守保留（受理与否未知）");
});

// ── 持久化与恢复 ─────────────────────────────────────────

test("S4b：重启（同一 ledgerFile 新建网关）后已用量与 usage_unknown 都还在", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mgwb-restart-"));
	const ledgerFile = join(dir, "budget.sqlite");
	const deadlines = { connectMs: 2000, firstTokenMs: 2000, idleMs: 200, totalMs: 10_000 };

	const up1 = await startFake();
	const gw1 = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up1.url, apiKey: "k" }],
		egressAllowlist: [up1.host], scopedTokenKey: KEY, ledgerFile, maxOutputTokens: 100,
	});
	cleanups.push(() => gw1.close());
	const port1 = await gw1.listen();
	const url1 = `http://127.0.0.1:${port1}/v1/chat/completions`;
	await (await call(url1, BODY, { authorization: `Bearer ${mint("team-r", "s1")}` })).text(); // settle 120
	assert.equal(gw1.usedTokens("team-r"), 120);
	await gw1.close(); // 正常关停（close 幂等，cleanups 二次调用无害）

	// 用同一 ledgerFile 重开：先一笔 usage_unknown（上游中途静默）
	const up2 = await startFake((_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write("data: x\n\n");
	});
	const gw2 = new ModelGateway({
		port: 0, host: "127.0.0.1", token: "gw-token",
		upstreams: [{ id: "azure", baseUrl: up2.url, apiKey: "k" }],
		egressAllowlist: [up2.host], scopedTokenKey: KEY, ledgerFile, maxOutputTokens: 100, deadlines,
	});
	cleanups.push(() => gw2.close());
	const port2 = await gw2.listen();
	const url2 = `http://127.0.0.1:${port2}/v1/chat/completions`;
	await (await call(url2, BODY, { authorization: `Bearer ${mint("team-r", "s2")}` })).text().catch(() => "aborted");
	assert.ok(await waitFor(() => gw2.ledger.listEntries().some((e) => e.status === "usage_unknown")));

	const entries = gw2.ledger.listEntries();
	assert.equal(entries.length, 2, "重启后两笔操作都在");
	const settled = entries.find((e) => e.status === "settled")!;
	assert.equal(settled.input, 100, "已结算用量跨重启保留");
	assert.equal(gw2.usedTokens("team-r"), 120 + estimate(BODY_JSON, 100), "已用量 + 在途 usage_unknown 预留都在");
});

test("S4b：崩溃残留的 reserved 在启动恢复时标 usage_unknown（继续占额度，不释放）", async () => {
	const up = await startFake();
	const dir = mkdtempSync(join(tmpdir(), "mgwb-crash-"));
	const ledgerFile = join(dir, "budget.sqlite");
	// 模拟上个进程：预留后没来得及 settle/release 就崩溃
	const crashed = new BudgetLedger(ledgerFile);
	crashed.reserve({ operationId: "crash-op-1", tenant: "t", team: "team-x", sessionId: "s", model: "m", upstream: "azure", reservedTokens: 500 });
	crashed.close();

	const { gw } = await startGateway(up, { ledgerFile, maxOutputTokens: 100 });
	const e = gw.ledger.entry("crash-op-1")!;
	assert.equal(e.status, "usage_unknown", "启动恢复标记");
	assert.equal(gw.usedTokens("team-x"), 500, "恢复后的 usage_unknown 继续占额度");
	// 对账：给出真实 usage → 结算；额度变为真实用量
	assert.ok(gw.ledger.reconcile("crash-op-1", { input: 30, output: 10 }));
	assert.equal(gw.usedTokens("team-x"), 40);
	assert.equal(gw.ledger.entry("crash-op-1")!.status, "settled");
});

// ── 幂等与对账 ───────────────────────────────────────────

test("S4b：同一 operationId 不重复记账（settle 幂等 / 终态不复活 / reserve 主键冲突）", () => {
	const ledger = new BudgetLedger(); // :memory:
	cleanups.push(() => ledger.close());
	ledger.reserve({ operationId: "op-1", tenant: "t", team: "g", sessionId: "s", model: "m", upstream: "u", reservedTokens: 1000 });
	assert.ok(ledger.settle("op-1", { input: 10, output: 5 }));
	assert.ok(ledger.settle("op-1", { input: 999, output: 999 }), "重复 settle 幂等返回 true");
	const e = ledger.entry("op-1")!;
	assert.equal(e.input, 10, "不得重复/覆盖记账");
	assert.equal(e.output, 5);
	assert.equal(ledger.committedTokens("g"), 15);
	assert.equal(ledger.settle("op-2", { input: 1, output: 1 }), false, "未知 operationId 返回 false");
	assert.equal(ledger.release("op-1"), false, "settled 终态不得再 release");
	// 重复 reserve 同一 operationId：PRIMARY KEY 冲突直接抛（程序错误，不是静默双记账）
	assert.throws(() =>
		ledger.reserve({ operationId: "op-1", tenant: "t", team: "g", sessionId: "s", model: "m", upstream: "u", reservedTokens: 1 }),
	);
});

test("S4b：reconcile 结算与释放后额度变化正确", () => {
	const ledger = new BudgetLedger();
	cleanups.push(() => ledger.close());
	ledger.reserve({ operationId: "op-a", tenant: "t", team: "g", sessionId: "s", model: "m", upstream: "u", reservedTokens: 400 });
	ledger.reserve({ operationId: "op-b", tenant: "t", team: "g", sessionId: "s", model: "m", upstream: "u", reservedTokens: 400 });
	ledger.markUsageUnknown("op-a");
	ledger.markUsageUnknown("op-b");
	assert.equal(ledger.committedTokens("g"), 800, "两条 usage_unknown 都占预留");
	assert.ok(ledger.reconcile("op-a", { input: 300, output: 50 }), "对账结算");
	assert.ok(ledger.reconcile("op-b", "release"), "对账确认未计费");
	assert.equal(ledger.committedTokens("g"), 350, "300+50 真实用量 + released 不占");
	assert.equal(ledger.settledTokens("g"), 350);
});

// ── 配置与口径 ───────────────────────────────────────────

test("S4b：strictBudget=true 缺 ledgerFile 启动即炸；配了才能启动", async () => {
	const up = await startFake();
	assert.throws(
		() =>
			new ModelGateway({
				port: 0, host: "127.0.0.1", token: "t",
				upstreams: [{ id: "x", baseUrl: up.url, apiKey: "k" }],
				egressAllowlist: [up.host],
				strictBudget: true,
			}),
		/ledgerFile/,
	);
	const { url } = await startGateway(up, { strictBudget: true });
	assert.equal((await fetch(new URL("/healthz", url))).status, 200);
});

test("S4b：cache 字段归一化 —— OpenAI 风格 prompt_tokens 已含 cached，不双算", async () => {
	const up = await startFake((_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(
			`data: ${JSON.stringify({
				choices: [{}],
				usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 80 } },
			})}\n\n`,
		);
		res.end("data: [DONE]\n\n");
	});
	const { gw, url } = await startGateway(up, { maxOutputTokens: 100 });
	await (await call(url, BODY, { authorization: `Bearer ${mint("team-cache")}` })).text();
	const e = gw.ledger.listEntries()[0]!;
	assert.equal(e.cacheRead, 80, "cacheRead 只入账本字段");
	assert.equal(e.input, 100);
	assert.equal(gw.usedTokens("team-cache"), 120, "占用 = input+output，cache 不叠加（避免双算）");
});

test("S4b：上游 4xx（未计费）→ 预留释放，占用归零", async () => {
	const up = await startFake();
	const { gw, url } = await startGateway(up, {
		maxOutputTokens: 100,
		fetchImpl: (async () => new Response('{"error":{"message":"context_length_exceeded"}}', { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
	});
	const res = await call(url, BODY, { authorization: `Bearer ${mint("team-4xx")}` });
	assert.equal(res.status, 400, "上游状态码原样透传");
	await res.text();
	const e = gw.ledger.listEntries()[0]!;
	assert.equal(e.status, "released", "4xx 明确未接受 → release");
	assert.equal(gw.usedTokens("team-4xx"), 0);
	assert.equal(gw.settledTokens("team-4xx"), 0);
});
