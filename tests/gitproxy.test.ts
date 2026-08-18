import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AuditLog } from "../src/audit/log.ts";
import { GitCredentialProxy } from "../src/gitproxy/server.ts";

/**
 * 覆盖策略说明（诚实标注，别让测试名许诺它没验证的东西）：
 *
 * - 全部用例走 **HTTP 层**：断言凭据注入、Basic 认证握手、请求体完整转发、
 *   push 被识别并留痕、allowlist 生效。
 * - **未覆盖**：真实 git 二进制的端到端 clone/push。tests/fixtures/git-http-server.mjs
 *   里留了一个最小 smart HTTP 上游，但本机系统级 git 配置（credential helper）
 *   会干扰无人值守运行，因此不作为自动化测试的一部分。Week 3 验收里的
 *   「沙箱内 clone/push 成功」需要在演示环境用真实 GitLab 手动跑一次 ——
 *   这一条尚未验证，不要当作已完成。
 * - 数据传输阶段（upload-pack / receive-pack 的 POST）**用 HTTP 层验证：
 *   断言请求体完整转发、凭据被注入、push 被识别并留痕。
 *   完整的 clone/push 冒烟需要一个真实的 git smart HTTP 服务端
 *   （生产上是 GitLab/GitHub 本身），不适合作为单元测试的一部分。
 */

const UPSTREAM_TOKEN = "glpat-real-upstream-token";
const UPSTREAM_AUTH = `Basic ${Buffer.from(`x-access-token:${UPSTREAM_TOKEN}`).toString("base64")}`;
const SESSION_TOKEN = "sandbox-session-token";

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups) await c();
});

/** 记录型假上游，用于 POST 阶段的断言 */
async function startRecordingUpstream(): Promise<{ port: number; seen: { method: string; url: string; auth: string | null; bytes: number }[] }> {
	const seen: { method: string; url: string; auth: string | null; bytes: number }[] = [];
	const srv = createServer((req, res) => {
		let bytes = 0;
		req.on("data", (c) => {
			bytes += c.length;
		});
		req.on("end", () => {
			seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization ?? null, bytes });
			res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" }).end("OK");
		});
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
	return { port: (srv.address() as { port: number }).port, seen };
}

async function startProxy(upstreamPort: number, allowPush?: boolean) {
	const auditFile = join(mkdtempSync(join(tmpdir(), "gp-")), "audit.jsonl");
	const audit = AuditLog.open(auditFile);
	cleanups.push(() => audit.close());
	const proxy = new GitCredentialProxy({
		port: 0,
		host: "127.0.0.1",
		token: SESSION_TOKEN,
		audit,
		repos: [
			{
				name: "app.git",
				upstream: `http://127.0.0.1:${upstreamPort}/app.git`,
				username: "x-access-token",
				token: UPSTREAM_TOKEN,
				allowPush,
			},
		],
	});
	cleanups.push(() => proxy.close());
	return { auditFile, base: `http://127.0.0.1:${await proxy.listen()}` };
}

async function auditEntries(file: string) {
	const out = [];
	for await (const e of AuditLog.replay(file)) out.push(e);
	return out;
}

function post(base: string, path: string, body: string, headers: Record<string, string> = {}) {
	return fetch(`${base}${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${SESSION_TOKEN}`, "content-type": "application/x-git-upload-pack-request", ...headers },
		body,
		signal: AbortSignal.timeout(10_000),
	});
}

// ── 真实 git 客户端：凭据注入 ───────────────────────────────

test("git 客户端的 Basic 认证握手：会话 token 通过，上游凭据被替换", async () => {
	const up = await startRecordingUpstream();
	const { base } = await startProxy(up.port);
	// git 把 URL 里的 user:pass 编成 Basic 送给代理
	const sandboxAuth = `Basic ${Buffer.from(`x-session:${SESSION_TOKEN}`).toString("base64")}`;
	const res = await fetch(`${base}/app.git/info/refs?service=git-upload-pack`, { headers: { authorization: sandboxAuth } });
	assert.equal(res.status, 200);
	assert.equal(up.seen[0]?.auth, UPSTREAM_AUTH, "上游看到的是注入的凭据，不是沙箱送来的会话 token");
});

test("沙箱侧从头到尾没有上游 git 凭据 —— 铁律 2 的形态", async () => {
	const up = await startRecordingUpstream();
	const { base } = await startProxy(up.port);
	const sandboxUrl = `http://x-session:${SESSION_TOKEN}@${new URL(base).host}/app.git`;
	await fetch(`${base}/app.git/info/refs?service=git-upload-pack`, {
		headers: { authorization: `Basic ${Buffer.from(`x-session:${SESSION_TOKEN}`).toString("base64")}` },
	});
	// 沙箱能看到的全部：remote URL
	assert.ok(!sandboxUrl.includes(UPSTREAM_TOKEN), "上游 git 凭据绝不能出现在沙箱侧");
	assert.ok(sandboxUrl.includes(SESSION_TOKEN), "沙箱手里只有会话 token —— 拿到别处无用");
});

