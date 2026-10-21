/**
 * R-Q9c/R-Q9a：ps 身份 observer 与资源收尾 helper（纯注入式，生产代码不引用）。
 *
 * gone 语义（严格）：仅「ps 退出码 === 1 且 stdout/stderr 双空」在已验证 ps 实现下可判 gone；
 * error/signal/status=null/其它非零/status=0 但输出不完整或不可解析 → unknown（调用方必须失败并保留 ledger）。
 * zombie（stat Z）＝dead-but-unreaped：等待至正向 gone，deadline 仍 Z 则失败。
 * 复用判定：活 PID 的 ppid/pgid/birth 任一与登记代际身份不符，或 command 缺 marker → 明确 reuse（原进程消失）；
 * 完全一致才视为同一 owner 仍存活。身份不符绝不调用 kill（由调用方以注入 kill spy 断言）。
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

export interface PsRunResult {
	error?: Error;
	status: number | null;
	signal?: string | null;
	stdout: string;
	stderr: string;
}
export type PsRunner = (args: string[]) => PsRunResult;

export function realPsRunner(): PsRunner {
	return (args) => {
		const r = spawnSync("ps", args, { timeout: 3000, encoding: "utf8" });
		return { error: r.error, status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
	};
}

export interface ObservedIdentity {
	ppid: number;
	pgid: number;
	birth: string;
	command: string;
}

export type PsState =
	| { state: "gone" }
	| { state: "zombie"; identity: ObservedIdentity }
	| { state: "alive"; identity: ObservedIdentity }
	| { state: "unknown"; detail: string };

/** ps 单次观察（注入 runner）。字段布局：0=stat 1=ppid 2=pgid 3-7=lstart(5 token) 8+=command。 */
export function psIdentity(observer: PsRunner, pid: number): PsState {
	const r = observer(["-o", "stat=,ppid=,pgid=,lstart=,command=", "-p", String(pid)]);
	if (r.error) return { state: "unknown", detail: `ps 启动失败: ${r.error.message}` };
	if (r.signal) return { state: "unknown", detail: `ps 被信号终止: ${r.signal}` };
	if (r.status === null) return { state: "unknown", detail: "ps status=null（未知）" };
	if (r.status === 1) {
		if (r.stdout === "" && r.stderr.trim() === "") return { state: "gone" }; // 已验证 ps 实现下的权威 gone
		return { state: "unknown", detail: `ps exit1 但输出非空（stdout=${r.stdout.slice(0, 60)} stderr=${r.stderr.slice(0, 60)}）` };
	}
	if (r.status !== 0) return { state: "unknown", detail: `ps 非零退出 ${r.status}（非 gone 语义）` };
	const out = r.stdout.replace(/\n+$/, "");
	if (out === "") return { state: "unknown", detail: "ps status=0 空输出（无法区分消失/复用）" };
	const parts = out.split(/\s+/);
	if (parts.length < 9) return { state: "unknown", detail: `ps 输出 token 不足: ${out.slice(0, 100)}` };
	const stat = parts[0]!;
	const ppid = Number(parts[1]);
	const pgid = Number(parts[2]);
	const birth = parts.slice(3, 8).join(" ");
	const command = parts.slice(8).join(" ");
	if (!Number.isInteger(ppid) || !Number.isInteger(pgid) || birth === "" || command === "") {
		return { state: "unknown", detail: "ps 字段解析失败" };
	}
	const identity = { ppid, pgid, birth, command };
	if (stat.startsWith("Z")) return { state: "zombie", identity };
	return { state: "alive", identity };
}

export interface GenerationIdentity {
	ppid: number;
	pgid: number;
	birth: string;
	marker: string;
}

/** R-Q9c：代际身份有效性——PPID/PGID 必须为正整数、birth/marker 非空；无效＝观察未完成，不得参与 reuse 判定。 */
export function isCompleteGeneration(gen: GenerationIdentity | undefined | null): gen is GenerationIdentity {
	return gen !== undefined && gen !== null
		&& Number.isInteger(gen.ppid) && gen.ppid > 0
		&& Number.isInteger(gen.pgid) && gen.pgid > 0
		&& typeof gen.birth === "string" && gen.birth.trim() !== ""
		&& typeof gen.marker === "string" && gen.marker.trim() !== "";
}

