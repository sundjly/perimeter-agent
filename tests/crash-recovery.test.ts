import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { AuditLog } from "../src/audit/log.ts";
import { ModelGateway } from "../src/modelgw/server.ts";
import type { ClientEvent } from "../src/protocol/types.ts";
import { initialState, reduce } from "../web/view-model.js";

test("kill -9 恢复 transcript、owner 与待审批；旧审批不重用", async () => {
	const dir = mkdtempSync(join(tmpdir(), "crash-"));
	const mock = spawn(process.execPath, ["tests/fixtures/mock-model.mjs", "0", JSON.stringify([{ text: "第一轮" }, { tool: "bash", args: { command: "git push; touch bypass" } }, { text: "恢复完成" }])]);
	const [chunk] = await once(mock.stdout!, "data");
	const audit = AuditLog.open(join(dir, "model.jsonl"));
	const model = new ModelGateway({ port: 0, host: "127.0.0.1", token: "test-model-token", upstreams: [{ id: "mock", baseUrl: `http://127.0.0.1:${JSON.parse(String(chunk)).port}/v1`, apiKey: "dummy" }], egressAllowlist: ["127.0.0.1"], audit });
	const modelPort = await model.listen();
	let child: ChildProcess | undefined;
	const sockets: WebSocket[] = [];
	const launch = async () => {
		child = spawn(process.execPath, ["tests/fixtures/gateway-process.ts"], { env: { PATH: process.env.PATH, PERIMETER_TEST_ROOT: dir, PERIMETER_TEST_MODEL_URL: `http://127.0.0.1:${modelPort}/v1` }, stdio: ["ignore", "pipe", "inherit"] });
		const [chunk] = await once(child.stdout!, "data");
		return JSON.parse(String(chunk)).port as number;
	};
	const connect = async (port: number, actor: string) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=test-gateway-token&session=crash&actor=${actor}`);
		sockets.push(ws);
		const events: ClientEvent[] = [];
		const controls: { control: string }[] = [];
		ws.on("message", (raw) => { const frame = JSON.parse(String(raw)); if (frame.event) events.push(frame.event); else controls.push(frame); });
		await once(ws, "open");
		return { ws, events, controls };
	};
	const wait = async (predicate: () => boolean) => {
		const deadline = Date.now() + 10_000;
		while (!predicate()) { if (Date.now() > deadline) throw new Error("恢复等待超时"); await new Promise((resolve) => setTimeout(resolve, 10)); }
	};
	try {
		let port = await launch();
		const first = await connect(port, "owner");
		await wait(() => first.events.some((event) => event.type === "session.ready"));
		first.ws.send(JSON.stringify({ type: "prompt", text: "第一轮", requestId: "one" }));
		await wait(() => first.events.some((event) => event.type === "agent.end"));
		first.ws.send(JSON.stringify({ type: "prompt", text: "推送", requestId: "two" }));
		await wait(() => first.events.some((event) => event.type === "approval.request"));
		const old = first.events.find((event) => event.type === "approval.request")!;
		if (old.type !== "approval.request") throw new Error("缺少旧审批");
		const exit = once(child!, "exit"); child!.kill("SIGKILL"); await exit;
		port = await launch();
		const intruder = await connect(port, "stranger");
		await wait(() => intruder.controls.some((control) => control.control === "error"));
		const next = await connect(port, "owner");
		await wait(() => next.events.reduce(reduce, initialState()).approvals.some((approval) => approval.approvalId !== old.approvalId));
		const state = next.events.reduce(reduce, initialState());
		assert.ok(state.messages.some((message) => message.text === "第一轮" && message.role === "assistant"));
		const approval = state.approvals[0]!;
		next.ws.send(JSON.stringify({ type: "approve", approvalId: old.approvalId, decision: "allow" }));
		next.ws.send(JSON.stringify({ type: "approve", approvalId: approval.approvalId, decision: "deny" }));
		await wait(() => next.events.some((event) => event.type === "agent.end"));
		assert.equal(existsSync(join(dir, "workspaces/crash/bypass")), false);
	} finally {
		for (const socket of sockets) socket.terminate();
		try { if (child?.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGTERM"); await exit; } } finally {
			try { await model.close(); } finally { audit.close(); mock.kill(); rmSync(dir, { recursive: true, force: true }); }
		}
	}
});
