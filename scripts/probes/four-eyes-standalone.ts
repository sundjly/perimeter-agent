/**
 * 四眼审批 standalone 生产链探针（独立冷进程运行，不依赖测试套件预热，自然退出契约）。
 *
 * 用法（外层必须用已批准 bounded runner 提供看护死线，建议 180s）：
 *   node scripts/bounded-test-runner.ts --timeout 180s \
 *     node --experimental-strip-types scripts/probes/four-eyes-standalone.ts --scenario all
 *
 * 参数：
 *   --scenario <ng|git|ctx|all>   必选语义；all = 三场景（默认 all）。未知/缺失 → exitCode 3。
 *   --preflight                   可选诊断项，默认关闭。启用时在场景前做一次容器握手计时，
 *                                 manifest 标注 nonCold:true——不构成冷启动证据，不算验收 oracle。
 *   --inject-cleanup-fault        受控故障注入：故意跳过一个 own 容器的清理，证明「清理失败 ≠ exit 0」；
 *                                 注入后该容器记 pendingReconcile（精确 ID），由操作者按 ID 对账，非本探针瞒报。
 *
 * 退出码（自然退出：全程不用 process.exit；stdout/manifest 的 plannedExit 即真实计划退出值）：
 *   0 = 所选场景 oracle 全过 且 本次 own 资源逐一核验清理确认
 *   1 = 场景 oracle 失败/异常
 *   2 = policy require_approval 预检失败（结果不可信）
 *   3 = 用法错误（未知/缺失 scenario）
 *   4 = own 清理未确认（含故障注入演示）→ manifest 记 pendingReconcile 精确 ID
 *
 * 三场景 oracle（真实 Gateway/Harness/DockerBackend(none)/localhost mock/自有凭证/仓库真实 policy）：
 *   ng  —— git-less 高风险写 package.json：policy.denied（上下文不可靠）+ 无 approval 事件 + marker 不写 + 审计无 allow
 *   git —— 临时 git 真实 HEAD + 独立 B 批准：approval.request → B allow → marker 落盘 + 审计 allow（actor/approver 断言）
 *   ctx —— request 后工作区 git 上下文丢失：decide 拒（审批意图上下文已失效/不可靠）+ marker 不写 + 审计无 allow
 *
 * 证据边界：session.ready 只是必要条件；每场景以真实 policy 命中与真实事件/落盘/审计为 oracle。
 * 阶段信息脱敏有界（帧类型/时延/容器名），不含凭证与环境原文。manifest 逐阶段落盘，
 * 外层死线强杀也留证据。清理只针对本次 runId 可确权的 own 资源；不确定资源不删。
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { AuditLog } from "../../src/audit/log.ts";
import { PolicyEngine } from "../../src/policy/engine.ts";
import { DockerBackend } from "../../src/gateway/execution-backend.ts";
import { Gateway } from "../../src/gateway/server.ts";
import type { ClientEvent } from "../../src/protocol/types.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const MOCK = join(REPO, "tests/fixtures/mock-model.mjs");
const POLICY = join(REPO, "config/policy.yaml");
const IMAGE = "perimeter-sandbox:test";
const SESSION_READY_TIMEOUT_MS = 60_000; // 探针契约常量：独立冷启动就绪上限，非产品 SLA
const WAIT_TIMEOUT_MS = 30_000;
const CMD_DEADLINE_MS = 10_000; // 每条 docker/git 子命令自身的死线
const EXIT_DEADLINE_MS = 5_000; // mock/ws 关闭等待死线，超时升级并如实记录

// ---------- CLI ----------
const argv = process.argv.slice(2);
function argValue(name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? String(argv[i + 1] ?? "") : undefined;
}
const scenarioArg = argValue("--scenario") ?? "all";
const validScenarios = new Set(["ng", "git", "ctx"]);
const scenarios: string[] = scenarioArg === "all" ? ["ng", "git", "ctx"] : [scenarioArg];
const usageError = scenarioArg !== "all" && !validScenarios.has(scenarioArg);
const optPreflight = argv.includes("--preflight");
const injectCleanupFault = argv.includes("--inject-cleanup-fault");

const runId = `fe-probe-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
const manifestDir = join(tmpdir(), "perimeter-fe-probe", runId);
const manifestPath = join(manifestDir, "manifest.json");
mkdirSync(manifestDir, { recursive: true });

const manifest: Record<string, unknown> = {
	runId, startedAt: new Date().toISOString(), pid: process.pid,
	scenarioArg, scenarios, preflightEnabled: optPreflight, injectCleanupFault,
	image: IMAGE, policy: POLICY,
	preexistingLabeledContainers: [], phases: [], scenarios_result: {},
	ownership: {}, cleanupVerification: {}, pendingReconcile: [], injectedFault: null,
};
function saveManifest(): void {
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
}
const t0 = Date.now();
function phase(name: string, detail?: Record<string, unknown>): void {
	const entry = { at: Date.now() - t0, phase: name, ...(detail ? { detail } : {}) };
	(manifest.phases as unknown[]).push(entry);
	console.log(`[${runId}][+${String(entry.at).padStart(6)}ms] ${name}${detail ? " " + JSON.stringify(detail) : ""}`);
	saveManifest();
}

/** 所有外部子命令统一带自身死线；超时抛错由调用方记账，绝不吞成成功。 */
function sh(bin: string, cmdArgs: string[], opts: { timeout?: number; cwd?: string } = {}): string {
	return execFileSync(bin, cmdArgs, { timeout: opts.timeout ?? CMD_DEADLINE_MS, cwd: opts.cwd, encoding: "utf8" });
}

