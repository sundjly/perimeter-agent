import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { AuditLog } from "../src/audit/log.ts";
import { perimeterExtension } from "../src/runtime/perimeter-extension.ts";
import type { Approvals } from "../src/runtime/approvals.ts";
import { PolicyEngine } from "../src/policy/engine.ts";
import type { ClientEvent } from "../src/protocol/types.ts";

/**
 * R-S2B-1（grok-s2-baseline-commit-round-1 必修项）：beforeTool 审计不可用双门的端到端测试。
 *
 * 真实网关子进程（tests/fixtures/gateway-process.ts）+ mock 模型 + 127.0.0.1 + 临时目录。
 * 故障注入只复用既有 PERIMETER_TEST_AUDIT_BREAK_MARKER（env 门控、默认行为不变）：
 * 标记文件出现后网关侧 AuditLog.close()，健康位粘滞为假。零生产码改动、零 fixture 改动、
 * 不新增任何注入开关。
 *
 * 覆盖：
 * - 门1（beforeTool 顶部门）：已受理的一轮中，模型在审计失效之后才发出的工具调用 →
 *   不执行（哨兵不存在）、policy.denied rule=audit-unavailable、固定类别不透传 IO 错误。
 *   时序：第一步为审计健康期执行的慢命令，其副作用落盘后测试才创建标记（50ms 轮询内 close），
 *   距第二步工具调用尚有整个 sleep 窗口，门1判定必然发生在 close 之后；close 后 afterTool/
 *   afterResponse 的审计写失败被 pi-durable hooks.each 吞没（report 为 noop），不影响判定路径。
 * - 门2（审批等待期内审计失效 → 批准后仍不执行）：如实说明 —— e2e 中该不变量由
 *   Approvals.decide 的「审计成功先于可用 allow」fail-closed 兜住（allow 决策审计写失败 →
 *   invalidated + waiter(false)，绝无可用 allow）；beforeTool 审批后第二道门只在 waiter 为
 *   true 时可达，而那以审计写入成功为前提，不存在确定性窗口。该门线级行为由文末单测直接固定。
 * - 正控：审计健康时同样流程工具确实执行，证明上述拒绝不是别的原因。
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MOCK = join(REPO, "tests/fixtures/mock-model.mjs");
const FIXTURE = join(REPO, "tests/fixtures/gateway-process.ts");
const FIXTURE_TOKEN = "test-gateway-token";

interface MockModel { port: number; kill: () => void }

async function startMock(script: unknown[]): Promise<MockModel> {
	const mock = spawn(process.execPath, [MOCK, "0", JSON.stringify(script)], { stdio: ["ignore", "pipe", "inherit"] });
	const port = await new Promise<number>((r, j) => {
		const timer = setTimeout(() => j(new Error("mock 模型启动超时")), 10_000);
		mock.stdout?.once("data", (d: Buffer) => { clearTimeout(timer); r(JSON.parse(d.toString()).port); });
	});
	return { port, kill: () => void mock.kill() };
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

interface Client {
	ws: WebSocket;
	events: ClientEvent[];
	send: (cmd: Record<string, unknown>) => void;
	waitFor: (pred: () => boolean, ms?: number, what?: string) => Promise<void>;
	close: () => void;
}

async function connect(port: number, query = "", token = FIXTURE_TOKEN): Promise<Client> {
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

async function stopChild(child: ChildProcess | undefined): Promise<void> {
	if (child && child.exitCode === null && child.signalCode === null) {
		try { const e = waitExit(child, 10_000); child.kill("SIGTERM"); await e; } catch { /* 已退出 */ }
	}
}

async function auditEntries(file: string): Promise<{ kind: string; summary: string; verdict?: string; callId?: string; command?: string; approver?: string; actor?: string }[]> {
	const out: { kind: string; summary: string; verdict?: string; callId?: string; command?: string; approver?: string; actor?: string }[] = [];
	for await (const e of AuditLog.replay(file)) out.push(e);
	return out;
}

