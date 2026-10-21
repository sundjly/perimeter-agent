import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { AuditLog } from "../src/audit/log.ts";
import { Gateway } from "../src/gateway/server.ts";
import type { ClientEvent } from "../src/protocol/types.ts";

/**
 * S3b：显式创建收据 + 消息幂等（handoff §3.1、验收矩阵「并发重复 create/prompt」行）。
 * 真实 Gateway + mock 模型，127.0.0.1，临时目录；不放宽任何既有安全行为。
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MOCK = join(REPO, "tests/fixtures/mock-model.mjs");
const TOKEN = "test-token";

interface Client {
	ws: WebSocket;
	events: ClientEvent[];
	controls: { control?: string; message?: string }[];
	waitFor: (pred: () => boolean, ms?: number) => Promise<void>;
	find: <T extends ClientEvent["type"]>(type: T) => Extract<ClientEvent, { type: T }> | undefined;
	send: (cmd: Record<string, unknown>) => void;
	close: () => void;
}

async function connect(url: string, query = "", token = TOKEN): Promise<Client> {
	const ws = new WebSocket(`${url.replace("http", "ws")}/?token=${token}${query}`);
	const events: ClientEvent[] = [];
	const controls: { control?: string; message?: string }[] = [];
	ws.on("message", (raw) => {
		const msg = JSON.parse(String(raw));
		if (msg.type === "control") { controls.push(msg); return; }
		events.push(msg.event);
	});
	await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
	const waitFor = async (pred: () => boolean, ms = 20_000) => {
		const deadline = Date.now() + ms;
		while (!pred()) {
			if (Date.now() > deadline) throw new Error(`waitFor 超时；已收到 ${events.map((e) => e.type).join(",")}`);
			await new Promise((r) => setTimeout(r, 20));
		}
	};
	return {
		ws, events, controls, waitFor,
		find: (type) => events.find((e) => e.type === type) as never,
		send: (cmd) => ws.send(JSON.stringify(cmd)),
		close: () => ws.close(),
	};
}

function newGateway(stateRoot: string, extra: Partial<ConstructorParameters<typeof Gateway>[0]> = {}): Gateway {
	return new Gateway({
		mode: "demo", port: 0, host: "127.0.0.1", token: TOKEN,
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(stateRoot, "audit.jsonl"),
		workspaceRoot: join(stateRoot, "workspaces"),
		stateRoot,
		webRoot: join(REPO, "web"),
		...extra,
	});
}

interface MockModel { port: number; requestsFile: string; kill: () => void }

async function startMock(dir: string): Promise<MockModel> {
	const requestsFile = join(dir, "requests.jsonl");
	const mock = spawn(process.execPath, [MOCK, "0", JSON.stringify([{ text: "ok" }, { text: "ok" }, { text: "ok" }, { text: "ok" }]), requestsFile], { stdio: ["ignore", "pipe", "inherit"] });
	const port = await new Promise<number>((r, j) => {
		const timer = setTimeout(() => j(new Error("mock 模型启动超时")), 10_000);
		mock.stdout?.once("data", (d: Buffer) => { clearTimeout(timer); r(JSON.parse(d.toString()).port); });
	});
	return { port, requestsFile, kill: () => void mock.kill() };
}

const countRequests = (file: string): number => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0);

const modelOf = (mock: MockModel) => ({ baseUrl: `http://127.0.0.1:${mock.port}/v1`, token: "dummy", model: "mock-model" });

async function auditEntries(file: string): Promise<{ kind: string; summary: string; verdict?: string }[]> {
	const out: { kind: string; summary: string; verdict?: string }[] = [];
	for await (const e of AuditLog.replay(file)) out.push(e);
	return out;
}

/** 收据目录 = principalId 的 sha256：客户端字符串永不参与路径拼接 */
function receiptPath(stateRoot: string, principalId: string, operationId: string): string {
	return join(stateRoot, "receipts", createHash("sha256").update(principalId).digest("hex"), `${operationId}.json`);
}

function readReceipt(stateRoot: string, principalId: string, operationId: string): { operationId: string; principalId: string; requestId: string; requestHash: string; sessionId: string; stage: string; outcome: string; createdAt: string; updatedAt: string } {
	// 具体形状而非 Record<string,string>：noUncheckedIndexedAccess 下索引签名会变 string|undefined
	return JSON.parse(readFileSync(receiptPath(stateRoot, principalId, operationId), "utf8")) as { operationId: string; principalId: string; requestId: string; requestHash: string; sessionId: string; stage: string; outcome: string; createdAt: string; updatedAt: string };
}

