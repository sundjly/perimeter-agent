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
	// 截断快照整体替换透传，元信息随快照更新
	state = reduce(state, { type: "session.snapshot", view: { ...initialState(), sessionId: "s", tools: [{ callId: "e", action: { tool: "bash", command: "c" }, output: "y", truncated: true, originalBytes: 9 }], toolsHistory: { total: 7, oldestIncluded: 6 } } });
	assert.equal(state.tools[0]!.truncated, true);
	assert.equal(state.tools[0]!.originalBytes, 9);
	assert.deepEqual(state.toolsHistory, { total: 7, oldestIncluded: 6 });
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
	// tools 元信息：全部工具都在尾页里
	assert.deepEqual(snap.toolsHistory, { total: 1, oldestIncluded: 0 });
	assert.equal(snap.history!.cursor, null);
});

test("注入形确定性：单工具 64KiB 截断标记与原始字节；快照/增量双出口都有界", async () => {
	// 真实 bash 输出受 vendor 50KiB 窗口约束，撞不到 64KiB —— 截断标记走 publish()
	// 公开协议面注入（与 S5a 压缩模拟同一测试缝；生产不配置 sessionProbe 零行为），
	// 确定性验证本层的 #clipTool/#clipToolEvent，不依赖 vendor 默认值
	let injected: Session | undefined;
	const env = await startGateway([], {
		toolsTail: { maxItems: 2, maxBytes: 1024 * 1024 },
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
	assert.deepEqual(liveSnap.toolsHistory, { total: 3, oldestIncluded: 1 });
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
	assert.deepEqual(snap.toolsHistory, { total: 3, oldestIncluded: 1 });
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
	assert.deepEqual(snap.toolsHistory, { total: 260, oldestIncluded: 60 });
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
