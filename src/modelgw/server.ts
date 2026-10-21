import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AuditLog } from "../audit/log.ts";
import { BudgetLedger } from "./budget-ledger.ts";
import { BodyScanError, decodeStrictUtf8, scanJsonDecoded, scanSecrets, validateFindings, type SecretFinding } from "./secrets.ts";
import { assertScopedTokenKey, verifyScopedToken, type ScopedTokenRejectReason } from "./scoped-token.ts";
import { GCP_TOKEN_HOST, type SignedRequest, type UpstreamAuth, authorizeUpstream } from "./upstream-auth.ts";

export interface UpstreamConfig {
	/** provider id，客户端用 model 前缀或 header 选择 */
	id: string;
	/** 完整的上游 base url，如 https://xxx.openai.azure.com/openai/v1 */
	baseUrl: string;
	/** 注入到上游请求的凭据。**只存在于网关，永不进沙箱** */
	apiKey?: string;
	/** 认证方式：多数是 Authorization: Bearer，Azure 用 api-key */
	authHeader?: string;
	/**
	 * 非 OpenAI 兼容通道的认证（Bedrock 的 SigV4、Vertex 的 service account）。
	 * 给了就用它，apiKey/authHeader 被忽略。
	 */
	auth?: UpstreamAuth;
	/**
	 * 上游路径，默认 `/chat/completions`。
	 *
	 * 四条通道都应当指向上游的 **OpenAI 兼容端点**（Bedrock 有
	 * `/openai/v1/chat/completions`，Vertex 有
	 * `.../endpoints/openapi/chat/completions`）—— 网关不做协议转换。
	 *
	 * `{model}` 占位符会用请求体里的 model 字段替换，供少数需要把模型 id
	 * 放进路径的部署使用。⚠️ 指向**原生**端点（如 Bedrock 的
	 * `/model/{model}/invoke`）虽然能连通，但响应是
	 * `application/vnd.amazon.eventstream` 二进制帧 —— 计量解析不出
	 * token 数，配额会静默失效，沙箱也拿到自己解析不了的格式。
	 */
	path?: string;
}

export interface Quota {
	team: string;
	maxTotalTokens: number;
}

/**
 * 出站 DLP（B3）模式。
 * - **block（生产默认）**：完整 body 在任何上游副作用（认证/转发）之前扫描，
 *   命中高置信凭据规则 → 403 + 审计固定类别，请求不达上游；
 * - **audit**：检测+告警+放行，仅限显式获批的低敏感部署（构造期强制 auditApproved），
 *   但扫描器自身故障仍 fail-closed（安全检测坏了不能变成盲目放行）。
 * 边界如实：本层是内容检测，不提供 DNS/SSRF 隔离；hostname allowlist 不防重绑定/重定向
 * （重定向由 redirect:"error" 逐跳拒绝）；零留存/DPA 是外部合同，不因 block 模式而视为已满足。
 */
export interface DlpConfig {
	/** 缺省 = block（生产默认 fail-closed；demo/评估流量无凭据，行为不变） */
	mode?: "audit" | "block";
	/** audit 模式的显式批准标记（部署方对低敏场景的具名批准）；构造期强制 */
	auditApproved?: boolean;
}

/**
 * S4a：模型请求的四段 deadline（handoff §3.2）。任一超时 → AbortController 中止
 * 上游 fetch 与 body reader，释放连接；未写响应头回 504 + 固定文案，已开流则终止
 * 写回，并审计 kind 固定（error）的超时事件（含段别）。换 token 的 fetch 也受
 * connect/总 deadline 约束。
 */
export interface GatewayDeadlines {
	/** 客户端请求体读取上限：慢发 body 的连接被 408 + 断开 */
	bodyMs?: number;
	/** 发起上游请求（含换 token）到收到响应头 */
	connectMs?: number;
	/** 响应头到首个响应 body chunk（首 token） */
	firstTokenMs?: number;
	/** 相邻 body chunk / 写回 drain 等待的最长间隔 */
	idleMs?: number;
	/** 单请求总时长，覆盖以上所有段 */
	totalMs?: number;
}

/** handoff §3.2 建议初值 10s/30s/60s/10min；body 读取无建议值，对齐首 token 取 30s */
export const DEFAULT_DEADLINES: Required<GatewayDeadlines> = {
	bodyMs: 30_000,
	connectMs: 10_000,
	firstTokenMs: 30_000,
	idleMs: 60_000,
	totalMs: 600_000,
};

/** 构造期校验：非正/非有限 deadline 启动即炸（fail-fast，与 dlp.mode 同口径） */
function resolveDeadlines(cfg: GatewayDeadlines | undefined): Required<GatewayDeadlines> {
	const merged = { ...DEFAULT_DEADLINES, ...cfg };
	for (const [key, value] of Object.entries(merged)) {
		if (!Number.isFinite(value) || value <= 0) {
			throw new Error(`模型网关 deadlines.${key} 必须是正数，收到 ${String(value)}`);
		}
	}
	return merged;
}

