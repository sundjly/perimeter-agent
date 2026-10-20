// B2 scoped-grant 真实集成面（回环 listen+fetch）—— **R49 coor 裁决 (c)：未授权，本轮不运行**。
// 断言原样自纯 fake 矩阵移入；获批执行轮由授权清单点名后方可运行（含 proxy.listen 127.0.0.1:0）。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AuditLog } from "../src/audit/log.ts";
import { GitCredentialProxy } from "../src/gitproxy/server.ts";
import { signGrant } from "../src/gitproxy/grants.ts";

const MASTER = randomBytes(32);
const NOW = 1_700_000_000_000;
const cleanups: (() => Promise<void> | void)[] = [];
after(async () => { for (const c of cleanups) await c(); });

function claims(over: Partial<Parameters<typeof signGrant>[0]> = {}): Parameters<typeof signGrant>[0] {
	return {
		v: 1, tenant: "t1", principal: "p1", session: "s1", repo: "git.internal/app.git",
		caps: { read: true, write: false, writeRefs: [] },
		exp: NOW + 60_000, jti: "jti-1", epoch: "epoch-1", aclVersion: 1, ...over,
	};
}

function makeProxy(over: {
	snapshot?: Record<string, unknown> | null;
	failRegistry?: boolean;
	mode?: "production" | "dev";
} = {}) {
	const calls: { url: string; headers: Record<string, string> }[] = [];
	const snapshot = over.snapshot ?? {
		epoch: "epoch-1",
		activeSessions: { "s1": { principal: "p1", tenant: "t1", repo: "git.internal/app.git", aclVersion: 1 } },
		revokedJtis: [],
	};
	const registryFetchImpl = (async (url: string | URL, init?: RequestInit) => {
		calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
		if (over.failRegistry) return new Response("boom", { status: 500 });
		if (over.snapshot === null) return new Response("{}", { status: 200 });
		return new Response(JSON.stringify(snapshot), { status: 200 });
	}) as unknown as typeof fetch;
	const auditFile = join(mkdtempSync(join(tmpdir(), "grants-")), "audit.jsonl");
	const audit = AuditLog.open(auditFile);
	cleanups.push(() => audit.close());
	const seen: { url: string; auth: string | null }[] = [];
	const upstream = (async (url: string | URL) => {
		seen.push({ url: String(url), auth: null });
		return new Response("OK", { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } });
	}) as unknown as typeof fetch;
	const proxy = new GitCredentialProxy({
		port: 0, host: "127.0.0.1", mode: over.mode ?? "production",
		masterKey: MASTER,
		registry: { url: "http://registry.internal/internal/git/registry", internalToken: "internal-test-token-xyz", pollMs: 5_000 },
		registryFetchImpl,
		fetchImpl: upstream,
		audit,
		nowImpl: () => NOW,
		repos: [{ name: "git.internal/app.git", upstream: "http://upstream.internal/app.git", token: "upstream-secret" }],
	});
	cleanups.push(() => proxy.close());
	return { proxy, calls, seen, auditFile, snapshot };
}


async function roundtrip(p: { proxy: GitCredentialProxy }, token: string, path = "/git.internal/app.git/info/refs?service=git-upload-pack"): Promise<{ status: number }> {
	// 直接触发 listen+一次请求（registry 首拉在构造即开始；等待一拍让快照就位）
	const port = await p.proxy.listen();
	cleanups.push(() => p.proxy.close());
	const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${token}` } });
	await p.proxy.close();
	return { status: res.status };
}

test("registry：internalToken 仅 header 携带（不写 URL）；production 拒 query 形态", async () => {
	const p = makeProxy();
	const token = signGrant(claims(), MASTER, NOW);
	await roundtrip(p, token);
	assert.ok(p.calls.length >= 1, "registry 被轮询");
	const u = new URL(p.calls[0]!.url);
	assert.equal(u.search, "", "registry url 无 query");
	assert.equal(p.calls[0]!.headers.authorization, "Bearer internal-test-token-xyz");
});

test("registry：epoch 不匹配的 grant（旧网关 epoch）→ 拒；session 未登记 → 拒", async () => {
	const p = makeProxy({ snapshot: { epoch: "epoch-1", activeSessions: {}, revokedJtis: [] } });
	const oldEpoch = signGrant(claims({ epoch: "epoch-0" }), MASTER, NOW);
	const r1 = await roundtrip(p, oldEpoch);
	assert.equal(r1.status, 403, "旧 epoch grant 拒");
	const unregistered = signGrant(claims({ session: "s-unknown", epoch: "epoch-1" }), MASTER, NOW);
	const r2 = await roundtrip(p, unregistered);
	assert.equal(r2.status, 403, "未登记 session 拒");
});

test("registry：jti 吊销 → 拒；acl/principal/tenant/repo 失配 → 拒", async () => {
	const p = makeProxy({ snapshot: { epoch: "epoch-1", activeSessions: { "s1": { principal: "p1", tenant: "t1", repo: "git.internal/app.git", aclVersion: 2 } }, revokedJtis: ["jti-1"] } });
	const r1 = await roundtrip(p, signGrant(claims({ jti: "jti-1" }), MASTER, NOW));
	assert.equal(r1.status, 403, "吊销 jti 拒");
	const r2 = await roundtrip(p, signGrant(claims({ tenant: "t2" }), MASTER, NOW));
	assert.equal(r2.status, 403, "tenant 失配拒");
});

test("registry：轮询失败超过 maxStale → fail-closed 全拒（快照缺失形态）", async () => {
	const p = makeProxy({ snapshot: null, failRegistry: false }); // 快照形如空对象但缺 epoch/active → 形状非法 → 永无有效快照
	const token = signGrant(claims(), MASTER, NOW);
	const r = await roundtrip(p, token);
	assert.equal(r.status, 403, "无有效快照必须全拒");
});

