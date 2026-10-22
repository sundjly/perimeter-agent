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
import type { ClientEvent, SessionView, ToolView } from "../src/protocol/types.ts";
import { initialState, reduce } from "../web/view-model.js";

/**
 * S5b：快照 tools 数组出口有界 + 增量工具事件单工具 64KiB 截断（handoff §3.2，
 * S5a 复审 P2 残余闭环）。
 *
 * 覆盖：多轮大输出工具会话 attach 快照帧 < maxFrameBytes、不再 1009 断连；tools
 * 项数（默认 200，可配）与序列化字节双上限；toolsHistory 元信息（总数 + 已含范围，
 * 与尾页链式衔接）；单工具截断标记与原始字节（注入形确定性用例，不依赖 vendor 的
 * 50KiB 输出窗口默认值）；增量 tool.progress/tool.end 帧有界且带标记；小会话正控
 * 快照内容不变；共享 reducer 的截断标记维护（大 progress 后小 end 清除，不留幽灵字段）。
 * 大会话驱动按 S5a 先例仅在测试实例调高每连接限流，生产默认 20/s 未动。
 *
 * S5c 扩展：historyTail+toolsTail 合计构造期校验（单项合法合计超限即抛、默认与边界内
 * 合法组合通过）；被裁旧工具的 tools.page 分页（逐页翻到最早与权威一致、无重复无缺漏；
 * t2 游标签发/验签/锚点核对；进行中 MAX order 工具不成锚、不漏不重；伪造/篡改/跨会话/
 * 跨种类固定类别拒绝；前缀重构旧游标固定失效；viewer 可读、撤权拿不到数据；reducer
 * 按 callId 去重）。
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MOCK = join(REPO, "tests/fixtures/mock-model.mjs");
const TOKEN = "tools-bounded-test-token";

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups) await c();
});

interface Env { url: string; gateway: Gateway }

async function startGateway(script: unknown[], extra: Partial<ConstructorParameters<typeof Gateway>[0]> = {}): Promise<Env> {
	const dir = mkdtempSync(join(tmpdir(), "tools-bounded-"));
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
	/** 原始帧文本（按收到顺序），用于帧字节断言 */
	frames: string[];
	readonly closeCode?: number;
	waitFor(pred: () => boolean, ms?: number): Promise<void>;
	find<T extends ClientEvent["type"]>(type: T): Extract<ClientEvent, { type: T }> | undefined;
	filter<T extends ClientEvent["type"]>(type: T): Extract<ClientEvent, { type: T }>[];
	send(cmd: unknown): void;
}

