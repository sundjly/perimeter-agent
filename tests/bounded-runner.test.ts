import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { test } from "node:test";
import {
	cleanupProcessGroup,
	getProcInfo,
	isPidAlive,
	runBounded,
	validateProcessGroup,
	type RunnerDeps,
	type RunBoundedResult,
} from "../scripts/bounded-test-runner.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 测试自清理（自身登记的进程；不依赖 runner、不做全局扫描） */
function killRegistered(pid: number | undefined): void {
	if (!pid) return;
	try { process.kill(pid, "SIGKILL"); } catch { /* 已死 */ }
	try { process.kill(-pid, "SIGKILL"); } catch { /* 非组长或已死 */ }
}

// ── 纯 fake 基建（信号只记录不投递、ps 经缝、无真实 child） ──────────

const FAKE_BIRTH = "Mon Oct 18 23:58:00 2026";
interface RecordedSignal { target: number; sig: string }

function fakeChild(pid: number): ChildProcess {
	const child = new EventEmitter() as unknown as ChildProcess;
	(child as unknown as { pid: number }).pid = pid;
	return child;
}

function makeFakeDeps(opts: {
	pgid: number;
	command: string;
	birth?: string;
	/** 每次 procInfo 调用后推进 fake 钟（模拟观察耗时） */
	consumeMs?: number;
	/** procInfo 返回 null 的调用序号（1-based）；缺省=全部成功 */
	failFromCall?: number;
	/** 第 N 次起返回篡改 command */
	spoofCommandFromCall?: number;
	spoofedCommand?: string;
}) {
	const signals: RecordedSignal[] = [];
	const psCalls: { pid: number; budget: number }[] = [];
	let t = 1_000_000;
	let call = 0;
	const deps: RunnerDeps = {
		now: () => t,
		sleep: async () => { t += 25; },
		signal: (target, sig) => { signals.push({ target, sig: String(sig) }); },
		setTimeoutImpl: (fn) => fn, // fake 钟：deadline timer 立即置位不靠真钟
		clearTimeoutImpl: () => {},
		procInfo: (pid, budget) => {
			call++;
			psCalls.push({ pid, budget });
			if (opts.consumeMs) t += opts.consumeMs;
			if (opts.failFromCall !== undefined && call >= opts.failFromCall) return null;
			if (opts.spoofCommandFromCall !== undefined && call >= opts.spoofCommandFromCall) {
				return { pgid: opts.pgid, ppid: process.pid, birth: opts.birth ?? FAKE_BIRTH, command: opts.spoofedCommand ?? "/bin/evil --pwn" };
			}
			return { pgid: opts.pgid, ppid: process.pid, birth: opts.birth ?? FAKE_BIRTH, command: opts.command };
		},
	};
	return { deps, signals, psCalls, clock: () => t };
}

// ── 真实 child 行为（短寿命 ≤10s；runBounded 内部持句柄真实 exit+close await） ──

test("bounded-runner: 正常退出码 0，进程组验证通过，direct-child 退出真实证明", async () => {
	const res = await runBounded({
		command: [process.execPath, "-e", "process.exit(0)"],
		timeoutMs: 5000,
		stdio: "pipe",
	});

	assert.equal(res.exitCode, 0);
	assert.equal(res.timedOut, false);
	assert.equal(res.actualExitCode, 0);
	assert.equal(res.groupVerified, true, "子进程必须为独立进程组组长");
	assert.equal(isPidAlive(res.childPid), false, "执行完毕后子进程必须已终结");
	assert.equal(res.groupResidue, "unknown", "R43：组成员零枚举 → residue 恒 unknown（绝不冒充 empty）");
});

test("bounded-runner: 正常退出码保留原 exitCode (如 42)", async () => {
	const res = await runBounded({
		command: [process.execPath, "-e", "process.exit(42)"],
		timeoutMs: 5000,
		stdio: "pipe",
	});

	assert.equal(res.exitCode, 42);
	assert.equal(res.timedOut, false);
	assert.equal(res.actualExitCode, 42);
});

test("bounded-runner: 真实触发短 deadline，hang 命令超时被终结并返回 124", async () => {
	const res = await runBounded({
		command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
		timeoutMs: 400,
		graceMs: 200,
		stdio: "pipe",
	});

	assert.equal(res.exitCode, 124, "超时必须严格遵循 GNU timeout 124 契约");
	assert.equal(res.timedOut, true);
	assert.equal(res.groupVerified, true);
	assert.equal(isPidAlive(res.childPid), false, "超时后子进程必须已被杀灭");
	assert.equal(res.groupResidue, "unknown", "组员无正证 → residue=unknown");
});

test("bounded-runner: 忽略 SIGTERM 的进程，在短 grace 窗口后被 SIGKILL 强行终结且真实 wait", async () => {
	const script = `
		process.on('SIGTERM', () => { /* 忽略 SIGTERM */ });
		process.stdout.write('READY\\n'); // ready marker：handler 安装完成（R48：TERM 不得早于 setup）
		setInterval(() => {}, 1000);
	`;
	// 例4 根因（S2b1-v2）：脚本写在 JS 模板字符串里，'READY\n' 的 \n 先被解释成真实换行，
	// node -e 收到跨行单引号字符串 → 子进程语法错误立即退出 → stdout 空（非时序竞态）；
	// 修：转义为 \\n。
	// TOTAL 保留 4000（不回 900）：R47 冻结 RESERVE=max(50, min(TOTAL-50, max(baseReserve,
	// graceMs+3000))) 下 TOTAL=900→target=50ms，与 node 启动同量级，TERM 仍可能先于
	// handler 安装（ready marker 竞态重现）；TOTAL=4000→target=700ms ≫ READY 写出
	// （~100ms），cleanup 预算≈3300ms 覆盖 ps 核验+grace300+KILL+close，测试前提确定。
	const res = await runBounded({
		command: [process.execPath, "-e", script],
		timeoutMs: 4000,
		graceMs: 300,
		stdio: "pipe",
	});
	// R48：ready marker 前置证据 + KILL 升级真实信号断言（setup 前提不再缺失）
	assert.match(res.stdout ?? "", /READY/, "handler 必须先于 TERM 安装（ready marker）");
	assert.equal(res.actualSignal, "SIGKILL", "忽略 TERM 的目标必须被 KILL 升级终结（真实信号）");

	assert.equal(res.exitCode, 124);
	assert.equal(res.timedOut, true);
	assert.equal(isPidAlive(res.childPid), false, "即使忽略 SIGTERM，后续 SIGKILL 也必须将其彻底杀死");
	assert.equal(res.targetExitProven, true, "KILL 后必须真实 wait 到退出事件");
});

