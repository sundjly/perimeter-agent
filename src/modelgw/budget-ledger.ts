import { DatabaseSync } from "node:sqlite";

/**
 * S4b：模型网关持久预算账本（handoff §4.3 P0、coverage s4-persistent-budget）。
 *
 * 语义边界，一条都不能让：
 * - 每次上游操作一行：reserve（转发前原子预留）→ settle（真实 usage 结算，替换预留）/
 *   release（上游明确未接受：连接前失败、4xx 未计费；DLP 拦截的请求根本不进来）/
 *   usage_unknown（中止/断流/无 usage/超时：**保守保留预留**继续占额度，不写成 0、不自动重试）。
 * - 配额判定与插入在同一 BEGIN IMMEDIATE 事务内：并发预留被串行化判定，结构上不可能超卖。
 * - 额度占用口径：settled 行按真实 input+output；reserved/usage_unknown 行按 reserved_tokens；
 *   released 不占用。cache token 只入账本字段、不叠加占用（OpenAI 风格 prompt_tokens 已含
 *   cached，再加一遍就是双算 —— 见 server.ts readUsage 注释与 handoff §4.3）。
 * - 同一 operationId 永不重复记账：settle/release/usage_unknown 都是
 *   「reserved|usage_unknown → 终态」的单向迁移，终态再调用是幂等 no-op；
 *   operationId 由服务端生成（scoped jti:序号 或 UUID），客户端字符串不参与。
 * - 重启与恢复：文件账本（node:sqlite + WAL + synchronous=FULL）重开后已用量与在途
 *   预留原样还在；启动恢复把崩溃残留的 reserved 标为 usage_unknown（继续占额度、不释放，
 *   处置权在对账）—— 与 receipt-store「未终态标 unknown」同一哲学。
 * - 未配置 ledgerFile 时用 :memory:（同一代码路径，只是不跨进程存活），保持 demo 与
 *   既有测试行为；strictBudget=true 必须显式配 ledgerFile（server.ts 构造期强制）。
 * - 价格版本字段先落库（本轮模型目录价格全 0，MODELGW_PRICE_VERSION="0"）；
 *   真实价格/币种/账单口径属 S5，不在这轮假装有钱。
 */

/** 本轮价格版本：models.ts 目录价格全 0；字段与口径先落库，真实价格接入时递增 */
export const MODELGW_PRICE_VERSION = "0";

export type LedgerStatus = "reserved" | "settled" | "released" | "usage_unknown";

export interface UsageRecord {
	input: number;
	output: number;
	/** 按 provider 语义归一化后的 cache 读/写 token；只记录，不叠加进配额占用 */
	cacheRead?: number;
	cacheWrite?: number;
}

export interface ReserveRequest {
	/** 服务端生成（scoped jti:序号 或 UUID）；PRIMARY KEY —— 重复预留是程序错误，直接抛 */
	operationId: string;
	tenant: string;
	team: string;
	sessionId: string;
	model: string;
	upstream: string;
	/** 输入估计 + 最大输出（server.ts 估算口径），预留的占额度单位 */
	reservedTokens: number;
	priceVersion?: string;
}

export type ReserveOutcome = { ok: true } | { ok: false; used: number; quota: number };

export interface LedgerEntry {
	operationId: string;
	tenant: string;
	team: string;
	sessionId: string;
	model: string;
	upstream: string;
	priceVersion: string;
	reservedTokens: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	status: LedgerStatus;
	providerRequestId: string;
	createdAt: string;
	updatedAt: string;
}

