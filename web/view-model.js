/** 自有协议的纯 reducer，两端共用。 */
export function initialState() {
	return { sessionId: "", model: null, streaming: false, messages: [], tools: [], inbox: [], approvals: [], participants: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, cacheHitRate: null }, audit: [], role: "viewer", errors: [], phase: "", history: null, toolsHistory: null };
}
/** S5b：增量工具事件携带的截断标记同步到工具卡上。事件不带标记时清除残留 ——
 * 大输出的 progress（已截断）之后跟小输出的 end，不得留下过期标记。删除键而非置
 * undefined，保证深度相等断言与 JSON 序列化都不出现幽灵字段 */
function applyToolClip(tool, event) {
	if (event.truncated === undefined) { delete tool.truncated; delete tool.originalBytes; }
	else { tool.truncated = event.truncated; tool.originalBytes = event.originalBytes; }
}
/** @param {import("./view-model.js").ViewState} state @param {import("../src/protocol/types.ts").ClientEvent} event */
export function reduce(state, event) {
	const next = { ...state, messages: state.messages.map((item) => ({ ...item })), tools: state.tools.map((item) => ({ ...item })) };
	switch (event.type) {
		case "session.snapshot": return { ...next, ...event.view };
		case "inbox.update": next.inbox = event.items; break;
		case "session.presence": next.participants = event.participants; if (event.role) next.role = event.role; break;
		case "session.ready": next.sessionId = event.sessionId; next.model = event.model; break;
		case "session.state": next.streaming = event.streaming; next.model = event.model; break;
		case "agent.start": next.streaming = true; break;
		case "agent.end": next.streaming = event.willRetry; break;
		case "agent.settled": next.streaming = false; next.phase = ""; break;
		case "agent.status": next.phase = event.detail; break;
		case "message.start": {
			// S5a：服务端权威历史在增长时，客户端持有的 total 同步 +1（替换同 id 不算新增），
			// 否则尾页元信息在下一次快照/分页前是陈旧的
			const isNew = !next.messages.some((item) => item.id === event.messageId);
			next.messages = next.messages.filter((item) => item.id !== event.messageId);
			next.messages.push({ id: event.messageId, order: event.order, role: event.role,
				...(event.actor !== undefined ? { actor: event.actor } : {}), text: "", thinking: "" });
			if (next.history && isNew) next.history = { ...next.history, total: next.history.total + 1 };
			break;
		}
		case "message.text": { const message = next.messages.find((item) => item.id === event.messageId); if (message) message.text += event.delta; break; }
		case "message.thinking": { const message = next.messages.find((item) => item.id === event.messageId); if (message) message.thinking += event.delta; break; }
		case "message.end": { const message = next.messages.find((item) => item.id === event.messageId); if (message) {
				message.text = event.text;
				if (event.thinking !== undefined) message.thinking = event.thinking;
				if (event.entryId !== undefined) {
					next.messages = next.messages.filter((item) => item === message || item.id !== event.entryId);
					message.id = event.entryId;
				}
				if (event.order !== undefined) { message.order = event.order; next.messages.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)); }
			} break; }
		case "tool.start": {
			const tool = next.tools.find((item) => item.callId === event.callId);
			if (tool) { tool.action = event.action; applyToolClip(tool, event); }
			else {
				next.tools.push({ callId: event.callId, order: Number.MAX_SAFE_INTEGER, action: event.action, output: "" });
				// S5b：新工具进入视图时同步 tools 元信息（与 message.start 同步 history.total 同一
				// 语义：替换同 callId 不计新增），否则客户端持有的 total 在下一次快照前是陈旧的
				if (next.toolsHistory) next.toolsHistory = { ...next.toolsHistory, total: next.toolsHistory.total + 1 };
			}
			break;
		}
		case "tool.progress": { const tool = next.tools.find((item) => item.callId === event.callId); if (tool) { tool.output = event.output; applyToolClip(tool, event); } break; }
		case "tool.end": {
			let tool = next.tools.find((item) => item.callId === event.callId);
			if (!tool && event.action) {
				tool = { callId: event.callId, action: event.action, output: "" };
				next.tools.push(tool);
				// 错过 tool.start 时（同上）：新建工具卡也算新增
				if (next.toolsHistory) next.toolsHistory = { ...next.toolsHistory, total: next.toolsHistory.total + 1 };
			}
			if (tool) {
				tool.output = event.output; tool.ok = event.ok;
				if (event.action) tool.action = event.action;
				applyToolClip(tool, event);
				if (event.order !== undefined) { tool.order = event.order; next.tools.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)); }
			}
			break;
		}
		case "approval.request": {
			const { type, ...approval } = event;
			next.approvals = [...state.approvals.filter((item) => item.approvalId !== event.approvalId), approval];
			break;
		}
		case "approval.resolved": next.approvals = state.approvals.filter((item) => item.approvalId !== event.approvalId); break;
		case "policy.denied": { const tool = next.tools.find((item) => item.callId === event.callId); if (tool) { tool.ok = false; tool.output = `策略拒绝（${event.rule}）：${event.reason}`; } break; }
		case "audit.entry": next.audit = [...state.audit, event.entry].slice(-100); break;
		case "usage": next.usage = event.usage; break;
		case "history.page": {
			// S5a：更早的历史向前 prepend，按 id 去重（重试/重连可能拿到重叠页，同一页内的
			// 重复项同样只保留首次出现）；历史元信息以服务端应答为准，cursor 为空表示已到最早
			const known = new Set(next.messages.map((item) => item.id));
			const older = [];
			for (const item of event.items) {
				if (known.has(item.id)) continue;
				known.add(item.id);
				older.push(item);
			}
			next.messages = [...older, ...next.messages];
			next.history = { total: event.total, oldestIncluded: event.oldestIncluded, cursor: event.cursor };
			break;
		}
		case "tools.page": {
			// S5c：更早的工具向前 prepend，按 callId 去重（含页内重复，与 history.page 同一语义）；
			// 元信息以服务端应答为准，cursor 为空表示已到最早
			const knownCalls = new Set(next.tools.map((item) => item.callId));
			const olderTools = [];
			for (const item of event.items) {
				if (knownCalls.has(item.callId)) continue;
				knownCalls.add(item.callId);
				olderTools.push(item);
			}
			next.tools = [...olderTools, ...next.tools];
			next.toolsHistory = { total: event.total, oldestIncluded: event.oldestIncluded, cursor: event.cursor };
			break;
		}
		case "error": next.errors = [...state.errors, event.message].slice(-100); break;
	}
	return next;
}
