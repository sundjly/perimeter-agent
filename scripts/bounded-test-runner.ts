import { execFileSync, spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:os";

/**
 * Bounded Test Runner（R47：R-Q45-1/2/3/4 修复 + 可注入验证缝；R43/R45 语义保留）
 *
 * 诚实边界（partial，不夸口）：
 * - 只允许有界 knownPID `ps -p` 定向观察；**组成员枚举（ps -g）已删除**——不存在组成员
 *   正证的任何通道 → group_residue 恒为 unknown（退出≠组绝灭，绝不造 empty）。
 * - 一切信号前的身份正证=四元组：PGID + birth + PPID=本 runner + 完整预期 command
 *   （ps command= 输出经白空格归一化后与 spawn argv 精确比对）。缺一/改变/观察失败
 *   → unknown → 零信号。组级与单发 fallback 同一把尺，绝不只凭 birth+PPID。
 * - 直接子进程的退出由真实 exit 事件证明（本进程持有 ChildProcess 句柄、内核 reap 时
 *   事件必达）；exit 已证 → 立即停发一切后续组/单 PID 信号。cleanup 通过动态 getter
 *   读取该事实，绝不以字面 false 假装未退出。child error/exit/close 回调体 contain：
 *   deps.now/onLog 抛错 → shared sticky failure，不让事件回调异常逃逸成 uncaught。
 * - TERM → 有界 grace → KILL 前必须 fresh 身份重核验 + 临枪 fresh budget/exit 检查；
 *   观察失败（null/超时）→ unknown → 不得 KILL；预算耗尽 → 零 spawn 零信号。
 * - R47 严格时序：原 TOTAL 单调绝对 deadline 唯一，含 prelude/所有等待/finalIO。等待用
 *   deps.sleep 有界循环驱动（可全 fake；零窗不建循环；`>=` 判过期；每次 sleep ≤ 当前原
 *   绝对剩余；真实钟兜底仅同幅防注入钟死锁、非第二预算）。validate/log 消耗后先判总
 *   剩余，过期显式 unknown 非零（零处置/零等待/零 signal/不赠 budget）。cleanup 接收原
 *   absolute totalDeadline 同锚（不重锚赠调用时间），每次观察前鲜采
 *   floor(min(cap,currentRemaining))；target 预留自适应覆盖 grace+close+验证，KILL 升级
 *   在原 TOTAL 内可达。不无限等待，不赠予额外预算，不补 kill。
 * - 收尾次序：结算 → 全部 finalizer IO（onLog + finalizeIO，可失败）→ 新鲜预算 check
 *   （green→red sticky，只翻红不翻绿）→ runnerWall 采样（不得早采样再 IO）→ finally
 *   清 timer（双 timer 独立尝试，任一失败 sticky）。任何失败（cleanup/回调 contain/
 *   finalizer/clear 失败）→ shared sticky → 停止其余 fallible IO → 非零 reject。
 * - snapshot/终值已知 sticky：已知 overBudget 先取 124（child 实际 0 不掩已超限）；
 *   已知非零/unknown 保留；pre_final_io 标注与 CLI wallAtCliLog 非最终 wall；真实
 *   runnerWall 在全部 IO 后采样。
 * - 四 wall 分开：actualExitWallMs（exit 事件）、closeWallMs（close/stdio 事件；
 *   nodeExitWallMs 为兼容别名）、runnerWallMs（最终采样，标注 runner_observed 非 OS
 *   exit wall）。外层 parent 的实际 OS wait 在本进程边界之外，由调用方如实观测。
 * - 可注入缝（RunnerDeps）：clock/ps观察/信号/spawn/sleep/timer 全部可换纯 fake——
 *   fake 信号只记录不投递、fake ps 不产生真实 child；被审代码无不可注入的真实
 *   setInterval/timer 等待。
 */

/** 可注入依赖缝（默认全部真实实现）。纯 fake 验证只记录、不投递、零真实资源。 */
export interface RunnerDeps {
	/** 定向 ps 观察（knownPID `ps -p`）；返回 null=观察失败/超时/预算耗尽=unknown */
	procInfo?: (pid: number, budgetMs: number) => ProcInfo | null;
	/** 信号投递（默认 process.kill；fake 实现只记录不投递） */
	signal?: (target: number, sig: NodeJS.Signals) => void;
	/** spawn 缝（默认 node:child_process spawn） */
	spawnImpl?: typeof spawn;
	/** 单调钟（默认 performance.now） */
	now?: () => number;
	/** 有界 sleep（默认 setTimeout promise） */
	sleep?: (ms: number) => Promise<void>;
	/** 预挂 deadline timer 缝（默认 setTimeout；fake 可控触发时机） */
	setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
	/** 与 setTimeoutImpl 配对的 clear（默认 clearTimeout） */
	clearTimeoutImpl?: (t: unknown) => void;
}

const defaultDeps = (deps?: RunnerDeps): Required<Pick<RunnerDeps, "signal" | "now" | "sleep" | "setTimeoutImpl" | "clearTimeoutImpl">> & { procInfo?: RunnerDeps["procInfo"]; spawnImpl?: RunnerDeps["spawnImpl"] } => ({
	signal: deps?.signal ?? ((target, sig) => process.kill(target, sig)),
	now: deps?.now ?? (() => performance.now()),
	sleep: deps?.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
	setTimeoutImpl: deps?.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms)),
	clearTimeoutImpl: deps?.clearTimeoutImpl ?? ((t) => clearTimeout(t as NodeJS.Timeout)),
	procInfo: deps?.procInfo,
	spawnImpl: deps?.spawnImpl,
});

export function getPgid(pid: number, budgetMs = 3_000): number | null {
	return getProcInfo(pid, budgetMs)?.pgid ?? null;
}

export interface ProcInfo {
	pgid: number;
	ppid: number;
	/** 进程出生时间（ps lstart 原文），同代（same-birth）核验的基准 */
	birth: string;
	command: string;
}

const PS_BIN = "/bin/ps"; // 生产身份源固定为系统 ps，不经 PATH（防 shim 冒充）；fake 走 deps.procInfo