const STATUSES: ReadonlySet<string> = new Set(["reserved", "settled", "released", "usage_unknown"]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS budget_entries (
	operation_id TEXT PRIMARY KEY,
	tenant TEXT NOT NULL,
	team TEXT NOT NULL,
	session_id TEXT NOT NULL,
	model TEXT NOT NULL,
	upstream TEXT NOT NULL,
	price_version TEXT NOT NULL,
	reserved_tokens INTEGER NOT NULL,
	input_tokens INTEGER NOT NULL DEFAULT 0,
	output_tokens INTEGER NOT NULL DEFAULT 0,
	cache_read_tokens INTEGER NOT NULL DEFAULT 0,
	cache_write_tokens INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL,
	provider_request_id TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_budget_team_status ON budget_entries(team, status);
`;

type Prepared = ReturnType<DatabaseSync["prepare"]>;

export class BudgetLedger {
	#db: DatabaseSync;
	#closed = false;
	#insert: Prepared;
	#settle: Prepared;
	#release: Prepared;
	#markUnknown: Prepared;
	#recover: Prepared;
	#committedByTeam: Prepared;
	#settledByTeam: Prepared;
	#byOperationId: Prepared;
	#list: Prepared;

	/**
	 * @param ledgerFile 持久账本文件（父目录必须已存在）；缺省 :memory:。
	 * 文件模式开 WAL + synchronous=FULL：进程崩溃后已提交事务不丢（WAL+NORMAL 只把掉电
	 * 窗口缩小，账本记的是钱，用 FULL），单写入者假设与 audit/stateRoot 同一口径。
	 */
	constructor(ledgerFile?: string) {
		this.#db = new DatabaseSync(ledgerFile ?? ":memory:", { timeout: 5000 });
		if (ledgerFile !== undefined) {
			this.#db.exec("PRAGMA journal_mode=WAL");
			this.#db.exec("PRAGMA synchronous=FULL");
		}
		this.#db.exec(SCHEMA);
		this.#insert = this.#db.prepare(
			`INSERT INTO budget_entries
				(operation_id, tenant, team, session_id, model, upstream, price_version, reserved_tokens,
				 input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, status, provider_request_id,
				 created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'reserved', '', ?, ?)`,
		);
		this.#settle = this.#db.prepare(
			`UPDATE budget_entries SET status='settled', input_tokens=?, output_tokens=?, cache_read_tokens=?,
			 cache_write_tokens=?, provider_request_id=?, updated_at=?
			 WHERE operation_id=? AND status IN ('reserved','usage_unknown')`,
		);
		this.#release = this.#db.prepare(
			`UPDATE budget_entries SET status='released', provider_request_id=?, updated_at=?
			 WHERE operation_id=? AND status IN ('reserved','usage_unknown')`,
		);
		this.#markUnknown = this.#db.prepare(
			`UPDATE budget_entries SET status='usage_unknown', provider_request_id=?, updated_at=?
			 WHERE operation_id=? AND status='reserved'`,
		);
		this.#recover = this.#db.prepare(
			`UPDATE budget_entries SET status='usage_unknown', updated_at=? WHERE status='reserved'`,
		);
		this.#committedByTeam = this.#db.prepare(
			// 占用口径：settled 按真实用量，reserved/usage_unknown 按预留；released 不占
			`SELECT COALESCE(SUM(CASE WHEN status='settled' THEN input_tokens + output_tokens
			                       ELSE reserved_tokens END), 0) AS used
			 FROM budget_entries WHERE team=? AND status IN ('settled','reserved','usage_unknown')`,
		);
		this.#settledByTeam = this.#db.prepare(
			`SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS used
			 FROM budget_entries WHERE team=? AND status='settled'`,
		);
		this.#byOperationId = this.#db.prepare(`SELECT * FROM budget_entries WHERE operation_id=?`);
		this.#list = this.#db.prepare(`SELECT * FROM budget_entries ORDER BY created_at DESC, operation_id DESC LIMIT ?`);
	}

	/**
	 * 原子预留：「已结算 + 在途预留 + 本次 ≤ quota」判定与插入在同一 IMMEDIATE 事务。
	 * quota 未配置（团队无配额）时只记账不设限 —— 记录每次操作是账本的第一职责。
	 */
	reserve(req: ReserveRequest, quota?: number): ReserveOutcome {
		this.#assertOpen();
		if (!Number.isSafeInteger(req.reservedTokens) || req.reservedTokens < 0) {
			throw new Error("预算账本：reservedTokens 必须是非负整数");
		}
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const used = this.#committed(req.team);
			if (quota !== undefined && used + req.reservedTokens > quota) {
				this.#db.exec("ROLLBACK");
				return { ok: false, used, quota };
			}
			const now = new Date().toISOString();
			this.#insert.run(req.operationId, req.tenant, req.team, req.sessionId, req.model, req.upstream,
				req.priceVersion ?? MODELGW_PRICE_VERSION, req.reservedTokens, now, now);
			this.#db.exec("COMMIT");
			return { ok: true };
		} catch (err) {
			try { this.#db.exec("ROLLBACK"); } catch { /* 事务已回滚或未开启 */ }
			throw err;
		}
	}

	/** 真实 usage 结算（替换预留）。幂等：已 settled 再调用不重复记账，返回 true。 */
	settle(operationId: string, usage: UsageRecord, providerRequestId = ""): boolean {
		this.#assertOpen();
		const res = this.#settle.run(usage.input, usage.output, usage.cacheRead ?? 0, usage.cacheWrite ?? 0,
			providerRequestId, new Date().toISOString(), operationId);
		if (Number(res.changes) > 0) return true;
		return this.#status(operationId) === "settled";
	}

	/** 上游明确未接受（连接前失败 / 4xx 未计费）→ 释放预留。幂等：已 released 返回 true。 */
	release(operationId: string, providerRequestId = ""): boolean {
		this.#assertOpen();
		const res = this.#release.run(providerRequestId, new Date().toISOString(), operationId);
		if (Number(res.changes) > 0) return true;
		return this.#status(operationId) === "released";
	}

	/** 中止/断流/无 usage/超时：reserved → usage_unknown，预留继续占额度。已 usage_unknown 幂等 true。 */
	markUsageUnknown(operationId: string, providerRequestId = ""): boolean {
		this.#assertOpen();
		const res = this.#markUnknown.run(providerRequestId, new Date().toISOString(), operationId);
		if (Number(res.changes) > 0) return true;
		return this.#status(operationId) === "usage_unknown";
	}

	/**
	 * 异步对账入口（handoff §4.3「异步对账后释放」）：给 usage_unknown/reserved 的操作补
	 * 真实 usage（结算）或确认未计费（释放）。本轮不接外部对账源，接口先立起来；
	 * settle/release 由请求路径内部调用，reconcile 面向运维/外部对账方。
	 */
	reconcile(operationId: string, outcome: UsageRecord | "release"): boolean {
		return outcome === "release" ? this.release(operationId) : this.settle(operationId, outcome);
	}

	/** 启动恢复：崩溃残留的 reserved 一律标 usage_unknown（继续占额度，不释放）。返回标记条数。 */
	recoverCrashReservations(): number {
		this.#assertOpen();
		return Number(this.#recover.run(new Date().toISOString()).changes);
	}

	/** 团队已占额度（配额口径）：settled 真实用量 + reserved/usage_unknown 在途预留 */
	committedTokens(team: string): number {
		this.#assertOpen();
		return this.#committed(team);
	}

	/** 团队已结算真实用量（计费/展示口径，不含在途预留） */
	settledTokens(team: string): number {
		this.#assertOpen();
		return Number((this.#settledByTeam.get(team) as { used: number }).used);
	}

	entry(operationId: string): LedgerEntry | undefined {
		this.#assertOpen();
		const row = this.#byOperationId.get(operationId) as Record<string, unknown> | undefined;
		return row ? toEntry(row) : undefined;
	}

	/** 运维/测试观测：最近 limit 条（新→旧） */
	listEntries(limit = 100): LedgerEntry[] {
		this.#assertOpen();
		return (this.#list.all(limit) as Record<string, unknown>[]).map(toEntry);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#db.close();
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("预算账本已关闭");
	}

	#committed(team: string): number {
		return Number((this.#committedByTeam.get(team) as { used: number }).used);
	}

	#status(operationId: string): LedgerStatus | undefined {
		const row = this.#byOperationId.get(operationId) as { status?: unknown } | undefined;
		return typeof row?.status === "string" && STATUSES.has(row.status) ? (row.status as LedgerStatus) : undefined;
	}
}

function toEntry(row: Record<string, unknown>): LedgerEntry {
	return {
		operationId: String(row.operation_id),
		tenant: String(row.tenant),
		team: String(row.team),
		sessionId: String(row.session_id),
		model: String(row.model),
		upstream: String(row.upstream),
		priceVersion: String(row.price_version),
		reservedTokens: Number(row.reserved_tokens),
		input: Number(row.input_tokens),
		output: Number(row.output_tokens),
		cacheRead: Number(row.cache_read_tokens),
		cacheWrite: Number(row.cache_write_tokens),
		status: String(row.status) as LedgerStatus,
		providerRequestId: String(row.provider_request_id),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}
