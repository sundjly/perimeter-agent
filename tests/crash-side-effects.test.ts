import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { AuditLog } from "../src/audit/log.ts";
import { Gateway } from "../src/gateway/server.ts";
import { ReceiptStore } from "../src/gateway/receipt-store.ts";
import type { ClientEvent } from "../src/protocol/types.ts";

/**
 * S3c：崩溃副作用与生命周期故障注入（handoff §3.1 后三条 / §3.3 审计不可用 / §8「崩溃/磁盘满」行）。
 * 127.0.0.1 + 临时目录 + mock 模型；真实崩溃用子进程 kill -9（tests/fixtures/gateway-process.ts 的
 * 注入 env，默认行为不变）；磁盘满用目录 chmod 0500 注入，不真写满磁盘。不放宽既有安全行为。
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MOCK = join(REPO, "tests/fixtures/mock-model.mjs");
const FIXTURE = join(REPO, "tests/fixtures/gateway-process.ts");
const FIXTURE_TOKEN = "test-gateway-token";
const TOKEN = "test-token";

interface MockModel { port: number; requestsFile: string; kill: () => void }

async function startMock(dir: string, script: unknown[]): Promise<MockModel> {
	const requestsFile = join(dir, "requests.jsonl");
	const mock = spawn(process.execPath, [MOCK, "0", JSON.stringify(script), requestsFile], { stdio: ["ignore", "pipe", "inherit"] });
	const port = await new Promise<number>((r, j) => {
		const timer = setTimeout(() => j(new Error("mock 模型启动超时")), 10_000);
		mock.stdout?.once("data", (d: Buffer) => { clearTimeout(timer); r(JSON.parse(d.toString()).port); });
	});
	return { port, requestsFile, kill: () => void mock.kill() };
}

const modelOf = (mock: MockModel) => ({ baseUrl: `http://127.0.0.1:${mock.port}/v1`, token: "dummy", model: "mock-model" });

const countRequests = (file: string): number => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0);

interface Client {
	ws: WebSocket;
	events: ClientEvent[];
	send: (cmd: Record<string, unknown>) => void;
	waitFor: (pred: () => boolean, ms?: number, what?: string) => Promise<void>;
	errorCount: () => number;
	close: () => void;
}

async function connect(port: number, query = "", token = TOKEN): Promise<Client> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}${query}`);
	const events: ClientEvent[] = [];
	ws.on("message", (raw) => {
		const msg = JSON.parse(String(raw));
		if (msg.type !== "control" && msg.event) events.push(msg.event);
	});
	await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
	return {
		ws, events,
		send: (cmd) => ws.send(JSON.stringify(cmd)),
		waitFor: async (pred, ms = 20_000, what = "事件") => {
			const deadline = Date.now() + ms;
			while (!pred()) {
				if (Date.now() > deadline) throw new Error(`waitFor 超时：${what}；已收到 ${events.map((e) => e.type).join(",")}`);
				await new Promise((r) => setTimeout(r, 20));
			}
		},
		errorCount: () => events.filter((e) => e.type === "error").length,
		close: () => ws.close(),
	};
}

async function waitUntil(pred: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await pred())) {
		if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

/** readyz 轮询（服务端缓存 ≥1s，必须轮询等待翻转） */
async function pollReadyStatus(port: number, expect: number, ms: number): Promise<void> {
	await waitUntil(async () => (await fetch(`http://127.0.0.1:${port}/readyz`)).status === expect, ms, `readyz 变为 ${expect}`);
}

function waitExit(child: ChildProcess, ms: number): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("子进程退出超时")), ms);
		child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
	});
}

async function auditEntries(file: string): Promise<{ kind: string; summary: string; verdict?: string; callId?: string; argsHash?: string; approver?: string }[]> {
	const out: { kind: string; summary: string; verdict?: string; callId?: string; argsHash?: string; approver?: string }[] = [];
	for await (const e of AuditLog.replay(file)) out.push(e);
	return out;
}

