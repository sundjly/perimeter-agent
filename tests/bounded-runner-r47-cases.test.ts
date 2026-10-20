import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, test } from "node:test";
import {
	cleanupProcessGroup,
	runBounded,
	validateProcessGroup,
	type CleanupOptions,
	type RunnerDeps,
	type RunBoundedResult,
} from "../scripts/bounded-test-runner.ts";

// R47 runner 因果测试（R-Q45-1…4 + R-Q45-6 断言强度）：全 fake 同锚假钟。
// - 无真实 spawn/ps/signal/socket/HTTP/worker（静态确认 imports：assert/node:events/
//   node:test/被审 runner 函数——runner 模块 import 无副作用，spawn 仅缺省 deps 路径使用，
//   本文件全注入不触达）；被审代码内已无不可注入 setInterval（R47 改 deps.sleep 有界循环）。
// - 假钟调度器：setTimeout/clear/sleep/child 事件全部同锚假钟；dispatch 回调 throw 记入
//   escapes（不冒进 await 调用栈）。
// - 唯一 root 真实 9s 失败 watchdog 在 mock 前预挂；正常结尾 fresh real elapsed 断言
//   （红必须真实非零，不先清 watchdog 假成功）。
const REAL_START = performance.now();
const watchdog = setTimeout(() => {
	console.error("R47-WATCHDOG: 根自寿命超 9s，强制非零退出（pipeline 停）");
	process.exit(124);
}, 9_000);

const BIRTH = "Mon Oct 19 04:00:00 2026";
const VAL = "r47" + "RunnerCase7b2d"; // 18 字符类内值

/** 全 fake 同锚假钟 + 假 child 事件调度（回调逃逸记录，不冒泡） */
class FakeClock {
	t = 1_000_000;
	private seq = 0;
	private timers = new Map<number, { at: number; fn: () => void }>();
	escapes: string[] = [];
	clearCalls: unknown[] = [];
	setTimeoutImpl = (fn: () => void, ms: number): unknown => {
		const id = ++this.seq;
		this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
		return id;
	};
	clearTimeoutImpl = (h: unknown): void => {
		this.clearCalls.push(h);
		this.timers.delete(h as number);
	};
	sleep = async (ms: number): Promise<void> => { await this.advance(ms); };
	/** 推钟到 t+ms，途中按到期序 dispatch（含注入的 child 事件）；回调 throw 记逃逸 */
	advance = async (ms: number): Promise<void> => {
		const target = this.t + Math.max(0, ms);
		for (;;) {
			this.t = target;
			const due = [...this.timers.entries()].filter(([, v]) => v.at <= this.t).sort((a, b) => a[1].at - b[1].at);
			if (due.length === 0) break;
			for (const [id, v] of due) {
				this.timers.delete(id);
				try { v.fn(); } catch (e) { this.escapes.push(String((e as Error)?.message ?? e)); }
			}
			if (this.timers.size === 0) break;
			const nextAt = Math.min(...[...this.timers.values()].map((v) => v.at));
			if (nextAt > this.t) break;
		}
	};
	/** 注入假事件（at=当前钟+delay） */
	schedule = (delayMs: number, fn: () => void): void => {
		this.setTimeoutImpl(fn, delayMs);
	};
	/** 被审 runBounded 用的 prelude 前 watcher 无需——watchdog 是真实钟 root 级 */
}

interface Sig { target: number; sig: string }

