import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	createReadStream,
	existsSync,
	fdatasyncSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";

export type AuditKind =
	| "session.start"
	| "session.end"
	| "prompt"
	| "tool.call"
	| "tool.result"
	| "policy.verdict"
	| "approval.request"
	| "approval.decision"
	| "usage"
	| "repo.clone"
	| "git.push"
	| "error";

/** 写入方提供的字段；seq / at / prevHash / hash 由日志自己填，调用方无法覆盖 */
export interface AuditInput {
	kind: AuditKind;
	sessionId: string;
	/** 发起人（会话所属用户） */
	actor: string;
	/** 审批人，仅 approval.decision 有 —— 与 actor 分开记，二者常常不是同一个人 */
	approver?: string;
	repo?: string;
	team?: string;
	/** 人类可读的一行摘要，进 UI 与 SIEM */
	summary: string;
	/** 工具调用 id，用于把 tool.call 与 tool.result 配对，回放时不必靠 seq 邻近性猜 */
	callId?: string;
	tool?: string;
	path?: string;
	/**
	 * bash 命令原文。这是「只记 hash 不记原文」的**有意例外**，见类注释第 1 条。
	 * 写入前会截断，但**不做脱敏** —— 脱敏在模型网关那一层统一做。
	 */
	command?: string;
	verdict?: string;
	rule?: string;
	/** 工具参数的 sha256 —— 只存 hash，源码不出 Data Plane */
	argsHash?: string;
	/** 改动内容的 sha256 */
	diffHash?: string;
	ok?: boolean;
	exitCode?: number;
	durationMs?: number;
	/** token 计量。cacheRead 通常是大头，配额与计费都依赖它，不能只记总数 */
	tokensInput?: number;
	tokensOutput?: number;
	tokensCacheRead?: number;
	tokensCacheWrite?: number;
	tokensTotal?: number;
	cost?: number;
}

export interface AuditEntry extends AuditInput {
	schemaVersion: number;
	seq: number;
	at: string;
	prevHash: string;
	hash: string;
}

export interface VerifyResult {
	ok: boolean;
	/** 链尾 hash，用于外部锚定 */
	head?: string;
	lastSeq?: number;
	brokenAt?: number;
	reason?: string;
}

const GENESIS = "0".repeat(64);
const SCHEMA_VERSION = 1;
/** summary/command 的上界。超长条目会让重启时的尾部窗口读取失败 */
const MAX_TEXT = 4096;

/** 调用方可写的字段白名单 —— 用白名单而非展开，防止外部塞入 hash/seq 污染链 */
const INPUT_KEYS = [
	"kind",
	"sessionId",
	"actor",
	"approver",
	"repo",
	"team",
	"summary",
	"callId",
	"tool",
	"path",
	"command",
	"verdict",
	"rule",
	"argsHash",
	"diffHash",
	"ok",
	"exitCode",
	"durationMs",
	"tokensInput",
	"tokensOutput",
	"tokensCacheRead",
	"tokensCacheWrite",
	"tokensTotal",
	"cost",
] as const;

const TEXT_KEYS = new Set(["summary", "command", "path", "rule", "verdict"]);

/**
 * append-only 审计日志。
 *
 * 三条设计取舍，都与「Control Plane 只见元数据、永不见源码」这条铁律有关：
 *
 * 1. **只记元数据与 hash，不记源码内容 —— 但 `command` 是有意的例外。**
 *    工具参数与文件改动都以 sha256 落库：审计日志要导出到 SIEM，而 SIEM 往往
 *    在 Data Plane 边界之外，把 diff 原文写进去等于绕过自己的铁律。
 *    `command` 存原文，因为 SOC 分析师看到 `argsHash: 3f9a…` 什么也做不了，
 *    审计 bash 的全部价值就在于命令可读。**代价必须说清楚**：heredoc 写文件、
 *    `curl -H "Authorization: …"` 这类命令原文同样承载源码与凭据，这条路径
 *    与 argsHash 堵的是同一个洞。缓解手段是模型网关那一层的统一脱敏，
 *    不在本模块 —— 在此之前，导出 SIEM 前应视 command 为敏感字段。
 *    完整 transcript 留在 Data Plane 内的 pi session 文件里，回放时按 seq 对齐。
 *
 * 2. **同步写入并 fdatasync。** 「100% 工具调用有记录」是对客户的承诺，
 *    只写进 page cache 的记录在内核 panic 或节点驱逐时同样会丢。
 *    工具调用是每秒个位数的低频事件，这点开销买这个保证是划算的。
 *
 * 3. **哈希链 —— 它防的是什么，必须诚实说明。**
 *    链里没有密钥、没有外部锚点，算法就在开源代码里。因此它能发现
 *    「意外损坏」与「粗糙篡改」（改一条不重算后续、删掉中间一条），
 *    但**挡不住有文件写权限的攻击者** —— 那种攻击者可以从 genesis 重算整条链，
 *    也可以直接截断尾部把不利记录抹掉。安全白皮书里必须同口径表述，
 *    不要写成「防篡改」。
 *    要把它升级为真正的防恶意篡改，需要外部锚点：链头 hash 是纯元数据，
 *    按铁律 1 完全可以出 Data Plane —— 定期上报 Control Plane 存档，
 *    再用 verify(path, expectedHead) 比对。本模块提供了这个入口，
 *    上报由部署侧接。没有锚点时，verify 只回答「这份文件自身是否自洽」。
 */
