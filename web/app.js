/**
 * 最小操作面。
 *
 * 一条纪律贯穿全文件：这里只认自有协议的 ClientEvent，绝不出现 pi 的字段名。
 * Phase 2 把底层从 RPC 子进程换成 AgentHarness 直连时，本文件一行都不用改。
 *
 * 零构建、零依赖：Phase 0 的 demo 要能在客户的受管设备上打开就跑。
 * React + xterm + CodeMirror 是 Phase 1 组队之后的事。
 */

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const state = {
	ws: null,
	seq: 0,
	sessionId: params.get("session") ?? null,
	messages: new Map(),
	tools: new Map(),
	auditCount: 0,
	countdownTimer: null,
};

connect();

function connect() {
	const q = new URLSearchParams();
	q.set("token", params.get("token") ?? "");
	if (params.get("actor")) q.set("actor", params.get("actor"));
	if (params.get("repo")) q.set("repo", params.get("repo"));
	if (state.sessionId) q.set("session", state.sessionId);

	const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/?${q}`);
	state.ws = ws;

	ws.onopen = () => {
		setDot("on");
		// 断线期间任务仍在服务端跑，重连后补齐错过的事件
		if (state.seq > 0) send({ type: "resume", since: state.seq });
	};
	ws.onclose = () => {
		setDot("");
		setTimeout(connect, 1500);
	};
	ws.onmessage = (e) => {
		const { seq, event } = JSON.parse(e.data);
		if (seq <= state.seq) return; // resume 会重放，去重
		state.seq = seq;
		render(event);
	};
}

function send(cmd) {
	if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(cmd));
}

function render(ev) {
	switch (ev.type) {
		case "session.ready":
			state.sessionId = ev.sessionId;
			$("model").textContent = ev.model ?? "未配置模型";
			break;

		case "session.state":
			if (ev.model) $("model").textContent = ev.model;
			setDot(ev.streaming ? "busy" : "on");
			break;

		case "agent.start":
			setDot("busy");
			break;
		// 实测 pi 只发 agent_end；agent_settled 在文档里有、这条路径上没有，
		// 因此以 agent.end 为结束信号，settled 只作补充。
		case "agent.end":
			if (!ev.willRetry) {
				setDot("on");
				clearStatus();
			}
			break;
		case "agent.settled":
			setDot("on");
			clearStatus();
			break;

		case "agent.status":
			// 重试与上下文压缩会让界面静默几十秒，必须给出解释
			ev.phase === "idle" ? clearStatus() : setStatus(ev.detail || ev.phase);
			break;

		case "message.start":
			messageEl(ev.messageId, ev.role);
			break;
		case "message.text":
			appendText(ev.messageId, ev.delta);
			break;
		case "message.thinking":
			appendThinking(ev.messageId, ev.delta);
			break;

		case "tool.start":
			toolEl(ev.callId, ev.summary);
			break;
		case "tool.progress":
			// 累计快照，替换而不是追加
			setToolOutput(ev.callId, ev.output);
			break;
		case "tool.end":
			setToolOutput(ev.callId, ev.output);
			toolEl(ev.callId).classList.add(ev.ok ? "ok" : "err");
			break;

		case "policy.denied":
			denied(ev);
			break;

		case "approval.request":
			openApproval(ev);
			break;
		case "approval.resolved":
			closeApproval(ev);
			break;

		case "audit.entry":
			auditRow(ev.entry);
			break;

		case "usage":
			$("usage").textContent = `token ${ev.usage.total}（缓存读 ${ev.usage.cacheRead}）· $${ev.usage.cost.toFixed(4)}`;
			break;

		case "error":
			errorRow(ev);
			break;
	}
	autoScroll();
}

// ── 对话流 ──────────────────────────────────────────────────

function messageEl(id, role) {
	let el = state.messages.get(id);
	if (!el) {
		el = document.createElement("div");
		el.className = `msg ${role}`;
		const who = document.createElement("span");
		who.className = "who";
		who.textContent = role === "user" ? "你" : "agent";
		el.append(who, document.createElement("span"));
		$("stream").append(el);
		state.messages.set(id, el);
	}
	return el;
}

function appendText(id, delta) {
	// textContent 而非 innerHTML：模型输出与工具结果都是不可信文本
	messageEl(id, "assistant").lastChild.textContent += delta;
}

function appendThinking(id, delta) {
	const el = messageEl(id, "assistant");
	let think = el.querySelector(".thinking");
	if (!think) {
		think = document.createElement("div");
		think.className = "thinking";
		el.insertBefore(think, el.lastChild);
	}
	think.textContent += delta;
}

function toolEl(callId, summary) {
	let el = state.tools.get(callId);
	if (!el) {
		el = document.createElement("div");
		el.className = "tool";
		const head = document.createElement("div");
		head.className = "head";
		const name = document.createElement("span");
		name.textContent = summary ?? callId;
		head.append(name);
		const out = document.createElement("div");
		out.className = "out";
		el.append(head, out);
		$("stream").append(el);
		state.tools.set(callId, el);
	}
	return el;
}

function setToolOutput(callId, text) {
	toolEl(callId).querySelector(".out").textContent = text;
}

function denied(ev) {
	const el = document.createElement("div");
	el.className = "tool denied";
	el.textContent = `策略拒绝（${ev.rule}）：${ev.reason}`;
	$("stream").append(el);
}

function errorRow(ev) {
	const el = document.createElement("div");
	el.className = "tool err";
	el.textContent = `${ev.code}：${ev.message}`;
	$("stream").append(el);
}

function setStatus(text) {
	let el = $("status");
	if (!el) {
		el = document.createElement("div");
		el.id = "status";
		el.className = "status";
		$("stream").append(el);
	}
	el.textContent = `⏳ ${text}`;
}

function clearStatus() {
	$("status")?.remove();
}

// ── 审计流 ──────────────────────────────────────────────────

function auditRow(entry) {
	const row = document.createElement("div");
	row.className = `entry ${entry.verdict === "deny" ? "deny" : ""} ${entry.kind.startsWith("approval") ? "approval" : ""}`;
	const seq = document.createElement("span");
	seq.className = "k";
	seq.textContent = `#${entry.seq}`;
	const kind = document.createElement("span");
	kind.className = "k";
	kind.textContent = entry.kind;
	const summary = document.createElement("span");
	summary.className = "v";
	summary.textContent = entry.summary;
	row.append(seq, kind, summary);
	$("audit").append(row);
	$("audit-count").textContent = `${++state.auditCount} 条`;
	$("audit").scrollTop = $("audit").scrollHeight;
}