function makeEnv(opts: {
	pid: number;
	command: string;
	consumePerObs?: number;
	hang?: boolean;
	exitCode?: number;
	/** procInfo 对非 child pid（runner/parent）返回的 pgid 偏移，默认 +50_000（非共享组） */
	observerIgnoresBudget?: boolean;
}) {
	const clock = new FakeClock();
	const signals: Sig[] = [];
	const psCalls: { pid: number; budget: number }[] = [];
	const onLogCalls: string[] = [];
	let call = 0;
	const deps: RunnerDeps = {
		now: () => clock.t,
		sleep: clock.sleep,
		signal: (target, sig) => { signals.push({ target, sig: String(sig) }); },
		setTimeoutImpl: clock.setTimeoutImpl,
		clearTimeoutImpl: clock.clearTimeoutImpl,
		spawnImpl: (() => {
			const c = new EventEmitter();
			(c as unknown as { pid: number }).pid = opts.pid;
			if (!opts.hang) {
				const code = opts.exitCode ?? 0;
				clock.schedule(10, () => { c.emit("exit", code, null); c.emit("close", code, null); });
			}
			return c as never;
		}) as never,
		procInfo: (pid, budget) => {
			call++;
			psCalls.push({ pid, budget });
			const use = opts.observerIgnoresBudget ? (opts.consumePerObs ?? 0) : Math.min(opts.consumePerObs ?? 0, budget);
			clock.t += use;
			if (pid !== opts.pid) {
				return { pgid: pid + 50_000, ppid: 1, birth: BIRTH, command: `pid-${pid}` };
			}
			return { pgid: opts.pid, ppid: process.pid, birth: BIRTH, command: opts.command };
		},
	};
	const onLogCounter = { n: 0 };
	const countingLog = (msg: string): void => { onLogCalls.push(msg); onLogCounter.n++; };
	const childRef = new EventEmitter();
	(childRef as unknown as { pid: number }).pid = opts.pid;
	// spawnImpl 的 fake child 统一为 childRef（事件经 clock.schedule 假钟 dispatch）
	const spawnImpl = ((() => {
		if (!opts.hang) {
			const code = opts.exitCode ?? 0;
			clock.schedule(10, () => { childRef.emit("exit", code, null); childRef.emit("close", code, null); });
		}
		return childRef as never;
	}) as never);
	deps.spawnImpl = spawnImpl;
	return { clock, deps, signals, psCalls, cleared: clock.clearCalls, escapes: clock.escapes, onLogCalls, onLogCounter, countingLog, calls: () => call, child: childRef as unknown as EventEmitter };
}

// ── R-Q45-1：零窗/绝对预算/无 interval ─────────────────────

test("R47-1：postValidate 预算尽 → 零处置/零等待/零 signal/零后续 ps，显式 unknown 124", async () => {
	const env = makeEnv({ pid: 4601, command: "/bin/t --r47-1", hang: true, consumePerObs: 500 });
	const res = await runBounded({
		command: ["/bin/t", "--r47-1"],
		timeoutMs: 400, graceMs: 100, stdio: "ignore", deps: env.deps,
		onLog: env.countingLog,
	});
	assert.equal(res.exitCode, 124);
	assert.equal(res.settlement, "unproven_unknown");
	assert.equal(res.targetExitProven, false);
	assert.equal(res.groupResidue, "unknown");
	assert.deepEqual(env.signals, [], "预算尽后零 signal");
	const callsAfterValidate = env.psCalls.length;
	assert.ok(callsAfterValidate <= 3, `观察次数受核验约束: ${env.psCalls.length}`);
	const tAfter = env.clock.t;
	await env.clock.advance(1_000); // 事后任意推钟：不得再有决策/信号
	assert.equal(env.signals.length, 0);
	assert.equal(env.clock.t - tAfter >= 1_000, true, "零窗无隐藏等待 tick");
});

