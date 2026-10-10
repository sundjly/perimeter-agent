import { initialState, reduce } from "./view-model.js";
import { labels } from "./labels.js";
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let state = initialState();
let ws;
let connected = false;
const expanded = new Set();
function node(tag, text, className = "") {
	const element = document.createElement(tag);
	element.textContent = text;
	element.className = className;
	return element;
}
function send(command) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(command)); }
function render(state) {
	$("conn-dot").className = `dot ${connected ? "on" : "off"}`;
	$("model").textContent = `${state.model ?? "—"} · ${state.participants.map((person) => `${person.actor} (${person.role}, ${person.clients})`).join(" · ")} · ${state.sessionId}`;
	$("usage").textContent = `token ${state.usage.total} · 缓存 ${state.usage.cacheHitRate == null ? "—" : (100 * state.usage.cacheHitRate).toFixed(1) + "%"}`;
	const stream = $("stream");
	const children = [];
	for (const message of state.messages) children.push({ order: message.order ?? 0, element: node("div", `${message.actor ?? (message.role === "user" ? "用户" : "助手")}\n${message.text}`, `msg ${message.role}`) });
	for (const tool of state.tools) {
		const card = node("details", "", `tool ${tool.ok === false ? "deny" : "info"}`);
		card.open = expanded.has(tool.callId);
		card.ontoggle = () => { if (card.open) expanded.add(tool.callId); else expanded.delete(tool.callId); };
		card.append(node("summary", `${tool.action.tool}: ${tool.action.command ?? tool.action.path ?? ""}`), node("pre", tool.output));
		children.push({ order: tool.order ?? Number.MAX_SAFE_INTEGER, element: card });
	}
	for (const approval of state.approvals) {
		const card = node("div", `${labels.pending} · ${approval.actor ?? "用户"}\n${approval.action.tool}: ${approval.action.command ?? approval.action.path ?? ""}\n${approval.reason}\n${Math.max(0, Math.ceil((approval.expiresAt - Date.now()) / 1000))} 秒 · 无人应答按拒绝处理`, "approval pending");
		if (state.role !== "viewer") for (const decision of ["allow", "deny"]) {
			const button = node("button", labels[decision]);
			button.disabled = Date.now() >= approval.expiresAt;
			button.onclick = () => send({ type: "approve", approvalId: approval.approvalId, decision });
			card.append(button);
		}
		children.push({ order: Number.MAX_SAFE_INTEGER, element: card });
	}
	for (const error of state.errors) children.push({ order: Number.MAX_SAFE_INTEGER, element: node("div", error, "deny") });
	stream.replaceChildren(...children.sort((a, b) => a.order - b.order).map((item) => item.element));
	$("audit").replaceChildren(...state.audit.map((entry) => node("div", `${entry.at} ${entry.kind} ${entry.summary}`, "audit-row")));
	$("audit-count").textContent = `${state.audit.length} 条`;
	$("send").textContent = state.streaming ? labels.queue : labels.send;
	$("send").disabled = $("input").disabled = state.role === "viewer" || !connected;
	$("steer").hidden = !state.streaming || state.role === "viewer";
	$("abort").hidden = !state.streaming || state.role === "viewer";
}
function connect() {
	const query = new URLSearchParams(params);
	if (state.sessionId) query.set("session", state.sessionId);
	ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/?${query}`);
	ws.onopen = () => { connected = true; render(state); };
	ws.onmessage = ({ data }) => { const frame = JSON.parse(data); if (frame.event) { state = reduce(state, frame.event); render(state); } };
	ws.onclose = () => { connected = false; render(state); setTimeout(connect, 1000); };
	ws.onerror = () => ws.close();
}
function prompt(type) { const text = $("input").value.trim(); if (!text) return; send({ type, text, requestId: crypto.randomUUID() }); $("input").value = ""; }
$("composer").onsubmit = (event) => { event.preventDefault(); prompt("prompt"); };
$("steer").onclick = () => prompt("steer");
$("abort").onclick = () => send({ type: "abort" });
setInterval(() => { if (state.approvals.length) render(state); }, 1000);
connect();
