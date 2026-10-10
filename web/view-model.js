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
		case "inbox.update": next.inbox = event.items; break;
		case "session.presence": next.participants = event.participants; if (event.role) next.role = event.role; break;
		case "session.ready": next.sessionId = event.sessionId; next.model = event.model; break;
		case "session.state": next.streaming = event.streaming; next.model = event.model; break;
		case "agent.start": next.streaming = true; break;
		case "agent.end": next.streaming = event.willRetry; break;
		case "agent.settled": next.streaming = false; next.phase = ""; break;
		case "agent.status": next.phase = event.detail; break;
		case "message.start": {
			next.messages = next.messages.filter((item) => item.id !== event.messageId);
			next.messages.push({ id: event.messageId, order: event.order, role: event.role,
				...(event.actor !== undefined ? { actor: event.actor } : {}), text: "", thinking: "" });
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
			if (tool) tool.action = event.action;
			else next.tools.push({ callId: event.callId, order: Number.MAX_SAFE_INTEGER, action: event.action, output: "" });
			break;
		}
		case "tool.progress": { const tool = next.tools.find((item) => item.callId === event.callId); if (tool) tool.output = event.output; break; }
		case "tool.end": {
			let tool = next.tools.find((item) => item.callId === event.callId);
			if (!tool && event.action) { tool = { callId: event.callId, action: event.action, output: "" }; next.tools.push(tool); }
			if (tool) {
				tool.output = event.output; tool.ok = event.ok;
				if (event.action) tool.action = event.action;
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
		case "error": next.errors = [...state.errors, event.message].slice(-100); break;
	}
	return next;
}
