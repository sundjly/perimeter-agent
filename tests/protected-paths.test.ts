/**
 * 保护路径 Slice A（canonical 路径守卫）专项测试。
 *
 * 真实链路（production Gateway/Harness/DockerBackend(none) + localhost mock + 仓库真实 policy）：
 * - 正控：普通相对写（多级新目录）、workspace 绝对路径写、require_approval 规范路径审批后正常落盘
 * - 反控：symlink 命中保护子树（deny 且目标未变）、symlink 外逃、假前缀绝对路径、NUL、循环 symlink（fail-closed）、
 *   获批后等待期目标漂移（canonical 不一致 → 拒且目标未变）
 * - fail-closed 单元：canonical 解析抛错（RPC/环境失败）→ deny 而非放行
 *
 * bash/硬链接/检查-使用全竞态不在本切片（见 s2-four-eyes-standalone/plan 文档的残余声明）。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { AuditLog } from "../src/audit/log.ts";
import { PolicyEngine } from "../src/policy/engine.ts";
import { perimeterExtension } from "../src/runtime/perimeter-extension.ts";
import { DockerBackend } from "../src/gateway/execution-backend.ts";
import { Gateway } from "../src/gateway/server.ts";
import type { ClientEvent } from "../src/protocol/types.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MOCK = join(REPO, "tests/fixtures/mock-model.mjs");
const POLICY = join(REPO, "config/policy.yaml");
const IMAGE = "perimeter-sandbox:test";
const s2Backend = new DockerBackend({ image: IMAGE, repoRoot: REPO, network: "none" });
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups) await c();
});

interface Env { port: number; auditFile: string; gateway: Gateway }

const prodAuthenticate = async (cred: string): Promise<{ id: string; issuer: string; subject: string; expiresAt: number; groups: string[] }> => ({
	id: cred === "token-1" ? "corp|alice-pp" : "corp|bob-pp",
	issuer: "corp",
	subject: cred === "token-1" ? "alice-pp-uuid" : "bob-pp-uuid",
	expiresAt: Date.now() + 3600_000,
	groups: ["dev"],
});

async function startProdGateway(script: unknown[]): Promise<{ port: number; env: Env }> {
	const mock: ChildProcess = spawn(process.execPath, [MOCK, "0", JSON.stringify(script)], { stdio: ["ignore", "pipe", "inherit"] });
	cleanups.push(() => void mock.kill());
	const mockPort: number = await new Promise((r, j) => {
		const t = setTimeout(() => j(new Error("mock port 超时")), 15_000);
		mock.stdout?.once("data", (d) => { clearTimeout(t); r(JSON.parse(d.toString()).port); });
	});
	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const port = (s.address() as { port: number }).port;
	await new Promise<void>((r) => s.close(() => r()));
	const dir = mkdtempSync(join(tmpdir(), "pp-four-eyes-"));
	const env = new Gateway({
		port, host: "127.0.0.1",
		policyFile: POLICY, auditFile: join(dir, "audit.jsonl"), workspaceRoot: join(dir, "workspaces"), webRoot: join(REPO, "web"),
		model: { baseUrl: `http://127.0.0.1:${mockPort}/v1`, token: "dummy", model: "mock-model" },
		approvalTimeoutMs: 30_000,
		mode: "production", backend: s2Backend,
		auth: { isPrincipalId: () => true, authenticate: prodAuthenticate },
		allowedHosts: [`127.0.0.1:${port}`], allowedOrigins: ["https://internal.corp"],
		resolveScope: () => ({ repo: "pp-repo", team: "pp-team" }),
	});
	const listening = await env.listen();
	cleanups.push(() => env.close());
	return { port: listening, env: { port: listening, auditFile: join(dir, "audit.jsonl"), gateway: env } };
}

interface Client { ws: WebSocket; send: (cmd: unknown) => void; events: ClientEvent[] }

async function connectProd(port: number, token: string, session?: string): Promise<Client> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/${session ? `?session=${session}` : ""}`, {
		headers: { Authorization: `Bearer ${token}`, Host: `127.0.0.1:${port}`, Origin: "https://internal.corp" },
	});
	const client: Client = { ws, send: (c: unknown) => ws.send(JSON.stringify(c)), events: [] };
	ws.on("message", (raw) => {
		const frame = JSON.parse(String(raw));
		if (frame.event) client.events.push(frame.event);
	});
	await new Promise<void>((r, j) => {
		const t = setTimeout(() => j(new Error("连接超时")), 15_000);
		ws.once("open", () => { clearTimeout(t); r(); });
		ws.once("error", (e) => { clearTimeout(t); j(e); });
	});
	return client;
}

async function waitFor(client: Client, pred: (e: ClientEvent[]) => boolean, ms = 20_000, label = ""): Promise<void> {
	const deadline = Date.now() + ms;
	while (!pred(client.events)) {
		if (Date.now() > deadline) throw new Error(`${label} 等待超时；已收到 ${client.events.map((e) => e.type).join(",")}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

function initGitFixture(wsPath: string): void {
	writeFileSync(join(wsPath, "seed.txt"), "seed\n");
	execFileSync("/bin/sh", ["-c", "git init -q && git config user.name 'P' && git config user.email 'p@local' && git add -A && git commit -q -m seed"], { cwd: wsPath });
}

async function auditDecisions(auditFile: string): Promise<{ kind: string; verdict?: string }[]> {
	const entries: { kind: string; verdict?: string }[] = [];
	for await (const e of AuditLog.replay(auditFile)) entries.push({ kind: e.kind, verdict: (e as { verdict?: string }).verdict });
	return entries;
}

test("正控：普通相对写（多级新目录）与 workspace 绝对路径写不被误拒", async () => {
	const { port } = await startProdGateway([
		{ tool: "write", args: { path: "src/deep/new/dir/file.txt", content: "ok1" } },
		{ tool: "write", args: { path: "/workspace/abs.txt", content: "ok2" } },
		{ text: "完成" },
	]);
	const owner = await connectProd(port, "token-1");
	await waitFor(owner, (es) => es.some((e) => e.type === "session.ready"));
	const wsPath = (owner.events.find((e) => e.type === "session.ready") as Extract<ClientEvent, { type: "session.ready" }>).workspace;
	owner.send({ type: "prompt", text: "正控写入", requestId: "pos" });
	await waitFor(owner, (es) => es.some((e) => e.type === "agent.end" && !(e as { willRetry?: boolean }).willRetry));
	assert.equal(readFileSync(join(wsPath, "src/deep/new/dir/file.txt"), "utf8"), "ok1");
	assert.equal(readFileSync(join(wsPath, "abs.txt"), "utf8"), "ok2");
	assert.ok(!owner.events.some((e) => e.type === "policy.denied"), "正控不得出现 denied");
	owner.ws.close();
});

test("反控：symlink 命中保护子树被拒且目标文件未变", async () => {
	const { port } = await startProdGateway([{ tool: "write", args: { path: "wf/evil.yml", content: "evil" } }, { text: "完成" }]);
	const owner = await connectProd(port, "token-1");
	await waitFor(owner, (es) => es.some((e) => e.type === "session.ready"));
	const wsPath = (owner.events.find((e) => e.type === "session.ready") as Extract<ClientEvent, { type: "session.ready" }>).workspace;
	mkdirSync(join(wsPath, ".github/workflows"), { recursive: true });
	writeFileSync(join(wsPath, ".github/workflows/ci.yml"), "ORIGINAL-CI");
	symlinkSync(".github/workflows", join(wsPath, "wf"));
	owner.send({ type: "prompt", text: "symlink 保护子树", requestId: "s1" });
	await waitFor(owner, (es) => es.some((e) => e.type === "agent.end" && !(e as { willRetry?: boolean }).willRetry));
	const denied = owner.events.find((e) => e.type === "policy.denied") as Extract<ClientEvent, { type: "policy.denied" }> | undefined;
	assert.ok(denied, "必须 deny");
	assert.equal(denied.rule, "ci-iac-secrets-off-limits", "deny 必须来自保护子树规则");
	assert.equal(readFileSync(join(wsPath, ".github/workflows/ci.yml"), "utf8"), "ORIGINAL-CI", "目标文件不得被改");
	owner.ws.close();
});

test("反控：symlink 外逃（/etc/passwd）被拒", async () => {
	const { port } = await startProdGateway([{ tool: "write", args: { path: "out", content: "x" } }, { text: "完成" }]);
	const owner = await connectProd(port, "token-1");
	await waitFor(owner, (es) => es.some((e) => e.type === "session.ready"));
	const wsPath = (owner.events.find((e) => e.type === "session.ready") as Extract<ClientEvent, { type: "session.ready" }>).workspace;
	symlinkSync("/etc/passwd", join(wsPath, "out"));
	owner.send({ type: "prompt", text: "symlink 外逃", requestId: "s2" });
	await waitFor(owner, (es) => es.some((e) => e.type === "agent.end" && !(e as { willRetry?: boolean }).willRetry));
	const denied = owner.events.find((e) => e.type === "policy.denied") as Extract<ClientEvent, { type: "policy.denied" }> | undefined;
	assert.ok(denied && denied.reason.includes("越界"), "必须按越界拒绝");
	owner.ws.close();
});

test("反控：假前缀绝对路径与 NUL 输入被拒", async () => {
	const { port } = await startProdGateway([
		{ tool: "write", args: { path: "/workspace-evil/x.txt", content: "x" } },
		{ tool: "write", args: { path: "a\u0000b.txt", content: "x" } },
		{ text: "完成" },
	]);
	const owner = await connectProd(port, "token-1");
	await waitFor(owner, (es) => es.some((e) => e.type === "session.ready"));
	const wsPath = (owner.events.find((e) => e.type === "session.ready") as Extract<ClientEvent, { type: "session.ready" }>).workspace;
	owner.send({ type: "prompt", text: "假前缀与NUL", requestId: "s3" });
	await waitFor(owner, (es) => es.some((e) => e.type === "agent.end" && !(e as { willRetry?: boolean }).willRetry));
	const denied = owner.events.filter((e) => e.type === "policy.denied");
	assert.ok(denied.length >= 2, "两个反控都必须 deny");
	assert.equal(existsSync(join(wsPath, "x.txt")), false);
	owner.ws.close();
});

test("反控：循环 symlink fail-closed 拒绝", async () => {
	const { port } = await startProdGateway([{ tool: "write", args: { path: "loop/x", content: "x" } }, { text: "完成" }]);
	const owner = await connectProd(port, "token-1");
	await waitFor(owner, (es) => es.some((e) => e.type === "session.ready"));
	const wsPath = (owner.events.find((e) => e.type === "session.ready") as Extract<ClientEvent, { type: "session.ready" }>).workspace;
	symlinkSync("loop", join(wsPath, "loop"));
	owner.send({ type: "prompt", text: "循环symlink", requestId: "s4" });
	await waitFor(owner, (es) => es.some((e) => e.type === "agent.end" && !(e as { willRetry?: boolean }).willRetry));
	const denied = owner.events.find((e) => e.type === "policy.denied") as Extract<ClientEvent, { type: "policy.denied" }> | undefined;
	assert.ok(denied && denied.reason.includes("fail-closed"), "ELOOP 必须 fail-closed 拒绝");
	owner.ws.close();
});

test("require_approval：canonical 升格不丢审批门；获批后等待期目标漂移被拒且目标未变", async () => {
	const { port, env } = await startProdGateway([
		{ tool: "write", args: { path: "alias.json", content: "NEW" } },
		{ text: "完成" },
	]);
	const owner = await connectProd(port, "token-1");
	await waitFor(owner, (es) => es.some((e) => e.type === "session.ready"));
	const wsPath = (owner.events.find((e) => e.type === "session.ready") as Extract<ClientEvent, { type: "session.ready" }>).workspace;
	writeFileSync(join(wsPath, "package.json"), "{}");
	writeFileSync(join(wsPath, "package.json.bak"), "bak");
	initGitFixture(wsPath);
	symlinkSync("package.json", join(wsPath, "alias.json"));
	owner.send({ type: "share", actor: "corp|bob-pp", role: "approver" });
	await new Promise((r) => setTimeout(r, 150));
	const bob = await connectProd(port, "token-b", (owner.events.find((e) => e.type === "session.ready") as Extract<ClientEvent, { type: "session.ready" }>).sessionId);
	await waitFor(bob, (es) => es.some((e) => e.type === "session.snapshot"));

	// alias.json → package.json：词法 allow，canonical 命中 require_approval_paths → 必须走审批
	owner.send({ type: "prompt", text: "canonical 升格审批", requestId: "d1" });
	await waitFor(bob, (es) => es.some((e) => e.type === "approval.request"), 20_000, "drift:approval.request");
	// 等待期漂移：改指向备份文件
	rmSync(join(wsPath, "alias.json"));
	symlinkSync("package.json.bak", join(wsPath, "alias.json"));
	bob.ws.send(JSON.stringify({ type: "approve", approvalId: (bob.events.find((e) => e.type === "approval.request") as Extract<ClientEvent, { type: "approval.request" }>).approvalId, decision: "allow" }));
	await waitFor(owner, (es) => es.some((e) => e.type === "agent.end" && !(e as { willRetry?: boolean }).willRetry));

	const driftDenied = owner.events.find((e) => e.type === "policy.denied") as Extract<ClientEvent, { type: "policy.denied" }> | undefined;
	assert.ok(driftDenied && driftDenied.reason.includes("漂移"), "等待期目标漂移必须被拒");
	assert.equal(readFileSync(join(wsPath, "package.json"), "utf8"), "{}", "package.json 不得被写");
	assert.equal(readFileSync(join(wsPath, "package.json.bak"), "utf8"), "bak", "备份文件不得被写");
	const decisions = await auditDecisions(env.auditFile);
	// B 的 allow 决策审计合法存在；阻断的是 dispatch（文件未变即执行未发生），不存在额外执行 allow
	assert.equal(decisions.filter((d) => d.kind === "approval.decision").length, 1, "仅一条审批决策审计");
	owner.ws.close();
	bob.ws.close();
});

test("正控：require_approval 规范路径审批后正常落盘（不误拒）", async () => {
	const { port, env } = await startProdGateway([{ tool: "write", args: { path: "package.json", content: "REAL" } }, { text: "完成" }]);
	const owner = await connectProd(port, "token-1");
	await waitFor(owner, (es) => es.some((e) => e.type === "session.ready"));
	const wsPath = (owner.events.find((e) => e.type === "session.ready") as Extract<ClientEvent, { type: "session.ready" }>).workspace;
	initGitFixture(wsPath);
	owner.send({ type: "share", actor: "corp|bob-pp", role: "approver" });
	await new Promise((r) => setTimeout(r, 150));
	const bob = await connectProd(port, "token-b", (owner.events.find((e) => e.type === "session.ready") as Extract<ClientEvent, { type: "session.ready" }>).sessionId);
	await waitFor(bob, (es) => es.some((e) => e.type === "session.snapshot"));
	owner.send({ type: "prompt", text: "规范路径审批", requestId: "p1" });
	await waitFor(bob, (es) => es.some((e) => e.type === "approval.request"));
	const req = bob.events.find((e) => e.type === "approval.request") as Extract<ClientEvent, { type: "approval.request" }>;
	bob.ws.send(JSON.stringify({ type: "approve", approvalId: req.approvalId, decision: "allow" }));
	await waitFor(owner, (es) => es.some((e) => e.type === "agent.end" && !(e as { willRetry?: boolean }).willRetry));
	assert.equal(readFileSync(join(wsPath, "package.json"), "utf8"), "REAL");
	const decisions = await auditDecisions(env.auditFile);
	assert.ok(decisions.some((d) => d.verdict === "allow"), "合法审批必须落 allow 审计");
	owner.ws.close();
	bob.ws.close();
});

test("单元：canonical 解析抛错时 fail-closed deny（不吞为 allow、不到达审批）", async () => {
	const audits: any[] = [];
	const emitted: any[] = [];
	const extension = perimeterExtension({
		repo: "r", team: "t",
		policy: PolicyEngine.fromYaml(readFileSync(POLICY, "utf8")),
		actor: async () => "alice",
		approvals: () => { throw new Error("不应到达审批"); },
		approvalTimeoutMs: 1000,
		audit: (input) => audits.push(input),
		emit: (e) => emitted.push(e),
		resolveGuardPath: async () => { throw new Error("path guard helper failed: econn-refused"); },
	});
	const hook = (extension.hooks as readonly { task: string; handlers: { beforeTool: (call: unknown, api: unknown, ctx: unknown) => Promise<{ block?: string } | undefined> } }[])
		.find((h) => h.task === "pi.tool");
	assert.ok(hook, "必须能取到 pi.tool 钩子");
	const result = await hook.handlers.beforeTool(
		{ id: "c1", name: "write", arguments: { path: "a.txt", content: "x" } },
		{},
		{ abortSignal: new AbortController().signal },
	);
	assert.ok(result?.block?.includes("fail-closed"), `必须 fail-closed 拒绝：${JSON.stringify(result)}`);
	assert.ok(emitted.some((e: any) => e.type === "policy.denied"), "必须发出脱敏 denied 事件");
	assert.ok(!audits.some((a) => a.kind === "approval.request"), "守卫失败不得进入审批");
});

// ---------- Slice A R2：能力缺失 / 取消 / deadline / 毒化隔离 ----------

function makeExtension(overrides: Partial<Parameters<typeof perimeterExtension>[0]> & { isProduction?: boolean }) {
	const audits: any[] = [];
	const emitted: any[] = [];
	const extension = perimeterExtension({
		repo: "r", team: "t",
		policy: PolicyEngine.fromYaml(readFileSync(POLICY, "utf8")),
		actor: async () => "alice",
		approvals: () => { throw new Error("不应到达审批"); },
		approvalTimeoutMs: 1000,
		audit: (input) => audits.push(input),
		emit: (e) => emitted.push(e),
		...overrides,
	});
	const hook = (extension.hooks as readonly { task: string; handlers: { beforeTool: (call: unknown, api: unknown, ctx: unknown) => Promise<{ block?: string } | undefined> } }[])
		.find((h) => h.task === "pi.tool");
	assert.ok(hook, "必须能取到 pi.tool 钩子");
	return { beforeTool: hook.handlers.beforeTool, audits, emitted };
}

test("能力缺失：production 下守卫能力缺失 → fail-closed deny（不静默跳过）", async () => {
	const cases = [
		{ label: "缺失 resolveGuardPath", overrides: { isProduction: true } },
	];
	for (const c of cases) {
		const { beforeTool, emitted } = makeExtension(c.overrides as never);
		const result = await beforeTool({ id: "c", name: "write", arguments: { path: "a.txt", content: "x" } }, {}, { abortSignal: new AbortController().signal });
		assert.ok(result?.block?.includes("缺少 canonical 路径解析能力"), `${c.label}：必须 fail-closed deny`);
		assert.ok((emitted as any[]).some((e) => e.type === "policy.denied" && e.rule === "canonical-path-guard"), `${c.label}：必须 emit 准确 denied`);
	}
});

test("能力缺失：demo 语义明确——不拒但留「守卫未启用」审计，词法策略照常", async () => {
	const { beforeTool, audits } = makeExtension({ /* demo：无 isProduction，且能力缺失 */ });
	const result = await beforeTool({ id: "c", name: "write", arguments: { path: "a.txt", content: "x" } }, {}, { abortSignal: new AbortController().signal });
	assert.equal(result, undefined, "demo 下能力缺失不拒（语义明确化，非静默）");
	assert.ok(audits.some((a) => a.summary?.includes("路径守卫未启用")), "必须留明确审计痕迹");
});

