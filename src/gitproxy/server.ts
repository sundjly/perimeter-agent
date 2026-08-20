import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { AuditLog } from "../audit/log.ts";

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
	 * 项目其余各处也是这个方向（策略求值失败→deny、钩子未挂→不跑 prompt、
	 * 未知工具→受路径约束）。
	 */
	allowPush?: boolean;
}

export interface GitProxyConfig {
	port: number;
	host: string;
	/** 沙箱访问代理时使用的会话 token —— 不是 git 凭据 */
	token: string;
	repos: RepoMapping[];
	audit?: AuditLog;
	fetchImpl?: typeof fetch;
}

/** git smart HTTP 只有这三类端点 */
const UPLOAD_PACK = "/git-upload-pack";
const RECEIVE_PACK = "/git-receive-pack";
const INFO_REFS = "/info/refs";

/**
 * Git 凭据代理 —— 铁律 2「凭据永不进沙箱」的落地。
 *
 * 沙箱里的 remote 指向 http://git-proxy.internal/<name>，代理按名字查表、
 * 鉴权、注入真 token 后转发到真实上游。沙箱被 prompt injection 攻陷，
 * 顶多能操作 allowlist 里的那几个仓库，偷不到可以拿去别处用的凭据。
 *
 * 两个容易被忽略、但决定这层是否有意义的点：
 *
 * 1. **仓库 allowlist 不是锦上添花。** 代理手里握着组织级的 token，
 *    如果按沙箱给的任意 URL 转发，agent 就能借代理之手 clone 组织内
 *    任何仓库 —— 凭据没泄漏，但数据泄漏了，等价于凭据泄漏。
 * 2. **push 必须能被单独识别并留痕。** git 的推送走 git-receive-pack，
 *    与 fetch 的 git-upload-pack 是不同端点，这让「推送」成为一个
 *    可在网络层判定的事实，而不是靠猜命令行。
 */
export class GitCredentialProxy {
	#cfg: GitProxyConfig;
	#http = createServer();
	#fetch: typeof fetch;

	constructor(cfg: GitProxyConfig) {
		this.#cfg = cfg;
		this.#fetch = cfg.fetchImpl ?? fetch;
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

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			await this.#route(req, res);
		} catch (err) {
			if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
			res.end(`git 代理上游失败：${String(err)}`);
		}
	}

	async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname === "/healthz") {
			res.writeHead(200).end("ok");
			return;
		}
		if (!this.#authorized(req)) {
			// git 客户端见到 401 会去问 credential helper；沙箱侧配的是
			// 一个固定吐会话 token 的 helper，所以这里给出标准挑战。
			res.writeHead(401, { "www-authenticate": 'Basic realm="perimeter-git-proxy"' }).end("未授权");
			return;
		}

		const parsed = parsePath(url.pathname);
		if (!parsed) {
			res.writeHead(404).end("不支持的 git 端点");
			return;
		}

		const repo = this.#cfg.repos.find((r) => r.name === parsed.repo);
		if (!repo) {
			// 不在 allowlist 内 —— 代理持有组织级 token，这一步不做就等于把它借出去了
			this.#audit(req, parsed.repo, `拒绝：仓库 ${parsed.repo} 不在 allowlist 内`, "deny");
			res.writeHead(403).end("仓库不在 allowlist 内");
			return;
		}

		// 端点与方法的对应是固定的：info/refs 只收 GET，两个 pack 端点只收 POST。
		// 不限制的话 PUT/DELETE/MOVE 都会带着注入的组织级凭据转发到上游 ——
		// 正规 git 服务端不实现这些方法，但没有理由替沙箱把它们递过去
		const wantMethod = parsed.endpoint === INFO_REFS ? "GET" : "POST";
		if ((req.method ?? "GET") !== wantMethod) {
			res.writeHead(405, { allow: wantMethod }).end("方法不允许");
			return;
		}

		const isPush = parsed.endpoint === RECEIVE_PACK || url.searchParams.get("service") === "git-receive-pack";
		if (isPush && repo.allowPush !== true) {
			this.#audit(req, repo.name, `拒绝推送：${repo.name} 未显式授权推送`, "deny");
			res.writeHead(403).end("该仓库为只读");
			return;
		}

		const target = new URL(repo.upstream.replace(/\/$/, "") + parsed.endpoint);
		// 只透传 git 协议真正需要的那个参数。全量透传的真实危害是**重复参数**：
		// `?service=git-upload-pack&service=git-receive-pack` 下，isPush 读的是
		// 第一个值（判定为非 push、放行），而循环 set 会用最后一个值覆盖 ——
		// 上游于是收到 receive-pack。「代理认为不是推送」与「上游按推送处理」
		// 同时成立，正是只读仓库最不该出现的状态。
		// 只在值恰好等于两个已知常量之一时才透传：否则「代理判定不是 push」
		// 与「上游收到一个 receive-pack 形状的字符串」会不一致，
		// 而那个不一致只会出现在审计盲区里
		const service = url.searchParams.get("service");
		if (service === "git-upload-pack" || service === "git-receive-pack") {
			target.searchParams.set("service", service);
		}

		const headers: Record<string, string> = {};
		// git 客户端的这几个头必须原样带上，否则协议协商会失败
		for (const h of ["content-type", "accept", "git-protocol", "content-encoding"]) {
			const v = req.headers[h];
			if (typeof v === "string") headers[h] = v;
		}
		if (repo.token) {
			// 凭据在这里、且只在这里注入
			headers.authorization = `Basic ${Buffer.from(`${repo.username ?? "x-access-token"}:${repo.token}`).toString("base64")}`;
		}

		const hasBody = req.method === "POST";
		const upRes = await this.#fetch(target, {
			method: req.method ?? "GET",
			headers,
			body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
			// 流式转发请求体：git 的 pack 文件可能很大，缓冲会吃满内存
			...(hasBody ? { duplex: "half" } : {}),
		} as RequestInit);

		if (isPush) {
			this.#audit(req, repo.name, `推送到 ${repo.name}（上游 ${redactUrl(repo.upstream)}）`, "allow");
		}

		const outHeaders: Record<string, string> = {};
		for (const h of ["content-type", "cache-control", "content-encoding"]) {
			const v = upRes.headers.get(h);
			if (v) outHeaders[h] = v;
		}
		res.writeHead(upRes.status, outHeaders);
		if (upRes.body) {
			// @ts-expect-error Node 的 Readable.fromWeb 类型与 DOM ReadableStream 不完全对齐
			Readable.fromWeb(upRes.body).pipe(res);
		} else {
			res.end();
		}
	}

	#authorized(req: IncomingMessage): boolean {
		const h = req.headers.authorization ?? "";
		if (h === `Bearer ${this.#cfg.token}`) return true;
		if (h.startsWith("Basic ")) {
			// git 只会用 Basic：任一字段等于会话 token 即可
			const [user, pass] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
			return pass === this.#cfg.token || user === this.#cfg.token;
		}
		return false;
	}

	#audit(req: IncomingMessage, repo: string, summary: string, verdict: string): void {
		this.#cfg.audit?.append({
			kind: "git.push",
			sessionId: String(req.headers["x-perimeter-session"] ?? "unknown"),
			actor: String(req.headers["x-perimeter-actor"] ?? "unknown"),
			repo,
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
