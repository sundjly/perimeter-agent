/** 自有协议的纯 reducer，两端共用。 */
export function initialState() {
	return { sessionId: "", model: null, streaming: false, messages: [], tools: [], inbox: [], approvals: [], participants: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, cacheHitRate: null }, audit: [], role: "viewer", errors: [], phase: "" };
}
/** @param {import("./view-model.js").ViewState} state @param {import("../src/protocol/types.ts").ClientEvent} event */
export function reduce(state, event) {
	const next = { ...state, messages: state.messages.map((item) => ({ ...item })), tools: state.tools.map((item) => ({ ...item })) };
	switch (event.type) {
		case "session.snapshot": return { ...next, ...event.view };
		case "session.presence": next.participants = event.participants; if (event.role) next.role = event.role; break;
		case "session.ready": next.sessionId = event.sessionId; next.model = event.model; break;
		case "session.state": next.streaming = event.streaming; next.model = event.model; break;
		case "agent.start": next.streaming = true; break;
		case "agent.end": next.streaming = event.willRetry; break;
		case "agent.settled": next.streaming = false; next.phase = ""; break;
		case "agent.status": next.phase = event.detail; break;
		case "message.start": next.messages.push({ id: event.messageId, role: event.role, actor: event.actor, text: "", thinking: "" }); break;
		case "message.text": { const message = next.messages.find((item) => item.id === event.messageId); if (message) message.text += event.delta; break; }
		case "message.thinking": { const message = next.messages.find((item) => item.id === event.messageId); if (message) message.thinking += event.delta; break; }
		case "message.end": { const message = next.messages.find((item) => item.id === event.messageId); if (message) message.text = event.text; break; }
		case "tool.start": next.tools.push({ callId: event.callId, action: event.action, output: "" }); break;
		case "tool.progress": { const tool = next.tools.find((item) => item.callId === event.callId); if (tool) tool.output = event.output; break; }
		case "tool.end": { const tool = next.tools.find((item) => item.callId === event.callId); if (tool) { tool.output = event.output; tool.ok = event.ok; } break; }
		case "approval.request": next.approvals = [...state.approvals.filter((item) => item.approvalId !== event.approvalId), event]; break;
		case "approval.resolved": next.approvals = state.approvals.filter((item) => item.approvalId !== event.approvalId); break;
		case "policy.denied": { const tool = next.tools.find((item) => item.callId === event.callId); if (tool) { tool.ok = false; tool.output = `策略拒绝（${event.rule}）：${event.reason}`; } break; }
		case "audit.entry": next.audit = [...state.audit, event.entry].slice(-100); break;
		case "usage": next.usage = event.usage; break;
		case "error": next.errors = [...state.errors, event.message].slice(-100); break;
	}
	return next;
}
