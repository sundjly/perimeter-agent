import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { randomBytes } from "node:crypto";
import { AuditLog } from "../src/audit/log.ts";
import { GitCredentialProxy } from "../src/gitproxy/server.ts";
import { signGrant } from "../src/gitproxy/grants.ts";

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
// B2：共享静态会话 token 已废除。测试用真签发器（HMAC masterKey + registry 假快照注入）
// 按 grant 维度发凭证；负控语义不变，只换凭证来源（合同 §7 迁移要求）。
const MASTER_KEY = randomBytes(32);
const INTERNAL_TOKEN = "internal-test-token-0123456789abcdef";
const SESSION = "sess-test";
const PRINCIPAL = "principal-test";
const TENANT = "tenant-test";

interface GrantOpts {
	repo?: string;
	read?: boolean;
	write?: boolean;
	writeRefs?: string[];
	exp?: number;
	jti?: string;
	session?: string;
	principal?: string;
	tenant?: string;
	aclVersion?: number;
}

function makeIssuer() {
	const snapshot = {
		epoch: "epoch-test-1",
		activeSessions: {
			[SESSION]: { principal: PRINCIPAL, tenant: TENANT, repo: "app.git", aclVersion: 1 },
		} as Record<string, { principal: string; tenant: string; repo: string; aclVersion: number }>,
		revokedJtis: [] as string[],
	};
	const registryFetchImpl = (async () => new Response(JSON.stringify(snapshot), { status: 200 })) as unknown as typeof fetch;
	return {
		snapshot,
		registryFetchImpl,
		issue(opts: GrantOpts = {}): string {
			const repo = opts.repo ?? "app.git";
			return signGrant(
				{
					v: 1, tenant: opts.tenant ?? TENANT, principal: opts.principal ?? PRINCIPAL,
					session: opts.session ?? SESSION, repo,
					caps: { read: opts.read ?? true, write: opts.write ?? false, writeRefs: opts.writeRefs ?? (opts.write ? ["refs/heads/*"] : []) },
					exp: opts.exp ?? Date.now() + 600_000,
					jti: opts.jti ?? `jti-${Math.random().toString(36).slice(2)}`,
					epoch: snapshot.epoch, aclVersion: opts.aclVersion ?? 1,
				} as never,
				MASTER_KEY, Date.now(),
			);
		},
	};
}
type Issuer = ReturnType<typeof makeIssuer>;

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

async function startProxy(upstreamPort: number, allowPush?: boolean, issuer?: Issuer) {
	const iss = issuer ?? makeIssuer();
	const auditFile = join(mkdtempSync(join(tmpdir(), "gp-")), "audit.jsonl");
	const audit = AuditLog.open(auditFile);
	cleanups.push(() => audit.close());
	const proxy = new GitCredentialProxy({
		port: 0,
		host: "127.0.0.1",
		mode: "production",
		masterKey: MASTER_KEY,
		registry: { url: "http://127.0.0.1:1/internal/git/registry", internalToken: INTERNAL_TOKEN, pollMs: 5_000 },
		registryFetchImpl: iss.registryFetchImpl,
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
	const base = `http://127.0.0.1:${await proxy.listen()}`;
	const issue = (o: GrantOpts = {}) => iss.issue({ write: allowPush ?? false, ...o });
	// 便捷读 grant（最常用形态）
	const readGrant = (): string => issue({ read: true, write: false });
	const writeGrant = (): string => issue({ read: true, write: true, writeRefs: ["refs/heads/*"] });
	return { auditFile, base, issue, readGrant, writeGrant, iss };
}

async function auditEntries(file: string) {
	const out = [];
	for await (const e of AuditLog.replay(file)) out.push(e);
	return out;
}

function post(base: string, path: string, body: string, headers: Record<string, string> = {}) {
	return fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/x-git-upload-pack-request", ...headers },
		body,
		signal: AbortSignal.timeout(10_000),
	});
}

// ── 真实 git 客户端：凭据注入 ───────────────────────────────

test("git 客户端的 Basic 认证握手：会话 token 通过，上游凭据被替换", async () => {
	const up = await startRecordingUpstream();
	const { base, issue } = await startProxy(up.port);
	// git 把 URL 里的 user:pass 编成 Basic 送给代理（x-session:<grant> 形态不变）
	const grant = issue({ read: true });
	const sandboxAuth = `Basic ${Buffer.from(`x-session:${grant}`).toString("base64")}`;
	const res = await fetch(`${base}/app.git/info/refs?service=git-upload-pack`, { headers: { authorization: sandboxAuth } });
	assert.equal(res.status, 200);
	assert.equal(up.seen[0]?.auth, UPSTREAM_AUTH, "上游看到的是注入的凭据，不是沙箱送来的会话 token");
});