/** R-Q9b：出生/父/组/birth/marker 全字段与登记代际比对，任一不同即非同一 owner。 */
export function matchesGeneration(identity: ObservedIdentity, gen: GenerationIdentity): boolean {
	return identity.ppid === gen.ppid && identity.pgid === gen.pgid && identity.birth === gen.birth && identity.command.includes(gen.marker);
}

export type GoneOutcome = "gone" | "gone-pid-reused";

/** 等待 owned PID 正向消失：gone/reuse 返回；Z 等到 ESRCH；unknown 立即抛（ledger 由回调记录）。 */
export async function waitOwnerGone(options: {
	observer: PsRunner;
	pid: number;
	generation: GenerationIdentity;
	nonce: string;
	deadlineMs: number;
	ledger: (event: Record<string, unknown>) => void;
	sleep?: (ms: number) => Promise<void>;
}): Promise<GoneOutcome> {
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const deadline = Date.now() + options.deadlineMs;
	for (;;) {
		const id = psIdentity(options.observer, options.pid);
		if (id.state === "gone") {
			options.ledger({ event: "inspect-gone", nonce: options.nonce, localpid: options.pid, outcome: "gone（PID 消失已证；owner 完整归属史不在本口径内）" });
			return "gone";
		}
		if (id.state === "unknown") {
			options.ledger({ event: "unknown", nonce: options.nonce, localpid: options.pid, outcome: WAIT_OWNER_GONE_OUTCOME_UNKNOWN });
			// R-Q10a：throw 经异常→test reporter→runner 日志落盘＝持久通道；只出固定类别+pid，
			// 绝不带 id.detail（ps stdout/stderr 切片＝被观察进程命令行）
			throw new Error(`pid ${options.pid} ps 观察 unknown（固定类别，raw detail 不入报告通道）`);
		}
		if (id.state === "zombie") {
			if (Date.now() > deadline) {
				options.ledger({ event: "inspect-gone", nonce: options.nonce, localpid: options.pid, outcome: "zombie-pending-reap", ppid: id.identity.ppid, pgid: id.identity.pgid, birth: id.identity.birth });
				throw new Error(`pid ${options.pid} 已死但 ${options.deadlineMs}ms 未收割（dead-but-unreaped，不得当 confirmed reaped）`);
			}
		} else if (id.state === "alive") {
			// R-Q9c：generation 无效/未初始化 → 活 owner 只能 unknown，绝不当已死/复用（协调者复现场景）
			if (!isCompleteGeneration(options.generation)) {
				options.ledger({ event: "unknown", nonce: options.nonce, localpid: options.pid, outcome: "generation 未采得/无效而 owner 存活——identity 未知，拒绝判 reuse/gone" });
				throw new Error(`pid ${options.pid} 活 owner 但 generation 未采得/无效——unknown（不得判已死/复用）`);
			}
			if (matchesGeneration(id.identity, options.generation)) {
				// 同一 owner 仍存活：继续轮询至 deadline
			} else if (id.identity.birth !== options.generation.birth) {
				// birth 真实可信不同：明确的 PID 复用（原进程消失）
				options.ledger({ event: "inspect-gone", nonce: options.nonce, localpid: options.pid, outcome: "gone-pid-reused（birth 不同）", ppid: id.identity.ppid, pgid: id.identity.pgid, birth: id.identity.birth });
				return "gone-pid-reused";
			} else {
				// 同 birth 但 PPID/PGID/marker 漂移：identity drift，非死亡证据 → unknown
				options.ledger({ event: "unknown", nonce: options.nonce, localpid: options.pid, outcome: "identity drift（同 birth，ppid/pgid/marker 变更）", ppid: id.identity.ppid, pgid: id.identity.pgid, birth: id.identity.birth });
				throw new Error(`pid ${options.pid} identity drift（同 birth 但父/组/marker 变更）——unknown，拒杀`);
			}
		}
		if (Date.now() > deadline) throw new Error(`pid ${options.pid} 未在 ${options.deadlineMs}ms 内正向消失`);
		await sleep(25);
	}
}