test("abort-before：工具信号已取消 → 拒且 resolver 未被调用", async () => {
	let calls = 0;
	const { beforeTool } = makeExtension({
		resolveGuardPath: async () => { calls++; return { canonical: "/ws/a.txt", root: "/ws", stats: null }; },
	});
	const controller = new AbortController();
	controller.abort(new Error("tool cancelled"));
	const result = await beforeTool({ id: "c", name: "write", arguments: { path: "a.txt", content: "x" } }, {}, { abortSignal: controller.signal });
	assert.ok(result?.block?.includes("类别=aborted"), `工具取消必须归类 aborted：${result?.block}`);
	assert.equal(calls, 0, "取消在前不得调用 resolver");
});

test("deadline：不响应的守卫解析在有限时间内 fail-closed deny（真实 deadline 而非立即/永久）", async () => {
	let calls = 0;
	const { beforeTool } = makeExtension({
		guardTimeoutMs: 200,
		resolveGuardPath: (raw: string, signal?: AbortSignal) => {
			calls++;
			return new Promise((_, reject) => { signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "aborted" })), { once: true }); });
		},
	});
	const started = Date.now();
	const result = await beforeTool({ id: "c", name: "write", arguments: { path: "a.txt", content: "x" } }, {}, { abortSignal: new AbortController().signal });
	const elapsed = Date.now() - started;
	assert.ok(result?.block?.includes("fail-closed"), "deadline 到点必须 fail-closed deny");
	assert.ok(elapsed >= 150 && elapsed < 1500, `deny 应发生在 deadline 附近（实际 ${elapsed}ms）`);
	assert.ok(calls >= 1, "resolver 必须真实被调用过（信号已接线）");
});