test("沙箱侧从头到尾没有上游 git 凭据 —— 铁律 2 的形态", async () => {
	const up = await startRecordingUpstream();
	const { base, issue } = await startProxy(up.port);
	const grant = issue({ read: true });
	const sandboxUrl = `http://x-session:${grant}@${new URL(base).host}/app.git`;
	await fetch(`${base}/app.git/info/refs?service=git-upload-pack`, {
		headers: { authorization: `Basic ${Buffer.from(`x-session:${grant}`).toString("base64")}` },
	});
	// 沙箱能看到的全部：remote URL
	assert.ok(!sandboxUrl.includes(UPSTREAM_TOKEN), "上游 git 凭据绝不能出现在沙箱侧");
	assert.ok(sandboxUrl.includes(grant), "沙箱手里只有本会话 grant —— 拿到别处无用（scope 锁 repo）");
});

test("没有会话 token 时，git 客户端拿到 401 挑战而不是静默失败", async () => {
	const up = await startRecordingUpstream();
	const { base, issue } = await startProxy(up.port);
	const grant = issue({ read: true });
	const res = await fetch(`${base}/app.git/info/refs?service=git-upload-pack`);
	assert.equal(res.status, 401);
	assert.match(res.headers.get("www-authenticate") ?? "", /Basic/);
});

// ── 数据传输阶段 ────────────────────────────────────────────

test("POST 请求体完整转发，且带上注入的凭据", async () => {
	const up = await startRecordingUpstream();
	const { base, issue } = await startProxy(up.port);
	const grant = issue({ read: true });
	const body = "0032want 1111111111111111111111111111111111111111\n0000";

	const res = await post(base, "/app.git/git-upload-pack", body, { authorization: `Bearer ${grant}` });
	assert.equal(res.status, 200);

	const seen = up.seen[0]!;
	assert.equal(seen.method, "POST");
	assert.equal(seen.bytes, Buffer.byteLength(body), "请求体必须完整到达上游");
	assert.equal(seen.auth, UPSTREAM_AUTH, "凭据由代理注入");
});

function pktCmd(oldSha: string, newSha: string, refname: string): string {
	const payload = `${oldSha} ${newSha} ${refname}\n`;
	return Math.round((payload.length + 4)).toString(16).padStart(4, "0") + payload + "0000";
}

test("推送走 git-receive-pack，被单独识别并留痕（合法命令区，writeRefs 内）", async () => {
	const up = await startRecordingUpstream();
	// 推送必须显式授权 —— 默认是只读的
	const { base, auditFile, issue } = await startProxy(up.port, true);
	const grant = issue({ read: true, write: true, writeRefs: ["refs/heads/*"] });

	const body = pktCmd("0".repeat(40), "1".repeat(40), "refs/heads/main");
	await post(base, "/app.git/git-receive-pack", body, { authorization: `Bearer ${grant}`, "content-type": "application/x-git-receive-pack-request" });

	const push = (await auditEntries(auditFile)).find((e) => e.kind === "git.push" && e.verdict === "allow");
	assert.ok(push, "推送必须留痕");
	assert.match(push!.summary, /推送到 app\.git/);
});

test("R49-N4：read-only grant 打 receive-pack → caps 层 403（先于命令区解析），上游零写入", async () => {
	const up = await startRecordingUpstream();
	const { base, issue } = await startProxy(up.port, true); // 部署面允许 push
	const grant = issue({ read: true, write: false }); // 凭证面无写
	const res = await post(base, "/app.git/git-receive-pack", "0000", {
		authorization: `Bearer ${grant}`,
		"content-type": "application/x-git-receive-pack-request",
	});
	assert.equal(res.status, 403);
	assert.equal(up.seen.length, 0);
});

test("R49-N11：payload/签名篡改 → 403（HMAC 失败），上游零写入", async () => {
	const up = await startRecordingUpstream();
	const { base, issue } = await startProxy(up.port);
	const grant = issue({ read: true });
	const tampered = grant.slice(0, -2) + (grant.endsWith("AA") ? "BB" : "AA");
	const res = await fetch(`${base}/app.git/info/refs?service=git-upload-pack`, {
		headers: { authorization: `Bearer ${tampered}` },
	});
	assert.equal(res.status, 403);
	assert.equal(up.seen.length, 0);
});

