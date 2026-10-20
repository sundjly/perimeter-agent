// grant 轮换事务纯缝（R55-A 同缝）：Gateway 初签/续签共用。mint 只产出 token（纯 sign，
// 零登记零 save）；本模块负责 jtis/revoked 的登记事务语义：
//   成功 = new 有效 + 旧全退役 + persist 先于投递；
//   mint/save/writer 任一失败 = new 不可用（active 不含 new / revoked 含 new）、不投递、
//   原有 revoked 不复活（rollback 只还原本次新增的 revocation）。
// 生产 #issueGitGrant / #renewGitGrant 与 resourcefree unit 消费同一实现。

export interface RotationEntry {
	jtis: Set<string>;
}

export interface RotationPlan {
	/** mint 前的旧 jti 集合快照（mint 纯化后捕获，绝不含 newJti） */
	previous: string[];
	/** 本次轮换将**新增**的 revocation（previous 中原本未 revoked 者；rollback 只还原这些） */
	newlyRevoked: string[];
	newJti: string;
}

/** mint 前捕获旧集：previous 绝不含 newJti（A 的时序缺陷根除） */
export function planRotation(currentJtis: Iterable<string>, revokedHas: (jti: string) => boolean, newJti: string): RotationPlan {
	const previous = [...currentJtis];
	const newlyRevoked = previous.filter((j) => !revokedHas(j));
	return { previous, newlyRevoked, newJti };
}

/** 成功提交：entry.jtis 只剩 newJti；previous 中本次新增者全部进 revoked */
export function applyRotation(entry: RotationEntry, revoked: Set<string>, plan: RotationPlan): void {
	entry.jtis.clear();
	entry.jtis.add(plan.newJti);
	for (const j of plan.newlyRevoked) revoked.add(j);
}

/** 失败回滚：entry 恢复 previous；只撤销本次新增的 revocation（原已 revoked 不动） */
export function rollbackRotation(entry: RotationEntry, revoked: Set<string>, plan: RotationPlan): void {
	entry.jtis.clear();
	for (const j of plan.previous) entry.jtis.add(j);
	for (const j of plan.newlyRevoked) revoked.delete(j);
}

/**
 * 初签/续签的失败兜底：new 不可用（进 revoked——即使它当前在 entry 中也判拒）。
 * writer 失败（已 apply+save 后）调用：撤销 new jti 本身。
 */
export function retireUndeliveredNew(revoked: Set<string>, plan: RotationPlan): void {
	revoked.add(plan.newJti);
}

/**
 * R59-④（F4 修正）：初签命中 existing entry 的 captured cap/currentExp 提交语义。
 * 同 owner（principal 字串精确匹配）：本次已验 signed.cap 为**权威**（fresh verified
 * identity 更短则跟着变短，不保留旧更长 cap 越过当前身份有效期；可信无到期 null 按原
 * 认证契约）；currentExpAt 恒等于本次新 token 的 exp。不同 owner（collaborator 命中同
 * sessionId）→ 抛固定类别错误（调用方在 save 前拒签：不 add jti、不改 entry、collaborator
 * 不借 expiry）。
 */
export function mergeIssueIntoEntry(
	entry: RotationEntry & { principal: string; maxExpAt?: number | null; currentExpAt?: number | null },
	principal: string,
	signed: { jti: string; cap: number | null; exp: number },
): void {
	if (entry.principal !== principal) {
		throw new Error("git grant 签发 principal 与 entry owner 不一致（固定类别；collaborator 不借 expiry）");
	}
	// cap 已过期的语义由 computeGrantExpiry（sign 前）拒；此处 signed.cap 为本次已验权威。
	entry.maxExpAt = signed.cap;
	entry.currentExpAt = signed.exp;
}
