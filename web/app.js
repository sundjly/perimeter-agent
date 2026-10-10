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
	approvals: [],
	retryMs: 0,
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
		state.retryMs = 0;
		// 断线期间任务仍在服务端跑，重连后补齐错过的事件
		// 用 sessionId 而不是 seq 做守卫：刷新后 seq 归零（没有持久化），
	// 用 `seq > 0` 会把刷新这条主路径整个挡掉 —— 一条历史都不重放。
	// 带 ?session= 的刷新应当 since:0 全量重放，去重逻辑天然放行。
	if (state.sessionId) send({ type: "resume", since: state.seq });
	};
	ws.onclose = () => {
		setDot("");
		// 指数退避：固定 1.5s 重试在网关拒绝（401、越权、超上限）时会变成死循环
		state.retryMs = Math.min((state.retryMs || 750) * 2, 30_000);
		setTimeout(connect, state.retryMs);
	};
	ws.onmessage = (e) => {
		const msg = JSON.parse(e.data);
		// 控制帧不参与 seq 序列：让它参与的话，attach 时那条帧会把 state.seq
		// 顶到最新，随后 resume 补发的事件全被去重逻辑丢掉
		if (msg.type === "control") {
			if (msg.control === "error") errorRow({ code: "gateway", message: msg.message });
			return;
		}
		if (msg.seq <= state.seq) return; // resume 会重放，去重
		state.seq = msg.seq;
		render(msg.event);
	};
}

function send(cmd) {
	if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(cmd));
}

function render(ev) {
	switch (ev.type) {
		case "session.ready":
			state.sessionId = ev.sessionId;
			// 不写回 URL 的话，用户一刷新就是一个全新会话、一个全新 pi 进程，
			// 旧会话连同进程泄漏 —— 也就没有「刷新后恢复会话」这回事了
			rememberSession(ev.sessionId);
			$("model").textContent = ev.model ?? "未配置模型";
			break;

		case "session.state":
			if (ev.model) $("model").textContent = ev.model;
			setDot(ev.streaming ? "busy" : "on");
			break;

		case "session.snapshot":
		case "session.presence":
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
	// 一律用 textContent 赋值：模型输出与工具结果都是不可信文本，
	// 走 HTML 注入接口等于把这道防线拆掉（有测试守着）
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

const MAX_TOOL_OUTPUT = 64 * 1024;

function setToolOutput(callId, text) {
	// tool.progress 是累计快照，每次整体重写。长构建输出不截断的话，
	// DOM 重写是 O(n²)，几 MB stdout 就能把页面卡死。
	const shown = text.length > MAX_TOOL_OUTPUT ? `…（略去前 ${text.length - MAX_TOOL_OUTPUT} 字符）
${text.slice(-MAX_TOOL_OUTPUT)}` : text;
	toolEl(callId).querySelector(".out").textContent = shown;
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

/** 审批按队列处理：第二条请求不能静默覆盖第一条 */
function openApproval(ev) {
	state.approvals.push(ev);
	if (state.approvals.length === 1) showApproval();
}

function showApproval() {
	const ev = state.approvals[0];
	if (!ev) {
		$("approval-backdrop").hidden = true;
		clearInterval(state.countdownTimer);
		return;
	}
	// 审批人必须看得清批的是什么：工具 + 具体目标，不只是命中的规则
	const target = ev.action?.command ?? ev.action?.path ?? "";
	$("approval-reason").textContent = target ? `${ev.action.tool}: ${target}
${ev.reason}` : ev.reason;
	$("approval-backdrop").hidden = false;
	$("approve-allow").onclick = () => decide(ev.approvalId, "allow");
	$("approve-deny").onclick = () => decide(ev.approvalId, "deny");

	clearInterval(state.countdownTimer);
	const tick = () => {
		const left = Math.max(0, Math.round((ev.expiresAt - Date.now()) / 1000));
		const n = state.approvals.length > 1 ? `（还有 ${state.approvals.length - 1} 条待审）` : "";
		$("approval-countdown").textContent = (left > 0 ? `${left} 秒后自动拒绝` : "已超时，按拒绝处理") + n;
		if (left === 0) clearInterval(state.countdownTimer);
	};
	tick();
	state.countdownTimer = setInterval(tick, 1000);
}

function decide(approvalId, decision) {
	send({ type: "approve", approvalId, decision });
	closeApproval({ approvalId });
}

/** 只关掉对应 id 的那一条，然后展示队列里的下一条 */
function closeApproval(ev) {
	const i = state.approvals.findIndex((a) => a.approvalId === ev.approvalId);
	if (i >= 0) state.approvals.splice(i, 1);
	showApproval();
}

/** 会话 id 写回 URL：刷新后仍连回同一个会话，而不是新建一个 */
function rememberSession(id) {
	const url = new URL(location.href);
	if (url.searchParams.get("session") === id) return;
	url.searchParams.set("session", id);
	history.replaceState(null, "", url);
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
