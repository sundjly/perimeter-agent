import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable, type Transform } from "node:stream";
import { createGunzip } from "node:zlib";
import type { AuditLog } from "../audit/log.ts";
import {
	GrantError,
	assertMasterKey,
	isSha1,
	isValidRefname,
	refGlobMatch,
	verifyGrant,
	type GrantClaims,
} from "./grants.ts";
import { CMD_BAND_MAX_BYTES as HEADER_BAND_MAX_BYTES, PktHeaderScanner, createIdentityForward, parsePktCommands } from "./receive-pack.ts";
import { DeadlineError, DeadlineReadGate, armDeadlineTimer, disarmDeadlineTimer } from "./bounded-reader.ts";
import { ByteBudget } from "./byte-budget.ts";

/** R72-c：session-miss 立即重拉快照的最小间隔（另有单飞在途锁）——防未登记 grant 放大打 registry */
const MISS_REFRESH_MIN_INTERVAL_MS = 1_000;
/** R74-v3：限流窗内等待上限（复用单飞收敛后重拉；单请求最多额外等待约 1s） */
const MISS_REFRESH_MAX_WAIT_MS = 1_200;

export interface RepoMapping {
	/** 沙箱侧使用的名字，出现在 git remote 里 */
	name: string;
	/** 真实上游仓库地址，如 https://gitlab.internal/team/app.git */
	upstream: string;
	/** 上游凭据。**只存在于代理，永不进沙箱** */
	username?: string;
	token?: string;
	/**
	 * 是否允许推送。**默认否** —— 必须显式写 true。
	 *
	 * 方向是有意的：代理持有组织级凭据，push 又是不可逆操作。
	 * 默认可写意味着部署者漏配一个仓库，agent 就能往它推东西；
	 * 默认只读的代价只是多写一行配置，而且写的时候人会意识到自己在授权。
	 */
	allowPush?: boolean;
}

/** 签发方（网关）内部登记端点快照（合同 A6） */
export interface RegistrySnapshot {
	epoch: string;
	activeSessions: Record<string, { principal: string; tenant: string; repo: string; aclVersion: number }>;
	revokedJtis: string[];
}

export interface GitProxyConfig {
	port: number;
	host: string;
	/** R49：运行模式。production 下 legacySessionToken/缺 registry 一律构造期抛错（fail-closed） */
	mode: "production" | "dev";
	/** HMAC masterKey（≥32B），与网关同源部署 Secret；必须与既有三 token 互异 */
	masterKey: Buffer | string;
	/** 签发方活会话登记端点（合同 A6）；production 必填 */
	registry?: {
		url: string;
		/** internalToken：Bearer header 携带；production 拒绝 query 传 token */
		internalToken: string;
		/** 轮询间隔 ms，必须 1..5000 正整数（授权 age 上限是独立常量 5s，不随 poll 缩放） */
		pollMs: number;
	};
	/**
	 * dev 显式兼容字段：旧 fixtures 的静态共享 token。production 构造期即抛。
	 * 它没有任何吊销/scope 语义，只服务于本地兼容期。
	 */
	legacySessionToken?: string;
	repos: RepoMapping[];
	audit?: AuditLog;
	fetchImpl?: typeof fetch;
	/** 可注入 signal 工厂（每 fetch 预算）；缺省才用原生 AbortSignal.timeout（R-Q50-12 纯度口径） */
	signalTimeoutImpl?: (ms: number) => AbortSignal;
	/** R55-D：header 截止 owned timer 注入（纯 unit 假钟/fake timer；缺省 native） */
	deadlineTimerImpl?: (fn: () => void, ms: number) => unknown;
	/** deadlineTimerImpl 的配对清除 */
	deadlineClearTimerImpl?: (timer: unknown) => void;
	/**
	 * R55-D/H receive 有限边界（全部可选；缺省即硬默认；ctor 校验正整数且不超过硬上限——
	 * header 10s/压缩 8MiB/raw 128MiB/decoded 512MiB/body 120s，上限见 RECEIVE_LIMIT_CEILINGS）。
	 */
	receiveLimits?: {
		headerDeadlineMs?: number;
		headerCompressedCapBytes?: number;
		maxRawBodyBytes?: number;
		maxDecodedBytes?: number;
		bodyDeadlineMs?: number;
	};
	/** 测试注入：registry 拉取函数（默认 fetch + 严格状态/body bounds） */
	registryFetchImpl?: typeof fetch;
	/** 测试注入：时钟（ms epoch） */
	nowImpl?: () => number;
}

/** git smart HTTP 只有这三类端点 */
const UPLOAD_PACK = "/git-upload-pack";
const RECEIVE_PACK = "/git-receive-pack";
const INFO_REFS = "/info/refs";
const REGISTRY_POLL_MAX_MS = 5_000; // pollMs 配置上限（轮询频率，不再等同于授权 age）
const REGISTRY_MAX_AUTH_AGE_MS = 5_000; // R-Q50-8：production 授权快照 age 上限（独立常量）
const REGISTRY_FETCH_BUDGET_MS = 2_000; // 每轮 fetch 预算（signal timeout，独立于 age/poll）
const REGISTRY_FETCH_MARGIN_MS = 1_000; // 调度早于 age 到期的真实裕量
const REGISTRY_MAX_STALE_MS = 30_000; // 轮询失败沿用旧快照的最长时间；超期 fail-closed 全拒
const REGISTRY_BODY_MAX_BYTES = 1 * 1024 * 1024; // registry 响应体上限
/** R55-D/H receive 有限默认与硬上限（生产 ctor 可配但封顶；别把正常 PACK 按 64KiB header 拒） */
const RECEIVE_LIMIT_CEILINGS = {
	headerDeadlineMs: 60_000,
	headerCompressedCapBytes: 64 * 1024 * 1024,
	maxRawBodyBytes: 1024 * 1024 * 1024,
	maxDecodedBytes: 4 * 1024 * 1024 * 1024,
	bodyDeadlineMs: 600_000,
};
const RECEIVE_LIMIT_DEFAULTS = {
	headerDeadlineMs: 10_000,
	headerCompressedCapBytes: 8 * 1024 * 1024,
	maxRawBodyBytes: 128 * 1024 * 1024,
	maxDecodedBytes: 512 * 1024 * 1024,
	bodyDeadlineMs: 120_000,
};
export const CMD_BAND_MAX_BYTES = 64 * 1024; // receive-pack 命令区缓冲上限（B6：超限 413，上游零写入；扫描器用 HEADER_BAND_MAX_BYTES 同值）
// R55-D/H：header 压缩侧/截止已迁 #limits（可配+硬上限封顶；缺省 8MiB/10s 见 RECEIVE_LIMIT_DEFAULTS）
const ZERO_SHA = "0".repeat(40);

/**
 * Git 凭据代理 —— 铁律 2「凭据永不进沙箱」的落地 + B2 scoped grant 验证层。
 *
 * R49 起：访问凭证不再是共享静态 token，而是网关签发的六维 scoped grant
 * （session/repo/rw/writeRefs/exp/jti，见 ./grants.ts）。授权五元组全部来自：
 * 服务端签发的 claims、服务端配置的 RepoMapping、服务端活会话登记快照——
 * **客户端请求头（x-perimeter-*）不进入任何授权判定，也不进入审计 identity**。
 *
 * 能力凭证的诚实边界（措辞合同）：grant 串可被盗用，本层没有 PoP；承诺的是
 * scope 最小化、jti+活会话登记拒跨用、吊销在 ≤min(pollMs, maxAuthAge−1s)（R76/R2：
 * pollMs 必填且真实驱动轮询节奏，无默认；轮询失败旧快照沿用最长 maxStale 30s）有界窗口内
 * 失效。禁止“无 token/不可盗用/立即失效”类措辞。
 *
 * 写面授权依据 = receive-pack 命令区自描述（B6：上游写之前全量预校验）；
 * 读面 = repo 级全 refs 透传（B5①：ref 级读控制代理层不可安全交付，不做）。
 * force push 由上游 denyNonFastForwards + git push* 四眼审批门负责（C1），
 * 代理不判 force、也无法把 HTTP 流绑定到某条审批记录——如实边界。
 */