test("R47-2：cleanup absoluteDeadline 同锚（调用前已耗 → 零信号零观察）与 budget 取更严", async () => {
	const env = makeEnv({ pid: 4602, command: "/bin/t --r47-2" });
	const opts: CleanupOptions = {
		childPid: 4602, childPgid: 4602, isSafeGroup: true,
		graceMs: 100, budgetMs: 5_000,
		absoluteDeadline: env.clock.t - 1, // 调用前已耗
		expectedBirth: BIRTH, expectedCommand: "/bin/t --r47-2",
		childExited: () => false, deps: env.deps,
	};
	const out = await cleanupProcessGroup(opts);
	assert.deepEqual(env.signals, [], "absolute 预算已耗必须零信号");
	assert.equal(out.signaled, false);
	assert.equal(out.residue, "unknown");
	assert.equal(env.psCalls.length, 0, "调用前已耗必须零观察");
	// 对照：预算充足 → 正常观察（budget 与 absolute 取更严，非零窗时可观察）
	const env2 = makeEnv({ pid: 4603, command: "/bin/t --r47-2b" });
	const out2 = await cleanupProcessGroup({
		childPid: 4603, childPgid: 4603, isSafeGroup: true,
		graceMs: 20, budgetMs: 5_000,
		absoluteDeadline: env2.clock.t + 5_000,
		expectedBirth: BIRTH, expectedCommand: "/bin/t --r47-2b",
		childExited: () => false, deps: env2.deps,
	});
	assert.ok(env2.psCalls.length >= 2, `非零窗应有观察（TERM核验+KILL核验）: ${env2.psCalls.length}`);
	assert.ok(env2.signals.some((s) => s.sig.includes("SIGTERM")));
	assert.ok(env2.signals.some((s) => s.sig.includes("SIGKILL")));
	assert.equal(out2.signaled, true);
});

// ── R-Q45-2：snapshot 已知 overBudget 先取 124（child0 不掩超限）──────

test("R47-3：child exit 0 + 前序 IO 推钟过原 deadline → snapshot 与终值均 124（child 0 不掩超限）", async () => {
	const env = makeEnv({ pid: 4604, command: "/bin/t --r47-3", exitCode: 0 });
	let snapshot: RunBoundedResult | null = null;
	const res = await runBounded({
		command: ["/bin/t", "--r47-3"],
		timeoutMs: 300, stdio: "ignore", deps: env.deps,
		onLog: (msg) => { if (msg.includes("执行完毕")) env.clock.advance(2_600); }, // finalizeIO 之前的 IO 推钟越限
		finalizeIO: (s) => { snapshot = s as unknown as RunBoundedResult; },
	});
	assert.equal(res.actualExitCode, 0, "真实 exit 0 保留");
	assert.equal(res.overBudget, true);
	assert.equal(res.exitCode, 124, "已知超限不得被 child 0 掩盖（终值 sticky）");
	assert.equal((snapshot as unknown as RunBoundedResult).exitCode, 124, "构造 snapshot 时已超限 → snapshot 已知 124（child 0 不掩）");
	assert.equal((snapshot as unknown as RunBoundedResult).overBudget, true);
	assert.ok(res.runnerWallMs >= 2_500, "最终 wall 在全部 IO 后采样");
});

test("R47-3b：finalizeIO snapshot 在已知超限时即为 124（pre_final_io 与终值一致）", async () => {
	const env = makeEnv({ pid: 4605, command: "/bin/t --r47-3b", hang: true });
	let snapshot: RunBoundedResult | null = null;
	const res = await runBounded({
		command: ["/bin/t", "--r47-3b"],
		timeoutMs: 200, graceMs: 20, stdio: "ignore", deps: env.deps,
		finalizeIO: (s) => { snapshot = s as unknown as RunBoundedResult; },
	});
	assert.equal(res.exitCode, 124);
	assert.equal((snapshot as unknown as RunBoundedResult).exitCode, 124, "unproven/超限 snapshot 已知 124");
});

// ── R-Q45-3 + R-Q45-4：sticky failure 停后续 IO / 回调 contain / timer arm/clear ──

test("R47-4：cleanup 内日志抛错 → sticky 停止后续全部 fallible IO（onLog/finalizeIO 计数 0）+ reject + timer 清", async () => {
	const env = makeEnv({ pid: 4606, command: "/bin/t --r47-4", hang: true });
	let finalizeCalls = 0;
	await assert.rejects(
		runBounded({
			command: ["/bin/t", "--r47-4"],
			timeoutMs: 150, graceMs: 20, stdio: "ignore", deps: env.deps,
			onLog: (msg) => { if (msg.includes("cleanup 开始")) throw new Error("cleanup logger boom"); env.countingLog(msg); },
			finalizeIO: () => { finalizeCalls++; },
		}),
		/cleanup logger boom/,
	);
	assert.equal(finalizeCalls, 0, "sticky 失败后 finalizeIO 必须跳过");
	assert.equal(env.onLogCalls.filter((m) => m.includes("执行完毕")).length, 0, "sticky 失败后执行完毕日志必须跳过");
	assert.equal(env.cleared.length, 2, "两个预挂 timer 都被清");
	assert.deepEqual(env.escapes, [], "无回调逃逸");
});

