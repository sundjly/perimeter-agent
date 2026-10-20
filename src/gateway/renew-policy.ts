// renew 决策纯函数（R-Q52-3 同缝）：Gateway.#renewGitGrant 开头调用，纯 unit 直测同一
// 实现。语义：会话死/principal 吊销 → skip；captured 有效期已到 → revoke-and-skip（撤旧，
// 不 phantom 永续）；临近到期（剩余 ≤ margin）→ skip（自然失效，不在边界上失败）；
// 其余 → mint（离线沿用 captured 上限由 mint 侧保证：mint 用 cap=min(15min, maxExpAt)）。

export interface RenewEntryShape {
	maxExpAt?: number | null;
}

export type RenewDecision =
	| { action: "mint"; capMs: number | null }
	| { action: "skip"; reason: string }
	| { action: "revoke-and-skip"; reason: string };

/** 提前 margin：min(60s, max(5s, 剩余/4))——不把续签排在边界上失败 */
export function renewMargin(capMs: number, nowMs: number): number {
	return Math.min(60_000, Math.max(5_000, Math.floor((capMs - nowMs) / 4)));
}

export function decideRenew(entry: RenewEntryShape, nowMs: number, sessionAlive: boolean, principalRevoked: boolean): RenewDecision {
	if (!sessionAlive) return { action: "skip", reason: "session gone" };
	if (principalRevoked) return { action: "skip", reason: "principal revoked" };
	const cap = entry.maxExpAt ?? null;
	// R57-4：未知/null captured cap（重启恢复缺失等）≠ 可信无到期 identity——fail-closed
	// 不续，直到同 owner fresh verified reauth（#renewGitGrant 开头已先做 fresh 更新）。
	if (cap === null) return { action: "skip", reason: "unknown captured cap（fail-closed until fresh reauth）" };
	if (cap <= nowMs) return { action: "revoke-and-skip", reason: "captured expiry reached" };
	if (cap - nowMs <= renewMargin(cap, nowMs)) return { action: "skip", reason: "near expiry" };
	return { action: "mint", capMs: cap };
}

/**
 * R55-F 提前调度：返回距下一次 renew fire 的 ms（≥minIntervalMs，避免 zeroTimer 忙循环）。
 * 取「当前活 entry 的最早可工作时点」：due = exp/currentExp − margin（近到期项的 cap 到点
 * 也驱动一次 revoke-and-skip，之后项被删除不再 spin）；无条目/超过 maxIntervalMs → 上限。
 * currentExp 缺失的条目不驱动提前 fire（由 maxInterval 轮询兼容）。
 */
export function computeNextRenewDelayMs(
	entries: { currentExpAt?: number | null; maxExpAt?: number | null }[],
	nowMs: number,
	maxIntervalMs: number,
	minIntervalMs = 250,
): number {
	let best = maxIntervalMs;
	for (const e of entries) {
		const due = e.currentExpAt ?? e.maxExpAt ?? null;
		if (due === null || due === undefined) continue;
		const margin = renewMargin(due, nowMs);
		let fireAt = due - margin;
		if (fireAt <= nowMs) fireAt = due; // 已在 margin 内/过窗：排到 cap 到点（revoke-and-skip 一次，不 spin）
		const delay = Math.max(minIntervalMs, fireAt - nowMs);
		if (delay < best) best = delay;
	}
	return best;
}

/**
 * R55-B 初签/续签 exp 计算（同缝纯函数）：exp = min(now+15min, cap)；cap 已到/已过即拒
 *（unknown/null 历史 cap 不解释为无限——只受 15min 锁；受信任无到期 identity 按认证原契约
 * 不自造 IdP expiry）。
 */
export function computeGrantExpiry(nowMs: number, capMs: number | null, ttlMs = 15 * 60_000): number {
	if (capMs !== null && capMs <= nowMs) throw new Error("principal 身份有效期已到，不能签发/续签 grant");
	return capMs !== null ? Math.min(nowMs + ttlMs, capMs) : nowMs + ttlMs;
}