test("R49-B2：content-type 与端点不一致 → 400 fail-closed（先于 body），上游零写入", async () => {
	const up = await startRecordingUpstream();
	const { base, issue } = await startProxy(up.port, true);
	const grant = issue({ read: true, write: true, writeRefs: ["refs/heads/*"] });
	const res = await post(base, "/app.git/git-upload-pack", "0032want x\n0000", {
		authorization: `Bearer ${grant}`,
		"content-type": "application/x-git-receive-pack-request", // upload-pack 端点配 receive ctype
	});
	assert.equal(res.status, 400);
	assert.equal(up.seen.length, 0);
});

test("R49-N3：receive-pack 越域 ref（writeRefs 之外）→ 403，上游零写入", async () => {
	const up = await startRecordingUpstream();
	const { base, issue } = await startProxy(up.port, true);
	const grant = issue({ read: true, write: true, writeRefs: ["refs/heads/feature/*"] });
	const body = pktCmd("0".repeat(40), "2".repeat(40), "refs/heads/outside");
	const res = await post(base, "/app.git/git-receive-pack", body, {
		authorization: `Bearer ${grant}`,
		"content-type": "application/x-git-receive-pack-request",
	});
	assert.equal(res.status, 403);
	assert.equal(up.seen.length, 0, "越域推送不得到达上游");
});

test("R49-N14：命令区超过 64KiB → 413，上游零写入", async () => {
	const up = await startRecordingUpstream();
	const { base, issue } = await startProxy(up.port, true);
	const grant = issue({ read: true, write: true, writeRefs: ["refs/heads/*"] });
	// R68-C：命令 pkt 线须在 flush 前累计 >64KiB——原构造每个 pktCmd 自带尾随 0000，
	// 首个 flush 即收束命令区，其余重复体沦为 PACK 数据 → 误 200。改为 N 条无 flush
	// 命令线 + 单次收尾 flush（单线 103B，700 条 ≈70KiB ≫ 64KiB 上限）。
	const cmdLine = "0067" + "0".repeat(40) + " " + "3".repeat(40) + " refs/heads/main\n";
	const flood = cmdLine.repeat(700) + "0000";
	const res = await post(base, "/app.git/git-receive-pack", flood, {
		authorization: `Bearer ${grant}`,
		"content-type": "application/x-git-receive-pack-request",
	});
	assert.equal([403, 413].includes(res.status), true, `超限/畸形命令区必须拒（实际 ${res.status}）`);
	assert.equal(up.seen.length, 0);
});

test("R49-A7：production 构造期 fail-closed（legacy token / 缺 registry）", () => {
	const up = 1;
	assert.throws(() => new GitCredentialProxy({
		port: 0, host: "127.0.0.1", mode: "production", masterKey: MASTER_KEY,
		legacySessionToken: "legacy",
		registry: { url: "http://x", internalToken: INTERNAL_TOKEN, pollMs: 5_000 },
		repos: [{ name: "app.git", upstream: `http://127.0.0.1:${up}/app.git` }],
	}), /legacySessionToken/);
	assert.throws(() => new GitCredentialProxy({
		port: 0, host: "127.0.0.1", mode: "production", masterKey: MASTER_KEY,
		repos: [{ name: "app.git", upstream: `http://127.0.0.1:${up}/app.git` }],
	}), /registry/);
});

test("R49-N15/B7：上游 302 → redirect:error → 502 + deny，跳转目标零请求", async () => {
	const redirector = createServer((_req, res) => {
		res.writeHead(302, { location: "http://127.0.0.1:1/evil" });
		res.end();
	});
	await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
	cleanups.push(() => new Promise<void>((r) => redirector.close(() => r())));
	const redirectPort = (redirector.address() as { port: number }).port;
	const auditFile = join(mkdtempSync(join(tmpdir(), "gp-")), "audit.jsonl");
	const audit = AuditLog.open(auditFile);
	cleanups.push(() => audit.close());
	const iss = makeIssuer();
	const proxy = new GitCredentialProxy({
		port: 0, host: "127.0.0.1", mode: "production", masterKey: MASTER_KEY,
		registry: { url: "http://127.0.0.1:1/internal/git/registry", internalToken: INTERNAL_TOKEN, pollMs: 5_000 },
		registryFetchImpl: iss.registryFetchImpl,
		audit,
		repos: [{ name: "app.git", upstream: `http://127.0.0.1:${redirectPort}/app.git`, token: UPSTREAM_TOKEN }],
	});
	cleanups.push(() => proxy.close());
	const base = `http://127.0.0.1:${await proxy.listen()}`;
	const grant = iss.issue({ read: true });
	const res = await fetch(`${base}/app.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${grant}` } });
	assert.equal(res.status, 502);
	// R68-D：真实 fetch + redirect:error 下，302 呈现为 fetch rejection → 固定类别 502 deny
	//（不透传 302 细节）；「重定向」summary 仅在注入 fetchImpl 直返 3xx 的生产分支可达。
	assert.ok((await auditEntries(auditFile)).some((e) => e.verdict === "deny" && e.summary.includes("上游 fetch 失败")));
});

