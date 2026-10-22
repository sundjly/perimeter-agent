import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { Gateway } from "../src/gateway/server.ts";
import { HISTORY_MAX_ITEM_BYTES, type Session } from "../src/gateway/session.ts";
import { parseCommand, HISTORY_MAX_PAGE_ITEMS } from "../src/protocol/validate.ts";
import type { ClientEvent, MessageView, SessionView } from "../src/protocol/types.ts";
import { initialState, reduce } from "../web/view-model.js";

/**
 * S5a：初始有界 tail + 旧历史分页（handoff §3.2）。
 *
 * 覆盖：attach 快照有项数/字节上限并附历史元信息；>2MiB 历史不再撞 maxFrameBytes
 * （旧行为是 Outbox 1009 断连）；逐页翻到最早且与权威历史一致（无重复无缺漏）；
 * 分页中途追加新消息不影响（游标=下标+锚定边界消息 id，常态追加稳定）；伪造/篡改/
 * 跨会话游标固定类别拒绝；权威数组重构（durable 压缩模拟）旧游标固定失效不静默错位；
 * viewer 可读、撤权后拿不到数据；单项超大截断标记；parseCommand 校验；共享 reducer
 * 的 prepend 去重。
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MOCK = join(REPO, "tests/fixtures/mock-model.mjs");
const TOKEN = "history-test-token";

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups) await c();
});

interface Env { url: string; gateway: Gateway }

async function startGateway(script: unknown[], extra: Partial<ConstructorParameters<typeof Gateway>[0]> = {}): Promise<Env> {
	const dir = mkdtempSync(join(tmpdir(), "hist-"));
	// 大脚本（多兆历史）经 argv 会撞 E2BIG：fixture 支持 @file 形态，统一走临时文件
	const scriptFile = join(dir, "mock-script.json");
	writeFileSync(scriptFile, JSON.stringify(script));
	const mock = spawn(process.execPath, [MOCK, "0", `@${scriptFile}`], { stdio: ["ignore", "pipe", "inherit"] });
	cleanups.push(() => void mock.kill());
	const port: number = await new Promise((r) => mock.stdout!.once("data", (d) => r(JSON.parse(String(d)).port)));

	const home = mkdtempSync(join(tmpdir(), "pihome-"));
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(
		join(home, ".pi", "agent", "models.json"),
		JSON.stringify({
			providers: {
				mock: {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "dummy",
					compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
					models: [{ id: "mock-model" }],
				},
			},
		}),
	);

	const gateway = new Gateway({
		mode: "demo",
		port: 0,
		host: "127.0.0.1",
		token: TOKEN,
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "workspaces"),
		stateRoot: join(dir, "state"),
		webRoot: join(REPO, "web"),
		model: { baseUrl: `http://127.0.0.1:${port}/v1`, token: "dummy", model: "mock-model" },
		approvalTimeoutMs: 30_000,
		...extra,
	});
	cleanups.push(() => gateway.close());
	const listening = await gateway.listen();
	return { url: `http://127.0.0.1:${listening}`, gateway };
}

interface Client {
	ws: WebSocket;
	events: ClientEvent[];
	controls: { control?: string; message?: string }[];
	/** 原始帧文本（按收到顺序），用于断言快照帧字节 */
	frames: string[];
	readonly closeCode?: number;
	waitFor(pred: () => boolean, ms?: number): Promise<void>;
	find<T extends ClientEvent["type"]>(type: T): Extract<ClientEvent, { type: T }> | undefined;
	send(cmd: unknown): void;
}