/** R-Q9d 收紧：docker inspect-gone 分类器（纯函数，fake CLI 负控用）。
 * gone 仅限整句已知错误：trim 后（大小写不敏感）恰为 `error: no such object: <fullCID>`；
 * status=0 且输出含同 CID → live（判失败）；error/signal/status null/status2/额外诊断/其它 CID → unknown。 */
export function classifyInspectGone(result: { error?: Error; status: number | null; signal?: string | null; stdout: string; stderr: string }, fullCid: string): "gone" | "live" | "unknown" {
	if (result.error || result.signal || result.status === null) return "unknown";
	if (result.status === 0) {
		return result.stdout.includes(fullCid) ? "live" : "unknown";
	}
	if (result.status === 1) {
		const trimmed = result.stderr.trim().toLowerCase();
		return trimmed === `error: no such object: ${fullCid.toLowerCase()}` ? "gone" : "unknown";
	}
	return "unknown";
}

/** R-Q9a：全量 settled 清理——每个 cleanup 都被执行并 await，错误聚合不吞（首个 throw 不跳过其余）。 */
export async function runAllCleanups(cleanups: readonly (() => Promise<void> | void)[]): Promise<Error | undefined> {
	const failedIndexes: number[] = [];
	for (const [i, cleanup] of cleanups.entries()) {
		try {
			await cleanup();
		} catch {
			failedIndexes.push(i + 1);
		}
	}
	if (failedIndexes.length === 0) return undefined;
	// R-Q10a：与 failures/throw 同类报告通道——聚合只出固定类别+索引+计数；
	// 失败原文（message/cause/stack/env/toJSON）经 test reporter 落盘＝持久通道，不拼入。
	// 全部 callback 均已执行、聚合恒 reject、计数保真，失败语义不削弱。
	return new Error(`cleanup 聚合失败（${failedIndexes.length}/${cleanups.length}）：失败步骤 #${failedIndexes.join(" #")}（raw 诊断不入报告通道）`);
}

// ─── R-Q9e：ledger 安全投影与白名单写入（纯测试 helper；生产代码不引用）───

/** 安全身份投影：只保留可审计字段（ppid/pgid/birth），command 仅以布尔匹配结果表达，
 *  绝不透传命令行原文（daemon serve --token <值> 属临时 RPC 凭据，不入证据文件）。 */
export function projectSafeIdentity(
	identity: ObservedIdentity,
	marker: string,
): { ppid: number; pgid: number; birth: string; commandMatchesMarker: boolean } {
	return {
		ppid: identity.ppid,
		pgid: identity.pgid,
		birth: identity.birth,
		commandMatchesMarker: identity.command.includes(marker),
	};
}

const LEDGER_ALLOWED_KEYS = ["event", "nonce", "localpid", "pgid", "ppid", "birth", "session", "container", "cid", "driver", "outcome", "time"] as const;

// R-Q9j/R-Q10a：waitOwnerGone unknown 持久化固定类别（detail 含 ps stdout/stderr 切片＝被观察进程命令行，
// 不入持久通道；throw 同理经 test reporter 落盘，只出固定类别+pid，不带 detail）
const WAIT_OWNER_GONE_OUTCOME_UNKNOWN = "unknown" as const;

// R-Q9g：outcome 精确允许枚举——生产路径全部固定类别；任意其它 string 一律映射 "unknown"
const OUTCOME_ALLOWED: ReadonlySet<string> = new Set([
	// docker-owned-ledger 生产值
	"creating", "created", "running", "driver-probed", "snapshot", "closing",
	"inspect-gone: gone", "inspect-gone: unknown",
	"driver-gone", "driver-gone-unknown", "driver 不可观测",
	// waitOwnerGone 生产值
	"gone（PID 消失已证；owner 完整归属史不在本口径内）", "zombie-pending-reap", WAIT_OWNER_GONE_OUTCOME_UNKNOWN,
	// R-Q10b：生产可达固定类别补全（此前缺失 7 串→落盘被 sanitizeOutcome 静默改写 unknown，归属标签坍缩）
	"generation 未采得/无效而 owner 存活——identity 未知，拒绝判 reuse/gone",
	"gone-pid-reused（birth 不同）",
	"identity drift（同 birth，ppid/pgid/marker 变更）",
	"inspect-gone: live",
	"driver-gone-pid-reused",
	// daemon-resource inspectIdentity 生产值（psIdentity state 为 gone/zombie/unknown 时 outcome=state）
	"gone", "zombie",
	// session-pin / daemon-resource 生产值
	"alive", "handle-close", "sigkill", "connection-close",
	"start-identity-alive", "start-identity-gone", "start-identity-zombie", "start-identity-unknown",
	"birth-observe-unknown", "birth-identity-mismatch", "track-failed", "unconfirmed-close", "dispose-observe-unknown",
	"daemon 归属发现异常——unconfirmed，已 close 不假 clean",
	"daemon 出生身份不可证——unconfirmed，已 close 不假 clean",
	"snapshot 迟到：cleanup 已启动（closed/unconfirmed），拒绝发布 ready",
	"dispose unconfirmed：pid/generation 未采得（观察未完成），如实失败不伪 clean",
]);