test("毒化隔离：守卫解析首次失败后，后续合法请求不受污染（每次新受控阶段）", async () => {
	let guardCalls = 0;
	const { beforeTool } = makeExtension({
		resolveGuardPath: async () => {
			guardCalls++;
			if (guardCalls === 1) throw Object.assign(new Error("path guard helper failed"), { code: "unknown" });
			return { canonical: "/ws/a.txt", root: "/ws", stats: null };
		},
	});
	const first = await beforeTool({ id: "c1", name: "write", arguments: { path: "a.txt", content: "x" } }, {}, { abortSignal: new AbortController().signal });
	assert.ok(first?.block?.includes("fail-closed"), "首次失败必须 deny");
	const second = await beforeTool({ id: "c2", name: "write", arguments: { path: "a.txt", content: "x" } }, {}, { abortSignal: new AbortController().signal });
	assert.equal(second, undefined, "第二次合法请求不受首次失败毒化");
	assert.equal(guardCalls, 2, "每次守卫都是新受控阶段，失败不得被缓存复用");
});

test("RPC 失败：permission_denied 类别继续 fail-closed（非 not_found 不回退）", async () => {
	const { beforeTool, emitted } = makeExtension({
		resolveGuardPath: async () => { const e = new Error("permission"); (e as any).code = "permission_denied"; throw e; },
	});
	const result = await beforeTool({ id: "c", name: "write", arguments: { path: "a.txt", content: "x" } }, {}, { abortSignal: new AbortController().signal });
	assert.ok(result?.block?.includes("permission_denied"), "权限类失败必须 fail-closed");
	assert.ok((emitted as any[]).some((e) => e.type === "policy.denied"));
});

