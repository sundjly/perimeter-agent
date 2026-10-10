import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { WebSocket } from "ws";
import { initialState, reduce } from "../web/view-model.js";
import { labels } from "../web/labels.js";
import type { ClientEvent } from "../src/protocol/types.ts";
const arg = (name: string) => process.argv.indexOf(name) >= 0 ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const url = new URL(arg("--url") ?? "http://127.0.0.1:8787");
if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) throw new Error("不支持的连接协议");
if (url.protocol === "http:") url.protocol = "ws:";
if (url.protocol === "https:") url.protocol = "wss:";
url.searchParams.set("token", arg("--token") ?? process.env.PERIMETER_TOKEN ?? "dev-token");
url.searchParams.set("session", arg("--session") ?? "");
url.searchParams.set("actor", arg("--actor") ?? "demo@local");
let state = initialState();
const shownMessages = new Map<string, string>();
const shownApprovals = new Set<string>();
let attached = "";
const ws = new WebSocket(url);
const input = createInterface({ input: process.stdin, output: process.stdout });
ws.on("open", () => console.log(labels.connected, "输入消息；/steer 文本；/approve id allow|deny；/abort"));
ws.on("message", (raw) => {
	const frame = JSON.parse(String(raw)) as { event?: ClientEvent; message?: string };
	if (!frame.event) { if (frame.message) console.log(frame.message); return; }
	state = reduce(state, frame.event);
	if (frame.event.type === "session.snapshot") {
		if (attached !== state.sessionId + state.role) { console.log(`会话 ${state.sessionId} · ${state.role}`); attached = state.sessionId + state.role; }
		for (const message of state.messages) if (message.id !== "live" && shownMessages.get(message.id) !== message.text) {
			console.log(message.actor ?? message.role, message.text); shownMessages.set(message.id, message.text);
		}
		for (const approval of state.approvals) if (!shownApprovals.has(approval.approvalId)) {
			console.log(labels.pending, approval.approvalId, approval.action.tool, approval.action.command ?? approval.action.path, approval.reason); shownApprovals.add(approval.approvalId);
		}
	}
	if (frame.event.type === "error") console.log(frame.event.message);
});
input.on("line", (line) => {
	if (ws.readyState !== ws.OPEN) return;
	if (line === "/abort") ws.send(JSON.stringify({ type: "abort" }));
	else if (line.startsWith("/approve ")) { const [, approvalId, decision] = line.split(" "); ws.send(JSON.stringify({ type: "approve", approvalId, decision })); }
	else ws.send(JSON.stringify({ type: line.startsWith("/steer ") ? "steer" : "prompt", text: line.replace(/^\/steer /, ""), requestId: randomUUID() }));
});
ws.on("close", () => input.close());
ws.on("error", (error) => { console.error(error.message); process.exitCode = 1; input.close(); });