/** 完整 body 上限（B7 全量预算/流控后置；本上限仅为「扫描前有界、不新增无界 buffer」的安全必要最小限） */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface ModelGatewayConfig {
	port: number;
	host: string;
	token: string;
	upstreams: UpstreamConfig[];
	/**
	 * 出口 allowlist（主机名）。唯一事实来源是 config/policy.yaml 的
	 * egress.deny_all_except，由调用方读出后传进来。
	 */
	egressAllowlist: string[];
	quotas?: Quota[];
	/**
	 * S4b：短期 scoped 凭证的 HMAC-SHA256 验签密钥（≥32 字节 Buffer，构造期校验）。
	 * 配置后接受 `Bearer <scoped token>`：计费归属完全取自凭证（tenant/team/sessionId）。
	 * 密钥只存在于网关进程；签发走 mintScopedToken()（S4c 接线，不在本轮）。
	 */
	scopedTokenKey?: Buffer;
	/** S4b：静态 cfg.token 请求的唯一归属团队（缺省 "default"）。请求头一律不参与归属。 */
	defaultTeam?: string;
	/** S4b：请求未声明 max_tokens 时的最大输出预留（缺省 8192，与 models.ts 目录 maxTokens 对齐） */
	maxOutputTokens?: number;
	/** S4b：持久预算账本文件（node:sqlite + WAL）。缺省 :memory:（不跨进程存活，保持 demo/测试行为） */
	ledgerFile?: string;
	/** S4b：生产预算严格口径 —— 必须显式配置持久账本，否则启动即炸（假的「严格」比没有更危险） */
	strictBudget?: boolean;
	audit?: AuditLog;
	/** B3 出站 DLP 配置；缺省 = block（生产默认） */
	dlp?: DlpConfig;
	/** S4a：四段 deadline（缺省 = DEFAULT_DEADLINES） */
	deadlines?: GatewayDeadlines;
	/** 便于测试注入；默认用全局 fetch */
	fetchImpl?: typeof fetch;
	/** 便于测试注入扫描器故障（fail-closed 负控）；默认 scanSecrets */
	scanSecretsImpl?: typeof scanSecrets;
}

interface Usage {
	total: number;
	input: number;
	output: number;
	/** cache 读/写按 provider 语义归一化，只记录不叠加进 total（防双算，见 readUsage 注释） */
	cacheRead: number;
	cacheWrite: number;
}

/**
 * 模型网关 —— 沙箱到模型厂商之间的唯一出口。
 *
 * 它承担四件事，都在这一层做才有意义：
 * 1. **出口 allowlist**：上游 host 必须在名单内。沙箱的 NetworkPolicy 只放通
 *    本服务，因此这里就是「代码流往外走」的最后一道闸。
 * 2. **凭据隔离**：模型 key 只存在于网关进程。沙箱被 prompt injection 攻陷
 *    也拿不到它 —— 沙箱手里只有网关的会话 token。
 * 3. **凭据/PII 检测**：audit-only，见 secrets.ts 里的理由。
 * 4. **计量与配额**：按 team 累计 token，超限拒绝。
 *
 * **接入方式**：本网关对沙箱说 OpenAI 兼容协议（/v1/chat/completions），
 * 可信网关的 pi-ai 模型目录用 baseUrl 指过来即可。四条企业通道的差别落在
 * **认证**与**上游路径**上，由 UpstreamConfig 的 auth/path 表达：
 *
 * - Azure OpenAI：api-key 头 + 原生 OpenAI 兼容面
 * - 自托管 vLLM：Bearer + 原生 OpenAI 兼容面
 * - AWS Bedrock：SigV4 签名 + 上游的 OpenAI 兼容端点
 * - Google Vertex：service account 换 access token + 上游的 OpenAI 兼容端点
 *
 * **边界要说准确**：网关不做协议转换，也不接受原生格式的入站请求
 * （路由只认 /chat/completions）。所以「支持 Bedrock/Vertex」的准确含义是
 * 「能用它们的认证方式打到它们的 OpenAI 兼容端点」，不是「实现了它们的
 * 原生 API」。销售材料按这个口径写。
 *
 * ⚠️ 四条通道**都没有对真实上游验证过** —— 认证算法有测试（SigV4 比对了
 * 官方向量），但没有一条打到过真的 Bedrock/Vertex/Azure。
 */
export class ModelGateway {
	#cfg: ModelGatewayConfig;
	#http = createServer();
	#fetch: typeof fetch;
	#scan: typeof scanSecrets;
	/** S4b：持久预算账本（缺省 :memory:），usedTokens 等观测接口全部改读账本 */
	#ledger: BudgetLedger;
	/** S4b：scoped jti → 已发操作序号（operationId = jti:序号，服务端生成，不信客户端） */
	#opSeq = new Map<string, number>();
	/** close 幂等闸：http.close 二次调用会以 ERR_SERVER_NOT_RUNNING 拒绝 */
	#closeStarted = false;
	/** B3：生效的 DLP 模式（构造期已校验） */
	readonly dlpMode: "audit" | "block";
	#deadlines: Required<GatewayDeadlines>;

