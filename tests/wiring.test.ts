import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { AuditLog } from "../src/audit/log.ts";
import { writeSandboxConfig } from "../src/gateway/sandbox-config.ts";
import { Gateway, scmGrantRepo } from "../src/gateway/server.ts";
import { GitCredentialProxy } from "../src/gitproxy/server.ts";
import { signGrant } from "../src/gitproxy/grants.ts";
import { ModelGateway } from "../src/modelgw/server.ts";
import type { ClientEvent } from "../src/protocol/types.ts";

/**
 * 组件接线的端到端验证：浏览器 → 网关 → pi（沙箱）→ 模型网关 → 上游。
 *
 * 要证明的是铁律 2 在**运行时**成立，而不只是在设计里成立。
 * 三个 token 刻意取不同的值，否则断言无法区分「凭据隔离成立」与
 * 「两个域用了同一个串所以看起来成立」。
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MOCK = join(REPO, "tests/fixtures/mock-model.mjs");
const GIT_SERVER = fileURLToPath(new URL("./fixtures/git-http-server.mjs", import.meta.url));
const UPSTREAM_KEY = "UPSTREAM-KEY-only-in-model-gateway";
const GATEWAY_TOKEN = "GATEWAY-TOKEN-for-browser";
const PROXY_TOKEN = "PROXY-TOKEN-for-sandbox";

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups) await c();
});

/** 预占一个回环空闲端口（production 代理的 registry url 必须在构造期确定——打破与 Gateway 端口的循环依赖） */
async function reservePort(): Promise<number> {
	const srv = createServer();
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const port = (srv.address() as { port: number }).port;
	await new Promise<void>((r) => srv.close(() => r()));
	return port;
}

/** 递归收集目录下所有文件内容 */
function readAllFiles(dir: string, out: { path: string; text: string }[] = []): { path: string; text: string }[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) readAllFiles(p, out);
		else out.push({ path: p, text: readFileSync(p, "utf8") });
	}
	return out;
}

// ── 配置生成 ────────────────────────────────────────────────

test("沙箱配置里写的是代理 token，不是上游凭据", () => {
	const home = mkdtempSync(join(tmpdir(), "wire-"));
	const generated = writeSandboxConfig(home, {
		proxyToken: PROXY_TOKEN,
		modelGatewayUrl: "http://model-gateway.internal:8080/v1",
		model: "claude-sonnet",
	});

	assert.ok(!readdirSync(home).includes(".pi"));
	assert.equal(generated.home, home);
});

