/**
 * G1 session-pin 集成测试（perimeter 侧，真实 daemon binary + 真实 path-guard helper 全链路）。
 *
 * 覆盖协调者要点：
 * - openEnvironment 单点 snapshot（info+sessionId 原子）→ pinned guardEnv 创建与核验；
 * - createPathGuardResolver 拒绝 unpinned 远端 env（严禁回退）；pinned 真实 helper 正控；
 * - daemon 被杀且 transport exit → 守卫解析立即 lost fail-closed，command factory 计数不增（无新 daemon）；
 * - 同 Connection unpinned 工具 env 真实重连正控；旧 pin 持续 deny；新 snapshot 新 pin 恢复；
 * - guard abort 只取消本请求，无关 unpinned sentinel 不受影响。
 *
 * 前置：本仓 node_modules 的 pi-env 已应用 vendor/pi-env 补丁（scripts/pi-env-patch.mjs apply）；
 * 未应用时 verifyPiEnvPatchInstalled 抛错 → 相关用例失败（诚实失败，不静默跳过）。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { openEnvironment, verifyPiEnvPatchInstalled, remoteEnvHome } from "../src/runtime/execution-env.ts";
import { createPathGuardResolver } from "../src/runtime/path-guard.ts";
import { DaemonResource } from "./helpers/daemon-resource.ts";
import { appendLedgerEvent, psIdentity, runAllCleanups, waitOwnerGone, realPsRunner, type ObservedIdentity, type PsState } from "./helpers/ps-observer.ts";

const DAEMON = join(import.meta.dirname, "..", "node_modules", "@earendil-works", "pi-env", "bin",
	`pi-env-${process.platform}-${process.arch}`, "pi-env");
const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	// R-Q9a：全量 settled——每个 cleanup 都被执行并 await，错误聚合不吞
	const error = await runAllCleanups(cleanups);
	if (error) throw error;
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── R-Q2/Q5/Q8：机器可读资源台账（每 daemon 资源一条 JSONL 事件流）──────

const LEDGER_PATH = process.env.PERIMETER_PIN_LEDGER ?? "/tmp/perimeter-r9/ledger-session-pin.jsonl";
const RUN_NONCE = `pin-${process.pid}-${Date.now().toString(36)}`;
let ledgerSeq = 0;

interface LedgerEvent {
	event: "start" | "inspect" | "cleanup" | "inspect-gone" | "unknown";
	nonce: string;
	localpid?: number;
	pgid?: number;
	ppid?: number;
	birth?: string;
	session?: number;
	outcome: string;
	time?: string;
}

function ledger(e: LedgerEvent): void {
	// R-Q9e：白名单写入（新文件 0600；已存在保留现权限，不妄称改旧权限）
	appendLedgerEvent(LEDGER_PATH, e as unknown as Record<string, unknown>);
}

/** owned 身份：存活且 ppid===本测试进程（直接子进程）且 command 含 daemon 路径（PID 复用防护）。 */
function ownedIdentity(pid: number): { owned: true; identity: ObservedIdentity } | { owned: false; identity: PsState } {
	const id = psIdentity(realPsRunner(), pid);
	if (id.state !== "alive") return { owned: false, identity: id };
	const owned = id.identity.ppid === process.pid && id.identity.command.includes(DAEMON);
	return owned ? { owned: true, identity: id.identity } : { owned: false, identity: id };
}

/** C：实际 DaemonResource 已迁 tests/helpers/daemon-resource.ts（注入式接缝）；
 * 本文件经 trackDaemon() 以生产同一路径使用（同 helper，无假实现自测）。 */
function trackDaemon(connection: Connection): Promise<DaemonResource> {
	// 期望进程组采集：不可采即 unknown 拒绝（诚实失败，不猜）
	const own = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { timeout: 3000, encoding: "utf8" });
	if (own.status !== 0 || own.stdout.trim() === "") throw new Error("本测试进程 pgid 不可采（unknown）——拒绝创建 tracked resource");
	return DaemonResource.track({
		connection,
		observer: realPsRunner(),
		kill: (pid, signal) => process.kill(pid, signal),
		ledger: (e) => ledger(e as unknown as LedgerEvent),
		register: (d) => cleanups.push(d),
		nonce: `${RUN_NONCE}-${++ledgerSeq}`,
		daemonMarker: DAEMON,
		expectedParentPid: process.pid,
		expectedPgid: Number(own.stdout.trim()),
		deadlineMs: 5000,
	});
}