test("R47-5：child error 回调内 onLog 抛错 → contain（无逃逸冒泡）+ sticky 非零 reject + 双 timer 清", async () => {
	const env = makeEnv({ pid: 4607, command: "/bin/t --r47-5", hang: true });
	// 模拟真实 error 事件（如 ENOENT/error 路径）经假调度 dispatch，回调内 onLog 抛
	const deps = env.deps;
	const origSpawn = deps.spawnImpl!;
	type SpawnFn = NonNullable<RunnerDeps["spawnImpl"]>;
	deps.spawnImpl = ((...callArgs: unknown[]) => {
		const c = (origSpawn as unknown as (...a: unknown[]) => unknown)(...callArgs) as EventEmitter;
		env.clock.schedule(10, () => { c.emit("error", new Error("fake-enoent")); });
		return c as never;
	}) as never;
	await assert.rejects(
		runBounded({
			command: ["/bin/t", "--r47-5"],
			timeoutMs: 200, stdio: "ignore", deps,
			onLog: (msg) => { if (msg.includes("子进程异常")) throw new Error("error-cb log boom"); },
		}),
		/error-cb log boom/,
	);
	assert.deepEqual(env.escapes, [], "回调异常必须被 contain，不得逃逸");
	assert.equal(env.cleared.length, 2, "双 timer 清");
});

test("R47-6：第 2 arm 抛 → 清第 1 并 reject；clear 第 1 抛 → 仍独立尝试清第 2 且 sticky", async () => {
	{ // 第 2 arm 抛
		const cleared: unknown[] = [];
		const env = makeEnv({ pid: 4608, command: "/bin/t --r47-6a", exitCode: 0 });
		let armCount = 0;
		env.deps.setTimeoutImpl = (fn, ms) => {
			armCount++;
			if (armCount === 2) throw new Error("arm2 boom");
			return env.clock.setTimeoutImpl(fn, ms);
		};
		env.deps.clearTimeoutImpl = (h) => { cleared.push(h); };
		await assert.rejects(
			runBounded({ command: ["/bin/t", "--r47-6a"], timeoutMs: 5_000, stdio: "ignore", deps: env.deps }),
			/arm2 boom/,
		);
		assert.equal(cleared.length, 1, "第 2 arm 抛必须清第 1 个已 arm timer");
	}
	{ // clear 第 1 抛 → 仍独立清第 2 + sticky 非零
		const cleared: unknown[] = [];
		const env = makeEnv({ pid: 4609, command: "/bin/t --r47-6b", exitCode: 0 });
		let clearCount = 0;
		env.deps.clearTimeoutImpl = (h) => {
			clearCount++;
			cleared.push(h);
			if (clearCount === 1) throw new Error("clear1 boom");
		};
		await assert.rejects(
			runBounded({ command: ["/bin/t", "--r47-6b"], timeoutMs: 5_000, stdio: "ignore", deps: env.deps }),
			/clear1 boom/,
		);
		assert.equal(cleared.length, 2, "clear 第 1 抛仍必须独立尝试清第 2");
	}
});

// ── 扳机纪律：日志正常 return，但推钟/改身份/模拟 exit 后不得旧证发枪 ──

