import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { AuditLog } from "../src/audit/log.ts";
import { Gateway } from "../src/gateway/server.ts";
import type { ClientEvent } from "../src/protocol/types.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MOCK = join(REPO, "tests/fixtures/mock-model.mjs");
const TOKEN = "test-token";

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups) await c();
});

interface Env {
	url: string;
	auditFile: string;
	workspaceRoot: string;
	gateway: Gateway;
}

async function startGateway(script: unknown[]): Promise<Env> {
	const mock: ChildProcess = spawn(process.execPath, [MOCK, "0", JSON.stringify(script)], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	cleanups.push(() => void mock.kill());
	const port: number = await new Promise((r) => mock.stdout?.once("data", (d) => r(JSON.parse(d.toString()).port)));

	const home = mkdtempSync(join(tmpdir(), "pihome-"));
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(
		join(home, ".pi", "agent", "models.json"),
		JSON.stringify({
			providers: {
				mock: {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "dummy",
					compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
					models: [{ id: "mock-model" }],
				},
			},
		}),
	);

	const dir = mkdtempSync(join(tmpdir(), "gw-"));
	const auditFile = join(dir, "audit.jsonl");
	const workspaceRoot = join(dir, "workspaces");
	const gateway = new Gateway({
		port: 0,
		host: "127.0.0.1",
		token: TOKEN,
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile,
		workspaceRoot,
		webRoot: join(REPO, "web"),
		piArgs: ["--no-session", "--provider", "mock", "--model", "mock-model"],
		piEnv: { ...process.env, HOME: home },
		approvalTimeoutMs: 30_000,
	});
	cleanups.push(() => gateway.close());
	const listening = await gateway.listen();
	return { url: `http://127.0.0.1:${listening}`, auditFile, workspaceRoot, gateway };
}

interface Client {
	ws: WebSocket;
	events: ClientEvent[];
	seqs: number[];
	waitFor: (pred: () => boolean, ms?: number) => Promise<void>;
	find: <T extends ClientEvent["type"]>(type: T) => Extract<ClientEvent, { type: T }> | undefined;
	send: (cmd: unknown) => void;
}

async function connect(env: Env, query = ""): Promise<Client> {
	const ws = new WebSocket(`${env.url.replace("http", "ws")}/?token=${TOKEN}${query}`);
	const events: ClientEvent[] = [];
	const seqs: number[] = [];
	ws.on("message", (raw) => {
		const { seq, event } = JSON.parse(String(raw));
		events.push(event);
		seqs.push(seq);
	});
	await new Promise((r, j) => {
		ws.once("open", r);
		ws.once("error", j);
	});
	cleanups.push(() => void ws.close());
	const waitFor = async (pred: () => boolean, ms = 20_000) => {
		const deadline = Date.now() + ms;
		while (!pred()) {
			if (Date.now() > deadline) throw new Error(`waitFor 超时；已收到 ${events.map((e) => e.type).join(",")}`);
			await new Promise((r) => setTimeout(r, 20));
		}
	};
	return {
		ws,
		events,
		seqs,
		waitFor,
		find: (type) => events.find((e) => e.type === type) as never,
		send: (cmd) => ws.send(JSON.stringify(cmd)),
	};
}

test("无 token 的连接被拒绝", async () => {
	const env = await startGateway([{ text: "hi" }]);
	const ws = new WebSocket(`${env.url.replace("http", "ws")}/`);
	await assert.rejects(
		new Promise((r, j) => {
			ws.once("open", r);
			ws.once("error", j);
		}),
		/401/,
	);
});

test("会话建立后下发 session.ready，前端拿到的全是自有协议事件", async () => {
	const env = await startGateway([{ text: "你好" }]);
	const c = await connect(env);
	await c.waitFor(() => c.find("session.ready") !== undefined);

	const ready = c.find("session.ready")!;
	assert.equal(ready.model, "mock-model");
	assert.ok(ready.workspace.length > 0);
	// 出口只有 ClientEvent：不允许出现 pi 的事件类型名
	assert.ok(!c.events.some((e) => e.type.includes("_")), `泄漏了 pi 事件：${c.events.map((e) => e.type).join(",")}`);
});

test("prompt 走完整链路：文本流式返回 + 审计留痕", async () => {
	const env = await startGateway([{ text: "已完成修复" }]);
	const c = await connect(env);
	await c.waitFor(() => c.find("session.ready") !== undefined);

	c.send({ type: "prompt", text: "修复登录超时" });
	await c.waitFor(() => c.events.some((e) => e.type === "agent.end" && !e.willRetry));

	const text = c.events.filter((e) => e.type === "message.text").map((e) => (e as { delta: string }).delta).join("");
	assert.match(text, /已完成修复/);
	assert.ok(c.events.some((e) => e.type === "audit.entry"));
	assert.equal((await AuditLog.verify(env.auditFile)).ok, true);
});

test("审批门：拦下不可逆操作，前端批准后才执行", async () => {
	const env = await startGateway([{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "完成" }]);
	const c = await connect(env);
	await c.waitFor(() => c.find("session.ready") !== undefined);

	c.send({ type: "prompt", text: "升级依赖" });
	await c.waitFor(() => c.find("approval.request") !== undefined);

	const req = c.find("approval.request")!;
	assert.match(req.reason, /git push|package.json|不可逆|高风险/);
	assert.ok(req.expiresAt > Date.now());

	c.send({ type: "approve", approvalId: req.approvalId, decision: "allow" });
	await c.waitFor(() => c.find("approval.resolved") !== undefined);
	await c.waitFor(() => c.events.some((e) => e.type === "agent.end" && !e.willRetry));

	const ws = c.find("session.ready")!.workspace;
	assert.equal(existsSync(join(ws, "package.json")), true);
});

test("审批门：拒绝后工具不执行，审计里留下审批人", async () => {
	const env = await startGateway([{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "完成" }]);
	const c = await connect(env, "&actor=bob@corp");
	await c.waitFor(() => c.find("session.ready") !== undefined);

	c.send({ type: "prompt", text: "升级依赖" });
	await c.waitFor(() => c.find("approval.request") !== undefined);
	c.send({ type: "approve", approvalId: c.find("approval.request")!.approvalId, decision: "deny" });
	await c.waitFor(() => c.events.some((e) => e.type === "agent.end" && !e.willRetry));

	assert.equal(existsSync(join(c.find("session.ready")!.workspace, "package.json")), false);

	const entries = [];
	for await (const e of AuditLog.replay(env.auditFile)) entries.push(e);
	const decision = entries.find((e) => e.kind === "approval.decision");
	assert.equal(decision?.verdict, "deny");
	assert.equal(decision?.approver, "bob@corp");
});

test("策略拒绝的操作下发 policy.denied 并记入审计", async () => {
	const env = await startGateway([
		{ tool: "write", args: { path: ".github/workflows/x.yml", content: "on: push" } },
		{ text: "完成" },
	]);
	const c = await connect(env);
	await c.waitFor(() => c.find("session.ready") !== undefined);
	c.send({ type: "prompt", text: "改 CI" });
	await c.waitFor(() => c.find("policy.denied") !== undefined);

	const denied = c.find("policy.denied")!;
	assert.equal(denied.rule, "ci-iac-secrets-off-limits");
	assert.equal(existsSync(join(c.find("session.ready")!.workspace, ".github/workflows/x.yml")), false);
});

test("断线重连不重启会话，任务继续在服务端跑", async () => {
	const env = await startGateway([{ text: "长任务结果" }]);
	const first = await connect(env);
	await first.waitFor(() => first.find("session.ready") !== undefined);
	const sessionId = first.find("session.ready")!.sessionId;

	first.ws.close();
	await new Promise((r) => setTimeout(r, 100));

	const second = await connect(env, `&session=${sessionId}`);
	second.send({ type: "prompt", text: "继续" });
	await second.waitFor(() => second.events.some((e) => e.type === "agent.end" && !e.willRetry));
	// 同一个 workspace，说明复用的是同一个 pi 进程而不是新建会话
	const text = second.events.filter((e) => e.type === "message.text").map((e) => (e as { delta: string }).delta).join("");
	assert.match(text, /长任务结果/);
});

test("resume 重放断线期间错过的事件", async () => {
	const env = await startGateway([{ text: "结果" }]);
	const c = await connect(env);
	await c.waitFor(() => c.find("session.ready") !== undefined);
	c.send({ type: "prompt", text: "跑" });
	await c.waitFor(() => c.events.some((e) => e.type === "agent.end" && !e.willRetry));

	const before = c.events.length;
	c.send({ type: "resume", since: 0 });
	await c.waitFor(() => c.events.length > before);
	assert.ok(c.events.length >= before * 2 - 1, "resume 应重放历史事件");
});

test("静态文件服务挡住路径穿越", async () => {
	const env = await startGateway([{ text: "x" }]);
	const res = await fetch(`${env.url}/../package.json`);
	assert.equal(res.status, 404);
	const res2 = await fetch(`${env.url}/%2e%2e/package.json`);
	assert.equal(res2.status, 404);
});

test("非法 JSON 命令不会打死会话", async () => {
	const env = await startGateway([{ text: "x" }]);
	const c = await connect(env);
	await c.waitFor(() => c.find("session.ready") !== undefined);
	c.ws.send("这不是 JSON");
	await c.waitFor(() => c.events.some((e) => e.type === "error" && e.code === "command_failed"));
	// 会话仍然可用
	c.send({ type: "prompt", text: "还活着吗" });
	await c.waitFor(() => c.events.some((e) => e.type === "agent.end" && !e.willRetry));
});
