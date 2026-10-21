import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { AuditLog } from "../src/audit/log.ts";
import {
	GRANT_MAX_TTL_MS,
	MASTER_KEY_MIN_BYTES,
	GrantError,
	refGlobMatch,
	signGrant,
	isValidRefname,
	isSha1,
	verifyGrant,
} from "../src/gitproxy/grants.ts";
import { GitCredentialProxy } from "../src/gitproxy/server.ts";

// B2 scoped-grant 纯 fake 矩阵（合同 §D 单元面；R49）。
// 零资源：无真实网络/git/ps；registry 走 registryFetchImpl 注入假快照；全部同进程。
// R49 coor 裁决 (c)：本轮全部不批执行；涉及回环 listen+fetch 的 3 个 roundtrip 用例已
// 静态移至 tests/git-grants-integration.test.ts（标未授权，属真实集成面），本文件仅保留
// 纯函数/纯注入面。断言原样保留未删。

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

// ── A1/A2：sign/verify、TTL 上限、key 强度、readRefs fail-closed ──

test("grant：签发→验证 roundtrip；claims 逐字段保真", () => {
	const token = signGrant(claims(), MASTER, NOW);
	const v = verifyGrant(token, MASTER, NOW + 1);
	assert.equal(v.ok, true);
	if (v.ok) {
		assert.equal(v.claims.tenant, "t1");
		assert.equal(v.claims.session, "s1");
		assert.equal(v.claims.repo, "git.internal/app.git");
		assert.equal(v.claims.epoch, "epoch-1");
		assert.equal(v.claims.caps.read, true);
	}
});

test("grant：exp ≤15min 上限在签发端锁死；验证端过期即拒", () => {
	assert.throws(() => signGrant(claims({ exp: NOW + GRANT_MAX_TTL_MS + 1 }), MASTER, NOW), /15min|上限/);
	const expired = signGrant(claims({ exp: NOW - 1 }), MASTER, NOW - 2);
	const v = verifyGrant(expired, MASTER, NOW);
	assert.equal(v.ok, false);
	if (!v.ok) assert.match(v.reason, /过期/);
});

test("grant：masterKey <32B 拒；HMAC 篡改/换 key 拒", () => {
	assert.throws(() => signGrant(claims(), randomBytes(MASTER_KEY_MIN_BYTES - 1), NOW), /32 字节|masterKey/);
	const token = signGrant(claims(), MASTER, NOW);
	const bad1 = token.slice(0, -3) + "AAA";
	assert.equal(verifyGrant(bad1, MASTER, NOW).ok, false);
	assert.equal(verifyGrant(token, randomBytes(32), NOW).ok, false, "换 masterKey 验签必败");
});

test("grant：readRefs 字段 fail-closed（B5②：ref 级读控制代理层不可交付）", () => {
	const bad = { ...claims(), readRefs: ["refs/heads/*"] } as never;
	assert.throws(() => signGrant(bad, MASTER, NOW), /readRefs/);
});

test("grant：payload 篡改一位 → HMAC 失败；格式/长度/编码攻击拒", () => {
	const token = signGrant(claims(), MASTER, NOW);
	const payload = token.split(".")[0]!;
	const tampered = `${payload.slice(0, -2)}${payload.endsWith("AA") ? "BB" : "AA"}.${token.split(".")[1]!}`;
	assert.equal(verifyGrant(tampered, MASTER, NOW).ok, false);
	assert.equal(verifyGrant("not-a-grant", MASTER, NOW).ok, false);
	assert.equal(verifyGrant(`${token}.${token}`, MASTER, NOW).ok, false);
	assert.equal(verifyGrant(`${token}${token}`, MASTER, NOW).ok, false);
});

// ── ref 语义：glob 不跨 /、refname 合法性、SHA-1 值域 ──

test("refGlobMatch：* 不跨 /（refs/heads/* 不命中 refs/heads/a/b）且大小写敏感", () => {
	assert.equal(refGlobMatch("refs/heads/*", "refs/heads/main"), true);
	assert.equal(refGlobMatch("refs/heads/*", "refs/heads/a/b"), false, "* 不跨 /");
	assert.equal(refGlobMatch("refs/heads/feature/*", "refs/heads/feature/x/y"), false);
	assert.equal(refGlobMatch("refs/heads/main", "REFS/heads/main"), false, "ref 大小写敏感");
	assert.equal(refGlobMatch("refs/heads/*", "refs/heads/.hidden"), true);
});