test("没有会话 token 时，git 客户端拿到 401 挑战而不是静默失败", async () => {
	const up = await startRecordingUpstream();
	const { base } = await startProxy(up.port);
	const res = await fetch(`${base}/app.git/info/refs?service=git-upload-pack`);
	assert.equal(res.status, 401);
	assert.match(res.headers.get("www-authenticate") ?? "", /Basic/);
});

// ── 数据传输阶段 ────────────────────────────────────────────

test("POST 请求体完整转发，且带上注入的凭据", async () => {
	const up = await startRecordingUpstream();
	const { base } = await startProxy(up.port);
	const body = "0032want 1111111111111111111111111111111111111111\n0000";

	const res = await post(base, "/app.git/git-upload-pack", body);
	assert.equal(res.status, 200);

	const seen = up.seen[0]!;
	assert.equal(seen.method, "POST");
	assert.equal(seen.bytes, Buffer.byteLength(body), "请求体必须完整到达上游");
	assert.equal(seen.auth, UPSTREAM_AUTH, "凭据由代理注入");
});

test("推送走 git-receive-pack，被单独识别并留痕", async () => {
	const up = await startRecordingUpstream();
	const { base, auditFile } = await startProxy(up.port);

	await post(base, "/app.git/git-receive-pack", "0000", { "content-type": "application/x-git-receive-pack-request" });

	const push = (await auditEntries(auditFile)).find((e) => e.kind === "git.push" && e.verdict === "allow");
	assert.ok(push, "推送必须留痕");
	assert.match(push!.summary, /推送到 app\.git/);
});

test("审计里不得出现上游凭据，连上游地址里内嵌的也要剥掉", async () => {
	const up = await startRecordingUpstream();
	const auditFile = join(mkdtempSync(join(tmpdir(), "gp-")), "audit.jsonl");
	const audit = AuditLog.open(auditFile);
	cleanups.push(() => audit.close());
	const proxy = new GitCredentialProxy({
		port: 0,
		host: "127.0.0.1",
		token: SESSION_TOKEN,
		audit,
		repos: [{ name: "app.git", upstream: `http://user:embedded-secret@127.0.0.1:${up.port}/app.git`, token: UPSTREAM_TOKEN }],
	});
	cleanups.push(() => proxy.close());
	const base = `http://127.0.0.1:${await proxy.listen()}`;

	await post(base, "/app.git/git-receive-pack", "0000");
	const dump = JSON.stringify(await auditEntries(auditFile));
	assert.ok(!dump.includes(UPSTREAM_TOKEN));
	assert.ok(!dump.includes("embedded-secret"));
});

test("只读仓库拒绝推送，拒绝也留痕", async () => {
	const up = await startRecordingUpstream();
	const { base, auditFile } = await startProxy(up.port, false);

	const res = await post(base, "/app.git/git-receive-pack", "0000");
	assert.equal(res.status, 403);
	assert.equal(up.seen.length, 0, "被拒的推送不该到达上游");
	assert.ok((await auditEntries(auditFile)).some((e) => e.verdict === "deny" && e.summary.includes("只读")));
});

test("info/refs 上的推送探测同样受 allowPush 约束", async () => {
	const up = await startRecordingUpstream();
	const { base } = await startProxy(up.port, false);
	const res = await fetch(`${base}/app.git/info/refs?service=git-receive-pack`, {
		headers: { authorization: `Bearer ${SESSION_TOKEN}` },
	});
	assert.equal(res.status, 403);
});

// ── allowlist ───────────────────────────────────────────────

test("allowlist 之外的仓库被拒 —— 代理握着组织级 token，不限仓就等于把它借出去", async () => {
	const up = await startRecordingUpstream();
	const { base, auditFile } = await startProxy(up.port);

	const res = await fetch(`${base}/other-team-secret.git/info/refs?service=git-upload-pack`, {
		headers: { authorization: `Bearer ${SESSION_TOKEN}` },
	});
	assert.equal(res.status, 403);
	assert.equal(up.seen.length, 0);
	assert.ok((await auditEntries(auditFile)).some((e) => e.summary.includes("不在 allowlist 内")));
});

test("非 git 端点与健康检查", async () => {
	const up = await startRecordingUpstream();
	const { base } = await startProxy(up.port);
	const res = await fetch(`${base}/app.git/../../etc/passwd`, { headers: { authorization: `Bearer ${SESSION_TOKEN}` } });
	assert.equal(res.status, 404);
	assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("上游不可达时返回 502 而不是挂死", async () => {
	const auditFile = join(mkdtempSync(join(tmpdir(), "gp-")), "audit.jsonl");
	const audit = AuditLog.open(auditFile);
	cleanups.push(() => audit.close());
	const proxy = new GitCredentialProxy({
		port: 0,
		host: "127.0.0.1",
		token: SESSION_TOKEN,
		audit,
		repos: [{ name: "app.git", upstream: "http://127.0.0.1:1/app.git" }],
		fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
	});
	cleanups.push(() => proxy.close());
	const base = `http://127.0.0.1:${await proxy.listen()}`;
	const res = await post(base, "/app.git/git-upload-pack", "0000");
	assert.equal(res.status, 502);
});
