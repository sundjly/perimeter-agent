import { initialState, reduce } from "./view-model.js";
import { labels } from "./labels.js";
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
params.delete("bearer");
params.delete("token");
params.delete("actor");
let state = initialState();
let ws;
let connected = false;
const expanded = new Set();
let loadingOlder = false;
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
	// S5a：还有更早的历史时置顶「加载更早」（textContent + onclick，CSP 同源约束不变）
	if (state.history?.cursor) {
		const older = node("button", labels.loadOlder, "ghost");
		older.disabled = !connected || loadingOlder;
		older.onclick = () => {
			if (loadingOlder || !state.history?.cursor) return;
			loadingOlder = true;
			send({ type: "history.page", sessionId: state.sessionId, cursor: state.history.cursor });
			render(state);
		};
		children.push({ order: -Infinity, element: older });
	}
	for (const message of state.messages) if (message.text || message.thinking) children.push({ order: message.order ?? 0, element: node("div", `${message.actor ?? (message.role === "user" ? "用户" : "助手")}\n${message.text}`, `msg ${message.role}`) });
	for (const tool of state.tools) {
		const card = node("details", "", `tool ${tool.ok === false ? "deny" : "info"}`);
		card.open = expanded.has(tool.callId);
		card.ontoggle = () => { if (card.open) expanded.add(tool.callId); else expanded.delete(tool.callId); };
		// S5b：截断标记走 textContent 拼接（CSP 约束不变）；originalBytes 缺省时只报截断
		const clipNote = tool.truncated ? `\n（已截断${tool.originalBytes ? `，原始 ${tool.originalBytes} 字节` : ""}）` : "";
		card.append(node("summary", `${tool.action.tool}: ${tool.action.command ?? tool.action.path ?? ""}`), node("pre", tool.output + clipNote));
		children.push({ order: tool.order ?? Number.MAX_SAFE_INTEGER, element: card });
	}
	for (const approval of state.approvals) {
		const card = node("div", `${labels.pending} · ${approval.actor ?? "用户"}\n${approval.action.tool}: ${approval.action.command ?? approval.action.path ?? ""}\n${approval.reason}\n${Math.max(0, Math.ceil((approval.expiresAt - Date.now()) / 1000))} 秒 · 无人应答按拒绝处理`, "approval pending");
		if (state.role === "approver") for (const decision of ["allow", "deny"]) {
			const button = node("button", labels[decision]);
			button.disabled = !connected || Date.now() >= approval.expiresAt;
			button.onclick = () => send({ type: "approve", approvalId: approval.approvalId, decision });
			card.append(button);
		}
		children.push({ order: Number.MAX_SAFE_INTEGER, element: card });
	}
	for (const error of state.errors) children.push({ order: Number.MAX_SAFE_INTEGER, element: node("div", error, "deny") });
	stream.replaceChildren(...children.sort((a, b) => a.order - b.order).map((item) => item.element));
	$("audit").replaceChildren(...state.audit.map((entry) => node("div", `${entry.at} ${entry.kind} ${entry.actor ?? ""} ${entry.approver ? "审批人 " + entry.approver : ""} ${entry.summary}`, "audit-row")));
	$("audit-count").textContent = `${state.audit.length} 条`;
	$("send").textContent = state.streaming ? labels.queue : labels.send;
	const canExecute = state.role === "owner" || state.role === "editor";
	$("send").disabled = $("input").disabled = !canExecute || !connected;
	$("steer").hidden = !state.streaming || !canExecute;
	$("abort").hidden = !state.streaming || !canExecute;
}
let reconnectAttempts = 0;
async function connect() {
	// 生产页面严禁从 location.search (params) 读取 bearer、token 或 actor！
	// 支持从一次性 hash (#bearer=... 或 #token=...) 引导；读到后立即从地址栏抹除
	const rawHash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
	const hashParams = new URLSearchParams(rawHash);
	const bearer = hashParams.get("bearer") || hashParams.get("token");
	const hashActor = hashParams.get("actor"); // R76-R3：审批人第二窗口以 #actor= 自报身份换 Cookie

	// 抹除地址栏遗留凭据：先清空 hash，且即使地址栏在 search 中误带了 bearer/token/actor 也一并抹除
	const cleanSearch = new URLSearchParams(location.search);
	let searchChanged = false;
	for (const key of ["bearer", "token", "actor"]) {
		if (cleanSearch.has(key)) {
			cleanSearch.delete(key);
			searchChanged = true;
		}
	}
	if (rawHash || searchChanged) {
		const cleanQuery = cleanSearch.toString() ? `?${cleanSearch.toString()}` : "";
		history.replaceState(null, "", location.pathname + cleanQuery);
	}

	let authed = false;
	if (bearer) {
		try {
			// R76-R3：hash 引导 token（及可选 #actor=）经 /auth/session 换同生产形态的会话
			// Cookie（demo 专用路径；production 走 IdP 验签，行为不变）。WS 本体不带凭据。
			const res = await fetch("/auth/session", {
				method: "POST",
				headers: { Authorization: `Bearer ${bearer}`, ...(hashActor ? { "x-demo-actor": hashActor } : {}) },
			});
			authed = res.ok;
		} catch {}
	}
	const query = new URLSearchParams();
	const sid = state.sessionId || params.get("session");
	if (sid) query.set("session", sid);
	ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/?${query}`);
	ws.onopen = () => { connected = true; reconnectAttempts = 0; render(state); };
	ws.onmessage = ({ data }) => {
		const frame = JSON.parse(data);
		if (frame.event) {
			state = reduce(state, frame.event);
			// S5a：分页应答（或失败）后恢复按钮；错误也算一次失败尝试，不把按钮卡死
			if (frame.event.type === "history.page" || frame.event.type === "error") loadingOlder = false;
			if (state.sessionId) {
				params.set("session", state.sessionId);
				history.replaceState(null, "", "?" + params.toString());
			}
			render(state);
		} else if (frame.control === "error") {
			state = reduce(state, { type: "error", message: frame.message });
			render(state);
		}
	};
	ws.onclose = ({ code }) => {
		connected = false;
		render(state);
		if (code === 4001 || code === 4003) return;
		const delay = Math.min(30000, 1000 * Math.pow(1.5, reconnectAttempts)) + Math.random() * 500;
		reconnectAttempts++;
		setTimeout(connect, delay);
	};
	ws.onerror = () => ws.close();
}
function prompt(type) { const text = $("input").value.trim(); if (!text) return; send({ type, text, requestId: crypto.randomUUID() }); $("input").value = ""; }
$("composer").onsubmit = (event) => { event.preventDefault(); prompt("prompt"); };
$("steer").onclick = () => prompt("steer");
$("abort").onclick = () => send({ type: "abort" });
setInterval(() => { if (state.approvals.length) render(state); }, 1000);
connect();
window.login = async (bearerToken) => {
	try {
		const res = await fetch("/auth/session", {
			method: "POST",
			headers: { Authorization: `Bearer ${bearerToken}` },
		});
		if (res.ok) {
			reconnectAttempts = 0;
			connect();
			return true;
		}
	} catch {}
	return false;
};