test("refname 一把尺（R51 收敛）：Git 非法字符/分量规则与 receive-pack 同用 isValidRefname", () => {
	// H2：旧行内正则漏 refs/heads/a^b；H5：refGlob 尺与 refname 尺不得两把
	for (const bad of ["refs/heads/a^b", "refs/heads/a~b", "refs/heads/a:b", "refs/heads/a?b", "refs/heads/a*b", "refs/heads/a[b", "refs/heads/a\\b", "refs/@{x", "refs//x", "refs/heads/.x", "refs/heads/x.lock", "refs/heads/x.", "heads/x", "refs/heads/x y"]) {
		assert.equal(isValidRefname(bad), false, `refname ${bad} 必须拒`);
	}
	for (const good of ["refs/heads/main", "refs/heads/feature/x-y.z", "refs/tags/v1.0.0"]) {
		assert.equal(isValidRefname(good), true, `refname ${good} 合法`);
	}
});

test("grant 验证失败 reason 全部固定类别（不透传客户端可控原文）", () => {
	// R51 H6 + R-Q52-9：对齐实际固定类串（含后缀），且断言不含原文（不宽泛正则掩盖 wrong reason）
	// R-Q62-1：writeRefs glob 校验签发/验证共用 validateClaims 无条件生效，
	// 非法 writeRefs 在 signGrant 即同步抛错，无法先签后验。
	assert.throws(
		() => signGrant(claims({ caps: { read: true, write: true, writeRefs: ["not-a-ref!!longpayload..."] } }), MASTER, NOW),
		(e) => e instanceof GrantError && e.reason === "caps.writeRefs 非法（固定类别，不透传原文）" && !e.message.includes("not-a-ref"),
	);
});

test("refname/SHA 合法性：UTF-8、refs/ 前缀、控制字符、..、.lock、SHA-1 值域", () => {
	assert.equal(isValidRefname("refs/heads/main"), true);
	assert.equal(isValidRefname("refs/heads/a b"), false, "空格");
	assert.equal(isValidRefname("heads/main"), false, "必须 refs/ 开头");
	assert.equal(isValidRefname("refs/heads/a..b"), false);
	assert.equal(isValidRefname("refs/heads/x.lock"), false);
	assert.equal(isValidRefname("refs/heads/main//sub"), false);
	assert.equal(isSha1("a".repeat(40)), true);
	assert.equal(isSha1("g".repeat(40)), false, "非 hex");
	assert.equal(isSha1("a".repeat(64)), false, "SHA-256 不在本子集声明内");
});

// ── A6/C2：registry 快照（epoch/active/revoked）与代理 fail-closed ──



// ── legacy（A7）：production fail-closed；dev 显式兼容 ──

test("legacy：production 拒 legacySessionToken/缺 registry；dev 显式可构造", () => {
	assert.throws(() => new GitCredentialProxy({
		port: 0, host: "127.0.0.1", mode: "production", masterKey: MASTER, legacySessionToken: "x",
		registry: { url: "http://r", internalToken: "internal-test-token-xyz", pollMs: 5_000 }, repos: [],
	}), /legacySessionToken/);
	assert.throws(() => new GitCredentialProxy({
		port: 0, host: "127.0.0.1", mode: "production", masterKey: MASTER, repos: [],
	}), /registry/);
	const dev = new GitCredentialProxy({
		port: 0, host: "127.0.0.1", mode: "dev", masterKey: MASTER, legacySessionToken: "legacy-dev-token",
		repos: [{ name: "app.git", upstream: "http://127.0.0.1:1/app.git" }],
	});
	cleanups.push(() => dev.close());
});

// ── B6：命令区解析单元面（pkt/64KiB/gzip 有界/dup/空命令区）────────

test("B6 单元：命令区 64KiB 上限由 prepare 层钳制（超限 413 语义，上游零写入）", async () => {
	// 该面在 gitproxy.test.ts 以 HTTP 层真实请求覆盖（R49-N14）；此处保留单元级锚点：
	// PKT_MAX 与 CMD_BAND_MAX_BYTES 的常量契约。
	const { CMD_BAND_MAX_BYTES } = await import("../src/gitproxy/server.ts");
	assert.equal(CMD_BAND_MAX_BYTES, 64 * 1024);
});