async function connect(env: Env, query = ""): Promise<Client> {
	const ws = new WebSocket(`${env.url.replace("http", "ws")}/?token=${TOKEN}${query}`);
	const events: ClientEvent[] = [];
	const controls: { control?: string; message?: string }[] = [];
	const frames: string[] = [];
	let closeCode: number | undefined;
	ws.on("message", (raw) => {
		const text = String(raw);
		const msg = JSON.parse(text) as { type?: string; control?: string; message?: string; event?: ClientEvent };
		if (msg.type === "control") { controls.push(msg); return; }
		frames.push(text);
		events.push(msg.event!);
	});
	ws.on("close", (code) => { closeCode = code; });
	await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
	cleanups.push(() => void ws.close());
	const waitFor = async (pred: () => boolean, ms = 30_000) => {
		const deadline = Date.now() + ms;
		while (!pred()) {
			if (Date.now() > deadline) throw new Error(`waitFor 超时；已收到 ${events.map((e) => e.type).join(",")}`);
			await new Promise((r) => setTimeout(r, 20));
		}
	};
	return {
		ws, events, controls, frames,
		get closeCode() { return closeCode; },
		waitFor,
		find: (type) => events.find((e) => e.type === type) as never,
		send: (cmd) => ws.send(JSON.stringify(cmd)),
	};
}

/** 驱动一轮 prompt 到 agent.settled（每轮一次），支持多轮串行 */
async function driveTurn(c: Client, text: string): Promise<void> {
	const before = c.events.filter((e) => e.type === "agent.settled").length;
	c.send({ type: "prompt", text, requestId: randomUUID() });
	await c.waitFor(() => c.events.filter((e) => e.type === "agent.settled").length > before);
}

/** 发一条 history.page 并等它的定向应答（该连接上的下一页） */
async function requestPage(c: Client, sessionId: string, cursor: string, limit?: number): Promise<Extract<ClientEvent, { type: "history.page" }>> {
	const before = c.events.filter((e) => e.type === "history.page").length;
	c.send({ type: "history.page", sessionId, cursor, ...(limit !== undefined ? { limit } : {}) });
	await c.waitFor(() => c.events.filter((e) => e.type === "history.page").length > before);
	return c.events.filter((e) => e.type === "history.page").at(-1)! as Extract<ClientEvent, { type: "history.page" }>;
}

test("parseCommand：history.page 的 schema 与上限", () => {
	const cursor = "v2.12.9.abcdef0123456789abcdef0123456789";
	const ok = parseCommand({ type: "history.page", sessionId: "s-1", cursor });
	assert.equal(ok.ok, true);
	assert.equal(parseCommand({ type: "history.page", sessionId: "s-1", cursor, limit: HISTORY_MAX_PAGE_ITEMS }).ok, true);
	// cursor 必填；形状不对（不是服务端 v2.idx.anchor.sig）在入口就拒；旧 v1 格式一并拒
	assert.equal(parseCommand({ type: "history.page", sessionId: "s-1" }).ok, false);
	assert.equal(parseCommand({ type: "history.page", sessionId: "s-1", cursor: "deadbeef" }).ok, false);
	assert.equal(parseCommand({ type: "history.page", sessionId: "s-1", cursor: "v1.1.abcdef0123456789abcdef0123456789" }).ok, false);
	assert.equal(parseCommand({ type: "history.page", sessionId: "s-1", cursor: "v2.1.锚.abcdef0123456789abcdef0123456789" }).ok, false);
	assert.equal(parseCommand({ type: "history.page", sessionId: "s-1", cursor: "v2.1.9.nothex" }).ok, false);
	// sessionId 与网关 SESSION_ID 同尺：路径字符一律不收
	assert.equal(parseCommand({ type: "history.page", sessionId: "../evil", cursor }).ok, false);
	assert.equal(parseCommand({ type: "history.page", sessionId: "x".repeat(65), cursor }).ok, false);
	// limit：正整数且 ≤ 上限
	assert.equal(parseCommand({ type: "history.page", sessionId: "s", cursor, limit: 0 }).ok, false);
	assert.equal(parseCommand({ type: "history.page", sessionId: "s", cursor, limit: HISTORY_MAX_PAGE_ITEMS + 1 }).ok, false);
	assert.equal(parseCommand({ type: "history.page", sessionId: "s", cursor, limit: 1.5 }).ok, false);
	assert.equal(parseCommand({ type: "history.page", sessionId: "s", cursor, limit: "10" }).ok, false);
	// 未知字段拒绝
	assert.equal(parseCommand({ type: "history.page", sessionId: "s", cursor, extra: 1 }).ok, false);
});