test("bounded-runner: leader 已退出且无登记后代正证 → runner 绝不发组信号（residue=unknown，测试自清理）", async () => {
	// 旧契约「leader 退出后仍彻底清理孤儿」不安全：无同代正证的组级信号可误杀 PID/PGID 复用者。
	// 新契约：no-signal + group_residue_unknown；孤儿由本测试以自己登记的 PID 自清理。
	const script = `
		const { spawn } = require('node:child_process');
		const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},15000)'], { stdio: 'ignore' });
		process.stdout.write('G' + g.pid);
		setTimeout(() => process.exit(0), 150);
	`;
	const res = await runBounded({
		command: [process.execPath, "-e", script],
		timeoutMs: 5000,
		graceMs: 300,
		stdio: "pipe",
	});
	assert.equal(res.exitCode, 0, "主子进程自发退出 0");
	assert.equal(res.timedOut, false);
	// 关键断言：runner 对 leader 已退出的组不发信号 —— 孙进程在 runner 返回后仍存活
	const gpid = Number(/G(\d+)/.exec(res.stdout ?? "")?.[1]);
	assert.ok(gpid > 0, "必须取得孙进程 PID");
	assert.equal(isPidAlive(gpid), true, "leader 已退出无正证 → runner 不得组杀孙进程");
	assert.equal(res.groupResidue, "unknown", "未枚举成员 → 不得冒充 empty");
	// 测试自清理（自己登记的身份）
	killRegistered(gpid);
	await sleep(100);
	assert.equal(isPidAlive(gpid), false, "测试自清理必须完成，不得留 legacy 残留");
});

test("bounded-runner: 独立 Sentinel 保护与 runner 存活验证（绝不误杀外部无关进程与父组）", async () => {
	// 启动一个外部不相关的独立 sentinel 进程
	const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], {
		detached: true,
		stdio: "ignore",
	});
	const sentinelPid = sentinel.pid!;
	assert.ok(sentinelPid > 0);

	try {
		// runner 运行一个超时 hang 命令并执行进程组清理
		const res = await runBounded({
			command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
			timeoutMs: 400,
			graceMs: 200,
			stdio: "pipe",
		});

		assert.equal(res.exitCode, 124);
		assert.equal(isPidAlive(res.childPid), false, "runner 目标进程被清理");

		// 核心断言：外部独立 sentinel 进程依然完好存活！
		assert.equal(isPidAlive(sentinelPid), true, "外部 sentinel 进程绝不能被误杀");
	} finally {
		killRegistered(sentinelPid);
	}
});

test("bounded-runner: 进程组安全核验防御（fail-closed 机制验证）", () => {
	// 验证 validateProcessGroup 能够正确识别与 runner 共享 PGID 的非独立子进程
	const sharedChild = spawn(process.execPath, ["-e", "process.exit(0)"], {
		detached: false, // 故意不 detached，使子进程继承当前 runner 的 PGID
		stdio: "ignore",
	});

	const val = validateProcessGroup(sharedChild.pid!, 3_000, [process.execPath, "-e", "process.exit(0)"].join(" "));
	// 由于没有 detached，它的 PGID 等于 runner 的 PGID，必须被判定为 safe: false
	assert.equal(val.safe, false, "共享 PGID 的子进程必须判定为 safe=false (fail-closed)");
	assert.ok(
		/共享进程组|不是自身进程组组长|身份|command/.test(val.reason ?? ""),
		`必须给出明确 fail-closed 原因: ${val.reason}`,
	);
});

test("bounded-runner: CLI 模式执行不存在命令受控退出 (exit 1 + 明确原因，无 unhandled 崩溃栈)", async () => {
	const runnerScript = new URL("../scripts/bounded-test-runner.ts", import.meta.url).pathname;
	const child = spawn(process.execPath, [runnerScript, "non_existent_command_xyz_888"], {
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (d) => { stdout += d; });
	child.stderr.on("data", (d) => { stderr += d; });

	const code: number = await new Promise((r) => child.on("close", r));

	assert.equal(code, 1, "不存在的命令必须以受控 exit 1 退出");
	assert.ok(stderr.includes("non_existent_command_xyz_888") || stderr.includes("ENOENT") || stderr.includes("命令失败"), "必须输出明确错误原因");
	assert.ok(!stderr.includes("Unhandled 'error' event"), "绝不可出现 Unhandled 'error' event 崩溃栈");
	assert.ok(!stderr.includes("node:events:"), "绝不可因事件未监听打崩进程");
});

test("bounded-runner: 库调用模式捕获 ENOENT，后续事件循环正常运转且外部 sentinel 存活", async () => {
	const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], {
		detached: true,
		stdio: "ignore",
	});
	const sentinelPid = sentinel.pid!;

	try {
		let caughtCode = "";
		try {
			await runBounded({
				command: ["definitely_missing_binary_abc_999"],
				stdio: "ignore",
			});
		} catch (err: any) {
			caughtCode = err?.code ?? "";
		}

		assert.equal(caughtCode, "ENOENT", "库调用必须受控 reject 并保留 ENOENT 错误码");

		// 确保在 catch 之后，事件循环下一个 tick/宏任务仍能正常执行，未被隐匿 unhandled rejection 破坏
		let resumed = false;
		await new Promise<void>((resolve) => {
			setImmediate(() => {
				resumed = true;
				resolve();
			});
		});
		assert.equal(resumed, true, "事件循环在 catch 后必须健康继续运转");
		assert.equal(isPidAlive(sentinelPid), true, "外部 sentinel 必须不受影响存活");
	} finally {
		killRegistered(sentinelPid);
	}
});

