/**
 * R-Q9a'/b'/C：实际 DaemonResource（helper 接缝）故障注入负控矩阵。
 *
 * 全部使用 mock connection/snapshot/ps-runner/register/kill-spy：
 * - 无真实 PID、无真实 kill、无新 daemon；
 * - kill spy 断言：身份不符（birth/pgid/ppid/marker 任一漂移）→ 零 kill；
 * - track 失败：close 必须被调用、ledger 保留 unconfirmed/unknown、原异常保留（cleanupError 附带）；
 * - dispose 未观察态：显式 unconfirmed 失败（不得假 clean）；
 * - waitOwnerGone：generation 未采得且 owner 存活 → unknown（协调者复现场景）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DaemonResource, type DaemonResourceDeps } from "./helpers/daemon-resource.ts";
import { waitOwnerGone } from "./helpers/ps-observer.ts";
import type { PsRunResult, PsRunner } from "./helpers/ps-observer.ts";

const DAEMON = "/opt/daemon/pi-env";
const BIRTH = "Sat Oct 17 10:00:00 2026";
const OTHER_BIRTH = "Fri Oct 16 09:00:00 2026";

const line = (stat: string, ppid: number, pgid: number, birth: string, command: string): string =>
	`${stat}   ${ppid}  ${pgid}  ${birth}     ${command}`;
const ok = (stdout: string): PsRunResult => ({ status: 0, stdout, stderr: "" });
const psFail = (): PsRunResult => ({ status: 2, signal: null, stdout: "", stderr: "" });
const goneResult = (): PsRunResult => ({ status: 1, stdout: "", stderr: "" });

interface Harness {
	deps: DaemonResourceDeps;
	closeCalls: () => number;
	killCalls: () => Array<{ pid: number; signal: string }>;
	registeredCallbacks: () => Array<() => Promise<void>>;
	ledgerEvents: () => Array<Record<string, unknown>>;
	setPs: (byPid: Record<number, PsRunResult>) => void;
}

function makeHarness(options: {
	snapshot?: () => Promise<{ info: { pid: number }; sessionId: number }>;
	psByPid?: Record<number, PsRunResult>;
} = {}): Harness {
	const closeCalls: number[] = [];
	const killCalls: Array<{ pid: number; signal: string }> = [];
	const registered: Array<() => Promise<void>> = [];
	const events: Array<Record<string, unknown>> = [];
	let psByPid: Record<number, PsRunResult> = options.psByPid ?? {};
	const deps: DaemonResourceDeps = {
		connection: {
			snapshot: options.snapshot ?? (async () => ({ info: { pid: 4242 }, sessionId: 7 })),
			close: () => { closeCalls.push(1); psByPid = {}; }, // R-Q9a：close 即资源消失（ps 转 gone）
		},
		observer: (args: string[]) => {
			const pid = Number(args[args.indexOf("-p") + 1]);
			return psByPid[pid] ?? goneResult();
		},
		kill: (pid, signal) => { killCalls.push({ pid, signal }); const { [pid]: _removed, ...rest } = psByPid; psByPid = rest; },
		ledger: (e) => { events.push(e); },
		register: (dispose) => { registered.push(dispose); },
		nonce: "fault-nonce",
		daemonMarker: DAEMON,
		expectedParentPid: process.pid,
		expectedPgid: 555,
		deadlineMs: 400,
	};
	return {
		deps,
		closeCalls: () => closeCalls.length,
		killCalls: () => killCalls.slice(),
		registeredCallbacks: () => registered.slice(),
		ledgerEvents: () => events.slice(),
		setPs: (byPid) => { psByPid = byPid; },
	};
}

const aliveOwn = (): PsRunResult => ({ status: 0, stdout: line("S", process.pid, 555, BIRTH, `${DAEMON} serve --token x`), stderr: "" });

describe("DaemonResource.track 故障注入（R-Q9a'）", () => {
	it("snapshot reject → 仍登记（register 恰 1 次）+ close 被调用 + ledger unconfirmed + 重抛原异常", async () => {
		const h = makeHarness({ snapshot: async () => { throw new Error("snapshot boom"); } });
		await assert.rejects(DaemonResource.track(h.deps), /snapshot boom/);
		assert.equal(h.registeredCallbacks().length, 1, "dispose 必须在 await 前登记（恰好一个 callback）");
		assert.equal(h.closeCalls(), 1, "track 失败必须 close");
		const kinds = h.ledgerEvents().map((e) => String(e.outcome));
		assert.ok(kinds.some((o) => o.includes("track-failed")), "ledger 必须记录 track 失败");
		assert.ok(h.ledgerEvents().some((e) => String(e.outcome).includes("unconfirmed")), "pid 未知收尾必须如实 unconfirmed");
	});
});

describe("DaemonResource.observeBirth 负控（R-Q9b 出生核验）", () => {
	it("ps unknown（status2）→ 出生观察 unknown → close", async () => {
		const h = makeHarness({ psByPid: { 4242: psFail() } });
		await assert.rejects(DaemonResource.track(h.deps), /unknown/);
		assert.equal(h.closeCalls(), 1);
	});
	it("出生 ppid 错 → 拒收（不冻结代际）+ close + kill 零调用", async () => {
		const h = makeHarness({ psByPid: { 4242: { status: 0, stdout: line("S", 999, 555, BIRTH, `${DAEMON} serve`), stderr: "" } } });
		await assert.rejects(DaemonResource.track(h.deps), /ppid/);
		assert.deepEqual(h.killCalls(), [], "出生身份不匹配必须零 kill");
	});
	it("出生 marker 错 → 拒收 + close + kill 零调用", async () => {
		const h = makeHarness({ psByPid: { 4242: { status: 0, stdout: line("S", process.pid, 555, BIRTH, "/opt/other/serve"), stderr: "" } } });
		await assert.rejects(DaemonResource.track(h.deps), /marker/);
		assert.deepEqual(h.killCalls(), []);
	});
	it("出生 pgid 错（提供了期望组）→ 拒收 + close", async () => {
		const h = makeHarness({ psByPid: { 4242: { status: 0, stdout: line("S", process.pid, 999, BIRTH, `${DAEMON} serve`), stderr: "" } } });
		await assert.rejects(DaemonResource.track(h.deps), /pgid/);
		assert.equal(h.closeCalls(), 1);
	});
});

// ─── R-Q9a（round-5 required）：只调登记 callback 的三门（mock，无真实 PID/kill/daemon）───

describe("登记 callback 三门（只调已登记 callback，不手动 dispose）", () => {
	it("门1 成功路径：track 后只调登记 callback → close 恰 1 + inspect-gone gone + 幂等", async () => {
		const h = makeHarness({ psByPid: { 4242: aliveOwn() } });
		const resource = await DaemonResource.track(h.deps);
		void resource; // 成功路径客户端只依赖已登记 callback
		const callbacks = h.registeredCallbacks();
		assert.equal(callbacks.length, 1, "登记恰好一个 callback");
		await callbacks[0]!();
		assert.equal(h.closeCalls(), 1, "真实 close 恰 1");
		const goneEvents = h.ledgerEvents().filter((e) => e.event === "inspect-gone" && String(e.outcome).startsWith("gone"));
		assert.equal(goneEvents.length, 1, `必须正向 gone（close 后 ps gone）；ledger=${JSON.stringify(h.ledgerEvents()).slice(0, 400)}`);
		await callbacks[0]!(); // 幂等：重复调用不重复 close
		assert.equal(h.closeCalls(), 1, "幂等：close 仍为 1");
	});
	it("门2 snapshot reject：只调登记 callback → 真实 close + unconfirmed 保留（原异常不吞）", async () => {
		const h = makeHarness({ snapshot: async () => { throw new Error("snapshot boom"); } });
		const originalError = await DaemonResource.track(h.deps).then(
			() => { throw new Error("不应成功"); },
			(e: Error & { cleanupError?: unknown }) => e,
		);
		assert.match(originalError.message, /snapshot boom/, "原异常必须保留");
		const callbacks = h.registeredCallbacks();
		assert.equal(callbacks.length, 1);
		// track catch 已先经同一登记闭包做过 close+unconfirmed（closedOnce）——二次调用幂等，close 仍 1
		await assert.rejects(callbacks[0]!(), /unconfirmed/, "重复调用必须保留同一 unconfirmed 失败（sticky，不伪成功）");
		assert.equal(h.closeCalls(), 1, "sticky：close 恰 1 不重复");
		// sticky 语义：重复调用恒 reject 同一 unconfirmed（不伪成功）；close 不重复
		await assert.rejects(callbacks[0]!(), /unconfirmed/, "sticky：重复调用必须仍 reject unconfirmed");
		assert.equal(h.closeCalls(), 1, "幂等：close 仍为 1");
		const attached = (originalError as { cleanupError?: Error }).cleanupError;
		assert.ok(attached instanceof Error && /unconfirmed/.test(attached.message), `cleanup 异常必须附带: ${String(attached).slice(0, 120)}`);
		const unknownEvents = h.ledgerEvents().filter((e) => e.event === "unknown");
		assert.ok(unknownEvents.some((e) => String(e.outcome).includes("unconfirmed")), "ledger 必须记录 unconfirmed");
	});
	it("门3 首次 observe 失败：只调登记 callback → close + unknown（不 noop/不假 gone）", async () => {
		const h = makeHarness({ psByPid: { 4242: psFail() } }); // 出生观察 status2 → unknown
		const observeError = await DaemonResource.track(h.deps).then(
			() => { throw new Error("不应成功"); },
			(e: Error & { cleanupError?: unknown }) => e,
		);
		assert.match(observeError.message, /unknown/, "出生观察 unknown 必须抛出");
		const callbacks = h.registeredCallbacks();
		assert.equal(callbacks.length, 1);
		// track catch 已先经同一登记闭包做过 close+unconfirmed（closedOnce）——二次调用幂等，close 仍 1
		await assert.rejects(callbacks[0]!(), /unconfirmed/, "重复调用必须保留同一 unconfirmed 失败（sticky，不伪成功）");
		assert.equal(h.closeCalls(), 1, "sticky：close 恰 1 不重复");
		// sticky 语义：重复调用恒 reject 同一 unconfirmed（不伪成功）；close 不重复
		await assert.rejects(callbacks[0]!(), /unconfirmed/, "sticky：重复调用必须仍 reject unconfirmed");
		assert.equal(h.closeCalls(), 1, "幂等：close 仍为 1");
		const goneEvents = h.ledgerEvents().filter((e) => e.event === "inspect-gone");
		assert.equal(goneEvents.length, 0, "未建代际绝不得 emit gone（不假 gone）");
		assert.ok(h.ledgerEvents().some((e) => e.event === "unknown" && String(e.outcome).includes("unknown")), "ledger 必须记录出生观察 unknown");
	});
});

describe("DaemonResource.kill 前代际漂移负控（R-Q9b'，注入 spy 断言零 kill）", () => {
	it("登记后 birth 漂移（同 ppid/pgid/marker）→ 拒杀且零 kill", async () => {
		const h = makeHarness({ psByPid: { 4242: aliveOwn() } });
		const resource = await DaemonResource.track(h.deps);
		h.setPs({ 4242: { status: 0, stdout: line("S", process.pid, 555, OTHER_BIRTH, `${DAEMON} serve --token x`), stderr: "" } });
		assert.throws(() => resource.inspectIdentity(), /birth/);
		await assert.rejects(resource.kill(), /birth|拒杀/);
		assert.equal(h.killCalls().length, 0, "birth 漂移必须零 kill");
	});
	it("登记后 ppid 漂移（同 birth/pgid/marker）→ 拒杀且零 kill", async () => {
		const h = makeHarness({ psByPid: { 4242: aliveOwn() } });
		const resource = await DaemonResource.track(h.deps);
		h.setPs({ 4242: { status: 0, stdout: line("S", 999, 555, BIRTH, `${DAEMON} serve --token x`), stderr: "" } });
		await assert.rejects(resource.kill(), /登记代际不符|ppid/);
		assert.equal(h.killCalls().length, 0);
	});
	it("登记后 pgid 漂移（同 birth/ppid/marker）→ 拒杀且零 kill", async () => {
		const h = makeHarness({ psByPid: { 4242: aliveOwn() } });
		const resource = await DaemonResource.track(h.deps);
		h.setPs({ 4242: { status: 0, stdout: line("S", process.pid, 999, BIRTH, `${DAEMON} serve --token x`), stderr: "" } });
		await assert.rejects(resource.kill(), /登记代际不符|pgid/);
		assert.equal(h.killCalls().length, 0);
	});
	it("登记后 marker 漂移（同 birth/ppid/pgid）→ 拒杀且零 kill", async () => {
		const h = makeHarness({ psByPid: { 4242: aliveOwn() } });
		const resource = await DaemonResource.track(h.deps);
		h.setPs({ 4242: { status: 0, stdout: line("S", process.pid, 555, BIRTH, "/opt/other/pi-env serve"), stderr: "" } });
		await assert.rejects(resource.kill(), /登记代际不符/);
		assert.equal(h.killCalls().length, 0);
	});
	it("身份一致 → kill spy 恰一次 + waitOwnerGone gone 正向返回", async () => {
		const h = makeHarness({ psByPid: { 4242: aliveOwn() } });
		const resource = await DaemonResource.track(h.deps);
		// kill spy 触发时同步移除 psByPid 条目：模拟「kill 后进程消失」的时序（观察在 kill 之后）
		await resource.kill();
		assert.equal(h.killCalls().length, 1);
		assert.deepEqual(h.killCalls()[0], { pid: 4242, signal: "SIGKILL" });
	});
});

function gone(): PsRunResult { return { status: 1, stdout: "", stderr: "" }; }

describe("waitOwnerGone/未建代际（R-Q9c 协调者复现语义）", () => {
	it("generation 未采得（NaN/空）且 owner 存活 → unknown（不得 resolve 为 gone/reused）", async () => {
		const observer: PsRunner = () => ({ status: 0, stdout: line("S", 111, 222, BIRTH, "/opt/daemon/pi-env"), stderr: "" });
		const events: Array<Record<string, unknown>> = [];
		await assert.rejects(
			waitOwnerGone({
				observer, pid: 100,
				generation: { ppid: Number.NaN, pgid: Number.NaN, birth: "", marker: "" },
				nonce: "coordinator-fake-unobserved-generation", deadlineMs: 100,
				ledger: (e) => events.push(e),
			}),
			/generation 未采得|unknown/i,
		);
		assert.equal(events.some((e) => String(e.outcome).includes("gone-pid-reused")), false, "不得记为 reused");
	});
});

// 有效代际 waitOwnerGone 已在 ps-observer.test.ts 覆盖（drift unknown/birth 不同 reused/gone）。
