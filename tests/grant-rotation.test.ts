// grant 轮换事务纯 unit（R55-A 同缝；resource-free：零 timer/FS/net/child）。
// 直验证：signGrant+verifyGrant 配合 plan/apply/rollback/retireUndeliveredNew——
// 成功=new 可验且未 revoked+旧全拒；save/writer 失败=new 不可用+原 revoked 不复活。
// 本文件为源码交付，未运行（R55 执行禁令；由 coor 新轮预审实际脚本后执行）。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { signGrant, verifyGrant } from "../src/gitproxy/grants.ts";
import { applyRotation, planRotation, retireUndeliveredNew, rollbackRotation, type RotationEntry } from "../src/gateway/grant-rotation.ts";

const MASTER = randomBytes(32);
const NOW = 1_700_000_000_000;
let seq = 0;
const claimsOf = (jti: string): Parameters<typeof signGrant>[0] => ({
	v: 1, tenant: "t1", principal: "p1", session: "s1", repo: "git.internal/app.git",
	caps: { read: true, write: false, writeRefs: [] },
	exp: NOW + 60_000, jti, epoch: "epoch-1", aclVersion: 1,
});
const entryOf = (...jtis: string[]): RotationEntry => ({ jtis: new Set(jtis) });

test("rotation：成功路径 —— new 可验且未 revoked，旧全退役，previous 不含 new", () => {
	const entry = entryOf("old-1", "old-2");
	const revoked = new Set<string>();
	const newJti = "new-A";
	const plan = planRotation(entry.jtis, (j) => revoked.has(j), newJti);
	assert.deepEqual(plan.previous.sort(), ["old-1", "old-2"], "previous 在纯 mint 前捕获，绝不含 new");
	assert.deepEqual(plan.newlyRevoked, ["old-1", "old-2"]);
	const token = signGrant(claimsOf(newJti), MASTER, NOW); // 纯 mint 产出（无登记无 save）
	applyRotation(entry, revoked, plan);
	assert.deepEqual([...entry.jtis], ["new-A"]);
	assert.ok(revoked.has("old-1") && revoked.has("old-2"));
	assert.equal(revoked.has(newJti), false, "new 不进 revoked");
	const v = verifyGrant(token, MASTER, NOW + 1);
	assert.ok(v.ok, "new token 可验");
	if (v.ok) assert.equal(v.claims.jti, newJti);
	// 旧 token 全拒（模拟 proxy revoked 判定）
	for (const old of ["old-1", "old-2"]) assert.ok(revoked.has(old));
});

test("rotation：save 失败回滚 —— entry 恢复旧集、本次新增 revocation 还原、原已 revoked 不复活", () => {
	const entry = entryOf("old-1", "already-revoked");
	const revoked = new Set<string>(["already-revoked"]); // 原本已 revoked（不得复活）
	const plan = planRotation(entry.jtis, (j) => revoked.has(j), "new-B");
	assert.deepEqual(plan.newlyRevoked, ["old-1"], "已 revoked 的不进本次新增");
	applyRotation(entry, revoked, plan);
	// save 失败：
	rollbackRotation(entry, revoked, plan);
	assert.deepEqual([...entry.jtis].sort(), ["already-revoked", "old-1"].sort(), "entry 恢复旧集");
	assert.equal(revoked.has("old-1"), false, "本次新增还原");
	assert.equal(revoked.has("already-revoked"), true, "原已 revoked 不复活");
	assert.equal(revoked.has("new-B"), false, "mint 阶段失败：new 尚未 retired 也未登记");
});

test("rotation：writer 失败（已 apply+save）—— new 不可用（retire）+ 回滚后原 revoked 不复活", () => {
	const entry = entryOf("old-1");
	const revoked = new Set<string>();
	const plan = planRotation(entry.jtis, (j) => revoked.has(j), "new-C");
	applyRotation(entry, revoked, plan);
	// writer 抛错（投递失败）：
	retireUndeliveredNew(revoked, plan); // new 不可用
	rollbackRotation(entry, revoked, plan); // 旧集恢复
	assert.equal(revoked.has("new-C"), true, "未投递 new 必须退役（不留可用未投递 token）");
	assert.deepEqual([...entry.jtis], ["old-1"], "旧集回滚");
	assert.equal(revoked.has("old-1"), false, "旧 jti 还原（原非 revoked）");
});

test("rotation：连发两轮 —— 第二轮 previous=第一轮结果，first jti 保持 retired 不复活", () => {
	const entry = entryOf("old-1");
	const revoked = new Set<string>();
	const p1 = planRotation(entry.jtis, (j) => revoked.has(j), "n1");
	applyRotation(entry, revoked, p1);
	const p2 = planRotation(entry.jtis, (j) => revoked.has(j), "n2");
	assert.deepEqual(p2.previous, ["n1"]);
	assert.deepEqual(p2.newlyRevoked, ["n1"]);
	applyRotation(entry, revoked, p2);
	assert.deepEqual([...entry.jtis], ["n2"]);
	assert.ok(revoked.has("old-1") && revoked.has("n1"), "历史 jti 保持 retired");
});
