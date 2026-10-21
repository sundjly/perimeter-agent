import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, test } from "node:test";
import {
	cleanupProcessGroup,
	runBounded,
	validateProcessGroup,
	type RunnerDeps,
	type RunBoundedResult,
} from "../scripts/bounded-test-runner.ts";
import { extractJsonStringTokens, scanJsonDecoded } from "../src/modelgw/secrets.ts";

// R45 因果测试（R-Q43-3/4 DLP 面 + R-Q45 runner 面部分用例；R47 起状态：DLP 节纯函数
// 不变仍有效；runner 节 C7 已改假钟调度，C2/C6/C8 等仍含真实 setTimeout(20ms) 协调与
// clear 只记录的假 clear——非全 timers fake（R46 G7/R-Q45-6 口径），全假钟因果由
// tests/bounded-runner-r47-cases.test.ts 承担。零资源：无真实 spawn/ps/signal/socket。
// 信号只记录不投递，无真实 child/ps/socket/server；静态确认 imports 无 http/server 实调）。
// 自监督 primary watchdog：自寿命 ≤9s，超时强制非零退出（断言红必须真实非零，不盖 0）。
const WATCHDOG_MS = 9_000;
const watchdog = setTimeout(() => {
	console.error("R45-WATCHDOG: 自寿命超 9s，强制非零退出（pipeline 停）");
	process.exit(124);
}, WATCHDOG_MS);

const BIRTH = "Mon Oct 19 03:00:00 2026";
const VAL = "r45" + "CausalValue9f3a"; // 18 字符类内值，非占位前缀
const AKIA = "AKIA" + "IOSFODNN7EXAMPLE";

interface Sig { target: number; sig: string }

/** 全注入 fake deps（真实计数 psCalls；fake 钟可推进；信号只记录） */
function fakeDeps(opts: {
	pgid: number;
	command: string;
	birth?: string;
	consumeMs?: number;
	failFromCall?: number;
}) {
	const signals: Sig[] = [];
	const psCalls: { pid: number; budget: number }[] = [];
	const cleared: unknown[] = [];
	let t = 1_000_000;
	let call = 0;
	const deps: RunnerDeps = {
		now: () => t,
		sleep: async (ms) => { t += ms; },
		signal: (target, sig) => { signals.push({ target, sig: String(sig) }); },
		setTimeoutImpl: (fn) => fn,
		clearTimeoutImpl: (h) => { cleared.push(h); },
		procInfo: (pid, budget) => {
			call++;
			psCalls.push({ pid, budget });
			if (opts.consumeMs) t += opts.consumeMs;
			if (opts.failFromCall !== undefined && call >= opts.failFromCall) return null;
			return { pgid: opts.pgid, ppid: process.pid, birth: opts.birth ?? BIRTH, command: opts.command };
		},
	};
	return { deps, signals, psCalls, cleared, advance: (ms: number) => { t += ms; }, calls: () => call };
}

// ── R-Q43-4：token 上限在抽取过程中当场强制 ──────────────────

