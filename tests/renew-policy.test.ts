// renew 决策 + browser-sid 映射纯 unit（R-Q52-3/2 同缝；resource-free：零 timer/FS/net/child）。
// 消费真实生产模块 renew-policy.ts / grant-session-mapping.ts（非测试副本）。
// 本文件为源码交付，未运行（R53 执行禁令；由 coor 新轮预审实际脚本后执行）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeGrantExpiry, computeNextRenewDelayMs, decideRenew, renewMargin } from "../src/gateway/renew-policy.ts";
import { linkBrowserSid, takeSessionsForBrowserSid, peekSessionsForBrowserSid } from "../src/gateway/grant-session-mapping.ts";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

test("renew-policy：在线正常 → mint（cap 透传，mint 侧沿用 captured 上限）", () => {
	const d = decideRenew({ maxExpAt: NOW + 10 * MIN }, NOW, true, false);
	assert.deepEqual(d, { action: "mint", capMs: NOW + 10 * MIN });
});

test("renew-policy：离线/无 conn —— maxExpAt 仍在 → 仍 mint 但 cap 沿用（不延成 now+15min）", () => {
	// 会话活但 captured cap 远小于 15min：决策仍 mint；mint 侧 exp=min(now+15min, cap)。
	const d = decideRenew({ maxExpAt: NOW + 2 * MIN }, NOW, true, false);
	assert.equal(d.action, "mint");
	if (d.action === "mint") assert.equal(d.capMs, NOW + 2 * MIN, "cap 沿用 captured，不被 now+15min 覆盖");
});

test("renew-policy：captured expiry 已到 → revoke-and-skip（撤旧不续）", () => {
	const d = decideRenew({ maxExpAt: NOW - 1 }, NOW, true, false);
	assert.equal(d.action, "revoke-and-skip");
});

test("renew-policy：近到期（剩余 ≤ margin）→ skip（自然失效，不在边界失败）", () => {
	const cap = NOW + 6_000; // < min(60s, max(5s, 1.5s))=5s? → 6s 剩余 > margin 5s → mint；用更小剩余
	const d1 = decideRenew({ maxExpAt: NOW + 4_000 }, NOW, true, false);
	assert.equal(d1.action, "skip", "剩余 4s ≤ margin 5s → skip");
	void cap;
});

test("renew-policy：margin 公式（min(60s, max(5s, 剩余/4))）边界", () => {
	assert.equal(renewMargin(NOW + 100 * MIN, NOW), 60_000, "剩余很长 → 上限 60s");
	assert.equal(renewMargin(NOW + 1_000, NOW), 5_000, "剩余很短 → 下限 5s");
	assert.equal(renewMargin(NOW + 40_000, NOW), 10_000, "剩余/4 中值");
});

test("renew-policy：session gone / principal revoked → skip（late/撤销不复活）", () => {
	assert.equal(decideRenew({}, NOW, false, false).action, "skip");
	assert.equal(decideRenew({}, NOW, true, true).action, "skip");
	assert.equal(decideRenew({}, NOW, false, true).action, "skip");
});

test("renew-policy：unknown/null captured → fail-closed 不续（R57-4：直到同 owner fresh reauth）", () => {
	// 重启恢复缺失/旧数据 null cap 不得反复 now+15min 当无限链；#renewGitGrant 开头的
	// fresh 更新命中后才可能转正（生产侧先更 entry.maxExpAt 再 decideRenew）。
	assert.equal(decideRenew({}, NOW, true, false).action, "skip");
	assert.deepEqual(decideRenew({}, NOW, true, false), { action: "skip", reason: "unknown captured cap（fail-closed until fresh reauth）" });
});

test("mapping：两 UUID 空间关联——logout 撤关联 session、无关 session 保留（R-Q52-2）", () => {
	const map = new Map<string, Set<string>>();
	// cookie sid（BrowserSessions UUID 空间）与 agent sessionId（另一 UUID 空间）不同源
	const cookieSid = "browser-uuid-aaaa";
	const agentSession1 = "agent-session-1111";
	const agentSession2 = "agent-session-2222"; // 同一 browser 会话重连产生的第二个 agent session
	const unrelated = "agent-session-9999";
	linkBrowserSid(map, cookieSid, agentSession1);
	linkBrowserSid(map, cookieSid, agentSession2);
	linkBrowserSid(map, "browser-uuid-bbbb", unrelated);
	assert.deepEqual(peekSessionsForBrowserSid(map, cookieSid).sort(), [agentSession1, agentSession2].sort());
	const revoked = takeSessionsForBrowserSid(map, cookieSid);
	assert.equal(revoked.length, 2, "logout 撤该 browser 会话全部关联 entry");
	assert.deepEqual(peekSessionsForBrowserSid(map, "browser-uuid-bbbb"), [unrelated], "无关会话不受影响");
	assert.deepEqual(takeSessionsForBrowserSid(map, cookieSid), [], "一次性取走后映射清空");
	// 过期/破损 cookie（未登记的 sid）不命中任何映射
	assert.deepEqual(takeSessionsForBrowserSid(map, "forged-cookie"), []);
});

test("初签 cap：identity 只剩 2min → exp=min(+15min,cap)=+2min；断线超 cap 拒；fresh reauth 允许（R55-B）", () => {
	// 初签 identity.expiresAt=now+2min：exp 被钻到 +2min（不越 IdP expiry）
	assert.equal(computeGrantExpiry(NOW, NOW + 2 * MIN), NOW + 2 * MIN);
	// 断线后（无 fresh）captured cap 已过：签发/续签拒
	assert.throws(() => computeGrantExpiry(NOW + 3 * MIN, NOW + 2 * MIN), /有效期已到/);
	// fresh reauth（可信同 principal 新 expiry 更晚）→ 续命合法
	assert.equal(computeGrantExpiry(NOW, NOW + 30 * MIN), NOW + 15 * MIN, "cap 远时 15min 锁生钱");
	// unknown/null cap：不解释为无限，只受 15min 锁（不自造 IdP expiry）
	assert.equal(computeGrantExpiry(NOW, null), NOW + 15 * MIN);
});

test("computeNextRenewDelayMs：最早可工作时点提前调度 + 不 spin（R55-F）", () => {
	// 无 entry → 上限轮询
	assert.equal(computeNextRenewDelayMs([], NOW, 450_000), 450_000);
	// entry exp=now+10min，margin=60s → 9min 后 fire（< 上限 7.5min? 9min>7.5min → max）
	assert.equal(computeNextRenewDelayMs([{ currentExpAt: NOW + 10 * MIN }], NOW, 450_000), 450_000, "最早点晚于轮询上限 → 取上限");
	// entry exp=now+3min：due-margin=3min-45s → 2min15s 后 fire（提前于 7.5min 轮询）
	assert.equal(computeNextRenewDelayMs([{ currentExpAt: NOW + 3 * MIN }], NOW, 450_000), 3 * MIN - 45_000);
	// 近到期（剩余<margin）：排 cap 到点一次 revoke（不 250ms spin）
	assert.equal(computeNextRenewDelayMs([{ currentExpAt: NOW + 4_000 }], NOW, 450_000), 4_000, "cap 到点驱动一次 revoke-and-skip");
	// 已过期：立即（min 250ms 下限）
	assert.equal(computeNextRenewDelayMs([{ currentExpAt: NOW - 1 }], NOW, 450_000), 250);
});
