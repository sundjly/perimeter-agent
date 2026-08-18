import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { AuditLog } from "../audit/log.ts";
import type { ClientCommand, ClientEvent } from "../protocol/types.ts";
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
	piEnv?: NodeJS.ProcessEnv;
	approvalTimeoutMs?: number;
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
};

/**
 * 会话网关。浏览器经 WebSocket 连到这里，网关为每个会话拉起一个 pi 进程。
 *
 * 身份这块 Phase 1 只做到共享 token：它的作用是把演示环境关起来，
 * 不是企业级身份。OIDC/SAML + RBAC 在 Phase 2，不要拿现在这个去过安全评审。
 */
export class Gateway {
	#cfg: GatewayConfig;
	#audit: AuditLog;
	#http = createServer();
	#wss = new WebSocketServer({ noServer: true });
	#sessions = new Map<string, Session>();

	constructor(cfg: GatewayConfig) {
		this.#cfg = cfg;
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
	}

	async listen(): Promise<number> {
		await new Promise<void>((r) => this.#http.listen(this.#cfg.port, this.#cfg.host, r));
		const addr = this.#http.address();
		return typeof addr === "object" && addr ? addr.port : this.#cfg.port;
	}

	async close(): Promise<void> {
		for (const s of this.#sessions.values()) await s.stop();
		this.#sessions.clear();
		// 必须先断开在途连接：http.close() 要等所有连接关闭才回调，
		// 而 WebSocket 是长连接，不主动断开就会一直等下去。
		for (const client of this.#wss.clients) client.terminate();
		this.#wss.close();
		this.#http.closeAllConnections();
		await new Promise<void>((r) => this.#http.close(() => r()));
		this.#audit.close();
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
		const repo = url.searchParams.get("repo") ?? "demo";
		const team = url.searchParams.get("team") ?? "demo";
		const sessionId = url.searchParams.get("session") ?? randomUUID();

		const existing = this.#sessions.get(sessionId);
		if (existing) {
			// 断线重连：不重启 pi，重新挂上传输即可
			attach(ws, existing);
			return;
		}

		const session = new Session({
			sessionId,
			actor,
			repo,
			team,
			workspace: join(this.#cfg.workspaceRoot, sessionId),
			policyFile: this.#cfg.policyFile,
			audit: this.#audit,
			piBin: this.#cfg.piBin,
			piArgs: this.#cfg.piArgs,
			piEnv: this.#cfg.piEnv,
			approvalTimeoutMs: this.#cfg.approvalTimeoutMs,
			send: (ev, seq) => broadcast(session, ev, seq),
		});
		this.#sessions.set(sessionId, session);
		attach(ws, session);
		void session.start();
	}

	#serveStatic(req: IncomingMessage, res: ServerResponse): void {
		const url = new URL(req.url ?? "/", "http://localhost");
		const rel = url.pathname === "/" ? "/index.html" : url.pathname;
		// 归一化后必须仍在 webRoot 下，否则 ../ 能读到仓库里的任意文件
		const file = join(this.#cfg.webRoot, normalize(rel));
		if (!file.startsWith(this.#cfg.webRoot) || !existsSync(file)) {
			res.writeHead(404).end("not found");
			return;
		}
		res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
		createReadStream(file).pipe(res);
	}
}

/** 一个会话可以同时连着多个传输（刷新页面、多标签），事件广播给全部 */
const transports = new WeakMap<Session, Set<WebSocket>>();

function attach(ws: WebSocket, session: Session): void {
	const set = transports.get(session) ?? new Set<WebSocket>();
	set.add(ws);
	transports.set(session, set);

	ws.on("message", (raw) => {
		let cmd: ClientCommand;
		try {
			cmd = JSON.parse(String(raw)) as ClientCommand;
		} catch {
			ws.send(JSON.stringify({ seq: 0, event: { type: "error", code: "command_failed", message: "非法的命令 JSON" } }));
			return;
		}
		session.handle(cmd);
	});
	ws.on("close", () => set.delete(ws));
	// 传输层错误不应连带打死会话：任务在服务端继续跑，用户重连即可续上
	ws.on("error", () => set.delete(ws));

	ws.send(JSON.stringify({ seq: session.lastSeq, event: { type: "session.state", streaming: false, messageCount: 0, model: null } }));
}

function broadcast(session: Session, event: ClientEvent, seq: number): void {
	const payload = JSON.stringify({ seq, event });
	for (const ws of transports.get(session) ?? []) {
		if (ws.readyState === ws.OPEN) ws.send(payload);
	}
}

function bearer(header: string | undefined): string | null {
	return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

// 直接运行时按环境变量启动
if (process.argv[1] && import.meta.filename === process.argv[1]) {
	const root = join(import.meta.dirname, "..", "..");
	const gw = new Gateway({
		port: Number(process.env.PORT ?? 8787),
		host: process.env.HOST ?? "127.0.0.1",
		token: process.env.PERIMETER_TOKEN ?? "dev-token",
		policyFile: process.env.PERIMETER_POLICY_FILE ?? join(root, "config/policy.yaml"),
		auditFile: process.env.PERIMETER_AUDIT_FILE ?? join(root, "audit-data/audit.jsonl"),
		workspaceRoot: process.env.PERIMETER_WORKSPACES ?? join(root, "workspaces"),
		webRoot: join(root, "web"),
		piArgs: process.env.PERIMETER_PI_ARGS?.split(" ").filter(Boolean),
	});
	mkdirSync(join(root, "audit-data"), { recursive: true });
	const port = await gw.listen();
	console.log(`网关已启动 http://127.0.0.1:${port}/?token=${process.env.PERIMETER_TOKEN ?? "dev-token"}`);
}
