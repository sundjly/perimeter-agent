import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import {
	createServer,
	request as httpRequest,
	type ClientRequest,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AuditLog } from "../src/audit/log.ts";
import { ModelGateway } from "../src/modelgw/server.ts";
import { GCP_TOKEN_HOST, clearTokenCache } from "../src/modelgw/upstream-auth.ts";

// S4a：模型网关四段 deadline（connect/首 token/idle/总时长）、写回背压、断流取消上游。
// 上游全部是真实本地 http fake（127.0.0.1），deadline 注入小值保证用例秒级；
// 所有 server / 定时器在测试结束清理，node --test 能自然退出。

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups) await c();
});

const SSE_HEADERS = { "content-type": "text/event-stream" };

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (cond()) return true;
		await sleep(stepMs);
	}
	return cond();
}

/** 轮询直到计数值连续两次采样不变（背压完全传播、输出真正停住），返回稳定值 */
async function untilStable(get: () => number, timeoutMs = 3000): Promise<number> {
	let prev = get();
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await sleep(100);
		const cur = get();
		if (cur === prev) return cur;
		prev = cur;
	}
	return prev;
}

interface FakeUpstream {
	url: string;
	host: string;
	/** 网关侧是否已掐断连接（fetch abort 会传播为 socket close） */
	closed: () => boolean;
	/** 完整收到的请求（req end 后计数） */
	readonly seen: { body: string }[];
}