test("bounded-runner: 重复快失败并发验证启动竞态 (多路 ENOENT 全部受控 reject)", async () => {
	const tasks = Array.from({ length: 5 }, (_, i) =>
		runBounded({
			command: [`missing_cmd_batch_${i}_${Date.now()}`],
			stdio: "ignore",
		})
	);

	const results = await Promise.allSettled(tasks);
	assert.equal(results.length, 5);
	for (const res of results) {
		assert.equal(res.status, "rejected", "所有并发快失败调用必须全部为 rejected");
		if (res.status === "rejected") {
			const err = res.reason;
			assert.equal(err?.code, "ENOENT", "错误必须为真实的 ENOENT");
		}
	}
});

// ── R41 负控（保留，签名适配 R43）──────────────

test("R41/R43负控：ps 观察失败=unknown；ps -g 组员枚举已删除（residue 恒 unknown）", () => {
	assert.equal(getProcInfo(999_999_999), null, "ps 失败必须返回 null(unknown)，不是空数组");
	// R43：getGroupPids/groupEmpty 已删除——组成员零枚举，empty 无证据通道（fake 绿测试证 residue 恒 unknown）
});

test("R41负控：expectedBirth 缺失 → 不判同代、不发组信号（子进程存活，测试自清理）", async () => {
	const cmd = [process.execPath, "-e", "setInterval(()=>{},10000)"];
	const c = spawn(cmd[0]!, cmd.slice(1), { detached: true, stdio: "ignore" });
	const pid = c.pid!;
	assert.ok(getProcInfo(pid)?.pgid === pid, "fixture 前置：必须为组长");
	try {
		const out = await cleanupProcessGroup({
			childPid: pid, childPgid: pid, isSafeGroup: true,
			graceMs: 100, budgetMs: 800, expectedBirth: null, expectedCommand: cmd.join(" "),
			childExited: () => false,
		});
		assert.equal(out.verification, "unverified_no_group_kill", `缺 birth 不得判同代：${out.verification}`);
		assert.equal(isPidAlive(pid), true, "缺 birth 不得发组信号");
		assert.equal(out.residue, "unknown");
	} finally {
		killRegistered(pid);
	}
});