	constructor(cfg: ModelGatewayConfig) {
		this.#cfg = cfg;
		this.#fetch = cfg.fetchImpl ?? fetch;
		this.#scan = cfg.scanSecretsImpl ?? scanSecrets;
		this.#deadlines = resolveDeadlines(cfg.deadlines);
		// S4b：预算配置 fail-fast —— 「严格预算」没有持久账本是假的；scoped key 太弱直接拒
		if (cfg.strictBudget === true && cfg.ledgerFile === undefined) {
			throw new Error("模型网关 strictBudget=true 必须配置 ledgerFile（持久预算账本），拒绝启动");
		}
		if (cfg.scopedTokenKey !== undefined) assertScopedTokenKey(cfg.scopedTokenKey);
		this.#ledger = new BudgetLedger(cfg.ledgerFile);
		// B3：模式校验 fail-fast（未知值/枚举外值启动即炸，绝不静默回退到任一模式）
		const mode = cfg.dlp?.mode ?? "block"; // 生产默认：block（strict fail-closed）
		if (mode !== "audit" && mode !== "block") {
			throw new Error(`模型网关 dlp.mode 非法：${String(cfg.dlp?.mode)}（只接受 audit | block）`);
		}
		// audit 仅限显式获批低敏部署：没有具名批准标记就拒绝以 audit 模式启动
		if (mode === "audit" && cfg.dlp?.auditApproved !== true) {
			throw new Error("模型网关 dlp.mode=audit 必须显式设置 dlp.auditApproved=true（仅限已获批低敏感部署）；生产默认 block");
		}
		this.dlpMode = mode;
		// 换 token 的端点是网关自身的一条硬编码出口，不像 baseUrl 那样
		// 天然过 assertAllowed。不校验的话，「allowlist 是唯一事实来源」
		// 这条不变量就只靠一行注释维持，锁死出口的生产环境里 Vertex 会在
		// 无人预期的地方 fail。
		if (cfg.upstreams.some((u) => u.auth?.kind === "gcp")) {
			assertAllowed(`https://${GCP_TOKEN_HOST}`, cfg.egressAllowlist, "GCP token 端点");
		}
		for (const u of cfg.upstreams) {
			assertAllowed(u.baseUrl, cfg.egressAllowlist);
			// HTTP header 只能是 ASCII。不在这里查的话，一个含非 ASCII 的凭据
			// 会变成运行时 502，而不是启动时一眼可见的配置错误。
			const staticKey = u.apiKey ?? (u.auth?.kind === "static" ? u.auth.apiKey : undefined);
			if (staticKey && !/^[\x20-\x7e]*$/.test(staticKey)) {
				throw new Error(`模型网关上游 ${u.id} 的 apiKey 含非 ASCII 字符，无法作为 HTTP header 发送`);
			}
		}
		// S4b：启动恢复 —— 崩溃残留的 reserved 一律标 usage_unknown（继续占额度、不释放；
		// 与 receipt-store「未终态标 unknown」同一哲学：不当成功、不自动重做，处置权在对账）
		const recovered = this.#ledger.recoverCrashReservations();
		if (recovered > 0) {
			this.#cfg.audit?.append({
				kind: "error",
				sessionId: "-",
				actor: "modelgw",
				summary: `预算账本启动恢复：${recovered} 条崩溃残留 reserved 标记为 usage_unknown（继续占额度，等待对账）`,
			});
		}
		this.#http.on("request", (req, res) => void this.#handle(req, res));
	}

	async listen(): Promise<number> {
		await new Promise<void>((r) => this.#http.listen(this.#cfg.port, this.#cfg.host, r));
		const addr = this.#http.address();
		return typeof addr === "object" && addr ? addr.port : this.#cfg.port;
	}

	async close(): Promise<void> {
		if (this.#closeStarted) return;
		this.#closeStarted = true;
		this.#http.closeAllConnections();
		await new Promise<void>((r) => this.#http.close(() => r()));
		this.#ledger.close();
	}

	/** S4b：团队已占额度（配额口径）= settled 真实用量 + reserved/usage_unknown 在途预留 —— 读账本 */
	usedTokens(team: string): number {
		return this.#ledger.committedTokens(team);
	}

	/** S4b：团队已结算真实用量（计费/展示口径，不含在途预留） */
	settledTokens(team: string): number {
		return this.#ledger.settledTokens(team);
	}

	/** S4b：账本直通（测试/运维观测；reconcile 供异步对账） */
	get ledger(): BudgetLedger {
		return this.#ledger;
	}

	/** S4a：中止/断流的固定类别审计 —— 含段别与 usage_unknown；不写 0 token 假成功（持久预算归 S4b） */
	#auditAbort(abort: AbortState, sessionId: string, actor: string, team: string): void {
		const cause = abort.cause;
		if (!cause) return;
		const summary =
			cause.kind === "timeout"
				? `上游 deadline 超时中止（segment=${cause.segment}），usage_unknown`
				: "客户端断开，上游请求已取消，usage_unknown";
		this.#cfg.audit?.append({ kind: "error", sessionId, actor, team, summary });
	}

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			await this.#route(req, res);
		} catch (err) {
			if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `模型网关上游失败：${String(err)}` } }));
		}
	}

	async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname === "/healthz") {
			res.writeHead(200).end("ok");
			return;
		}
		if (!url.pathname.endsWith("/chat/completions")) {
			res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "不支持的路径" } }));
			return;
		}
		// S4b：计费归属只来自凭证。scoped token → token 声明的 tenant/team/sessionId；
		// 静态 token → defaultTeam。x-perimeter-team / x-perimeter-actor / x-perimeter-session 头
		// 一律不参与归属（session_id 头仅作为 cache 亲和诊断继续原样转发上游）。
		const auth = this.#authenticate(req);
		if (!auth.ok) {
			// 固定类别 401：原因类别只进审计（私有面），公共响应只有「未授权」
			if (auth.reason !== "missing" && auth.reason !== "invalid") {
				this.#cfg.audit?.append({
					kind: "error",
					sessionId: "-",
					actor: "-",
					summary: `scoped token 校验失败（${auth.reason}），固定 401，原因类别不回给客户端`,
				});
			}
			res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "未授权" } }));
			return;
		}
		const identity = auth.identity;
		const team = identity.team;
		const sessionId = identity.sessionId;
		const actor = identity.via === "scoped" ? `token:${identity.jti}` : "static";
		// B3/R41：完整 body 有界读取（超限 413 fail-closed）+ 严格 UTF-8 解码 + raw/语义双层扫描。
		// 任何body形态异常（非法UTF-8/非法JSON/无界嵌套）或扫描器故障/非法返回都在任何上游副作用前 fail-closed。
		let body: string;
		let findings: SecretFinding[];
		try {
			const raw = await readBodyBounded(req, MAX_BODY_BYTES, this.#deadlines.bodyMs);
			body = decodeStrictUtf8(raw);
			const rawFindings = validateFindings(this.#scan(body));
			const decodedFindings = scanJsonDecoded(body, this.#scan);
			findings = [...rawFindings, ...decodedFindings];
		} catch (err) {
			if (err instanceof BodyReadTimeoutError) {
				this.#cfg.audit?.append({
					kind: "error",
					sessionId,
					actor,
					team,
					summary: "请求体读取超时（segment=body_read），请求未达上游",
				});
				// 先把固定错误发出去再断读：客户端看到 408，而不是裸断连
				res.writeHead(408, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "请求体读取超时" } }), () => req.destroy());
				return;
			}
			if (err instanceof BodyTooLargeError) {
				this.#cfg.audit?.append({
					kind: "error",
					sessionId,
					actor,
					team,
					summary: `请求体超过上限 ${MAX_BODY_BYTES} 字节，fail-closed 拒绝（未达上游）`,
				});
				res.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "请求体超过上限" } }));
				return;
			}
			// 客户端 body 形态异常（非法 UTF-8/JSON/嵌套超限）→ 403；扫描器故障/非法返回 → 503。都未达上游。
			const isClientShape = err instanceof BodyScanError && err.category !== "scan_invalid_return";
			const status = isClientShape ? 403 : 503;
			const category = err instanceof BodyScanError ? err.category : "scan_error";
			this.#cfg.audit?.append({
				kind: "error",
				sessionId,
				actor,
				team,
				summary: `出站扫描 fail-closed（${category}），请求未达上游`,
			});
			res.writeHead(status, { "content-type": "application/json" }).end(
				JSON.stringify({ error: { message: isClientShape ? "请求体不合法，请求被拒绝" : "出站扫描失败，请求被拒绝" } }),
			);
			return;
		}

		// B3/R41：raw + 解码双层扫描已完成（上方）。命中处理不变：审计（私有面）保留 kind+脱敏 hint；
		// 回给沙箱（公共面）只有固定类别；block 模式下认证/转发都不发生。
		if (findings.length > 0) {
			// 审计（私有面）保留 kind + 脱敏 hint；回给沙箱（公共面）只有固定类别，无原文/无 hint/无 token
			this.#cfg.audit?.append({
				kind: "error",
				sessionId,
				actor,
				team,
				summary: `出站内容命中凭据特征 ${findings.length} 处：${findings.map((f) => `${f.kind}(${f.hint})`).join(", ")}`,
			});
			if (this.dlpMode === "block") {
				res.writeHead(403, { "content-type": "application/json" }).end(
					JSON.stringify({ error: { message: "出站内容命中凭据特征（dlp_block）", categories: findings.map((f) => f.kind) } }),
				);
				return;
			}
		}

		const upstream = this.#pickUpstream(req, body);
		if (!upstream) {
			res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "没有匹配的上游 provider" } }));
			return;
		}

		// S4b：原子预留（handoff §4.3）。位置在 DLP 之后（拦截的请求根本不预留）、
		// 任何上游副作用（换 token、fetch）之前（超预算连认证副作用都不该发生）。
		// reserve 在同一 IMMEDIATE 事务里做「已结算 + 在途预留 + 本次 ≤ 配额」判定：
		// 并发预留串行化，结构上不可能超卖。超额 429 固定文案、不转发、审计。
		const quota = this.#cfg.quotas?.find((q) => q.team === team)?.maxTotalTokens;
		const operationId = this.#nextOperationId(identity);
		const estimate = estimateTokens(body, this.#cfg.maxOutputTokens);
		const reserved = this.#ledger.reserve(
			{ operationId, tenant: identity.tenant, team, sessionId, model: safeModel(body) ?? "-", upstream: upstream.id, reservedTokens: estimate },
			quota,
		);
		if (!reserved.ok) {
			this.#cfg.audit?.append({
				kind: "error",
				sessionId,
				actor,
				team,
				summary: `配额耗尽：${team} 已用 ${reserved.used}/${reserved.quota}（含在途预留），本次预估 ${estimate}，拒绝转发`,
			});
			res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "团队 token 配额已用尽" } }));
			return;
		}

		const target = upstreamUrl(upstream, body);
		const headers: Record<string, string> = { "content-type": "application/json" };
		for (const name of ["session_id", "x-session-id", "x-client-request-id", "x-session-affinity"]) {
			if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
		}
		// 凭据只在这里注入 —— 沙箱侧从头到尾看不到它（upstreamAuth：避免与上方鉴权结果 auth 同名）
		const upstreamAuth = upstream.auth ?? (upstream.apiKey ? staticAuth(upstream) : null);

		// S4a：四段 deadline + 断流取消上游 + 写回背压。
		// abort.cause 是「这次请求为何结束」的唯一事实源：哪个先发生（超时/客户端断开）
		// 就记哪个，后到的 ac.abort()（如超时后又触发 res 'close'）不再改写。
		const ac = new AbortController();
		const abort: AbortState = { cause: null };
		let streamStarted = false;
		res.on("error", () => {
			// 向已断开的客户端写数据可能 EPIPE；abort 流是预期路径，不让它炸进程
		});
		res.on("close", () => {
			// writableEnded=false = 写回未正常结束：客户端断开 → 立即 abort 上游 fetch 与 reader
			if (!res.writableEnded && abort.cause === null) {
				abort.cause = { kind: "client" };
				ac.abort();
			}
		});
		const watch = new DeadlineWatch((segment) => {
			if (abort.cause !== null) return;
			abort.cause = { kind: "timeout", segment };
			ac.abort();
			// 已开始流：终止写回，让 read/drain 等待立即退出（客户端看到流被截断）
			if (streamStarted) res.destroy();
		});

		try {
			// 计时从认证开始：换 token 也是「连上游」的一部分，受 connect/总 deadline 约束
			watch.arm("total", this.#deadlines.totalMs);
			watch.arm("connect", this.#deadlines.connectMs);
			if (upstreamAuth) {
				let signed: SignedRequest;
				try {
					signed = await authorizeUpstream(upstreamAuth, { method: "POST", url: target, body }, this.#fetch, ac.signal);
				} catch (err) {
					if (abort.cause !== null) {
						this.#auditAbort(abort, sessionId, actor, team);
						// 尚未写响应头，回固定类别错误，不透传内部错误
						if (abort.cause.kind === "timeout" && !res.destroyed) {
							res.writeHead(504, { "content-type": "application/json" }).end(
								JSON.stringify({ error: { message: UPSTREAM_TIMEOUT_MESSAGE } }),
							);
						}
						return;
					}
					// 详情进审计日志，**不回给沙箱**：换 token 失败的消息里嵌着
					// 上游响应正文，长度无界、内容由上游控制，还会暴露 SA 邮箱
					// 之类的内部拓扑
					const detail = err instanceof Error ? err.message : String(err);
					this.#ledger.release(operationId); // 请求未达上游（明确未接受），释放预留
					this.#cfg.audit?.append({
						kind: "error",
						sessionId: "-",
						actor: "modelgw",
						summary: `上游 ${upstream.id} 认证失败：${detail.slice(0, 500)}`,
					});
					res.writeHead(502, { "content-type": "application/json" }).end(
						JSON.stringify({ error: { message: "上游认证失败，详情见网关审计日志" } }),
					);
					return;
				}
				Object.assign(headers, signed.headers);
			}
			// 换 token 用掉的时间不挤占真正连上游的窗口：connect 段重新起算；总时长不重置
			watch.arm("connect", this.#deadlines.connectMs);

			// redirect:"error"（B3）：携带凭据的上游请求逐跳拒绝重定向 —— 不跟随跨 host/同 host 多跳，
			// 不把 hostname allowlist 当作 DNS/SSRF 隔离（那要靠网络层）。上游想重定向 = 本次请求失败。
			let upRes: Response;
			try {
				upRes = await this.#fetch(target, { method: "POST", headers, body, redirect: "error", signal: ac.signal });
			} catch (err) {
				watch.disarm("connect");
				if (abort.cause !== null) {
					// 我方中止：上游是否已受理未知 → usage_unknown 保守保留预留
					this.#ledger.markUsageUnknown(operationId);
					this.#auditAbort(abort, sessionId, actor, team);
					if (abort.cause.kind === "timeout" && !res.destroyed) {
						res.writeHead(504, { "content-type": "application/json" }).end(
							JSON.stringify({ error: { message: UPSTREAM_TIMEOUT_MESSAGE } }),
						);
					}
					return;
				}
				// 连接前失败（连接拒绝/DNS 等）= 上游明确未接受 → 释放预留；502 语义不变
				this.#ledger.release(operationId);
				this.#cfg.audit?.append({
					kind: "error",
					sessionId,
					actor,
					team,
					summary: `上游连接失败（未接受，预留已释放）：${String(err).slice(0, 200)}`,
				});
				throw err; // 真实上游错误 → 保留既有 502 透传语义（#handle）
			}
			watch.disarm("connect");
			// S4b：上游请求 id 入账（有则记，无则空串 —— 字段口径保证存在）
			const providerRequestId = upRes.headers.get("x-request-id") ?? "";
			if (abort.cause !== null) {
				// abort 与 fetch 完成之间的窄窗口：按已记录原因收尾，不把死响应写给客户端；
				// 上游是否受理未知 → usage_unknown 保守保留预留
				this.#ledger.markUsageUnknown(operationId, providerRequestId);
				this.#auditAbort(abort, sessionId, actor, team);
				return;
			}

			// 上游的错误正文**有意透传**给沙箱：agent 要据此判断是 rate limit、
			// context 超长还是参数错误，并决定重试还是改写请求。这与换 token
			// 失败不同 —— 那种错误对 agent 毫无用处，纯粹是内部拓扑泄漏。
			res.writeHead(upRes.status, {
				"content-type": upRes.headers.get("content-type") ?? "text/event-stream",
				"cache-control": "no-cache",
			});
			// SSE 代理：头立即冲给客户端，不等首个 body chunk —— 客户端/SDK 的 header
			// 超时不会误触；后续首 token/idle 超时截断时，客户端看到的是
			// 「已写头 + 流被截断」而非裸断连。
			res.flushHeaders();
			streamStarted = true;

			const usage = await pipeAndMeter(upRes, res, watch, abort, this.#deadlines);
			// S4b 计量矩阵（handoff §4.3：无 usage 不免单，也不写成 0 假成功）：
			// - 4xx：上游明确未接受（未计费）→ release；
			// - 中止/断流：受理与否未知 → usage_unknown 保守保留预留；
			// - 5xx / 2xx 无 usage：结果不可计量 → usage_unknown；
			// - 2xx 有 usage：按真实 usage settle（替换预留，幂等）。
			if (upRes.status >= 400 && upRes.status < 500) {
				this.#ledger.release(operationId, providerRequestId);
				return;
			}
			if (abort.cause !== null && !res.writableEnded) {
				this.#ledger.markUsageUnknown(operationId, providerRequestId);
				// 中止/断流：固定类别审计 + 段别 + usage_unknown；预留保留，等对账
				this.#auditAbort(abort, sessionId, actor, team);
				return;
			}
			if (upRes.status >= 500) {
				this.#ledger.markUsageUnknown(operationId, providerRequestId);
				this.#cfg.audit?.append({
					kind: "error",
					sessionId,
					actor,
					team,
					summary: `上游 ${upRes.status}，计费结果未知（usage_unknown），预留保守保留`,
				});
				return;
			}
			if (usage.total > 0) {
				this.#ledger.settle(
					operationId,
					{ input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite },
					providerRequestId,
				);
				this.#cfg.audit?.append({
					kind: "usage",
					sessionId,
					actor,
					team,
					summary: `模型网关计量 ${usage.total} token（${upstream.id}）`,
					tokensInput: usage.input,
					tokensOutput: usage.output,
					tokensCacheRead: usage.cacheRead,
					tokensCacheWrite: usage.cacheWrite,
					tokensTotal: usage.total,
				});
			} else {
				// 完整成功流却没拿到 usage：不能写成 0 免单，标 usage_unknown 保守保留预留
				this.#ledger.markUsageUnknown(operationId, providerRequestId);
				this.#cfg.audit?.append({
					kind: "error",
					sessionId,
					actor,
					team,
					summary: "上游流正常结束但未报告 usage，按 usage_unknown 保守保留预留（不写成 0，不自动重试）",
				});
			}
		} finally {
			watch.disarmAll();
		}
	}

	/**
	 * S4b：认证 + 归属解析。优先静态 token（常量时间比较）；否则（配置了 scopedTokenKey 时）
	 * 按 scoped 凭证验签。归属三元组只来自凭证本身 —— 请求头一律不参与。
	 */
	#authenticate(req: IncomingMessage):
		| { ok: true; identity: GatewayIdentity }
		| { ok: false; reason: "missing" | "invalid" | ScopedTokenRejectReason } {
		const h = req.headers.authorization;
		const presented =
			typeof h === "string" && h.startsWith("Bearer ")
				? h.slice(7)
				: typeof req.headers["api-key"] === "string"
					? req.headers["api-key"]
					: undefined;
		if (presented === undefined) return { ok: false, reason: "missing" };
		if (timingSafeTokenEqual(presented, this.#cfg.token)) {
			return {
				ok: true,
				identity: { via: "static", tenant: "local", team: this.#cfg.defaultTeam ?? DEFAULT_TEAM, sessionId: "unknown" },
			};
		}
		if (this.#cfg.scopedTokenKey === undefined) return { ok: false, reason: "invalid" };
		const v = verifyScopedToken(presented, this.#cfg.scopedTokenKey);
		if (!v.ok) return { ok: false, reason: v.reason };
		return {
			ok: true,
			identity: { via: "scoped", tenant: v.identity.tenant, team: v.identity.team, sessionId: v.identity.sessionId, jti: v.identity.jti },
		};
	}

	/** S4b：operationId 服务端生成 —— scoped 凭证用 jti:序号（同凭证多请求可归因），静态用 UUID */
	#nextOperationId(identity: GatewayIdentity): string {
		if (identity.via !== "scoped" || identity.jti === undefined) return randomUUID();
		const seq = (this.#opSeq.get(identity.jti) ?? 0) + 1;
		this.#opSeq.set(identity.jti, seq);
		return `${identity.jti}:${seq}`;
	}

	#pickUpstream(req: IncomingMessage, body: string): UpstreamConfig | undefined {
		const explicit = req.headers["x-perimeter-provider"];
		if (typeof explicit === "string") return this.#cfg.upstreams.find((u) => u.id === explicit);
		// 约定 model 形如 "<provider>/<model>"；没有前缀就用第一个上游
		const model = safeModel(body);
		const prefix = model?.includes("/") ? model.split("/")[0] : undefined;
		return this.#cfg.upstreams.find((u) => u.id === prefix) ?? this.#cfg.upstreams[0];
	}
}

/** 出口 allowlist 是真正的安全边界，配置期就要拒绝名单外的上游 */
export function assertAllowed(baseUrl: string, allowlist: string[], what = "上游"): void {
	const host = new URL(baseUrl).hostname;
	if (!allowlist.includes(host)) {
		throw new Error(`模型网关${what} ${host} 不在 egress allowlist 内：${allowlist.join(", ")}`);
	}
}

/** S4a：deadline 段别（审计 summary 里的 segment= 值） */
export type DeadlineSegment = "body_read" | "connect" | "first_token" | "idle" | "total";

/** 超时时回给沙箱的 504 固定文案 —— 不透传内部错误（AbortError 等） */
const UPSTREAM_TIMEOUT_MESSAGE = "上游响应超时，请求已中止";

/** 上游请求结束原因的唯一事实源：超时（含段别）或客户端断开 */
interface AbortState {
	cause: { kind: "timeout"; segment: DeadlineSegment } | { kind: "client" } | null;
}

/**
 * S4a：deadline 计时器组。同段重臂 = 重置计时（idle 逐 chunk / drain 重臂）；
 * disarmAll 在请求收尾时清掉全部句柄，node --test 能自然退出。
 */
class DeadlineWatch {
	#timers = new Map<DeadlineSegment, NodeJS.Timeout>();
	#fire: (segment: DeadlineSegment) => void;
	constructor(fire: (segment: DeadlineSegment) => void) {
		this.#fire = fire;
	}
	arm(segment: DeadlineSegment, ms: number): void {
		this.disarm(segment);
		this.#timers.set(
			segment,
			setTimeout(() => {
				this.#timers.delete(segment);
				this.#fire(segment);
			}, ms),
		);
	}
	disarm(segment: DeadlineSegment): void {
		const timer = this.#timers.get(segment);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.#timers.delete(segment);
		}
	}
	disarmAll(): void {
		for (const timer of this.#timers.values()) clearTimeout(timer);
		this.#timers.clear();
	}
}

/**
 * 边转发边计量。刻意流式转发而不是缓冲整包：
 * 长回复缓冲会让首 token 延迟变成整轮延迟，而验收指标里有「首 token < 3s」。
 *
 * S4a：每个 await 都有 deadline（首 chunk 前是 first_token，之后是 idle，逐 chunk 重臂）；
 * 写回遵守背压（write 返回 false 等 drain，等待受 idle/总 deadline 约束）。
 * 我方中止（超时/客户端断开）时返回已计量的部分结果，由调用方按 abort.cause 统一收尾；
 * 上游自身故障仍然抛出，保持 #handle 的既有 502 语义。
 */
async function pipeAndMeter(
	upRes: Response,
	res: ServerResponse,
	watch: DeadlineWatch,
	abort: AbortState,
	deadlines: Required<GatewayDeadlines>,
): Promise<Usage> {
	const usage: Usage = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	if (!upRes.body) {
		res.end();
		return usage;
	}
	const reader = upRes.body.getReader();
	const decoder = new TextDecoder();
	let tail = "";
	let first = true;
	for (;;) {
		if (res.destroyed) return usage;
		watch.arm(first ? "first_token" : "idle", first ? deadlines.firstTokenMs : deadlines.idleMs);
		let read: Awaited<ReturnType<typeof reader.read>>;
		try {
			read = await reader.read();
		} catch (err) {
			if (abort.cause !== null) return usage; // 我方中止：调用方按原因审计收尾
			throw err; // 上游自身故障：保留既有 502 语义
		} finally {
			watch.disarm(first ? "first_token" : "idle");
		}
		if (read.done) break;
		first = false;
		const chunk = decoder.decode(read.value, { stream: true });
		await writeChunk(res, chunk, deadlines.idleMs, watch);
		tail = readUsage(tail + chunk, usage);
	}
	res.end();
	return usage;
}

/**
 * S4a：写回背压。res.write 返回 false 时等 'drain'（或 close/error），等待受 idle 段
 * 约束（总时长始终有效）。等待期间不读上游，TCP 背压逐级传到上游侧，
 * 网关进程内缓冲有界（socket 写缓冲 + 当前这一个 chunk）。
 */
function writeChunk(res: ServerResponse, chunk: string, idleMs: number, watch: DeadlineWatch): Promise<void> {
	return new Promise((resolve) => {
		if (res.write(chunk)) {
			resolve();
			return;
		}
		watch.arm("idle", idleMs);
		const done = () => {
			res.off("drain", done);
			res.off("close", done);
			res.off("error", done);
			watch.disarm("idle");
			resolve();
		};
		res.once("drain", done);
		res.once("close", done);
		res.once("error", done);
	});
}

/** 从 SSE 流里抓 usage 字段；返回尚未成行的残留 */
function readUsage(buf: string, usage: Usage): string {
	let rest = buf;
	let i: number;
	while ((i = rest.indexOf("\n")) >= 0) {
		const line = rest.slice(0, i).trim();
		rest = rest.slice(i + 1);
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (payload === "[DONE]") continue;
		try {
			// S4b：cache 字段按 provider 定义归一化（handoff §4.3「区分 cache 是否已含在 input」）：
			// OpenAI 风格 prompt_tokens **已包含** cached（prompt_tokens_details.cached_tokens 是其子集），
			// cacheRead 只记录、不叠加进 total，否则同一批 token 会被算两遍（双算抬高配额占用与账单）；
			// Anthropic 风格字段（cache_read/creation_input_tokens）与 input 分离，同样只入账本字段。
			// 配额占用口径统一 = input + output（见 budget-ledger.ts 的占用 SQL）。
			const u = (JSON.parse(payload) as {
				usage?: {
					prompt_tokens?: number;
					completion_tokens?: number;
					total_tokens?: number;
					prompt_tokens_details?: { cached_tokens?: number };
					cache_read_input_tokens?: number;
					cache_creation_input_tokens?: number;
				};
			}).usage;
			if (u) {
				usage.input = u.prompt_tokens ?? usage.input;
				usage.output = u.completion_tokens ?? usage.output;
				usage.total = u.total_tokens ?? usage.input + usage.output;
				usage.cacheRead = u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? usage.cacheRead;
				usage.cacheWrite = u.cache_creation_input_tokens ?? usage.cacheWrite;
			}
		} catch {
			// 上游偶发的非 JSON 行不该中断转发
		}
	}
	// 只保留最后一段未成行的数据，避免长会话把整条流攒在内存里
	return rest.length > 64 * 1024 ? "" : rest;
}

function safeModel(body: string): string | undefined {
	try {
		return (JSON.parse(body) as { model?: string }).model;
	} catch {
		return undefined;
	}
}

class BodyTooLargeError extends Error {
	constructor() {
		super("request body too large");
		this.name = "BodyTooLargeError";
	}
}

class BodyReadTimeoutError extends Error {
	constructor() {
		super("request body read timeout");
		this.name = "BodyReadTimeoutError";
	}
}

/** readBody + 读取超时：客户端慢发 body 时在 bodyMs 内拒绝，而不是无限挂住（字节上限不变） */
async function readBodyBounded(req: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<Buffer> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			readBody(req, maxBytes),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new BodyReadTimeoutError()), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** 完整 body 有界读取（Buffer；超限立即停止读，不新增无界 buffer）。严格 UTF-8 解码在上层统一做 */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const c of req) {
		total += (c as Buffer).length;
		if (total > maxBytes) throw new BodyTooLargeError();
		chunks.push(c as Buffer);
	}
	return Buffer.concat(chunks);
}