test("R47-7：TERM/KILL 意图日志推进钟耗尽预算 → 零过期枪（正常 return 非 throw）", async () => {
	{ // group TERM
		const env = makeEnv({ pid: 4610, command: "/bin/t --r47-7a", hang: true });
		const out = await cleanupProcessGroup({
			childPid: 4610, childPgid: 4610, isSafeGroup: true,
			graceMs: 50, budgetMs: 300,
			expectedBirth: BIRTH, expectedCommand: "/bin/t --r47-7a",
			childExited: () => false, deps: env.deps,
			onLog: () => { env.clock.t += 400; },
		});
		assert.deepEqual(env.signals, [], `意图日志耗尽预算后零枪: ${JSON.stringify(env.signals)}`);
		assert.equal(out.signaled, false);
	}
	{ // direct KILL（先 TERM 预算内，KILL 前日志推钟耗尽）
		const env = makeEnv({ pid: 4611, command: "/bin/t --r47-7b" });
		const out = await cleanupProcessGroup({
			childPid: 4611, childPgid: null, isSafeGroup: false,
			graceMs: 40, budgetMs: 5_000,
			expectedBirth: BIRTH, expectedCommand: "/bin/t --r47-7b",
			childExited: () => false, deps: env.deps,
			onLog: (msg) => { if (msg.includes("KILL 前 fresh")) env.clock.t += 10_000; },
		});
		assert.deepEqual(env.signals.filter((s) => s.sig.includes("KILL")), [], "KILL 意图日志耗尽预算 → 零 KILL");
		assert.equal(out.signaled, true, "TERM 已在预算内正证发出");
	}
});

test("R47-8：日志后改身份 / 模拟 exit → 零过期枪（group 与 direct）", async () => {
	{ // group：日志后身份改变
		const env = makeEnv({ pid: 4612, command: "/bin/t --r47-8a" });
		let swapped = false;
		const deps = env.deps;
		const orig = deps.procInfo;
		deps.procInfo = (pid, b) => {
			if (swapped && pid === 4612) return { pgid: 4612, ppid: process.pid, birth: BIRTH, command: "/bin/evil --pwn" };
			return orig!(pid, b);
		};
		const out = await cleanupProcessGroup({
			childPid: 4612, childPgid: 4612, isSafeGroup: true,
			graceMs: 20, budgetMs: 5_000,
			expectedBirth: BIRTH, expectedCommand: "/bin/t --r47-8a",
			childExited: () => false, deps,
			onLog: () => { swapped = true; },
		});
		assert.deepEqual(env.signals, [], `日志后身份改变零枪: ${JSON.stringify(env.signals)}`);
		assert.equal(out.signaled, false);
	}
	{ // direct：日志后模拟 exit
		const env = makeEnv({ pid: 4613, command: "/bin/t --r47-8b" });
		let exited = false;
		const out = await cleanupProcessGroup({
			childPid: 4613, childPgid: null, isSafeGroup: false,
			graceMs: 30, budgetMs: 5_000,
			expectedBirth: BIRTH, expectedCommand: "/bin/t --r47-8b",
			childExited: () => exited, deps: env.deps,
			onLog: () => { exited = true; },
		});
		assert.deepEqual(env.signals, [], `exit 已证零枪: ${JSON.stringify(env.signals)}`);
		assert.equal(out.signaled, false);
	}
});

// ── 正控：原 TOTAL 内 TERM→grace→freshKILL→模拟 close（setup marker 确证到达）────