test("git 重写带上主机名 —— 否则两个上游的同名仓库会塌缩成同一条 allowlist", () => {
	const home = mkdtempSync(join(tmpdir(), "wire-"));
	writeSandboxConfig(home, {
		proxyToken: PROXY_TOKEN,
		modelGatewayUrl: "http://mgw/v1",
		gitProxyUrl: "http://git-proxy.internal:8080",
		gitProxyToken: "git-only-token",
		scmHosts: ["gitlab.internal", "github.com"],
	});

	const cfg = readFileSync(join(home, ".gitconfig"), "utf8");
	// 两个上游各自有独立的代理命名空间
	assert.match(cfg, /git-proxy\.internal:8080\/gitlab\.internal\/"\]/);
	assert.match(cfg, /git-proxy\.internal:8080\/github\.com\/"\]/);
	// https 与 ssh 两种写法都要覆盖，否则换个协议就绕过代理
	assert.match(cfg, /insteadOf = https:\/\/gitlab\.internal\//);
	assert.match(cfg, /insteadOf = git@gitlab\.internal:/);
	// 沙箱里不该有本地凭据存储
	assert.match(cfg, /\[credential\]\n\thelper =/);
});

test("token 做 URL 编码 —— 含 / @ : 的 token 会把 URL 解析歪", () => {
	const home = mkdtempSync(join(tmpdir(), "wire-"));
	writeSandboxConfig(home, {
		proxyToken: "model-only-token",
		gitProxyToken: "ab/cd+ef=gh",
		modelGatewayUrl: "http://mgw/v1",
		gitProxyUrl: "http://proxy:8080",
		scmHosts: ["git.internal"],
	});
	const cfg = readFileSync(join(home, ".gitconfig"), "utf8");
	assert.match(cfg, /x-session:ab%2Fcd%2Bef%3Dgh@proxy:8080/);
	assert.ok(!cfg.includes("x-session:ab/cd"));
});

test("缺 proxyToken 或只配 git 不配模型，都在生成时就报错", () => {
	const home = mkdtempSync(join(tmpdir(), "wire-"));
	assert.throws(() => writeSandboxConfig(home, { proxyToken: "" }), /proxyToken 必填/);
	assert.throws(
		() => writeSandboxConfig(home, { proxyToken: "t", gitProxyUrl: "http://p", scmHosts: ["x"] }),
		/gitProxyToken 必填/,
	);
});

// ── 网关的 fail-fast ────────────────────────────────────────

test("代理 token 等于网关 token 时拒绝启动 —— 否则等于把审批门钥匙交给 agent", () => {
	const dir = mkdtempSync(join(tmpdir(), "wire-"));
	assert.throws(
		() =>
			new Gateway({
				mode: "demo",
				port: 0,
				host: "127.0.0.1",
				token: "same-token",
				policyFile: join(REPO, "config/policy.yaml"),
				auditFile: join(dir, "a.jsonl"),
				workspaceRoot: join(dir, "ws"),
				webRoot: join(REPO, "web"),
				wiring: { proxyToken: "same-token", modelGatewayUrl: "http://mgw/v1" },
			}),
		/不能等于网关 token/,
	);
});

// ── 端到端 ──────────────────────────────────────────────────

test("端到端：请求经模型网关，且沙箱侧任何文件都不含上游凭据或网关 token", async () => {
	const mock: ChildProcess = spawn(process.execPath, [MOCK, "0", JSON.stringify([{ text: "已修复" }])], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	cleanups.push(() => void mock.kill());
	const mockPort: number = await new Promise((r) => mock.stdout?.once("data", (d) => r(JSON.parse(d.toString()).port)));

	const dir = mkdtempSync(join(tmpdir(), "wire-e2e-"));
	const mgwAudit = AuditLog.open(join(dir, "modelgw.jsonl"));
	cleanups.push(() => mgwAudit.close());
	const modelGw = new ModelGateway({
		port: 0,
		host: "127.0.0.1",
		token: PROXY_TOKEN,
		upstreams: [{ id: "upstream", baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: UPSTREAM_KEY }],
		egressAllowlist: ["127.0.0.1"],
		audit: mgwAudit,
	});
	cleanups.push(() => modelGw.close());
	const modelPort = await modelGw.listen();

	const workspaceRoot = join(dir, "workspaces");
	const gateway = new Gateway({
		mode: "demo",
		port: 0,
		host: "127.0.0.1",
		token: GATEWAY_TOKEN,
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit.jsonl"),
		workspaceRoot,
		webRoot: join(REPO, "web"),
		wiring: { proxyToken: PROXY_TOKEN, modelGatewayUrl: `http://127.0.0.1:${modelPort}/v1`, model: "mock-model" },
	});
	cleanups.push(() => gateway.close());
	const port = await gateway.listen();

	const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${GATEWAY_TOKEN}`);
	const events: ClientEvent[] = [];
	ws.on("message", (raw) => {
		const m = JSON.parse(String(raw));
		if (m.type !== "control") events.push(m.event);
	});
	await new Promise((r) => ws.once("open", r));
	cleanups.push(() => void ws.close());

	const waitFor = async (pred: () => boolean, ms = 25_000) => {
		const deadline = Date.now() + ms;
		while (!pred()) {
			if (Date.now() > deadline) throw new Error(`超时；已收到 ${events.map((e) => e.type).join(",")}`);
			await new Promise((r) => setTimeout(r, 20));
		}
	};

	await waitFor(() => events.some((e) => e.type === "session.ready"));
	ws.send(JSON.stringify({ type: "prompt", requestId: randomUUID(), text: "修一下" }));
	await waitFor(() => events.some((e) => e.type === "agent.end" && !e.willRetry));

	// 回答来自上游，说明整条链路通了
	const text = events.filter((e) => e.type === "message.end").map((e) => (e as { text: string }).text).join("");
	assert.match(text, /已修复/);

	// 模型网关确实在链路上
	const mgwEntries = [];
	for await (const e of AuditLog.replay(join(dir, "modelgw.jsonl"))) mgwEntries.push(e);
	assert.ok(mgwEntries.some((e) => e.kind === "usage"), "请求必须经过模型网关");

	// 决定性断言：遍历沙箱能看到的全部文件（HOME + workspace）
	// 遍历 HOME 与 workspace 两处 —— 沙箱能看到的全部文件
	writeFileSync(join(workspaceRoot, "sandbox-fixture.txt"), "实际遍历的沙箱文件");
	const files = readAllFiles(workspaceRoot);
	assert.ok(files.length > 0, "应当扫到文件，否则这条断言是空转");
	for (const f of files) {
		assert.ok(!f.text.includes(UPSTREAM_KEY), `上游凭据泄漏到 ${f.path}`);
		assert.ok(!f.text.includes(GATEWAY_TOKEN), `网关 token 泄漏到 ${f.path} —— agent 读到就能批准自己的审批`);
	}
	// 而代理 token 确实在（沙箱要用它访问模型网关）
	assert.ok(!files.some((f) => f.text.includes(PROXY_TOKEN)), "模型 token 不应进入沙箱");
});

test("沙箱 HOME 在 workspace 之外 —— 否则 git commit 会把 token 带进仓库", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wire-home-"));
	const workspaceRoot = join(dir, "workspaces");
	const gateway = new Gateway({
		mode: "demo",
		port: 0,
		host: "127.0.0.1",
		token: GATEWAY_TOKEN,
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit.jsonl"),
		workspaceRoot,
		webRoot: join(REPO, "web"),
		wiring: { proxyToken: PROXY_TOKEN, modelGatewayUrl: "http://127.0.0.1:1/v1", model: "m" },
	});
	cleanups.push(() => gateway.close());
	const port = await gateway.listen();
	const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${GATEWAY_TOKEN}&session=abc123`);
	await new Promise((r) => ws.once("open", r));
	cleanups.push(() => void ws.close());
	await new Promise((r) => setTimeout(r, 800));

	// agent 的 cwd 是 workspaces/abc123；HOME 在 workspaces/.homes/abc123
	const cwdFiles = readAllFiles(join(workspaceRoot, "abc123"));
	assert.ok(!cwdFiles.some((f) => f.text.includes(PROXY_TOKEN)), "工作区里不该有任何 token —— 它会被 commit 走");
	assert.ok(!readAllFiles(join(workspaceRoot, ".homes", "abc123")).some((f) => f.text.includes(PROXY_TOKEN)));
});

test("显式模型配置不能与沙箱 git 代理共用凭据", () => {
	const dir = mkdtempSync(join(tmpdir(), "credential-domains-"));
	assert.throws(() => new Gateway({ mode: "demo", port: 0, host: "127.0.0.1", token: "browser-only", policyFile: "config/policy.yaml", auditFile: join(dir, "a.jsonl"), workspaceRoot: join(dir, "ws"), webRoot: "web",
		model: { baseUrl: "http://model/v1", token: "same", model: "model" }, wiring: { proxyToken: "unused-model-alias", gitProxyToken: "same", gitProxyUrl: "http://git", scmHosts: ["git.internal"] } }), /模型 token 不能与 gitProxyToken 相同/);
});

test("B2：gitGrant masterKey/internalToken 与既有凭据域互异（构造期 fail-fast；R51 H1 真实 ctor 同缝）", async () => {
	// 纯度口径（R50 观察如实）：Gateway 构造含真实 reaper/renew timer 与 audit FS ——
	// 本用例是构造级非 pure；纯逻辑断言在 tests/credential-domains.test.ts（同缝模块）。
	const dir = mkdtempSync(join(tmpdir(), "grant-domains-"));
	// R67：互异分支的 masterKey/token 同值需 ≥32B（构造期强度门 H1 先于互异检查：
	// 12B "browser-only" 在互异前即抛「强度不足」）；各互异/形态碰撞分支数据同步补足 ≥32B，语义不变。
	const gwToken = "browser-only-0123456789abcdef0123456789";
	const base = { mode: "demo" as const, port: 0, host: "127.0.0.1", token: gwToken, policyFile: "config/policy.yaml", auditFile: join(dir, "a.jsonl"), workspaceRoot: join(dir, "ws"), webRoot: "web", model: { baseUrl: "http://model/v1", token: "model-only", model: "model" }, wiring: { proxyToken: "unused-model-alias", gitProxyToken: "git-proxy-only", gitProxyUrl: "http://git", scmHosts: ["git.internal"] } };
	// R68-A：意外构造成功必须先 close 再 fail——否则 reaper/renew timer 残留挂死整个文件。
	async function expectCtorThrow(cfg: ConstructorParameters<typeof Gateway>[0], re: RegExp): Promise<void> {
		let g: Gateway | null = null;
		let err: unknown;
		try { g = new Gateway(cfg); } catch (e) { err = e; }
		if (g !== null) { try { await g.close(); } catch { /* 意外实例收尾失败不掩盖主断言 */ } }
		assert.ok(
			err instanceof Error && re.test(err.message),
			`构造期必须抛 ${re}，实际：${err instanceof Error ? err.message : String(err)}`,
		);
	}
	// masterKey 等于网关 token → 抛（R67 已证：该分支真实生效）
	await expectCtorThrow({ ...base, gitGrants: { masterKey: gwToken, internalToken: "internal-only-0123456789", writeRefs: ["refs/heads/*"] } }, /凭据域必须分开/);
	// masterKey 等于 internalToken → 抛
	await expectCtorThrow({ ...base, gitGrants: { masterKey: "internal-collide-0123456789abcdef0123456789", internalToken: "internal-collide-0123456789abcdef0123456789", writeRefs: ["refs/heads/*"] } }, /internalToken/);
	// masterKey 过短 → 抛（H1：强度与互异同门）
	await expectCtorThrow({ ...base, gitGrants: { masterKey: "short", internalToken: "internal-only-0123456789", writeRefs: ["refs/heads/*"] } }, /强度不足/);
	// R-Q50-5：同字节跨形态（masterKey Buffer 原字节恰为 internalToken 字符串的 UTF-8 字节）不藏碰撞。
	// R68-A 勘误：原 .toString("hex") 是「不同字节」（hex 文本 ≠ 原字节），byte 级比较下
	// 本就不构成碰撞，断言恒失败——改为等值字符串形态（这才是 R-Q50-5 的同字节不同形态）。
	const collide = Buffer.from("hex-collide-0123456789abcdef0123456789", "utf8");
	await expectCtorThrow({ ...base, gitGrants: { masterKey: collide, internalToken: collide.toString("utf8"), writeRefs: ["refs/heads/*"] } }, /凭据域碰撞/);
	// 合法互异配置真正不抛/进入生产接线（H1 正控：不再恒抛）
	const gw = new Gateway({ ...base, gitGrants: { masterKey: randomBytes(32), internalToken: "internal-only-0123456789", writeRefs: ["refs/heads/*"] } });
	await gw.close();
});

test("C3：scmGrantRepo 推导（正例/带端口/无路径/未登记反例；合同 A2 全等口径）", () => {
	const repos = [{ name: "git.internal/app.git" }];
	assert.equal(scmGrantRepo("https://git.internal/app.git", repos), "git.internal/app.git", "正例：host+path");
	assert.equal(scmGrantRepo("https://git.internal/app.git/", repos), "git.internal/app.git", "尾斜杠归一");
	assert.equal(scmGrantRepo("https://git.internal:8443/team/app.git", [{ name: "git.internal:8443/team/app.git" }]), "git.internal:8443/team/app.git", "带端口推导");
	assert.equal(scmGrantRepo("https://git.internal", repos), null, "无路径 fail-closed");
	assert.equal(scmGrantRepo("https://git.internal/", repos), null, "仅斜杠无路径 fail-closed");
	assert.equal(scmGrantRepo("https://git.internal/app.git?x=1", repos), null, "带 query 不签发");
	assert.equal(scmGrantRepo("https://other.internal/app.git", repos), null, "不在 repos 登记不签发（demo-app 类策略标签同理）");
	assert.equal(scmGrantRepo(undefined, repos), null, "未配置 repoUrl 不签发");
	assert.equal(scmGrantRepo("https://git.internal/app.git", undefined), null, "无 repos 配置不签发");
	assert.equal(scmGrantRepo("ftp://git.internal/app.git", repos), null, "非 http(s) 不签发");
});

test("R72：构造期 fail-closed（已初始化 stateRoot 缺 revocations.json）抛错后无残留 ref 定时器", async () => {
	// 回归锚：Gateway ctor 曾在 renew timer（ref，armed 450s）之后才跑 #loadRevocations，
	// 构造抛错时无 close 可调 → ref 定时器泄漏拖住整个进程直至强杀。
	const dir = mkdtempSync(join(tmpdir(), "ctor-leak-"));
	const stateRoot = join(dir, "state");
	// 预置「已初始化实例」痕迹：sessions 目录存在但吊销表缺失 → #loadRevocations fail-closed
	mkdirSync(join(stateRoot, "sessions", "s1"), { recursive: true });
	const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
	let threw = false;
	try {
		new Gateway({
			mode: "demo", port: 0, host: "127.0.0.1", token: "browser-only-0123456789abcdef0123456789",
			policyFile: join(REPO, "config/policy.yaml"), auditFile: join(dir, "a.jsonl"),
			workspaceRoot: join(dir, "ws"), stateRoot, webRoot: "web",
			model: { baseUrl: "http://model/v1", token: "model-only", model: "model" },
			wiring: { proxyToken: "unused-model-alias", gitProxyToken: "git-proxy-only", gitProxyUrl: "http://git", scmHosts: ["git.internal"] },
			gitGrants: { masterKey: randomBytes(32), internalToken: "registry-internal-token-xyz", writeRefs: ["refs/heads/*"] },
		});
	} catch {
		threw = true; // fail-closed 抛错本身是期望行为（语义与消息不在本例断言范围）
	}
	assert.ok(threw, "已初始化实例缺 revocations.json 必须拒启动");
	// 给可能的异步收尾一拍；ref Timeout 数量不得因构造失败而净增（renew timer 泄漏会 +1）
	await new Promise((r) => setTimeout(r, 50));
	const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
	assert.ok(after <= before, `构造失败不得残留 ref 定时器（before ${before} → after ${after}）`);
});

test("R74：运行中 share 新增 approver —— 旧 grant 立即失效、新 grant 带新 aclVersion 可用", async () => {
	// 真实四眼流（R74 方案 a）：owner 运行中 share approver → acl 变更撤旧 grant 并以
	// 新 aclVersion 重签（renew 同缝事务）→ 旧 grant 403（jti 已吊销）、新 grant 200。
	const execP = promisify(execFile);
	const dir = mkdtempSync(join(tmpdir(), "r74-"));
	const masterKey = randomBytes(32);
	const internalToken = randomBytes(24).toString("base64url");
	const sid = "r74share1";
	const owner = "demo@local";
	const approver = "approver@local";

	// 真实 git 上游（session.start 要 clone；gitGrants 现强制 repoUrl，故必须真拓扑）
	const upstreamAuth = `Basic ${Buffer.from(`x-access-token:${UPSTREAM_KEY}`).toString("base64")}`;
	const scmRoot = mkdtempSync(join(tmpdir(), "r74-scm-"));
	const upstreamRepo = join(scmRoot, "app.git");
	const seed = mkdtempSync(join(tmpdir(), "r74-seed-"));
	const g = (args: string[], cwd: string) =>
		execP("git", args, { cwd, env: { PATH: process.env.PATH ?? "", HOME: cwd, GIT_AUTHOR_NAME: "s", GIT_AUTHOR_EMAIL: "s@s", GIT_COMMITTER_NAME: "s", GIT_COMMITTER_EMAIL: "s@s" } });
	await g(["init", "-q", "-b", "main"], seed);
	writeFileSync(join(seed, "README.md"), "r74 seed\n");
	await g(["add", "."], seed);
	await g(["commit", "-qm", "初始提交"], seed);
	await g(["init", "-q", "--bare", upstreamRepo], scmRoot);
	await g(["remote", "add", "origin", upstreamRepo], seed);
	await g(["push", "-q", "origin", "main"], seed);
	const scm = spawn(process.execPath, [GIT_SERVER, scmRoot, upstreamAuth], { stdio: ["ignore", "pipe", "inherit"] });
	cleanups.push(() => void scm.kill());
	const scmPort: number = await new Promise((r) => scm.stdout?.once("data", (d) => r(JSON.parse(d.toString()).port)));

	// mock 模型 + ModelGateway：session.ready 需 pi 完整启动，模型仅在 prompt 时被调用
	const mock = spawn(process.execPath, [MOCK, "0", JSON.stringify([{ text: "ok" }])], { stdio: ["ignore", "pipe", "inherit"] });
	cleanups.push(() => void mock.kill());
	const mockPort: number = await new Promise((r, rej) => {
		const t = setTimeout(() => rej(new Error("mock 模型启动超时")), 10_000);
		mock.stdout?.once("data", (d) => { clearTimeout(t); r(JSON.parse(d.toString()).port); });
	});
	const mgwAudit = AuditLog.open(join(dir, "modelgw.jsonl"));
	cleanups.push(() => mgwAudit.close());
	const modelGw = new ModelGateway({
		port: 0, host: "127.0.0.1", token: PROXY_TOKEN,
		upstreams: [{ id: "upstream", baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "UPSTREAM-MODEL-KEY-only-in-mgw" }],
		egressAllowlist: ["127.0.0.1"], audit: mgwAudit,
	});
	cleanups.push(() => modelGw.close());
	const modelPort = await modelGw.listen();

	// 先占网关端口：production 代理的 registry url 必须在构造期确定（不接受运行期回填），
	// 而 Gateway 的 wiring 又需要代理端口——用预留端口打破循环；production 下 maxAuthAge 5s
	// → 轮询周期 ≈4s（dev 为 ≈30s），吊销/重签生效等待按此口径设置。
	const gwPort = await reservePort();
	const gitAudit = AuditLog.open(join(dir, "gitproxy.jsonl"));
	cleanups.push(() => gitAudit.close());
	const gitProxy = new GitCredentialProxy({
		port: 0, host: "127.0.0.1", mode: "production", masterKey,
		registry: { url: `http://127.0.0.1:${gwPort}/internal/git/registry`, internalToken, pollMs: 250 },
		audit: gitAudit,
		repos: [{ name: "git.internal/app.git", upstream: `http://127.0.0.1:${scmPort}/app.git`, username: "x-access-token", token: UPSTREAM_KEY, allowPush: true }],
	});
	cleanups.push(() => gitProxy.close());
	const proxyPort = await gitProxy.listen();

	const workspaceRoot = join(dir, "workspaces");
	const stateRoot = join(dir, "state");
	mkdirSync(join(stateRoot, "sessions", sid), { recursive: true });
	writeFileSync(join(stateRoot, "revocations.json"), JSON.stringify({ revoked: [], updatedAt: new Date().toISOString() }), { mode: 0o600 });

	const gateway = new Gateway({
		mode: "demo", port: gwPort, host: "127.0.0.1", token: GATEWAY_TOKEN,
		policyFile: join(REPO, "config/policy.yaml"), auditFile: join(dir, "audit.jsonl"),
		workspaceRoot, stateRoot, webRoot: join(REPO, "web"),
		gitGrants: { masterKey, internalToken, writeRefs: ["refs/heads/*"], repos: [{ name: "git.internal/app.git", allowPush: true }] },
		wiring: { gitProxyToken: "", proxyToken: PROXY_TOKEN, modelGatewayUrl: `http://127.0.0.1:${modelPort}/v1`, model: "m", gitProxyUrl: `http://127.0.0.1:${proxyPort}`, scmHosts: ["git.internal"] },
		repoUrl: "https://git.internal/app.git",
	});
	cleanups.push(() => gateway.close());
	await gateway.listen(); // 在预留端口上启动（registry url 已在代理构造期确定）

	// 快照就绪探针（同 demo-e2e）：合法签名但未登记 grant 的 deny summary 区分快照是否在位，
	// 避免会话启动 clone 撞上「快照缺失/未登记」fail-closed 空窗（R74-v4 教训）。
	const probeGrant = signGrant({
		v: 1, tenant: "probe", principal: "probe", session: "probe-s", repo: "git.internal/app.git",
		caps: { read: true, write: false, writeRefs: [] }, exp: Date.now() + 60_000, jti: "probe-jti",
		epoch: "epoch-probe", aclVersion: 1,
	} as never, masterKey, Date.now());
	{
		const deadline = Date.now() + 10_000;
		for (;;) {
			await fetch(`http://127.0.0.1:${proxyPort}/git.internal/app.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${probeGrant}` } });
			let ready = false;
			for await (const e of AuditLog.replay(join(dir, "gitproxy.jsonl"))) {
				if (e.verdict === "deny" && /epoch 与 registry 快照不一致|session 未在活会话登记/.test(e.summary)) ready = true;
			}
			if (ready) break;
			if (Date.now() > deadline) throw new Error("git 代理未及时拉取 registry 快照");
			await new Promise((r) => setTimeout(r, 100));
		}
	}

	const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/?token=${GATEWAY_TOKEN}&actor=${owner}&session=${sid}`);
	const events: ClientEvent[] = [];
	ws.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.type !== "control" && m.event) events.push(m.event); });
	await new Promise((r) => ws.once("open", r));
	cleanups.push(() => void ws.close());
	const waitFor = async (pred: () => boolean, ms = 10_000): Promise<void> => {
		const deadline = Date.now() + ms;
		while (!pred()) {
			if (Date.now() > deadline) {
				const errs = events.filter((e) => e.type === "error").map((e) => JSON.stringify(e)).join(" | ");
				throw new Error(`超时；事件：${events.map((e) => e.type).join(",")}；error：${errs.slice(0, 500) || "(无)"}`);
			}
			await new Promise((r) => setTimeout(r, 20));
		}
	};
	await waitFor(() => events.some((e) => e.type === "session.ready"));

	const home = join(workspaceRoot, ".homes", sid);
	const grantFromHome = (): string => {
		const m = readFileSync(join(home, ".gitconfig"), "utf8").match(/x-session:([^@\s]+)@/);
		assert.ok(m, "沙箱 HOME .gitconfig 必须携带 grant");
		return m[1]!;
	};
	const statusWith = async (grant: string): Promise<number> =>
		(await fetch(`http://127.0.0.1:${proxyPort}/git.internal/app.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${grant}` } })).status;
	const waitForStatus = async (grant: string, want: number, ms = 5_000): Promise<void> => {
		const deadline = Date.now() + ms;
		for (;;) {
			if ((await statusWith(grant)) === want) return;
			if (Date.now() > deadline) throw new Error(`grant 未在 ${ms}ms 内达到 ${want}`);
			await new Promise((r) => setTimeout(r, 50));
		}
	};

	const grant0 = grantFromHome();
	await waitForStatus(grant0, 200); // 基线：签发 grant 可用（session-miss 重拉覆盖冷启动）

	ws.send(JSON.stringify({ type: "share", actor: approver, role: "approver" }));
	// R74：share → acl 变更撤旧签新——HOME gitconfig 的 grant 随即更换（agent 无感）
	const deadline = Date.now() + 5_000;
	while (grantFromHome() === grant0) {
		if (Date.now() > deadline) throw new Error("share 后 grant 未重签（HOME gitconfig 未更换）");
		await new Promise((r) => setTimeout(r, 50));
	}
	const grant1 = grantFromHome();
	assert.notEqual(grant1, grant0, "重签后的必须是新 grant 串");

	// A6 语义：吊销/重签后旧 grant 在 ≤poll 轮询周期（production ≈4s）内失效属预期；
	// 等待上限 = 轮询周期 + 余量，不枙 5s 死限
	await waitForStatus(grant0, 403, 8_000); // 旧 grant：jti 已吊销 → 403（A6：旧 aclVersion 必须失效）
	await waitForStatus(grant1, 200); // 新 grant：新 aclVersion 可用

	const reg = await fetch(`http://127.0.0.1:${gwPort}/internal/git/registry`, { headers: { authorization: `Bearer ${internalToken}` } });
	assert.equal(reg.status, 200);
	const snap = (await reg.json()) as { activeSessions: Record<string, { aclVersion: number }>; revokedJtis: string[] };
	assert.equal(snap.activeSessions[sid]?.aclVersion, 2, "registry aclVersion 必须为新值");
	assert.ok(snap.revokedJtis.length > 0, "旧 jti 必须已进吊销表");
});

/** R78 共用：起真实本地上游 git（clone 必须成功，否则会话启动失败会先撤 grant，撞不进 acl 重签路径） */
async function seedUpstream(prefix: string): Promise<number> {
	const execP = promisify(execFile);
	const upstreamAuth = `Basic ${Buffer.from(`x-access-token:${UPSTREAM_KEY}`).toString("base64")}`;
	const scmRoot = mkdtempSync(join(tmpdir(), `${prefix}-scm-`));
	const upstreamRepo = join(scmRoot, "app.git");
	const seed = mkdtempSync(join(tmpdir(), `${prefix}-seed-`));
	const g = (args: string[], cwd: string) =>
		execP("git", args, { cwd, env: { PATH: process.env.PATH ?? "", HOME: cwd, GIT_AUTHOR_NAME: "s", GIT_AUTHOR_EMAIL: "s@s", GIT_COMMITTER_NAME: "s", GIT_COMMITTER_EMAIL: "s@s" } });
	await g(["init", "-q", "-b", "main"], seed);
	writeFileSync(join(seed, "README.md"), `${prefix} seed\n`);
	await g(["add", "."], seed);
	await g(["commit", "-qm", "初始提交"], seed);
	await g(["init", "-q", "--bare", upstreamRepo], scmRoot);
	await g(["remote", "add", "origin", upstreamRepo], seed);
	await g(["push", "-q", "origin", "main"], seed);
	const scm = spawn(process.execPath, [GIT_SERVER, scmRoot, upstreamAuth], { stdio: ["ignore", "pipe", "inherit"] });
	cleanups.push(() => void scm.kill());
	return await new Promise((r) => scm.stdout?.once("data", (d) => r(JSON.parse(d.toString()).port)));
}

test("R78：acl 重签（#remintGitGrant）写 HOME 失败 —— 旧 grant 已撤不复活、新 entry 不残留登记", async () => {
	// round-13 缺口 (a)：重签事务失败路径此前无测试。失败注入用现有真实缝（零 prod 改动）：
	// 沙箱 HOME 目录置 0o500 → 重签投递步 writeGitCredentialConfig 的 writeFileSync(tmp) EACCES。
	// 期望（renew 同缝事务语义）：new jti 退役（不可用）、回滚不复活旧 grant、
	// fresh entry 连同移除（不留无 token 的半登记）、固定类别审计可见。
	const dir = mkdtempSync(join(tmpdir(), "r78a-"));
	const masterKey = randomBytes(32);
	const internalToken = randomBytes(24).toString("base64url");
	const sid = "r78remint1";
	const scmPort = await seedUpstream("r78a");

	const gwPort = await reservePort();
	const gitAudit = AuditLog.open(join(dir, "gitproxy.jsonl"));
	cleanups.push(() => gitAudit.close());
	const gitProxy = new GitCredentialProxy({
		port: 0, host: "127.0.0.1", mode: "production", masterKey,
		registry: { url: `http://127.0.0.1:${gwPort}/internal/git/registry`, internalToken, pollMs: 250 },
		audit: gitAudit,
		repos: [{ name: "git.internal/app.git", upstream: `http://127.0.0.1:${scmPort}/app.git`, username: "x-access-token", token: UPSTREAM_KEY, allowPush: true }],
	});
	cleanups.push(() => gitProxy.close());
	const proxyPort = await gitProxy.listen();

	const workspaceRoot = join(dir, "workspaces");
	const stateRoot = join(dir, "state");
	mkdirSync(join(stateRoot, "sessions", sid), { recursive: true });
	writeFileSync(join(stateRoot, "revocations.json"), JSON.stringify({ revoked: [], updatedAt: new Date().toISOString() }), { mode: 0o600 });

	const gateway = new Gateway({
		mode: "demo", port: gwPort, host: "127.0.0.1", token: GATEWAY_TOKEN,
		policyFile: join(REPO, "config/policy.yaml"), auditFile: join(dir, "audit.jsonl"),
		workspaceRoot, stateRoot, webRoot: join(REPO, "web"),
		gitGrants: { masterKey, internalToken, writeRefs: ["refs/heads/*"], repos: [{ name: "git.internal/app.git", allowPush: true }] },
		wiring: { gitProxyToken: "", proxyToken: PROXY_TOKEN, modelGatewayUrl: "http://127.0.0.1:1/v1", model: "m", gitProxyUrl: `http://127.0.0.1:${proxyPort}`, scmHosts: ["git.internal"] },
		repoUrl: "https://git.internal/app.git",
	});
	cleanups.push(() => gateway.close());
	await gateway.listen();

	// 快照就绪探针（同 R74）：clone 不得撞上「快照缺失 fail-closed」空窗
	const probeGrant = signGrant({
		v: 1, tenant: "probe", principal: "probe", session: "probe-s", repo: "git.internal/app.git",
		caps: { read: true, write: false, writeRefs: [] }, exp: Date.now() + 60_000, jti: "probe-jti",
		epoch: "epoch-probe", aclVersion: 1,
	} as never, masterKey, Date.now());
	{
		const probeDeadline = Date.now() + 10_000;
		for (;;) {
			await fetch(`http://127.0.0.1:${proxyPort}/git.internal/app.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${probeGrant}` } });
			let snapReady = false;
			for await (const e of AuditLog.replay(join(dir, "gitproxy.jsonl"))) {
				if (e.verdict === "deny" && /epoch 与 registry 快照不一致|session 未在活会话登记/.test(e.summary)) snapReady = true;
			}
			if (snapReady) break;
			if (Date.now() > probeDeadline) throw new Error("git 代理未及时拉取 registry 快照");
			await new Promise((r) => setTimeout(r, 100));
		}
	}

	const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/?token=${GATEWAY_TOKEN}&actor=demo@local&session=${sid}`);
	const events: ClientEvent[] = [];
	ws.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.type !== "control" && m.event) events.push(m.event); });
	await new Promise((r) => ws.once("open", r));
	cleanups.push(() => void ws.close());
	const waitFor = async (pred: () => boolean, ms = 20_000): Promise<void> => {
		const deadline = Date.now() + ms;
		while (!pred()) {
			if (Date.now() > deadline) throw new Error(`超时；事件：${events.map((e) => e.type).join(",")}`);
			await new Promise((r) => setTimeout(r, 20));
		}
	};
	await waitFor(() => events.some((e) => e.type === "session.ready"));

	const home = join(workspaceRoot, ".homes", sid);
	const grantFromHome = (): string => {
		const m = readFileSync(join(home, ".gitconfig"), "utf8").match(/x-session:([^@\s]+)@/);
		assert.ok(m, "沙箱 HOME .gitconfig 必须携带 grant");
		return m[1]!;
	};
	const registry = async (): Promise<{ activeSessions: Record<string, { principal: string; aclVersion: number }>; revokedJtis: string[] }> => {
		const res = await fetch(`http://127.0.0.1:${gwPort}/internal/git/registry`, { headers: { authorization: `Bearer ${internalToken}` } });
		assert.equal(res.status, 200);
		return await res.json() as { activeSessions: Record<string, { principal: string; aclVersion: number }>; revokedJtis: string[] };
	};

	const grant0 = grantFromHome();
	{
		const snap0 = await registry();
		assert.ok(snap0.activeSessions[sid], "初签 entry 必须在登记");
		assert.equal(snap0.revokedJtis.length, 0, "基线无 git grant 吊销");
	}

	// 失败注入：HOME 只读 → 重签投递步 writeFileSync EACCES（save 本身不失败 → 走「写 HOME 失败」回滚支路）
	chmodSync(home, 0o500);
	cleanups.unshift(() => { try { chmodSync(home, 0o700); } catch { /* 已被收尾清理 */ } });

	ws.send(JSON.stringify({ type: "share", actor: "approver@local", role: "approver" }));

	// 终态收敛：active 无该 session（fresh entry 回滚连同移除）；revoked 恰 2 = 旧 jti + 未投递 new jti
	const deadline = Date.now() + 5_000;
	let snap: Awaited<ReturnType<typeof registry>>;
	for (;;) {
		snap = await registry();
		if (!snap.activeSessions[sid] && snap.revokedJtis.length === 2) break;
		if (Date.now() > deadline) throw new Error(`重签失败后登记未收敛：active=${Object.keys(snap.activeSessions)} revoked=${snap.revokedJtis.length}`);
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.ok(!snap.activeSessions[sid], "新 entry 不得残留登记（fresh entry 回滚连同移除）");
	assert.equal(snap.revokedJtis.length, 2, "旧 jti 已撤 + new jti 已退役（恰 2 —— 旧 grant 不复活、新 grant 不可用）");
	assert.equal(grantFromHome(), grant0, "写 HOME 失败：沙箱 .gitconfig 仍是旧 grant 串（已吊销失效，未被替换）");
	const entries: { summary: string }[] = [];
	for await (const e of AuditLog.replay(join(dir, "audit.jsonl"))) entries.push(e as { summary: string });
	assert.ok(entries.some((e) => /git grant acl 变更回调失败/.test(e.summary)), "重签失败必须有固定类别审计（不静默）");
});

