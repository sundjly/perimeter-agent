import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { type ChildProcess, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { AuditLog } from "../src/audit/log.ts";
import { Approvals, ApprovalsDoc, type ApprovalContext } from "../src/runtime/approvals.ts";
import { gatewayModels } from "../src/runtime/models.ts";
import { DockerBackend } from "../src/gateway/execution-backend.ts";
import { Gateway } from "../src/gateway/server.ts";
import type { ClientEvent } from "../src/protocol/types.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MOCK = join(REPO, "tests/fixtures/mock-model.mjs");
const TOKEN = "test-token";
const s2Backend = new DockerBackend({ image: "perimeter-sandbox:test", repoRoot: REPO, network: "none" });

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

async function startGateway(script: unknown[], extra: Partial<ConstructorParameters<typeof Gateway>[0]> = {}): Promise<Env> {
	const mock: ChildProcess = spawn(process.execPath, [MOCK, "0", JSON.stringify(script)], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	cleanups.push(() => void mock.kill());
	const port: number = await new Promise((r) => mock.stdout?.once("data", (d) => r(JSON.parse(d.toString()).port)));

	const dir = mkdtempSync(join(tmpdir(), "gw-four-eyes-"));
	const auditFile = join(dir, "audit.jsonl");
	const workspaceRoot = join(dir, "workspaces");
	const isProd = extra.mode === "production";
	const gateway = new Gateway({
		port: 0,
		host: "127.0.0.1",
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile,
		workspaceRoot,
		webRoot: join(REPO, "web"),
		model: { baseUrl: `http://127.0.0.1:${port}/v1`, token: "dummy", model: "mock-model" },
		approvalTimeoutMs: 30_000,
		...(isProd ? {} : { token: TOKEN }),
		...extra,
		mode: extra.mode ?? "demo",
	});
	cleanups.push(() => gateway.close());
	const listening = await gateway.listen();
	return { url: `http://127.0.0.1:${listening}`, auditFile, workspaceRoot, gateway };
}

interface Client {
	ws: WebSocket;
	events: ClientEvent[];
	controls: Record<string, unknown>[];
	waitFor: (pred: () => boolean, ms?: number) => Promise<void>;
	find: <T extends ClientEvent["type"]>(type: T) => Extract<ClientEvent, { type: T }> | undefined;
	send: (cmd: unknown) => void;
}

async function connect(env: Env, query = ""): Promise<Client> {
	const ws = new WebSocket(`${env.url.replace("http", "ws")}/?token=${TOKEN}${query}`);
	const events: ClientEvent[] = [];
	const controls: Record<string, unknown>[] = [];
	ws.on("message", (raw) => {
		const msg = JSON.parse(String(raw));
		if (msg.type === "control") {
			controls.push(msg);
			return;
		}
		events.push(msg.event);
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
		controls,
		waitFor,
		find: (type) => events.find((e) => e?.type === type) as any,
		send: (cmd) => ws.send(JSON.stringify(cmd)),
	};
}

test("四眼审批正向流：owner 提交 prompt，通过 share 授权独立 approver，由 approver 批准后高风险工具正常执行", async () => {
	const env = await startGateway([{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "完成" }]);
	const owner = await connect(env, "&actor=alice");
	await owner.waitFor(() => !!owner.find("session.ready"));
	const sessionId = owner.find("session.ready")!.sessionId;

	owner.send({ type: "share", actor: "bob", role: "approver" });
	const approver = await connect(env, `&actor=bob&session=${sessionId}`);
	await approver.waitFor(() => !!approver.find("session.snapshot"));

	owner.send({ type: "prompt", text: "升级 package.json", requestId: "r1" });
	await approver.waitFor(() => !!approver.find("approval.request"));
	const req = approver.find("approval.request")!;

	approver.send({ type: "approve", approvalId: req.approvalId, decision: "allow" });
	await approver.waitFor(() => !!approver.find("approval.resolved"));
	await owner.waitFor(() => owner.events.some((e) => e.type === "agent.end" && !e.willRetry));

	const wsPath = owner.find("session.ready")!.workspace;
	assert.equal(existsSync(join(wsPath, "package.json")), true);

	const entries = [];
	for await (const e of AuditLog.replay(env.auditFile)) entries.push(e);
	const decision = entries.find((e) => e.kind === "approval.decision");
	assert.equal(decision?.verdict, "allow");
	assert.equal(decision?.actor, "alice");
	assert.equal(decision?.approver, "bob");
});

test("防自批铁律：requester 严禁自批（owner 发送 approve 立即被拒，工具不执行）", async () => {
	const env = await startGateway([{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "完成" }]);
	const owner = await connect(env, "&actor=alice");
	await owner.waitFor(() => !!owner.find("session.ready"));

	owner.send({ type: "prompt", text: "写配置", requestId: "r-self" });
	await owner.waitFor(() => !!owner.find("approval.request"));
	const req = owner.find("approval.request")!;

	// owner 角色尝试 approve 直接被拒
	owner.send({ type: "approve", approvalId: req.approvalId, decision: "allow" });
	await owner.waitFor(() => owner.events.some((e) => e.type === "error" && e.message.includes("无权审批")));

	const wsPath = owner.find("session.ready")!.workspace;
	assert.equal(existsSync(join(wsPath, "package.json")), false);
});

interface ProdIdentity { id: string; issuer: string; subject: string; expiresAt: number; groups: string[] }

const prodAuthenticate = async (cred: string): Promise<ProdIdentity> => ({
	// production 下连接 actor = principal.id；token-1/token-2 同 subject（同一自然人）
	id: cred === "token-1" ? "corp|alice-laptop" : cred === "token-b" ? "corp|bob" : "corp|alice-mobile",
	issuer: "corp",
	subject: cred === "token-b" ? "bob-uuid" : "alice-uuid",
	expiresAt: Date.now() + 3600_000,
	groups: ["dev"],
});

async function startProdGateway(script: unknown[]): Promise<{ port: number; env: Env }> {
	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const port = (s.address() as { port: number }).port;
	await new Promise<void>((r) => s.close(() => r()));
	const env = await startGateway(script, {
		mode: "production",
		backend: s2Backend,
		port,
		auth: { isPrincipalId: () => true, authenticate: prodAuthenticate },
		allowedHosts: [`127.0.0.1:${port}`],
		allowedOrigins: ["https://internal.corp"],
		resolveScope: () => ({ repo: "r", team: "t" }),
	});
	return { port, env };
}

async function connectProd(port: number, token: string, session?: string): Promise<{ ws: WebSocket; events: any[] }> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/${session ? `?session=${session}` : ""}`, {
		headers: { Authorization: `Bearer ${token}`, Host: `127.0.0.1:${port}`, Origin: "https://internal.corp" },
	});
	const events: any[] = [];
	ws.on("message", (raw) => {
		const frame = JSON.parse(String(raw));
		if (frame.event) events.push(frame.event);
	});
	await new Promise<void>((r, j) => {
		const timer = setTimeout(() => j(new Error("生产连接超时")), 15_000);
		ws.once("open", () => { clearTimeout(timer); r(); });
		ws.once("error", (e) => { clearTimeout(timer); j(e); });
	});
	return { ws, events };
}

async function waitForRaw(pred: () => boolean, events: unknown[], ms = 20_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error(`等待超时；已收到 ${events.map((e: any) => e?.type).join(",")}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

async function decisionEntries(auditFile: string): Promise<any[]> {
	const entries: any[] = [];
	for await (const e of AuditLog.replay(auditFile)) entries.push(e);
	return entries.filter((e) => e.kind === "approval.decision");
}

function initGitFixture(wsPath: string): void {
	execSync("git init -q", { cwd: wsPath });
	execSync("git config user.name 'Test' && git config user.email 'test@test.local'", { cwd: wsPath });
	writeFileSync(join(wsPath, "seed.txt"), "seed");
	execSync("git add . && git commit -q -m 'init'", { cwd: wsPath });
}

test("生产 fail-closed：production + DockerBackend + 无 git 工作区，高风险请求直接拒绝且不创建可批准 pending", async () => {
	const { port, env } = await startProdGateway([{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "完成" }]);
	const alice = await connectProd(port, "token-1");
	await waitForRaw(() => alice.events.some((e) => e.type === "session.ready"), alice.events);
	const wsPath = alice.events.find((e) => e.type === "session.ready")!.workspace;

	// 先 share（避免 share 的 expirePending 干扰断言），再发起高风险请求
	alice.ws.send(JSON.stringify({ type: "share", actor: "corp|alice-mobile", role: "approver" }));
	await new Promise((r) => setTimeout(r, 100));
	alice.ws.send(JSON.stringify({ type: "prompt", text: "无 git 高风险", requestId: "r-nogit" }));
	// fail-closed：工具被阻断，mock 模型继续走到「完成」→ agent.end；全程必须有界
	await waitForRaw(() => alice.events.some((e) => e.type === "agent.end" && !e.willRetry), alice.events);

	// 不得发出可批准的 approval.request（发的是脱敏 policy.denied 说明）
	assert.ok(!alice.events.some((e) => e.type === "approval.request"), "上下文不可靠时禁止发出可批准 request");
	const denied = alice.events.find((e) => e.type === "policy.denied");
	assert.ok(denied && String(denied.reason).includes("上下文不可靠"), "必须发送脱敏 denied 说明");
	assert.ok(!("args" in (denied.action as any)), "denied 事件不携带参数原文");
	// marker 无副作用；审计无 allow 决策
	assert.equal(existsSync(join(wsPath, "package.json")), false);
	assert.equal((await decisionEntries(env.auditFile)).some((e) => e.verdict === "allow"), false);
	alice.ws.close();
});

test("生产正控：同设置临时 git 真实 HEAD，真实 B（另一 subject）批准后容器执行落盘", async () => {
	const { port, env } = await startProdGateway([{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "完成" }]);
	const alice = await connectProd(port, "token-1");
	await waitForRaw(() => alice.events.some((e) => e.type === "session.ready"), alice.events);
	const wsPath = alice.events.find((e) => e.type === "session.ready")!.workspace;
	initGitFixture(wsPath);

	alice.ws.send(JSON.stringify({ type: "share", actor: "corp|bob", role: "approver" }));
	await new Promise((r) => setTimeout(r, 100));
	const bob = await connectProd(port, "token-b", alice.events.find((e) => e.type === "session.ready")!.sessionId);
	await waitForRaw(() => bob.events.some((e) => e.type === "session.snapshot"), bob.events);

	alice.ws.send(JSON.stringify({ type: "prompt", text: "git 正控高风险", requestId: "r-git-pos" }));
	await waitForRaw(() => bob.events.some((e) => e.type === "approval.request"), bob.events);
	const req = bob.events.find((e) => e.type === "approval.request")!;
	bob.ws.send(JSON.stringify({ type: "approve", approvalId: req.approvalId, decision: "allow" }));
	await waitForRaw(() => alice.events.some((e) => e.type === "agent.end" && !e.willRetry), alice.events);

	// 真实 B 批准后容器内落盘（bind mount 回宿主机工作区）
	assert.equal(existsSync(join(wsPath, "package.json")), true);
	const decisions = await decisionEntries(env.auditFile);
	assert.ok(decisions.some((e) => e.verdict === "allow" && e.actor === "corp|alice-laptop" && e.approver === "corp|bob"), "审计必须记录真实 allow 决策");
	alice.ws.close();
	bob.ws.close();
});

test("防自批铁律：同一主体换不同凭证（同 subject）自批被拒绝（production + 临时 git）", async () => {
	const { port, env } = await startProdGateway([{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "完成" }]);
	const alice1 = await connectProd(port, "token-1");
	await waitForRaw(() => alice1.events.some((e) => e.type === "session.ready"), alice1.events);
	const wsPath = alice1.events.find((e) => e.type === "session.ready")!.workspace;
	initGitFixture(wsPath);

	// Alice 把自己的另一凭证身份 share 为 approver
	alice1.ws.send(JSON.stringify({ type: "share", actor: "corp|alice-mobile", role: "approver" }));
	await new Promise((r) => setTimeout(r, 100));
	const alice2 = await connectProd(port, "token-2", alice1.events.find((e) => e.type === "session.ready")!.sessionId);
	await waitForRaw(() => alice2.events.some((e) => e.type === "session.snapshot"), alice2.events);

	alice1.ws.send(JSON.stringify({ type: "prompt", text: "换凭证自批", requestId: "r-same-principal" }));
	await waitForRaw(() => alice2.events.some((e) => e.type === "approval.request"), alice2.events);
	const req = alice2.events.find((e) => e.type === "approval.request")!;
	alice2.ws.send(JSON.stringify({ type: "approve", approvalId: req.approvalId, decision: "allow" }));
	// 自批违规由 decide 前置断言即时抛出；pending 保留至超时（与既有能力一致），不等待 agent.end
	await waitForRaw(() => alice2.events.some((e) => e.type === "error" && String(e.message).includes("自批违规")), alice2.events);
	await new Promise((r) => setTimeout(r, 300));

	assert.ok(alice2.events.some((e) => e.type === "error" && String(e.message).includes("自批违规")), "同一主体换凭据自批必须报自批违规错误");
	assert.equal(existsSync(join(wsPath, "package.json")), false);
	assert.equal((await decisionEntries(env.auditFile)).some((e) => e.verdict === "allow"), false);
	alice1.ws.close();
	alice2.ws.close();
});

test("生产失效：request 后工作区 git 上下文丢失，decide 拒绝且容器不落盘", async () => {
	const { port, env } = await startProdGateway([{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "完成" }]);
	const alice = await connectProd(port, "token-1");
	await waitForRaw(() => alice.events.some((e) => e.type === "session.ready"), alice.events);
	const wsPath = alice.events.find((e) => e.type === "session.ready")!.workspace;
	initGitFixture(wsPath);

	alice.ws.send(JSON.stringify({ type: "share", actor: "corp|bob", role: "approver" }));
	await new Promise((r) => setTimeout(r, 100));
	const bob = await connectProd(port, "token-b", alice.events.find((e) => e.type === "session.ready")!.sessionId);
	await waitForRaw(() => bob.events.some((e) => e.type === "session.snapshot"), bob.events);

	alice.ws.send(JSON.stringify({ type: "prompt", text: "context 丢失", requestId: "r-ctx-loss" }));
	await waitForRaw(() => bob.events.some((e) => e.type === "approval.request"), bob.events);
	const req = bob.events.find((e) => e.type === "approval.request")!;

	// request 之后工作区失去可靠 git 上下文
	rmSync(join(wsPath, ".git"), { recursive: true, force: true });
	bob.ws.send(JSON.stringify({ type: "approve", approvalId: req.approvalId, decision: "allow" }));
	await waitForRaw(() => alice.events.some((e) => e.type === "agent.end" && !e.willRetry), alice.events);

	assert.ok(alice.events.some((e) => e.type === "error" && (String(e.message).includes("审批意图上下文已失效") || String(e.message).includes("不可靠"))), "decide 必须因上下文丢失拒绝");
	assert.equal(existsSync(join(wsPath, "package.json")), false);
	assert.equal((await decisionEntries(env.auditFile)).some((e) => e.verdict === "allow"), false);
	alice.ws.close();
	bob.ws.close();
});

test("角色能力矩阵：owner 只能 share 别人，严禁将本人角色更改为 approver 规避自批", async () => {
	const env = await startGateway([{ text: "ok" }]);
	const owner = await connect(env, "&actor=alice");
	await owner.waitFor(() => !!owner.find("session.ready"));

	owner.send({ type: "share", actor: "alice", role: "approver" });
	await owner.waitFor(() => owner.events.some((e) => e.type === "error" && e.message.includes("非法共享命令或无权共享")));
});

test("角色能力矩阵：approver 角色禁止发起 prompt、steer 或 share，只读 + 审批", async () => {
	const env = await startGateway([{ text: "ok" }]);
	const owner = await connect(env, "&actor=alice");
	await owner.waitFor(() => !!owner.find("session.ready"));
	const sessionId = owner.find("session.ready")!.sessionId;

	owner.send({ type: "share", actor: "bob", role: "approver" });
	const approver = await connect(env, `&actor=bob&session=${sessionId}`);
	await approver.waitFor(() => !!approver.find("session.snapshot"));
	assert.equal(approver.find("session.snapshot")!.view.role, "approver");

	approver.send({ type: "prompt", text: "approver 违规执行", requestId: "p1" });
	await approver.waitFor(() => approver.events.some((e) => e.type === "error" && e.message.includes("无权执行命令")));

	approver.send({ type: "share", actor: "charlie", role: "editor" });
	await approver.waitFor(() => approver.events.filter((e) => e.type === "error").length >= 2);
});

test("意图与上下文绑定：客户端事件与审计不泄露敏感参数原文，仅包含规范化 argsHash", async () => {
	const secretPayload = JSON.stringify({ name: "app", secret: "super-secret-api-key-1234567890" });
	const env = await startGateway([{ tool: "write", args: { path: "package.json", content: secretPayload } }, { text: "done" }]);
	const owner = await connect(env, "&actor=alice");
	await owner.waitFor(() => !!owner.find("session.ready"));
	const sessionId = owner.find("session.ready")!.sessionId;

	owner.send({ type: "share", actor: "bob", role: "approver" });
	const approver = await connect(env, `&actor=bob&session=${sessionId}`);
	await approver.waitFor(() => !!approver.find("session.snapshot"));

	owner.send({ type: "prompt", text: "写敏感文件", requestId: "sec-1" });
	await approver.waitFor(() => !!approver.find("approval.request"));

	const req = approver.find("approval.request")!;
	// 客户端事件中只有 argsHash，绝无 secretPayload 原文
	assert.ok(req.argsHash && typeof req.argsHash === "string" && req.argsHash.length === 64);
	assert.equal((req.action as any).args, undefined);
	assert.ok(!JSON.stringify(req).includes(secretPayload));

	approver.send({ type: "approve", approvalId: req.approvalId, decision: "deny" });
	await owner.waitFor(() => owner.events.some((e) => e.type === "agent.end"));

	// 检查审计日志
	for await (const entry of AuditLog.replay(env.auditFile)) {
		if (entry.kind === "approval.request" || entry.kind === "approval.decision") {
			assert.ok(!JSON.stringify(entry).includes(secretPayload));
		}
	}
});

test("意图与上下文绑定：成员变更（ACL 变动）使在途审批立即失效", async () => {
	const env = await startGateway([{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "done" }]);
	const owner = await connect(env, "&actor=alice");
	await owner.waitFor(() => !!owner.find("session.ready"));
	const sessionId = owner.find("session.ready")!.sessionId;

	owner.send({ type: "share", actor: "bob", role: "approver" });
	const approver = await connect(env, `&actor=bob&session=${sessionId}`);
	await approver.waitFor(() => !!approver.find("session.snapshot"));

	owner.send({ type: "prompt", text: "写文件", requestId: "acl-1" });
	await approver.waitFor(() => !!approver.find("approval.request"));
	const req = approver.find("approval.request")!;

	// 在审批决断前，owner 更改了成员配置（新增 viewer charlie），触发 ACL 版本递增与在途废止
	owner.send({ type: "share", actor: "charlie", role: "viewer" });
	await new Promise((r) => setTimeout(r, 60));

	// Bob 随后尝试 allow 该审批
	approver.send({ type: "approve", approvalId: req.approvalId, decision: "allow" });
	await new Promise((r) => setTimeout(r, 100));

	// 确认工具未被执行
	const wsPath = owner.find("session.ready")!.workspace;
	assert.equal(existsSync(join(wsPath, "package.json")), false);
});

test("意图与上下文绑定：工作区 HEAD 发生变更使审批二次核验失败并阻断执行", async () => {
	const env = await startGateway([{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "done" }]);
	const owner = await connect(env, "&actor=alice");
	await owner.waitFor(() => !!owner.find("session.ready"));
	const sessionId = owner.find("session.ready")!.sessionId;
	const wsPath = owner.find("session.ready")!.workspace;

	// 初始化 git 仓库并提交初始 commit
	execSync("git init -q", { cwd: wsPath });
	execSync("git config user.name 'Test' && git config user.email 'test@test.local'", { cwd: wsPath });
	writeFileSync(join(wsPath, "init.txt"), "v1");
	execSync("git add . && git commit -q -m 'init commit'", { cwd: wsPath });

	owner.send({ type: "share", actor: "bob", role: "approver" });
	const approver = await connect(env, `&actor=bob&session=${sessionId}`);
	await approver.waitFor(() => !!approver.find("session.snapshot"));

	owner.send({ type: "prompt", text: "写文件", requestId: "head-1" });
	await approver.waitFor(() => !!approver.find("approval.request"));
	const req = approver.find("approval.request")!;

	// 在审批决断前，工作区有人提交了新的 commit，导致 HEAD 改变
	writeFileSync(join(wsPath, "drift.txt"), "drift");
	execSync("git add . && git commit -q -m 'drift commit'", { cwd: wsPath });

	// Approver 尝试 allow
	approver.send({ type: "approve", approvalId: req.approvalId, decision: "allow" });
	await approver.waitFor(() => approver.events.some((e) => e.type === "error" && e.message.includes("代码版本漂移")));

	// 确认 package.json 未被写入
	assert.equal(existsSync(join(wsPath, "package.json")), false);
});

test("意图绑定与审计故障闭环（真实 Durable 存储）：args 变更拒、审计失败不留可用 allow、真实 reopen 后 retry 仍拒、跨 session 不复用", async () => {
	const dir = mkdtempSync(join(tmpdir(), "four-eyes-unit-"));
	const file = join(dir, "session.sqlite");
	const registry = createRegistry();
	registry.install(CodingTools);
	const models = gatewayModels({ baseUrl: "http://127.0.0.1:9/v1", token: "x", model: "m" });
	let auditFault = false;

	const openApprovals = async (dbFile: string = file) => {
		const storage = await openNodeSqliteStorage(dbFile);
		const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
		const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "perimeter", modelId: "m" }, cwd: dir } });
		const approvals = new Approvals(root, () => {}, () => {
			if (auditFault) throw new Error("注入的审计故障");
		});
		const items = async () => ((await harness.snapshot(ApprovalsDoc, root.id, BACKGROUND_CONTEXT))?.items ?? []);
		return { storage, harness, approvals, items };
	};
	const prodCtx = (): ApprovalContext => ({
		sessionIdentity: "sess-1", tenantIdentity: "team-1", repoIdentity: "repo-1",
		gitRevision: "a".repeat(40), policyHash: "b".repeat(64), aclVersion: 1, reliable: true, isProduction: true,
	});
	const writeAction = (content: string) => ({ tool: "write", path: "a.txt", args: { path: "a.txt", content } });
	const approveOpts = { approverPrincipal: "bob-p", isProduction: true };

	try {
		let ctx = await openApprovals();
		// 1) 成功对照：B allow（审计正常）→ 恰好一次可执行 allow
		const p1 = ctx.approvals.request("call-1", writeAction("v1"), "rule", "reason", "alice", 60_000, new AbortController().signal, prodCtx(), "alice-p", true);
		await new Promise((r) => setTimeout(r, 50));
		const item1 = (await ctx.items()).find((i) => i.callId === "call-1");
		assert.ok(item1?.status === "pending");
		assert.equal((await ctx.approvals.decide(item1.id, "allow", "bob", approveOpts))?.status, "allow");
		assert.equal(await p1, true);
		// 2) 同 tool/path 不同 content：verifyApproved 拒；同 args 幂等通过
		assert.equal((await ctx.approvals.verifyApproved("call-1", writeAction("v2"), prodCtx(), true)).ok, false);
		assert.equal((await ctx.approvals.verifyApproved("call-1", writeAction("v1"), prodCtx(), true)).ok, true);

		// 3) 审计故障注入：allow 决策时审计失败 → 抛错、存储 invalidated、request 结算 false
		auditFault = true;
		const p2 = ctx.approvals.request("call-2", writeAction("w1"), "rule", "reason", "alice", 60_000, new AbortController().signal, prodCtx(), "alice-p", true);
		await new Promise((r) => setTimeout(r, 50));
		const item2 = (await ctx.items()).find((i) => i.callId === "call-2");
		assert.ok(item2?.status === "pending");
		await assert.rejects(ctx.approvals.decide(item2.id, "allow", "bob", approveOpts), /审计/);
		assert.equal(await p2, false, "审计失败时 waiter 必须收 false");
		assert.equal((await ctx.items()).find((i) => i.callId === "call-2")?.status, "invalidated");
		assert.equal((await ctx.approvals.verifyApproved("call-2", writeAction("w1"), prodCtx(), true)).ok, false);
		auditFault = false;

		// 4) 真实 reopen（关闭后重开同一 sqlite）：invalidate 持久、retry 仍拒、合法 allow 仍在
		await ctx.harness.close(BACKGROUND_CONTEXT);
		try { await ctx.storage.close(BACKGROUND_CONTEXT); } catch {}
		ctx = await openApprovals();
		await ctx.approvals.expirePending(); // 与 HarnessHost.open 一致
		assert.equal((await ctx.approvals.verifyApproved("call-2", writeAction("w1"), prodCtx(), true)).ok, false);
		assert.equal(await ctx.approvals.decide(item2.id, "allow", "bob", approveOpts), undefined, "非 pending retry 不产生可用 allow");
		assert.equal((await ctx.approvals.verifyApproved("call-1", writeAction("v1"), prodCtx(), true)).ok, true);

		// 5) 旧 call 跨 session 不复用：独立 sqlite 查不到他_session 审批
		const other = await openApprovals(join(dir, "other.sqlite"));
		assert.equal((await other.approvals.verifyApproved("call-1", writeAction("v1"), prodCtx(), true)).reason, "未找到审批记录");
		await other.harness.close(BACKGROUND_CONTEXT);
		try { await other.storage.close(BACKGROUND_CONTEXT); } catch {}

		await ctx.harness.close(BACKGROUND_CONTEXT);
		try { await ctx.storage.close(BACKGROUND_CONTEXT); } catch {}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