// ---------- 有界的客户端 ----------
interface ProbeClient {
	ws: WebSocket;
	send: (cmd: unknown) => void;
	frames: { kind: "control" | "event"; type: string; at: number }[];
	events: ClientEvent[];
	openedAt?: number;
	closeInfo?: { code: number; reason: string };
	dead?: boolean;
}

function connectProd(port: number, token: string, session?: string): Promise<ProbeClient> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/${session ? `?session=${session}` : ""}`, {
		headers: { Authorization: `Bearer ${token}`, Host: `127.0.0.1:${port}`, Origin: "https://internal.corp" },
	});
	const client: ProbeClient = { ws, send: (c: unknown) => ws.send(JSON.stringify(c)), frames: [], events: [] };
	const FRAME_CAP = 300; // 有界：超出的帧只计丢
	ws.on("message", (raw) => {
		try {
			const frame = JSON.parse(String(raw));
			if (frame.event) {
				if (client.frames.length < FRAME_CAP) client.frames.push({ kind: "event", type: frame.event.type, at: Date.now() - t0 });
				client.events.push(frame.event);
			} else if (frame.type === "control") {
				if (client.frames.length < FRAME_CAP) client.frames.push({ kind: "control", type: String(frame.control), at: Date.now() - t0 });
			}
		} catch { /* 非 JSON 帧计数在 frames 之外，不影响 oracle */ }
	});
	ws.on("close", (code, reason) => { client.closeInfo = { code, reason: String(reason).slice(0, 120) }; client.dead = true; });
	ws.on("error", () => { client.dead = true; });
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("ws open 超时")), 15_000);
		ws.once("open", () => { clearTimeout(timer); client.openedAt = Date.now() - t0; resolve(client); });
		ws.once("error", (e) => { clearTimeout(timer); reject(e); });
	});
}

/** WS 关闭也要 await：先 close，超时升级 terminate，最终等到 close 事件为止。 */
function closeWsAwait(client: ProbeClient): Promise<{ closed: boolean; closeInfo?: { code: number; reason: string } }> {
	if (client.dead || client.ws.readyState === WebSocket.CLOSED) return Promise.resolve({ closed: true, closeInfo: client.closeInfo });
	return new Promise((resolve) => {
		const timer = setTimeout(() => { try { client.ws.terminate(); } catch {} }, EXIT_DEADLINE_MS);
		client.ws.once("close", (code, reason) => {
			clearTimeout(timer);
			resolve({ closed: true, closeInfo: client.closeInfo ?? { code, reason: String(reason).slice(0, 120) } });
		});
		try { client.ws.close(); } catch { try { client.ws.terminate(); } catch {} }
	});
}

async function waitFor(client: ProbeClient, pred: (e: ClientEvent[]) => boolean, ms = WAIT_TIMEOUT_MS, label = ""): Promise<void> {
	const deadline = Date.now() + ms;
	while (!pred(client.events)) {
		if (client.dead) throw new Error(`${label} 连接已关闭 close=${JSON.stringify(client.closeInfo)} frames=${client.frames.map((f) => f.type).join(",")}`);
		if (Date.now() > deadline) {
			throw new Error(`${label} 等待超时(${ms}ms)；frames=${client.frames.map((f) => `${f.type}@${f.at}`).join(",")}`);
		}
		await new Promise((r) => setTimeout(r, 25));
	}
}

// ---------- 精确 owned 资源 ----------
interface Owned {
	gatewayTag: string;
	containerIds: string[]; // session.ready 后与清理前两次登记的并集
	mockPid?: number;
	tempDir?: string;
	auditFile?: string;
}
const ownership: Record<string, Owned> = {};

function ownContainerIds(gatewayTag: string): string[] {
	// 只按本次 gatewayId 的容器名过滤（容器名内嵌 gatewayId），绝不按全局 label 等式判定归属
	try {
		return sh("docker", ["ps", "-aq", "--filter", "label=perimeter.gateway", "--filter", `name=${gatewayTag}`])
			.split("\n").map((s) => s.trim()).filter(Boolean);
	} catch { return []; }
}

function containerName(id: string): string | null {
	try { return sh("docker", ["inspect", "--format", "{{.Name}}", id]).trim().replace(/^\//, ""); } catch { return null; }
}

async function stopMockAwait(mock: ChildProcess): Promise<{ forced: boolean; exitCode: number | null; signal: string | null }> {
	if (mock.exitCode !== null || mock.signalCode !== null) return { forced: false, exitCode: mock.exitCode, signal: mock.signalCode };
	mock.kill("SIGTERM");
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			try { mock.kill("SIGKILL"); } catch {}
			mock.once("exit", (code, signal) => resolve({ forced: true, exitCode: code, signal: signal ?? null }));
		}, EXIT_DEADLINE_MS);
		mock.once("exit", (code, signal) => { clearTimeout(timer); resolve({ forced: false, exitCode: code, signal: signal ?? null }); });
	});
}

/** 清理并逐一核验本次 own 容器；返回每 ID 的核验结果，确认与否不由全局计数推断。 */
function cleanupOwnedContainers(owned: Owned, opts: { skipOneForFault?: boolean } = {}): { confirmed: boolean; perId: Record<string, string>; skipped?: string; reconcile: string[] } {
	const perId: Record<string, string> = {};
	const reconcile: string[] = [];
	let skipped: string | undefined;
	// 清理前再次登记（覆盖晚创建的容器）
	owned.containerIds = Array.from(new Set([...owned.containerIds, ...ownContainerIds(owned.gatewayTag)]));
	const toRemove = [...owned.containerIds];
	if (opts.skipOneForFault && toRemove.length > 0) {
		skipped = toRemove.shift();
		phase("inject-cleanup-fault", { skippedContainerId: skipped });
	}
	for (const id of toRemove) {
		try { sh("docker", ["rm", "-f", id]); perId[id] = "removed"; } catch (e) { perId[id] = `rm failed: ${String(e).slice(0, 120)}`; }
	}
	if (skipped) { perId[skipped] = "injected-fault: not removed"; reconcile.push(skipped); }
	// 逐一核验：每个 own ID 必须查无此容器才算 confirmed
	let confirmed = true;
	for (const id of owned.containerIds) {
		let state: string;
		if (perId[id] === "removed") {
			const gone = containerName(id) === null;
			state = gone ? "verified-gone" : "STILL-PRESENT";
			if (!gone) { confirmed = false; reconcile.push(id); }
		} else { state = perId[id] ?? "unknown"; confirmed = false; }
		perId[id] = state;
	}
	// 兜底：按名再扫一次本次 gatewayTag（含未登记 ID 的极端情况）
	const strays = ownContainerIds(owned.gatewayTag).filter((id) => !owned.containerIds.includes(id));
	if (strays.length > 0) {
		for (const id of strays) {
			try { sh("docker", ["rm", "-f", id]); } catch (e) { reconcile.push(id); }
			const gone = containerName(id) === null;
			perId[id] = gone ? "stray-removed" : "stray-STILL-PRESENT";
			owned.containerIds.push(id);
			if (!gone) confirmed = false; else perId[id] = "stray-verified-gone";
		}
	}
	return { confirmed, perId, skipped, reconcile };
}

function dockerDiagnostics(gatewayTag: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	try {
		const ids = ownContainerIds(gatewayTag);
		out.ownContainerStates = ids.map((id) => sh("docker", ["inspect", "--format", "{{.Name}} {{.State.Status}} startedAt={{.State.StartedAt}}", id]).trim());
		out.ownContainerLogsTail = ids.map((id) => ({
			name: containerName(id),
			logs: sh("docker", ["logs", "--tail", "40", id]).slice(0, 2000),
		}));
	} catch (e) { out.diagnosticsError = String(e).slice(0, 200); }
	return out;
}

function initGitFixture(wsPath: string): void {
	writeFileSync(join(wsPath, "seed.txt"), "seed\n");
	sh("/bin/sh", ["-c", "git init -q && git config user.name 'Probe' && git config user.email 'probe@local' && git add -A && git commit -q -m seed"], { cwd: wsPath });
}

interface ProdIdentity { id: string; issuer: string; subject: string; expiresAt: number; groups: string[] }
const prodAuthenticate = async (cred: string): Promise<ProdIdentity> => ({
	// 自有凭证：production 下连接 actor = principal.id；token-1/token-b 为不同 subject 的两个自然人
	id: cred === "token-1" ? "corp|alice-probe" : "corp|bob-probe",
	issuer: "corp",
	subject: cred === "token-1" ? "alice-probe-uuid" : "bob-probe-uuid",
	expiresAt: Date.now() + 3600_000,
	groups: ["dev"],
});

interface ScenarioEnv {
	tag: string; port: number; auditFile: string; owner: ProbeClient; sessionId: string; workspace: string;
	close: () => Promise<{ confirmed: boolean; perId: Record<string, string>; skipped?: string; reconcile: string[] }>;
}

async function startScenario(tag: string, script: unknown[]): Promise<ScenarioEnv> {
	phase(`${tag}:mock-spawn`);
	const mock: ChildProcess = spawn(process.execPath, [MOCK, "0", JSON.stringify(script)], { stdio: ["ignore", "pipe", "inherit"] });
	const mockPort: number = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("mock port 超时")), 15_000);
		mock.stdout?.once("data", (d) => { clearTimeout(timer); resolve(JSON.parse(d.toString()).port); });
	});
	phase(`${tag}:mock-ready`, { mockPort, mockPid: mock.pid });
	const reservation = await createReservation();
	const gatewayTag = `${runId}-${tag}`;
	const owned: Owned = { gatewayTag, containerIds: [], mockPid: mock.pid };
	ownership[tag] = owned;
	const backend = new DockerBackend({ image: IMAGE, repoRoot: REPO, network: "none", gatewayId: gatewayTag });
	const dir = mkdtempSync(join(tmpdir(), `fe-probe-${tag}-`));
	owned.tempDir = dir;
	const auditFile = join(dir, "audit.jsonl");
	owned.auditFile = auditFile;
	phase(`${tag}:gateway-construct`);
	const gateway = new Gateway({
		port: reservation.port, host: "127.0.0.1",
		policyFile: POLICY, auditFile, workspaceRoot: join(dir, "workspaces"), webRoot: join(REPO, "web"),
		model: { baseUrl: `http://127.0.0.1:${mockPort}/v1`, token: "dummy", model: "mock-model" },
		approvalTimeoutMs: 30_000,
		mode: "production", backend,
		auth: { isPrincipalId: () => true, authenticate: prodAuthenticate },
		allowedHosts: [`127.0.0.1:${reservation.port}`], allowedOrigins: ["https://internal.corp"],
		resolveScope: () => ({ repo: "probe-repo", team: "probe-team" }),
	});
	const listening = await gateway.listen();
	phase(`${tag}:gateway-listening`, { port: listening });
	const owner = await connectProd(listening, "token-1");
	phase(`${tag}:ws-open`, { openedAt: owner.openedAt });
	const readyDeadline = Date.now() + SESSION_READY_TIMEOUT_MS;
	while (!owner.events.some((e) => e.type === "session.ready")) {
		if (owner.dead) throw new Error(`${tag}: 连接关闭且未 ready close=${JSON.stringify(owner.closeInfo)}`);
		if (Date.now() > readyDeadline) {
			owned.containerIds = Array.from(new Set([...owned.containerIds, ...ownContainerIds(gatewayTag)]));
			const diag = dockerDiagnostics(gatewayTag);
			phase(`${tag}:session-ready-timeout`, { waitedMs: SESSION_READY_TIMEOUT_MS, frames: owner.frames, ...diag });
			throw new Error(`${tag}: ${SESSION_READY_TIMEOUT_MS}ms 内 session.ready 未至（容器握手或会话启动挂起，诊断已入 manifest）`);
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	phase(`${tag}:session-ready`);
	// 登记本次 own 容器（精确 ID 入 manifest）
	owned.containerIds = ownContainerIds(gatewayTag);
	phase(`${tag}:containers-registered`, { gatewayTag, containerIds: owned.containerIds });
	const readyEvent = owner.events.find((e) => e.type === "session.ready") as Extract<ClientEvent, { type: "session.ready" }>;
	const close = async (): Promise<{ confirmed: boolean; perId: Record<string, string>; skipped?: string; reconcile: string[] }> => {
		const wsResult = await closeWsAwait(owner);
		phase(`${tag}:ws-closed`, { closed: wsResult.closed, code: wsResult.closeInfo?.code });
		try { await gateway.close(); phase(`${tag}:gateway-closed`); } catch (e) { phase(`${tag}:gateway-close-error`, { error: String(e).slice(0, 160) }); }
		const mockExit = await stopMockAwait(mock);
		phase(`${tag}:mock-exited`, mockExit);
		const result = cleanupOwnedContainers(owned, { skipOneForFault: injectCleanupFault && !faultConsumed });
		if (result.skipped) faultConsumed = true;
		phase(`${tag}:containers-cleaned`, { confirmed: result.confirmed, perId: result.perId });
		if (result.reconcile.length) (manifest.pendingReconcile as string[]).push(...result.reconcile);
		(manifest.cleanupVerification as Record<string, unknown>)[tag] = result;
		try { rmSync(dir, { recursive: true, force: true }); } catch {}
		reservation.release();
		return result;
	};
	return { tag, port: listening, auditFile, owner, sessionId: readyEvent.sessionId, workspace: readyEvent.workspace, close };
}

let faultConsumed = false;

function createReservation(): Promise<{ port: number; release: () => void }> {
	// 先占一个真实端口再释放：production allowedHosts 必须与实际监听端口精确一致
	const s = createServer();
	return new Promise((resolve) => {
		s.listen(0, "127.0.0.1", () => {
			const port = (s.address() as { port: number }).port;
			s.close(() => resolve({ port, release: () => s.closeAllConnections?.() }));
		});
	});
}

async function auditDecisions(auditFile: string): Promise<{ kind: string; verdict?: string; actor?: string; approver?: string }[]> {
	const entries: { kind: string; verdict?: string; actor?: string; approver?: string }[] = [];
	for await (const e of AuditLog.replay(auditFile)) entries.push({ kind: e.kind, verdict: (e as { verdict?: string }).verdict, actor: (e as { actor?: string }).actor, approver: (e as { approver?: string }).approver });
	return entries;
}

async function scenarioNG(): Promise<Record<string, unknown>> {
	const env = await startScenario("ng", [{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "完成" }]);
	try {
		env.owner.send({ type: "prompt", text: "git-less 高风险", requestId: "ng-1" });
		await waitFor(env.owner, (es) => es.some((e) => e.type === "agent.end" && !(e as { willRetry?: boolean }).willRetry), WAIT_TIMEOUT_MS, "ng:agent.end");
		const denied = env.owner.events.find((e) => e.type === "policy.denied") as Extract<ClientEvent, { type: "policy.denied" }> | undefined;
		const approvals = env.owner.events.filter((e) => e.type === "approval.request" || e.type === "approval.resolved");
		const decisions = await auditDecisions(env.auditFile);
		const marker = existsSync(join(env.workspace, "package.json"));
		const pass = !!denied && String(denied.reason).includes("上下文不可靠") && approvals.length === 0 && !marker && !decisions.some((d) => d.kind === "approval.decision" && d.verdict === "allow");
		return { pass, policyDenied: denied?.reason, approvalEvents: approvals.length, markerWritten: marker, allowAudit: decisions.some((d) => d.verdict === "allow") };
	} finally { await env.close(); }
}

async function scenarioGIT(): Promise<Record<string, unknown>> {
	const env = await startScenario("git", [{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "完成" }]);
	try {
		initGitFixture(env.workspace);
		phase("git:fixture-ready");
		env.owner.send({ type: "share", actor: "corp|bob-probe", role: "approver" });
		// share 成功不产生含 B 的 presence（participants 仅列已连接成员）；以「无 error + B attach 成功」为落地证据
		await new Promise((r) => setTimeout(r, 300));
		{ const shareErr = env.owner.events.find((e) => e.type === "error") as Extract<ClientEvent, { type: "error" }> | undefined;
			if (shareErr) throw new Error(`share 被拒：${String(shareErr.message).slice(0, 160)}`); }
		phase("share-done", { ownerEvents: env.owner.events.map((e) => e.type).join(",").slice(0, 160) });
		const bob = await connectProd(env.port, "token-b", env.sessionId);
		try {
			await waitFor(bob, (es) => es.some((e) => e.type === "session.snapshot"), WAIT_TIMEOUT_MS, "git:bob.snapshot");
			env.owner.send({ type: "prompt", text: "git 正控", requestId: "git-1" });
			await waitFor(bob, (es) => es.some((e) => e.type === "approval.request"), WAIT_TIMEOUT_MS, "git:approval.request");
			const req = bob.events.find((e) => e.type === "approval.request") as Extract<ClientEvent, { type: "approval.request" }>;
			phase("git:approval-requested");
			bob.ws.send(JSON.stringify({ type: "approve", approvalId: req.approvalId, decision: "allow" }));
			await waitFor(env.owner, (es) => es.some((e) => e.type === "agent.end" && !(e as { willRetry?: boolean }).willRetry), WAIT_TIMEOUT_MS, "git:agent.end");
			const marker = existsSync(join(env.workspace, "package.json"));
			const decisions = await auditDecisions(env.auditFile);
			const allow = decisions.find((d) => d.kind === "approval.decision" && d.verdict === "allow");
			const pass = marker && !!allow && allow.actor === "corp|alice-probe" && allow.approver === "corp|bob-probe";
			return { pass, markerWritten: marker, allowAudit: allow ?? null };
		} finally { await closeWsAwait(bob); }
	} finally { await env.close(); }
}

async function scenarioCTX(): Promise<Record<string, unknown>> {
	const env = await startScenario("ctx", [{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "完成" }]);
	try {
		initGitFixture(env.workspace);
		env.owner.send({ type: "share", actor: "corp|bob-probe", role: "approver" });
		await new Promise((r) => setTimeout(r, 300));
		{ const shareErr = env.owner.events.find((e) => e.type === "error") as Extract<ClientEvent, { type: "error" }> | undefined;
			if (shareErr) throw new Error(`share 被拒：${String(shareErr.message).slice(0, 160)}`); }
		phase("share-done", { ownerEvents: env.owner.events.map((e) => e.type).join(",").slice(0, 160) });
		const bob = await connectProd(env.port, "token-b", env.sessionId);
		try {
			await waitFor(bob, (es) => es.some((e) => e.type === "session.snapshot"), WAIT_TIMEOUT_MS, "ctx:bob.snapshot");
			env.owner.send({ type: "prompt", text: "context 丢失", requestId: "ctx-1" });
			await waitFor(bob, (es) => es.some((e) => e.type === "approval.request"), WAIT_TIMEOUT_MS, "ctx:approval.request");
			const req = bob.events.find((e) => e.type === "approval.request") as Extract<ClientEvent, { type: "approval.request" }>;
			// request 之后工作区失去可靠 git 上下文
			rmSync(join(env.workspace, ".git"), { recursive: true, force: true });
			phase("ctx:context-removed");
			bob.ws.send(JSON.stringify({ type: "approve", approvalId: req.approvalId, decision: "allow" }));
			await waitFor(env.owner, (es) => es.some((e) => es.some((x) => x.type === "agent.end") && es.some((x) => x.type === "agent.end" && !(x as { willRetry?: boolean }).willRetry)), WAIT_TIMEOUT_MS, "ctx:agent.end");
			const err = env.owner.events.find((e) => e.type === "error") as Extract<ClientEvent, { type: "error" }> | undefined;
			const marker = existsSync(join(env.workspace, "package.json"));
			const decisions = await auditDecisions(env.auditFile);
			const invalidated = !!err && (String(err.message).includes("审批意图上下文已失效") || String(err.message).includes("不可靠"));
			const pass = invalidated && !marker && !decisions.some((d) => d.verdict === "allow");
			return { pass, decideRejected: invalidated, errorReason: err?.message?.slice(0, 160), markerWritten: marker, allowAudit: decisions.some((d) => d.verdict === "allow") };
		} finally { await closeWsAwait(bob); }
	} finally { await env.close(); }
}

async function main(): Promise<void> {
	phase("probe-start", { scenarios, preflightEnabled: optPreflight, injectCleanupFault });

	// 0) 用法校验（未知/缺失 scenario → 3）
	if (usageError) {
		manifest.usageError = { scenarioArg };
		manifest.plannedExit = 3; // 计划退出值先于任何 stdout 终态输出定值
		saveManifest();
		console.error(`未知 scenario：${scenarioArg}（可用：ng | git | ctx | all）`);
		phase("usage-error", { scenarioArg, plannedExit: 3 });
		process.exitCode = 3;
		return;
	}

	// 1) 真实 policy 预检：确认 write package.json 命中 require_approval（防 ActionDescriptor 缺 path 的 allow 误判）
	const engine = PolicyEngine.fromYaml(readFileSync(POLICY, "utf8"));
	const verdict = engine.evaluate({ tool: "write", path: "package.json", args: { path: "package.json", content: "{}" } }, { repo: "probe-repo", team: "probe-team" });
	phase("policy-precheck", { decision: verdict.decision, rule: "rule" in verdict ? verdict.rule : undefined });
	if (verdict.decision !== "require_approval") {
		manifest.policyPrecheck = { ok: false, verdict };
		manifest.plannedExit = 2;
		saveManifest();
		console.error("policy 预检失败：write package.json 未命中 require_approval，探针结果不可信");
		phase("policy-precheck-failed", { plannedExit: 2 });
		process.exitCode = 2;
		return;
	}
	manifest.policyPrecheck = { ok: true, decision: verdict.decision, rule: verdict.rule };

	// 2) 登记（不清理）当前环境 labeled 容器——仅作环境快照，所有权判定只看本次 gatewayId
	try {
		const ids = sh("docker", ["ps", "-a", "--filter", "label=perimeter.gateway", "--format", "{{.ID}} {{.Names}} {{.CreatedAt}}"]).trim();
		manifest.preexistingLabeledContainers = ids ? ids.split("\n") : [];
	} catch (e) { manifest.preexistingLabeledContainers = [`inspect failed: ${String(e).slice(0, 120)}`]; }
	phase("preexisting-registered", { count: (manifest.preexistingLabeledContainers as string[]).length });

	// 3) 可选 preflight（默认关闭）：启用属诊断项，manifest 标注 nonCold —— 不构成冷启动证据
	if (optPreflight) {
		const pfTag = `${runId}-preflight`;
		const pfOwned: Owned = { gatewayTag: pfTag, containerIds: [] };
		ownership.preflight = pfOwned;
		const pfDir = mkdtempSync(join(tmpdir(), "fe-probe-pf-"));
		pfOwned.tempDir = pfDir;
		let pfFailed = false;
		try {
			const pfBackend = new DockerBackend({ image: IMAGE, repoRoot: REPO, network: "none", gatewayId: pfTag });
			const pfStart = Date.now();
			const handle = await pfBackend.environment({ sessionId: "preflight", workspace: pfDir, home: join(pfDir, "home"), extensionPath: "", policyFile: POLICY, env: {} });
			const handshakeMs = Date.now() - pfStart;
			await handle.close();
			phase("preflight-handshake", { handshakeMs, nonCold: true });
			manifest.preflight = { handshakeMs, nonCold: true, note: "诊断项，默认关闭；不构成冷启动证据，不算验收 oracle" };
		} catch (e) {
			pfFailed = true;
			phase("preflight-handshake-failed", { error: String(e).slice(0, 300), nonCold: true });
			manifest.preflight = { ok: false, nonCold: true, error: String(e).slice(0, 300) };
		} finally {
			// finally 覆盖失败半启动：无论成败都清理 own 资源并核验
			pfOwned.containerIds = ownContainerIds(pfTag);
			const result = cleanupOwnedContainers(pfOwned);
			(manifest.cleanupVerification as Record<string, unknown>)["preflight"] = result;
			if (result.reconcile.length) (manifest.pendingReconcile as string[]).push(...result.reconcile);
			try { rmSync(pfDir, { recursive: true, force: true }); } catch {}
			if (pfFailed && !result.confirmed) manifest.preflightCleanupUnverified = true;
		}
	}

	// 4) 场景逐个真实运行：失败不中断后续场景（每场景独立网关/容器，互为对照）
	for (const sc of scenarios) {
		const started = Date.now();
		try {
			const result = sc === "ng" ? await scenarioNG() : sc === "git" ? await scenarioGIT() : await scenarioCTX();
			(manifest.scenarios_result as Record<string, unknown>)[sc] = { ...result, durationMs: Date.now() - started };
			phase(`${sc}:done`, { pass: result.pass, durationMs: Date.now() - started });
		} catch (e) {
			(manifest.scenarios_result as Record<string, unknown>)[sc] = { pass: false, error: String(e).slice(0, 500), durationMs: Date.now() - started };
			phase(`${sc}:failed`, { error: String(e).slice(0, 300) });
		}
	}

	// 5) 收尾核验：成功 = 指定场景 oracle 全过 且 own 清理逐一确认；否则如实 nonzero
	const results = manifest.scenarios_result as Record<string, { pass?: boolean; error?: string }>;
	const allRan = scenarios.every((sc) => results[sc] !== undefined);
	const allPassed = allRan && scenarios.every((sc) => results[sc]?.pass === true);
	const verifyEntries = Object.values(manifest.cleanupVerification as Record<string, { confirmed?: boolean }>);
	const cleanupConfirmed = verifyEntries.length > 0 && verifyEntries.every((v) => v.confirmed === true);
	const noPending = (manifest.pendingReconcile as string[]).length === 0;
	manifest.ownBeforeAfter = {
		before: manifest.preexistingLabeledContainers,
		ownContainerIds: Object.fromEntries(Object.entries(ownership).map(([k, v]) => [k, v.containerIds])),
		afterGlobalLabeledCount: (() => { try { return sh("docker", ["ps", "-aq", "--filter", "label=perimeter.gateway"]).split("\n").filter(Boolean).length; } catch { return -1; } })(),
		note: "泄漏判定只看 own ID 逐一核验（cleanupVerification.confirmed），全局计数仅环境参考",
	};
	manifest.finishedAt = new Date().toISOString();
	manifest.allPassed = allPassed;
	manifest.cleanupConfirmed = cleanupConfirmed;
	// 先按既定优先规则计算最终计划退出值：cleanup 未确认(4) > 场景失败/缺场景(1) > 成功(0)。
	// 同一真实计划值写 manifest、打 stdout、赋 process.exitCode —— 不先输出再折算。
	const scenarioFailed = !allRan || !allPassed;
	const cleanupUnconfirmed = !cleanupConfirmed || !noPending;
	const plannedExitCode = cleanupUnconfirmed ? 4 : scenarioFailed ? 1 : 0;
	manifest.plannedExit = plannedExitCode; // 「计划退出」：真实自然退出由外部 bounded runner 的 exit/close 记录佐证
	saveManifest();
	console.log("===MANIFEST===");
	console.log(JSON.stringify({
		runId, manifestPath, allPassed, cleanupConfirmed, pendingReconcile: manifest.pendingReconcile,
		scenarios: results, preflight: manifest.preflight ?? null, plannedExit: plannedExitCode,
	}, null, 1));
	process.exitCode = plannedExitCode;
	// return 后事件循环自然排空：mock/gateway/ws/docker 子命令均已 await 关闭
}

main().catch((e) => {
	phase("probe-crashed", { error: String(e).slice(0, 400) });
	manifest.crashed = true;
	manifest.plannedExit = 1;
	saveManifest();
	console.error(e);
	process.exitCode = 1; // 自然退出（非 process.exit），计划退出值与真实一致
});