/** 子进程网关（tests/fixtures/gateway-process.ts；默认行为，注入只走 env） */
async function launchFixture(dir: string, mockPort: number, extraEnv: Record<string, string> = {}): Promise<{ child: ChildProcess; port: number }> {
	const child = spawn(process.execPath, [FIXTURE], {
		env: { PATH: process.env.PATH, PERIMETER_TEST_ROOT: dir, PERIMETER_TEST_MODEL_URL: `http://127.0.0.1:${mockPort}/v1`, ...extraEnv },
		stdio: ["ignore", "pipe", "inherit"],
	});
	const port = await new Promise<number>((r, j) => {
		const timer = setTimeout(() => j(new Error("网关子进程启动超时")), 15_000);
		child.stdout?.once("data", (d: Buffer) => { clearTimeout(timer); r(JSON.parse(d.toString()).port); });
	});
	return { child, port };
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
	if (child && child.exitCode === null && child.signalCode === null) {
		try { const e = waitExit(child, 10_000); child.kill("SIGTERM"); await e; } catch { /* 已退出 */ }
	}
}

test("S3c-1: unsafe 工具执行中 kill -9 → 重启不自动重放（副作用恰一次）；outcome_unknown 对成员可见并审计留痕", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s3c-1-"));
	const mock = await startMock(dir, [
		{ tool: "bash", args: { command: "printf run >> runs.txt; echo $$ > pgid.txt; sleep 30" } },
		{ text: "恢复完成" },
	]);
	const auditFile = join(dir, "gateway.jsonl");
	let child: ChildProcess | undefined;
	let orphanPgid: number | undefined; // kill -9 后无人收尸的孤儿进程组；测试自行回收（残留风险见 ask）
	const sockets: WebSocket[] = [];
	try {
		const first = await launchFixture(dir, mock.port);
		child = first.child;
		const owner = await connect(first.port, "", FIXTURE_TOKEN);
		sockets.push(owner.ws);
		await owner.waitFor(() => owner.events.some((e) => e.type === "session.ready"), 20_000, "首次 session.ready");
		const sid = owner.events.find((e) => e.type === "session.ready")!;
		if (sid.type !== "session.ready") return;
		const wsPath = join(dir, "workspaces", sid.sessionId);
		owner.send({ type: "prompt", text: "跑个慢命令", requestId: "r1" });
		await waitUntil(() => existsSync(join(wsPath, "runs.txt")), 15_000, "bash 副作用落盘（工具执行中）");
		await waitUntil(() => existsSync(join(wsPath, "pgid.txt")), 5_000, "进程组 id 落盘");
		// detached spawn 下工具 bash 自己是组长：$$ 即进程组 id
		const parsedPgid = Number.parseInt(readFileSync(join(wsPath, "pgid.txt"), "utf8").trim(), 10);
		assert.ok(Number.isInteger(parsedPgid) && parsedPgid > 0, "pgid 文件内容必须是正整数");
		orphanPgid = parsedPgid;
		// kill -9：无任何收尾机会 —— 工具停在「结果未知」
		const exit = waitExit(child, 10_000);
		child.kill("SIGKILL");
		await exit;
		owner.close();
		sockets.pop();

		// 重启 + 重新 attach：恢复续跑，不得重放该 unsafe 工具
		const second = await launchFixture(dir, mock.port);
		child = second.child;
		const again = await connect(second.port, `&session=${sid.sessionId}`, FIXTURE_TOKEN);
		sockets.push(again.ws);
		await again.waitFor(() => again.events.some((e) => e.type === "session.ready"), 20_000, "重启后 session.ready");
		// 可见性：outcome_unknown 对会话成员可见——实时 audit.entry 或快照 view.audit 任一（首次
		// attach 的 overflow 窗口会丢弃实时事件，快照必须携带）
		const flagVisible = () => {
			if (again.events.some((e) => e.type === "audit.entry" && e.entry.summary.includes("工具结果未知"))) return true;
			const snap = again.events.find((e) => e.type === "session.snapshot");
			return snap !== undefined && snap.type === "session.snapshot" && snap.view.audit.some((a) => a.summary.includes("工具结果未知"));
		};
		await again.waitFor(flagVisible, 10_000, "outcome_unknown 可见");
		const flagEntry = (() => {
			const live = again.events.find((e) => e.type === "audit.entry" && e.entry.summary.includes("工具结果未知"));
			if (live && live.type === "audit.entry") return live.entry;
			const snap = again.events.find((e) => e.type === "session.snapshot");
			if (snap && snap.type === "session.snapshot") return snap.view.audit.find((a) => a.summary.includes("工具结果未知"))!;
			throw new Error("不可达：flagVisible 已通过");
		})();
		assert.ok(flagEntry.summary.includes("阶段=执行中"), "必须标注执行阶段");
		assert.ok(flagEntry.summary.includes("需人工核对"), "必须带需人工核对标记");
		assert.ok(flagEntry.summary.includes("callId="), "必须带 callId");
		assert.equal(flagEntry.verdict, "deny");
		// 审计留痕：固定类别 error 条目，带 callId 与 argsHash（意图摘要 hash）
		await waitUntil(() => readFileSync(auditFile, "utf8").includes("工具结果未知"), 10_000, "outcome_unknown 审计落链");
		const entries = await auditEntries(auditFile);
		const flagged = entries.filter((e) => e.kind === "error" && e.summary.includes("工具结果未知"));
		assert.equal(flagged.length, 1, "恰一条 outcome_unknown 审计（不重标）");
		assert.ok(flagged[0]!.callId, "审计条目带 callId");
		assert.ok(flagged[0]!.argsHash, "审计条目带意图 hash");
		// 恢复续跑完成（模型收到 interrupted 结果后进入下一轮）
		await again.waitFor(() => again.events.some((e) => e.type === "message.end" && e.text === "恢复完成"), 30_000, "恢复后续跑完成");
		// 不自动重放的硬 oracle：副作用恰发生一次
		assert.equal(readFileSync(join(wsPath, "runs.txt"), "utf8"), "run");
		// 回收孤儿进程组（kill -9 后无人收尸的残留）：测试自行 SIGKILL 整组并验证无残留
		process.kill(-orphanPgid!, "SIGKILL");
		await waitUntil(() => {
			try { process.kill(-orphanPgid!, 0); return false; } catch (err) { return (err as NodeJS.ErrnoException).code === "ESRCH"; }
		}, 5_000, "孤儿进程组退出");
		orphanPgid = undefined;
	} finally {
		for (const ws of sockets) ws.terminate();
		if (orphanPgid !== undefined) { try { process.kill(-orphanPgid, "SIGKILL"); } catch { /* 已退出 */ } }
		await stopChild(child);
		mock.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("S3c-2: 审计不可用 → readyz 503、新 prompt 固定拒绝（不透传 IO 错误）、abort 仍可用", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s3c-2-"));
	const mock = await startMock(dir, [{ text: "ok" }]);
	const audit = AuditLog.open(join(dir, "audit.jsonl"));
	const gateway = new Gateway({
		mode: "demo", port: 0, host: "127.0.0.1", token: TOKEN,
		policyFile: join(REPO, "config/policy.yaml"), auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "workspaces"), stateRoot: dir, webRoot: join(REPO, "web"),
		model: modelOf(mock), auditInstance: audit,
	});
	const port = await gateway.listen();
	let c: Client | undefined;
	try {
		c = await connect(port);
		await c.waitFor(() => c!.events.some((e) => e.type === "session.ready"), 20_000, "session.ready");
		// 注入：审计通道失效（fd 关闭 → 健康位粘滞为假）
		audit.close();
		assert.equal(audit.healthy, false, "close 后健康位必须为假");
		assert.throws(() => audit.checkWritable(), /审计已关闭/, "checkWritable 必须抛出");
		// readyz 翻红（缓存 ≤1s，轮询等待）
		await pollReadyStatus(port, 503, 5_000);
		assert.equal((await fetch(`http://127.0.0.1:${port}/livez`)).status, 200, "liveness 不受影响");
		// 新 prompt：固定类别拒绝（在 submit 审计之前就被门住，不产生任何模型生成）
		c.send({ type: "prompt", text: "不该被受理", requestId: "r1" });
		await c.waitFor(() => c!.events.some((e) => e.type === "error" && String(e.message).includes("审计不可用")), 10_000, "固定类别拒绝");
		const rejected = c.events.find((e) => e.type === "error")!;
		if (rejected.type !== "error") return;
		assert.ok(rejected.message.includes("固定类别"), "拒绝文案必须标固定类别");
		assert.ok(!rejected.message.includes("EACCES") && !rejected.message.includes("EBADF"), "不透传底层 IO 错误");
		assert.equal(countRequests(mock.requestsFile), 0, "审计不可用时不得有任何模型生成");
		// abort 必须仍然可用：不产生新错误
		const afterReject = c.errorCount();
		c.send({ type: "abort" });
		await new Promise((r) => setTimeout(r, 500));
		assert.equal(c.errorCount(), afterReject, "abort 在审计不可用时必须保持可用");
		assert.equal(countRequests(mock.requestsFile), 0);
	} finally {
		c?.close();
		await gateway.close();
		mock.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("S3c-3: stateRoot/receipts 不可写 → readyz 503、账本写失败固定拒新且原文件不损、create 固定拒；恢复后原账本继续有效", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s3c-3-"));
	const mock = await startMock(dir, [{ text: "ok1" }, { text: "ok2" }]);
	const stateRoot = join(dir, "state");
	const gateway = new Gateway({
		mode: "demo", port: 0, host: "127.0.0.1", token: TOKEN,
		policyFile: join(REPO, "config/policy.yaml"), auditFile: join(stateRoot, "audit.jsonl"),
		workspaceRoot: join(dir, "workspaces"), stateRoot, webRoot: join(REPO, "web"),
		model: modelOf(mock),
	});
	const port = await gateway.listen();
	let c: Client | undefined;
	const hardened: string[] = []; // 已 chmod 0500 的目录；finally 逆序恢复，保证 rmSync 不因残留只读目录失败
	try {
		c = await connect(port);
		await c.waitFor(() => c!.events.some((e) => e.type === "session.ready"), 20_000, "session.ready");
		const sid = c.events.find((e) => e.type === "session.ready")!;
		if (sid.type !== "session.ready") return;
		// 正常受理一条 prompt（写账本），捕获账本字节基线
		c.send({ type: "prompt", text: "第一条", requestId: "r1" });
		await c.waitFor(() => c!.events.some((e) => e.type === "agent.end"), 30_000, "第一条完成");
		const ledgerFile = join(stateRoot, "sessions", sid.sessionId, "prompt-ledger.json");
		assert.ok(existsSync(ledgerFile), "prompt 账本应已落盘");
		const ledgerBefore = readFileSync(ledgerFile, "utf8");
		// 注入：磁盘不可写（目录 0500；不真写满磁盘）。stateRoot 管 readyz 探针；
		// sessions/<sid> 管 prompt 账本 tmp；receipts/<principal sha256> 管收据写（save 的
		// tmp+rename 落在 principal 子目录，父目录 0500 拦不住）——三处真实写路径各自封死
		const principalReceiptDir = join(stateRoot, "receipts", createHash("sha256").update("demo@local").digest("hex"));
		for (const target of [stateRoot, join(stateRoot, "sessions", sid.sessionId), principalReceiptDir]) {
			chmodSync(target, 0o500);
			hardened.push(target);
		}
		await pollReadyStatus(port, 503, 5_000);
		// 账本写失败 → 新任务固定类别拒绝，原账本文件一个字节都不动
		c.send({ type: "prompt", text: "写不进去", requestId: "r2" });
		await c.waitFor(() => c!.events.some((e) => e.type === "error" && String(e.message).includes("prompt 幂等账本写入失败")), 10_000, "账本写失败固定拒新");
		assert.equal(readFileSync(ledgerFile, "utf8"), ledgerBefore, "tmp 写失败不得覆盖原账本");
		// create：收据写失败 → 固定类别拒绝，无半态收据；故障窗口内无副作用（工作区数量不变）
		const workspacesBeforeCreate = readdirSync(join(dir, "workspaces"));
		c.send({ type: "create", operationId: "op-x" });
		await c.waitFor(() => c!.events.some((e) => e.type === "error" && String(e.message).includes("会话创建失败")), 10_000, "create 固定拒");
		assert.equal(readdirSync(join(dir, "workspaces")).length, workspacesBeforeCreate.length, "故障窗口内 create 不得产生新工作区");
		assert.equal(countRequests(mock.requestsFile), 1, "故障窗口内不得新增模型生成");
		// 恢复可写：readyz 回绿；原账本继续有效（同键重放仍幂等拒绝），新键正常受理
		for (const target of [...hardened].reverse()) chmodSync(target, 0o700);
		hardened.length = 0;
		await pollReadyStatus(port, 200, 5_000);
		c.send({ type: "prompt", text: "第一条", requestId: "r1" });
		await c.waitFor(() => c!.events.some((e) => e.type === "error" && String(e.message).includes("不重复生成")), 10_000, "恢复后同键仍幂等");
		c.send({ type: "prompt", text: "第二条", requestId: "r2" });
		await c.waitFor(() => c!.events.filter((e) => e.type === "agent.end").length === 2, 30_000, "恢复后新键正常受理");
		assert.equal(countRequests(mock.requestsFile), 2);
	} finally {
		c?.close();
		for (const target of [...hardened].reverse()) { try { chmodSync(target, 0o700); } catch { /* 已恢复 */ } }
		await gateway.close();
		mock.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("S3c-4a: abort 取消工具进程组（无僵尸子进程）、等收尾后才报告完成、会话继续可用", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s3c-4a-"));
	const mock = await startMock(dir, [
		{ tool: "bash", args: { command: "sleep 30 & echo $! > zombie.pid; wait $!" } },
		{ text: "后续" },
	]);
	let child: ChildProcess | undefined;
	const sockets: WebSocket[] = [];
	try {
		const first = await launchFixture(dir, mock.port);
		child = first.child;
		const owner = await connect(first.port, "", FIXTURE_TOKEN);
		sockets.push(owner.ws);
		await owner.waitFor(() => owner.events.some((e) => e.type === "session.ready"), 20_000, "session.ready");
		const sid = owner.events.find((e) => e.type === "session.ready")!;
		if (sid.type !== "session.ready") return;
		const wsPath = join(dir, "workspaces", sid.sessionId);
		owner.send({ type: "prompt", text: "起一个后台子进程", requestId: "r1" });
		await waitUntil(() => existsSync(join(wsPath, "zombie.pid")), 15_000, "后台子进程 pid 落盘");
		const pid = Number.parseInt(readFileSync(join(wsPath, "zombie.pid"), "utf8").trim(), 10);
		assert.ok(Number.isInteger(pid) && pid > 0, "pid 文件内容必须是正整数");
		owner.send({ type: "abort" });
		// 等收尾后才报告完成
		await owner.waitFor(() => owner.events.some((e) => e.type === "agent.end"), 15_000, "abort 后 agent.end");
		// 无僵尸：后台子进程与工具主进程同进程组，abort 后整组被杀
		await waitUntil(() => {
			try { process.kill(pid, 0); return false; } catch (err) { return (err as NodeJS.ErrnoException).code === "ESRCH"; }
		}, 5_000, "后台子进程退出（无僵尸）");
		// 会话继续可用：新 prompt 正常走完（mock 第二步）
		owner.send({ type: "prompt", text: "再跑一件事", requestId: "r2" });
		await owner.waitFor(() => owner.events.some((e) => e.type === "message.end" && e.text === "后续"), 30_000, "abort 后新任务完成");
	} finally {
		for (const ws of sockets) ws.terminate();
		await stopChild(child);
		mock.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("S3c-4b: abort 使 pending 审批立即按拒绝收束并审计（approver=system）；工具不执行", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s3c-4b-"));
	const mock = await startMock(dir, [
		{ tool: "write", args: { path: "package.json", content: "{}" } },
		{ text: "不应到达" },
	]);
	const auditFile = join(dir, "gateway.jsonl");
	let child: ChildProcess | undefined;
	const sockets: WebSocket[] = [];
	try {
		const first = await launchFixture(dir, mock.port);
		child = first.child;
		const owner = await connect(first.port, "", FIXTURE_TOKEN);
		sockets.push(owner.ws);
		await owner.waitFor(() => owner.events.some((e) => e.type === "session.ready"), 20_000, "session.ready");
		const sid = owner.events.find((e) => e.type === "session.ready")!;
		if (sid.type !== "session.ready") return;
		const wsPath = join(dir, "workspaces", sid.sessionId);
		owner.send({ type: "prompt", text: "改 package.json", requestId: "r1" });
		await owner.waitFor(() => owner.events.some((e) => e.type === "approval.request"), 20_000, "审批请求");
		owner.send({ type: "abort" });
		await owner.waitFor(() => owner.events.some((e) => e.type === "approval.resolved" && e.decision === "deny"), 15_000, "审批按拒绝收束");
		await owner.waitFor(() => owner.events.some((e) => e.type === "agent.end"), 15_000, "abort 收尾完成");
		assert.equal(existsSync(join(wsPath, "package.json")), false, "工具不得执行");
		const entries = await auditEntries(auditFile);
		const decision = entries.find((e) => e.kind === "approval.decision");
		assert.ok(decision, "审批决策必须留痕");
		assert.equal(decision!.verdict, "deny");
		assert.equal(decision!.approver, "system", "abort 收束的审批必须记为 system 拒绝");
	} finally {
		for (const ws of sockets) ws.terminate();
		await stopChild(child);
		mock.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("S3c-5: prompt 账本达上限 → 拒新不淘汰（固定类别）；重启后同键仍被幂等拒绝，无无提示重复生成窗口", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s3c-5-"));
	const mock = await startMock(dir, [{ text: "ok" }]);
	const base = {
		mode: "demo" as const, port: 0, host: "127.0.0.1", token: TOKEN,
		policyFile: join(REPO, "config/policy.yaml"), auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "workspaces"), stateRoot: dir, webRoot: join(REPO, "web"),
		model: modelOf(mock), promptLedgerMaxEntries: 1,
	};
	let gateway: Gateway | undefined = new Gateway(base);
	const port = await gateway.listen();
	let c: Client | undefined;
	try {
		c = await connect(port);
		await c.waitFor(() => c!.events.some((e) => e.type === "session.ready"), 20_000, "session.ready");
		const sid = c.events.find((e) => e.type === "session.ready")!;
		if (sid.type !== "session.ready") return;
		c.send({ type: "prompt", text: "占满账本", requestId: "r1" });
		await c.waitFor(() => c!.events.some((e) => e.type === "agent.end"), 30_000, "第一条完成");
		// 上限=1：新键固定拒绝（选择「拒新不淘汰」——淘汰会让同键重复生成变成无提示窗口）
		c.send({ type: "prompt", text: "第二条", requestId: "r2" });
		await c.waitFor(() => c!.events.some((e) => e.type === "error" && String(e.message).includes("账本已满")), 10_000, "超限拒新");
		assert.equal(countRequests(mock.requestsFile), 1, "超限拒新不得触发生成");
		// 跨网关重启：账本仍在，同键重复仍被幂等拒绝（不因上限引入重复生成窗口）
		c.close();
		c = undefined;
		await gateway.close();
		gateway = undefined;
		const second = new Gateway(base);
		gateway = second;
		const port2 = await second.listen();
		c = await connect(port2, `&session=${sid.sessionId}`);
		await c.waitFor(() => c!.events.some((e) => e.type === "session.snapshot"), 20_000, "重连快照");
		c.send({ type: "prompt", text: "占满账本", requestId: "r1" });
		await c.waitFor(() => c!.events.some((e) => e.type === "error" && String(e.message).includes("不重复生成")), 10_000, "重启后同键仍幂等");
		c.send({ type: "prompt", text: "第二条", requestId: "r2" });
		await c.waitFor(() => c!.events.some((e) => e.type === "error" && String(e.message).includes("账本已满")), 10_000, "重启后仍拒新");
		assert.equal(countRequests(mock.requestsFile), 1, "全程恰一次生成");
	} finally {
		c?.close();
		if (gateway) await gateway.close();
		mock.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("S3c-6: recoverNonTerminal 原子标记（无 tmp 残留）；写失败不损坏原收据，恢复后可重试", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s3c-6-"));
	const receiptsRoot = join(dir, "receipts");
	try {
		const store = new ReceiptStore(dir, 24 * 60 * 60 * 1000);
		const now = new Date().toISOString();
		const receipt = (operationId: string, stage: "accepted" | "outcome_unknown") => ({
			operationId, principalId: "p", requestId: `req-${operationId}`, requestHash: "", sessionId: "s1",
			stage, outcome: stage === "accepted" ? "pending" as const : "unknown" as const, createdAt: now, updatedAt: now,
		});
		store.save(receipt("op-1", "accepted"));
		// 标记为 outcome_unknown：原子 tmp+rename，无残留
		const marked = store.recoverNonTerminal();
		assert.equal(marked.length, 1);
		assert.equal(marked[0]!.stage, "outcome_unknown");
		assert.equal(store.load("p", "op-1")?.outcome, "unknown");
		store.save(receipt("op-2", "accepted"));
		const principalDir = join(receiptsRoot, readdirSync(receiptsRoot)[0]!);
		assert.deepEqual(readdirSync(principalDir).filter((f) => f.endsWith(".tmp")), [], "原子标记不得残留 tmp");
		// 注入写失败：标记写不得损坏原收据（tmp 写失败即抛，原文件未动）。写入目录是
		// principal 子目录（save/recoverNonTerminal 的 tmp+rename 都落在内），父目录 0500 无效
		chmodSync(principalDir, 0o500);
		assert.throws(() => store.recoverNonTerminal(), /EACCES|EPERM/, "目录不可写时标记必须失败可见");
		chmodSync(principalDir, 0o700);
		const untouched = JSON.parse(readFileSync(join(principalDir, "op-2.json"), "utf8")) as { stage: string };
		assert.equal(untouched.stage, "accepted", "写失败不得损坏原收据");
		// 磁盘恢复后重试成功
		const retried = store.recoverNonTerminal();
		assert.equal(retried.length, 1);
		assert.equal(store.load("p", "op-2")?.stage, "outcome_unknown");
	} finally {
		try { chmodSync(receiptsRoot, 0o700); } catch { /* 尚未创建 */ }
		try { for (const sub of readdirSync(receiptsRoot)) chmodSync(join(receiptsRoot, sub), 0o700); } catch { /* 尚未创建 */ }
		rmSync(dir, { recursive: true, force: true });
	}
});