/** R-Q8：发现本测试进程直接子代中的 pi-env daemon（ppid+command+serve 归属，非全局计数）。 */
function findSessionDaemons(): number[] {
	const r = spawnSync("ps", ["-eo", "pid=,ppid=,command="], { timeout: 3000, encoding: "utf8" });
	if (r.status !== 0) throw new Error("ps 全表扫描失败（unknown）");
	const out: number[] = [];
	for (const line of r.stdout.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		if (m && Number(m[2]) === process.pid && m[3]!.includes(DAEMON) && m[3]!.includes("serve")) out.push(Number(m[1]));
	}
	return out;
}

function makeWs(): string {
	return mkdtempSync(join(tmpdir(), "pin-it-"));
}

test("补丁运行时核验：verifyPiEnvPatchInstalled 通过（未打补丁的安装必须先跑 apply 脚本）", () => {
	assert.doesNotThrow(() => verifyPiEnvPatchInstalled());
});

test("openEnvironment：单点 snapshot → pinned guardEnv 核验一致，pinned 真实 helper 解析正控（含 owned daemon 生命周期）", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	const handle = await openEnvironment({ cwd: ws, command: [DAEMON] });
	// R-Q6/R-Q9a'：handle 创建后立即登记 close（finally 真实 await）；close 后做真实观察，
	// 归属发现/观察不可证 → ledger unknown + 如实失败（不把同步 close 当观察、不假 clean）
	const daemonPids = findSessionDaemons();
	if (daemonPids.length !== 1) {
		await handle.close();
		// R-Q9g：固定类别（daemonPids 为数字数组，不拼进持久 outcome）；throw 保留语义
		ledger({ event: "unknown", nonce: `${RUN_NONCE}-openenv`, outcome: "daemon 归属发现异常——unconfirmed，已 close 不假 clean" });
		throw new Error(`daemon 归属发现异常: ${JSON.stringify(daemonPids)}`);
	}
	const nonce = `${RUN_NONCE}-openenv`;
	const daemonPid = daemonPids[0]!;
	const idAtStart = ownedIdentity(daemonPid);
	if (!idAtStart.owned) {
		await handle.close();
		ledger({ event: "unknown", nonce, localpid: daemonPid, outcome: `daemon 出生身份不可证——unconfirmed，已 close 不假 clean` });
		// R-Q9j：身份内容（可含 daemon argv/token）不进异常通道；ppid/pgid/birth 已在 ledger
		throw new Error("daemon 出生身份不可证（ppid/pgid/birth 已记 ledger；身份内容不透传异常通道）");
	}
	const generation = { ...idAtStart.identity, marker: DAEMON };
	ledger({ event: "start", nonce, localpid: daemonPid, pgid: generation.pgid, ppid: generation.ppid, birth: generation.birth, outcome: "alive" });
	// dispose：handle.close（同步不证远端）+ 外部 owned PID 有界观察真实消失，finally 语义由 cleanups await 保证
	cleanups.push(async () => {
		ledger({ event: "cleanup", nonce, localpid: daemonPid, outcome: "handle-close" });
		await handle.close();
		await waitOwnerGone({ observer: realPsRunner(), pid: daemonPid, generation, nonce, deadlineMs: 5000, ledger: (e) => ledger(e as unknown as LedgerEvent) });
	});
	assert.ok(handle.guardEnv, "远端会话必须提供 pinned guardEnv");
	const pin = (handle.guardEnv as RemoteExecutionEnv).pinnedSession;
	assert.equal(typeof pin, "number", "guardEnv 必须带可核验 pin");
	assert.ok(typeof remoteEnvHome.get(handle.guardEnv!) === "string", "guardEnv 必须有打开时缓存 metadata");
	assert.notEqual(handle.env, handle.guardEnv, "guardEnv 与工具 env 必须是不同实例（工具 env 不 pin）");
	const resolver = createPathGuardResolver(() => handle.guardEnv!, 5000, { helperNode: process.execPath });
	const resolved = await resolver("src/deep/new/dir/file.txt");
	assert.equal(resolved.root, realpathSync(ws), "pinned 守卫解析 root=env cwd canonical（同 namespace）");
	assert.equal(resolved.canonical, join(realpathSync(ws), "src/deep/new/dir/file.txt"));
});

