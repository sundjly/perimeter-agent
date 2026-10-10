import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AuditLog } from "../audit/log.ts";
import { scanSecrets } from "./secrets.ts";
import { GCP_TOKEN_HOST, type UpstreamAuth, authorizeUpstream } from "./upstream-auth.ts";

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
	audit?: AuditLog;
	/** 便于测试注入；默认用全局 fetch */
	fetchImpl?: typeof fetch;
}

interface Usage {
	total: number;
	input: number;
	output: number;
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
	/** team → 已用 token */
	#used = new Map<string, number>();

	constructor(cfg: ModelGatewayConfig) {
		this.#cfg = cfg;
		this.#fetch = cfg.fetchImpl ?? fetch;
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
		this.#http.on("request", (req, res) => void this.#handle(req, res));
	}

	async listen(): Promise<number> {
		await new Promise<void>((r) => this.#http.listen(this.#cfg.port, this.#cfg.host, r));
		const addr = this.#http.address();
		return typeof addr === "object" && addr ? addr.port : this.#cfg.port;
	}

	async close(): Promise<void> {
		this.#http.closeAllConnections();
		await new Promise<void>((r) => this.#http.close(() => r()));
	}

	usedTokens(team: string): number {
		return this.#used.get(team) ?? 0;
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
		if (!this.#authorized(req)) {
			res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "未授权" } }));
			return;
		}

		const team = String(req.headers["x-perimeter-team"] ?? "default");
		const sessionId = String(req.headers.session_id ?? req.headers["x-session-affinity"] ?? req.headers["x-perimeter-session"] ?? "unknown");
		const actor = String(req.headers["x-perimeter-actor"] ?? "unknown");
		const body = await readBody(req);

		const quota = this.#cfg.quotas?.find((q) => q.team === team);
		if (quota && this.usedTokens(team) >= quota.maxTotalTokens) {
			this.#cfg.audit?.append({
				kind: "error",
				sessionId,
				actor,
				team,
				summary: `配额耗尽：${team} 已用 ${this.usedTokens(team)}/${quota.maxTotalTokens}`,
			});
			res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "团队 token 配额已用尽" } }));
			return;
		}

		// audit-only：检测并留痕，不改写请求体
		const findings = scanSecrets(body);
		if (findings.length > 0) {
			this.#cfg.audit?.append({
				kind: "error",
				sessionId,
				actor,
				team,
				summary: `出站内容命中凭据特征 ${findings.length} 处：${findings.map((f) => `${f.kind}(${f.hint})`).join(", ")}`,
			});
		}

		const upstream = this.#pickUpstream(req, body);
		if (!upstream) {
			res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "没有匹配的上游 provider" } }));
			return;
		}

		const target = upstreamUrl(upstream, body);
		const headers: Record<string, string> = { "content-type": "application/json" };
		for (const name of ["session_id", "x-session-id", "x-client-request-id", "x-session-affinity"]) {
			if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
		}
		// 凭据只在这里注入 —— 沙箱侧从头到尾看不到它
		const auth = upstream.auth ?? (upstream.apiKey ? staticAuth(upstream) : null);
		if (auth) {
			try {
				const signed = await authorizeUpstream(auth, { method: "POST", url: target, body }, this.#fetch);
				Object.assign(headers, signed.headers);
			} catch (err) {
				// 详情进审计日志，**不回给沙箱**：换 token 失败的消息里嵌着
				// 上游响应正文，长度无界、内容由上游控制，还会暴露 SA 邮箱
				// 之类的内部拓扑
				const detail = err instanceof Error ? err.message : String(err);
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
		}

		const upRes = await this.#fetch(target, { method: "POST", headers, body });
		// 上游的错误正文**有意透传**给沙箱：agent 要据此判断是 rate limit、
		// context 超长还是参数错误，并决定重试还是改写请求。这与换 token
		// 失败不同 —— 那种错误对 agent 毫无用处，纯粹是内部拓扑泄漏。

		res.writeHead(upRes.status, {
			"content-type": upRes.headers.get("content-type") ?? "text/event-stream",
			"cache-control": "no-cache",
		});

		const usage = await pipeAndMeter(upRes, res);
		if (usage.total > 0) {
			this.#used.set(team, this.usedTokens(team) + usage.total);
			this.#cfg.audit?.append({
				kind: "usage",
				sessionId,
				actor,
				team,
				summary: `模型网关计量 ${usage.total} token（${upstream.id}）`,
				tokensInput: usage.input,
				tokensOutput: usage.output,
				tokensTotal: usage.total,
			});
		}
	}

	#authorized(req: IncomingMessage): boolean {
		const h = req.headers.authorization;
		return h === `Bearer ${this.#cfg.token}` || req.headers["api-key"] === this.#cfg.token;
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

/**
 * 边转发边计量。刻意流式转发而不是缓冲整包：
 * 长回复缓冲会让首 token 延迟变成整轮延迟，而验收指标里有「首 token < 3s」。
 */
async function pipeAndMeter(upRes: Response, res: ServerResponse): Promise<Usage> {
	const usage: Usage = { total: 0, input: 0, output: 0 };
	if (!upRes.body) {
		res.end();
		return usage;
	}
	const reader = upRes.body.getReader();
	const decoder = new TextDecoder();
	let tail = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = decoder.decode(value, { stream: true });
		res.write(chunk);
		tail = readUsage(tail + chunk, usage);
	}
	res.end();
	return usage;
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
			const u = (JSON.parse(payload) as { usage?: Record<string, number> }).usage;
			if (u) {
				usage.input = u.prompt_tokens ?? usage.input;
				usage.output = u.completion_tokens ?? usage.output;
				usage.total = u.total_tokens ?? usage.input + usage.output;
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

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString("utf8");
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