test("reducer：history.page 向前 prepend、按 id 去重、元信息以应答为准", () => {
	const m1: MessageView = { id: "1", order: 1, role: "user", text: "早一", thinking: "" };
	const m2: MessageView = { id: "2", order: 2, role: "assistant", text: "早二", thinking: "" };
	const m3: MessageView = { id: "3", order: 3, role: "user", text: "尾", thinking: "" };
	let state = reduce(initialState(), {
		type: "session.snapshot",
		view: { ...initialState(), sessionId: "s", messages: [m3], history: { total: 9, oldestIncluded: 8, cursor: "v1.8.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
	});
	assert.equal(state.messages.length, 1);
	// 重叠页：m2 重复出现只 prepend 一次
	state = reduce(state, { type: "history.page", items: [m1, m2, { ...m2 }], total: 9, oldestIncluded: 5, cursor: "v1.5.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
	assert.deepEqual(state.messages.map((m) => m.id), ["1", "2", "3"]);
	assert.deepEqual(state.history, { total: 9, oldestIncluded: 5, cursor: "v1.5.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
	// 翻到最早：cursor 为空，按钮依据消失
	state = reduce(state, { type: "history.page", items: [], total: 9, oldestIncluded: 0, cursor: null });
	assert.equal(state.history!.cursor, null);
	// 快照替换语义：历史元信息随最新快照更新（权威永远是最近一份快照）
	state = reduce(state, { type: "session.snapshot", view: { ...initialState(), sessionId: "s", messages: [m1, m2, m3], history: { total: 3, oldestIncluded: 0, cursor: null } } });
	assert.deepEqual(state.messages.map((m) => m.id), ["1", "2", "3"]);
	assert.deepEqual(state.history, { total: 3, oldestIncluded: 0, cursor: null });
});

test("attach 快照有界：项数上限、历史元信息、逐页翻到最早与权威历史一致", async () => {
	const env = await startGateway(
		[{ text: "回复-1" }, { text: "回复-2" }, { text: "回复-3" }, { text: "回复-4" }, { text: "回复-5" }],
		{ historyTail: { maxItems: 4, maxBytes: 64 * 1024 } },
	);
	const driver = await connect(env);
	await driver.waitFor(() => driver.find("session.ready") !== undefined);
	const sessionId = driver.find("session.ready")!.sessionId;
	for (let i = 1; i <= 5; i++) await driveTurn(driver, `问题-${i}`);

	// 新连接 attach：快照只带尾部 4 项，附元信息与游标
	const fresh = await connect(env, `&session=${sessionId}`);
	await fresh.waitFor(() => fresh.find("session.snapshot") !== undefined);
	const snap = fresh.find("session.snapshot")!.view;
	assert.equal(snap.messages.length, 4);
	assert.ok(snap.history, "有界快照必须带历史元信息");
	assert.equal(snap.history!.total, 10, "5 轮 = 5 条用户 + 5 条助手");
	assert.equal(snap.history!.oldestIncluded, 6);
	assert.match(snap.history!.cursor!, /^v2\.6\.[0-9]+\.[0-9a-f]{32}$/);

	// 逐页向更早翻：每页 ≤ 上限；翻到最早后 cursor 为空
	const page1 = await requestPage(fresh, sessionId, snap.history!.cursor!);
	assert.equal(page1.items.length, 4);
	assert.equal(page1.total, 10);
	assert.equal(page1.oldestIncluded, 2);
	const page2 = await requestPage(fresh, sessionId, page1.cursor!);
	assert.equal(page2.items.length, 2);
	assert.equal(page2.oldestIncluded, 0);
	assert.equal(page2.cursor, null);

	// 全集 = 各页 + 尾页：10 条、无重复、顺序与权威历史一致（order 严格递增）
	const all = [...page2.items, ...page1.items, ...snap.messages];
	assert.equal(all.length, 10);
	assert.equal(new Set(all.map((m) => m.id)).size, 10, "不允许重复");
	const orders = all.map((m) => m.order!);
	assert.deepEqual(orders, [...orders].sort((a, b) => a - b), "拼接后必须按时间序");
});

test(">2MiB 历史：attach 快照帧有界、单项截断、连接不再 1009 断连", async () => {
	const script = Array.from({ length: 25 }, (_, i) => ({ chunks: [`P${i}-`, "x".repeat(100 * 1024)] }));
	// 25 轮 × ~100KiB 助手文本 ≈ 2.5MiB 权威历史。默认 tail 上限（200 项 / 1MiB）：
	// 旧行为下整段历史进单帧必撞 maxFrameBytes(2MiB) 被 Outbox 1009 杀连接。
	// 本例目的在帧边界不在限流：同一驱动连接连发 prompt 会撞每秒 20 条的既有
	// 每连接限流（1008），仅在测试实例上经既有配置调高，生产默认不动、语义不放宽
	const env = await startGateway(script, { limits: { maxCommandsPerSecond: 100 } });
	const driver = await connect(env);
	await driver.waitFor(() => driver.find("session.ready") !== undefined);
	const sessionId = driver.find("session.ready")!.sessionId;
	for (let i = 0; i < 25; i++) await driveTurn(driver, `大消息-${i}`);

	const fresh = await connect(env, `&session=${sessionId}`);
	await fresh.waitFor(() => fresh.find("session.snapshot") !== undefined);
	assert.equal(fresh.closeCode, undefined, "有界快照下不允许断连（旧行为 1009）");
	assert.ok(fresh.ws.readyState === fresh.ws.OPEN);
	const snapFrame = fresh.frames.filter((f) => f.includes("session.snapshot")).at(-1)!;
	assert.ok(Buffer.byteLength(snapFrame) < 2 * 1024 * 1024, `快照帧必须 < maxFrameBytes，实际 ${Buffer.byteLength(snapFrame)}`);
	const snap = fresh.find("session.snapshot")!.view;
	assert.ok(snap.history);
	assert.equal(snap.history!.total, 50);
	assert.ok(snap.history!.oldestIncluded > 0);
	// 尾页序列化字节 ≤ 1MiB 预算 + 单项余量（最新一项始终保留）
	assert.ok(
		Buffer.byteLength(JSON.stringify(snap.messages)) < 1024 * 1024 + 160 * 1024,
		`尾页字节超预算：${Buffer.byteLength(JSON.stringify(snap.messages))}`,
	);
	// 每条 ~100KiB 的消息都被确定性截断到单项上限，带标记与原始长度
	for (const message of snap.messages) {
		assert.ok(Buffer.byteLength(message.text) <= HISTORY_MAX_ITEM_BYTES, "单项展示不得超 64KiB");
		if (Buffer.byteLength(message.text) === HISTORY_MAX_ITEM_BYTES || message.truncated) {
			assert.equal(message.truncated, true);
			assert.ok((message.originalBytes ?? 0) >= 100 * 1024, "截断标记必须带原始字节长度");
		}
	}
	// 分页出去的完整历史同样逐项截断，全集仍是 50 条不重复
	const page = await requestPage(fresh, sessionId, snap.history!.cursor!);
	for (const message of page.items) assert.ok(Buffer.byteLength(message.text) <= HISTORY_MAX_ITEM_BYTES);
	const seen = new Set([...page.items, ...snap.messages].map((m) => m.id));
	assert.equal(seen.size, [...page.items, ...snap.messages].length, "页与尾页不允许重复");
});

test("分页中途追加新消息：不重复、不跳项（页边界链式衔接）", async () => {
	const env = await startGateway(
		[{ text: "t1" }, { text: "t2" }, { text: "t3" }, { chunks: ["慢1", "慢2", "慢3"], delayMs: 300 }],
		{ historyTail: { maxItems: 2, maxBytes: 1024 * 1024 } },
	);
	const driver = await connect(env);
	await driver.waitFor(() => driver.find("session.ready") !== undefined);
	const sessionId = driver.find("session.ready")!.sessionId;
	await driveTurn(driver, "一");
	await driveTurn(driver, "二");
	await driveTurn(driver, "三");

	// 6 条消息，尾页 2 条；然后开始慢流式轮次（新消息边翻页边追加）
	const fresh = await connect(env, `&session=${sessionId}`);
	await fresh.waitFor(() => fresh.find("session.snapshot") !== undefined);
	const snap = fresh.find("session.snapshot")!.view;
	assert.equal(snap.history!.oldestIncluded, 4);

	const settledBefore = driver.events.filter((e) => e.type === "agent.settled").length;
	driver.send({ type: "prompt", text: "四", requestId: randomUUID() });
	await driver.waitFor(() => driver.events.some((e) => e.type === "message.text" && e.delta === "慢1"));
	// 流式进行中翻页：页内容只取决于游标下标，追加不移动旧下标
	const page1 = await requestPage(fresh, sessionId, snap.history!.cursor!);
	assert.equal(page1.items.length, 2);
	assert.equal(page1.oldestIncluded, 2);
	await driver.waitFor(() => driver.events.filter((e) => e.type === "agent.settled").length > settledBefore);
	const page2 = await requestPage(fresh, sessionId, page1.cursor!);
	assert.equal(page2.items.length, 2);
	assert.equal(page2.oldestIncluded, 0);
	assert.equal(page2.cursor, null);
	// 页边界链式衔接：下一页的 (oldestIncluded + items.length) 必须等于上一页的 oldestIncluded
	assert.equal(page2.oldestIncluded + page2.items.length, page1.oldestIncluded);
	// 全集 = 三页 + 追加后的最新尾页，恰好 8 条不重复：页边界与尾页边界也链式衔接
	const end = await connect(env, `&session=${sessionId}`);
	await end.waitFor(() => end.find("session.snapshot") !== undefined);
	const endSnap = end.find("session.snapshot")!.view;
	assert.equal(endSnap.history!.total, 8);
	assert.equal(endSnap.messages.length, 2, "新 attach 的尾页同样受项数上限");
	const page3 = await requestPage(end, sessionId, endSnap.history!.cursor!);
	assert.equal(page3.items.length, 2);
	assert.equal(page3.oldestIncluded + page3.items.length, endSnap.history!.oldestIncluded, "页与尾页边界衔接");
	const all = [...page2.items, ...page1.items, ...page3.items, ...endSnap.messages];
	assert.equal(all.length, 8);
	assert.equal(new Set(all.map((m) => m.id)).size, 8, "追加期间翻页不允许出现重复或缺漏");
});

test("游标防护：伪造/篡改/跨会话固定类别拒绝；viewer 可读、撤权后拿不到数据", async () => {
	const env = await startGateway([{ text: "a" }, { text: "b" }], { historyTail: { maxItems: 2, maxBytes: 1024 * 1024 } });

	// 会话 1：2 轮 = 4 条，尾页 2 条，游标可用
	const owner1 = await connect(env);
	await owner1.waitFor(() => owner1.find("session.ready") !== undefined);
	const sid1 = owner1.find("session.ready")!.sessionId;
	await driveTurn(owner1, "一");
	await driveTurn(owner1, "二");
	const c1 = await connect(env, `&session=${sid1}`);
	await c1.waitFor(() => c1.find("session.snapshot") !== undefined);
	const snap1 = c1.find("session.snapshot")!.view;
	const cursor1 = snap1.history!.cursor!;

	// 会话 2：独立 Session 实例（独立游标密钥）
	const owner2 = await connect(env);
	await owner2.waitFor(() => owner2.find("session.ready") !== undefined);
	const sid2 = owner2.find("session.ready")!.sessionId;

	// 篡改：真签名换到别的 idx（签名覆盖旧 idx，验签必败）→ 固定类别拒绝；
	// 错误只定向回发起连接，同会话其他连接不得收到
	const tampered = cursor1.replace(/^v2\.\d+\./, "v2.0.");
	const owner1ErrorsBefore = owner1.events.filter((e) => e.type === "error").length;
	c1.send({ type: "history.page", sessionId: sid1, cursor: tampered });
	await c1.waitFor(() => c1.events.some((e) => e.type === "error" && e.message.includes("游标无效")));
	assert.equal(
		owner1.events.filter((e) => e.type === "error").length, owner1ErrorsBefore,
		"分页错误只回发起连接，不得广播",
	);

	// 伪造：形状合法但签名是编的（锚位随意填）
	const forged = "v2.1.7." + "0".repeat(32);
	c1.send({ type: "history.page", sessionId: sid1, cursor: forged });
	await c1.waitFor(() => c1.events.filter((e) => e.type === "error" && e.message.includes("游标无效")).length >= 2);

	// 跨会话：会话 1 签发的游标拿到会话 2 用 —— HMAC 绑定 sessionId，验签必败
	owner2.send({ type: "history.page", sessionId: sid2, cursor: cursor1 });
	await owner2.waitFor(() => owner2.events.some((e) => e.type === "error" && e.message.includes("游标无效")));

	// 连接级越权：在会话 2 的连接上点名会话 1（不泄漏其存在性，固定类别）
	const before = c1.events.length;
	owner2.send({ type: "history.page", sessionId: sid1, cursor: cursor1 });
	await owner2.waitFor(() => owner2.events.some((e) => e.type === "error" && e.message.includes("会话不匹配")));
	assert.equal(c1.events.length, before, "被拒的分页不得把数据发给其他连接");

	// viewer 正控：只读成员可翻页；撤权（unshare）后连接被关、再无分页数据
	owner1.send({ type: "share", actor: "bob", role: "viewer" });
	await new Promise((r) => setTimeout(r, 50));
	const bob = await connect(env, `&actor=bob&session=${sid1}`);
	await bob.waitFor(() => bob.find("session.snapshot") !== undefined);
	assert.equal(bob.find("session.snapshot")!.view.role, "viewer");
	const bobPage = await requestPage(bob, sid1, bob.find("session.snapshot")!.view.history!.cursor!);
	assert.ok(bobPage.items.length > 0, "viewer 必须能读历史");

	owner1.send({ type: "unshare", actor: "bob" });
	await bob.waitFor(() => bob.closeCode !== undefined, 5_000);
	assert.equal(bob.closeCode, 4003, "撤权必须立即断开旧连接");
	const itemsAfter = bob.events.filter((e) => e.type === "history.page").length;
	assert.equal(itemsAfter, 1, "撤权后不得再收到分页数据");
});

test("limit 收窄：单页条数受客户端 limit 与服务端上限取更严", async () => {
	const env = await startGateway(
		[{ text: "a" }, { text: "b" }, { text: "c" }],
		{ historyTail: { maxItems: 2, maxBytes: 1024 * 1024 } },
	);
	const driver = await connect(env);
	await driver.waitFor(() => driver.find("session.ready") !== undefined);
	const sessionId = driver.find("session.ready")!.sessionId;
	for (const t of ["一", "二", "三"]) await driveTurn(driver, t);
	const c = await connect(env, `&session=${sessionId}`);
	await c.waitFor(() => c.find("session.snapshot") !== undefined);
	const snap = c.find("session.snapshot")!.view;
	const cursor = snap.history!.cursor!;
	// limit=1 压过服务端上限：单页只有 1 条
	const page = await requestPage(c, sessionId, cursor, 1);
	assert.equal(page.items.length, 1, "客户端 limit=1 必须生效");
	assert.equal(page.oldestIncluded + page.items.length, 4);
	// 默认 limit 取服务端 tail 同尺（maxItems=2）：每页最多 2 条，逐页翻到底
	const rest = await requestPage(c, sessionId, page.cursor!);
	assert.equal(rest.items.length, 2);
	assert.equal(rest.oldestIncluded, 1);
	const last = await requestPage(c, sessionId, rest.cursor!);
	assert.equal(last.items.length, 1);
	assert.equal(last.oldestIncluded, 0);
	assert.equal(last.cursor, null);
	// 全集 = 三页 + 尾页 = 权威 6 条，无重复且有序
	const all = [...last.items, ...rest.items, ...page.items, ...snap.messages];
	assert.equal(all.length, 6);
	assert.equal(new Set(all.map((m) => m.id)).size, 6, "不重复不缺漏");
	const orders = all.map((m) => m.order!);
	assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
});

test("权威数组重构（压缩模拟）：旧游标固定失效不静默错位，重构后新游标正常翻页", async () => {
	// 真实压缩阈值是 32768 tokens 的后台异步决策，测试内不可确定性触发；注入走
	// publish() 的公开协议面（与 durable 溢出重快照同一条路径），模拟形状逐点对照
	// vendor view.js:132-138 的真实行为：splice 前缀 + 大 id 摘要前置。
	// sessionProbe 仅测试实例配置（生产不配置，零行为影响；先例 createStageProbe）。
	let injected: Session | undefined;
	const env = await startGateway(
		[{ text: "回复-1" }, { text: "回复-2" }, { text: "回复-3" }, { text: "回复-4" }, { text: "回复-5" }],
		{
			historyTail: { maxItems: 4, maxBytes: 64 * 1024 },
			sessionProbe: (session) => { injected = session; },
		},
	);
	const driver = await connect(env);
	await driver.waitFor(() => driver.find("session.ready") !== undefined);
	const sessionId = driver.find("session.ready")!.sessionId;
	for (let i = 1; i <= 5; i++) await driveTurn(driver, `问题-${i}`);

	const c = await connect(env, `&session=${sessionId}`);
	await c.waitFor(() => c.find("session.snapshot") !== undefined);
	const snap = c.find("session.snapshot")!.view;
	const oldCursor = snap.history!.cursor!;
	assert.match(oldCursor, /^v2\.6\./);
	const page1 = await requestPage(c, sessionId, oldCursor);
	const page2 = await requestPage(c, sessionId, page1.cursor!);
	const authoritative = [...page2.items, ...page1.items, ...snap.messages];
	assert.equal(authoritative.length, 10);

	// 模拟压缩：splice 掉前 4 条、前置一条大 id 摘要。旧游标 idx=6 仍在界内，
	// 但锚定的 messages[5].id 已漂移 —— 必须走锚点失配分支而不是静默错位
	const summary: MessageView = { id: "900001", order: 900001, role: "user", text: "（历史摘要）前 4 条已压缩", thinking: "" };
	const rebuilt: MessageView[] = [summary, ...authoritative.slice(-6)];
	assert.equal(rebuilt.length, 7);
	assert.ok(injected, "sessionProbe 必须交付 Session 实例");
	injected!.publish({ type: "session.snapshot", view: { messages: rebuilt } as unknown as SessionView });
	await c.waitFor(() => c.events.filter((e) => e.type === "session.snapshot").length >= 2);

	// 旧游标：签名真实但锚点已漂移 → 「游标已失效」定向错误、零数据下发
	const pagesBefore = c.events.filter((e) => e.type === "history.page").length;
	c.send({ type: "history.page", sessionId, cursor: oldCursor });
	await c.waitFor(() => c.events.some((e) => e.type === "error" && e.message.includes("游标已失效")));
	assert.equal(c.events.filter((e) => e.type === "history.page").length, pagesBefore, "失效游标不得返回任何条目");

	// 重构后新游标正常翻页：内容与重构后数组一致，无错位、无旧前缀条目复活
	const fresh = await connect(env, `&session=${sessionId}`);
	await fresh.waitFor(() => fresh.find("session.snapshot") !== undefined);
	const snap2 = fresh.find("session.snapshot")!.view;
	assert.equal(snap2.history!.total, 7);
	assert.equal(snap2.messages.length, 4);
	const page = await requestPage(fresh, sessionId, snap2.history!.cursor!);
	assert.equal(page.items.length, 3);
	assert.equal(page.cursor, null);
	assert.deepEqual(page.items.map((m) => m.id), ["900001", ...authoritative.slice(4, 6).map((m) => m.id)]);
	assert.deepEqual([...page.items, ...snap2.messages].map((m) => m.id), rebuilt.map((m) => m.id));
});