test("createPathGuardResolver 拒绝 unpinned 远端 env（严禁回退 unpinned）", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	const connection = new Connection({ command: [DAEMON] });
	const resource = await trackDaemon(connection); // R-Q6：创建即登记
	const env = new RemoteExecutionEnv({ connection, id: "plain", cwd: ws }); // 无 pin
	remoteEnvHome.set(env, "/tmp");
	const resolver = createPathGuardResolver(() => env, 3000, { helperNode: process.execPath });
	await assert.rejects(resolver("x.txt"), (e: NodeJS.ErrnoException) => (e as { code?: string }).code === "unknown");
});

test("daemon 被杀且 transport exit → 守卫解析立即 fail-closed，factory 计数不增（零重连/零新 daemon；R-Q2 生命周期）", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	let calls = 0;
	const connection = new Connection({ command: () => { calls += 1; return Promise.resolve([DAEMON]); } });
	const resource = await trackDaemon(connection); // R-Q6：创建即登记（dispose 幂等，finally 真实 await）
	const guard = new RemoteExecutionEnv({ connection, id: "guard", cwd: ws, sessionPin: resource.session });
	remoteEnvHome.set(guard, "/tmp"); // helper 不使用 HOME，仅需台账条目存在
	const resolver = createPathGuardResolver(() => guard, 5000, { helperNode: process.execPath });
	await resolver("ok.txt"); // 存活期正控
	resource.inspectIdentity(); // kill 前身份复核（owned/ppid/pgid）
	await resource.kill(); // 只动本代 owned PID，含 after-kill gone 观察
	const t0 = Date.now();
	await assert.rejects(resolver("x.txt"), (e: NodeJS.ErrnoException) => (e as { code?: string }).code === "unknown");
	const elapsed = Date.now() - t0;
	assert.ok(elapsed < 2000, `必须立即 lost（实际 ${elapsed}ms，无重连等待）`);
	assert.equal(calls, 1, "command factory 不得再被调用");
	await assert.rejects(resolver("y.txt"), (e: NodeJS.ErrnoException) => (e as { code?: string }).code === "unknown");
	assert.equal(calls, 1, "反复尝试仍零重连");
});

test("R-Q1：同 Connection——kill→本地退出→teardown barrier（旧 pin lost）→unpinned 重连唯一新 daemon→新 snapshot 新 pin 恢复", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	let calls = 0;
	const connection = new Connection({ command: () => { calls += 1; return Promise.resolve([DAEMON]); } });
	const oldResource = await trackDaemon(connection); // R-Q6：创建即登记
	const oldGuard = new RemoteExecutionEnv({ connection, id: "guard", cwd: ws, sessionPin: oldResource.session });
	remoteEnvHome.set(oldGuard, "/tmp");
	const oldResolver = createPathGuardResolver(() => oldGuard, 5000, { helperNode: process.execPath });
	await oldResolver("before.txt");
	await oldResource.kill(); // 身份复核→SIGKILL→本地退出（gone/复用）→ledger
	// R-Q1 确定性 barrier：旧 pinned 探针必须以 lost 立即拒绝（teardown 已处理本请求）；
	// 探针无副作用（helper 只读解析），≤3 次即时，非 lost 失败即真实失败
	let barrierAttempts = 0;
	const barrierDeadline = Date.now() + 5000;
	for (;;) {
		barrierAttempts += 1;
		try {
			await oldResolver("teardown-probe.txt");
			throw new Error("teardown 后旧 pinned 探针意外成功——pin 语义被破坏");
		} catch (e) {
			if ((e as { code?: string }).code === "unknown") break; // lost = barrier 达成
			if (Date.now() > barrierDeadline || barrierAttempts >= 3) throw e;
		}
		await sleep(25);
	}
	// unpinned 工具 env：barrier 后发起唯一新 daemon（lost 类有界重试 ≤3，其它错误真实失败）
	const tools = new RemoteExecutionEnv({ connection, id: "tools", cwd: ws });
	let r: Awaited<ReturnType<typeof tools.exec>> | undefined;
	let reconnectAttempts = 0;
	const reconnectDeadline = Date.now() + 5000;
	for (;;) {
		reconnectAttempts += 1;
		r = await tools.exec(["echo", "reconnected"], undefined, { abortSignal: undefined } as never);
		if (r.ok) break;
		const code = (r as { ok: false; error: { code?: string } }).error.code;
		if (code !== "unknown" || reconnectAttempts >= 3 || Date.now() > reconnectDeadline) {
			throw new Error(`unpinned 重连失败（第 ${reconnectAttempts} 次）: ${JSON.stringify(r).slice(0, 160)}`);
		}
		await sleep(25);
	}
	assert.equal(calls, 2, "重连恰好新起一次 daemon");
	// 旧 pin：持续 deny，不追随新 session
	await assert.rejects(oldResolver("after.txt"), (e: NodeJS.ErrnoException) => (e as { code?: string }).code === "unknown");
	assert.equal(calls, 2);
	// 新 snapshot 新 pin：恢复（snapshot 命中 tools 已建立的 #ready，非额外连接）
	const newSnap = await connection.snapshot();
	assert.ok(newSnap.sessionId > oldResource.session);
	// R-Q9a：重连产生的新代必须新 track/new nonce/完整身份/末 gone——不能只关 currentConnection 后等旧 PID
	const newResource = await trackDaemon(connection);
	newResource.inspectIdentity();
	assert.equal(newResource.session, newSnap.sessionId, "新代 session 与新 snapshot 一致");
	assert.notEqual(newResource.pid, oldResource.pid, "新代必须是新 daemon 进程");
	const newGuard = new RemoteExecutionEnv({ connection, id: "guard2", cwd: ws, sessionPin: newSnap.sessionId });
	remoteEnvHome.set(newGuard, "/tmp");
	const newResolver = createPathGuardResolver(() => newGuard, 5000, { helperNode: process.execPath });
	const resolved = await newResolver("recovered/new.txt");
	assert.equal(resolved.canonical, join(realpathSync(ws), "recovered/new.txt"));
	// 收尾：旧代已 gone（kill 时证）、新代 dispose 走完整 close+gone 观察
	await newResource.dispose();
});