export class AuditLog {
	#fd: number;
	#path: string;
	#lockPath: string;
	#seq: number;
	#prevHash: string;
	#closed = false;

	private constructor(path: string, lockPath: string, fd: number, seq: number, prevHash: string) {
		this.#path = path;
		this.#lockPath = lockPath;
		this.#fd = fd;
		this.#seq = seq;
		this.#prevHash = prevHash;
	}

	/**
	 * 打开或创建日志；已存在则从最后一条记录续接哈希链。
	 * 同一文件同时只允许一个写入者：seq 与 prevHash 是进程内状态，
	 * 两个 writer 会各自从 N+1 编号，把链写成不可恢复的分叉。
	 */
	static open(path: string): AuditLog {
		const lockPath = `${path}.lock`;
		acquireLock(lockPath);
		try {
			const tail = existsSync(path) ? readLastEntry(path) : null;
			const fd = openSync(path, "a");
			return new AuditLog(path, lockPath, fd, tail?.seq ?? 0, tail?.hash ?? GENESIS);
		} catch (err) {
			releaseLock(lockPath);
			throw err;
		}
	}

	get path(): string {
		return this.#path;
	}

	get lastSeq(): number {
		return this.#seq;
	}

	/** 链尾 hash —— 上报 Control Plane 存档后即可用于检测整链重写与尾部截断 */
	get head(): string {
		return this.#prevHash;
	}