async function connect(env: Env, query = ""): Promise<Client> {
	const ws = new WebSocket(`${env.url.replace("http", "ws")}/?token=${TOKEN}${query}`);
	const events: ClientEvent[] = [];
	const frames: string[] = [];
	let closeCode: number | undefined;
	ws.on("message", (raw) => {
		const text = String(raw);
		const msg = JSON.parse(text) as { type?: string; control?: string; event?: ClientEvent };
		if (msg.type === "control") return;
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
		ws, events, frames,
		get closeCode() { return closeCode; },
		waitFor,
		find: (type) => events.find((e) => e.type === type) as never,
		filter: (type) => events.filter((e) => e.type === type) as never,
		send: (cmd) => ws.send(JSON.stringify(cmd)),
	};
}

/** 驱动一轮 prompt 到 agent.settled */
async function driveTurn(c: Client, text: string): Promise<void> {
	const before = c.events.filter((e) => e.type === "agent.settled").length;
	c.send({ type: "prompt", text, requestId: randomUUID() });
	await c.waitFor(() => c.events.filter((e) => e.type === "agent.settled").length > before);
}

/** 按快照携带的 tools 元信息定位注入帧：ClientEvent 联合需显式谓词才能在 filter 后保留收窄 */
type SnapshotEvent = Extract<ClientEvent, { type: "session.snapshot" }>;
const snapshotWithToolsTotal = (total: number) =>
	(event: ClientEvent): event is SnapshotEvent => event.type === "session.snapshot" && event.view.toolsHistory?.total === total;

/** S5c：发一条 tools.page 并等它的定向应答（该连接上的下一页） */
async function requestToolsPage(c: Client, sessionId: string, cursor: string, limit?: number): Promise<Extract<ClientEvent, { type: "tools.page" }>> {
	const before = c.events.filter((e) => e.type === "tools.page").length;
	c.send({ type: "tools.page", sessionId, cursor, ...(limit !== undefined ? { limit } : {}) });
	await c.waitFor(() => c.events.filter((e) => e.type === "tools.page").length > before);
	return c.events.filter((e) => e.type === "tools.page").at(-1)! as Extract<ClientEvent, { type: "tools.page" }>;
}

const BIG_COMMAND = "head -c 1048576 /dev/zero | tr '\\000' x";

test("reducer：工具截断标记的增量维护、清除与快照透传", () => {
	let state = reduce(initialState(), { type: "session.snapshot", view: { ...initialState(), sessionId: "s", tools: [{ callId: "c", order: 1, action: { tool: "bash" }, output: "已有输出" }] } });
	// 大输出 progress（服务端已截断）：标记与原始字节落到工具卡
	state = reduce(state, { type: "tool.progress", callId: "c", output: "x", truncated: true, originalBytes: 300000 });
	assert.equal(state.tools[0]!.truncated, true);
	assert.equal(state.tools[0]!.originalBytes, 300000);
	// 随后的小输出 end：标记必须清除且不残留幽灵键（既有深度相等语义依赖这一点）
	state = reduce(state, { type: "tool.end", callId: "c", ok: true, output: "done", order: 1 });
	assert.equal("truncated" in state.tools[0]!, false);
	assert.equal("originalBytes" in state.tools[0]!, false);
	// 无标记事件不得产生 undefined 幽灵字段
	state = reduce(state, { type: "tool.start", callId: "d", action: { tool: "read" }, summary: "read" });
	assert.deepEqual(state.tools[1]!, { callId: "d", order: Number.MAX_SAFE_INTEGER, action: { tool: "read" }, output: "" });
	// 截断快照整体替换透传，元信息随快照更新（S5c：元信息含分页游标，注入快照给什么透传什么）
	state = reduce(state, { type: "session.snapshot", view: { ...initialState(), sessionId: "s", tools: [{ callId: "e", action: { tool: "bash", command: "c" }, output: "y", truncated: true, originalBytes: 9 }], toolsHistory: { total: 7, oldestIncluded: 6, cursor: null } } });
	assert.equal(state.tools[0]!.truncated, true);
	assert.equal(state.tools[0]!.originalBytes, 9);
	assert.deepEqual(state.toolsHistory, { total: 7, oldestIncluded: 6, cursor: null });
});

test("正控小会话：快照 tools 内容不变、无标记、元信息为全量", async () => {
	const env = await startGateway([{ tool: "bash", args: { command: "echo hi" } }, { text: "done" }]);
	const driver = await connect(env);
	await driver.waitFor(() => driver.find("session.ready") !== undefined);
	const sessionId = driver.find("session.ready")!.sessionId;
	await driveTurn(driver, "跑一个小命令");

	const fresh = await connect(env, `&session=${sessionId}`);
	await fresh.waitFor(() => fresh.find("session.snapshot") !== undefined);
	const snap = fresh.find("session.snapshot")!.view;
	assert.equal(snap.tools.length, 1);
	assert.ok(snap.tools[0]!.output.includes("hi"), "小输出必须原样保留");
	assert.equal(snap.tools[0]!.ok, true);
	assert.equal("truncated" in snap.tools[0]!, false, "未截断的工具不得带标记");
	assert.equal("originalBytes" in snap.tools[0]!, false);
	// tools 元信息：全部工具都在尾页里，无更早工具（cursor 为空）
	assert.deepEqual(snap.toolsHistory, { total: 1, oldestIncluded: 0, cursor: null });
	assert.equal(snap.history!.cursor, null);
});

test("注入形确定性：单工具 64KiB 截断标记与原始字节；快照/增量双出口都有界", async () => {
	// 真实 bash 输出受 vendor 50KiB 窗口约束，撞不到 64KiB —— 截断标记走 publish()
	// 公开协议面注入（与 S5a 压缩模拟同一测试缝；生产不配置 sessionProbe 零行为），
	// 确定性验证本层的 #clipTool/#clipToolEvent，不依赖 vendor 默认值。
	// maxBytes 512KiB 与默认同尺：S5c 合计校验下默认 historyTail(1MiB) + 1MiB 会超限；
	// 本例上限由 maxItems=2 绑定，字节上限取值不影响断言语义
	let injected: Session | undefined;
	const env = await startGateway([], {
		toolsTail: { maxItems: 2, maxBytes: 512 * 1024 },
		sessionProbe: (session) => { injected = session; },
	});
	const driver = await connect(env);
	await driver.waitFor(() => driver.find("session.ready") !== undefined);
	assert.ok(injected, "sessionProbe 必须交付 Session 实例");

	// 3 个工具：最新一个带 300KiB 输出（恒保留），maxItems=2 裁掉最旧的
	const small1: ToolView = { callId: "call-s1", order: 1, action: { tool: "read", path: "a.txt" }, output: "小一" };
	const small2: ToolView = { callId: "call-s2", order: 2, action: { tool: "read", path: "b.txt" }, output: "小二" };
	const big: ToolView = { callId: "call-big", order: 3, action: { tool: "bash", command: "big" }, output: "a".repeat(300 * 1024) };
	injected!.publish({ type: "session.snapshot", view: { tools: [small1, small2, big], messages: [] } as unknown as SessionView });
	// 按内容定位注入帧（toolsHistory.total=3），避免与 durable 空闲快照竞态
	const injectedSnap = () => driver.events.filter(snapshotWithToolsTotal(3)).at(-1);
	await driver.waitFor(() => injectedSnap() !== undefined);

	// 在途（live）快照出口：裁到 2 项、大工具被确定性截断并带标记与原始字节。
	// originalBytes 与 MessageView 同口径 = 各展示字段未裁前之和：output 307200 + command "big" 3
	const liveSnap = injectedSnap()!.view;
	assert.equal(liveSnap.tools.length, 2, "tools 出口受项数上限");
	assert.deepEqual(liveSnap.tools.map((t) => t.callId), ["call-s2", "call-big"]);
	assert.equal(liveSnap.toolsHistory!.total, 3);
	assert.equal(liveSnap.toolsHistory!.oldestIncluded, 1);
	// S5c：被裁部分可翻页 —— cursor 锚=覆盖范围最新一项，即 tools[idx-1]=tools[0]=call-s1
	//（与 history 游标 messages[idx-1].id 同一公式；idx=1 的覆盖范围是下标 0 的那一项）
	assert.match(liveSnap.toolsHistory!.cursor!, /^t2\.1\.call-s1\.[0-9a-f]{32}$/);
	const liveBig = liveSnap.tools[1]!;
	assert.equal(Buffer.byteLength(liveBig.output), HISTORY_MAX_ITEM_BYTES);
	assert.equal(liveBig.truncated, true);
	assert.equal(liveBig.originalBytes, 300 * 1024 + 3);
	assert.equal(liveSnap.tools[0]!.truncated, undefined, "未超限工具不带标记");

	// 增量 progress 出口：300KiB 累计输出被截到 64KiB，帧不超限、带标记
	injected!.publish({ type: "tool.progress", callId: "call-big", output: "b".repeat(300 * 1024) });
	await driver.waitFor(() => driver.events.some((e) => e.type === "tool.progress" && e.truncated === true));
	// 事件级标记只描述被裁的 output 字段（不含 command/path），与 ToolView 级口径不同、各自自洽
	const progress = driver.filter("tool.progress").at(-1)!;
	assert.equal(progress.output, "b".repeat(HISTORY_MAX_ITEM_BYTES));
	assert.equal(progress.originalBytes, 300 * 1024);
	const progressFrame = driver.frames.filter((f) => f.includes("\"tool.progress\"")).at(-1)!;
	assert.ok(
		Buffer.byteLength(progressFrame) < HISTORY_MAX_ITEM_BYTES + 8 * 1024,
		`增量工具帧必须接近 64KiB 上限，实际 ${Buffer.byteLength(progressFrame)}`,
	);

	// 新连接 attach：权威 #view 里的 300KiB 工具同样被截断（快照出口），裁剪元信息一致
	const fresh = await connect(env, `&session=${driver.find("session.ready")!.sessionId}`);
	await fresh.waitFor(() => fresh.find("session.snapshot") !== undefined);
	const snap = fresh.find("session.snapshot")!.view;
	assert.equal(snap.tools.length, 2);
	const attachBig = snap.tools.find((t) => t.callId === "call-big")!;
	assert.equal(attachBig.output, "b".repeat(HISTORY_MAX_ITEM_BYTES));
	assert.equal(attachBig.truncated, true);
	assert.equal(attachBig.originalBytes, 300 * 1024 + 3, "与 live 快照同一口径（output+command 之和）");
	assert.equal(snap.toolsHistory!.total, 3);
	assert.equal(snap.toolsHistory!.oldestIncluded, 1);
	assert.match(snap.toolsHistory!.cursor!, /^t2\.1\.call-s1\.[0-9a-f]{32}$/);
});

test("默认项数上限 200：注入 260 个工具裁到 200 并带全量元信息", async () => {
	let injected: Session | undefined;
	const env = await startGateway([], { sessionProbe: (session) => { injected = session; } });
	const driver = await connect(env);
	await driver.waitFor(() => driver.find("session.ready") !== undefined);
	const many: ToolView[] = Array.from({ length: 260 }, (_, i) => ({ callId: `c${i}`, order: i, action: { tool: "read", path: `f${i}.txt` }, output: `out-${i}` }));
	injected!.publish({ type: "session.snapshot", view: { tools: many, messages: [] } as unknown as SessionView });
	await driver.waitFor(() => driver.events.some(snapshotWithToolsTotal(260)));
	const snap = driver.events.filter(snapshotWithToolsTotal(260)).at(-1)!.view;
	assert.equal(snap.tools.length, 200, "默认 tools 项数上限 200");
	assert.equal(snap.toolsHistory!.total, 260);
	assert.equal(snap.toolsHistory!.oldestIncluded, 60);
	assert.match(snap.toolsHistory!.cursor!, /^t2\.60\.c59\.[0-9a-f]{32}$/);
	// 保留的必须是最新的 200 个（尾部），最旧的被裁掉
	assert.equal(snap.tools[0]!.callId, "c60");
	assert.equal(snap.tools.at(-1)!.callId, "c259");
	for (const tool of snap.tools) assert.equal(tool.truncated, undefined);
});

test("48 轮 ×1MiB bash 输出：快照帧 < maxFrameBytes、不 1009、增量帧全程有界", async () => {
	// 48 个工具 × ~50KiB（vendor 尾窗）≈ 2.4MiB 序列化：旧行为整段 tools 进单帧必撞
	// maxFrameBytes(2MiB) 被 Outbox 1009 杀连接。目的在帧边界不在限流：驱动连接连发
	// prompt 按既有配置在测试实例调高（生产默认 20/s 未动、语义不放宽）
	const script: unknown[] = [];
	for (let i = 0; i < 48; i++) script.push({ tool: "bash", args: { command: BIG_COMMAND } }, { text: `ok-${i}` });
	const env = await startGateway(script, { limits: { maxCommandsPerSecond: 100 } });
	const driver = await connect(env);
	await driver.waitFor(() => driver.find("session.ready") !== undefined);
	const sessionId = driver.find("session.ready")!.sessionId;
	for (let i = 0; i < 48; i++) await driveTurn(driver, `大工具-${i}`);

	// 驱动连接全程存活（增量工具事件有界，没有 1009）
	assert.equal(driver.closeCode, undefined, "增量工具事件有界下不允许断连（旧行为 1009）");
	assert.ok(driver.ws.readyState === driver.ws.OPEN);
	// 全程收到的每一帧都有界（progress 累计快照若不裁会到 MiB 级）
	const oversized = driver.frames.map((f) => Buffer.byteLength(f)).filter((n) => n >= 128 * 1024);
	assert.deepEqual(oversized, [], `增量帧必须 < 128KiB，超限帧字节：${oversized.join(",")}`);
	// 每个收到的工具结果事件都带 64KiB 上限语义
	for (const event of driver.events) {
		if (event.type === "tool.end" || event.type === "tool.progress") {
			assert.ok(Buffer.byteLength(event.output) <= HISTORY_MAX_ITEM_BYTES, "增量工具输出不得超 64KiB");
		}
	}

	// 新连接 attach：快照帧有界、tools 尾页受双上限、元信息与尾页链式衔接
	const fresh = await connect(env, `&session=${sessionId}`);
	await fresh.waitFor(() => fresh.find("session.snapshot") !== undefined);
	assert.equal(fresh.closeCode, undefined, "有界快照下不允许断连（旧行为 1009）");
	const snapFrame = fresh.frames.filter((f) => f.includes("session.snapshot")).at(-1)!;
	assert.ok(Buffer.byteLength(snapFrame) < 2 * 1024 * 1024, `快照帧必须 < maxFrameBytes，实际 ${Buffer.byteLength(snapFrame)}`);
	const snap = fresh.find("session.snapshot")!.view;
	assert.ok(snap.history, "有界快照必须带历史元信息");
	// 每个工具轮在权威 messages 里是 3 条：用户 + 带 tool_call 的助手 + 最终助手
	//（toolResult 计入 tools 不计 messages，见 translate 的 snapshotView）
	assert.equal(snap.history!.total, 144, "48 轮 × 3 条");
	assert.equal(snap.toolsHistory!.total, 48, "tools 元信息给出权威总数");
	assert.equal(snap.toolsHistory!.oldestIncluded + snap.tools.length, 48, "tools 尾页与元信息链式衔接");
	assert.ok(snap.toolsHistory!.oldestIncluded > 0, "字节预算必须真实裁掉旧工具");
	assert.ok(snap.tools.length < 48);
	assert.ok(
		Buffer.byteLength(JSON.stringify(snap.tools)) < 512 * 1024 + 128 * 1024,
		`tools 尾页字节超预算：${Buffer.byteLength(JSON.stringify(snap.tools))}`,
	);
	for (const tool of snap.tools) {
		assert.ok(Buffer.byteLength(tool.output) <= HISTORY_MAX_ITEM_BYTES, "单项工具展示不得超 64KiB");
		assert.equal(tool.ok, true, "bash 成功执行（策略默认放行，无审批档）");
	}
});

// ── S5c：historyTail+toolsTail 合计构造期校验 + 被裁旧工具的 tools.page 分页 ──

test("合计校验：单项合法但合计超限构造即抛；默认与边界内合法组合通过", () => {
	// 合计校验位于构造期最前段（单项校验之后、mode 校验之前）：抛错不占用锁/审计等资源，
	// 可直接 new Gateway 断言
	const ctorConfig = () => ({
		mode: "demo" as const,
		port: 0,
		host: "127.0.0.1",
		token: TOKEN,
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(mkdtempSync(join(tmpdir(), "tools-bounded-ctor-")), "audit.jsonl"),
		workspaceRoot: mkdtempSync(join(tmpdir(), "tools-bounded-ws-")),
		stateRoot: mkdtempSync(join(tmpdir(), "tools-bounded-st-")),
		webRoot: join(REPO, "web"),
	});
	// 两项各自合法（各 ≤ maxFrameBytes-256KiB）但合计超限：固定文案指出两项之和
	assert.throws(
		() => new Gateway({ ...ctorConfig(), historyTail: { maxBytes: 1400 * 1024 }, toolsTail: { maxBytes: 512 * 1024 } }),
		(error: unknown) => error instanceof Error && error.message.includes("historyTail.maxBytes + toolsTail.maxBytes"),
		"1400KiB + 512KiB + 256KiB > 2MiB 必须构造即抛",
	);
	// 只配一项时另一项按默认值（1MiB / 512KiB）参与合计：1792KiB 单项合法，加默认 tools 512KiB 必超
	assert.throws(
		() => new Gateway({ ...ctorConfig(), historyTail: { maxBytes: 1792 * 1024 } }),
		(error: unknown) => error instanceof Error && error.message.includes("historyTail.maxBytes + toolsTail.maxBytes"),
	);
	// 默认组合（1MiB + 512KiB）与恰好用满预算的合法组合必须能构造
	const gw = new Gateway({ ...ctorConfig(), historyTail: { maxBytes: 1024 * 1024 }, toolsTail: { maxBytes: 512 * 1024 } });
	gw.close();
	const gw2 = new Gateway({ ...ctorConfig(), historyTail: { maxBytes: 512 * 1024 }, toolsTail: { maxBytes: 1024 * 1024 } });
	gw2.close();
});

test("parseCommand：tools.page 的 schema、t2 游标形状与跨种类互斥", () => {
	const cursor = "t2.12.call-9.abcdef0123456789abcdef0123456789";
	assert.equal(parseCommand({ type: "tools.page", sessionId: "s-1", cursor }).ok, true);
	assert.equal(parseCommand({ type: "tools.page", sessionId: "s-1", cursor, limit: 50 }).ok, true);
	// cursor 必填；history 游标（v2）与 tools 游标（t2）按种类互斥，双向都在入口即拒
	assert.equal(parseCommand({ type: "tools.page", sessionId: "s-1" }).ok, false);
	assert.equal(parseCommand({ type: "tools.page", sessionId: "s-1", cursor: "v2.12.9.abcdef0123456789abcdef0123456789" }).ok, false);
	assert.equal(parseCommand({ type: "history.page", sessionId: "s-1", cursor }).ok, false);
	assert.equal(parseCommand({ type: "tools.page", sessionId: "s-1", cursor: "deadbeef" }).ok, false);
	assert.equal(parseCommand({ type: "tools.page", sessionId: "s-1", cursor: "t2.1.锚.abcdef0123456789abcdef0123456789" }).ok, false);
	assert.equal(parseCommand({ type: "tools.page", sessionId: "s-1", cursor: "t2.1.9.nothex" }).ok, false);
	assert.equal(parseCommand({ type: "tools.page", sessionId: "s-1", cursor, limit: 0 }).ok, false);
	assert.equal(parseCommand({ type: "tools.page", sessionId: "s-1", cursor, limit: HISTORY_MAX_PAGE_ITEMS + 1 }).ok, false);
	assert.equal(parseCommand({ type: "tools.page", sessionId: "s-1", cursor, extra: 1 }).ok, false);
});

test("reducer：tools.page 向前 prepend、按 callId 去重（含页内）、元信息以应答为准", () => {
	const t1: ToolView = { callId: "1", order: 1, action: { tool: "read", path: "a" }, output: "早一", ok: true };
	const t2: ToolView = { callId: "2", order: 2, action: { tool: "read", path: "b" }, output: "早二", ok: true };
	const t3: ToolView = { callId: "3", order: 3, action: { tool: "bash" }, output: "尾", ok: true };
	let state = reduce(initialState(), { type: "session.snapshot", view: { ...initialState(), sessionId: "s", tools: [t3], toolsHistory: { total: 9, oldestIncluded: 8, cursor: "t2.8.7.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } } });
	assert.deepEqual(state.tools.map((t) => t.callId), ["3"]);
	// 重叠页 + 页内重复：callId=2 出现两次只 prepend 一次
	state = reduce(state, { type: "tools.page", items: [t1, t2, { ...t2 }], total: 9, oldestIncluded: 5, cursor: "t2.5.4.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
	assert.deepEqual(state.tools.map((t) => t.callId), ["1", "2", "3"]);
	assert.deepEqual(state.toolsHistory, { total: 9, oldestIncluded: 5, cursor: "t2.5.4.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
	// 翻到最早：cursor 为空
	state = reduce(state, { type: "tools.page", items: [], total: 9, oldestIncluded: 0, cursor: null });
	assert.equal(state.toolsHistory!.cursor, null);
	// 快照替换语义：元信息随最新快照更新（权威永远是最近一份快照）
	state = reduce(state, { type: "session.snapshot", view: { ...initialState(), sessionId: "s", tools: [t1, t2, t3], toolsHistory: { total: 3, oldestIncluded: 0, cursor: null } } });
	assert.deepEqual(state.tools.map((t) => t.callId), ["1", "2", "3"]);
	assert.deepEqual(state.toolsHistory, { total: 3, oldestIncluded: 0, cursor: null });
});

test("tools.page 逐页翻到最早：与权威一致、无重复无缺漏；进行中工具不成锚；页内单项截断", async () => {
	let injected: Session | undefined;
	const env = await startGateway([], {
		toolsTail: { maxItems: 4 },
		sessionProbe: (session) => { injected = session; },
	});
	const driver = await connect(env);
	await driver.waitFor(() => driver.find("session.ready") !== undefined);
	const sessionId = driver.find("session.ready")!.sessionId;

	// 12 个已完结工具（c5 带 300KiB 输出验证页内单项截断）+ 1 个进行中（MAX order 恒排尾）
	const completed: ToolView[] = Array.from({ length: 12 }, (_, i) => ({
		callId: `c${i}`, order: i + 1, action: { tool: "read", path: `f${i}.txt` }, output: i === 5 ? "z".repeat(300 * 1024) : `out-${i}`, ok: true,
	}));
	const live: ToolView = { callId: "live-1", order: Number.MAX_SAFE_INTEGER, action: { tool: "bash" }, output: "运行中" };
	injected!.publish({ type: "session.snapshot", view: { tools: [...completed, live], messages: [] } as unknown as SessionView });
	await driver.waitFor(() => driver.events.some(snapshotWithToolsTotal(13)));

	const fresh = await connect(env, `&session=${sessionId}`);
	await fresh.waitFor(() => fresh.find("session.snapshot") !== undefined);
	const snap = fresh.find("session.snapshot")!.view;
	assert.equal(snap.tools.length, 4, "尾页受项数上限");
	assert.equal(snap.toolsHistory!.total, 13);
	assert.equal(snap.toolsHistory!.oldestIncluded, 9);
	// 尾页 = 最新 4 项（进行中的恒在尾部、随尾页下发）；游标锚是已完结的 c8
	assert.deepEqual(snap.tools.map((t) => t.callId), ["c9", "c10", "c11", "live-1"]);
	const tailCursor = snap.toolsHistory!.cursor!;
	assert.match(tailCursor, /^t2\.9\.c8\.[0-9a-f]{32}$/);

	// 逐页翻到最早：每页 ≤ 上限，翻完 cursor 为空
	const page1 = await requestToolsPage(fresh, sessionId, tailCursor);
	assert.equal(page1.items.length, 4);
	assert.deepEqual(page1.items.map((t) => t.callId), ["c5", "c6", "c7", "c8"]);
	assert.equal(page1.oldestIncluded, 5);
	// 页内单项 64KiB 截断与 history.page 同一把尺（originalBytes = 各展示字段未裁前之和）
	const clipped = page1.items.find((t) => t.callId === "c5")!;
	assert.equal(Buffer.byteLength(clipped.output), HISTORY_MAX_ITEM_BYTES);
	assert.equal(clipped.truncated, true);
	assert.equal(clipped.originalBytes, 300 * 1024 + 6, "output 300KiB + path f5.txt 6 字节");
	const page2 = await requestToolsPage(fresh, sessionId, page1.cursor!);
	assert.deepEqual(page2.items.map((t) => t.callId), ["c1", "c2", "c3", "c4"]);
	assert.equal(page2.oldestIncluded, 1);
	const page3 = await requestToolsPage(fresh, sessionId, page2.cursor!);
	assert.deepEqual(page3.items.map((t) => t.callId), ["c0"]);
	assert.equal(page3.oldestIncluded, 0);
	assert.equal(page3.cursor, null);

	// 链式衔接：下一页 (oldestIncluded + items.length) = 上一页 oldestIncluded
	assert.equal(page1.oldestIncluded + page1.items.length, 9);
	assert.equal(page2.oldestIncluded + page2.items.length, page1.oldestIncluded);
	assert.equal(page3.oldestIncluded + page3.items.length, page2.oldestIncluded);
	// 全集 = 三页 + 尾页 = 权威 13 项，无重复无缺漏、顺序与权威一致
	const all = [...page3.items, ...page2.items, ...page1.items, ...snap.tools];
	assert.equal(all.length, 13);
	assert.equal(new Set(all.map((t) => t.callId)).size, 13, "不允许重复");
	assert.deepEqual(all.map((t) => t.callId), [...completed.map((t) => t.callId), "live-1"]);
	// 每个签发过的游标锚都是已完结工具（进行中的 MAX order 项永不成为锚、不被分页重复）
	for (const cursor of [tailCursor, page1.cursor!, page2.cursor!]) {
		assert.match(cursor, /^t2\.\d+\.c\d+\.[0-9a-f]{32}$/);
		assert.doesNotMatch(cursor, /live-1/);
	}
});

test("tools 游标防护：篡改/伪造/跨会话/跨种类固定拒绝，错误只回发起连接", async () => {
	let injected: Session | undefined;
	const env = await startGateway([], {
		toolsTail: { maxItems: 2 },
		sessionProbe: (session) => { injected = session; },
	});
	const owner1 = await connect(env);
	await owner1.waitFor(() => owner1.find("session.ready") !== undefined);
	const sid1 = owner1.find("session.ready")!.sessionId;
	const tools: ToolView[] = Array.from({ length: 3 }, (_, i) => ({ callId: `t${i}`, order: i + 1, action: { tool: "read", path: `f${i}.txt` }, output: `out-${i}`, ok: true }));
	injected!.publish({ type: "session.snapshot", view: { tools, messages: [] } as unknown as SessionView });
	const c1 = await connect(env, `&session=${sid1}`);
	await c1.waitFor(() => c1.find("session.snapshot") !== undefined);
	const cursor1 = c1.find("session.snapshot")!.view.toolsHistory!.cursor!;
	// 尾页 [t1,t2]、oldestIncluded=1：锚=tools[0]=t0（覆盖范围=[t0]，与 history 同一公式）
	assert.match(cursor1, /^t2\.1\.t0\.[0-9a-f]{32}$/);

	// 篡改 idx：签名覆盖旧 idx，验签必败 → 固定类别拒绝；错误只定向回发起连接
	const owner1ErrorsBefore = owner1.events.filter((e) => e.type === "error").length;
	c1.send({ type: "tools.page", sessionId: sid1, cursor: cursor1.replace(/^t2\.1\./, "t2.0.") });
	await c1.waitFor(() => c1.events.some((e) => e.type === "error" && e.message.includes("游标无效")));
	assert.equal(owner1.events.filter((e) => e.type === "error").length, owner1ErrorsBefore, "分页错误只回发起连接，不得广播");

	// 伪造：形状合法但签名是编的
	const forged = "t2.1.t1." + "0".repeat(32);
	c1.send({ type: "tools.page", sessionId: sid1, cursor: forged });
	await c1.waitFor(() => c1.events.filter((e) => e.type === "error" && e.message.includes("游标无效")).length >= 2);

	// 跨会话：会话 1 签发的 tools 游标拿到会话 2 用 —— HMAC 绑定 sessionId，验签必败
	const owner2 = await connect(env);
	await owner2.waitFor(() => owner2.find("session.ready") !== undefined);
	const sid2 = owner2.find("session.ready")!.sessionId;
	owner2.send({ type: "tools.page", sessionId: sid2, cursor: cursor1 });
	await owner2.waitFor(() => owner2.events.some((e) => e.type === "error" && e.message.includes("游标无效")));

	// 跨种类：history 游标（v2 形）不得用于 tools.page，tools 游标（t2 形）不得用于
	// history.page —— 形状层双向互斥，入口即拒（固定文案 cursor 无效）
	c1.send({ type: "tools.page", sessionId: sid1, cursor: "v2.1.m1." + "a".repeat(32) });
	await c1.waitFor(() => c1.events.some((e) => e.type === "error" && e.message.includes("cursor 无效")));
	c1.send({ type: "history.page", sessionId: sid1, cursor: cursor1 });
	await c1.waitFor(() => c1.events.filter((e) => e.type === "error" && e.message.includes("cursor 无效")).length >= 2);
});

test("tools 数组前缀重构：旧游标固定失效不静默错位，重构后新游标正常翻页", async () => {
	let injected: Session | undefined;
	const env = await startGateway([], {
		toolsTail: { maxItems: 4 },
		sessionProbe: (session) => { injected = session; },
	});
	const driver = await connect(env);
	await driver.waitFor(() => driver.find("session.ready") !== undefined);
	const sessionId = driver.find("session.ready")!.sessionId;
	const authoritative: ToolView[] = Array.from({ length: 12 }, (_, i) => ({ callId: `c${i}`, order: i + 1, action: { tool: "read", path: `f${i}.txt` }, output: `out-${i}`, ok: true }));
	injected!.publish({ type: "session.snapshot", view: { tools: authoritative, messages: [] } as unknown as SessionView });
	await driver.waitFor(() => driver.events.some(snapshotWithToolsTotal(12)));

	const c = await connect(env, `&session=${sessionId}`);
	await c.waitFor(() => c.find("session.snapshot") !== undefined);
	const snap = c.find("session.snapshot")!.view;
	const oldCursor = snap.toolsHistory!.cursor!;
	assert.match(oldCursor, /^t2\.8\.c7\.[0-9a-f]{32}$/);
	const page1 = await requestToolsPage(c, sessionId, oldCursor);
	assert.deepEqual(page1.items.map((t) => t.callId), ["c4", "c5", "c6", "c7"]);

	// 模拟前缀重构（同 S5a 压缩模拟的注入缝）：splice 掉前 2 条、前置一个伪摘要工具。
	// 旧游标 idx=8 仍在界内，但锚定的 tools[7].callId 已从 c7 漂移为 c8 —— 必须走锚点
	// 失配分支而不是静默错位
	const summary: ToolView = { callId: "900000", order: 0, action: { tool: "read", path: "summary" }, output: "（工具摘要）最早 2 个已压缩", ok: true };
	const rebuilt: ToolView[] = [summary, ...authoritative.slice(2)];
	assert.equal(rebuilt.length, 11);
	injected!.publish({ type: "session.snapshot", view: { tools: rebuilt, messages: [] } as unknown as SessionView });
	await c.waitFor(() => c.events.filter((e) => e.type === "session.snapshot").length >= 2);

	// 旧游标：签名真实但锚点已漂移 → 「游标已失效」定向错误、零数据下发
	const pagesBefore = c.events.filter((e) => e.type === "tools.page").length;
	c.send({ type: "tools.page", sessionId, cursor: oldCursor });
	await c.waitFor(() => c.events.some((e) => e.type === "error" && e.message.includes("游标已失效")));
	assert.equal(c.events.filter((e) => e.type === "tools.page").length, pagesBefore, "失效游标不得返回任何条目");

	// 重构后新游标正常翻页：全集与重构后数组逐 callId 全等，无旧前缀复活
	const fresh = await connect(env, `&session=${sessionId}`);
	await fresh.waitFor(() => fresh.find("session.snapshot") !== undefined);
	const snap2 = fresh.find("session.snapshot")!.view;
	assert.equal(snap2.toolsHistory!.total, 11);
	assert.equal(snap2.tools.length, 4);
	assert.deepEqual(snap2.tools.map((t) => t.callId), ["c8", "c9", "c10", "c11"]);
	const page = await requestToolsPage(fresh, sessionId, snap2.toolsHistory!.cursor!);
	assert.equal(page.items.length, 4);
	assert.notEqual(page.cursor, null);
	const last = await requestToolsPage(fresh, sessionId, page.cursor!);
	assert.deepEqual(last.items.map((t) => t.callId), [summary.callId, "c2", "c3"]);
	assert.equal(last.cursor, null);
	assert.deepEqual([...last.items, ...page.items, ...snap2.tools].map((t) => t.callId), rebuilt.map((t) => t.callId));
});

test("tools.page 授权：viewer 可翻页；撤权后连接关闭、拿不到数据", async () => {
	let injected: Session | undefined;
	const env = await startGateway([], {
		toolsTail: { maxItems: 2 },
		sessionProbe: (session) => { injected = session; },
	});
	const owner1 = await connect(env);
	await owner1.waitFor(() => owner1.find("session.ready") !== undefined);
	const sid1 = owner1.find("session.ready")!.sessionId;
	const tools: ToolView[] = Array.from({ length: 4 }, (_, i) => ({ callId: `t${i}`, order: i + 1, action: { tool: "read", path: `f${i}.txt` }, output: `out-${i}`, ok: true }));
	injected!.publish({ type: "session.snapshot", view: { tools, messages: [] } as unknown as SessionView });
	await owner1.waitFor(() => owner1.events.some(snapshotWithToolsTotal(4)));

	// viewer 正控：只读成员可翻被裁掉的旧工具
	owner1.send({ type: "share", actor: "bob", role: "viewer" });
	await new Promise((r) => setTimeout(r, 50));
	const bob = await connect(env, `&actor=bob&session=${sid1}`);
	await bob.waitFor(() => bob.find("session.snapshot") !== undefined);
	assert.equal(bob.find("session.snapshot")!.view.role, "viewer");
	const bobCursor = bob.find("session.snapshot")!.view.toolsHistory!.cursor!;
	const bobPage = await requestToolsPage(bob, sid1, bobCursor);
	assert.ok(bobPage.items.length > 0, "viewer 必须能读被裁掉的旧工具");

	// 撤权：连接立即 4003 关闭，再无分页数据
	owner1.send({ type: "unshare", actor: "bob" });
	await bob.waitFor(() => bob.closeCode !== undefined, 5_000);
	assert.equal(bob.closeCode, 4003, "撤权必须立即断开旧连接");
	const pagesAfter = bob.events.filter((e) => e.type === "tools.page").length;
	assert.equal(pagesAfter, 1, "撤权后不得再收到分页数据");
});