// ---------- Slice A R3：错误类别白名单（无余文/宿主路径/secret 泄露） ----------

test("白名单：无 code 的任意 Error 文案 → 类别 unknown，拒绝原因不含宿主路径/secret 余文", async () => {
	const LEAKY = "EACCES: permission denied, open '/Users/someuser/private/secrets/token.txt'";
	const { beforeTool } = makeExtension({
		resolveGuardPath: async () => { throw new Error(LEAKY); },
	});
	const result = await beforeTool({ id: "c", name: "write", arguments: { path: "a.txt", content: "x" } }, {}, { abortSignal: new AbortController().signal });
	assert.ok(result?.block?.includes("类别=unknown"), `必须归类 unknown：${result?.block}`);
	assert.ok(!result?.block?.includes("/Users"), "不得泄露宿主路径");
	assert.ok(!result?.block?.includes("secrets"), "不得泄露 secret-like 内容");
	assert.ok(!result?.block?.includes("EACCES:"), "不得包含 Error.message 余文");
});

test("白名单：带白名单 code 的错误按 code 分类（not_found/permission_denied）", async () => {
	for (const code of ["not_found", "permission_denied"]) {
		const { beforeTool } = makeExtension({
			resolveGuardPath: async () => { throw Object.assign(new Error("path guard helper failed"), { code }); },
		});
		const result = await beforeTool({ id: "c", name: "write", arguments: { path: "a.txt", content: "x" } }, {}, { abortSignal: new AbortController().signal });
		assert.ok(result?.block?.includes(`类别=${code}`), `${code} 必须白名单分类：${result?.block}`);
	}
});