/**
 * 单次 scoped `ps -p <knownPid>` 定向观察（绝不全局枚举、绝不组员枚举）。
 * 预算 guard（floor(min(cap,budgetMs))、≤0 零 spawn）统一在注入之前：deps.procInfo 收到
 * 的就是 floor 后的 budget，同一把尺验证，零预算时 fake 路径同样不观察。
 * ps 失败/超时=unknown（null），绝不折叠成空。ps 是本调用新 spawn、由 execFileSync
 * 真实 wait 的 owned CLI：killSignal=SIGKILL，TERM-resistant shim 不能挂死本调用。
 */
export function getProcInfo(pid: number, budgetMs = 3_000, deps?: RunnerDeps): ProcInfo | null {
	const timeout = Math.floor(Math.min(3_000, budgetMs));
	if (!(timeout > 0)) return null;
	if (deps?.procInfo) return deps.procInfo(pid, timeout);
	try {
		const out = execFileSync(PS_BIN, ["-p", String(pid), "-o", "pgid=", "-o", "ppid=", "-o", "lstart=", "-o", "command="], {
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
			timeout,
			killSignal: "SIGKILL",
		}).trim();
		const tok = out.split(/\s+/);
		if (tok.length < 8) return null;
		const pgid = parseInt(tok[0]!, 10);
		const ppid = parseInt(tok[1]!, 10);
		if (!Number.isSafeInteger(pgid) || pgid <= 0 || !Number.isSafeInteger(ppid) || ppid <= 0) return null;
		return { pgid, ppid, birth: tok.slice(2, 7).join(" "), command: tok.slice(7)!.join(" ") };
	} catch {
		return null;
	}
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** ps command= 输出被空白切分重组，且 macOS ps 会把控制字符转成八进制转义（\012 等）——
 *  比对前先解码转义再对预期 argv 串做同一归一化 */
function normalizeCommand(s: string): string {
	const decoded = s.replace(/\\([0-7]{1,3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
	return decoded.split(/\s+/).filter((x) => x.length > 0).join(" ");
}

/**
 * 身份四正证：观察非空 + PGID 匹配 + birth 匹配 + PPID=本 runner + command 与预期一致。
 * expectedBirth/expectedCommand 缺失（null/undefined）→ 永不正证（fail-closed）。
 */
function identityVerified(
	info: ProcInfo | null,
	expected: { pgid: number | null; birth: string | null; command: string | null },
): boolean {
	if (!info) return false;
	if (expected.pgid !== null && info.pgid !== expected.pgid) return false;
	if (expected.birth == null || info.birth !== expected.birth) return false;
	if (info.ppid !== process.pid) return false;
	if (expected.command == null || normalizeCommand(info.command) !== normalizeCommand(expected.command)) return false;
	return true;
}

export interface ProcessGroupValidation {
	safe: boolean;
	childPid: number;
	childPgid: number | null;
	runnerPid: number;
	runnerPgid: number | null;
	parentPgid: number | null;
	/** 启动期观察到的出生时间；同代核验的基准。缺失=null → 永不判同代 */
	birth: string | null;
	reason?: string;
}

/**
 * 进程组安全核验（R43：总绝对单调预算 + command 绑定）。
 * - 全部重试（child/runner/parent 的每次 ps）共享同一个总预算：绝对单调钟起点后，
 *   每次 ps 预算=floor(min(cap, 当前剩余))，≤0 → 零 spawn；不再有固定次数×固定预算。
 * - child 的 command 必须与 expectedCommand 一致才 safe（缺失 → 永不 safe）。
 */
export function validateProcessGroup(
	childPid: number,
	psBudgetMs = 3_000,
	expectedCommand?: string | null,
	deps?: RunnerDeps,
): ProcessGroupValidation {
	const now = deps?.now ?? (() => performance.now());
	const runnerPid = process.pid;
	const parentPid = process.ppid;
	const start = now();
	const remaining = () => psBudgetMs - (now() - start);
	const psBudget = () => Math.max(0, Math.floor(Math.min(3_000, remaining())));
	const noSpawn: ProcessGroupValidation = { safe: false, childPid, childPgid: null, runnerPid, runnerPgid: null, parentPgid: null, birth: null };

	// child 观察：重试受同一总预算约束（每次单独 floor(min(cap,剩余))，≤0 停）
	let childInfo: ProcInfo | null = null;
	for (let i = 0; i < 5; i++) {
		const budget = psBudget();
		if (budget <= 0) break;
		childInfo = getProcInfo(childPid, budget, deps);
		if (childInfo !== null) break;
	}
	if (childInfo === null) {
		return { ...noSpawn, reason: "未能获取子进程身份（观察失败/预算耗尽/子进程可能已退出）→ unknown，零信号" };
	}
	// 初次 safe 前就要校验 child 四元组：PPID=本 runner + birth/command 非空（不只留给 cleanup）
	if (childInfo.ppid !== process.pid || childInfo.birth.length === 0 || childInfo.command.length === 0) {
		return {
			...noSpawn,
			childPgid: childInfo.pgid,
			birth: childInfo.birth,
			reason: "子进程 PPID≠本 runner 或 birth/command 为空 → 身份不正证，零信号",
		};
	}
	// command 绑定：不匹配/未提供 → 不 safe（组级与单发都不正证）
	if (expectedCommand == null || normalizeCommand(childInfo.command) !== normalizeCommand(expectedCommand)) {
		return {
			...noSpawn,
			childPgid: childInfo.pgid,
			birth: childInfo.birth,
			reason: "子进程 command 与预期不符（或未提供预期 command）→ 身份不正证，零信号",
		};
	}
	const childPgid = childInfo.pgid;
	const birth = childInfo.birth;
	// runner/parent 观察失败（unknown）不得 safe：无法证明组不相交 → 零信号（口径收缩）
	const runnerPgid = remaining() > 0 ? (getProcInfo(runnerPid, psBudget(), deps)?.pgid ?? null) : null;
	if (runnerPgid === null) {
		return { safe: false, childPid, childPgid, runnerPid, runnerPgid: null, parentPgid: null, birth, reason: "runner 自身 PGID 观察失败/预算耗尽 → 组关系未知，零信号" };
	}
	const parentPgid = remaining() > 0 && parentPid ? (getProcInfo(parentPid, psBudget(), deps)?.pgid ?? null) : null;
	if (parentPid && parentPgid === null) {
		return { safe: false, childPid, childPgid, runnerPid, runnerPgid, parentPgid: null, birth, reason: "runner 父进程 PGID 观察失败/预算耗尽 → 组关系未知，零信号" };
	}
	if (childPgid !== childPid) {
		return { safe: false, childPid, childPgid, runnerPid, runnerPgid, parentPgid, birth, reason: `子进程不是自身进程组组长 (childPid=${childPid}, childPgid=${childPgid})` };
	}
	if (runnerPgid !== null && childPgid === runnerPgid) {
		return { safe: false, childPid, childPgid, runnerPid, runnerPgid, parentPgid, birth, reason: `子进程与 runner 共享进程组 (${childPgid})，禁止向该组广播信号` };
	}
	if (parentPgid !== null && childPgid === parentPgid) {
		return { safe: false, childPid, childPgid, runnerPid, runnerPgid, parentPgid, birth, reason: `子进程与 runner 父进程共享进程组 (${childPgid})，禁止向该组广播信号` };
	}
	return { safe: true, childPid, childPgid, runnerPid, runnerPgid, parentPgid, birth };
}

export interface CleanupOutcome {
	/** 收到 TERM/KILL 的目标（仅身份四正证后才可能有） */
	cleanedPids: number[];
	/** R43：组成员零枚举 → 恒 unknown（不存在 empty 证据通道，绝不冒充已清空） */
	residue: "unknown";
	/** verified_same_generation=TERM 时刻四正证；其余一律未证不杀 */
	verification: "verified_same_generation" | "unverified_no_group_kill" | "not_needed";
	/** 是否发出过任何信号（KILL 前身份失效等情形下用于结算归类） */
	signaled: boolean;
}

export interface CleanupOptions {
	childPid: number;
	childPgid: number | null;
	isSafeGroup: boolean;
	graceMs?: number;
	onLog?: (msg: string) => void;
	/** 独立调用时的预算上限（ms，自进入起算）；与 absoluteDeadline 取更严者 */
	budgetMs?: number;
	/** 原绝对单调 deadline（调用方钟坐标，同锚不重锚）；与 budgetMs 取更严者 */
	absoluteDeadline?: number;
	/**
	 * R-Q47-A：调用方 shared failure 谓词（contain 过的事件失败/sticky）。cleanup 在
	 * 入口/意图日志前/每次观察前/每 sleep 醒后/离开 grace 后/两枪临枪检查——命中即停
	 * 所有后 IO/观察/信号，返回已发部分 + residue unknown。绝不伪造成 childExited。
	 */
	failure?: () => boolean;
	expectedBirth?: string | null;
	/** 预期完整 command（spawn argv join；ps 输出归一化比对）；缺失=永不正证 */
	expectedCommand?: string | null;
	/** 真实 child 退出动态查询（exit 事件驱动）；true=已证退出 → 一切信号停止 */
	childExited: () => boolean;
	deps?: RunnerDeps;
}

/**
 * 进程组清理（R43 严格版）。核心纪律：
 * - exit 已证（childExited()）→ 立即零信号（TERM 前、grace 每轮、KILL 前都查）；
 * - 组级 TERM 只在「PGID+birth+PPID+command」四正证时发出；否则单发 fallback 也要
 *   同一四正证（pgid 之外的字段全查），绝不只凭 birth+PPID；
 * - KILL 前 fresh 重核验（独立预算），不跨同步观察沿用 TERM 时刻的结论；
 * - 观察失败（null）=unknown → 不得 KILL；预算耗尽 → 零 spawn 零信号；
 * - 每次观察/等待都有界于 budgetMs；residue 恒 unknown（无枚举即无 empty 正证）。
 */
export async function cleanupProcessGroup(opts: CleanupOptions): Promise<CleanupOutcome> {
	const { childPid, childPgid, isSafeGroup, onLog, deps } = opts;
	const graceMs = opts.graceMs ?? 1500;
	const budgetMs = opts.budgetMs ?? 4_000;
	const expectedBirth = opts.expectedBirth ?? null;
	const expectedCommand = opts.expectedCommand ?? null;
	const childExited = opts.childExited;
	const signal = defaultDeps(deps).signal;
	const now = deps?.now ?? (() => performance.now());
	const sleep = defaultDeps(deps).sleep;

	const cleaned = new Set<number>();
	const start = now();
	// R47：absoluteDeadline 与 budgetMs 取更严界（runBounded 传同锚 absolute，不重锚赠调用时间）
	const remaining = (): number => {
		const byBudget = budgetMs - (now() - start);
		if (opts.absoluteDeadline !== undefined) return Math.min(byBudget, opts.absoluteDeadline - now());
		return byBudget;
	};
	const psBudget = () => Math.max(0, Math.floor(Math.min(3_000, remaining())));
	// R-Q47-A：shared failure 谓词——证据/决策基础设施报损即停链（contain 过的事件失败
	// 可跨 await 到达 grace 循环；此时 childExited 仍 false，不查就继续 KILL 是缺口）。
	const failed = (): boolean => opts.failure?.() === true;
	const failReturn = (): CleanupOutcome => ({
		cleanedPids: Array.from(cleaned), residue: "unknown", verification, signaled,
	});
	let verification: CleanupOutcome["verification"] = isSafeGroup ? "unverified_no_group_kill" : "not_needed";
	const expected = { pgid: childPgid, birth: expectedBirth, command: expectedCommand };
	let signaled = false;

	// 0a. R-Q47-A：shared failure → 零信号收尾（不伪 childExited）。failure 谓词存在的
	// 理由恰是证据通道可能已损：判定后的 onLog 仍是后续 fallible IO —— 全部 failed()
	// 分支裸 return（零 onLog、零观察、零信号；remaining/exit 分支通道未损保留日志）。
	if (failed()) return failReturn();

	// 0. exit 已证 → 零信号直接返回（重新枚举不冒同代，residue 恒 unknown）
	if (childExited()) {
		onLog?.(`[bounded-runner] child exit 已证（exit 事件），零信号收尾；residue=unknown（组员无正证）`);
		return { cleanedPids: [], residue: "unknown", verification: isSafeGroup ? "unverified_no_group_kill" : "not_needed", signaled: false };
	}

	// 1. TERM：fallible 日志在 fresh 观察之前（日志抛错=保守失败收敛：零信号、停止余下
	//    fallible IO，不因 logger 坏去冒险处置）；观察后紧邻 remaining/exit 检查，检查与
	//    信号之间无任何日志或其它 fallible IO。
	let sameGeneration = false;
	let directVerified = false;
	if (failed()) return failReturn();
	onLog?.(`[bounded-runner] cleanup 开始：TERM 前 fresh 四正证核验 (pid=${childPid}, pgid=${childPgid ?? "-"}, safeGroup=${isSafeGroup})`);
	if (failed()) return failReturn();
	if (remaining() <= 0) {
		onLog?.(`[bounded-runner] cleanup 预算耗尽（TERM 前），零 spawn 零信号；residue=unknown`);
		return { cleanedPids: [], residue: "unknown", verification, signaled: false };
	}
	if (failed()) return failReturn();
	const termVerify = getProcInfo(childPid, psBudget(), deps);
	if (failed()) return failReturn();
	if (identityVerified(termVerify, expected)) {
		if (isSafeGroup && childPgid !== null) {
			sameGeneration = true;
			verification = "verified_same_generation";
		} else if (!isSafeGroup) {
			directVerified = true;
		} else {
			onLog?.(`[bounded-runner] 身份正证但组不安全（pgid=${termVerify!.pgid}），零信号；residue=unknown`);
			return { cleanedPids: [], residue: "unknown", verification, signaled: false };
		}
	} else {
		onLog?.(`[bounded-runner] 身份四正证未通过（${termVerify ? "字段不符" : "观察失败/预算耗尽"}），零信号；真实等待目标自身收尾，residue=unknown`);
		return { cleanedPids: [], residue: "unknown", verification, signaled: false };
	}
	// 临枪 fresh budget/exit check（identity 后、signal 前，无 IO 夹入）；failure 先拆独立
	// 裸返回
	if (failed()) return failReturn();
	if (remaining() <= 0 || childExited()) {
		onLog?.(`[bounded-runner] TERM 扳机前重查失败（预算耗尽或 exit 已证），零信号；residue=unknown`);
		return { cleanedPids: [], residue: "unknown", verification, signaled: false };
	}
	// 扳机：此处到 signal 之间无任何 fallible IO（日志已前置）
	if (sameGeneration && childPgid !== null) {
		try { signal(-childPgid, "SIGTERM"); signaled = true; } catch {}
	} else {
		try { signal(childPid, "SIGTERM"); signaled = true; } catch {}
	}
	cleaned.add(childPid);
	onLog?.(`[bounded-runner] SIGTERM 已发（${sameGeneration ? `组 -${childPgid}` : `直接子进程 ${childPid}`}，四正证）；进入有界 grace`);

	// 2. 有界 grace：从 TERM 之后起算（不是核验前的 start——观察耗时不得吃掉 grace）；
	//    每轮先查真实 exit；sleep=min(50, 剩余预算, grace 剩余)。对 leader 的观察失败
	//    （null/超时）先让出事件循环再查一次 exit（同步 ps 期间到达的 exit 事件不算
	//    观察失败），仍失败 → unknown → 终止信号链（不得 break 后无条件 KILL）。
	const graceEnd = now() + Math.min(graceMs, Math.max(0, remaining()));
	const graceRealEnd = performance.now() + graceMs; // 真实钟兜底：仅同幅防注入钟死锁，非第二预算
	let observationFailed = false;
	while (now() < graceEnd && performance.now() < graceRealEnd) {
		if (childExited()) break;
		if (failed()) break; // R-Q47-A：sleep 醒后/每轮先查 shared failure（停链）
		const budgetLeft = remaining();
		if (budgetLeft <= 0) break;
		if (failed()) break;
		const fresh = getProcInfo(childPid, psBudget(), deps);
		if (fresh === null || !identityVerified(fresh, expected)) {
			// 同步 ps 期间可能有 exit 事件排队：让出一个宏任务再查一次，避免把「已退出」
			// 误报成「观察失败」；仍未证 exit 才算观察失败/身份改变。
			await sleep(0);
			if (childExited() || failed()) break;
			observationFailed = true;
			break;
		}
		const sleepMs = Math.max(0, Math.floor(Math.min(50, remaining(), graceEnd - now())));
		if (sleepMs <= 0) break;
		await sleep(sleepMs);
		if (failed()) break; // sleep 醒后（R-Q47-A：grace await 是真实让位点）
	}
	if (failed()) return failReturn(); // 离开 grace：裸返回（零日志）
	if (childExited()) {
		onLog?.(`[bounded-runner] grace 中 exit 已证，停发一切后续信号（组/单 PID 都停）；residue=unknown`);
		return { cleanedPids: Array.from(cleaned), residue: "unknown", verification, signaled };
	}

	// 3. KILL：fallible 日志前置 → fresh 重核验（独立预算，不沿用 TERM 时刻结论）→
	//    紧邻 remaining/exit 检查 → 单发信号（扳机间无任何 fallible IO）。组模式单发
	//    -pgid KILL（不补冗余 direct 枪，避免第二枪打复用 PID）。exit 已证/观察失败/
	//    身份改变/预算耗尽 → 零信号。
	if (failed()) return failReturn();
	onLog?.(`[bounded-runner] grace 到点，KILL 前 fresh 重核验 (pid=${childPid})`);
	if (failed()) return failReturn();
	if (remaining() <= 0) {
		onLog?.(`[bounded-runner] cleanup 预算耗尽（KILL 前），零 spawn 零信号；residue=unknown`);
		return { cleanedPids: Array.from(cleaned), residue: "unknown", verification, signaled };
	}
	const killVerify = observationFailed ? null : getProcInfo(childPid, psBudget(), deps);
	if (failed()) return failReturn();
	if (!identityVerified(killVerify, expected)) {
		onLog?.(`[bounded-runner] KILL 扳机前 fresh 核验未通过（${observationFailed ? "grace 中观察失败" : killVerify ? "身份改变" : "观察失败/预算耗尽"}），零信号；residue=unknown`);
		return { cleanedPids: Array.from(cleaned), residue: "unknown", verification, signaled };
	}
	// 临枪 fresh budget/exit check（identity 后、signal 前，无 IO 夹入）；failure 先拆独立
	if (failed()) return failReturn();
	if (remaining() <= 0 || childExited()) {
		onLog?.(`[bounded-runner] KILL 扳机前重查失败（预算耗尽或 exit 已证），零信号；residue=unknown`);
		return { cleanedPids: Array.from(cleaned), residue: "unknown", verification, signaled };
	}
	// 扳机：此处到 signal 之间无任何 fallible IO（日志已前置）
	if (sameGeneration && childPgid !== null) {
		try { signal(-childPgid, "SIGKILL"); } catch {}
	} else {
		try { signal(childPid, "SIGKILL"); } catch {}
	}
	signaled = true;
	onLog?.(`[bounded-runner] SIGKILL 已发（${sameGeneration ? `组 -${childPgid}` : `直接子进程 ${childPid}`}，fresh 四正证通过）`);

	// 4. R43：无组员枚举 → 无 empty 证据通道，residue 恒 unknown；剩余等待由 runBounded
	//    的真实 close/总 deadline 承担（不在此处循环赌运气）。
	return { cleanedPids: Array.from(cleaned), residue: "unknown", verification, signaled };
}

export interface RunBoundedOptions {
	command: string[];
	timeoutMs?: number;
	graceMs?: number;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	stdio?: StdioOptions;
	runId?: string;
	onLog?: (msg: string) => void;
	/**
	 * CLI/调用方最终 fallible IO（如 CLI 结果行）。在全部库内 onLog 之后、新鲜预算
	 * check 之前执行 —— 总预算覆盖到最后一次证据 IO；此处抛错同样计入失败。
	 */
	finalizeIO?: (result: RunBoundedResult) => void;
	deps?: RunnerDeps;
}

export interface RunBoundedResult {
	exitCode: number;
	timedOut: boolean;
	/** 结算类别：natural_exit / killed_after_verified / unproven_unknown / spawn_failed */
	settlement: "natural_exit" | "killed_after_verified" | "unproven_unknown" | "spawn_failed";
	/** 收尾新鲜 check 发现超过总 deadline（sticky red：exitCode 翻 124 且不回绿） */
	overBudget: boolean;
	/** 兼容字段：runner 观测 wall（performance.now 单调，含启动核验与收尾） */
	wallTimeMs: number;
	/** exit 事件时点（真实 exit，不含 stdio drain） */
	actualExitWallMs: number | null;
	/** close/stdio 事件时点（nodeExitWallMs 为兼容别名） */
	closeWallMs: number | null;
	nodeExitWallMs: number | null;
	/** 最终采样（全部 finalizer IO 之后）；标注 runner_observed 非 OS exit wall */
	runnerWallMs: number;
	runnerWallKind: string;
	childPid: number;
	childPgid: number | null;
	groupVerified: boolean;
	actualExitCode: number | null;
	actualSignal: NodeJS.Signals | null;
	killVerification: "verified_same_generation" | "unverified_no_group_kill" | "not_needed";
	/** 组内残留：R43 起恒 unknown（组成员零枚举，绝不冒充 empty） */
	groupResidue: "unknown";
	cleanedPids: number[];
	/** 目标退出是否被真实 wait 证明（false=unproven_unknown） */
	targetExitProven: boolean;
	stdout?: string;
	stderr?: string;
}

export async function runBounded(opts: RunBoundedOptions): Promise<RunBoundedResult> {
	if (!opts.command || opts.command.length === 0) {
		throw new Error("runBounded 缺少 command 参数");
	}

	// R-Q47-B：t0 提前为函数首行——prelude 真实工作（runId/randomBytes/expectedCommand
	// join 等）全部计入预算原点，先取得同钟 deps 再立刻 t0。
	const deps0 = defaultDeps(opts.deps);
	const t0 = deps0.now();

	const timeoutMs = opts.timeoutMs ?? 900_000;
	const graceMs = opts.graceMs ?? 1500;
	const runId = opts.runId ?? `run-${Date.now()}-${randomBytes(4).toString("hex")}`;
	const onLog = opts.onLog;
	const deps = defaultDeps(opts.deps);
	const bin = opts.command[0]!;
	const args = opts.command.slice(1);
	// 身份锚：spawn 的完整 argv（ps command= 归一化后比对）
	const expectedCommand = opts.command.join(" ");

	// 严格时序：单调原点 + 两个 deadline 全部在 spawn 前预挂（覆盖 prelude）。
	// R47：target 预留自适应覆盖 grace+close+验证（KILL 升级在原 TOTAL 内可达，
	// 不让默认 grace 吃光固定 reserve 后把忽略 TERM 的目标永久退 unknown）。
	// t0 已在函数首行取得（R-Q47-B：prelude 真实工作计入预算原点）。
	const TOTAL = timeoutMs;
	const baseReserve = Math.min(1_500, Math.max(50, Math.floor(TOTAL * 0.2)));
	const RESERVE = Math.max(50, Math.min(TOTAL - 50, Math.max(baseReserve, graceMs + 3_000)));
	const totalDeadline = t0 + TOTAL;
	const targetDeadline = t0 + Math.max(50, TOTAL - RESERVE);
	const remainingToTotal = () => totalDeadline - deps.now();
	let targetFired = false;
	let totalFired = false;
	// R47：全失败路径 shared sticky failure（cleanup/回调 contain/finalizer/clear 失败共用）。
	const failureBox: { failed: boolean; err: unknown } = { failed: false, err: null };
	const stickyFail = (err: unknown): void => {
		if (!failureBox.failed) { failureBox.failed = true; failureBox.err = err; }
	};
	// 双 timer arm 在保护范围内：第 2 arm 抛则（经 finally）清已 arm 的第 1；clear 时两
	// timer 独立尝试、任一失败 sticky（不先标 cleared 后漏另一）；未 arm 的不调 clear。
	// R-Q47-C（真改布尔）：arm/clear 失败由布尔标志判定（不再 null sentinel + ??=）；err
	// 独立保留。throw null 不被吞：布尔置位即 sticky，末尾 reject 时把 null 包装成 Error。
	let targetTimer: unknown;
	let totalTimer: unknown;
	let armFailed = false;
	let armErr: unknown = null;
	try {
		targetTimer = deps.setTimeoutImpl(() => { targetFired = true; }, Math.max(0, targetDeadline - deps.now()));
	} catch (e) { armFailed = true; armErr = e; }
	try {
		totalTimer = deps.setTimeoutImpl(() => { totalFired = true; }, Math.max(0, TOTAL - (deps.now() - t0)));
	} catch (e) { armFailed = true; armErr = e; }
	if (armFailed) stickyFail(armErr); // 布尔置位即 sticky（err 可能为 null，末尾 reject 包装非空）
	let timersCleared = false;
	const clearTimersOnce = (): void => {
		if (timersCleared) return;
		timersCleared = true;
		let clearFailed = false;
		let clearErr: unknown = null;
		try { if (targetTimer !== undefined) deps.clearTimeoutImpl(targetTimer); } catch (e) { clearFailed = true; clearErr = e; }
		try { if (totalTimer !== undefined) deps.clearTimeoutImpl(totalTimer); } catch (e) { clearFailed = true; clearErr = e; }
		if (clearFailed) stickyFail(clearErr);
	};
	// 有界等待：零窗不建循环；每次 sleep ≤ 当前原绝对剩余；真实钟兜底仅同幅防注入钟死锁。
	const waitUntil = async (cond: () => boolean, deadlineAbs: number, realGuardMs: number): Promise<void> => {
		const realDeadline = performance.now() + Math.max(0, realGuardMs);
		for (;;) {
			if (cond()) return;
			const nowD = deps.now();
			if (nowD >= deadlineAbs) return;
			const realNow = performance.now();
			if (realNow >= realDeadline) return;
			const w = Math.floor(Math.min(25, deadlineAbs - nowD, realDeadline - realNow));
			if (!(w > 0)) return;
			await deps.sleep(w);
		}
	};
	try {
	// arm 失败在 try 内抛：经 finally 清已 arm 的第 1 个 timer（sticky 同构），不遗留。
	if (armErr !== null) throw armErr;
	// prelude/失败分支与主路径同一预算：无剩余零 spawn；启动日志是 fallible IO：抛错即失败。
	safeStartupLog();
	if (remainingToTotal() <= 0 || targetFired) {
		throw new Error(`[bounded-runner] 启动即预算耗尽（prelude 消费后剩余 ≤0），零 spawn`);
	}

	function safeStartupLog(): void {
		onLog?.(`[bounded-runner] [${runId}] 启动命令: ${bin} ${args.join(" ")} (总预算 ${TOTAL}ms, target ${Math.round(targetDeadline - t0)}ms, 预挂先于 spawn)`);
	}

	let timedOut = false;
	let actualExitCode: number | null = null;
	let actualSignal: NodeJS.Signals | null = null;
	let actualExitWallMs: number | null = null;
	let closeWallMs: number | null = null;
	let cleanedPids: number[] = [];
	let killVerification: CleanupOutcome["verification"] = "not_needed";
	const groupResidue: "unknown" = "unknown";
	let signaled = false;
	let spawnError: Error | null = null;
	// 真实退出事实（exit 事件驱动；cleanup 经 getter 读取，绝不传字面 false）。监听在
	// spawn 返回后立即注册（先于 validate/log），不遗漏事实。回调体 contain：deps.now/
	// onLog 抛错 → shared sticky failure + 准确 unknown，不让事件回调异常逃逸成 uncaught。
	let childExitedConfirmed = false;

	const spawnImpl = opts.deps?.spawnImpl ?? spawn;
	let child: ChildProcess;
	try {
		child = spawnImpl(bin, args, {
			detached: true,
			stdio: opts.stdio ?? "inherit",
			cwd: opts.cwd ?? process.cwd(),
			env: opts.env ?? process.env,
		});
	} catch (err) {
		// spawn 同步抛（fake/异常实现）：失败路径经 finally 收 timer
		throw err;
	}
	child.on("error", (err) => {
		try {
			spawnError = err;
			if (!failureBox.failed) onLog?.(`[bounded-runner] 子进程异常: ${String(err)}`);
		} catch (e) { stickyFail(e); }
	});
	child.on("exit", (code, sig) => {
		try {
			childExitedConfirmed = true;
			actualExitCode = code;
			actualSignal = sig;
			actualExitWallMs = deps.now() - t0;
		} catch (e) { stickyFail(e); }
	});
	child.on("close", (code, sig) => {
		try {
			if (actualExitCode === null && actualSignal === null) { actualExitCode = code; actualSignal = sig; }
			closeWallMs = deps.now() - t0;
		} catch (e) { stickyFail(e); }
	});

	const childPid = child.pid;
	if (!childPid) {
		// 未获得 PID（如 ENOENT）：不碰任何信号；等真实 error/close，钳在原 totalDeadline 内
		//（零窗不建等待循环；真实钟兜底仅同幅防注入钟死锁），到点按未证结算，finally 收 timer。
		const waitWindow = Math.max(0, Math.min(2_000, remainingToTotal()));
		await waitUntil(
			() => spawnError !== null || closeWallMs !== null || failureBox.failed,
			Math.min(totalDeadline, deps.now() + waitWindow),
			waitWindow,
		);
		throw spawnError ?? new Error(`子进程启动失败 (ENOENT 或未获得 PID): ${bin}`);
	}

	// 启动核验：ps 预算受剩余钳制（核验不能吃掉处置预算）
	const validation = validateProcessGroup(childPid, Math.max(0, Math.floor(targetDeadline - deps.now())), expectedCommand, opts.deps);
	// 核验/日志消耗后先判总剩余：过期直接显式 unknown（零处置/零等待/零 signal/不赠 budget）。
	const postValidateExhausted = remainingToTotal() <= 0 || totalFired;
	const childPgid = validation.childPgid;
	const isSafeGroup = postValidateExhausted ? false : validation.safe;
	const startBirth = validation.birth;
	if (postValidateExhausted) {
		onLog?.(`[bounded-runner] 启动核验后总预算耗尽：显式 unknown（零处置/零等待，资源 unknown）`);
	} else if (isSafeGroup) {
		onLog?.(`[bounded-runner] 进程组安全验证成功: PGID=${childPgid} birth=${startBirth ?? "unknown"}`);
	} else {
		onLog?.(`[bounded-runner] ⚠️ 进程组安全校验未通过: ${validation.reason ?? "未知"}；仅身份四正证时单进程维度管理`);
	}

	let stdoutData = "";
	let stderrData = "";
	if (child.stdout) {
		child.stdout.on("data", (d) => { if (stdoutData.length < 8 * 1024 * 1024) stdoutData += d; });
	}
	if (child.stderr) {
		child.stderr.on("data", (d) => { if (stderrData.length < 8 * 1024 * 1024) stderrData += d; });
	}

	// 等 target deadline 或自然退出，二者先到（每次 sleep ≤ 当前原绝对剩余；deps 驱动可全
	// fake；postValidate 耗尽分支零窗直落 unproven，不等待/不观察/signal）。
	if (postValidateExhausted) {
		await waitUntil(() => closeWallMs !== null, deps.now(), 0);
	} else {
	await waitUntil(
		() => targetFired || closeWallMs !== null || remainingToTotal() <= 0 || failureBox.failed,
		totalDeadline,
		TOTAL,
	);
	}

	timedOut = closeWallMs === null; // 到 target 仍未退出 = 超时处置路径

	if (timedOut && !postValidateExhausted && !failureBox.failed) {
		onLog?.(`[bounded-runner] ⚠️ target deadline 到点（剩余预算 ${Math.max(0, Math.floor(remainingToTotal()))}ms）：四正证 fresh 核验后才处置`);
		// cleanup 传原 absolute totalDeadline 同锚（不重锚赠调用时间）；内部每次观察前
		// 鲜采 floor(min(cap, currentRemaining))，耗尽即零信号；无任何 grace 扩展。
		let cleanRes: CleanupOutcome;
		try {
			cleanRes = await cleanupProcessGroup({
				childPid,
				childPgid,
				isSafeGroup,
				graceMs,
				onLog,
				budgetMs: Math.max(0, Math.floor(remainingToTotal())),
				absoluteDeadline: totalDeadline,
				expectedBirth: startBirth,
				expectedCommand,
				childExited: () => childExitedConfirmed,
				failure: () => failureBox.failed,
				deps: opts.deps,
			});
		} catch (err) {
			// cleanup 内 fallible IO 抛错：shared sticky failure——停所有剩余 fallible IO，
			// 不伪装安全结算（非零、不补杀），fresh 失败/时间后 finally 清 timer 再 reject。
			stickyFail(err);
			cleanRes = { cleanedPids: [], residue: "unknown", verification: "unverified_no_group_kill", signaled: false };
		}
		cleanedPids = cleanRes.cleanedPids;
		killVerification = cleanRes.verification;
		signaled = cleanRes.signaled;
		// 真实 wait 到 close 为止：钳在原 totalDeadline 内（零窗不建循环；真实钟兜底仅同幅
		// 防注入钟死锁）。仍未退出=unproven（不无限等、不补杀，资源 unknown）。
		if (closeWallMs === null && !failureBox.failed) {
			const closeWaitWindow = Math.max(0, Math.min(2_000, remainingToTotal()));
			// 原锚：min(totalDeadline, now+window)，不重锚赠时
			await waitUntil(
				() => closeWallMs !== null || failureBox.failed,
				Math.min(totalDeadline, deps.now() + closeWaitWindow),
				closeWaitWindow,
			);
		}
	} else if (postValidateExhausted) {
		// 启动核验后预算耗尽：零处置（无 cleanup/无 signal），直落 unproven。
		killVerification = "unverified_no_group_kill";
	} else {
		// 自然退出：不枚举、不碰已退出 leader 的组；residue 如实 unknown
		killVerification = "not_needed";
	}

	// ── 收尾：结算 → 全部 finalizer IO → 新鲜预算 check（sticky red）→ runnerWall 采样 → 清 timer ──
	const settled = closeWallMs !== null;
	let settlement: RunBoundedResult["settlement"];
	if (!settled) {
		settlement = "unproven_unknown";
	} else if (timedOut && signaled) {
		settlement = killVerification === "verified_same_generation" ? "killed_after_verified" : "unproven_unknown";
	} else {
		// 自然退出；或 target 到点瞬间恰好自退且零信号（不冒充 killed）
		settlement = "natural_exit";
	}

	// G4：cleanup 失败已置 failureBox → finalizerBox 初始化即 failed，后续 onLog/finalizeIO
	// 全部跳过（失败 sticky 停止所有剩余 fallible IO），fresh 失败/时间后 finally 清 timer 再 reject。
	const finalizerBox: { failed: boolean; err: unknown } = { failed: failureBox.failed, err: failureBox.err };
	const safeFinalizer = (io: () => void): void => {
		if (failureBox.failed || finalizerBox.failed) return; // 失败后停止其余 fallible IO
		try {
			io();
		} catch (err) {
			finalizerBox.failed = true;
			finalizerBox.err = err;
		}
	};

	// 最后证据/日志 IO（fallible evidence；全部在新鲜 check 之前）
	const wallBeforeFinalLog = deps.now() - t0;
	safeFinalizer(() =>
		onLog?.(`[bounded-runner] 执行完毕: settlement=${settlement}, target_exit=${settled ? `code=${actualExitCode ?? "signal:" + actualSignal}` : "unknown"}, timedOut=${timedOut}, kill=${killVerification}, residue=${groupResidue}, signaled=${signaled}, actualExitWall=${actualExitWallMs ?? "unknown"}ms, closeWall=${closeWallMs ?? "unknown"}ms, wallAtFinalLog=${Math.round(wallBeforeFinalLog)}ms`),
	);
	// 调用方最终 IO（如 CLI 结果行）——同样在新鲜 check 之前、计入总预算。snapshot 填
	// 已知状态（不含最终 sticky）：exitCode 为已知结算值（unproven/超时路径已知非 0），
	// overBudget 为当时已知值；wall 标注 pre_final_io，不是最终返回值。
	if (opts.finalizeIO) {
		const preKnownOverBudget = totalFired || deps.now() > totalDeadline;
		// 已知 overBudget 先取 124：child 实际 0 不得掩已超限（snapshot 与终值一致 sticky）。
		const preKnownExitCode = !settled || preKnownOverBudget ? 124 : timedOut && signaled ? 124 : actualExitCode ?? (actualSignal !== null ? 128 + (constants.signals[actualSignal] ?? 1) : 1);
		const snapshot: RunBoundedResult = {
			exitCode: preKnownExitCode,
			timedOut,
			settlement,
			overBudget: preKnownOverBudget,
			wallTimeMs: deps.now() - t0,
			actualExitWallMs,
			closeWallMs,
			nodeExitWallMs: closeWallMs,
			runnerWallMs: deps.now() - t0,
			runnerWallKind: "pre_final_io_wall_not_final_return",
			childPid,
			childPgid,
			groupVerified: isSafeGroup,
			actualExitCode,
			actualSignal,
			killVerification,
			groupResidue,
			targetExitProven: settled,
			cleanedPids,
			stdout: stdoutData || undefined,
			stderr: stderrData || undefined,
		};
		safeFinalizer(() => opts.finalizeIO!(snapshot));
	}

	// 新鲜预算 check（在全部 finalizer IO 之后；green->red sticky，只翻红不翻绿）
	const overBudget = totalFired || deps.now() > totalDeadline;

	let finalExitCode: number;
	if (!settled) {
		finalExitCode = 124; // unproven_unknown：非零 + 明确 unknown，不冒自然 settle
		actualExitCode = null;
		actualSignal = null;
	} else if (timedOut && signaled) {
		finalExitCode = 124; // GNU timeout 契约：超时处置路径恒 124（TERM/KILL 信号细节在字段里）
	} else if (overBudget) {
		finalExitCode = 124; // sticky red：真实 exit 保留在 actualExitCode，但结算超预算如实翻红
	} else if (actualExitCode !== null) {
		finalExitCode = actualExitCode;
	} else if (actualSignal !== null) {
		finalExitCode = 128 + (constants.signals[actualSignal] ?? 1);
	} else {
		finalExitCode = 1;
	}

	// runnerWall 采样：在全部 finalizer IO 之后（不早采样再 IO）
	const wallTimeMs = deps.now() - t0;
	const runnerWallMs = wallTimeMs;

	// timer 清理由 clearTimersOnce（幂等：正常末尾 + finally 兜底）承担：真实结算 + 全部 finalizer
	// （含失败收敛）之后、或任何 throw 路径；幂等不重复。

	const result: RunBoundedResult = {
		exitCode: finalExitCode,
		timedOut,
		settlement,
		overBudget,
		wallTimeMs,
		actualExitWallMs,
		closeWallMs,
		nodeExitWallMs: closeWallMs,
		runnerWallMs,
		runnerWallKind: "runner_observed_until_final_evidence_write_NOT_os_exit_wall",
		childPid,
		childPgid,
		groupVerified: isSafeGroup,
		actualExitCode,
		actualSignal,
		killVerification,
		groupResidue,
		targetExitProven: settled,
		cleanedPids,
		stdout: stdoutData || undefined,
		stderr: stderrData || undefined,
	};
	if (finalizerBox.failed) {
		throw finalizerBox.err ?? new Error("bounded-runner: sticky finalizer failure（hook 抛 null，布尔置位保留非空 reject）");
	}
	if (failureBox.failed) {
		throw failureBox.err ?? new Error("bounded-runner: sticky failure（hook 抛 null，布尔置位保留非空 reject）");
	}
	// 正常路径：clear 双 timer（任一失败 sticky → 非零，不冒成功返回）
	clearTimersOnce();
	if (failureBox.failed) {
		throw failureBox.err ?? new Error("bounded-runner: sticky failure（timer clear 抛 null，布尔置位保留非空 reject）");
	}
	return result;
	} finally {
	// 任何失败/返回路径统一兜底清已 arm timer（幂等）。
	clearTimersOnce();
}
}

// ── CLI 入口 ──────────────────────────────────────────────

function parseDuration(val: string): number {
	const lower = val.trim().toLowerCase();
	if (lower.endsWith("ms")) return parseInt(lower.slice(0, -2), 10);
	if (lower.endsWith("s")) return parseInt(lower.slice(0, -1), 10) * 1000;
	if (lower.endsWith("m")) return parseInt(lower.slice(0, -1), 10) * 60 * 1000;
	if (lower.endsWith("h")) return parseInt(lower.slice(0, -1), 10) * 3600 * 1000;
	const n = parseInt(lower, 10);
	if (!Number.isSafeInteger(n) || n <= 0) {
		throw new Error(`无法解析超时时间: ${val}`);
	}
	return n;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
	const rawArgs = process.argv.slice(2);
	let timeoutMs = 900_000;
	let runId: string | undefined;
	let cmdStartIndex = -1;

	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i]!;
		if (arg === "--timeout" && rawArgs[i + 1]) {
			timeoutMs = parseDuration(rawArgs[i + 1]!);
			i++;
		} else if (arg.startsWith("--timeout=")) {
			timeoutMs = parseDuration(arg.slice(10));
		} else if (arg === "--run-id" && rawArgs[i + 1]) {
			runId = rawArgs[i + 1]!;
			i++;
		} else if (arg === "--") {
			cmdStartIndex = i + 1;
			break;
		} else if (!arg.startsWith("-")) {
			cmdStartIndex = i;
			break;
		}
	}

	if (cmdStartIndex === -1 || cmdStartIndex >= rawArgs.length) {
		console.error("用法: node scripts/bounded-test-runner.ts [--timeout <duration>] <command> [args...]");
		process.exit(1);
	}

	const cmd = rawArgs.slice(cmdStartIndex);

	runBounded({
		command: cmd,
		timeoutMs,
		runId,
		stdio: "inherit",
		onLog: (msg) => {
			console.log(msg);
		},
		// CLI 最终 IO：经 finalizeIO 计入总预算（新鲜 check 之前）。wall 是 IO 前采样，
		// 如实标 wallAtCliLog；真实最终 wall 由回调后结果/外层 parent 实际 wait 给出，
		// 不为再打印 final wall 陷无穷 regress。
		finalizeIO: (res) => {
			console.log(`[bounded-runner] [CLI] target_exit=${res.targetExitProven ? `code=${res.actualExitCode ?? "signal:" + res.actualSignal}` : "unknown"} close=${res.closeWallMs !== null ? "observed" : "unknown"} settlement=${res.settlement} kill=${res.killVerification} residue=${res.groupResidue} signaled=${res.cleanedPids.length > 0 ? "yes" : "no"} actualExitWall=${res.actualExitWallMs ?? "unknown"}ms closeWall=${res.closeWallMs ?? "unknown"}ms wallAtCliLog=${Math.round(res.runnerWallMs)}ms(pre_final_io) exitCode=由进程退出码给出`);
		},
	})
		.then((res) => {
			process.exit(res.exitCode);
		})
		.catch((err) => {
			console.error(`[bounded-runner] 命令失败: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		});
}