/**
 * 上游 URL。默认 OpenAI 兼容的 /chat/completions；
 * Bedrock 那种带模型 id 的路径用 {model} 占位，从请求体里取。
 */
export function upstreamUrl(upstream: UpstreamConfig, body: string): string {
	const base = upstream.baseUrl.replace(/\/$/, "");
	const path = upstream.path ?? "/chat/completions";
	if (!path.includes("{model}")) return `${base}${path}`;

	let model = "";
	try {
		model = String((JSON.parse(body) as { model?: unknown }).model ?? "");
	} catch {
		// body 不是 JSON 时留空，让上游去报错 —— 网关不解析 body 是有意的
	}
	// 剥掉选路用的 provider 前缀：#pickUpstream 认的是 `<provider>/<model>`，
	// 而上游要的是不带前缀的模型 id。不剥的话 URL 里会多一段 provider 名
	if (model.startsWith(`${upstream.id}/`)) model = model.slice(upstream.id.length + 1);

	// model 来自沙箱，会被拼进 URL 路径。encodeURIComponent 不转义 `.`，
	// 所以 `..` 能穿越一层目录（主机换不掉，但路径会变，且穿越后仍被合法签名）。
	// 模型 id 与 ARN 都在这个字符集内。
	if (model && !/^[A-Za-z0-9._:/-]+$/.test(model)) {
		throw new Error(`非法的 model 值：${model.slice(0, 60)}`);
	}
	if (model.split("/").some((seg) => seg === "..")) throw new Error("model 不得含路径穿越");

	return `${base}${path.replace("{model}", encodeURIComponent(model))}`;
}