/** 可编程假上游：handler 完全自控响应；连接关闭经 res/req 'close' 观测 */
async function startFake(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<FakeUpstream> {
	let closed = false;
	const seen: { body: string }[] = [];
	const srv = createServer((req, res) => {
		const markClosed = () => {
			closed = true;
		};
		res.on("close", markClosed);
		req.on("close", markClosed);
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			seen.push({ body });
			handler(req, res);
		});
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
	const port = (srv.address() as { port: number }).port;
	return { url: `http://127.0.0.1:${port}/v1`, host: "127.0.0.1", closed: () => closed, seen };
}

async function startGateway(
	up: FakeUpstream,
	opts: Partial<ConstructorParameters<typeof ModelGateway>[0]> = {},
): Promise<{ gw: ModelGateway; auditFile: string; url: string }> {
	const auditFile = join(mkdtempSync(join(tmpdir(), "mgwd-")), "audit.jsonl");
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
	return { gw, auditFile, url: `http://127.0.0.1:${port}/v1/chat/completions` };
}

function call(url: string, body: unknown, headers: Record<string, string> = {}) {
	return fetch(url, {
		method: "POST",
		headers: { authorization: "Bearer gw-token", "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

interface RawResult {
	status?: number;
	text: string;
	/** 连接是否在响应正常结束前被掐断 */
	aborted: boolean;
	completed: boolean;
}

/** 一次性拿完整响应，能区分「正常结束」与「流被截断」 */
function rawCall(url: string, body: string): Promise<RawResult> {
	return new Promise((resolve) => {
		const u = new URL(url);
		const req = httpRequest(
			{
				host: u.hostname,
				port: u.port,
				path: u.pathname,
				method: "POST",
				headers: { authorization: "Bearer gw-token", "content-type": "application/json" },
			},
			(res) => {
				let text = "";
				let settled = false;
				const finish = (aborted: boolean) => {
					if (settled) return;
					settled = true;
					resolve({ status: res.statusCode, text, aborted, completed: !aborted });
				};
				res.on("data", (c) => (text += c));
				res.on("end", () => finish(false));
				res.on("aborted", () => finish(true));
				res.on("error", () => finish(true));
			},
		);
		req.on("error", () => resolve({ text: "", aborted: true, completed: false }));
		req.end(body);
	});
}

/** 流式客户端：首批数据到达后 resolve，可 pause / resume / destroy —— 用于背压与断开测试 */
function streamingClient(url: string, body: string) {
	const u = new URL(url);
	let text = "";
	let res: IncomingMessage | null = null;
	let req: ClientRequest | null = null;
	let gotFirst = false;
	let settled = false;
	let resolveFinished: (r: RawResult) => void = () => {};
	const firstData = new Promise<void>((r) => {
		const request = httpRequest(
			{
				host: u.hostname,
				port: u.port,
				path: u.pathname,
				method: "POST",
				headers: { authorization: "Bearer gw-token", "content-type": "application/json" },
			},
			(message) => {
				res = message;
				message.on("data", (c) => {
					text += c;
					if (!gotFirst) {
						gotFirst = true;
						r();
					}
				});
				const finish = (aborted: boolean) => {
					if (settled) return;
					settled = true;
					resolveFinished({ status: message.statusCode, text, aborted, completed: !aborted });
				};
				message.on("end", () => finish(false));
				message.on("aborted", () => finish(true));
				message.on("error", () => finish(true));
			},
		);
		request.on("error", () => {
			if (!gotFirst) r();
			if (!settled) {
				settled = true;
				resolveFinished({ text, aborted: true, completed: false });
			}
		});
		request.end(body);
		req = request;
	});
	return {
		firstData,
		finished: new Promise<RawResult>((resolve) => {
			resolveFinished = resolve;
		}),
		pause: () => res?.pause(),
		resume: () => res?.resume(),
		destroy: () => req?.destroy(),
	};
}

/** 客户端发出半截 body 后停顿 pauseMs —— 网关应在停顿期内以 408 拒绝（body 读取超时） */
function slowBodyCall(url: string, body: string, pauseMs: number): Promise<RawResult> {
	return new Promise((resolve) => {
		const u = new URL(url);
		const req = httpRequest(
			{
				host: u.hostname,
				port: u.port,
				path: u.pathname,
				method: "POST",
				headers: { authorization: "Bearer gw-token", "content-type": "application/json" },
			},
			(res) => {
				let text = "";
				let settled = false;
				const done = (aborted: boolean) => {
					if (settled) return;
					settled = true;
					resolve({ status: res.statusCode, text, aborted, completed: !aborted });
				};
				res.on("data", (c) => (text += c));
				res.on("end", () => done(false));
				res.on("aborted", () => done(true));
				res.on("error", () => done(true));
			},
		);
		req.on("error", () => {
			// 被网关中途掐断是预期路径；响应已在 response 回调里交付
		});
		const half = Math.floor(body.length / 2);
		req.write(body.slice(0, half));
		setTimeout(() => {
			try {
				req.write(body.slice(half));
				req.end();
			} catch {
				// 连接已被网关断开
			}
		}, pauseMs);
	});
}

async function auditEntries(auditFile: string): Promise<{ kind: string; summary: string }[]> {
	const entries: { kind: string; summary: string }[] = [];
	for await (const e of AuditLog.replay(auditFile)) entries.push({ kind: e.kind, summary: e.summary });
	return entries;
}

/** 有界等待审计条目出现：审计在 abort 收尾链路落盘，与上游 socket 关闭无固定先后 */
async function waitForAudit(
	auditFile: string,
	pred: (e: { kind: string; summary: string }) => boolean,
	timeoutMs = 2000,
): Promise<{ kind: string; summary: string } | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const entries = await auditEntries(auditFile);
		const hit = entries.find(pred);
		if (hit) return hit;
		if (Date.now() >= deadline) return undefined;
		await sleep(10);
	}
}

// ── 四段 deadline：connect/header ──────────────────────────

test("S4a：connect/header 超时 → 504 固定文案、上游连接被中止、审计 segment=connect + usage_unknown", async () => {
	const up = await startFake((_req, _res) => {
		// 接受请求但永不回响应头
	});
	const { url, auditFile, gw } = await startGateway(up, {
		deadlines: { connectMs: 150, firstTokenMs: 5000, idleMs: 5000, totalMs: 10000 },
	});
	const res = await call(url, { messages: [] });
	assert.equal(res.status, 504);
	const text = await res.text();
	assert.match(text, /上游响应超时/, "回给沙箱的是固定文案");
	assert.ok(!text.includes("Error"), "不透传内部错误（AbortError/TimeoutError）");
	assert.ok(await waitFor(() => up.closed()), "超时后网关必须关掉上游连接，释放连接");
	const entries = await auditEntries(auditFile);
	const hit = entries.find((e) => e.summary.includes("segment=connect"));
	assert.ok(hit, "应有 connect 段超时审计");
	assert.ok(hit.summary.includes("usage_unknown"), "中止时计量必须标注 usage_unknown");
	assert.equal(gw.usedTokens("default"), 0, "中止不得计费");
});

// ── 四段 deadline：首 token ────────────────────────────────

test("S4a：首 token 超时 → 已写头的流被终止（非正常结束）、审计 segment=first_token + usage_unknown", async () => {
	const up = await startFake((_req, res) => {
		res.writeHead(200, SSE_HEADERS);
		// Node http 不会自动冲出响应头，必须显式 flush，网关才拿得到头（否则变成 connect 超时）
		res.flushHeaders();
		// body 永远不来，等网关首 token deadline 中止
	});
	const { url, auditFile } = await startGateway(up, {
		deadlines: { connectMs: 5000, firstTokenMs: 150, idleMs: 5000, totalMs: 10000 },
	});
	const out = await rawCall(url, JSON.stringify({ messages: [] }));
	assert.equal(out.status, 200, "响应头已写给客户端");
	assert.equal(out.completed, false, "流必须被终止，而非正常 end");
	const hit = await waitForAudit(auditFile, (e) => e.summary.includes("segment=first_token"));
	assert.ok(hit, "应有 first_token 段超时审计");
	assert.ok(hit.summary.includes("usage_unknown"));
	assert.ok(await waitFor(() => up.closed()), "上游侧必须观测到 abort");
});

// ── 四段 deadline：流 idle ─────────────────────────────────

test("S4a：流 idle 超时 → 已转发部分数据后截断、审计 segment=idle + usage_unknown", async () => {
	const up = await startFake((_req, res) => {
		res.writeHead(200, SSE_HEADERS);
		res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "首块" } }] })}\n\n`);
		// 之后静默，直到网关 idle deadline 中止
	});
	const { url, auditFile } = await startGateway(up, {
		deadlines: { connectMs: 5000, firstTokenMs: 5000, idleMs: 150, totalMs: 10000 },
	});
	const out = await rawCall(url, JSON.stringify({ messages: [] }));
	assert.ok(out.text.includes("首块"), "超时前已收到的数据必须已转发");
	assert.equal(out.completed, false);
	const hit = await waitForAudit(auditFile, (e) => e.summary.includes("segment=idle"));
	assert.ok(hit, "应有 idle 段超时审计");
	assert.ok(hit.summary.includes("usage_unknown"));
	assert.ok(await waitFor(() => up.closed()));
});

// ── 四段 deadline：总时长 ──────────────────────────────────

test("S4a：总时长超时 → 持续滴流的上游被中止、审计 segment=total + usage_unknown（idle 不先触发）", async () => {
	const up = await startFake((_req, res) => {
		res.writeHead(200, SSE_HEADERS);
		res.write("data: tick\n\n");
		// 每 30ms 滴流：idle(500ms) 永远不会触发，只有 total(400ms) 能触发
		const timer = setInterval(() => res.write("data: tick\n\n"), 30);
		res.on("close", () => clearInterval(timer));
	});
	const { url, auditFile } = await startGateway(up, {
		deadlines: { connectMs: 5000, firstTokenMs: 5000, idleMs: 500, totalMs: 400 },
	});
	const out = await rawCall(url, JSON.stringify({ messages: [] }));
	assert.ok(out.text.includes("tick"));
	assert.equal(out.completed, false, "流必须在总时长 deadline 处截断");
	const hit = await waitForAudit(auditFile, (e) => e.summary.includes("segment=total"));
	assert.ok(hit, "应有 total 段超时审计");
	assert.ok(hit.summary.includes("usage_unknown"));
	assert.ok(await waitFor(() => up.closed()));
	const entries = await auditEntries(auditFile);
	assert.ok(!entries.some((e) => e.summary.includes("segment=idle")), "idle 段不应先于 total 触发");
});

// ── 写回背压 ───────────────────────────────────────────────

test("S4a：慢读客户端触发背压 → 网关暂停读上游（缓冲有界），恢复读后完整收到、计量不变", async () => {
	const CHUNK = "x".repeat(64 * 1024);
	const TOTAL = 4 * 1024 * 1024; // 远超任何 socket 缓冲，逼出真实背压
	const trailer =
		"\n" +
		`data: ${JSON.stringify({ choices: [{}], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\n` +
		"data: [DONE]\n\n";
	let sent = 0;
	let sawBackpressure = false;
	let upstreamClosed = false;
	const srv = createServer((_req, res) => {
		res.on("close", () => {
			upstreamClosed = true;
		});
		res.writeHead(200, { "content-type": "application/octet-stream" });
		void (async () => {
			while (sent < TOTAL && !res.destroyed) {
				const ok = res.write(CHUNK);
				sent += CHUNK.length;
				if (!ok) {
					sawBackpressure = true;
					await new Promise<void>((r) => res.once("drain", r));
				}
			}
			if (!res.destroyed) res.end(trailer);
		})();
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
	const port = (srv.address() as { port: number }).port;
	const up: FakeUpstream = { url: `http://127.0.0.1:${port}/v1`, host: "127.0.0.1", closed: () => upstreamClosed, seen: [] };

	const { url, gw, auditFile } = await startGateway(up, {
		deadlines: { connectMs: 2000, firstTokenMs: 2000, idleMs: 5000, totalMs: 20000 },
	});

	const client = streamingClient(url, JSON.stringify({ messages: [] }));
	await client.firstData;
	client.pause(); // 客户端暂停读 → 网关 write 返回 false → 等 drain → 停止读上游
	const stable = await untilStable(() => sent);
	assert.ok(sawBackpressure, "上游必须观测到 write 返回 false（背压经网关逐级传播）");
	assert.ok(stable < TOTAL, "上游必须停在中途，而不是把 4MiB 全部吐进网关内存");
	await sleep(400);
	assert.equal(sent, stable, "客户端暂停读期间上游输出必须保持停止 —— 网关在等 drain，不是无界缓冲");
	client.resume();
	const out = await client.finished;
	assert.equal(out.completed, true, "恢复读后必须正常完成");
	assert.equal(out.text.length, TOTAL + trailer.length, "恢复读后必须完整收到全部字节");
	assert.equal(gw.usedTokens("default"), 10, "完整成功流按 team 计量的行为不变");
	const entries = await auditEntries(auditFile);
	assert.ok(entries.some((e) => e.kind === "usage"), "应有 usage 审计");
	assert.ok(!entries.some((e) => e.summary.includes("usage_unknown")), "正常路径不得出现 usage_unknown");
});

// ── 客户端断开 → 取消上游 ──────────────────────────────────

test("S4a：客户端中途断开 → 上游请求立即被 abort（无僵尸上游）、审计 usage_unknown、不计费", async () => {
	const up = await startFake((_req, res) => {
		res.writeHead(200, SSE_HEADERS);
		res.write("data: first\n\n");
		const timer = setInterval(() => res.write("data: tick\n\n"), 25);
		res.on("close", () => clearInterval(timer));
	});
	const { url, auditFile, gw } = await startGateway(up, {
		deadlines: { connectMs: 2000, firstTokenMs: 2000, idleMs: 5000, totalMs: 20000 },
	});
	const client = streamingClient(url, JSON.stringify({ messages: [] }));
	await client.firstData;
	client.destroy();
	assert.ok(await waitFor(() => up.closed(), 2000), "上游必须观测到连接被关闭（不留僵尸上游请求）");
	const hit = await waitForAudit(auditFile, (e) => e.summary.includes("客户端断开"));
	assert.ok(hit, "应有断开的固定类别审计");
	assert.ok(hit.summary.includes("usage_unknown"));
	assert.equal(gw.usedTokens("default"), 0);
});

// ── 正控：正常流不受影响 ───────────────────────────────────

test("S4a 正控：正常流在 deadline 内完整通过，计量与既有行为一致", async () => {
	const up = await startFake((_req, res) => {
		res.writeHead(200, SSE_HEADERS);
		res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "上游回复" } }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ choices: [{}], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
	const { url, gw, auditFile } = await startGateway(up, {
		deadlines: { connectMs: 1000, firstTokenMs: 1000, idleMs: 1000, totalMs: 5000 },
	});
	const res = await call(url, { model: "azure/gpt-4o", messages: [] }, { "x-perimeter-team": "plat" });
	const text = await res.text();
	assert.match(text, /上游回复/);
	assert.match(text, /\[DONE\]/);
	assert.equal(gw.usedTokens("plat"), 120);
	const entries = await auditEntries(auditFile);
	assert.ok(entries.some((e) => e.kind === "usage" && e.summary.includes("120")), "应有 usage 审计");
	assert.ok(!entries.some((e) => e.summary.includes("usage_unknown")), "正常路径不得出现 usage_unknown");
});

// ── 请求体读取超时 ─────────────────────────────────────────

test("S4a：客户端慢发 body → 读取超时 408 固定文案、请求未达上游、审计 segment=body_read", async () => {
	const up = await startFake((_req, res) => {
		res.writeHead(200, SSE_HEADERS);
		res.end("data: [DONE]\n\n");
	});
	const { url, auditFile } = await startGateway(up, {
		deadlines: { bodyMs: 150, connectMs: 2000, firstTokenMs: 2000, idleMs: 2000, totalMs: 10000 },
	});
	const body = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(4096) }] });
	const out = await slowBodyCall(url, body, 500); // bodyMs=150 < 停顿 500ms
	assert.equal(out.status, 408);
	assert.match(out.text, /请求体读取超时/);
	assert.equal(up.seen.length, 0, "超时请求不得到达上游");
	const entries = await auditEntries(auditFile);
	assert.ok(entries.some((e) => e.summary.includes("segment=body_read")), "应有 body_read 段审计");
});