export class GitCredentialProxy {
	#cfg: GitProxyConfig;
	#http = createServer();
	#fetch: typeof fetch;
	#registryFetch: typeof fetch;
	#now: () => number;
	/** 快照 age 单调钟（performance.now）；#now（wall）仅用于 grant exp 对比 */
	#mono: () => number = () => performance.now();
	#snapshot: RegistrySnapshot | null = null;
	#snapshotAtMono = -Infinity; // 快照age用单调钟（performance.now），grant exp 对比才用 wall
	#pollTimer: NodeJS.Timeout | null = null;
	#polling = false;
	#closed = false;
	/** R-Q50-8：production 授权快照 age 上限=5s 常量（独立于 pollMs）；dev 30s 仅低保障不进 allow */
	#maxAuthAgeMs: number;
	/** R55-D/H receive 有限边界（ctor 校验后落定，含硬上限封顶） */
	#limits: {
		headerDeadlineMs: number;
		headerCompressedCapBytes: number;
		maxRawBodyBytes: number;
		maxDecodedBytes: number;
		bodyDeadlineMs: number;
	};
	/** 每轮 registry fetch 预算（AbortSignal + 发布判定共锚）；可注入避免纯 unit 藏原生 timer */
	#signalTimeoutImpl: (ms: number) => AbortSignal;

	/** R72-c：session-miss 立即重拉快照的限流（单飞 + 最小间隔 1s，防未登记 grant 放大打 registry） */
	#missRefreshInFlight = false;
	#missRefreshNotBeforeMono = 0;

	constructor(cfg: GitProxyConfig) {
		this.#cfg = cfg;
		this.#fetch = cfg.fetchImpl ?? fetch;
		this.#registryFetch = cfg.registryFetchImpl ?? this.#fetch;
		this.#now = cfg.nowImpl ?? (() => Date.now());
		this.#mono = cfg.nowImpl ?? (() => performance.now()); // 测试注入时同锚
		this.#signalTimeoutImpl = cfg.signalTimeoutImpl ?? ((ms: number) => AbortSignal.timeout(ms));
		// H5：运行时 validate 不是 TS interface —— mode 严格二值、masterKey 实调、
		// poll/limits 正整数、internalToken 真实类型/强度、readRefs 部署面任何出现即拒。
		if (cfg.mode !== "production" && cfg.mode !== "dev") {
			throw new Error("mode 必须显式为 production 或 dev（缺省/未知值不落 dev 默认）");
		}
		assertMasterKey(cfg.masterKey);
		if (cfg.registry) {
			const poll = cfg.registry.pollMs;
			if (typeof poll !== "number" || !Number.isSafeInteger(poll) || poll <= 0 || poll > REGISTRY_POLL_MAX_MS) {
				throw new Error(`registry.pollMs 必须为 1..${REGISTRY_POLL_MAX_MS} 的正整数（拒 NaN/0/浮点/负值退化忙 poll）`);
			}
			if (typeof cfg.registry.internalToken !== "string" || cfg.registry.internalToken.length < 16) {
				throw new Error("registry.internalToken 必须为字符串且 ≥16 字符");
			}
		}
		// readRefs 在部署配置任何出现（含空数组）都明确拒：ref 级读控制代理层不可交付（B5②），
		// 不能被签成 repo 全读。同时拒已知不支持的部署面字段。
		const cfgProbe = cfg as unknown as Record<string, unknown>;
		if ("readRefs" in cfgProbe || "writeGlob" in cfgProbe) {
			throw new Error("部署配置含不支持的读控制字段（readRefs/writeGlob）：明确拒，不静默忽略");
		}
		for (const r of cfg.repos ?? []) {
			const probe = r as unknown as Record<string, unknown>;
			if ("readRefs" in probe || "writeGlob" in probe) {
				throw new Error(`repo 条目含不支持字段（readRefs/writeGlob）：明确拒`);
			}
		}
		// A7：production fail-closed —— legacy token / 缺 registry 一律构造期抛错
		if (cfg.mode === "production") {
			if (cfg.legacySessionToken !== undefined) throw new Error("production 模式禁止 legacySessionToken（共享 token 无 scope/吊销语义）");
			if (!cfg.registry) throw new Error("production 模式必须配置 registry（活会话登记端点）");
		}
		this.#maxAuthAgeMs = cfg.mode === "production" ? REGISTRY_MAX_AUTH_AGE_MS : 30_000;
		// R55-D/H：receive 边界校验（正整数 + 硬上限封顶；有限默认已论证，生产可配不封死）
		const rl = cfg.receiveLimits ?? {};
		const bounded = (v: number | undefined, dflt: number, ceiling: number): number => {
			if (v === undefined) return dflt;
			if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0 || v > ceiling) {
				throw new Error(`receiveLimits 超出有限范围（正整数且 ≤${ceiling}）`);
			}
			return v;
		};
		this.#limits = {
			headerDeadlineMs: bounded(rl.headerDeadlineMs, RECEIVE_LIMIT_DEFAULTS.headerDeadlineMs, RECEIVE_LIMIT_CEILINGS.headerDeadlineMs),
			headerCompressedCapBytes: bounded(rl.headerCompressedCapBytes, RECEIVE_LIMIT_DEFAULTS.headerCompressedCapBytes, RECEIVE_LIMIT_CEILINGS.headerCompressedCapBytes),
			maxRawBodyBytes: bounded(rl.maxRawBodyBytes, RECEIVE_LIMIT_DEFAULTS.maxRawBodyBytes, RECEIVE_LIMIT_CEILINGS.maxRawBodyBytes),
			maxDecodedBytes: bounded(rl.maxDecodedBytes, RECEIVE_LIMIT_DEFAULTS.maxDecodedBytes, RECEIVE_LIMIT_CEILINGS.maxDecodedBytes),
			bodyDeadlineMs: bounded(rl.bodyDeadlineMs, RECEIVE_LIMIT_DEFAULTS.bodyDeadlineMs, RECEIVE_LIMIT_CEILINGS.bodyDeadlineMs),
		};
		if (cfg.registry) {
			this.#startPolling();
		}
		this.#http.on("request", (req, res) => void this.#handle(req, res));
	}

	#startPolling(): void {
		// R-Q50-8：maxAuthAge 与 pollMs 解耦 —— production age≤5s 常量（不随 poll 缩放），
		// age 锚 = 每轮 pull **起始** mono 时点（网络+读体+解析都消费 age）；晚到过窗不发布；
		// 调度间隔早于 age 到期（留真实裕量给 fetch），不产生每轮 dt 空窗。
		const maxAge = this.#maxAuthAgeMs;
		// R76/R2：registry.pollMs 真正生效——实际轮询间隔 = min(pollMs, maxAuthAge−1s)，下限 250ms。
		// dev/demo（maxAuthAge 30s）配 pollMs 4000 → 吊销/轮换 ≤4s 生效（合同 C2 ≤5s）；prod 仍 4s。
		const pollEvery = Math.max(250, Math.min(this.#cfg.registry!.pollMs, maxAge - REGISTRY_FETCH_MARGIN_MS));
		const retrySoon = 250;
		const tick = async (): Promise<boolean> => {
			if (this.#closed || this.#polling) return true;
			this.#polling = true;
			const startMono = this.#mono(); // 请求起始锚
			try {
				const snap = await this.#pullRegistry();
				if (this.#closed) return false; // H53-c：每 await 后 #closed 再查，close 后不回写/不 rearm
				if (this.#mono() - startMono > maxAge) {
					// 晚到过窗：网络+读体+解析把 age 消耗完了 → 不发布（旧 snapshot 不续 authority、
					// 不 reset age 锚）；retrySoon 重试本身受 #closed 守卫
					return false;
				}
				this.#snapshot = snap;
				this.#snapshotAtMono = startMono;
				return true;
			} catch {
				// 拉取失败：沿用旧快照至 maxAuthAge；超期后 authorize 全拒（fail-closed）。
				return false; // 失败尽快重试（仍受 maxAuthAge 失效约束）
			} finally {
				this.#polling = false;
			}
		};
		const loop = (): void => {
			if (this.#closed) return;
			void tick().then((ok) => {
				if (this.#closed) return;
				this.#pollTimer = setTimeout(loop, ok ? pollEvery : retrySoon);
			});
		};
		loop();
	}

	async #pullRegistry(): Promise<RegistrySnapshot> {
		const reg = this.#cfg.registry!;
		const target = new URL(reg.url);
		if (this.#cfg.mode === "production" && target.searchParams.size > 0) {
			// internal bearer 走 header；production 拒绝任何 query 形态（对齐网关口径）
			throw new Error("registry url 在 production 下不得携带 query");
		}
		// 拉取生命周期有界：可注入 signalTimeout（每 fetch 预算，独立于 maxAuthAge），
		// 不悬挂在半开连接上；原生 AbortSignal.timeout 只在未注入时使用
		const up = await this.#registryFetch(target, {
			method: "GET",
			headers: { authorization: `Bearer ${reg.internalToken}` },
			redirect: "error",
			signal: this.#signalTimeoutImpl(REGISTRY_FETCH_BUDGET_MS),
		});
		if (up.status !== 200) throw new Error(`registry 状态 ${up.status}`);
		if (!up.body) throw new Error("registry 空 body");
		// stream 字节界：边读边计数超限即 cancel（不整包读完后才判）
		const reader = up.body.getReader();
		const parts: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > REGISTRY_BODY_MAX_BYTES) { await reader.cancel().catch(() => {}); throw new Error("registry body 超限"); }
			parts.push(value);
		}
		const text = Buffer.concat(parts.map((p) => Buffer.from(p))).toString("utf8");
		const parsed = JSON.parse(text) as unknown;
		// H53-c/O-5：形状收紧——root 非 null/非 array；逐 entry 字段类型/epoch；cardinality
		// 上限；坏流抛错（不覆盖旧 authority、不 reset age）。上限为合理默认：快照条目 ≤10k、
		// 吊销列表 ≤100k（超过即视为异常源，fail-closed）。
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("registry 快照形状非法");
		const snap = parsed as { epoch?: unknown; activeSessions?: unknown; revokedJtis?: unknown };
		if (typeof snap.epoch !== "string" || snap.epoch.length === 0 || snap.epoch.length > 128) throw new Error("registry 快照形状非法（epoch）");
		if (snap.activeSessions === null || typeof snap.activeSessions !== "object" || Array.isArray(snap.activeSessions)) throw new Error("registry 快照形状非法（activeSessions）");
		if (!Array.isArray(snap.revokedJtis)) throw new Error("registry 快照形状非法（revokedJtis）");
		const sessions = snap.activeSessions as Record<string, unknown>;
		if (Object.keys(sessions).length > 10_000) throw new Error("registry 快照超限（activeSessions cardinality）");
		for (const [k, v] of Object.entries(sessions)) {
			if (typeof k !== "string" || k.length === 0 || k.length > 128 || v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("registry 快照形状非法（entry key/shape）");
			const e = v as Record<string, unknown>;
			if (typeof e.principal !== "string" || typeof e.tenant !== "string" || typeof e.repo !== "string" || typeof e.aclVersion !== "number" || !Number.isSafeInteger(e.aclVersion) || e.aclVersion < 1) {
				throw new Error("registry 快照形状非法（entry fields）");
			}
		}
		if (snap.revokedJtis.length > 100_000) throw new Error("registry 快照超限（revokedJtis cardinality）");
		for (const j of snap.revokedJtis) {
			if (typeof j !== "string" || j.length === 0 || j.length > 128) throw new Error("registry 快照形状非法（revokedJtis element）");
		}
		return parsed as RegistrySnapshot;
	}

	/** 调试用/测试注入：当前快照与新鲜度 */
	#snapshotFresh(): boolean {
		if (this.#snapshot === null) return false;
		return this.#mono() - this.#snapshotAtMono <= this.#maxAuthAgeMs;
	}

	/**
	 * dev/编排窗口内回填 registry url（demo 双进程里代理先于网关 listen 时使用）。
	 * production 由配置直接给完整 url；该方法仅启动窗口期合法，poll 循环下一拍生效。
	 */
	setRegistryUrl(url: string): void {
		if (this.#cfg.mode === "production") throw new Error("production 的 registry url 由配置提供，不接受运行期回填");
		if (this.#cfg.registry) this.#cfg.registry.url = url;
	}

	async listen(): Promise<number> {
		await new Promise<void>((r) => this.#http.listen(this.#cfg.port, this.#cfg.host, r));
		const addr = this.#http.address();
		return typeof addr === "object" && addr ? addr.port : this.#cfg.port;
	}

	async close(): Promise<void> {
		this.#closed = true;
		if (this.#pollTimer) clearTimeout(this.#pollTimer);
		this.#http.closeAllConnections();
		await new Promise<void>((r) => this.#http.close(() => r()));
	}

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		// H53-c/O-7：early res error 一次性 contain（deny/401/413 写已断开连接不再崩代理；
		// 不 raw err 入 public/audit）
		res.on("error", () => {});
		// R55-D：请求起点 mono 唯一绝对锚（所有 receive/body 截止由此锚推）
		const requestStartMono = this.#mono();
		try {
			await this.#route(req, res, requestStartMono);
		} catch {
			// 固定公开类别：错误详情（可能含路径/上游信息）只进审计固定 summary，不回 client
			if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
			res.end("git 代理内部错误（fixed public category）");
		}
	}

	#deny(res: ServerResponse, audit: { claims: GrantClaims | null; repo: string }, status: number, summary: string): void {
		const c = audit.claims;
		this.#audit(c, audit.repo, summary, "deny");
		if (!res.headersSent) res.writeHead(status, { "content-type": "text/plain" });
		res.end("拒绝");
	}

	/** R72/R74：快照落后于签发方时的立即重拉（单飞 + 最小间隔 1s 限流）；返回是否实际重拉成功。
	 * 拉取失败沿用旧快照（fail-closed 不变）。 */
	async #refreshSnapshotOnce(): Promise<boolean> {
		const now = this.#mono();
		if (this.#missRefreshInFlight || now < this.#missRefreshNotBeforeMono) return false;
		this.#missRefreshInFlight = true;
		try {
			const fresh = await this.#pullRegistry();
			this.#snapshot = fresh;
			this.#snapshotAtMono = this.#mono();
			return true;
		} catch {
			return false;
		} finally {
			this.#missRefreshInFlight = false;
			this.#missRefreshNotBeforeMono = this.#mono() + MISS_REFRESH_MIN_INTERVAL_MS;
		}
	}

	/** R74-v3：限流窗内不直接按旧快照拒——等待窗/在途拉取收敛（≤1s）后再重拉一次。
	 * 全局拉取频率仍 ≤1 次/秒（notBefore+单飞），单请求最多额外等待约 1s+拉取预算。 */
	async #refreshSnapshotAwaited(): Promise<boolean> {
		const deadline = this.#mono() + MISS_REFRESH_MAX_WAIT_MS;
		for (;;) {
			if (this.#closed) return false;
			const now = this.#mono();
			if (!this.#missRefreshInFlight && now >= this.#missRefreshNotBeforeMono) {
				return await this.#refreshSnapshotOnce();
			}
			if (now >= deadline) return false;
			await new Promise((r) => setTimeout(r, 25));
		}
	}

	/** R1：A6 判定唯一实现（首判与重拉后复判同缝）。mayFlip=该失败是否可能经重拉翻转为放行：
	 * 仅 session 未登记（冷启动 miss：登记未及轮询）与 claims.aclVersion 高于快照（网关已 bump
	 * 未及轮询）成立；epoch 不一致/jti 已吊销/aclVersion 低于快照/五 scope 不一致均不可能。 */
	#checkGrantAgainstSnapshot(claims: GrantClaims, snap: RegistrySnapshot): { ok: true } | { ok: false; reason: string; mayFlip: boolean } {
		// epoch 比对（A6 补项）：签发方重启换 epoch 后，旧 epoch grant 一律拒（新快照 epoch 只会更新）
		if (claims.epoch !== snap.epoch) {
			return { ok: false, reason: "拒绝：grant epoch 与 registry 快照不一致（签发方重启/轮换）", mayFlip: false };
		}
		if (snap.revokedJtis.includes(claims.jti)) {
			return { ok: false, reason: "拒绝：grant 已吊销（jti）", mayFlip: false };
		}
		const registered = snap.activeSessions[claims.session];
		if (!registered) {
			return { ok: false, reason: "拒绝：session 未在活会话登记表（已销毁/未登记/他网关签发）", mayFlip: true };
		}
		// H53-c/O-8：全五 scope+epoch/acl——不漏 tenant/repo 两轴（登记身份不会变，不可翻转）
		if (registered.principal !== claims.principal || registered.tenant !== claims.tenant || registered.repo !== claims.repo) {
			return { ok: false, reason: "拒绝：registry 登记与 grant claims 不一致", mayFlip: false };
		}
		// aclVersion 可对比字段（A6 补项）：签发方变更/撤销后条目失配即拒；
		// 仅 claims 更高（网关已 bump 未及轮询）可能经重拉翻转，claims 更旧=旧 grant 必须失效
		if (registered.aclVersion !== claims.aclVersion) {
			return { ok: false, reason: "拒绝：aclVersion 已变更（旧 grant 失效）", mayFlip: claims.aclVersion > registered.aclVersion };
		}
		return { ok: true };
	}

	async #route(req: IncomingMessage, res: ServerResponse, requestStartMono: number): Promise<void> {
		// B1：raw url 先查（new URL 的规范化会抹掉 // 与 .. 的字面形态）
		const rawUrl = req.url ?? "/";
		if (rawUrl.includes("..") || rawUrl.includes("//")) {
			res.writeHead(403).end("仓库路径非法");
			return;
		}
		const url = new URL(rawUrl, "http://localhost");
		if (url.pathname === "/healthz") {
			res.writeHead(200).end("ok");
			return;
		}

		const parsed = parsePath(url.pathname);
		if (!parsed) {
			res.writeHead(404).end("不支持的 git 端点");
			return;
		}
		// B1：allowlist 名是部署者写的字面量——百分号编码/双斜杠/`..`/大小写变体
		// 都不是 allowlist 名，一律拒（不做解码匹配，那是新增攻击面）
		if (parsed.repo.includes("%") || parsed.repo.includes("//") || parsed.repo.includes("..")) {
			res.writeHead(403).end("仓库路径非法");
			return;
		}

		const repo = this.#cfg.repos.find((r) => r.name === parsed.repo);
		const deny = (status: number, summary: string, claims: GrantClaims | null = null): void => {
			this.#deny(res, { claims, repo: parsed.repo }, status, summary);
		};

		if (!repo) {
			// 不在 allowlist 内 —— 代理持有组织级 token，这一步不做就等于把它借出去了。
			// H6：拒绝类别固定，不把请求路径形态（可能是 token 片段）透传进审计/响应。
			deny(403, "拒绝：目标仓库不在 allowlist 内（unverified）");
			return;
		}

		// ── A2：授权管道。先取 grant（Basic 为主——git 只发 Basic；Bearer 兼容保留给测试直连）
		const grantStr = this.#extractGrant(req);
		if (grantStr === null) {
			// git 客户端见到 401 会去问 credential helper
			res.writeHead(401, { "www-authenticate": 'Basic realm="perimeter-git-proxy"' }).end("未授权");
			return;
		}
		const verified = verifyGrant(grantStr, this.#cfg.masterKey, this.#now());
		if (!verified.ok) {
			deny(403, `拒绝：${verified.reason}`);
			return;
		}
		const claims = verified.claims;

		// grant.repo 与请求 repo 字符串全等（不做前后缀/大小写宽松）；类别固定不透传双方值
		if (claims.repo !== parsed.repo) {
			deny(403, "拒绝：grant 绑定仓库与请求仓库不一致", claims);
			return;
		}

		// A6：活会话登记 + jti 吊销 + epoch。快照过期（>maxStale）= fail-closed 全拒。
		if (!this.#cfg.registry) {
			deny(403, "拒绝：registry 未配置（本实例无活会话登记能力）", claims);
			return;
		}
		if (!this.#snapshotFresh()) {
			deny(403, "拒绝：registry 快照缺失或超过 maxStale（fail-closed）", claims);
			return;
		}
		// R1+R76b：判定抽唯一实现；首判失败时仅当「结果可能翻转为放行」（session 未登记/
		// claims.aclVersion 高于快照）才等待并重拉一次，随后按**新快照重走同一实现**并复查
		// 新鲜度；重拉失败/等待超时/仍失败 → 「快照缺失或过期」fail-closed，绝不依据超龄
		// 快照放行；不可能翻转的失败（epoch/jti 吊销/低 acl/scope）直接拒，不消耗重拉额度。
		let check = this.#checkGrantAgainstSnapshot(claims, this.#snapshot!);
		if (!check.ok && check.mayFlip) {
			if (!await this.#refreshSnapshotAwaited()) {
				deny(403, "拒绝：registry 快照缺失或超过 maxStale（fail-closed）", claims);
				return;
			}
			const fresh = this.#snapshot!;
			if (!this.#snapshotFresh()) {
				deny(403, "拒绝：registry 快照缺失或超过 maxStale（fail-closed）", claims);
				return;
			}
			check = this.#checkGrantAgainstSnapshot(claims, fresh);
			if (!check.ok) {
				// 固定类别后缀区分：带「（重拉后复核）」= 走过重拉路径；不带 = 未重拉直接拒
				deny(403, `${check.reason}（重拉后复核）`, claims);
				return;
			}
		}
		if (!check.ok) {
			// 不可翻转的失败（epoch/jti 吊销/低 aclVersion/scope 不一致）：未重拉直接拒，原文案
			deny(403, check.reason, claims);
			return;
		}

		// 端点与方法的对应是固定的：info/refs 只收 GET，两个 pack 端点只收 POST。
		const wantMethod = parsed.endpoint === INFO_REFS ? "GET" : "POST";
		if ((req.method ?? "GET") !== wantMethod) {
			res.writeHead(405, { allow: wantMethod }).end("方法不允许");
			return;
		}

		// B2：操作推导三方一致（端点 × service × content-type）。
		// 重复 service 参数直接 fail-closed（get 只取首个会让判定与转发各看各的字符串）
		const services = url.searchParams.getAll("service");
		if (services.length > 1) {
			return deny(400, "拒绝：service 参数重复", claims);
		}
		const service = services[0] ?? null;
		let isPush: boolean;
		if (parsed.endpoint === INFO_REFS) {
			if ((req.method ?? "GET") !== "GET") return deny(405, "方法不允许", claims);
			if (service === "git-upload-pack") isPush = false;
			else if (service === "git-receive-pack") isPush = true;
			else {
				// dumb 协议不在子集内：无 service 或未知值直接 400（上游会吐 dumb 广告引入死巷）
				return deny(400, "拒绝：info/refs 缺失或未知 service 参数", claims);
			}
		} else {
			const ctype = String(req.headers["content-type"] ?? "");
			const expectedType = parsed.endpoint === RECEIVE_PACK
				? "application/x-git-receive-pack-request"
				: "application/x-git-upload-pack-request";
			if (ctype !== expectedType) {
				return deny(400, `拒绝：content-type 与端点不一致（${parsed.endpoint}）`, claims);
			}
			isPush = parsed.endpoint === RECEIVE_PACK;
		}

		// caps 判定（R-Q50-2：读也是能力——每个读操作都必须 caps.read；写按 caps.write/
		// writeRefs/部署面 allowPush 三层）。验证端独立强制，签名位不是装饰。
		if (!claims.caps.read) {
			deny(403, "拒绝：grant 无读能力（caps.read=false）", claims);
			return;
		}
		if (isPush && repo.allowPush !== true) {
			deny(403, "拒绝推送：目标仓库未显式授权推送", claims);
			return;
		}
		if (isPush && claims.caps.write !== true) {
			deny(403, "拒绝推送：grant 无写能力（read-only）", claims);
			return;
		}

		const target = new URL(repo.upstream.replace(/\/$/, "") + parsed.endpoint);
		// 只透传 git 协议真正需要的那个参数（重复参数分歧在旧版已闭合，语义保持）
		if (service === "git-upload-pack" || service === "git-receive-pack") {
			target.searchParams.set("service", service);
		}

		const headers: Record<string, string> = {};
		// git 客户端的这几个头必须原样带上，否则协议协商会失败。
		// B3：git-protocol 只接受单值 version=1|2 原样透传；其余值（重复/畸形/v3）丢弃该头
		const proto = req.headers["git-protocol"];
		const protoVal = typeof proto === "string" ? proto : Array.isArray(proto) ? proto[0] : undefined;
		if (protoVal === "version=1" || protoVal === "version=2") headers["git-protocol"] = protoVal;
		if (parsed.endpoint === UPLOAD_PACK) {
			// 读路径 content-encoding 原样透传（无解析需求）
			const ce = req.headers["content-encoding"];
			if (typeof ce === "string") headers["content-encoding"] = ce;
		}
		if (req.method === "POST") {
			// POST 上游头补全：content-type（gzip receive 已 inflate → identity 的 request ctype）
			// 与 accept 原样（git 协商需要）
			if (isPush) {
				headers["content-type"] = "application/x-git-receive-pack-request";
			} else {
				const ct = req.headers["content-type"];
				if (typeof ct === "string") headers["content-type"] = ct;
			}
			const accept = req.headers.accept;
			if (typeof accept === "string") headers.accept = accept;
		}

		let body: ReadableStream | undefined;
		// R59-②/v3：外层 fetch AbortController（全寿命 fire 时真正 abort fetch）；
		// res close（响应未结束前）= 客户端断开 → abort（req 的 close 在 body 消费完即触发，
		// 不代表断开——v3 修正：不监听 req close，避免合法 push 上传完即被中止）；
		const lifetimeAbort = new AbortController();
		let preparedDispose: (() => void) | null = null;
		const onClientClose = (): void => {
			if (!res.writableFinished) lifetimeAbort.abort();
		};
		res.once("close", onClientClose);
		const detachClientClose = (): void => {
			res.off("close", onClientClose);
		};
		if (req.method === "POST") {
			if (isPush) {
				// B6：命令区预校验（上游写之前）。返回 null = 已响应（403/413），调用结束。
				// R55-D：请求起点 mono t0 为唯一绝对锚（#handle 设定，经 route 传入）
				const prepared = await this.#prepareReceivePack(req, res, claims, requestStartMono, () => lifetimeAbort.abort());
				if (prepared === null) {
					detachClientClose(); // v3：早退路径也解绑 close 监听（幂等）
					return;
				}
				body = prepared.body;
				preparedDispose = prepared.dispose;
				// 预校验含 await（读命令区耗时不受限）：授权决定已过一段时间，首笔上游 fetch
				// 前重新校验（H6）：exp/jti/epoch/session/acl/快照新鲜度。不重验就是头部验过
				// 后慢送命令也能借组织凭据写到上游。已流向上游的动作可能有副作用：如重验
				// 拒绝时 prepare 阶段已无副作用（未 fetch），但若上游 fetch 已开始后失败，
				// 副作用如实 unknown，不承诺回滚。
				const stale = this.#revalidateBeforeFetch(claims);
				if (stale !== null) {
					body.cancel().catch(() => {}); // R59-②/F3：contain（不 void 丢 rejection）
					preparedDispose?.(); // 重验拒绝：解除全寿命 timer（未 fetch，无副作用）
					detachClientClose();
					return deny(403, stale, claims);
				}
				// gzip 场景已在 prepare 内解压：向上游以 identity 转发（剥 content-encoding）
				if (!prepared.identity) {
					const ce = req.headers["content-encoding"];
					if (typeof ce === "string") headers["content-encoding"] = ce;
				}
			} else {
				body = this.#requestBodyStream(req); // R68-B：不再裸 toWeb（收束后 enqueue 打崩进程）
				if (typeof req.headers["content-encoding"] === "string") headers["content-encoding"] = req.headers["content-encoding"];
			}
		}

		if (repo.token) {
			// 凭据在这里、且只在这里注入
			headers.authorization = `Basic ${Buffer.from(`${repo.username ?? "x-access-token"}:${repo.token}`).toString("base64")}`;
		}

		// R59-②/F3：fetch 受 try 保护（abort/网络错误统一收束：disarm + deny 固定类别，
		// 不漏 dispose）；客户端断开（req/res close）也触发 lifetimeAbort.abort。
		let upRes: Response;
		try {
			upRes = await this.#fetch(target, {
				method: req.method ?? "GET",
				headers,
				body,
				// B7：携带凭据的上游请求逐跳拒绝重定向；3xx 一律失败（不跟随）
				redirect: "error",
				// R59-②缺口 b：全寿命 fire（或客户端断开）真正中止外层 fetch
				signal: lifetimeAbort.signal,
				...(body !== undefined ? { duplex: "half" } : {}),
			} as RequestInit);
		} catch {
			// 固定类别：abort/网络错误不透传原文（上游副作用若已开始如实 unknown，不重试）
			detachClientClose();
			preparedDispose?.();
			void body?.cancel().catch(() => {});
			return deny(502, "拒绝：上游 fetch 失败或被全寿命截止中止（fixed category）", claims);
		}
		detachClientClose();

		if (upRes.status >= 300 && upRes.status < 400) {
			deny(502, `拒绝：上游返回重定向 ${upRes.status}（redirect:error，不跟随）`, claims);
			await upRes.body?.cancel().catch(() => {});
			detachClientClose(); // v3：早退解绑（幂等）
			preparedDispose?.(); // R78：与其他完成路径一致收束全寿命 timer（disarm 幂等，只 dispose 一次）
			return;
		}

		if (isPush) {
			this.#audit(claims, repo.name, `推送到 ${repo.name}（上游 ${redactUrl(repo.upstream)}）`, "allow");
		}

		const outHeaders: Record<string, string> = {};
		for (const h of ["content-type", "cache-control", "content-encoding"]) {
			const v = upRes.headers.get(h);
			if (v) outHeaders[h] = v;
		}
		res.writeHead(upRes.status, outHeaders);
		if (upRes.body) {
			// H6：错误收束——上游/客户端任一侧错误 contain（不崩全代理、不崩进程），
			// 不自动重试（写动作不重放）；客户端断开时取消上游 body。
			// @ts-expect-error Node 的 Readable.fromWeb 类型与 DOM ReadableStream 不完全对齐
			const upstream = Readable.fromWeb(upRes.body);
			let clientGone = false;
			res.on("close", () => {
				clientGone = true;
				lifetimeAbort.abort(); // R59-②/F3：客户端断开也 abort 外层 fetch 生命周期
				preparedDispose?.(); // 响应收束：解除全寿命 timer
				upRes.body?.cancel().catch(() => {});
			});
			upstream.on("end", () => { preparedDispose?.(); }); // 上游读完：响应阶段结束
			upstream.on("error", () => {
				preparedDispose?.();
				if (!res.writableEnded) res.destroy();
			});
			res.on("error", () => { upRes.body?.cancel().catch(() => {}); });
			upstream.pipe(res);
			void clientGone;
		} else {
			res.end();
			preparedDispose?.(); // 无 body 响应：同样收束
		}
		// R59-v2/F3：响应收尾尾部不再无条件 dispose（由 end/error/close/无body/fetch
		// catch/revalidate 各自触发；dispose 幂等）
	}

	/** 授权后慢路径的 fetch 前重验（H6）：快照新鲜度 + exp + epoch + jti + 登记 + acl */
	#revalidateBeforeFetch(claims: GrantClaims): string | null {
		if (!this.#snapshotFresh()) return "拒绝：registry 快照已过期（授权后重验 fail-closed）";
		if (claims.exp <= this.#now()) return "拒绝：grant 已过期（授权后重验）";
		const snap = this.#snapshot!;
		if (claims.epoch !== snap.epoch) return "拒绝：grant epoch 与快照不一致（授权后重验）";
		if (snap.revokedJtis.includes(claims.jti)) return "拒绝：grant 已吊销（授权后重验）";
		const registered = snap.activeSessions[claims.session];
		if (!registered) return "拒绝：session 登记已消失（授权后重验）";
		// H53-c/O-8：全五 scope+epoch/acl——不漏 tenant/repo 两轴
		if (registered.principal !== claims.principal || registered.tenant !== claims.tenant || registered.repo !== claims.repo || registered.aclVersion !== claims.aclVersion) {
			return "拒绝：登记与 claims 不一致（授权后重验）";
		}
		return null;
	}

	#extractGrant(req: IncomingMessage): string | null {
		const h = req.headers.authorization ?? "";
		const single = typeof h === "string" ? h : Array.isArray(h) ? h[0]! : "";
		if (single.startsWith("Bearer ")) return single.slice(7).trim() || null;
		if (single.startsWith("Basic ")) {
			const decoded = Buffer.from(single.slice(6), "base64").toString("utf8");
			const idx = decoded.indexOf(":");
			const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
			return pass || null;
		}
		return null;
	}

	/** R68-B（真实 N18）：可控请求体流——裸 toWeb(req) 的适配器在 fetch 失败/取消后
	 * controller 已 closed，而 req 残余 'data' 仍 onData→enqueue → 未捕获
	 * "Invalid state: Controller is already closed" 打崩代理进程。此处：enqueue 一律包
	 * try（已收束即 pause 止流；不 destroy——拒绝响应还需同一 socket 送达）；
	 * pull/cancel 用 pause/resume 维持背压与消费方收束后的止流。 */
	#requestBodyStream(req: IncomingMessage): ReadableStream<Uint8Array> {
		return new ReadableStream<Uint8Array>({
			start: (controller) => {
				req.on("data", (chunk: Buffer) => {
					if ((controller.desiredSize ?? 1) <= 0) req.pause();
					try {
						controller.enqueue(new Uint8Array(chunk));
					} catch {
						req.pause(); // 已收束（fetch 失败/取消）：止流即收束
					}
				});
				req.once("end", () => { try { controller.close(); } catch { /* 已收束 */ } });
				req.once("error", (e) => { try { controller.error(e); } catch { /* 已收束 */ } });
			},
			pull: () => { req.resume(); },
			cancel: () => { req.pause(); },
		});
	}

	/**
	 * B6：receive-pack 命令区预校验（上游写之前，全部 fail-closed）。R51 重写：
	 * - identity：PktHeaderScanner（真实 pkt cursor，不滑动回退）跨 chunk 定位 flush；
	 *   前缀=完整命令区（含 flush 0000 精确一次）+ 同一 reader 续读余包 —— 转发字节
	 *   byte-for-byte 等于原始 identity 流（same-chunk 后缀与后 reader 各转一次）。
	 * - gzip（R-Q50-4）：整个 HTTP body 经**单一 createGunzip 连续流**；header 在解压后
	 *   字节上定位；前缀+剩余解压字节以 identity 单次上游（不对已剥 encoding 的上游
	 *   re-deflate；不整包缓存：compressed/decompressed/header 各自有界，余包背压转发）。
	 * - 拒绝/客户端断开：reader.cancel() 收束上游流（不只 releaseLock）。
	 * - 已流向上游的动作可能有副作用：如 fetch 后中途失败，如实 unknown，不承诺回滚。
	 */
	async #prepareReceivePack(req: IncomingMessage, res: ServerResponse, claims: GrantClaims, requestStartMono: number, onLifetimeFire: () => void): Promise<{ body: ReadableStream; identity: boolean; dispose: () => void } | null> {
		const deny = (status: number, category: string): void => {
			this.#deny(res, { claims, repo: claims.repo }, status, category);
		};
		const cancelAndDeny = async (status: number, category: string, cancel: () => Promise<void> | void): Promise<null> => {
			try { await cancel(); } catch { /* 收束失败不掩盖拒绝本身 */ }
			// R59-②缺口 c：header 段所有早退（deny/异常/取消）统一解除全寿命 timer
			//（timer 残留至 bodyDeadline 且缺省未 unref 会累积挂钟；调用时 bodyLifetimeTimer
			// 已初始化——首用点均在 arm 之后）。
			this.#deadlineDisarm(bodyLifetimeTimer);
			deny(status, category);
			return null;
		};
		const encoding = String(req.headers["content-encoding"] ?? "identity");
		if (encoding !== "identity" && encoding !== "gzip") {
			req.destroy();
			deny(415, "拒绝：receive-pack content-encoding 不支持（仅 identity/gzip）");
			return null;
		}
		const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });
		const identity = encoding === "identity";
		// R59-②：onLifetimeFire 由调用方注入（AbortController.abort——fire 时真正 abort 外层 fetch）
		// R55-D：零窗 `>=` 拒（不可启动 read）；header 10s 可配有限；全 body 寿命/字节硬上限
		if (requestStartMono + this.#limits.headerDeadlineMs <= this.#mono()) {
			deny(408, "拒绝：receive 请求窗口已耗尽（零窗拒绝）");
			return null;
		}

		// 字节源：identity → 原始 body reader；gzip → 单一 gunzip 连续流的解压侧 reader。
		// R55-D/H：header 阶段 DeadlineReadGate（owned 截止能唤醒 pending read）；全程
		// compressed ≤128MiB / decoded ≤512MiB / 全 body ≤120s（可配有限硬上限）；
		// header 阶段压缩侧另限 8MiB、命令区 64KiB 独立保留。
		const webBody = this.#requestBodyStream(req); // R68-B：同缝替换（prepare 的 cancel 路径同样不再打崩）
		const rawReader = webBody.getReader();
		let src: ReadableStreamDefaultReader<Uint8Array>;
		let gunzip: Transform | null = null;
		const counters: { compressedBytes: number; decompressedBytes: number; aborted: boolean; failCategory?: string; fail: (category: string) => void } = { compressedBytes: 0, decompressedBytes: 0, aborted: false, fail: (category: string): void => { counters.failCategory = category; } };
		const scanner = new PktHeaderScanner(HEADER_BAND_MAX_BYTES);
		let scannerDone = false;
		// 闭包延迟绑定（gzip 分支后 src 才定）；零窗/粘滞由 gate 内部处理。
		// R57-2：删除同块重复声明（第二行还直传未赋值 src）——仅保留此行。
		const gate = new DeadlineReadGate({ read: () => src.read() }, this.#readDeadlineDeps());
		if (encoding === "gzip") {
			// R-Q50-4：整个 body 经单一 createGunzip 连续流（不分段新建 inflate、不在压缩
			// 字节上找 pkt）。R55-E：drain/close/error 三路一次性等待（settle 解绑全部
			// listeners，不对长寿命 promise 累积 reaction）；pumpDead/close/error 后不再
			// rawReader.read；退出统一 finally cancel rawReader（正常 EOF 不 destroy——
			// 尾部解压字节仍可读尽，由解压侧 reader 自然 done 收束）。
			gunzip = createGunzip();
			let pumpDead = false;
			gunzip.once("close", () => { pumpDead = true; });
			gunzip.once("error", () => { pumpDead = true; });
			const pump = (async () => {
				try {
					for (;;) {
						const { done, value } = await rawReader.read();
						if (pumpDead) { await rawReader.cancel().catch(() => {}); return; }
						if (done) { gunzip!.end(); return; } // 正常 EOF：不 destroy，尾部读尽
						counters.compressedBytes += value.length;
						if (!scannerDone && counters.compressedBytes > this.#limits.headerCompressedCapBytes) {
							pumpDead = true;
							counters.fail("拒绝：receive-pack header 压缩侧超限");
							gunzip!.destroy();
							await rawReader.cancel().catch(() => {});
							return;
						}
						if (counters.compressedBytes > this.#limits.maxRawBodyBytes) {
							pumpDead = true;
							counters.fail("拒绝：receive body 超过原始字节上限");
							gunzip!.destroy();
							await rawReader.cancel().catch(() => {});
							return;
						}
						if (!gunzip!.write(Buffer.from(value))) {
							await new Promise<void>((resolve) => {
								const onDrain = (): void => finish();
								const onClose = (): void => finish();
								const onErr = (): void => finish();
								const finish = (): void => {
									gunzip!.off("drain", onDrain);
									gunzip!.off("close", onClose);
									gunzip!.off("error", onErr);
									resolve();
								};
								gunzip!.once("drain", onDrain);
								gunzip!.once("close", onClose);
								gunzip!.once("error", onErr);
							});
							if (pumpDead) { await rawReader.cancel().catch(() => {}); return; } // close/error 胜出：不再 read
						}
					}
				} catch {
					// 异常退出：统一收束（read 挂起由 cancel settle；不 unhandled）
					pumpDead = true;
					counters.fail("拒绝：receive body 读取失败（固定类别）");
					gunzip!.destroy();
					await rawReader.cancel().catch(() => {});
				}
			})();
			void pump;
			// 解压侧 web reader：错误从 gunzip 经 from() 传播到 src.read()（pull 处 c.error）
			const gzWeb = Readable.toWeb(Readable.from(gunzip)) as unknown as ReadableStream<Uint8Array>;
			src = gzWeb.getReader();
		} else {
			src = rawReader;
		}
		// R57-6：幂等 Promise（缓存首次收束；后续调用 await 同一 promise，不靠 bool 让后调用
		// 误认清理已完成）；ReadableStream 已 errored 后 reader.cancel 返回 rejected——
		// 每条取消都显式 contain，不 void 丢 unhandled。
		let cancelPromise: Promise<void> | null = null;
		const cancelSource = (): Promise<void> => {
			if (cancelPromise !== null) return cancelPromise;
			cancelPromise = (async (): Promise<void> => {
				counters.aborted = true;
				gunzip?.destroy();
				await src.cancel().catch(() => { /* 已收束/已 errored */ });
				await rawReader.cancel().catch(() => { /* 已收束/已 errored */ });
			})();
			return cancelPromise;
		};

		// 阶段一：header 定位（owned 截止能唤醒 pending read；header 段=min(header, body) 双锚）
		let sawEnd = false;
		const headerBudgetDeadline = requestStartMono + this.#limits.headerDeadlineMs;
		const bodyBudgetDeadline = requestStartMono + this.#limits.bodyDeadlineMs;
		// R59-③：同一纯计数实现覆盖 header+同 chunk tail+续 PACK；identity 时 raw==decoded
		// 同轨即时检查（gzip 的 raw 由泵独立累计，见下）。
		// R57-D/H：唯一原请求绝对 body deadline 的全寿命 timer——upstream 不 pull/backpressure
		// 无 read 时也必须在点触发取消（不留无界 fetch/泵/drain 等待）；fire 额外通知外层
		// AbortController（R59-②缺口 b：真正 abort 外层 fetch）；结束/错误/取消独立 clear；
		// 缺省 timer unref（错误请求不累积挂钟）。
		const countersAbort = async (): Promise<void> => {
			counters.fail("拒绝：receive body 超过全 body 寿命上限");
			onLifetimeFire();
			await cancelSource();
		};
		const bodyLifetimeTimer = this.#deadlineArm(bodyBudgetDeadline, countersAbort);
		const headerDeadline = Math.min(headerBudgetDeadline, bodyBudgetDeadline); // R58-3：header 段取 min（最早预算）
		// F1：唯一 ByteBudget 实例（arm 前构造；header 循环/seed/转发段共用同一计数缝）
		const budget = new ByteBudget(this.#limits.maxDecodedBytes, identity ? this.#limits.maxRawBodyBytes : Number.MAX_SAFE_INTEGER);
		for (;;) {
			if (scanner.state$.phase === "done") { scannerDone = true; sawEnd = true; break; }
			if (scanner.state$.phase === "error") {
				const isOver = scanner.state$.reason.includes("64KiB");
				return await cancelAndDeny(isOver ? 413 : 403, isOver ? "拒绝：receive-pack 命令区超过 64KiB 上限" : "拒绝：命令区 pkt 语法非法", cancelSource);
			}
			if (counters.failCategory !== undefined) {
				return await cancelAndDeny(413, counters.failCategory, cancelSource);
			}
			try {
				const { done, value } = await gate.read(headerDeadline);
				if (done) break;
				if (value) {
					counters.decompressedBytes += value.length;
					// R59-③：identity header 段原始字节同入预算即时检查（不再无 raw 计数）
					const verdict = budget.add(value.length, identity ? value.length : 0);
					if (verdict !== "ok") {
						return await cancelAndDeny(413, verdict === "over-raw"
							? "拒绝：receive body 超过原始字节上限（identity）"
							: "拒绝：receive body 超过解压字节上限", cancelSource);
					}
					scanner.push(value);
				}
			} catch (e) {
				if (e instanceof DeadlineError || gate.expired) {
					return await cancelAndDeny(408, "拒绝：receive-pack 命令区定位超时（owned 截止）", cancelSource);
				}
				return await cancelAndDeny(400, "拒绝：receive body 读取失败（固定类别）", cancelSource);
			}
		}
		if (!sawEnd) {
			this.#deadlineDisarm(bodyLifetimeTimer);
			return await cancelAndDeny(413, "拒绝：receive-pack 命令区未见 flush（流提前结束）", cancelSource);
		}
		const cmdBuf = Buffer.from(scanner.header());
		const tailBuf = scanner.takeTail(); // R-Q52-1：同 chunk flush 后 pack 尾字节，一次性取走
		// R59-③：decoded 预算把 header/tail 初段一并计入并**立即检查**（fetch 前超限 →
		// 413/upstream 0；EOF 不跳过——seed 判定与 done 无关）
		const seedVerdict = budget.seed(cmdBuf.length + tailBuf.length, identity ? cmdBuf.length + tailBuf.length : 0);
		if (seedVerdict !== "ok") {
			return await cancelAndDeny(413, seedVerdict === "over-raw"
				? "拒绝：receive body 超过原始字节上限（identity）"
				: "拒绝：receive body 超过解压字节上限", cancelSource);
		}

		// 阶段二：命令区严格解析（同缝模块；refname 一把尺）
		const parsed = parsePktCommands(cmdBuf, fatalUtf8);
		if (!parsed.ok) {
			this.#deadlineDisarm(bodyLifetimeTimer);
			return await cancelAndDeny(403, parsed.category, cancelSource);
		}
		const offGlob = parsed.commands.find((c) => !claims.caps.writeRefs.some((g) => refGlobMatch(g, c.refname)));
		if (offGlob) {
			this.#deadlineDisarm(bodyLifetimeTimer);
			return await cancelAndDeny(403, "拒绝：ref 不在 grant 写域（writeRefs）", cancelSource);
		}

		// 阶段三：单次上游 fetch —— 同缝转发器（header→tail→源续读，pull 真背压）；
		// R57-3：转发段 pending read 也经 gate（deadline=min(双锚)——真正 owned 截止）；
		// R57-H：identity raw 也受 receiveMaxRawBodyBytes 约束（raw==decoded 口径）。
		// 阶段三：单次上游 fetch —— 同缝转发器（header→tail→源续读，pull 真背压）；
		// R58-3：转发段唯一 deadline = bodyBudgetDeadline（全寿命唯一锚；header 段才取 min）
		// —— 合法长 push（header 8s 后 60s PACK）可过；R58-4：decoded/raw 经同一 ByteBudget
		// 即时检查（EOF 不跳过——初段已查）。dispose 由调用方在响应完成后统一解除（EOF 不提前）。
		const boundedRead = async (): Promise<{ done: boolean; value?: Uint8Array }> => {
			if (counters.aborted) throw new Error("receive stream aborted");
			try {
				const r = await gate.read(bodyBudgetDeadline);
				if (r.value) {
					const verdict = budget.add(r.value.length, identity ? r.value.length : 0);
					if (verdict !== "ok") {
						counters.fail(verdict === "over-raw"
							? "拒绝：receive body 超过原始字节上限（identity）"
							: "拒绝：receive body 超过解压字节上限");
						this.#deadlineDisarm(bodyLifetimeTimer);
						void cancelSource().catch(() => {}); // 流式才越界：fetch 已发起，副作用 unknown 不重试
						throw new Error(verdict === "over-raw" ? "receive raw size limit exceeded" : "receive decoded size limit exceeded");
					}
				}
				return r;
			} catch (e) {
				if (e instanceof DeadlineError || gate.expired) {
					counters.fail("拒绝：receive body 超过全 body 寿命上限（owned 截止）");
					this.#deadlineDisarm(bodyLifetimeTimer);
					void cancelSource().catch(() => {});
					throw new Error("receive body deadline exceeded");
				}
				throw e;
			}
		};
		const body = createIdentityForward(cmdBuf, tailBuf, boundedRead, async () => {
			this.#deadlineDisarm(bodyLifetimeTimer); // 取消路径解除全寿命 timer
			await cancelSource();
		});
		return {
			body,
			identity: true,
			dispose: () => {
				// R59-②：正常响应完成后统一解除（EOF 不提前解除——响应阶段仍受全寿命 timer 管辖）
				this.#deadlineDisarm(bodyLifetimeTimer);
			},
		};
	}

	/** R57-D/H：一次性全寿命 timer（arm→fire 触发取消；disarm 独立 clear，幂等） */
	#deadlineArm(absoluteMonoMs: number, onFire: () => Promise<void> | void): unknown {
		// R59-②：同缝纯函数委托（armDeadlineTimer；resourcefree unit 直测同一实现）
		return armDeadlineTimer(this.#readDeadlineDeps(), absoluteMonoMs, onFire);
	}

	#deadlineDisarm(timer: unknown): void {
		// R59-②：同缝纯函数委托
		disarmDeadlineTimer(this.#readDeadlineDeps(), timer);
	}

	/** R55-D：可注入 deadline timer 对（缺省 native；纯 unit 注入假钟/fake timer） */
	#readDeadlineDeps(): { mono: () => number; setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (timer: unknown) => void } {
		return {
			mono: this.#mono,
			setTimeout: this.#cfg.deadlineTimerImpl ?? ((fn, ms) => setTimeout(fn, ms)),
			clearTimeout: this.#cfg.deadlineClearTimerImpl ?? ((t) => clearTimeout(t as NodeJS.Timeout)),
		};
	}


	#audit(claims: GrantClaims | null, repo: string, summary: string, verdict: string): void {
		// B8/A3：审计 identity 只取已验证 grant claims（client 头不读）；无 token/grant 串。
		// H6：team 取 claims.tenant（非请求头）；未知 repo 不透传路径形态。
		this.#cfg.audit?.append({
			kind: "git.push",
			sessionId: claims?.session ?? "unverified",
			actor: claims?.principal ?? "unverified",
			repo: claims ? repo : "unverified",
			team: claims?.tenant ?? "unverified",
			summary,
			verdict,
		});
	}
}



/** /<repo>/info/refs 或 /<repo>/git-upload-pack 等 */
function parsePath(pathname: string): { repo: string; endpoint: string } | null {
	for (const endpoint of [INFO_REFS, UPLOAD_PACK, RECEIVE_PACK]) {
		if (pathname.endsWith(endpoint)) {
			const repo = pathname.slice(0, -endpoint.length).replace(/^\/+/, "");
			return repo ? { repo, endpoint } : null;
		}
	}
	return null;
}

/** 上游地址可能内嵌凭据，进审计前剥掉 */
function redactUrl(u: string): string {
	try {
		const url = new URL(u);
		url.username = "";
		url.password = "";
		return url.toString();
	} catch {
		return u;
	}
}

void ZERO_SHA;