	append(input: AuditInput): AuditEntry {
		const entry: AuditEntry = {
			...pickInput(input),
			schemaVersion: SCHEMA_VERSION,
			seq: this.#seq + 1,
			at: new Date().toISOString(),
			prevHash: this.#prevHash,
			hash: "",
		};
		const { hash: _drop, ...unhashed } = entry;
		entry.hash = sha256(canonicalize(unhashed));
		appendFileSync(this.#fd, `${JSON.stringify(entry)}\n`, "utf8");
		fdatasyncSync(this.#fd);
		this.#seq = entry.seq;
		this.#prevHash = entry.hash;
		return entry;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		closeSync(this.#fd);
		releaseLock(this.#lockPath);
	}

	/** 按 seq 顺序回放全部记录，可按会话过滤。损坏行抛出带行号的错误。 */
	static async *replay(path: string, sessionId?: string): AsyncGenerator<AuditEntry> {
		if (!existsSync(path)) return;
		const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Number.POSITIVE_INFINITY });
		let lineNo = 0;
		for await (const line of rl) {
			lineNo += 1;
			if (!line) continue;
			let entry: AuditEntry;
			try {
				entry = JSON.parse(line) as AuditEntry;
			} catch {
				rl.close();
				throw new CorruptLineError(lineNo);
			}
			if (!sessionId || entry.sessionId === sessionId) yield entry;
		}
	}

	/**
	 * 校验链的自洽性。传 expectedHead（来自 Control Plane 的存档）才能同时
	 * 检测出整链重写与尾部截断 —— 不传时这两种攻击都验不出来。
	 */
	static async verify(path: string, expectedHead?: string): Promise<VerifyResult> {
		if (!existsSync(path)) {
			// 「日志被整个删掉」与「日志完好」不能返回同一个结果
			return { ok: false, reason: "审计日志不存在" };
		}
		let prev = GENESIS;
		let expectedSeq = 1;
		try {
			for await (const entry of AuditLog.replay(path)) {
				if (entry.seq !== expectedSeq) {
					return { ok: false, brokenAt: entry.seq, reason: `序号不连续，期望 ${expectedSeq}` };
				}
				if (entry.prevHash !== prev) {
					return { ok: false, brokenAt: entry.seq, reason: "前序 hash 不匹配，中间有记录被删改" };
				}
				const { hash, ...rest } = entry;
				if (sha256(canonicalize(rest)) !== hash) {
					return { ok: false, brokenAt: entry.seq, reason: "本条内容被改动" };
				}
				prev = hash;
				expectedSeq += 1;
			}
		} catch (err) {
			if (err instanceof CorruptLineError) {
				return { ok: false, brokenAt: err.lineNo, reason: `第 ${err.lineNo} 行无法解析` };
			}
			throw err;
		}
		if (expectedHead && prev !== expectedHead) {
			return { ok: false, head: prev, lastSeq: expectedSeq - 1, reason: "链尾与外部锚点不符：整链被重写或尾部被截断" };
		}
		return { ok: true, head: prev, lastSeq: expectedSeq - 1 };
	}
}

export class CorruptLineError extends Error {
	lineNo: number;
	constructor(lineNo: number) {
		super(`审计日志第 ${lineNo} 行无法解析`);
		this.lineNo = lineNo;
	}
}

/** 内容的 sha256 —— 用于参数与 diff：只留证据，不留原文 */
export function contentHash(value: unknown): string {
	return sha256(canonicalize(value));
}

/**
 * 确定性序列化：递归排序 key、跳过 undefined、区分类型。
 *
 * 不能用 `JSON.stringify(v, Object.keys(v).sort())`：数组形式的 replacer 是
 * **递归作用于所有层级**的属性白名单，用顶层 key 生成的白名单会把嵌套对象里
 * 的字段静默剔除出哈希输入 —— 两条内容不同的记录会算出同一个 hash。
 */
function canonicalize(v: unknown): string {
	if (v === null || v === undefined) return "null";
	if (typeof v !== "object") return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
	const obj = v as Record<string, unknown>;
	const keys = Object.keys(obj)
		.filter((k) => obj[k] !== undefined)
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

function sha256(s: string): string {
	return createHash("sha256").update(s, "utf8").digest("hex");
}

/** 按白名单取字段并截断长文本，杜绝调用方污染链字段或写出超长行 */
function pickInput(input: AuditInput): AuditInput {
	const out: Record<string, unknown> = {};
	for (const key of INPUT_KEYS) {
		const v = input[key];
		if (v === undefined) continue;
		out[key] = TEXT_KEYS.has(key) && typeof v === "string" ? truncate(v) : v;
	}
	return out as unknown as AuditInput;
}

function truncate(s: string): string {
	return s.length <= MAX_TEXT ? s : `${s.slice(0, MAX_TEXT)}…[截断 ${s.length - MAX_TEXT} 字符]`;
}

function acquireLock(lockPath: string): void {
	try {
		writeFileSync(lockPath, String(process.pid), { flag: "wx" });
		return;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
	// 进程崩溃会留下锁文件。持有者已死则接管，否则拒绝启动。
	const holder = Number(readFileSync(lockPath, "utf8").trim());
	if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) {
		throw new Error(`审计日志已被 pid ${holder} 持有；同一文件不允许两个写入者，否则哈希链会分叉`);
	}
	writeFileSync(lockPath, String(process.pid));
}

function releaseLock(lockPath: string): void {
	try {
		unlinkSync(lockPath);
	} catch {
		// 已被清理，无需处理
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * 只读文件尾部，避免重启时把整份审计日志读进内存。
 * 窗口内找不到换行时逐步扩窗：条目字段虽已截断，仍不该由窗口大小决定能否启动。
 */
function readLastEntry(path: string): AuditEntry | null {
	const size = statSync(path).size;
	if (size === 0) return null;
	const fd = openSync(path, "r");
	try {
		for (let window = Math.min(size, 64 * 1024); ; window = Math.min(size, window * 4)) {
			const buf = Buffer.alloc(window);
			const read = readSync(fd, buf, 0, window, size - window);
			const text = buf.subarray(0, read).toString("utf8");
			const lines = text.split("\n").filter(Boolean);
			// 窗口未覆盖整个文件且没看到换行，说明最后一行比窗口还长
			if (lines.length <= 1 && window < size) continue;
			const last = lines.at(-1);
			if (!last) return null;
			try {
				return JSON.parse(last) as AuditEntry;
			} catch {
				// 崩溃可能留下半行。这里刻意不跳过：静默续接会让哈希链断口
				// 变得无法区分于事后删改，而「可完整回放」是对客户的承诺。
				throw new Error(`审计日志尾部损坏，需人工处理后再启动：${path}`);
			}
		}
	} finally {
		closeSync(fd);
	}
}
