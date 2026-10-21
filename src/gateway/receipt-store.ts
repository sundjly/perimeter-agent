import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * S3b：显式创建收据（handoff §3.1）。
 *
 * 语义边界，一条都不能让：
 * - 收据先于外部副作用落盘（accepted 先写，再建工作区、起 harness）；
 *   目录存在不能证明任务完成，收据 stage 才是进度事实来源。
 * - 幂等键按 principal 作用域隔离：目录名 = principalId 的 sha256，
 *   客户端字符串（actor / operationId）永不直接参与路径拼接。
 * - 0600、tmp（唯一名）+ rename 原子写；同键并发写最后赢者完整可见，无半行。
 * - 崩溃恢复是读取方的职责：启动时未到终态的收据标 outcome_unknown ——
 *   不当成功、不自动重做外部副作用，处置权在运维。
 * - 保留期（TTL）可配置；过期收据由周期清理与读取时惰性删除共同移除，
 *   只删收据文件，不触碰任何活会话。TTL 过后同键 create 视为新创建。
 */

export type ReceiptStage = "accepted" | "workspace_ready" | "harness_ready" | "failed" | "outcome_unknown";
export type ReceiptOutcome = "pending" | "created" | "failed" | "unknown";

export interface CreateReceipt {
	/** 客户端幂等键（显式创建）；隐式创建为服务器生成的 auto- 前缀 */
	operationId: string;
	/** 创建者身份（demo=actor；production=issuer|subject）。按它哈希隔离 */
	principalId: string;
	/** 首次受理时服务器生成的请求标识，重放时原样返回 */
	requestId: string;
	/** 客户端内容指纹；缺省为空串（空内容）。同键不同值固定拒绝 */
	requestHash: string;
	sessionId: string;
	stage: ReceiptStage;
	outcome: ReceiptOutcome;
	createdAt: string;
	updatedAt: string;
}

/** 与 state-lock 同一口径：固定类别错误，不透传底层 errno/原文 */
export class CorruptReceiptError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CorruptReceiptError";
	}
}

/** 默认保留期 24h；过期后同键 create 视为新创建（幂等键不是永久的，部署方必须知道这一点） */
export const DEFAULT_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

const OPERATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HASH_OR_EMPTY = /^[A-Za-z0-9_-]{0,128}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STAGES: ReadonlySet<string> = new Set(["accepted", "workspace_ready", "harness_ready", "failed", "outcome_unknown"]);
const OUTCOMES: ReadonlySet<string> = new Set(["pending", "created", "failed", "unknown"]);
const NON_TERMINAL: ReadonlySet<string> = new Set(["accepted", "workspace_ready"]);

function sha256hex(s: string): string {
	return createHash("sha256").update(s, "utf8").digest("hex");
}

function expired(receipt: CreateReceipt, ttlMs: number, now = Date.now()): boolean {
	const at = Date.parse(receipt.updatedAt);
	return Number.isFinite(at) && now - at > ttlMs;
}

/** 解析并校验形状；任何字段缺失/类型不符都算损坏（不部分恢复） */
function parseReceipt(raw: string): CreateReceipt {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		throw new CorruptReceiptError("创建收据无法解析");
	}
	const str = (v: unknown): v is string => typeof v === "string";
	if (
		!str(parsed.operationId) || !OPERATION_ID.test(parsed.operationId) ||
		!str(parsed.principalId) || parsed.principalId.length === 0 || parsed.principalId.length > 512 ||
		!str(parsed.requestId) || parsed.requestId.length === 0 || parsed.requestId.length > 128 ||
		!str(parsed.requestHash) || !HASH_OR_EMPTY.test(parsed.requestHash) ||
		!str(parsed.sessionId) || !SESSION_ID.test(parsed.sessionId) ||
		!str(parsed.stage) || !STAGES.has(parsed.stage) ||
		!str(parsed.outcome) || !OUTCOMES.has(parsed.outcome) ||
		!str(parsed.createdAt) || !Number.isFinite(Date.parse(parsed.createdAt)) ||
		!str(parsed.updatedAt) || !Number.isFinite(Date.parse(parsed.updatedAt))
	) {
		throw new CorruptReceiptError("创建收据字段不完整或形状非法");
	}
	return parsed as unknown as CreateReceipt;
}

export class ReceiptStore {
	#root: string;
	#ttlMs: number;