function staticAuth(u: UpstreamConfig): UpstreamAuth {
	return { kind: "static", apiKey: u.apiKey!, header: u.authHeader };
}

/** S4b：静态请求的缺省归属团队 */
const DEFAULT_TEAM = "default";

/** S4b：请求未声明 max_tokens 时的最大输出预留 —— 与 models.ts 目录 maxTokens=8192 对齐 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

interface GatewayIdentity {
	via: "scoped" | "static";
	tenant: string;
	team: string;
	sessionId: string;
	/** scoped 凭证唯一 id；operationId 以 jti:序号 派生（服务端生成，不信客户端） */
	jti?: string;
}

/** 常量时间的静态 token 比较（长度不等也跑一次等长比较，避免时长泄漏长度信息） */
function timingSafeTokenEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a, "utf8");
	const bb = Buffer.from(b, "utf8");
	if (ab.length !== bb.length) {
		timingSafeEqual(ab, ab);
		return false;
	}
	return timingSafeEqual(ab, bb);
}

/**
 * S4b：预留估算 = 输入估计 + 最大输出。
 * 输入估计用 body 字节/4（≈4 字节/token 的粗估；中文与代码实际更稠密，会低估 ——
 * 低估的敞口由「结算替换预留、usage_unknown 不释放」兜底：结算用量超出预留的部分
 * 会计入已占用，只是当次可能挤过闸门；更保守的系数是配置演进，不在本轮拍死）。
 * 最大输出取请求 max_tokens / max_completion_tokens，缺省用配置 maxOutputTokens。
 */
function estimateTokens(body: string, configuredMaxOutput?: number): number {
	const maxOutput = parseMaxOutputTokens(body) ?? configuredMaxOutput ?? DEFAULT_MAX_OUTPUT_TOKENS;
	return Math.ceil(Buffer.byteLength(body, "utf8") / 4) + maxOutput;
}

function parseMaxOutputTokens(body: string): number | undefined {
	try {
		const m = JSON.parse(body) as { max_tokens?: unknown; max_completion_tokens?: unknown };
		for (const v of [m.max_tokens, m.max_completion_tokens]) {
			if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
		}
	} catch {
		// body 不是 JSON：走配置缺省
	}
	return undefined;
}