async function waitUntil(pred: () => boolean, ms: number, what: string): Promise<void> {
	const deadline = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

function waitExit(child: ChildProcess, ms: number): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("子进程退出超时")), ms);
		child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
	});
}

test("S3b-1: 显式创建写收据；同键同内容重放返回原 sessionId 且审计标 replay；同键异内容固定拒绝；隐式创建也写收据", async () => {
	const dir = mkdtempSync(join(tmpdir(), "receipt-1-"));
	const mock = await startMock(dir);
	const gateway = newGateway(dir, { model: modelOf(mock) });
	const port = await gateway.listen();
	const c = await connect(`http://127.0.0.1:${port}`);
	try {
		await c.waitFor(() => c.find("session.ready") !== undefined);
		c.send({ type: "create", operationId: "op-1" });
		await c.waitFor(() => c.events.some((e) => e.type === "session.created"));
		const first = c.events.find((e) => e.type === "session.created")!;
		assert.equal(first.type, "session.created");
		if (first.type !== "session.created") return;
		assert.equal(first.replayed, false);
		assert.equal(first.operationId, "op-1");
		// 收据已持久化：harness_ready / created（真实 start 完成后才到终态）
		const receipt = readReceipt(dir, "demo@local", "op-1");
		assert.equal(receipt.sessionId, first.sessionId);
		assert.equal(receipt.stage, "harness_ready");
		assert.equal(receipt.outcome, "created");
		assert.equal(receipt.principalId, "demo@local");
		// 同键同内容重放：原 sessionId，不新建资源
		const sessionsBefore = gateway.sessionCount;
		c.send({ type: "create", operationId: "op-1" });
		await c.waitFor(() => c.events.filter((e) => e.type === "session.created").length === 2);
		const second = c.events.filter((e) => e.type === "session.created")[1]!;
		if (second.type !== "session.created") return;
		assert.equal(second.replayed, true);
		assert.equal(second.sessionId, first.sessionId);
		assert.equal(gateway.sessionCount, sessionsBefore, "重放不得新建会话");
		// 同键异内容：固定类别拒绝，无新会话
		c.send({ type: "create", operationId: "op-1", requestHash: "deadbeef" });
		await c.waitFor(() => c.events.some((e) => e.type === "error" && e.code === "command_failed" && e.message.includes("不同内容")));
		assert.equal(gateway.sessionCount, sessionsBefore);
		// 审计：受理、终态、replay 标记齐全；隐式创建也写了 auto- 收据
		const entries = await auditEntries(join(dir, "audit.jsonl"));
		assert.ok(entries.some((e) => e.kind === "session.create" && e.summary.includes("op-1") && e.summary.includes("受理")));
		assert.ok(entries.some((e) => e.kind === "session.create" && e.summary.includes("replay")));
		assert.ok(entries.some((e) => e.kind === "session.create" && e.summary.includes("auto-") && e.summary.includes("受理")));
	} finally {
		c.close();
		await gateway.close();
		mock.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("S3b-2: 不同身份即使同键同内容也不共用收据（按 principal 隔离）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "receipt-2-"));
	const mock = await startMock(dir);
	const gateway = newGateway(dir, { model: modelOf(mock) });
	const port = await gateway.listen();
	const alice = await connect(`http://127.0.0.1:${port}`, "&actor=alice");
	const bob = await connect(`http://127.0.0.1:${port}`, "&actor=bob");
	try {
		await alice.waitFor(() => alice.find("session.ready") !== undefined);
		await bob.waitFor(() => bob.find("session.ready") !== undefined);
		alice.send({ type: "create", operationId: "op-shared", requestHash: "samehash" });
		bob.send({ type: "create", operationId: "op-shared", requestHash: "samehash" });
		await alice.waitFor(() => alice.events.some((e) => e.type === "session.created"));
		await bob.waitFor(() => bob.events.some((e) => e.type === "session.created"));
		const a = alice.find("session.created")!;
		const b = bob.find("session.created")!;
		if (a.type !== "session.created" || b.type !== "session.created") return;
		assert.notEqual(a.sessionId, b.sessionId, "不同身份不得共用会话");
		assert.equal(a.replayed, false);
		assert.equal(b.replayed, false);
		// 各自目录下各有一份收据，互不读写
		assert.equal(readReceipt(dir, "alice", "op-shared").sessionId, a.sessionId);
		assert.equal(readReceipt(dir, "bob", "op-shared").sessionId, b.sessionId);
	} finally {
		alice.close();
		bob.close();
		await gateway.close();
		mock.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("S3b-3: 并发 N 个同键 create 只产生一个会话（单飞），等待者拿到同一结果并标 replay", async () => {
	const dir = mkdtempSync(join(tmpdir(), "receipt-3-"));
	const mock = await startMock(dir);
	const gateway = newGateway(dir, { model: modelOf(mock) });
	const port = await gateway.listen();
	const conns: Client[] = [];
	try {
		for (let i = 0; i < 8; i++) {
			const conn = await connect(`http://127.0.0.1:${port}`, "&actor=carol");
			conns.push(conn);
			await conn.waitFor(() => conn.find("session.ready") !== undefined);
			conn.send({ type: "create", operationId: "op-par", requestHash: "fixed" });
		}
		await Promise.all(conns.map((conn) => conn.waitFor(() => conn.events.some((e) => e.type === "session.created"))));
		const replies = conns.map((conn) => conn.find("session.created")!).filter((e) => e.type === "session.created");
		const sessionIds = new Set(replies.map((e) => (e.type === "session.created" ? e.sessionId : "")));
		assert.equal(sessionIds.size, 1, "并发同键 create 只允许一个 sessionId");
		const replayedCount = replies.filter((e) => e.type === "session.created" && e.replayed).length;
		assert.ok(replayedCount >= 7, `恰一个 created，其余为 replay（实际 replay=${replayedCount}）`);
		assert.equal(readdirSync(join(dir, "receipts", createHash("sha256").update("carol").digest("hex"))).filter((f) => f === "op-par.json").length, 1, "恰一份收据");
		const entries = await auditEntries(join(dir, "audit.jsonl"));
		const accepted = entries.filter((e) => e.kind === "session.create" && e.summary.includes("op-par") && e.summary.includes("受理"));
		assert.equal(accepted.length, 1, "受理审计恰一条（单飞）");
	} finally {
		for (const conn of conns) conn.close();
		await gateway.close();
		mock.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("S3b-4: 注入 accepted 后抛错 → 收据终态 failed、不建工作区；重放原样返回 failed 不重做", async () => {
	const dir = mkdtempSync(join(tmpdir(), "receipt-4-"));
	const mock = await startMock(dir);
	const gateway = newGateway(dir, {
		model: modelOf(mock),
		createStageProbe: (stage) => { if (stage === "accepted") throw new Error("注入失败"); },
	});
	const port = await gateway.listen();
	const c = await connect(`http://127.0.0.1:${port}`);
	try {
		await c.waitFor(() => c.find("session.ready") !== undefined);
		c.send({ type: "create", operationId: "op-fail" });
		await c.waitFor(() => c.events.some((e) => e.type === "error" && e.code === "command_failed" && e.message.includes("会话创建失败")));
		const receipt = readReceipt(dir, "demo@local", "op-fail");
		assert.equal(receipt.stage, "failed");
		assert.equal(receipt.outcome, "failed");
		assert.equal(existsSync(join(dir, "workspaces", receipt.sessionId)), false, "外部副作用不得发生（无工作区）");
		// 重放：原样返回 failed 收据，不重做创建
		c.send({ type: "create", operationId: "op-fail" });
		await c.waitFor(() => c.events.some((e) => e.type === "session.created"));
		const replay = c.events.find((e) => e.type === "session.created")!;
		if (replay.type !== "session.created") return;
		assert.equal(replay.replayed, true);
		assert.equal(replay.stage, "failed");
		assert.equal(existsSync(join(dir, "workspaces", receipt.sessionId)), false, "重放不得重做外部副作用");
	} finally {
		c.close();
		await gateway.close();
		mock.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("S3b-5: 子进程 kill -9 于创建中途 → 重启后收据 outcome_unknown、不当成功、不自动重做外部副作用", async () => {
	const dir = mkdtempSync(join(tmpdir(), "receipt-5-"));
	const mock = await startMock(dir);
	const stateRoot = join(dir, "state");
	// fixture 的网关 token 与 auditFile 与本文件默认值不同（见 tests/fixtures/gateway-process.ts），对齐不改 fixture
	const fixtureToken = "test-gateway-token";
	const fixtureAudit = join(dir, "gateway.jsonl");
	const baseEnv = { PATH: process.env.PATH, PERIMETER_TEST_ROOT: dir, PERIMETER_TEST_MODEL_URL: `http://127.0.0.1:${mock.port}/v1` };
	const launch = async (park: boolean) => {
		const child = spawn(process.execPath, [join(REPO, "tests/fixtures/gateway-process.ts")], {
			env: park ? { ...baseEnv, PERIMETER_TEST_CREATE_PROBE_PARK: "1" } : baseEnv,
			stdio: ["ignore", "pipe", "inherit"],
		});
		const port = await new Promise<number>((r, j) => {
			const timer = setTimeout(() => j(new Error("网关子进程启动超时")), 15_000);
			child.stdout?.once("data", (d: Buffer) => { clearTimeout(timer); r(JSON.parse(d.toString()).port); });
		});
		return { child, port };
	};
	let child1: ChildProcess | undefined;
	let child2: ChildProcess | undefined;
	const sockets: WebSocket[] = [];
	try {
		const first = await launch(true);
		child1 = first.child;
		const c1 = await connect(`http://127.0.0.1:${first.port}`, "", fixtureToken);
		sockets.push(c1.ws);
		await c1.waitFor(() => c1.find("session.ready") !== undefined);
		// 显式创建在 workspace_ready 后被注入点挂起（隐式创建不受影响，session.ready 已到）
		c1.send({ type: "create", operationId: "op-crash" });
		await waitUntil(() => {
			if (!existsSync(receiptPath(stateRoot, "demo@local", "op-crash"))) return false;
			return readReceipt(stateRoot, "demo@local", "op-crash").stage === "workspace_ready";
		}, 15_000, "收据停在 workspace_ready");
		const crashed = readReceipt(stateRoot, "demo@local", "op-crash");
		const workspacesBefore = readdirSync(join(dir, "workspaces"));
		// kill -9：没有任何收尾机会 —— 这就是「outcome_unknown」要覆盖的真实世界状态
		const exit = waitExit(child1!, 10_000);
		child1!.kill("SIGKILL");
		await exit;
		c1.ws.terminate();

		// 重启：恢复扫描必须把未终态收据标 outcome_unknown，create 重放原样返回、不重做
		const second = await launch(false);
		child2 = second.child;
		const c2 = await connect(`http://127.0.0.1:${second.port}`, "", fixtureToken);
		sockets.push(c2.ws);
		await c2.waitFor(() => c2.find("session.ready") !== undefined);
		c2.send({ type: "create", operationId: "op-crash" });
		await c2.waitFor(() => c2.events.some((e) => e.type === "session.created"), 30_000);
		const reply = c2.events.find((e) => e.type === "session.created")!;
		if (reply.type !== "session.created") return;
		assert.equal(reply.replayed, true);
		assert.equal(reply.sessionId, crashed.sessionId, "返回崩溃前的原 sessionId");
		assert.equal(reply.stage, "outcome_unknown");
		assert.equal(reply.outcome, "unknown");
		const disk = readReceipt(stateRoot, "demo@local", "op-crash");
		assert.equal(disk.stage, "outcome_unknown");
		const added = readdirSync(join(dir, "workspaces")).filter((d) => !workspacesBefore.includes(d));
		assert.equal(added.length, 1, "重启后只允许出现重连实例自己的隐式会话工作区，不得为同一 operationId 再建第二个");
		assert.equal(countRequests(mock.requestsFile), 0, "全程不得有任何模型生成");
		const entries = await auditEntries(fixtureAudit);
		assert.ok(entries.some((e) => e.kind === "session.create" && e.summary.includes("outcome_unknown")), "恢复标记必须进审计");
	} finally {
		for (const ws of sockets) ws.terminate();
		for (const child of [child1, child2]) {
			if (child && child.exitCode === null && child.signalCode === null) {
				try { const e = waitExit(child, 10_000); child.kill("SIGTERM"); await e; } catch { /* 已退出 */ }
			}
		}
		mock.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("S3b-6: TTL 清理只删过期收据，不影响活会话；过期后同键 create 视为新创建", async () => {
	const dir = mkdtempSync(join(tmpdir(), "receipt-6-"));
	const mock = await startMock(dir);
	const gateway = newGateway(dir, { model: modelOf(mock), receiptTtlMs: 50 });
	const port = await gateway.listen();
	const c = await connect(`http://127.0.0.1:${port}`);
	try {
		await c.waitFor(() => c.find("session.ready") !== undefined);
		c.send({ type: "create", operationId: "op-ttl" });
		await c.waitFor(() => c.events.some((e) => e.type === "session.created"));
		const created = c.events.find((e) => e.type === "session.created")!;
		if (created.type !== "session.created") return;
		assert.equal(existsSync(receiptPath(dir, "demo@local", "op-ttl")), true);
		await waitUntil(() => !existsSync(receiptPath(dir, "demo@local", "op-ttl")), 10_000, "TTL 清理删除收据");
		// 活会话不受影响：会话仍在表里，工作区仍在盘上
		assert.ok(gateway.sessionCount >= 2, "清理不得触碰活会话");
		assert.equal(existsSync(join(dir, "workspaces", created.sessionId)), true);
	} finally {
		c.close();
		await gateway.close();
		mock.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("S3b-7: prompt 同 requestId 异内容固定拒绝；同内容与跨网关重启重放都不重复模型生成", async () => {
	const dir = mkdtempSync(join(tmpdir(), "receipt-7-"));
	const mock = await startMock(dir);
	let gateway = newGateway(dir, { model: modelOf(mock) });
	let port = await gateway.listen();
	let c = await connect(`http://127.0.0.1:${port}`);
	try {
		await c.waitFor(() => c.find("session.ready") !== undefined);
		const sid = c.find("session.ready")!.sessionId;
		c.send({ type: "prompt", text: "内容甲", requestId: "r1" });
		await c.waitFor(() => c.events.some((e) => e.type === "agent.end"));
		assert.equal(countRequests(mock.requestsFile), 1);
		// 同 requestId 不同内容：固定类别拒绝，不得当作重放、不得生成第二次调用
		c.send({ type: "prompt", text: "内容乙", requestId: "r1" });
		await c.waitFor(() => c.events.some((e) => e.type === "error" && e.code === "command_failed" && e.message.includes("不同内容")));
		assert.equal(countRequests(mock.requestsFile), 1);
		// 同 requestId 同内容重复：不重复模型生成
		c.send({ type: "prompt", text: "内容甲", requestId: "r1" });
		await c.waitFor(() => c.events.some((e) => e.type === "error" && e.code === "command_failed" && e.message.includes("不重复生成")));
		assert.equal(countRequests(mock.requestsFile), 1);
		// 跨网关重启后同 requestId 重放：同样不重复生成
		c.close();
		await gateway.close();
		gateway = newGateway(dir, { model: modelOf(mock) });
		port = await gateway.listen();
		c = await connect(`http://127.0.0.1:${port}`, `&session=${sid}`);
		await c.waitFor(() => c.events.some((e) => e.type === "session.snapshot"));
		c.send({ type: "prompt", text: "内容甲", requestId: "r1" });
		await c.waitFor(() => c.events.some((e) => e.type === "error" && e.code === "command_failed" && e.message.includes("不重复生成")));
		assert.equal(countRequests(mock.requestsFile), 1, "重启后重放不得重复生成");
		// 新键正常受理（mock 第二轮），证明拒绝不是把会话打死了
		c.send({ type: "prompt", text: "内容乙", requestId: "r2" });
		await c.waitFor(() => c.events.filter((e) => e.type === "agent.end").length === 1, 30_000);
		assert.equal(countRequests(mock.requestsFile), 2);
	} finally {
		c.close();
		await gateway.close();
		mock.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("S3b-8: readyz 并发探测不误报、探针文件不残留；结果短时缓存", async () => {
	const dir = mkdtempSync(join(tmpdir(), "receipt-8-"));
	const mock = await startMock(dir);
	const gateway = newGateway(dir, { model: modelOf(mock) });
	const port = await gateway.listen();
	try {
		const url = `http://127.0.0.1:${port}/readyz`;
		const results = await Promise.all(Array.from({ length: 20 }, () => fetch(url)));
		const statuses = results.map((r) => r.status);
		assert.ok(statuses.every((s) => s === 200), `并发探测出现非 200：${statuses.join(",")}`);
		// ≥1s 内复用上次结果（缓存路径），依旧是 200
		assert.equal((await fetch(url)).status, 200);
		assert.equal((await fetch(url)).status, 200);
		const leftovers = readdirSync(dir).filter((f) => f.startsWith(".readyz-probe"));
		assert.deepEqual(leftovers, [], "探针文件不得残留");
	} finally {
		await gateway.close();
		mock.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});
