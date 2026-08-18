import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AuditLog, contentHash } from "../src/audit/log.ts";

function tempLog(): string {
	return join(mkdtempSync(join(tmpdir(), "audit-")), "audit.jsonl");
}

function base(kind: "tool.call" | "prompt" = "tool.call") {
	return { kind, sessionId: "s1", actor: "alice@corp", summary: "测试条目" } as const;
}

async function collect(path: string, sessionId?: string) {
	const out = [];
	for await (const e of AuditLog.replay(path, sessionId)) out.push(e);
	return out;
}

function lines(path: string): string[] {
	return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

/** 用与实现相同的公开算法重算整条链 —— 模拟拿到文件写权限的攻击者 */
function forgeChain(path: string, mutate: (entries: Record<string, unknown>[]) => void): void {
	const entries = lines(path).map((l) => JSON.parse(l) as Record<string, unknown>);
	mutate(entries);
	let prev = "0".repeat(64);
	for (const e of entries) {
		e.prevHash = prev;
		delete e.hash;
		const canon = canonicalize(e);
		e.hash = createHash("sha256").update(canon, "utf8").digest("hex");
		prev = e.hash as string;
	}
	writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

function canonicalize(v: unknown): string {
	if (v === null || v === undefined) return "null";
	if (typeof v !== "object") return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
	const obj = v as Record<string, unknown>;
	const keys = Object.keys(obj)
		.filter((k) => obj[k] !== undefined)
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

// ── 基本性质 ────────────────────────────────────────────────

test("条目带单调 seq、时间戳与哈希链", () => {
	const p = tempLog();
	const log = AuditLog.open(p);
	const a = log.append(base());
	const b = log.append(base());
	assert.equal(a.seq, 1);
	assert.equal(b.seq, 2);
	assert.equal(a.prevHash, "0".repeat(64));
	assert.equal(b.prevHash, a.hash);
	assert.match(a.at, /^\d{4}-\d{2}-\d{2}T/);
	assert.equal(a.schemaVersion, 1);
	log.close();
});

test("每条写入立即落盘", () => {
	const p = tempLog();
	const log = AuditLog.open(p);
	log.append(base());
	// 不 close 也应已在磁盘上，且是一条可解析的完整记录
	const written = lines(p);
	assert.equal(written.length, 1);
	assert.equal(JSON.parse(written[0]!).seq, 1);
	log.close();
});

test("调用方无法覆盖链字段：一个多余的 hash 字段曾能让整份日志永久处于已篡改状态", async () => {
	const p = tempLog();
	const log = AuditLog.open(p);
	const e = log.append({ ...base(), seq: 999, hash: "deadbeef", prevHash: "x" } as never);
	assert.equal(e.seq, 1);
	assert.notEqual(e.hash, "deadbeef");
	log.append(base());
	log.close();
	assert.equal((await AuditLog.verify(p)).ok, true);
});

test("重启后从最后一条续接 seq 与哈希链", () => {
	const p = tempLog();
	const first = AuditLog.open(p);
	first.append(base());
	const last = first.append(base());
	first.close();

	const second = AuditLog.open(p);
	assert.equal(second.lastSeq, 2);
	assert.equal(second.head, last.hash);
	const next = second.append(base());
	assert.equal(next.seq, 3);
	assert.equal(next.prevHash, last.hash);
	second.close();
});

test("超长字段被截断，不会让重启时的尾部读取失败", () => {
	const p = tempLog();
	const log = AuditLog.open(p);
	log.append({ ...base(), summary: "x".repeat(70_000), command: "y".repeat(70_000) });
	log.close();
	const reopened = AuditLog.open(p);
	assert.equal(reopened.lastSeq, 1);
	reopened.close();
});

// ── 哈希链能发现什么 ────────────────────────────────────────

test("完整链通过校验并给出链尾，供外部锚定", async () => {
	const p = tempLog();
	const log = AuditLog.open(p);
	for (let i = 0; i < 5; i++) log.append(base());
	const head = log.head;
	log.close();
	const v = await AuditLog.verify(p);
	assert.equal(v.ok, true);
	assert.equal(v.head, head);
	assert.equal(v.lastSeq, 5);
});

test("改动任意一条记录会被 verify 发现", async () => {
	const p = tempLog();
	const log = AuditLog.open(p);
	log.append(base());
	log.append({ ...base(), summary: "原始内容" });
	log.append(base());
	log.close();

	const ls = lines(p);
	const tampered = JSON.parse(ls[1]!);
	tampered.summary = "被篡改的内容";
	ls[1] = JSON.stringify(tampered);
	writeFileSync(p, `${ls.join("\n")}\n`);

	const v = await AuditLog.verify(p);
	assert.equal(v.ok, false);
	assert.equal(v.brokenAt, 2);
	assert.match(v.reason ?? "", /本条内容被改动/);
});

test("嵌套字段的改动同样进入哈希 —— canonical 序列化不得漏掉深层内容", async () => {
	const p = tempLog();
	const log = AuditLog.open(p);
	log.append(base());
	log.close();
	const entry = JSON.parse(lines(p)[0]!);
	// 直接在落盘记录上加一个嵌套字段，不重算 hash
	entry.meta = { secret: "sk-live-999" };
	writeFileSync(p, `${JSON.stringify(entry)}\n`);
	const v = await AuditLog.verify(p);
	assert.equal(v.ok, false, "顶层 key 白名单式的 canonical 会把嵌套字段剔出哈希输入");
});

test("删除中间一条会被 verify 发现", async () => {
	const p = tempLog();
	const log = AuditLog.open(p);
	for (let i = 0; i < 3; i++) log.append(base());
	log.close();

	const ls = lines(p);
	writeFileSync(p, `${[ls[0], ls[2]].join("\n")}\n`);

	const v = await AuditLog.verify(p);
	assert.equal(v.ok, false);
	assert.equal(v.brokenAt, 3);
	assert.match(v.reason ?? "", /序号不连续/);
});

test("损坏行让 verify 返回结构化结果而不是抛异常", async () => {
	const p = tempLog();
	const log = AuditLog.open(p);
	log.append(base());
	log.close();
	const ls = lines(p);
	writeFileSync(p, `${ls[0]}\n{坏行\n`);
	const v = await AuditLog.verify(p);
	assert.equal(v.ok, false);
	assert.equal(v.brokenAt, 2);
	assert.match(v.reason ?? "", /第 2 行无法解析/);
});

test("日志被整个删除与日志完好不能返回同一结果", async () => {
	const v = await AuditLog.verify(join(tmpdir(), `absent-${Date.now()}.jsonl`));
	assert.equal(v.ok, false);
	assert.match(v.reason ?? "", /不存在/);
});

// ── 哈希链发现不了什么（已知局限，必须留证据） ──────────────

test("已知局限：有写权限的攻击者能重算整链，无锚点时验不出来", async () => {
	const p = tempLog();
	const log = AuditLog.open(p);
	log.append({ ...base(), summary: "真实操作 rm -rf /" });
	log.append(base());
	log.close();

	forgeChain(p, (entries) => {
		(entries[0] as { summary: string }).summary = "无害操作";
	});

	// 这正是类注释第 3 条声明的局限：无锚点时 verify 只回答「文件自身是否自洽」
	assert.equal((await AuditLog.verify(p)).ok, true);
});

test("已知局限：尾部截断在无锚点时同样验不出来", async () => {
	const p = tempLog();
	const log = AuditLog.open(p);
	for (let i = 0; i < 5; i++) log.append(base());
	log.close();
	writeFileSync(p, `${lines(p).slice(0, 2).join("\n")}\n`);
	assert.equal((await AuditLog.verify(p)).ok, true);
});

test("给出外部锚点后，整链重写与尾部截断都能被发现", async () => {
	const p = tempLog();
	const log = AuditLog.open(p);
	for (let i = 0; i < 5; i++) log.append(base());
	const anchor = log.head;
	log.close();

	writeFileSync(p, `${lines(p).slice(0, 2).join("\n")}\n`);
	const truncated = await AuditLog.verify(p, anchor);
	assert.equal(truncated.ok, false);
	assert.match(truncated.reason ?? "", /整链被重写或尾部被截断/);
});

// ── 并发 ────────────────────────────────────────────────────

test("同一文件不允许两个写入者，否则哈希链会分叉", () => {
	const p = tempLog();
	const first = AuditLog.open(p);
	assert.throws(() => AuditLog.open(p), /已被 pid \d+ 持有/);
	first.close();
	// 释放后可正常接管
	const second = AuditLog.open(p);
	second.close();
});

test("持有者进程已死时可接管锁，不需要人工清理", () => {
	const p = tempLog();
	writeFileSync(`${p}.lock`, "2147483646");
	const log = AuditLog.open(p);
	assert.equal(log.append(base()).seq, 1);
	log.close();
});

// ── 内容边界 ────────────────────────────────────────────────

test("源码内容不落审计日志，只落 sha256", () => {
	const p = tempLog();
	const log = AuditLog.open(p);
	const secret = "const API_KEY = 'sk-live-123';";
	log.append({
		...base(),
		tool: "write",
		path: "src/config.ts",
		argsHash: contentHash({ path: "src/config.ts", content: secret }),
		diffHash: contentHash(secret),
		summary: "write: src/config.ts",
	});
	log.close();
	const raw = readFileSync(p, "utf8");
	assert.ok(!raw.includes("sk-live-123"), "审计日志会导出到 SIEM，源码原文不得出现");
	assert.ok(raw.includes(contentHash(secret)));
});

test("已知例外：command 存原文，导出 SIEM 前须视为敏感字段", () => {
	const p = tempLog();
	const log = AuditLog.open(p);
	log.append({ ...base(), tool: "bash", command: "echo 'sk-live-123' > .env" });
	log.close();
	// 这条断言记录的是当前的真实行为，不是期望的最终状态：
	// 脱敏在模型网关那一层统一做，本模块不做，注释里已声明。
	assert.ok(readFileSync(p, "utf8").includes("sk-live-123"));
});

test("contentHash 稳定、无类型碰撞、与 key 顺序无关", () => {
	assert.equal(contentHash("abc"), contentHash("abc"));
	assert.notEqual(contentHash("abc"), contentHash("abd"));
	// 字符串不得与同形的对象/字面量碰撞
	assert.notEqual(contentHash(null), contentHash("null"));
	assert.notEqual(contentHash(123), contentHash("123"));
	assert.notEqual(contentHash({ a: 1 }), contentHash('{"a":1}'));
	// key 顺序不同的同一组参数必须得到同一个 hash
	assert.equal(contentHash({ a: 1, b: 2 }), contentHash({ b: 2, a: 1 }));
	assert.equal(contentHash({ x: { p: 1, q: 2 } }), contentHash({ x: { q: 2, p: 1 } }));
});

// ── 回放 ────────────────────────────────────────────────────

test("回放可按会话过滤，工具调用与结果可按 callId 配对", async () => {
	const p = tempLog();
	const log = AuditLog.open(p);
	log.append({ ...base(), sessionId: "s1", callId: "c1", tool: "bash" });
	log.append({ ...base(), sessionId: "s2" });
	log.append({ kind: "tool.result", sessionId: "s1", actor: "a", summary: "done", callId: "c1", ok: true });
	log.close();

	assert.equal((await collect(p)).length, 3);
	const s1 = await collect(p, "s1");
	assert.equal(s1.length, 2);
	assert.equal(s1[0]?.callId, s1[1]?.callId);
});

test("回放不存在的日志返回空而不是抛错", async () => {
	assert.deepEqual(await collect(join(tmpdir(), `absent-${Date.now()}.jsonl`)), []);
});

test("空文件可正常打开", () => {
	const p = tempLog();
	writeFileSync(p, "");
	const log = AuditLog.open(p);
	assert.equal(log.lastSeq, 0);
	assert.equal(log.append(base()).seq, 1);
	log.close();
});

test("尾部半行时启动即失败，不静默续接", () => {
	const p = tempLog();
	const log = AuditLog.open(p);
	log.append(base());
	log.close();
	appendFileSync(p, '{"seq":2,"partial');
	assert.throws(() => AuditLog.open(p), /尾部损坏/);
});