// ── 审批门 ──────────────────────────────────────────────────

function openApproval(ev) {
	$("approval-reason").textContent = ev.reason;
	$("approval-backdrop").hidden = false;
	$("approve-allow").onclick = () => decide(ev.approvalId, "allow");
	$("approve-deny").onclick = () => decide(ev.approvalId, "deny");

	clearInterval(state.countdownTimer);
	const tick = () => {
		const left = Math.max(0, Math.round((ev.expiresAt - Date.now()) / 1000));
		$("approval-countdown").textContent = left > 0 ? `${left} 秒后自动拒绝` : "已超时，按拒绝处理";
		if (left === 0) clearInterval(state.countdownTimer);
	};
	tick();
	state.countdownTimer = setInterval(tick, 1000);
}

function decide(approvalId, decision) {
	send({ type: "approve", approvalId, decision });
	$("approval-backdrop").hidden = true;
	clearInterval(state.countdownTimer);
}

function closeApproval() {
	$("approval-backdrop").hidden = true;
	clearInterval(state.countdownTimer);
}

// ── 输入 ────────────────────────────────────────────────────

$("composer").addEventListener("submit", (e) => {
	e.preventDefault();
	const text = $("input").value.trim();
	if (!text) return;
	const el = messageEl(`local-${Date.now()}`, "user");
	el.lastChild.textContent = text;
	send({ type: "prompt", text });
	$("input").value = "";
	autoScroll();
});

$("input").addEventListener("keydown", (e) => {
	if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("composer").requestSubmit();
});

$("abort").addEventListener("click", () => send({ type: "abort" }));

function setDot(cls) {
	$("conn-dot").className = `dot ${cls}`;
}

function autoScroll() {
	const s = $("stream");
	s.scrollTop = s.scrollHeight;
}