	constructor(stateRoot: string, ttlMs: number = DEFAULT_RECEIPT_TTL_MS) {
		if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("receiptTtlMs 必须为正整数");
		this.#ttlMs = ttlMs;
		this.#root = join(stateRoot, "receipts");
		mkdirSync(this.#root, { recursive: true, mode: 0o700 });
		try { chmodSync(this.#root, 0o700); } catch { /* 刚以 0700 创建；chmod 兜底失败不影响语义 */ }
	}

	#dir(principalId: string): string {
		return join(this.#root, sha256hex(principalId));
	}

	#path(principalId: string, operationId: string): string {
		// 纵深防御：即使上游校验被绕过，这里也不给路径注入留口子
		if (!OPERATION_ID.test(operationId)) throw new CorruptReceiptError("operationId 字符集非法（固定类别）");
		return join(this.#dir(principalId), `${operationId}.json`);
	}

	/** 原子写：0600 + 唯一 tmp 名 + rename。并发同键写互不覆盖半行 */
	save(receipt: CreateReceipt): void {
		const dir = this.#dir(receipt.principalId);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const path = this.#path(receipt.principalId, receipt.operationId);
		const tmp = join(dir, `.${receipt.operationId}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
		writeFileSync(tmp, JSON.stringify(receipt), { mode: 0o600 });
		renameSync(tmp, path);
		try { chmodSync(path, 0o600); } catch { /* 刚以 0600 写入；chmod 兜底失败不影响语义 */ }
	}

	/**
	 * 读取收据。不存在返回 undefined；已过期则惰性删除并按不存在处理（只删收据，
	 * 不影响该收据指向的会话）；损坏抛 CorruptReceiptError，调用方必须 fail-closed，
	 * 绝不能把「读不到」与「损坏」混同 —— 后者按不存在处理会为同一键创建第二个会话。
	 */
	load(principalId: string, operationId: string): CreateReceipt | undefined {
		const path = this.#path(principalId, operationId);
		if (!existsSync(path)) return undefined;
		const receipt = parseReceipt(readFileSync(path, "utf8"));
		if (expired(receipt, this.#ttlMs)) {
			try { unlinkSync(path); } catch { /* 已被周期清理 */ }
			return undefined;
		}
		return receipt;
	}

	#allFiles(suffix: ".json" | ".tmp"): { dir: string; file: string }[] {
		const out: { dir: string; file: string }[] = [];
		let dirs: string[];
		try {
			dirs = readdirSync(this.#root);
		} catch {
			return out;
		}
		for (const dir of dirs) {
			const full = join(this.#root, dir);
			let files: string[];
			try {
				files = readdirSync(full);
			} catch {
				continue;
			}
			for (const file of files) if (file.endsWith(suffix)) out.push({ dir: full, file });
		}
		return out;
	}

	/**
	 * 启动恢复：上次进程留下的未终态收据标 outcome_unknown。返回被标记的收据供审计。
	 * 收据损坏 → 抛出（调用方在构造期，fail-closed 拒绝启动，交运维处理）。
	 */
	recoverNonTerminal(): CreateReceipt[] {
		const marked: CreateReceipt[] = [];
		for (const { dir, file } of this.#allFiles(".json")) {
			const path = join(dir, file);
			const receipt = parseReceipt(readFileSync(path, "utf8"));
			if (!NON_TERMINAL.has(receipt.stage)) continue;
			receipt.stage = "outcome_unknown";
			receipt.outcome = "unknown";
			receipt.updatedAt = new Date().toISOString();
			// S3c（round-1 notes）：标记写改原子 tmp+rename——与 save() 同一写路径；标记中途
			// 崩溃不再产生半行损坏收据（旧实现直接 writeFileSync 原文件，损坏后 fail-closed 拒启）
			const tmp = join(dir, `.${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
			writeFileSync(tmp, JSON.stringify(receipt), { mode: 0o600 });
			renameSync(tmp, path);
			try { chmodSync(path, 0o600); } catch { /* 刚以 0600 写入；chmod 兜底失败不影响语义 */ }
			marked.push(receipt);
		}
		return marked;
	}

	/**
	 * TTL 清理：删除过期收据与残留的 tmp 半成品；损坏文件跳过不删（留给运维），
	 * 只动收据文件，绝不触碰会话/工作区。返回删除数量。
	 */
	sweepExpired(): number {
		let removed = 0;
		for (const { dir, file } of this.#allFiles(".json")) {
			const path = join(dir, file);
			let receipt: CreateReceipt;
			try {
				receipt = parseReceipt(readFileSync(path, "utf8"));
			} catch {
				continue; // 损坏收据不自动清理，fail-visible 交运维
			}
			if (!expired(receipt, this.#ttlMs)) continue;
			try {
				unlinkSync(path);
				removed++;
			} catch { /* 已被并发清理 */ }
		}
		// 崩溃可能留下唯一名 tmp 半成品（rename 未及执行）：同为过期即清
		for (const { dir, file } of this.#allFiles(".tmp")) {
			if (!file.startsWith(".")) continue;
			const path = join(dir, file);
			try {
				const mtime = statSync(path).mtimeMs;
				if (Date.now() - mtime > this.#ttlMs) unlinkSync(path);
			} catch { /* 已消失 */ }
		}
		return removed;
	}
}