test("R8/R-Q6：connection.close 同步返回不证远端结束——创建即登记，close 后外部 owned PID 有界观察真实 exit 与身份消失", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	let calls = 0;
	const connection = new Connection({ command: () => { calls += 1; return Promise.resolve([DAEMON]); } });
	const resource = await trackDaemon(connection); // R-Q6：创建后立即登记（任意失败分支都走 dispose）
	resource.inspectIdentity(); // 出生身份：ppid===测试进程/pgid===测试进程组/birth
	// 同步 close 不等 transport 退出（SDK 既有行为，R8 口径）——因此以外部 owned PID 有界观察真实结束
	await resource.dispose(); // close + waitGone（gone/复用），幂等
	// close 后不再有新 daemon（factory 计数不增），owned 身份生命周期 start→alive→gone 闭环（全事件在 ledger）
	assert.equal(calls, 1);
});

test("guard abort 只取消本请求：无关 unpinned sentinel 不受影响（真实 helper 全链路）", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	const connection = new Connection({ command: [DAEMON] });
	const resource = await trackDaemon(connection); // R-Q6：创建即登记
	const guard = new RemoteExecutionEnv({ connection, id: "guard", cwd: ws, sessionPin: resource.session });
	const tools = new RemoteExecutionEnv({ connection, id: "tools", cwd: ws });
	remoteEnvHome.set(guard, "/tmp");
	const resolver = createPathGuardResolver(() => guard, 30_000, { helperNode: process.execPath });
	// 无关 sentinel：unpinned 工具 env 上的长 exec，与 guard 请求同连接并行
	const sentinel = tools.exec(["/bin/sh", "-c", "sleep 0.5; echo done"], undefined, { abortSignal: undefined } as never);
	// 取消只作用于本 guard 请求：已 abort 的信号 → 立即 aborted 类失败（helper 极快无法中途取消，
	// 中途取消的组杀证据由 path-guard-exec-helper 的 kill 证明覆盖），同连接的 sentinel 不受影响
	const controller = new AbortController();
	controller.abort();
	const t0 = Date.now();
	await assert.rejects(resolver("slow-guard.txt", controller.signal), (e: NodeJS.ErrnoException) => (e as { code?: string }).code === "aborted");
	assert.ok(Date.now() - t0 < 5000, "abort 后 guard 必须 promptly 以 aborted 失败");
	// sentinel 期间发起的第二次 guard 请求（新 controller）照常工作：取消不波及后续请求
	const second = await resolver("after-abort.txt");
	assert.equal(second.canonical, join(realpathSync(ws), "after-abort.txt"));
	const s = await sentinel;
	assert.ok(s.ok && s.value.exitCode === 0, "sentinel 必须不受 guard abort 影响");
});