test("R47-9：正控——TOTAL 内完成 TERM→grace→freshKILL→模拟 close，killed_after_verified", async () => {
	const signals: Sig[] = [];
	let t = 1_000_000;
	const pending: { at: number; fn: () => void }[] = [];
	const childRef = new EventEmitter();
	(childRef as unknown as { pid: number }).pid = 4614;
	const clockLikeAdvance = async (ms: number): Promise<void> => {
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
		sleep: async (ms) => { await clockLikeAdvance(ms); },
		signal: (target, sig) => {
			signals.push({ target, sig: String(sig) });
			if (String(sig).includes("KILL")) {
				// 模拟：SIGKILL 投递后 child 真实消亡（exit+close 经假钟调度到达）
				pending.push({ at: t + 5, fn: () => { childRef.emit("exit", null, "SIGKILL"); childRef.emit("close", null, "SIGKILL"); } });
			}
		},
		setTimeoutImpl: (fn, ms) => { pending.push({ at: t + Math.max(0, ms), fn }); return fn; },
		clearTimeoutImpl: () => {},
		spawnImpl: (() => childRef) as never,
		procInfo: (pid) => (pid === 4614
			? { pgid: 4614, ppid: process.pid, birth: BIRTH, command: "/bin/t --r47-9" }
			: { pgid: pid + 50_000, ppid: 1, birth: BIRTH, command: `pid-${pid}` }),
	};
	const res = await runBounded({
		command: ["/bin/t", "--r47-9"],
		timeoutMs: 4_000, graceMs: 300, stdio: "ignore", deps,
	});
	assert.equal(signals.filter((s) => s.sig === "SIGTERM").length, 1, "恰好一次组 TERM");
	assert.equal(signals.filter((s) => s.sig === "SIGKILL").length, 1, "恰好一次组 KILL（fresh 核验后）");
	assert.equal(res.exitCode, 124);
	assert.equal(res.settlement, "killed_after_verified");
	assert.equal(res.targetExitProven, true, "模拟 close 后真实结算");
	assert.ok(res.closeWallMs !== null, "close 已证");
	assert.ok(res.runnerWallMs <= 4_000, `全程在原 TOTAL 内: ${res.runnerWallMs}`);
});

// ── 预算/观察计数对照 + observer 预算尊重 ────────────────────

test("R47-10：budget=0 零观察零信号（真实计数），budget>0 对照触发观察", async () => {
	const zero = makeEnv({ pid: 4615, command: "/bin/t --x" });
	const out0 = await cleanupProcessGroup({
		childPid: 4615, childPgid: 4615, isSafeGroup: true,
		graceMs: 20, budgetMs: 0,
		expectedBirth: BIRTH, expectedCommand: "/bin/t --x",
		childExited: () => false, deps: zero.deps,
	});
	assert.equal(zero.psCalls.length, 0, "零预算零观察（真实计数）");
	assert.equal(zero.signals.length, 0);
	assert.equal(out0.signaled, false);
	const pos = makeEnv({ pid: 4616, command: "/bin/t --x" });
	await cleanupProcessGroup({
		childPid: 4616, childPgid: 4616, isSafeGroup: true,
		graceMs: 20, budgetMs: 5_000,
		expectedBirth: BIRTH, expectedCommand: "/bin/t --x",
		childExited: () => false, deps: pos.deps,
	});
	assert.ok(pos.psCalls.length >= 2, `正预算对照必须触发观察: ${pos.psCalls.length}`);
});

test("R47-11：observer 尊重传入 budget（每次 ≤ min(cap,剩余)）；坏依赖越窗 → 后续决策零", async () => {
	const good = makeEnv({ pid: 4617, command: "/bin/t --r47-11a", consumePerObs: 60 });
	await cleanupProcessGroup({
		childPid: 4617, childPgid: 4617, isSafeGroup: true,
		graceMs: 30, budgetMs: 200,
		expectedBirth: BIRTH, expectedCommand: "/bin/t --r47-11a",
		childExited: () => false, deps: good.deps,
	});
	for (const c of good.psCalls) assert.ok(c.budget > 0 && c.budget <= 200, `观察预算必须 ∈ (0,200]: ${JSON.stringify(good.psCalls)}`);
	// 坏依赖：无视 budget 每次耗 500 → 后续决策零（KILL 前预算尽 → 零 KILL）
	const bad = makeEnv({ pid: 4618, command: "/bin/t --r47-11b", consumePerObs: 500, observerIgnoresBudget: true });
	const out = await cleanupProcessGroup({
		childPid: 4618, childPgid: 4618, isSafeGroup: true,
		graceMs: 30, budgetMs: 200,
		expectedBirth: BIRTH, expectedCommand: "/bin/t --r47-11b",
		childExited: () => false, deps: bad.deps,
	});
	assert.deepEqual(bad.signals.filter((s) => s.sig.includes("KILL")), [], "坏依赖耗尽预算后 KILL 决策必须为零");
	assert.equal(out.residue, "unknown");
});