test("审计里不得出现上游凭据，连上游地址里内嵌的也要剥掉", async () => {
	const up = await startRecordingUpstream();
	const auditFile = join(mkdtempSync(join(tmpdir(), "gp-")), "audit.jsonl");
	const audit = AuditLog.open(auditFile);
	cleanups.push(() => audit.close());
	const iss = makeIssuer();
	const proxy = new GitCredentialProxy({
		port: 0,
		host: "127.0.0.1",
		mode: "production",
		masterKey: MASTER_KEY,
		registry: { url: "http://127.0.0.1:1/internal/git/registry", internalToken: INTERNAL_TOKEN, pollMs: 5_000 },
		registryFetchImpl: iss.registryFetchImpl,
		audit,
		repos: [
			{
				name: "app.git",
				upstream: `http://user:embedded-secret@127.0.0.1:${up.port}/app.git`,
				token: UPSTREAM_TOKEN,
				allowPush: true,
			},
		],
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
	const { base, auditFile, issue } = await startProxy(up.port, false);
	const grant = issue({ read: true });

	// R68-v2：合法形态 push 请求（端点×content-type 三方一致是 caps/allowPush 前置，
	// 默认 upload-pack content-type 会被先行 400 拦截——同 #6 惯例）
	const res = await post(base, "/app.git/git-receive-pack", "0000", { authorization: `Bearer ${grant}`, "content-type": "application/x-git-receive-pack-request" });
	assert.equal(res.status, 403);
	assert.equal(up.seen.length, 0, "被拒的推送不该到达上游");
	assert.ok((await auditEntries(auditFile)).some((e) => e.verdict === "deny" && e.summary.includes("未显式授权推送")));
});

test("info/refs 上的推送探测同样受 allowPush 约束", async () => {
	const up = await startRecordingUpstream();
	const { base, issue } = await startProxy(up.port, false);
	const grant = issue({ read: true });
	const res = await fetch(`${base}/app.git/info/refs?service=git-receive-pack`, {
		headers: { authorization: `Bearer ${grant}` },
	});
	assert.equal(res.status, 403);
});

// ── allowlist ───────────────────────────────────────────────

test("allowlist 之外的仓库被拒 —— 代理握着组织级 token，不限仓就等于把它借出去", async () => {
	const up = await startRecordingUpstream();
	const { base, auditFile, issue } = await startProxy(up.port);
	const grant = issue({ read: true });

	const res = await fetch(`${base}/other-team-secret.git/info/refs?service=git-upload-pack`, {
		headers: { authorization: `Bearer ${grant}` },
	});
	assert.equal(res.status, 403);
	assert.equal(up.seen.length, 0);
	assert.ok((await auditEntries(auditFile)).some((e) => e.summary.includes("不在 allowlist 内")));
});

test("非 git 端点与健康检查", async () => {
	const up = await startRecordingUpstream();
	const { base, issue } = await startProxy(up.port);
	const grant = issue({ read: true });
	const res = await fetch(`${base}/app.git/../../etc/passwd`, { headers: { authorization: `Bearer ${grant}` } });
	assert.equal(res.status, 404);
	assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("上游不可达时返回 502 而不是挂死", async () => {
	const auditFile = join(mkdtempSync(join(tmpdir(), "gp-")), "audit.jsonl");
	const audit = AuditLog.open(auditFile);
	cleanups.push(() => audit.close());
	const iss = makeIssuer();
	const proxy = new GitCredentialProxy({
		port: 0,
		host: "127.0.0.1",
		mode: "production",
		masterKey: MASTER_KEY,
		registry: { url: "http://127.0.0.1:1/internal/git/registry", internalToken: INTERNAL_TOKEN, pollMs: 5_000 },
		registryFetchImpl: iss.registryFetchImpl,
		audit,
		repos: [{ name: "app.git", upstream: "http://127.0.0.1:1/app.git" }],
		fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
	});
	cleanups.push(() => proxy.close());
	const base = `http://127.0.0.1:${await proxy.listen()}`;
	const grant = iss.issue({ read: true }); // R67：带有效 grant 过授权面，才能到达上游 fetch（不可达 → 502 而非 401）
	const res = await post(base, "/app.git/git-upload-pack", "0000", { authorization: `Basic ${Buffer.from(`x-session:${grant}`).toString("base64")}` });
	assert.equal(res.status, 502);
});

test("默认只读：不传 allowPush 时推送被拒", async () => {
	const up = await startRecordingUpstream();
	const { base, auditFile, issue } = await startProxy(up.port);
	const grant = issue({ read: true }); // 刻意不传

	// R68-v2：同 #14——显式 receive-pack content-type 才能到达 caps/allowPush 层（否则先行 400）
	const res = await post(base, "/app.git/git-receive-pack", "0000", { authorization: `Bearer ${grant}`, "content-type": "application/x-git-receive-pack-request" });
	assert.equal(res.status, 403, "未显式授权就该拒绝");
	assert.equal(up.seen.length, 0, "被拒的推送不该到达上游");
	assert.ok((await auditEntries(auditFile)).some((e) => e.verdict === "deny"));
});

test("默认只读不影响 clone —— 只读仓库照样能拉", async () => {
	const up = await startRecordingUpstream();
	const { base, issue } = await startProxy(up.port);
	const grant = issue({ read: true });
	const res = await fetch(`${base}/app.git/info/refs?service=git-upload-pack`, {
		headers: { authorization: `Bearer ${grant}` },
	});
	assert.equal(res.status, 200);
	assert.equal(up.seen.length, 1);
});

test("只有 service 参数被透传给上游 —— 沙箱不能往上游塞任意查询串", async () => {
	// 全量透传会让沙箱覆盖 upstream URL 里已有的同名参数
	// （GitLab 支持 ?private_token=），也给上游多开一个无谓的输入面
	const up = await startRecordingUpstream();
	const { base, issue } = await startProxy(up.port);
	const grant = issue({ read: true });
	await fetch(`${base}/app.git/info/refs?service=git-upload-pack&private_token=attacker&x=1`, {
		headers: { authorization: `Bearer ${grant}` },
	});
	const seen = up.seen.at(-1)!;
	assert.match(seen.url, /service=git-upload-pack/);
	assert.ok(!seen.url.includes("private_token"), "沙箱传的额外参数不得到达上游");
	assert.ok(!seen.url.includes("x=1"));
});

test("重复 service 参数：代理判定与转发给上游的必须一致", async () => {
	// 这是全量透传与白名单唯一发生安全性分歧的输入。旧写法下：
	// isPush 读第一个值（upload-pack → 判定非推送、放行），而循环 set 用
	// 最后一个值覆盖 → 上游收到 receive-pack。
	// 「代理认为不是推送」与「上游按推送处理」同时成立，
	// 正是只读仓库最不该出现的状态。
	const up = await startRecordingUpstream();
	const { base, issue } = await startProxy(up.port);
	const grant = issue({ read: true }); // 默认只读
	const res = await fetch(`${base}/app.git/info/refs?service=git-upload-pack&service=git-receive-pack`, {
		headers: { authorization: `Bearer ${grant}` },
	});

	if (res.status === 200) {
		// 放行了就必须是按 upload-pack 放行的，上游不能收到 receive-pack
		assert.ok(!up.seen.at(-1)!.url.includes("git-receive-pack"), "代理判定非推送，却把 receive-pack 递给了上游");
	} else {
		// 或者干脆 fail-closed 拒绝（B2 设计定案：重复 service 参数 → 400 固定类别），
		// 上游零接触是硬性要求
		assert.equal(res.status, 400);
		assert.equal(up.seen.length, 0);
	}
});

test("端点与方法的对应被强制 —— 不替沙箱把 PUT/DELETE 递给上游", async () => {
	const up = await startRecordingUpstream();
	const { base, issue } = await startProxy(up.port);
	const grant = issue({ read: true });
	for (const method of ["PUT", "DELETE", "PATCH"]) {
		const res = await fetch(`${base}/app.git/info/refs?service=git-upload-pack`, {
			method,
			headers: { authorization: `Bearer ${grant}` },
		});
		assert.equal(res.status, 405, `${method} 应当被拒`);
	}
	assert.equal(up.seen.length, 0, "被拒的请求不该带着注入的凭据到达上游");
});

test("service 值的大小写变体不透传 —— 判定与转发不能各看各的字符串", async () => {
	const up = await startRecordingUpstream();
	const { base, issue } = await startProxy(up.port);
	const grant = issue({ read: true });
	await fetch(`${base}/app.git/info/refs?service=GIT-RECEIVE-PACK`, {
		headers: { authorization: `Bearer ${grant}` },
	});
	if (up.seen.length > 0) {
		assert.ok(!/service=/i.test(up.seen.at(-1)!.url), "不认识的 service 值不该原样递给上游");
	}
});