function sanitizeOutcome(value: unknown): string {
	if (typeof value !== "string") return "unknown";
	return OUTCOME_ALLOWED.has(value) ? value : "unknown";
}

const DRIVER_UNOBSERVABLE = "未找到 driver 进程" as const;

/** R-Q9g：driver 深投影——兼容 raw identity shape（{pid,identity:{ppid,pgid,birth,command,...}}）
 *  与已投影 shape（{pid?,ppid,pgid,birth,commandMatchesMarker}），只挑安全子字段；
 *  绝不透传嵌套 command/env/token/未知键。 */
function sanitizeDriverValue(value: unknown): unknown {
	if (typeof value === "string") return DRIVER_UNOBSERVABLE;
	if (!value || typeof value !== "object") return { unknown: DRIVER_UNOBSERVABLE };
	const obj = value as Record<string, unknown>;
	// R-Q10b 附注：driverProbe 不可观测分支的 {unknown:<串>} 形态——保固定安全类别，
	// 不返回空对象、不透传 raw 未知串（可能内嵌诊断文本）
	if (typeof obj.unknown === "string") return { unknown: DRIVER_UNOBSERVABLE };
	const nested = (obj.identity && typeof obj.identity === "object" ? obj.identity : obj) as Record<string, unknown>;
	const safe: Record<string, unknown> = {};
	if (typeof obj.pid === "number") safe.pid = obj.pid;
	for (const key of ["ppid", "pgid", "birth"] as const) {
		const v = nested[key];
		if (typeof v === "number" || typeof v === "string") safe[key] = v;
	}
	if (typeof obj.commandMatchesMarker === "boolean") safe.commandMatchesMarker = obj.commandMatchesMarker;
	return safe;
}

function sanitizeFieldValue(key: string, value: unknown): unknown {
	if (key === "outcome") return sanitizeOutcome(value);
	if (key === "driver") return sanitizeDriverValue(value);
	// session/container/cid/event/nonce/localpid/pgid/ppid/birth 为受控标量；数字/字符串原样，
	// 对象/数组/其它（嵌套结构不可入持久通道）一律安全占位
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return value;
	return "[sanitized-non-scalar]";
}

/** R-Q9e/g/i：ledger 白名单写入——顶层显式挑键 + driver/outcome 深投影与精确枚举
 *  （绝不透传嵌套 command/env/token/raw Error.message；未知 outcome 映射 "unknown"）；
 *  新文件创建时即 mode 0600（writeFileSync mode 选项＝ open O_CREAT mode，无 0644 窗口）；
 *  已存在文件保留现权限（POSIX 语义，不妄称改旧权限），函数返回实际权限处理记录。 */
export function appendLedgerEvent(
	filePath: string,
	event: Record<string, unknown>,
): { fileExisted: boolean; modeApplied: "new-0600" | "kept-existing" } {
	const safe: Record<string, unknown> = {};
	for (const key of LEDGER_ALLOWED_KEYS) {
		if (key in event) safe[key] = sanitizeFieldValue(key, event[key]);
	}
	safe.time = new Date().toISOString();
	const fileExisted = existsSync(filePath);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(safe)}\n`, { flag: "a", mode: 0o600 });
	return fileExisted ? { fileExisted: true, modeApplied: "kept-existing" } : { fileExisted: false, modeApplied: "new-0600" };
}