test("R45-A1：tokenizer 达 maxTokens 当场 fail（不先完整提取再判断）", () => {
	// 1000 个 token 的 body；上限 3 → 新实现第 4 个 token 前即抛；
	// 旧实现（R43 基线）签名无 maxTokens，参数被忽略 → 完整返回 1000 个 token（红）。
	const body = `{"a":"v0",` + `"b":"v",`.repeat(499) + `"z":"v9"}`;
	assert.ok((body.match(/"/g) ?? []).length / 2 >= 1000, "夹具前置：token 数 ≥1000");
	assert.throws(
		() => extractJsonStringTokens(body, { maxDepth: 64, maxTokens: 3, onFail: (k) => { throw new Error(k); } }),
		/json_bounds_exceeded/,
		"累计达上限必须当场抛，而不是抽取全部后返回",
	);
	// 上限内正常返回（对照：非红路径）
	const small = extractJsonStringTokens(`{"k":"v"}`, { maxDepth: 64, maxTokens: 3, onFail: (k) => { throw new Error(k); } });
	assert.equal(small.length, 2);
});

test("R45-A2：late-duplicate collapse 炸弹 → 抽取过程中当场 fail（不先完整提取再判断）", () => {
	// 8300 个同对象重复 key：JSON.parse 塌缩后 walk nodes=3（极小）；旧实现抽取全部 16602
	// token 后才在后置长度检查拖 bounds；新实现在抽取中第 2 个重复 key 即当场报
	// json_duplicate_key（等价可证累计 guard：同缝 A1 以 maxTokens=3 直接证当场性）。
	const parts: string[] = [];
	for (let i = 0; i < 8300; i++) parts.push(`"k":"v${i}"`);
	const body = `{${parts.join(",")},"k":"clean"}`;
	assert.throws(() => scanJsonDecoded(body), /json_duplicate_key/);
	// 数组前值形态：{"k":[8300 strings],"k":"clean"} —— walk 在塌缩文档上计数，8300 字符串
	// 超 nodes 上限 → walk 阶段即 bounds 拒（同样 fail-closed，不达 tokenizer）。
	const arr = `{"k":[${Array.from({ length: 8300 }, (_, i) => `"s${i}"`).join(",")}],"k":"clean"}`;
	assert.throws(() => scanJsonDecoded(arr), /json_bounds_exceeded/);
	// 对照：唯一 key + 低于上限 → 正常
	assert.doesNotThrow(() => scanJsonDecoded(`{"only":"${VAL}"}`));
});

// ── R-Q43-3：own-pair 经完整 RULES 合成（raw 词边界语义 parity）──────

test("R45-B1：raw 词边界可达的三形态在解码层同条目命中（转义 key）", () => {
	const forms: [string, string, string][] = [
		[`{"my\\u002dpassword":"${VAL}"}`, "credential-assignment", "my-password"],
		[`{"auth\\u002dtoken":"${VAL}"}`, "credential-assignment", "auth-token"],
		[`{"authorizatio\\u006e":"Bearer ${AKIA.slice(0, 20)}0"}`, "authorization-header", "authorization"],
	];
	for (const [body, kind, name] of forms) {
		const hits = scanJsonDecoded(body);
		assert.ok(
			hits.some((h) => h.kind === kind),
			`own-pair 合成必须覆盖 ${name}（${kind}）: ${JSON.stringify(hits)}`,
		);
	}
});

test("R45-B2：词边界正反 + 不误拼 + 转义值", () => {
	// 正：连字符前缀变体未转义形态也命中（与 raw 一致）
	assert.ok(scanJsonDecoded(`{"my-password":"${VAL}"}`).some((h) => h.kind === "credential-assignment"));
	// 反：无词边界前缀/后缀不命中（xpassword、passwordx）
	assert.deepEqual(scanJsonDecoded(`{"xpassword":"${VAL}"}`), [], "xpassword 无 \\b 边界不得命中");
	assert.deepEqual(scanJsonDecoded(`{"passwordx":"${VAL}"}`), [], "passwordx 名册词后非分隔符不得命中");
	// 反：authorization 词边界后缀
	assert.deepEqual(scanJsonDecoded(`{"authorizationx":"Bearer ${AKIA.slice(0, 20)}0"}`), [], "authorizationx 不得命中 authorization-header");
	// 反：无关 pass/word 单条目不误拼（合成串无名册词边界）
	assert.deepEqual(scanJsonDecoded(`{"pass":"word1234567890"}`), [], "pass+word 同条目不得误拼命中");
	assert.deepEqual(scanJsonDecoded(`{"pass":"clean","word":"1234567890123"}`), [], "跨字段不误拼保持");
	// 转义 key + 转义值（aws-access-key 值独立扫描 + assignment 合成双通道）
	const hits = scanJsonDecoded(`{"my\\u002dpassword":"\\u0041KIAIOSFODNN7EXAMPLE"}`);
	assert.ok(hits.some((h) => h.kind === "aws-access-key"), "转义值独立扫描命中 aws-access-key");
	assert.ok(hits.some((h) => h.kind === "credential-assignment"), "own-pair 合成命中 credential-assignment");
});

// ── R-Q43-1：cleanup 预算钳制（无 grace 扩展/额外 margin）─────────

test("R45-C1：cleanup 全程钳在 budgetMs 内——graceMs 超大也不得越过剩余预算发 KILL", async () => {
	const { deps, signals, psCalls } = fakeDeps({ pgid: 4401, command: "/bin/t --nonce-c1", consumeMs: 150 });
	const out = await cleanupProcessGroup({
		childPid: 4401, childPgid: 4401, isSafeGroup: true,
		graceMs: 10_000, budgetMs: 200, // grace 请求远大于剩余预算
		expectedBirth: BIRTH, expectedCommand: "/bin/t --nonce-c1",
		childExited: () => false, deps,
	});
	// TERM 核验消耗 150 → 剩余 50；grace=min(10000,50)=50 → 耗尽 → KILL 前零信号
	assert.deepEqual(signals.filter((s) => s.sig.includes("KILL")), [], `预算耗尽不得 KILL: ${JSON.stringify(signals)}`);
	assert.equal(signals.filter((s) => s.sig.includes("TERM")).length, 1, "TERM 在预算内正证发出");
	assert.equal(out.signaled, true);
	assert.equal(out.residue, "unknown");
	assert.ok(psCalls.every((c) => c.budget > 0), "每次观察 budget 必须 >0");
	// 整个 cleanup 在 fake 钟上的消耗不超过 budgetMs（无 grace 扩展）
	assert.equal(psCalls.length >= 2, true, "TERM 核验 + grace 内至少一次观察（真实计数对照）");
});

test("R45-C2：runBounded 超时处置预算 = 剩余总预算（无 max(grace+2000) 扩展）——hangChild 下零 KILL 且 unproven 124", async () => {
	const signals: Sig[] = [];
	const cleared: unknown[] = [];
	const timerFns: (() => void)[] = [];
	let t = 1_000_000;
	const deps: RunnerDeps = {
		now: () => t,
		sleep: async (ms) => { t += ms; },
		signal: (target, sig) => { signals.push({ target, sig: String(sig) }); },
		setTimeoutImpl: (fn) => { timerFns.push(fn); setTimeout(fn, 20); return fn; },
		clearTimeoutImpl: (h) => { cleared.push(h); },
		spawnImpl: (() => {
			const c = new EventEmitter();
			(c as unknown as { pid: number }).pid = 4402; // hang：永不 exit/close
			return c as never;
		}) as never,
		procInfo: () => { t += 60; return { pgid: 4402, ppid: process.pid, birth: BIRTH, command: "/bin/t --nonce-c2" }; },
	};
	const res = await runBounded({
		command: ["/bin/t", "--nonce-c2"],
		timeoutMs: 300, graceMs: 10_000, stdio: "ignore", deps,
	});
	// target 到点后剩余预算很小：TERM 在预算内正证发出；grace/KILL 阶段预算耗尽 → 零 KILL
	// （无 grace 扩展），unproven 124 + resources unknown。
	assert.equal(res.exitCode, 124);
	assert.equal(res.settlement, "unproven_unknown");
	assert.equal(res.targetExitProven, false);
	assert.deepEqual(signals.filter((s) => s.sig.includes("KILL")), [], `无扩展预算后不得越窗 KILL: ${JSON.stringify(signals)}`);
	assert.ok(signals.filter((s) => s.sig.includes("TERM")).length <= 1, "TERM 至多一次（预算内正证）");
	assert.equal(res.groupResidue, "unknown");
});

// ── R-Q43-2：fallible 日志前置 + 扳机邻接 + 统一 finally 收 timer ────

test("R45-C3：TERM 意图日志同步耗尽预算 → cleanup 正常返回且零过期枪（日志在观察前）", async () => {
	const signals: Sig[] = [];
	let t = 1_000_000;
	const deps: RunnerDeps = {
		now: () => t,
		sleep: async (ms) => { t += ms; },
		signal: (target, sig) => { signals.push({ target, sig: String(sig) }); },
		setTimeoutImpl: (fn) => fn,
		clearTimeoutImpl: () => {},
		procInfo: () => ({ pgid: 4403, ppid: process.pid, birth: BIRTH, command: "/bin/t --nonce-c3" }),
	};
	const out = await cleanupProcessGroup({
		childPid: 4403, childPgid: 4403, isSafeGroup: true,
		graceMs: 50, budgetMs: 300,
		expectedBirth: BIRTH, expectedCommand: "/bin/t --nonce-c3",
		childExited: () => false, deps,
		onLog: () => { t += 400; }, // 意图日志（观察前）同步耗尽剩余预算
	});
	assert.equal(signals.length, 0, `日志耗尽预算后不得有过期枪: ${JSON.stringify(signals)}`);
	assert.equal(out.signaled, false);
	assert.equal(out.residue, "unknown");
});

test("R45-C4：TERM 意图日志改身份 → 观察在新身份下进行 → 零信号", async () => {
	const signals: Sig[] = [];
	let swapped = false;
	const deps: RunnerDeps = {
		now: () => 1_000_000,
		sleep: async () => {},
		signal: (target, sig) => { signals.push({ target, sig: String(sig) }); },
		setTimeoutImpl: (fn) => fn,
		clearTimeoutImpl: () => {},
		procInfo: () => swapped
			? { pgid: 4404, ppid: process.pid, birth: BIRTH, command: "/bin/evil --pwn" }
			: { pgid: 4404, ppid: process.pid, birth: BIRTH, command: "/bin/t --nonce-c4" },
	};
	const out = await cleanupProcessGroup({
		childPid: 4404, childPgid: 4404, isSafeGroup: true,
		graceMs: 30, budgetMs: 5_000,
		expectedBirth: BIRTH, expectedCommand: "/bin/t --nonce-c4",
		childExited: () => false, deps,
		onLog: () => { swapped = true; }, // 日志（观察前）改变后续观察所见身份
	});
	assert.equal(signals.length, 0, `身份被日志改变后不得信号: ${JSON.stringify(signals)}`);
	assert.equal(out.signaled, false);
});

test("R45-C5：validate 结果 onLog 抛错 → reject 且预挂 timer 全清（:544/:568 泄漏门）", async () => {
	const cleared: unknown[] = [];
	const deps: RunnerDeps = {
		now: () => 1_000_000,
		sleep: async () => {},
		signal: () => {},
		setTimeoutImpl: (fn) => fn,
		clearTimeoutImpl: (h) => { cleared.push(h); },
		spawnImpl: (() => {
			const c = new EventEmitter();
			(c as unknown as { pid: number }).pid = 4405;
			setTimeout(() => { c.emit("exit", 0, null); c.emit("close", 0, null); }, 10);
			return c as never;
		}) as never,
		procInfo: (pid) => (pid === 4405
			? { pgid: 4405, ppid: process.pid, birth: BIRTH, command: "/bin/t --nonce-c5" }
			: { pgid: pid + 50_000, ppid: 1, birth: BIRTH, command: `pid-${pid}` }),
	};
	await assert.rejects(
		runBounded({
			command: ["/bin/t", "--nonce-c5"],
			timeoutMs: 5_000, stdio: "ignore", deps,
			onLog: (msg) => { if (msg.includes("进程组安全验证成功")) throw new Error("validate log IO failed"); },
		}),
		/validate log IO failed/,
	);
	assert.equal(cleared.length, 2, `validate 后日志抛错必须仍清全部预挂 timer: ${cleared.length}`);
});

test("R45-C6：target 到点 onLog 抛错 → reject 且预挂 timer 全清（第二处裸 onLog 门）", async () => {
	const cleared: unknown[] = [];
	const deps: RunnerDeps = {
		now: () => 1_000_000,
		sleep: async () => {},
		signal: () => {},
		setTimeoutImpl: (fn) => { setTimeout(fn, 20); return fn; },
		clearTimeoutImpl: (h) => { cleared.push(h); },
		spawnImpl: (() => {
			const c = new EventEmitter();
			(c as unknown as { pid: number }).pid = 4406; // hang
			return c as never;
		}) as never,
		procInfo: () => ({ pgid: 4406, ppid: process.pid, birth: BIRTH, command: "/bin/t --nonce-c6" }),
	};
	await assert.rejects(
		runBounded({
			command: ["/bin/t", "--nonce-c6"],
			timeoutMs: 200, graceMs: 20, stdio: "ignore", deps,
			onLog: (msg) => { if (msg.includes("target deadline 到点")) throw new Error("deadline log IO failed"); },
		}),
		/deadline log IO failed/,
	);
	assert.equal(cleared.length, 2, `到点日志抛错必须仍清全部预挂 timer: ${cleared.length}`);
});

// ── genuine exit/close / finalizeIO / snapshot 已知值（B10/B11 改进）────

test("R45-C7：genuine exit/close → exitCode 透传 7 + finalizeIO snapshot 已知值 + 全清 timer", async () => {
	// R47 改写：runner 等待已改 deps.sleep 驱动（可全 fake）——child 事件经同一假钟调度，
	// 不再用真实 setTimeout 协调（R-Q45-6：all-timers-fake 口径）。
	const cleared: unknown[] = [];
	const signals: { target: number; sig: string }[] = [];
	let t = 1_000_000;
	const pending: { at: number; fn: () => void }[] = [];
	const childRef = new EventEmitter();
	(childRef as unknown as { pid: number }).pid = 4607;
	const advance = async (ms: number): Promise<void> => {
		const target = t + ms;
		for (;;) {
			t = target;
			const due = pending.filter((p) => p.at <= t).sort((a, b) => a.at - b.at);
			if (due.length === 0) break;
			for (const p of due) { pending.splice(pending.indexOf(p), 1); p.fn(); }
			if (pending.length === 0) break;
			const nextAt = Math.min(...pending.map((p) => p.at));
			if (nextAt > t) break;
		}
	};
	const deps: RunnerDeps = {
		now: () => t,
		sleep: async (ms) => { await advance(ms); },
		signal: (target, sig) => { signals.push({ target, sig: String(sig) }); },
		setTimeoutImpl: (fn, ms) => { pending.push({ at: t + Math.max(0, ms), fn }); return fn; },
		clearTimeoutImpl: (h) => { cleared.push(h); },
		spawnImpl: (() => {
			pending.push({ at: t + 10, fn: () => { childRef.emit("exit", 7, null); childRef.emit("close", 7, null); } });
			return childRef as never;
		}) as never,
		procInfo: () => ({ pgid: 4607, ppid: process.pid, birth: "Mon Oct 19 04:00:00 2026", command: "/bin/t --r45-c7" }),
	};
	let snapshot: RunBoundedResult | null = null;
	const res = await runBounded({
		command: ["/bin/t", "--r45-c7"],
		timeoutMs: 5_000, stdio: "ignore", deps,
		finalizeIO: (snap) => { snapshot = snap as unknown as RunBoundedResult; },
	});
	assert.equal(res.exitCode, 7, "genuine close 透传非零退出码");
	assert.equal(res.settlement, "natural_exit");
	assert.equal(res.targetExitProven, true);
	assert.equal(signals.length, 0);
	assert.ok(snapshot, "finalizeIO 必须被调用");
	assert.equal((snapshot as unknown as RunBoundedResult).exitCode, 7, "snapshot 已知非零不得填 0");
	assert.match((snapshot as unknown as RunBoundedResult).runnerWallKind, /pre_final_io/);
	assert.equal(cleared.length, 2);
});

test("R45-C8：unproven 路径 snapshot/结果已知 124 + residue unknown（真模拟 hang，无真实资源）", async () => {
	const deps: RunnerDeps = {
		now: () => 1_000_000,
		sleep: async () => {},
		signal: () => {},
		setTimeoutImpl: (fn) => { setTimeout(fn, 20); return fn; },
		clearTimeoutImpl: () => {},
		spawnImpl: (() => {
			const c = new EventEmitter();
			(c as unknown as { pid: number }).pid = 4408; // hang：永不退出
			return c as never;
		}) as never,
		procInfo: () => null, // 观察全失败 → unknown
	};
	let snapshot: RunBoundedResult | null = null;
	const res = await runBounded({
		command: ["/bin/t", "--nonce-c8"],
		timeoutMs: 200, graceMs: 20, stdio: "ignore", deps,
		finalizeIO: (s) => { snapshot = s as unknown as RunBoundedResult; },
	});
	assert.equal(res.exitCode, 124);
	assert.equal(res.settlement, "unproven_unknown");
	assert.equal(res.groupResidue, "unknown");
	assert.equal((snapshot as unknown as RunBoundedResult).exitCode, 124, "unproven snapshot 已知 124");
});

// ── 零 observe 对照（真实计数 + budget>0 对照触发观察）──────────

test("R45-C9：validateProcessGroup budget>0 必触发观察（真实计数对照），budget=0 零观察", () => {
	const pos = fakeDeps({ pgid: 4409, command: "/bin/t --x" });
	// runner/parent 的 pgid 必须与 child 不同（否则共享组 fail-closed），且可观察
	pos.deps.procInfo = (pid, budget) => {
		pos.psCalls.push({ pid, budget });
		return pid === 4409
			? { pgid: 4409, ppid: process.pid, birth: BIRTH, command: "/bin/t --x" }
			: { pgid: pid + 50_000, ppid: 1, birth: BIRTH, command: `pid-${pid}` };
	};
	const v1 = validateProcessGroup(4409, 5_000, "/bin/t --x", pos.deps);
	assert.equal(v1.safe, true, `budget>0 且身份全符 → safe: ${v1.reason}`);
	assert.ok(pos.psCalls.length >= 3, `budget>0 必须有真实观察（实际 ${pos.psCalls.length} 次）`);
	const zero = fakeDeps({ pgid: 4410, command: "/bin/t --x" });
	let zeroCalls = 0;
	zero.deps.procInfo = () => { zeroCalls++; return null; };
	const v2 = validateProcessGroup(4410, 0, "/bin/t --x", zero.deps);
	assert.equal(v2.safe, false);
	assert.equal(zeroCalls, 0, "零预算必须零注入观察");
});

after(() => { clearTimeout(watchdog); });