// ── 换 token 的 fetch 受 deadline 约束 ─────────────────────

test("S4a：换 token 的 fetch 受 connect deadline 约束（signal 传入并被 abort）→ 504 + usage_unknown", async () => {
	clearTokenCache();
	const key = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	}).privateKey;
	let upstreamHits = 0;
	const tokenSignals: AbortSignal[] = [];
	const up = await startFake((_req, res) => {
		upstreamHits += 1;
		res.writeHead(200, SSE_HEADERS);
		res.end("data: [DONE]\n\n");
	});
	const auditFile = join(mkdtempSync(join(tmpdir(), "mgwd-")), "audit.jsonl");
	const audit = AuditLog.open(auditFile);
	cleanups.push(() => audit.close());
	const gw = new ModelGateway({
		port: 0,
		host: "127.0.0.1",
		token: "gw-token",
		upstreams: [{ id: "vertex", baseUrl: up.url, auth: { kind: "gcp", clientEmail: "sa@x", privateKey: key } }],
		egressAllowlist: [up.host, GCP_TOKEN_HOST],
		audit,
		deadlines: { connectMs: 150, firstTokenMs: 5000, idleMs: 5000, totalMs: 10000 },
		fetchImpl: (async (u: string | URL, init?: RequestInit) => {
			if (String(u).includes(GCP_TOKEN_HOST)) {
				tokenSignals.push(init?.signal as AbortSignal);
				// 永不自行返回，但 abort 时立即退出（模拟 fetch 被中止）
				await new Promise<never>((_, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				});
			}
			return fetch(u, init);
		}) as unknown as typeof fetch,
	});
	cleanups.push(() => gw.close());
	const port = await gw.listen();

	const res = await call(`http://127.0.0.1:${port}/v1/chat/completions`, { model: "m", messages: [] });
	assert.equal(res.status, 504);
	assert.match(await res.text(), /上游响应超时/);
	assert.ok(await waitFor(() => tokenSignals[0]?.aborted === true, 2000), "换 token 的 fetch 必须收到 abort");
	assert.equal(upstreamHits, 0, "换 token 失败后上游不得被调用");
	const entries = await auditEntries(auditFile);
	const hit = entries.find((e) => e.summary.includes("segment=connect"));
	assert.ok(hit && hit.summary.includes("usage_unknown"), "认证段超时也要审计 + usage_unknown");
});
