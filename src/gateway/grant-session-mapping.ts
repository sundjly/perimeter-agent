// browser sid ↔ agent session 映射（R-Q52-2 同缝纯 helper）：logout 的 cookie sid 与
// agent sessionId 是两个 UUID 空间——签发/可信连接登记时按**服务端验证得到的** sid 关联，
// logout 据此撤全部关联 entry，不误撤无关会话、不读 client 自报头。生产 Gateway 与纯
// unit 消费同一实现。

/** 关联：一个 browser sid 可关联多个 agent session（同凭证多窗口/重连） */
export function linkBrowserSid(map: Map<string, Set<string>>, browserSid: string, sessionId: string): void {
	if (!browserSid || !sessionId) return;
	let set = map.get(browserSid);
	if (!set) {
		set = new Set<string>();
		map.set(browserSid, set);
	}
	set.add(sessionId);
}

/**
 * 取走并清除该 browser sid 的全部关联 agent sessionId（logout 语义：一次性撤全部；
 * 返回数组供逐个 revokeGitGrantSession）。无关会话不受影响（其它 key 原样保留）。
 */
export function takeSessionsForBrowserSid(map: Map<string, Set<string>>, browserSid: string): string[] {
	const set = map.get(browserSid);
	if (!set) return [];
	map.delete(browserSid);
	return [...set];
}

/** 只读查看（诊断/审计用），不改变映射 */
export function peekSessionsForBrowserSid(map: Map<string, Set<string>>, browserSid: string): string[] {
	return [...(map.get(browserSid) ?? [])];
}
