import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AuditLog } from "../audit/log.ts";
import { scanSecrets } from "./secrets.ts";

export interface UpstreamConfig {
	/** provider id，客户端用 model 前缀或 header 选择 */
	id: string;
	/** 完整的上游 base url，如 https://xxx.openai.azure.com/openai/v1 */
	baseUrl: string;
	/** 注入到上游请求的凭据。**只存在于网关，永不进沙箱** */
	apiKey?: string;
	/** 认证方式：多数是 Authorization: Bearer，Azure 用 api-key */
	authHeader?: string;
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
 * **接入方式与一个已知缺口**：本网关说 OpenAI 兼容协议
 * （/v1/chat/completions），pi 侧用 models.json 的 baseUrl 指过来即可，
 * 这条路已实测跑通且零额外依赖。Azure OpenAI 与自托管 vLLM 原生就是
 * 这个协议。**Bedrock 与 Vertex 的原生协议不是**，它们需要各自 SDK 签名
 * （且 Bedrock 只能在服务端调）—— 这两条通道是 Phase 1 的已知缺口，
 * 企业客户多数已有 OpenAI 兼容的内部网关可先接上，但销售材料里
 * 不要写成「已支持 Bedrock/Vertex」。
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
		for (const u of cfg.upstreams) {
			assertAllowed(u.baseUrl, cfg.egressAllowlist);
			// HTTP header 只能是 ASCII。不在这里查的话，一个含非 ASCII 的凭据
			// 会变成运行时 502，而不是启动时一眼可见的配置错误。
			if (u.apiKey && !/^[\x20-\x7e]*$/.test(u.apiKey)) {
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
		const sessionId = String(req.headers["x-perimeter-session"] ?? "unknown");
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

		const headers: Record<string, string> = { "content-type": "application/json" };
		if (upstream.apiKey) {
			// 凭据只在这里注入 —— 沙箱侧从头到尾看不到它
			headers[upstream.authHeader ?? "authorization"] =
				upstream.authHeader ? upstream.apiKey : `Bearer ${upstream.apiKey}`;
		}

		const upRes = await this.#fetch(`${upstream.baseUrl.replace(/\/$/, "")}/chat/completions`, {
			method: "POST",
			headers,
			body,
		});

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
export function assertAllowed(baseUrl: string, allowlist: string[]): void {
	const host = new URL(baseUrl).hostname;
	if (!allowlist.includes(host)) {
		throw new Error(`模型网关上游 ${host} 不在 egress allowlist 内：${allowlist.join(", ")}`);
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