test("R47-12（R-Q47-A）：TERM 已发 → grace await 期间 contain 失败置位 → 停链（0 后续 ps/log/KILL），不伪 exit", async () => {
	const env = makeEnv({ pid: 4619, command: "/bin/t --r47-12", hang: true });
	// shared failure 谓词：grace 期间 fake child.error 被 contain 置位（经 runBounded 回调路径）
	const deps = env.deps;
	// R-Q52-8 计数门（R55-G 修正）：三段计数——TERM 前（preTerm）/ TERM 后失败派发前
	// grace 首轮（gracePreContain，真 TERM 后门）/ contain 置位后（postContain）。
	let containArmed = false; // “子进程异常”日志抛错=contain 链已走 → failure 置位
	let termSeen = false;
	let preTermObs = 0;
	let gracePreContainObs = 0;
	let postContainObs = 0;
	const origProc = deps.procInfo;
	deps.procInfo = (pid, b) => {
		if (containArmed) postContainObs++;
		else if (termSeen) gracePreContainObs++;
		else preTermObs++;
		return origProc!(pid, b);
	};
	let snapshot: RunBoundedResult | null = null;
	let logCallsAfterContain = 0;
	const pending = runBounded({
		command: ["/bin/t", "--r47-12"],
		timeoutMs: 4_000, graceMs: 400, stdio: "ignore", deps,
		onLog: (msg) => {
			if (containArmed) logCallsAfterContain++; // 置位后任何日志都是后续 fallible IO（R50 收紧：必须 0）
			if (msg.includes("SIGTERM 已发")) {
				termSeen = true;
				// 模拟 grace await 期间真实事件失败：child error 事件（假钟 dispatch）
				// → runner contain 回调 → onLog 抛错 → shared failure 置位（真实 contain 链）
				env.clock.schedule(0, () => { env.child.emit("error", new Error("grace-period-error")); });
			}
			if (msg.includes("子进程异常")) { containArmed = true; throw new Error("error-cb log boom"); }
		},
		finalizeIO: (s2) => { snapshot = s2 as unknown as RunBoundedResult; },
	});
	// R-Q47-A 契约：sticky failure → 停止余下 fallible IO（finalizeIO 跳过）→ 非零 reject
	await assert.rejects(pending, /error-cb log boom/);
	assert.equal(snapshot, null, "sticky 失败后 finalizeIO 必须跳过");
	// 停链断言：TERM 后零 KILL；置位后日志/观察全 0
	assert.deepEqual(env.signals.filter((s) => s.sig.includes("KILL")), [], "grace 期 contain 失败必须停链（零 KILL）");
	assert.equal(env.signals.filter((s) => s.sig.includes("TERM")).length, 1, "TERM 恰一次（预算内正证）");
	assert.ok(gracePreContainObs >= 1, "TERM 后失败派发前 grace 首轮合法观察发生过（真 TERM 后门，非 TERM 前计数）");
	assert.ok(preTermObs >= 1, "TERM 前核验 ps 发生过（正证，不是全程零 ps 的假安全）");
	assert.equal(logCallsAfterContain, 0, `置位后必须零日志（实际 ${logCallsAfterContain}）`);
	assert.equal(postContainObs, 0, `contain 置位后观察必须停链（实际 ${postContainObs}）`);
	assert.deepEqual(env.escapes, [], "回调异常被 contain 记录路径处理，无假钟逃逸");
	assert.equal(env.cleared.length, 2, "双 timer 独立清（finally）");
});

after(() => {
	// 正常结尾 fresh real elapsed 断言（不先清 watchdog 假成功；红必须真实非零）
	const elapsed = performance.now() - REAL_START;
	assert.ok(elapsed < 9_000, `根自寿命必须 <9s（实际 ${Math.round(elapsed)}ms）`);
	clearTimeout(watchdog);
});