test("R-S2B-1 门1: 受理轮内审计失效后模型才发出的工具调用被 fail-closed（rule=audit-unavailable，哨兵不落盘）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s2b2-gate1-"));
	const mock = await startMock([
		{ tool: "bash", args: { command: "printf ok > step1.txt; sleep 3" } },
		{ tool: "bash", args: { command: "printf pwned > sentinel-gate1.txt" } },
		{ text: "完成" },
	]);
	const marker = join(dir, "audit-break.marker");
	let child: ChildProcess | undefined;
	const sockets: WebSocket[] = [];
	try {
		const first = await launchFixture(dir, mock.port, { PERIMETER_TEST_AUDIT_BREAK_MARKER: marker });
		child = first.child;
		const owner = await connect(first.port);
		sockets.push(owner.ws);
		await owner.waitFor(() => owner.events.some((e) => e.type === "session.ready"), 20_000, "session.ready");
		const sid = owner.events.find((e) => e.type === "session.ready")!;
		if (sid.type !== "session.ready") return;
		const wsPath = join(dir, "workspaces", sid.sessionId);
		owner.send({ type: "prompt", text: "先跑慢命令再写哨兵", requestId: "r1" });
		// 第一步（审计健康期）副作用落盘后注入：标记出现 → 网关 50ms 轮询内 close 审计；
		// 距第二步工具调用还有整个 sleep 窗口，门1判定必然发生在审计失效之后
		await waitUntil(() => existsSync(join(wsPath, "step1.txt")), 15_000, "第一步副作用落盘");
		writeFileSync(marker, "break");
		await pollReadyStatus(first.port, 503, 5_000);
		// 门1：固定类别拒绝，rule=audit-unavailable
		await owner.waitFor(() => owner.events.some((e) => e.type === "policy.denied" && e.rule === "audit-unavailable"), 20_000, "policy.denied(audit-unavailable)");
		const denied = owner.events.find((e) => e.type === "policy.denied" && e.rule === "audit-unavailable")!;
		if (denied.type !== "policy.denied") return;
		assert.ok(denied.reason.includes("固定类别"), "拒绝说明必须标固定类别");
		assert.ok(!/EBADF|EACCES|EPERM|bad file descriptor/i.test(denied.reason), "不透传底层 IO 错误");
		// 模型收到阻断结果后正常收尾（mock 第三步）
		await owner.waitFor(() => owner.events.some((e) => e.type === "agent.end"), 30_000, "阻断后运行收束");
		// IO 错误不得透传到客户端任何事件（hook 审计写失败被吞没，只见固定类别）
		const leaked = owner.events.find((e) => e.type === "error" && /EBADF|EACCES|EPERM|bad file descriptor/i.test(String(e.message)));
		assert.equal(leaked, undefined, "IO 错误不得透传到客户端");
		// 硬 oracle：审计失效后的工具调用未执行；工具视图可见固定阻断（快照 tools 同源）
		assert.equal(existsSync(join(wsPath, "sentinel-gate1.txt")), false, "审计失效后的工具调用不得执行");
		const toolEnd = owner.events.find((e) => e.type === "tool.end" && e.action?.command?.includes("sentinel-gate1"));
		assert.ok(toolEnd !== undefined && toolEnd.type === "tool.end" && toolEnd.ok === false, "被拒调用在工具视图可见失败结果");
		if (toolEnd !== undefined && toolEnd.type === "tool.end") {
			assert.ok(toolEnd.output.includes("audit-unavailable"), "工具输出含固定类别 rule");
		}
		// 审计链：门先于一切审计写入 —— 被拒调用不得留下 tool.call
		const entries = await auditEntries(join(dir, "gateway.jsonl"));
		assert.equal(entries.filter((e) => e.kind === "tool.call" && (e.command ?? "").includes("sentinel-gate1")).length, 0, "被拒调用无 tool.call 审计");
	} finally {
		for (const ws of sockets) ws.terminate();
		await stopChild(child);
		mock.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("R-S2B-1 门2: 审批等待期内审计失效，批准后工具仍不执行（decide fail-closed，绝无可用 allow；哨兵不落盘）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s2b2-gate2-"));
	const mock = await startMock([
		{ tool: "write", args: { path: "package.json", content: "{}" } },
		{ text: "完成" },
	]);
	const marker = join(dir, "audit-break.marker");
	const auditFile = join(dir, "gateway.jsonl");
	let child: ChildProcess | undefined;
	const sockets: WebSocket[] = [];
	try {
		const first = await launchFixture(dir, mock.port, { PERIMETER_TEST_AUDIT_BREAK_MARKER: marker });
		child = first.child;
		const owner = await connect(first.port, "&actor=alice");
		sockets.push(owner.ws);
		await owner.waitFor(() => owner.events.some((e) => e.type === "session.ready"), 20_000, "session.ready");
		const sid = owner.events.find((e) => e.type === "session.ready")!;
		if (sid.type !== "session.ready") return;
		const wsPath = join(dir, "workspaces", sid.sessionId);
		owner.send({ type: "share", actor: "bob", role: "approver" });
		const bob = await connect(first.port, `&actor=bob&session=${sid.sessionId}`);
		sockets.push(bob.ws);
		await bob.waitFor(() => bob.events.some((e) => e.type === "session.snapshot"), 20_000, "approver 接入");
		owner.send({ type: "prompt", text: "改 package.json", requestId: "r1" });
		await bob.waitFor(() => bob.events.some((e) => e.type === "approval.request"), 20_000, "审批请求");
		// 等待期内注入：审计失效（readyz 翻红确认 close 已生效）
		writeFileSync(marker, "break");
		await pollReadyStatus(first.port, 503, 5_000);
		// 审批人批准：allow 决策的审计写入失败 → fail-closed（invalidated，waiter 收 false）
		const req = bob.events.find((e) => e.type === "approval.request")!;
		if (req.type !== "approval.request") return;
		bob.send({ type: "approve", approvalId: req.approvalId, decision: "allow" });
		await bob.waitFor(() => bob.events.some((e) => e.type === "error" && String(e.message).includes("审计日志写入失败")), 10_000, "审计失败固定拒绝可见");
		await owner.waitFor(() => owner.events.some((e) => e.type === "approval.resolved" && e.decision === "deny"), 10_000, "审批按拒绝收束");
		const resolved = owner.events.find((e) => e.type === "approval.resolved")!;
		if (resolved.type !== "approval.resolved") return;
		assert.equal(resolved.actor, "system", "fail-closed 收束的审批记为 system 拒绝");
		// waiter 收 false → beforeTool 阻断（未获批准）→ 运行收束
		await owner.waitFor(() => owner.events.some((e) => e.type === "agent.end"), 30_000, "阻断后运行收束");
		// 硬 oracle：批准后审计失效，工具不得执行
		assert.equal(existsSync(join(wsPath, "package.json")), false, "批准后审计失效不得执行");
		// 审计链：有审批请求与 require_approval 判定，绝无 allow 决策留痕
		const entries = await auditEntries(auditFile);
		assert.ok(entries.some((e) => e.kind === "approval.request"), "审批请求已留痕（失效前写入）");
		assert.ok(entries.some((e) => e.kind === "policy.verdict" && e.verdict === "require_approval"), "require_approval 判定已留痕");
		assert.equal(entries.filter((e) => e.kind === "approval.decision" && e.verdict === "allow").length, 0, "审计写失败的 allow 绝不留痕");
	} finally {
		for (const ws of sockets) ws.terminate();
		await stopChild(child);
		mock.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("R-S2B-1 正控: 审计健康时同流程工具确实执行（bash 哨兵落盘）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s2b2-pos1-"));
	const mock = await startMock([
		{ tool: "bash", args: { command: "printf ok > sentinel-ok.txt" } },
		{ text: "完成" },
	]);
	let child: ChildProcess | undefined;
	const sockets: WebSocket[] = [];
	try {
		// 不设 PERIMETER_TEST_AUDIT_BREAK_MARKER：默认行为，审计自开
		const first = await launchFixture(dir, mock.port);
		child = first.child;
		const owner = await connect(first.port);
		sockets.push(owner.ws);
		await owner.waitFor(() => owner.events.some((e) => e.type === "session.ready"), 20_000, "session.ready");
		const sid = owner.events.find((e) => e.type === "session.ready")!;
		if (sid.type !== "session.ready") return;
		const wsPath = join(dir, "workspaces", sid.sessionId);
		owner.send({ type: "prompt", text: "写哨兵", requestId: "r1" });
		await waitUntil(() => existsSync(join(wsPath, "sentinel-ok.txt")), 15_000, "哨兵落盘（审计健康时正常执行）");
		await owner.waitFor(() => owner.events.some((e) => e.type === "agent.end"), 30_000, "运行完成");
		const toolEnd = owner.events.find((e) => e.type === "tool.end" && e.action?.command?.includes("sentinel-ok.txt"));
		assert.ok(toolEnd !== undefined && toolEnd.type === "tool.end" && toolEnd.ok === true, "工具成功执行");
	} finally {
		for (const ws of sockets) ws.terminate();
		await stopChild(child);
		mock.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("R-S2B-1 正控: 审计健康时同流程审批通过后工具确实执行（package.json 落盘 + allow 决策留痕）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s2b2-pos2-"));
	const mock = await startMock([
		{ tool: "write", args: { path: "package.json", content: "{}" } },
		{ text: "完成" },
	]);
	const auditFile = join(dir, "gateway.jsonl");
	let child: ChildProcess | undefined;
	const sockets: WebSocket[] = [];
	try {
		const first = await launchFixture(dir, mock.port);
		child = first.child;
		const owner = await connect(first.port, "&actor=alice");
		sockets.push(owner.ws);
		await owner.waitFor(() => owner.events.some((e) => e.type === "session.ready"), 20_000, "session.ready");
		const sid = owner.events.find((e) => e.type === "session.ready")!;
		if (sid.type !== "session.ready") return;
		const wsPath = join(dir, "workspaces", sid.sessionId);
		owner.send({ type: "share", actor: "bob", role: "approver" });
		const bob = await connect(first.port, `&actor=bob&session=${sid.sessionId}`);
		sockets.push(bob.ws);
		await bob.waitFor(() => bob.events.some((e) => e.type === "session.snapshot"), 20_000, "approver 接入");
		owner.send({ type: "prompt", text: "改 package.json", requestId: "r1" });
		await bob.waitFor(() => bob.events.some((e) => e.type === "approval.request"), 20_000, "审批请求");
		const req = bob.events.find((e) => e.type === "approval.request")!;
		if (req.type !== "approval.request") return;
		bob.send({ type: "approve", approvalId: req.approvalId, decision: "allow" });
		await owner.waitFor(() => owner.events.some((e) => e.type === "approval.resolved" && e.decision === "allow"), 15_000, "审批通过");
		await owner.waitFor(() => owner.events.some((e) => e.type === "agent.end"), 30_000, "运行完成");
		assert.equal(existsSync(join(wsPath, "package.json")), true, "审计健康时批准后工具正常执行");
		const entries = await auditEntries(auditFile);
		const decision = entries.find((e) => e.kind === "approval.decision" && e.verdict === "allow");
		assert.ok(decision, "allow 决策已留痕");
		assert.equal(decision!.actor, "alice");
		assert.equal(decision!.approver, "bob");
	} finally {
		for (const ws of sockets) ws.terminate();
		await stopChild(child);
		mock.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("R-S2B-1 单测: beforeTool 两道 audit-unavailable 门的线级行为（固定类别、先于审计写入、deny 语义不受影响）", async () => {
	const policy = PolicyEngine.fromYaml(readFileSync(join(REPO, "config/policy.yaml"), "utf8"));
	type BeforeToolFn = (call: { id: string; name: string; arguments: unknown }, api: unknown, ctx: { abortSignal?: AbortSignal }) => Promise<undefined | { block: string }>;
	const makeExt = (healthy: { value: boolean }) => {
		const emitted: ClientEvent[] = [];
		let auditWrites = 0;
		const ext = perimeterExtension({
			repo: "r", team: "t", policy,
			actor: async () => "tester",
			// 假审批：request 解决即视为「审计在等待期内失效」，直接放行（verifyApproved 通过）
			approvals: () => ({
				request: async () => { healthy.value = false; return true; },
				verifyApproved: async () => ({ ok: true }),
			}) as unknown as Approvals,
			approvalTimeoutMs: 1_000,
			audit: () => { auditWrites += 1; },
			emit: (event) => { emitted.push(event); },
			isProduction: false,
			auditHealthy: () => healthy.value,
		});
		const hooks = (ext as unknown as { hooks: { task: string; handlers: Record<string, unknown> }[] }).hooks;
		const beforeTool = hooks.find((h) => h.task === "pi.tool")!.handlers.beforeTool as unknown as BeforeToolFn;
		return { beforeTool, emitted, auditWrites: () => auditWrites };
	};
	const ctx = () => ({ abortSignal: new AbortController().signal });
	const pushCall = { id: "c", name: "bash", arguments: { command: "git push origin main" } };

	// 门1：审计已失效 → 顶部门先于一切审计写入拒绝，固定类别、不透传 IO 错误
	{
		const { beforeTool, emitted, auditWrites } = makeExt({ value: false });
		const result = await beforeTool(pushCall, {}, ctx());
		assert.ok(result?.block.includes("audit-unavailable"), "门1必须阻断");
		const denied = emitted.find((e) => e.type === "policy.denied");
		assert.ok(denied !== undefined && denied.type === "policy.denied" && denied.rule === "audit-unavailable", "emit policy.denied rule=audit-unavailable");
		if (denied !== undefined && denied.type === "policy.denied") {
			assert.ok(denied.reason.includes("固定类别"));
			assert.ok(!/EBADF|bad file descriptor/i.test(denied.reason), "不透传底层 IO 错误");
		}
		assert.equal(auditWrites(), 0, "门1先于一切审计写入");
	}
	// 门2：审批等待期内审计失效 → 审批后执行前第二道门拦截
	{
		const { beforeTool, emitted } = makeExt({ value: true });
		const result = await beforeTool(pushCall, {}, ctx());
		assert.ok(result?.block.includes("audit-unavailable"), "门2必须阻断");
		const denied = emitted.find((e) => e.type === "policy.denied");
		assert.ok(denied !== undefined && denied.type === "policy.denied" && denied.reason.includes("审批后"), "门2拒绝说明标注审批后场景");
	}
	// 对照：审计健康 + policy deny → 固定 deny 语义不受双门影响
	{
		const { beforeTool, emitted } = makeExt({ value: true });
		const result = await beforeTool({ id: "c", name: "bash", arguments: { command: "rm -rf /" } }, {}, ctx());
		assert.ok(result?.block.includes("策略拒绝（destructive-commands）"), "policy deny 照常拒绝");
		const denied = emitted.find((e) => e.type === "policy.denied");
		assert.ok(denied !== undefined && denied.type === "policy.denied" && denied.rule === "destructive-commands");
	}
});