test("分类稳定：deadline 按控制器状态归类（非 Error 文案），abort 按工具信号归类", async () => {
	// deadline：resolver 永不响应，guardTimeoutMs 到点 → 类别=deadline（即使 rejection reason 任意文案）
	const never = makeExtension({
		guardTimeoutMs: 150,
		resolveGuardPath: (raw: string, signal?: AbortSignal) => new Promise((_, reject) => { signal?.addEventListener("abort", () => reject(new Error("任意超时文案 /Users/x")), { once: true }); }),
	});
	const r1 = await never.beforeTool({ id: "c", name: "write", arguments: { path: "a.txt", content: "x" } }, {}, { abortSignal: new AbortController().signal });
	assert.ok(r1?.block?.includes("类别=deadline"), `deadline 必须按状态分类：${r1?.block}`);
	assert.ok(!r1?.block?.includes("/Users/x"), "任意文案不得透传");
	// abort：工具信号取消 → 类别=aborted
	const controller = new AbortController();
	controller.abort(new Error("tool cancelled"));
	const aborted = makeExtension({
		resolveGuardPath: async () => { throw new Error("任意错误文案"); },
	});
	const r2 = await aborted.beforeTool({ id: "c", name: "write", arguments: { path: "a.txt", content: "x" } }, {}, { abortSignal: controller.signal });
	assert.ok(r2?.block?.includes("类别=aborted"), `工具取消必须归类 aborted：${r2?.block}`);
});
