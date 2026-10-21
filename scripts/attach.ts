import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { WebSocket } from "ws";
import { initialState, reduce } from "../web/view-model.js";
import { labels } from "../web/labels.js";
import type { ClientEvent } from "../src/protocol/types.ts";
const print = (...parts: unknown[]) => console.log(...parts.map((part) => typeof part === "string" ? part.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "") : part));
const arg = (name: string) => process.argv.indexOf(name) >= 0 ? process.argv[process.argv.indexOf(name) + 1] : undefined;
if (!arg("--session")) throw new Error("必须指定 --session <id>");
const url = new URL(arg("--url") ?? "http://127.0.0.1:8787");
if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) throw new Error("不支持的连接协议");
if (url.protocol === "http:") url.protocol = "ws:";
if (url.protocol === "https:") url.protocol = "wss:";
const bearerToken = arg("--bearer");
const explicitToken = arg("--token");
const explicitActor = arg("--actor");

if (bearerToken !== undefined && explicitToken !== undefined) {
	console.error("冲突参数：不能同时指定 --bearer 与 --token");
	process.exit(1);
}
if (bearerToken !== undefined && explicitActor !== undefined) {
	console.error("冲突参数：使用 --bearer 生产身份时禁止指定 --actor");
	process.exit(1);
}

url.searchParams.set("session", arg("--session") ?? "");
const headers: Record<string, string> = {};

if (bearerToken) {
	headers["Authorization"] = `Bearer ${bearerToken}`;
} else {
	const rawToken = explicitToken ?? process.env.PERIMETER_TOKEN;
	const queryToken = rawToken ?? "dev-token";
	url.searchParams.set("token", queryToken);
	url.searchParams.set("actor", explicitActor ?? "demo@local");
	if (rawToken) headers["Authorization"] = `Bearer ${rawToken}`;
}
let state = initialState();
const shownMessages = new Map<string, string>();
const shownApprovals = new Set<string>();
const shownTools = new Map<string, string>();
let attached = "";
const ws = new WebSocket(url, { headers });
const input = createInterface({ input: process.stdin, output: process.stdout });
// R76：连接建立前从 stdin 读到的命令排队（原缺陷：WS 未 OPEN 直接 return 丢弃，
// 首次 /share 无效），open 后按序发送。
const pendingLines: string[] = [];
let wsOpen = false;
let pendingCloseAfterFlush = false;
const handleLine = (line: string): void => {
	if (!wsOpen) { pendingLines.push(line); return; }
	if (ws.readyState !== ws.OPEN) return;
	if (line === "/abort") ws.send(JSON.stringify({ type: "abort" }));
	else if (line.startsWith("/share ")) { const [, actor, role] = line.split(" "); ws.send(JSON.stringify({ type: "share", actor, role })); }
	else if (line.startsWith("/unshare ")) ws.send(JSON.stringify({ type: "unshare", actor: line.slice(9) }));
	else if (line.startsWith("/approve ")) { const [, approvalId, decision] = line.split(" "); ws.send(JSON.stringify({ type: "approve", approvalId, decision })); }
	else ws.send(JSON.stringify({ type: line.startsWith("/steer ") ? "steer" : "prompt", text: line.replace(/^\/steer /, ""), requestId: randomUUID() }));
};
input.on("line", handleLine);
ws.on("open", () => {
	wsOpen = true;
	print(labels.connected, "输入消息；/steer 文本；/approve id allow|deny；/abort；/share actor editor|approver|viewer；/unshare actor");
	for (const line of pendingLines.splice(0)) handleLine(line); // open 后按序补发排队命令
	if (pendingCloseAfterFlush) ws.close(); // stdin 已结束：补发完再关（管道输入时序）
});
ws.on("message", (raw) => {
	const frame = JSON.parse(String(raw)) as { event?: ClientEvent; message?: string };
	if (!frame.event) { if (frame.message) print(frame.message); return; }
	state = reduce(state, frame.event);
	if (frame.event.type === "usage") print(`token ${state.usage.total} · 缓存 ${state.usage.cacheHitRate === null ? "—" : (state.usage.cacheHitRate * 100).toFixed(1) + "%"}`);
	if (frame.event.type === "session.snapshot") {
		if (attached !== state.sessionId + state.role) { print(`会话 ${state.sessionId} · ${state.role}`); attached = state.sessionId + state.role; }
		for (const message of state.messages) if (message.text && message.id !== "live" && shownMessages.get(message.id) !== message.text) {
			print(message.actor ?? message.role, message.text); shownMessages.set(message.id, message.text);
		}
		for (const tool of state.tools) if (shownTools.get(tool.callId) !== tool.output) {
			print(tool.action.tool, tool.action.command ?? tool.action.path, tool.ok === false ? labels.deny : "", tool.output);
			shownTools.set(tool.callId, tool.output);
		}
	}
	for (const approval of state.approvals) if (!shownApprovals.has(approval.approvalId)) {
		print(labels.pending, approval.approvalId, approval.action.tool, approval.action.command ?? approval.action.path, approval.reason); shownApprovals.add(approval.approvalId);
	}
	if (frame.event.type === "error") print(frame.event.message);
});
ws.on("close", () => input.close());
input.on("close", () => {
	// R76：stdin 关闭时若 WS 尚未 open（管道输入 echo '/share …' | attach），排队命令
	// 还没发出——标记待关闭，open 并补发完排队命令后再关；已 open 时行为不变。
	if (!wsOpen) pendingCloseAfterFlush = true;
	else ws.close();
});
ws.on("error", (error) => { console.error(error.message); process.exitCode = 1; input.close(); });