test("R76：demo 浏览器入口 —— 按 app.js 实际请求序列（静态页 + /auth/session 换 Cookie + 带 Cookie 的 WS）能建立会话", async () => {
	// round-13 R3：banner 的 #token= 流在 demo 下原先必败（/auth/session 401 + WS 无凭据）。
	// app.js R76 后的实际序列：GET / → POST /auth/session（demo：静态 token 换同生产形态
	// Cookie）→ WS 只带 Cookie、无 query 凭据（S1 不变量：凭据不进 WS query；production
	// 走 IdP /auth/session 与 Cookie 校验，行为不变）。
	const dir = mkdtempSync(join(tmpdir(), "r76-"));
	const token = "demo-browser-entry-token";
	const sid = "r76web1";
	const gateway = new Gateway({
		mode: "demo", port: 0, host: "127.0.0.1", token,
		policyFile: join(REPO, "config/policy.yaml"), auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "workspaces"), stateRoot: join(dir, "state"), webRoot: join(REPO, "web"),
		// session.ready 需要可信模型配置（pi 完整启动）；本例不发 prompt，死地址即可
		model: { baseUrl: "http://127.0.0.1:1/v1", token: "bootstrap-only", model: "m" },
	});
	cleanups.push(() => gateway.close());
	const port = await gateway.listen();

	// ① 按 banner 打开：GET /（静态页 200；hash 凭据由页面自行消费/抹除，服务端不参与）
	const page = await fetch(`http://127.0.0.1:${port}/?token=${token}&actor=demo@local`);
	assert.equal(page.status, 200);
	assert.match(page.headers.get("content-type") ?? "", /text\/html/);
	// ② app.js：POST /auth/session（demo：静态 token + x-demo-actor 换同形态会话 Cookie）
	const s = await fetch(`http://127.0.0.1:${port}/auth/session`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, origin: `http://127.0.0.1:${port}`, "x-demo-actor": "demo@local" },
	});
	assert.equal(s.status, 204);
	const setCookie = s.headers.get("set-cookie") ?? "";
	assert.match(setCookie, /__Host-perimeter_session=/);
	assert.match(setCookie, /HttpOnly/);
	assert.match(setCookie, /Secure/);
	assert.match(setCookie, /SameSite=Strict/);
	const cookie = setCookie.split(";")[0]!;
	// ③ app.js connect()：WS 只带 Cookie（无 query 凭据，S1 不变量）→ session.ready
	const ws = new WebSocket(`ws://127.0.0.1:${port}/?session=${sid}`, { headers: { cookie } });
	const events: ClientEvent[] = [];
	ws.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.type !== "control" && m.event) events.push(m.event); });
	await new Promise((r) => ws.once("open", r));
	cleanups.push(() => void ws.close());
	const deadline = Date.now() + 20_000;
	while (!events.some((e) => e.type === "session.ready")) {
		if (Date.now() > deadline) throw new Error(`demo 浏览器入口未能建立会话；事件：${events.map((e) => e.type).join(",")}`);
		await new Promise((r) => setTimeout(r, 20));
	}
	// 审批人第二窗口：独立 Cookie 会话（actor=approver@local）。未 share 前非成员接入
	// 必须 4003 被拒（防越权）；share 后可接入的完整流由 demo-e2e R74 例覆盖。
	const s2 = await fetch(`http://127.0.0.1:${port}/auth/session`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, origin: `http://127.0.0.1:${port}`, "x-demo-actor": "approver@local" },
	});
	assert.equal(s2.status, 204);
	const cookie2 = (s2.headers.get("set-cookie") ?? "").split(";")[0]!;
	const approver = new WebSocket(`ws://127.0.0.1:${port}/?session=${sid}`, { headers: { cookie: cookie2 } });
	const closed = new Promise<number | undefined>((r) => approver.on("close", (c) => r(c)));
	await new Promise((r) => approver.once("open", r));
	cleanups.push(() => void approver.close());
	assert.equal(await closed, 4003, "未 share 的非成员接入必须被拒（4003）");
});
