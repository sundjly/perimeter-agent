// 初签 existing entry 的 captured cap/currentExp 提交语义纯 unit（R59-④ 同缝，F4 修正后）。
// 本次已验 signed.cap 为权威（fresh 更短跟着变短）；不同 owner 抛固定类别拒签（entry 不变）。
// 本文件为源码交付，未运行（R59 执行禁令；由 coor 新轮预审实际脚本后执行）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeIssueIntoEntry } from "../src/gateway/grant-rotation.ts";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function entry(principal: string, maxExpAt: number | null): { jtis: Set<string>; principal: string; maxExpAt: number | null; currentExpAt: number | null } {
	return { jtis: new Set(["old"]), principal, maxExpAt, currentExpAt: null };
}

test("issue-merge：同 owner 旧 cap 已过期 → 新验 cap 覆盖（不保留已过期旧 cap）", () => {
	const e = entry("p1", NOW - 2 * MIN);
	mergeIssueIntoEntry(e, "p1", { jti: "new", cap: NOW + 8 * 60 * 60_000, exp: NOW + 60_000 });
	assert.equal(e.maxExpAt, NOW + 8 * 60 * 60_000);
	assert.equal(e.currentExpAt, NOW + 60_000);
});

test("issue-merge：同 owner fresh verified 更短 → 权威跟随变短（不越当前身份有效期）", () => {
	const e = entry("p1", NOW + 8 * 60 * 60_000); // 旧 8h（遗留长 cap）
	mergeIssueIntoEntry(e, "p1", { jti: "new", cap: NOW + 60_000, exp: NOW + 60_000 }); // 本次已验仅 1h
	assert.equal(e.maxExpAt, NOW + 60_000, "F4：本次已验 cap 为权威，不保留旧更长 cap");
	assert.equal(e.currentExpAt, NOW + 60_000);
});

test("issue-merge：同 owner 旧 cap null → 用本次已验 cap（null 不当无限）", () => {
	const e = entry("p1", null);
	mergeIssueIntoEntry(e, "p1", { jti: "new", cap: NOW + 60_000, exp: NOW + 60_000 });
	assert.equal(e.maxExpAt, NOW + 60_000);
});

test("issue-merge：可信无到期 identity（signed.cap=null）按原契约 → maxExpAt=null（15min 锁在 TTL 面）", () => {
	const e = entry("p1", NOW + 60_000);
	mergeIssueIntoEntry(e, "p1", { jti: "new", cap: null, exp: NOW + 60_000 });
	assert.equal(e.maxExpAt, null, "可信无到期沿原认证契约（非猜 IdP expiry）");
	assert.equal(e.currentExpAt, NOW + 60_000);
});

test("issue-merge：不同 owner（collaborator 命中同 sessionId）→ 抛固定类别拒签（entry 不变）", () => {
	const e = entry("p1", NOW + 60_000);
	assert.throws(
		() => mergeIssueIntoEntry(e, "p2-collaborator", { jti: "new", cap: NOW + 8 * 60 * 60_000, exp: NOW + 60_000 }),
		/固定类别/,
		"不同 owner 必须拒签（不 add jti、不改 entry、不借 expiry）",
	);
	assert.equal(e.maxExpAt, NOW + 60_000, "entry 字段未被修改");
	assert.deepEqual([...e.jtis], ["old"], "jtis 未被修改");
	assert.equal(e.currentExpAt, null, "currentExpAt 未被修改");
});
