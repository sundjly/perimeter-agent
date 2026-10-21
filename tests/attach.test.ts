import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { Gateway } from "../src/gateway/server.ts";

/**
 * R76：attach CLI 回归 —— 连接建立前从 stdin 读到的命令不得丢弃（原缺陷：readline
 * 收到 /share 时 WS 尚未 OPEN 直接 return，coordinator 实测首次 /share 无效）。
 * 修复后输入排队，open 后按序发送。本例在 spawn 后立即写入 /share（此刻 WS 大概率
 * 尚未 open，正是缺陷场景；修复后两种时序等价），断言 share 生效：approver 随后
 * 可接入同会话且角色为 approver。
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const ATTACH = join(REPO, "scripts/attach.ts");
const TOKEN = "attach-test-token";

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups) await c();
});

test("R76：attach CLI —— open 前输入的 /share 排队生效（不再丢弃），approver 随后可接入", async () => {
	const dir = mkdtempSync(join(tmpdir(), "attach-"));
	const sid = "attach1";
	const gateway = new Gateway({
		mode: "demo", port: 0, host: "127.0.0.1", token: TOKEN,
		policyFile: join(REPO, "config/policy.yaml"), auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "workspaces"), stateRoot: join(dir, "state"), webRoot: join(REPO, "web"),
		// session.ready 需要可信模型配置（pi 完整启动）；本例不发 prompt，死地址即可
		model: { baseUrl: "http://127.0.0.1:1/v1", token: "bootstrap-only", model: "m" },
	});
	cleanups.push(() => gateway.close());
	const port = await gateway.listen();

	// attach.ts 以 owner 身份接入（子进程）；stdin 在 spawn 后立即写入 /share
	const child = spawn(
		process.execPath,
		[ATTACH, "--url", `http://127.0.0.1:${port}`, "--session", sid, "--actor", "demo@local", "--token", TOKEN],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	cleanups.push(() => void child.kill());
	let childOut = "";
	child.stdout?.on("data", (d) => { childOut += String(d); });
	child.stderr?.resume();
	child.stdin!.write("/share approver@local approver\n");

	// 等 attach 子进程真正建立会话（stdout 出现「会话 attach1 · owner」）再开始 approver
	// 探测——否则探测会先把会话建出来，approver 反成 owner、share 无从生效（R76-v8 竞态）
	{
		const deadline = Date.now() + 10_000;
		while (!childOut.includes("会话 attach1 · owner")) {
			if (Date.now() > deadline) throw new Error(`attach 未及时建立会话；stdout：${childOut.slice(0, 300)}`);
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	// share 生效的判据：approver 以独立身份接入同会话不被拒（原缺陷下无成员资格 → 4003），
	// 且收到的会话快照角色为 approver
	const deadline = Date.now() + 10_000;
	let attached = false;
	while (Date.now() < deadline && !attached) {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}&actor=approver@local&session=${sid}`);
		const result = await new Promise<{ ok: boolean; role?: string }>((resolve) => {
			const timer = setTimeout(() => resolve({ ok: false }), 2_000);
			ws.on("message", (raw) => {
				const m = JSON.parse(String(raw));
				if (m.event?.type === "session.snapshot") {
					clearTimeout(timer);
					resolve({ ok: true, role: m.event.view.role });
				}
			});
			ws.on("close", (code) => {
				clearTimeout(timer);
				resolve({ ok: code !== 4003 });
			});
		});
		ws.close();
		if (result.ok && result.role === "approver") {
			attached = true;
			break;
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	assert.ok(attached, "share 必须生效：approver 接入同会话且角色为 approver（10s 超时）");
});

test("R78：attach 握手 URL 不携带 token —— token 走 WS 握手 Authorization 头", async () => {
	// 本地 http server 的 upgrade 事件捕获 attach 发出的握手请求：query 不得含 token
	//（会随 URL 落日志）；token 改经 Authorization 头（#authenticateWS demo 分支接受，行为等价）。
	const server = createServer((_req, res) => { res.writeHead(404).end(); });
	let upgradeResolve: ((req: IncomingMessage) => void) | undefined;
	const seen = new Promise<IncomingMessage>((resolve) => { upgradeResolve = resolve; });
	server.on("upgrade", (req, socket) => {
		socket.on("error", () => {});
		upgradeResolve?.(req);
		socket.destroy(); // 捕获即断：attach 侧报错退出，本例只断言握手形态
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
	const port = (server.address() as { port: number }).port;
	const child = spawn(
		process.execPath,
		[ATTACH, "--url", `http://127.0.0.1:${port}`, "--session", "hdrcheck", "--actor", "demo@local", "--token", "hdr-only-token"],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	cleanups.push(() => void child.kill());
	const req = await Promise.race([
		seen,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("attach 未在 5s 内发起 WS 握手")), 5_000).unref()),
	]);
	const handshake = new URL(req.url ?? "/", "http://127.0.0.1");
	assert.equal(handshake.searchParams.get("token"), null, "握手 URL 不得携带 token（会随 URL 进访问日志）");
	assert.equal(handshake.searchParams.get("actor"), "demo@local", "actor 无头部通道，仍走 query（#authenticateWS demo 分支只读 query）");
	assert.equal(req.headers.authorization, "Bearer hdr-only-token", "token 经 WS 握手 Authorization 头（#authenticateWS demo 分支接受）");
});
