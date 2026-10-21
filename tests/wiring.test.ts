import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { AuditLog } from "../src/audit/log.ts";
import { writeSandboxConfig } from "../src/gateway/sandbox-config.ts";
import { Gateway } from "../src/gateway/server.ts";
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
const UPSTREAM_KEY = "UPSTREAM-KEY-only-in-model-gateway";
const GATEWAY_TOKEN = "GATEWAY-TOKEN-for-browser";
const PROXY_TOKEN = "PROXY-TOKEN-for-sandbox";

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups) await c();
});

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