test("R41负控：exit 已证不得凭重新枚举冒同代 → no-signal + residue unknown（测试自清理）", async () => {
	const leaderScript = `
		const { spawn } = require('node:child_process');
		const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},15000)'], { stdio: 'ignore' });
		process.stdout.write(String(g.pid));
		setTimeout(() => process.exit(0), 150);
	`;
	const leader = spawn(process.execPath, ["-e", leaderScript], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
	const gpidBuf: string[] = [];
	leader.stdout!.on("data", (d) => gpidBuf.push(String(d)));
	const leaderPid = leader.pid!;
	const cmd = [process.execPath, "-e", leaderScript].join(" ");
	const lb = getProcInfo(leaderPid);
	assert.ok(lb && lb.pgid === leaderPid);
	try {
		await once(leader, "exit");
		const out = await cleanupProcessGroup({
			childPid: leaderPid, childPgid: leaderPid, isSafeGroup: true,
			graceMs: 100, budgetMs: 800, expectedBirth: lb!.birth, expectedCommand: cmd,
			childExited: () => true,
		});
		assert.equal(out.verification, "unverified_no_group_kill", `leader 已退出不得凭重新枚举判同代：${out.verification}`);
		assert.equal(out.residue, "unknown");
		assert.equal(out.signaled, false, "exit 已证必须零信号");
		const gpid = Number(gpidBuf.join("").trim());
		assert.ok(gpid > 0);
		assert.equal(isPidAlive(gpid), true, "无登记后代正证 → 不杀");
		killRegistered(gpid);
		await sleep(100);
		assert.equal(isPidAlive(gpid), false, "测试自清理必须完成");
	} finally {
		killRegistered(leaderPid);
	}
});

test("R41负控：cleanup 预算 ≤0 → 零 spawn、零信号（子进程存活，测试自清理）", async () => {
	const cmd = [process.execPath, "-e", "setInterval(()=>{},10000)"];
	const c = spawn(cmd[0]!, cmd.slice(1), { detached: true, stdio: "ignore" });
	const pid = c.pid!;
	try {
		const out = await cleanupProcessGroup({
			childPid: pid, childPgid: pid, isSafeGroup: true,
			graceMs: 100, budgetMs: 0, expectedBirth: getProcInfo(pid)?.birth ?? null, expectedCommand: cmd.join(" "),
			childExited: () => false,
		});
		assert.equal(out.verification, "unverified_no_group_kill", "预算耗尽不得开新观察/发信号");
		assert.equal(out.signaled, false, "预算 0 不得 TERM");
		assert.equal(isPidAlive(pid), true, "预算 0 不得杀（子进程存活，测试自清理）");
	} finally {
		killRegistered(pid);
	}
});

test("R41负控：身份未正证（birth 缺失）→ 不得对已知 PID 单杀 fallback（无辜进程存活，测试自清理）", async () => {
	// 模拟「close 后 PID 疑似复用」：只拿到一个活 PID、无登记 birth/command —— 也不得杀
	const innocent = spawn(process.execPath, ["-e", "setInterval(()=>{},10000)"], { detached: true, stdio: "ignore" });
	const pid = innocent.pid!;
	try {
		const out = await cleanupProcessGroup({
			childPid: pid, childPgid: null, isSafeGroup: false,
			graceMs: 100, budgetMs: 800, expectedBirth: null, expectedCommand: null,
			childExited: () => true,
		});
		assert.equal(isPidAlive(pid), true, "birth/command 未正证 → 不得单杀 fallback");
		assert.equal(out.residue, "unknown");
	} finally {
		killRegistered(pid);
	}
});

test("R41负控：final IO 拖过总 deadline → sticky red（overBudget=true 且退出非零，不伪装自然 0）", async () => {
	const res = await runBounded({
		command: [process.execPath, "-e", "process.exit(0)"],
		timeoutMs: 300,
		stdio: "pipe",
		onLog: (msg) => {
			// 在最终证据写日志阶段同步拖过 deadline：收尾后的新鲜 check 必须翻红（green->red sticky）
			if (msg.includes("执行完毕: settlement=")) {
				const end = performance.now() + 500;
				while (performance.now() < end) { /* 同步占满事件循环 */ }
			}
		},
	});
	assert.equal(res.overBudget, true, "final IO 超预算必须如实标记 sticky red");
	assert.equal(res.exitCode, 124, "超预算结算不得伪装自然 0 退出");
	assert.equal(res.actualExitCode, 0, "但真实 exit 事件仍如实保留");
});

test("R41负控：exit 事件 wall 与 close(stdio) wall 分开且 exit ≤ close；不把 final 写盘 wall 称 OS exit", async () => {
	const res = await runBounded({
		command: [process.execPath, "-e", "process.stdout.write('x'.repeat(4096)); process.exit(0)"],
		timeoutMs: 15_000,
		stdio: "pipe",
	});
	assert.equal(res.exitCode, 0);
	assert.ok(typeof res.actualExitWallMs === "number", "必须有 actualExitWallMs（exit 事件时点）");
	assert.ok(typeof res.closeWallMs === "number", "必须有 closeWallMs（close/stdio 时点）");
	assert.ok(res.actualExitWallMs! <= res.closeWallMs! + 1);
	assert.match(res.runnerWallKind, /runner_observed/, "runner wall 必须标注非 OS exit wall");
});

test("R41负控：超时处置=同代核验后才组杀；residue/verification/targetExitProven 如实上报", async () => {
	const res = await runBounded({
		command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
		timeoutMs: 400,
		graceMs: 200,
		stdio: "pipe",
	});

	assert.equal(res.exitCode, 124);
	assert.equal(res.timedOut, true);
	// 组级信号必须只发生在同代核验通过之后（PID/PGID 复用的异代进程绝不组杀）
	assert.equal(res.killVerification, "verified_same_generation", `超时处置必须有同代核验正证: ${res.killVerification}`);
	assert.equal(res.groupResidue, "unknown", "不枚举成员 → 组残留只能 unknown（不得冒充 empty）");
	assert.equal(res.targetExitProven, true, "TERM/KILL 后必须真实 wait 到退出才算退出证明");
	assert.ok(res.actualExitWallMs !== null, "必须有 exit 事件 wall");
	assert.ok(res.runnerWallMs >= res.actualExitWallMs!);
});

test("R41负控：自然退出的 target_exit 与 runner wall 分开且单调一致", async () => {
	const res = await runBounded({
		command: [process.execPath, "-e", "process.stdout.write('x')"],
		timeoutMs: 15_000,
		stdio: "pipe",
	});

	assert.equal(res.exitCode, 0);
	assert.equal(res.timedOut, false);
	assert.equal(res.targetExitProven, true);
	assert.equal(res.killVerification, "not_needed", "自然退出不做超时处置");
	assert.ok(res.actualExitWallMs !== null);
	assert.ok(res.runnerWallMs >= res.actualExitWallMs!);
	assert.equal(res.settlement, "natural_exit", "自然退出必须标注 settlement=natural_exit");
});

// ── R43 修复绿（纯 fake：信号只记录、ps 经缝、无真实 child；R-Q42-2 b1–b9 形态全转绿）──

test("R43绿b1：TERM 后 grace 中 exit 已证 → 停发一切后续信号（不再对已 reap 的 pid/组 KILL）", async () => {
	const signals: RecordedSignal[] = [];
	let exited = false;
	let psCalls = 0;
	let t = 1_000_000;
	const deps: RunnerDeps = {
		now: () => t,
		sleep: async (ms) => { t += ms; },
		signal: (target, sig) => { signals.push({ target, sig: String(sig) }); },
		setTimeoutImpl: (fn) => fn,
		clearTimeoutImpl: () => {},
		procInfo: () => {
			psCalls++;
			// 模拟：TERM 已发出后（grace 期第一次观察时）exit 事件到达
			if (psCalls >= 2) exited = true;
			return { pgid: 4243, ppid: process.pid, birth: FAKE_BIRTH, command: "/bin/t --nonce-b1" };
		},
	};
	const out = await cleanupProcessGroup({
		childPid: 4243, childPgid: 4243, isSafeGroup: true,
		graceMs: 200, budgetMs: 5_000,
		expectedBirth: FAKE_BIRTH, expectedCommand: "/bin/t --nonce-b1",
		childExited: () => exited,
		deps,
	});
	assert.deepEqual(signals.filter((s) => s.sig.includes("KILL")), [], `exit 已证后不得 KILL: ${JSON.stringify(signals)}`);
	assert.equal(signals.filter((s) => s.sig.includes("TERM")).length, 1, "TERM 已发出（当时身份正证）");
	assert.equal(out.residue, "unknown");
	assert.equal(out.verification, "verified_same_generation");
	assert.equal(out.signaled, true);
});

test("R43绿：TERM 后 exit 在扳机前到达 → 零信号（紧邻扳机重查）", async () => {
	const signals: RecordedSignal[] = [];
	let exited = false;
	let t = 1_000_000;
	const deps: RunnerDeps = {
		now: () => t,
		sleep: async (ms) => { t += ms; },
		signal: (target, sig) => { signals.push({ target, sig: String(sig) }); },
		setTimeoutImpl: (fn) => fn,
		clearTimeoutImpl: () => {},
		procInfo: () => {
			// 模拟：TERM 核验观察后、扣扳机前 exit 事件已到（同步观察期间排队）
			exited = true;
			return { pgid: 4243, ppid: process.pid, birth: FAKE_BIRTH, command: "/bin/t --nonce-b1b" };
		},
	};
	const out = await cleanupProcessGroup({
		childPid: 4243, childPgid: 4243, isSafeGroup: true,
		graceMs: 200, budgetMs: 5_000,
		expectedBirth: FAKE_BIRTH, expectedCommand: "/bin/t --nonce-b1b",
		childExited: () => exited,
		deps,
	});
	assert.deepEqual(signals, [], `exit 已证必须零信号: ${JSON.stringify(signals)}`);
	assert.equal(out.signaled, false);
	assert.equal(out.residue, "unknown");
});

test("R43绿b2：grace 中 ps 观察失败(unknown) → 不得 KILL（零补杀）", async () => {
	const { deps, signals } = makeFakeDeps({ pgid: 4244, command: "/bin/t --nonce-b2", failFromCall: 2 });
	const out = await cleanupProcessGroup({
		childPid: 4244, childPgid: 4244, isSafeGroup: true,
		graceMs: 60, budgetMs: 5_000,
		expectedBirth: FAKE_BIRTH, expectedCommand: "/bin/t --nonce-b2",
		childExited: () => false,
		deps,
	});
	assert.deepEqual(signals.filter((s) => s.sig.includes("KILL")), [], `观察失败必须阻断 KILL: ${JSON.stringify(signals)}`);
	assert.equal(out.signaled, true, "TERM 已发出（当时身份正证）");
	assert.equal(out.residue, "unknown");
});

test("R43绿b4：首次观察耗尽预算 → 零信号（TERM 前守卫）", async () => {
	const { deps, signals, psCalls } = makeFakeDeps({ pgid: 4245, command: "/bin/t --nonce-b4", consumeMs: 90 });
	const out = await cleanupProcessGroup({
		childPid: 4245, childPgid: 4245, isSafeGroup: true,
		graceMs: 30, budgetMs: 50,
		expectedBirth: FAKE_BIRTH, expectedCommand: "/bin/t --nonce-b4",
		childExited: () => false,
		deps,
	});
	assert.equal(signals.length, 0, `预算耗尽必须零信号: ${JSON.stringify(signals)}`);
	assert.equal(psCalls.length, 1, "仅一次观察（其耗尽了预算）");
	assert.equal(out.signaled, false);
	assert.equal(out.residue, "unknown");
});

test("R43绿b5：command 与预期不符 → 身份不正证 → 零信号", async () => {
	const { deps, signals } = makeFakeDeps({ pgid: 4246, command: "/bin/evil --pwn" });
	const out = await cleanupProcessGroup({
		childPid: 4246, childPgid: 4246, isSafeGroup: true,
		graceMs: 30, budgetMs: 5_000,
		expectedBirth: FAKE_BIRTH, expectedCommand: "/bin/t --nonce-b5",
		childExited: () => false,
		deps,
	});
	assert.equal(signals.length, 0, `command 不符必须零信号: ${JSON.stringify(signals)}`);
	assert.equal(out.verification, "unverified_no_group_kill");
	assert.equal(out.signaled, false);
});

test("R43绿b9：direct fallback 也必须 command 正证（birth+ppid 相同、command 不同 → 零信号）", async () => {
	const { deps, signals } = makeFakeDeps({ pgid: 4247, command: "/bin/evil --pwn" });
	const out = await cleanupProcessGroup({
		childPid: 4247, childPgid: null, isSafeGroup: false,
		graceMs: 30, budgetMs: 5_000,
		expectedBirth: FAKE_BIRTH, expectedCommand: "/bin/t --nonce-b9",
		childExited: () => false,
		deps,
	});
	assert.equal(signals.length, 0, `fallback 必须四正证: ${JSON.stringify(signals)}`);
	assert.equal(out.signaled, false);
});

test("R43绿：direct fallback 身份四正证通过 → 单发 TERM+KILL（正控）", async () => {
	const { deps, signals } = makeFakeDeps({ pgid: 4248, command: "/bin/t --nonce-g" });
	const out = await cleanupProcessGroup({
		childPid: 4248, childPgid: null, isSafeGroup: false,
		graceMs: 30, budgetMs: 5_000,
		expectedBirth: FAKE_BIRTH, expectedCommand: "/bin/t --nonce-g",
		childExited: () => false,
		deps,
	});
	assert.deepEqual(signals.map((s) => `${s.target}:${s.sig}`).sort(), ["4248:SIGKILL", "4248:SIGTERM"]);
	assert.equal(out.verification, "not_needed");
	assert.equal(out.signaled, true);
	assert.deepEqual(out.cleanedPids, [4248]);
});

test("R43绿：KILL 前 fresh 重核验发现身份改变（command 被换）→ 零 KILL", async () => {
	const { deps, signals } = makeFakeDeps({
		pgid: 4249, command: "/bin/t --nonce-g6",
		spoofCommandFromCall: 3, spoofedCommand: "/bin/evil --pwn",
	});
	const out = await cleanupProcessGroup({
		childPid: 4249, childPgid: 4249, isSafeGroup: true,
		graceMs: 25, budgetMs: 5_000,
		expectedBirth: FAKE_BIRTH, expectedCommand: "/bin/t --nonce-g6",
		childExited: () => false,
		deps,
	});
	const kills = signals.filter((s) => s.sig.includes("KILL"));
	assert.deepEqual(kills, [], `KILL 前 fresh 核验失败必须零 KILL: ${JSON.stringify(signals)}`);
	assert.equal(out.signaled, true, "TERM 已发出");
	assert.equal(out.residue, "unknown");
});

test("R43绿b6b：validateProcessGroup 总绝对预算核算——每次 ps floor(min(cap,剩余))，耗尽即停（不再固定 7 次）", () => {
	const { deps, psCalls } = makeFakeDeps({ pgid: 4250, command: "/bin/t --x", consumeMs: 90, failFromCall: 1 });
	const val = validateProcessGroup(4250, 200, "/bin/t --x", deps);
	assert.equal(val.safe, false, "观察全失败 → unsafe(unknown)");
	assert.deepEqual(psCalls.map((c) => c.budget), [200, 110, 20], `每次 ps 必须按真实剩余钳制: ${JSON.stringify(psCalls)}`);
	assert.ok(psCalls.length < 7, `固定 7 次已废（实际 ${psCalls.length} 次）`);
});

test("R43绿：cleanup 预算 0 → 零 spawn 零信号；exit 已证 → 零 spawn 零信号", async () => {
	{ // 预算 0
		const { deps, signals, psCalls } = makeFakeDeps({ pgid: 4251, command: "/bin/t --x" });
		const out = await cleanupProcessGroup({
			childPid: 4251, childPgid: 4251, isSafeGroup: true,
			graceMs: 30, budgetMs: 0, expectedBirth: FAKE_BIRTH, expectedCommand: "/bin/t --x",
			childExited: () => false, deps,
		});
		assert.equal(psCalls.length, 0, "预算 0 必须零 spawn");
		assert.equal(signals.length, 0);
		assert.equal(out.signaled, false);
	}
	{ // exit 已证
		const { deps, signals, psCalls } = makeFakeDeps({ pgid: 4252, command: "/bin/t --x" });
		const out = await cleanupProcessGroup({
			childPid: 4252, childPgid: 4252, isSafeGroup: true,
			graceMs: 30, budgetMs: 5_000, expectedBirth: FAKE_BIRTH, expectedCommand: "/bin/t --x",
			childExited: () => true, deps,
		});
		assert.equal(psCalls.length, 0, "exit 已证必须零观察");
		assert.equal(signals.length, 0, "exit 已证必须零信号");
		assert.equal(out.residue, "unknown");
	}
});

test("R43绿：正控——同代四正证 TERM → grace → fresh 核验 → 组 KILL（单发，不补冗余 direct 枪）", async () => {
	const { deps, signals } = makeFakeDeps({ pgid: 4253, command: "/bin/t --nonce-g13" });
	const out = await cleanupProcessGroup({
		childPid: 4253, childPgid: 4253, isSafeGroup: true,
		graceMs: 30, budgetMs: 5_000,
		expectedBirth: FAKE_BIRTH, expectedCommand: "/bin/t --nonce-g13",
		childExited: () => false, deps,
	});
	const sigs = signals.map((s) => `${s.target}:${s.sig}`);
	assert.ok(sigs.includes("-4253:SIGTERM"), `组 TERM 缺失: ${JSON.stringify(sigs)}`);
	assert.ok(sigs.includes("-4253:SIGKILL"), `fresh 核验后组 KILL 缺失: ${JSON.stringify(sigs)}`);
	assert.ok(!sigs.includes("4253:SIGKILL"), `组模式不得补冗余 direct KILL（第二枪可打复用 PID）: ${JSON.stringify(sigs)}`);
	assert.equal(out.verification, "verified_same_generation");
	assert.equal(out.signaled, true);
	assert.deepEqual(out.cleanedPids, [4253]);
	assert.equal(out.residue, "unknown");
});

test("R43绿：grace 从 TERM 后起算——核验耗时不得吃掉 grace 窗（观察后仍有 grace 观察）", async () => {
	const { deps, psCalls, signals } = makeFakeDeps({ pgid: 4260, command: "/bin/t --nonce-g14", consumeMs: 600 });
	const out = await cleanupProcessGroup({
		childPid: 4260, childPgid: 4260, isSafeGroup: true,
		graceMs: 100, budgetMs: 10_000,
		expectedBirth: FAKE_BIRTH, expectedCommand: "/bin/t --nonce-g14",
		childExited: () => false, deps,
	});
	// 旧实现 graceEnd 从 start 起算：600ms 观察 ≥ graceMs 100 → grace 循环零迭代直接 KILL；
	// 新实现从 TERM 后起算 → grace 内至少还有一次观察（总调用 ≥3：TERM核验+grace+KILL核验）
	assert.ok(psCalls.length >= 3, `核验吃 grace 缺陷必须已修（实际 ps 调用 ${psCalls.length}）`);
	assert.ok(signals.some((s) => s.sig.includes("KILL")));
	assert.equal(out.signaled, true);
});

// ── R43 runBounded 收尾时序（fake spawn/fake 钟；b7 形态转绿 + 实际最后 IO 注入 slow/throw）──

/** fake spawn：R47 同锚假钟调度器——deadline timer 与 child 退出事件全部在 fake 钟上到期
 * dispatch（对齐 bounded-runner-r47-cases 的 FakeClock 形态）。R-Q45-1 冻结语义：runner
 * 等待由 deps.sleep 有界循环驱动，真实 setTimeout 宏任务无法参与 fake 钟时序（旧 fake 用
 * 真实 setTimeout(10) emit child 事件 → 微任务自旋先耗尽假钟 → close 永远赶不上 →
 * unproven_unknown）。hangChild=永不退出 */
function runBoundedFakeDeps(pid: number, command: string, exitCode: number, opts?: { hangChild?: boolean }) {
	let t = 1_000_000;
	const signals: RecordedSignal[] = [];
	const cleared: unknown[] = [];
	const timers = new Map<unknown, { fn: () => void; due: number }>();
	let child: ChildProcess | null = null;
	let childFireAt: number | null = null; // fake 钟时点：spawn+10ms 后 emit exit/close
	let childFired = false;
	const deps: RunnerDeps = {
		now: () => t,
		sleep: async (ms) => {
			t += Math.max(0, Math.floor(ms));
			for (const [h, it] of [...timers]) {
				if (timers.has(h) && it.due <= t) { timers.delete(h); it.fn(); }
			}
			if (childFireAt !== null && !childFired && t >= childFireAt) {
				childFired = true;
				child!.emit("exit", exitCode, null);
				child!.emit("close", exitCode, null);
			}
		},
		signal: (target, sig) => { signals.push({ target, sig: String(sig) }); },
		setTimeoutImpl: (fn, ms) => {
			const handle: object = {};
			timers.set(handle, { fn, due: t + Math.max(0, Math.floor(ms)) });
			return handle;
		},
		clearTimeoutImpl: (timer) => { cleared.push(timer); timers.delete(timer); },
		spawnImpl: (() => {
			child = fakeChild(pid);
			if (!opts?.hangChild) childFireAt = t + 10;
			return child;
		}) as unknown as typeof spawn,
		procInfo: () => ({ pgid: pid, ppid: process.pid, birth: FAKE_BIRTH, command }),
	};
	return { deps, signals, cleared, advance: (ms: number) => { t += ms; } };
}

test("R43绿b7：实际最后 onLog（执行完毕）同步拖过总 deadline → overBudget=true + 124 + runnerWall 后采样", async () => {
	const { deps, signals, advance } = runBoundedFakeDeps(777_001, "/bin/fake-target --nonce-g8", 0);
	const res = await runBounded({
		command: ["/bin/fake-target", "--nonce-g8"],
		timeoutMs: 300, stdio: "ignore", deps,
		onLog: (msg) => { if (msg.includes("执行完毕: settlement=")) advance(2_600); },
	});
	assert.equal(res.settlement, "natural_exit");
	assert.equal(res.overBudget, true, "实际最后 onLog 拖过 deadline 必须翻红（b7 转绿）");
	assert.equal(res.exitCode, 124);
	assert.equal(res.actualExitCode, 0, "真实 exit 保留");
	assert.ok(res.runnerWallMs >= 2_500, `runnerWall 必须在 IO 之后采样: ${res.runnerWallMs}`);
	assert.equal(signals.length, 0);
});

test("R43绿：finalizeIO（调用方最终 IO）拖过 deadline → 同样 sticky red", async () => {
	const { deps, advance } = runBoundedFakeDeps(777_002, "/bin/fake-target --nonce-g9", 0);
	const res = await runBounded({
		command: ["/bin/fake-target", "--nonce-g9"],
		timeoutMs: 300, stdio: "ignore", deps,
		finalizeIO: () => advance(2_600),
	});
	assert.equal(res.overBudget, true, "finalizeIO 计入总预算");
	assert.equal(res.exitCode, 124);
	assert.ok(res.runnerWallMs >= 2_500, `wall 必须在 finalizeIO 之后采样: ${res.runnerWallMs}`);
});

test("R43绿b7b：finalizeIO 抛错 → 受控 reject（失败非零）且 timer 全部清除（失败收敛语义）", async () => {
	const { deps, cleared } = runBoundedFakeDeps(777_003, "/bin/fake-target --nonce-g10", 0);
	await assert.rejects(
		runBounded({
			command: ["/bin/fake-target", "--nonce-g10"],
			timeoutMs: 5_000, stdio: "ignore", deps,
			finalizeIO: () => { throw new Error("finalize IO failed"); },
		}),
		/finalize IO failed/,
	);
	assert.equal(cleared.length, 2, `真实结算后失败收敛必须仍清 timer: ${cleared.length}`);
});

test("R43绿：最后 onLog 抛错 → 受控 reject 且 timer 清除（不悬挂、不假绿）", async () => {
	const { deps, cleared } = runBoundedFakeDeps(777_004, "/bin/fake-target --nonce-g11", 0);
	await assert.rejects(
		runBounded({
			command: ["/bin/fake-target", "--nonce-g11"],
			timeoutMs: 5_000, stdio: "ignore", deps,
			onLog: (msg) => { if (msg.includes("执行完毕: settlement=")) throw new Error("final log IO failed"); },
		}),
		/final log IO failed/,
	);
	assert.equal(cleared.length, 2, `失败收敛仍清 timer: ${cleared.length}`);
});

test("R43绿：自然退出 fake → exitCode 透传、零信号、settlement=natural_exit", async () => {
	const { deps, signals } = runBoundedFakeDeps(777_005, "/bin/fake-target --nonce-g12", 7);
	const res = await runBounded({
		command: ["/bin/fake-target", "--nonce-g12"],
		timeoutMs: 5_000, stdio: "ignore", deps,
	});
	assert.equal(res.exitCode, 7);
	assert.equal(res.settlement, "natural_exit");
	assert.equal(res.overBudget, false);
	assert.equal(res.targetExitProven, true);
	assert.equal(signals.length, 0, "自然退出零信号");
});

// ── R43 WIP 源门补强（coor msg_82b3621748c6 / msg_7c38ca7d0bcd）──

test("R43绿：validateProcessGroup——runner 自身 PGID 观察失败 → safe=false（未知组不信号）", () => {
	const signals: RecordedSignal[] = [];
	let t = 1_000_000;
	const deps: RunnerDeps = {
		now: () => t,
		sleep: async () => { t += 25; },
		signal: (target, sig) => { signals.push({ target, sig: String(sig) }); },
		setTimeoutImpl: (fn) => fn,
		clearTimeoutImpl: () => {},
		procInfo: (pid) => (pid === process.pid ? null : { pgid: pid, ppid: process.pid, birth: FAKE_BIRTH, command: "/bin/t --x" }),
	};
	const val = validateProcessGroup(4301, 5_000, "/bin/t --x", deps);
	assert.equal(val.safe, false, "runner PGID 未知 → 组关系未知 → 不得 safe");
	assert.match(val.reason ?? "", /runner 自身 PGID/);
});

test("R43绿：validateProcessGroup——子进程 PPID≠本 runner → safe=false（初次即拒，不只留 cleanup）", () => {
	const deps: RunnerDeps = {
		now: () => 1_000_000,
		sleep: async () => {},
		signal: () => {},
		setTimeoutImpl: (fn) => fn,
		clearTimeoutImpl: () => {},
		procInfo: () => ({ pgid: 4302, ppid: 999_999, birth: FAKE_BIRTH, command: "/bin/t --x" }),
	};
	const val = validateProcessGroup(4302, 5_000, "/bin/t --x", deps);
	assert.equal(val.safe, false);
	assert.match(val.reason ?? "", /PPID≠|PPID/);
});

test("R43绿：getProcInfo 零预算 guard 在注入之前——deps.procInfo 不被零预算调用", () => {
	let called = 0;
	const deps: RunnerDeps = { procInfo: () => { called++; return null; } };
	assert.equal(getProcInfo(4303, 0, deps), null);
	assert.equal(getProcInfo(4303, -5, deps), null);
	assert.equal(getProcInfo(4303, 0.4, deps), null, "floor 后 ≤0 同样零观察");
	assert.equal(called, 0, `零预算必须零注入调用: ${called}`);
});

test("R43绿：getProcInfo 把 floor 后的 budget 传给注入缝（同一把尺）", () => {
	const seen: number[] = [];
	const deps: RunnerDeps = { procInfo: (_pid, budget) => { seen.push(budget); return null; } };
	getProcInfo(4304, 5_000, deps);
	assert.deepEqual(seen, [3_000], "budget 必须先 floor(min(cap,budget)) 再注入");
});

test("R43绿：prelude 预算耗尽 → 零 spawn + timer 收敛 + 受控拒绝", async () => {
	let spawnCalls = 0;
	const cleared: unknown[] = [];
	let t = 1_000_000;
	const deps: RunnerDeps = {
		now: () => t,
		sleep: async () => { t += 25; },
		signal: () => {},
		setTimeoutImpl: (fn) => fn,
		clearTimeoutImpl: (timer) => { cleared.push(timer); },
		spawnImpl: (() => { spawnCalls++; return fakeChild(4305); }) as unknown as typeof spawn,
		procInfo: () => ({ pgid: 4305, ppid: process.pid, birth: FAKE_BIRTH, command: "/bin/fake --nonce" }),
	};
	await assert.rejects(
		runBounded({
			command: ["/bin/fake", "--nonce"],
			timeoutMs: 5_000, stdio: "ignore", deps,
			onLog: () => { t += 6_000; }, // 启动日志同步耗尽预算
		}),
		/零 spawn/,
	);
	assert.equal(spawnCalls, 0, "预算耗尽必须零 spawn");
	assert.equal(cleared.length, 2, "失败路径必须收全部预挂 timer");
});

test("R43绿：启动 onLog 抛错 → 零 spawn + timer 收敛 + 受控拒绝", async () => {
	let spawnCalls = 0;
	const cleared: unknown[] = [];
	const deps: RunnerDeps = {
		now: () => 1_000_000,
		sleep: async () => {},
		signal: () => {},
		setTimeoutImpl: (fn) => fn,
		clearTimeoutImpl: (timer) => { cleared.push(timer); },
		spawnImpl: (() => { spawnCalls++; return fakeChild(4306); }) as unknown as typeof spawn,
		procInfo: () => ({ pgid: 4306, ppid: process.pid, birth: FAKE_BIRTH, command: "/bin/fake --nonce" }),
	};
	await assert.rejects(
		runBounded({
			command: ["/bin/fake", "--nonce"],
			timeoutMs: 5_000, stdio: "ignore", deps,
			onLog: () => { throw new Error("startup log IO failed"); },
		}),
		/startup log IO failed/,
	);
	assert.equal(spawnCalls, 0, "启动日志失败不得 spawn");
	assert.equal(cleared.length, 2, "失败路径必须收全部预挂 timer");
});

test("R43绿：spawn 同步抛错 → timer 收敛 + 受控拒绝（失败不冒已 join）", async () => {
	const cleared: unknown[] = [];
	const deps: RunnerDeps = {
		now: () => 1_000_000,
		sleep: async () => {},
		signal: () => {},
		setTimeoutImpl: (fn) => fn,
		clearTimeoutImpl: (timer) => { cleared.push(timer); },
		spawnImpl: (() => { throw new Error("spawn exploded"); }) as unknown as typeof spawn,
	};
	await assert.rejects(
		runBounded({ command: ["/bin/fake"], timeoutMs: 5_000, stdio: "ignore", deps }),
		/spawn exploded/,
	);
	assert.equal(cleared.length, 2, "spawn 失败必须收全部预挂 timer");
});

test("R43绿：finalizeIO snapshot 填已知结算值（非占位 0）并标注 pre_final_io", async () => {
	const { deps } = runBoundedFakeDeps(777_006, "/bin/fake-target --nonce-g20", 7);
	let seen: RunBoundedResult | null = null;
	const res = await runBounded({
		command: ["/bin/fake-target", "--nonce-g20"],
		timeoutMs: 5_000, stdio: "ignore", deps,
		finalizeIO: (snap) => { seen = snap as unknown as RunBoundedResult; },
	});
	assert.ok(seen, "finalizeIO 必须收到 snapshot");
	assert.equal((seen as unknown as RunBoundedResult).exitCode, 7, "snapshot 不得硬填 0（已知非零）");
	assert.match((seen as unknown as RunBoundedResult).runnerWallKind, /pre_final_io/, "snapshot wall 必须标注 pre_final_io");
	assert.equal(res.exitCode, 7, "最终返回值 exitCode 不变");
	assert.equal(res.overBudget, false);
});

test("R43绿：cleanup 内 onLog 抛错 → 按 unknown 失败收敛（非零 + 不泄露 timer）", async () => {
	const { deps, cleared, signals } = runBoundedFakeDeps(777_007, "/bin/fake-target --nonce-g21", 0, { hangChild: true });
	await assert.rejects(
		runBounded({
			command: ["/bin/fake-target", "--nonce-g21"],
			timeoutMs: 150, graceMs: 20, stdio: "ignore", deps,
			onLog: (msg) => { if (msg.includes("SIGTERM")) throw new Error("cleanup log IO failed"); },
		}),
		/cleanup log IO failed/,
	);
	assert.equal(cleared.length, 2, "失败收敛必须收全部预挂 timer");
	// R47 冻结语义：cleanup 内 onLog 为裸调用，「SIGTERM 已发」日志抛错时 TERM 已离手
	// （异常传播出 cleanupProcessGroup → runBounded catch → sticky reject）。守护性质=
	// 失败收敛后无 KILL 补杀：精确单枪 TERM（direct fallback，isSafeGroup=false），非恒真。
	assert.deepEqual(
		signals.map((s) => `${s.target}:${s.sig}`),
		["777007:SIGTERM"],
		`失败收敛后必须恰一发 TERM、零 KILL 补杀: ${JSON.stringify(signals)}`,
	);
});
