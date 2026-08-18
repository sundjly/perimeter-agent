import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { PiEvent, PiResponse } from "../src/protocol/translate.ts";
import { PiSession } from "../src/rpc/pi-session.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

interface Harness {
	session: PiSession;
	events: PiEvent[];
	responses: PiResponse[];
	stderr: string[];
	exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("waitFor 超时");
		await new Promise((r) => setTimeout(r, 5));
	}
}

function start(extra: Partial<ConstructorParameters<typeof PiSession>[0]> = {}): Harness {
	const events: PiEvent[] = [];
	const responses: PiResponse[] = [];
	const stderr: string[] = [];
	let resolveExit: (i: { code: number | null; signal: NodeJS.Signals | null }) => void;
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
		resolveExit = r;
	});
	const session = new PiSession({
		cwd: process.cwd(),
		bin: process.execPath,
		args: [FAKE_PI],
		onEvent: (e) => events.push(e),
		onResponse: (r) => responses.push(r),
		onStderr: (s) => stderr.push(s),
		onExit: (i) => resolveExit(i),
		requestTimeoutMs: 500,
		...extra,
	});
	return { session, events, responses, stderr, exited };
}

test("命令与响应按 id 关联", async () => {
	const h = start();
	const res = await h.session.request({ type: "get_state" });
	assert.equal(res.success, true);
	assert.equal(res.command, "get_state");
	await h.session.stop();
});

test("并发请求各自拿到自己的响应", async () => {
	const h = start();
	const [a, b] = await Promise.all([h.session.request({ type: "get_state" }), h.session.request({ type: "other" })]);
	assert.equal(a.command, "get_state");
	assert.equal(b.command, "other");
	assert.notEqual(a.id, b.id);
	await h.session.stop();
});

test("事件流与响应流分开投递，含裸 U+2028 的中文完整还原", async () => {
	const h = start();
	await h.session.request({ type: "prompt", message: "hi" });
	await waitFor(() => h.events.some((e) => e.type === "agent_settled"));
	const types = h.events.map((e) => e.type);
	assert.deepEqual(types, ["agent_start", "message_start", "message_update", "message_end", "agent_settled"]);
	const end = h.events.find((e) => e.type === "message_end") as unknown as { message: { content: { text: string }[] } };
	assert.equal(end.message.content[0]!.text, "第一行 第二行");
	assert.equal(h.responses.length, 1);
	await h.session.stop();
});

test("失败响应同样投递给上层，不被 request 吞掉", async () => {
	const h = start();
	const res = await h.session.request({ type: "fail" });
	assert.equal(res.success, false);
	assert.equal(h.responses[0]?.success, false);
	await h.session.stop();
});

test("无响应的命令按超时拒绝，且不泄漏 pending", async () => {
	const h = start();
	await assert.rejects(h.session.request({ type: "silent" }), /timed out: silent/);
	await h.session.stop();
});

test("进程崩溃时 flush 残留行并拒绝所有在途请求", async () => {
	const h = start();
	const pendings = [h.session.request({ type: "silent" }), h.session.request({ type: "silent" })];
	h.session.send({ type: "crash" });
	const info = await h.exited;
	assert.equal(info.code, 3);
	for (const p of pendings) await assert.rejects(p, /exited \(code=3/);
	// 半行 stdout 在退出时被 flush 出来
	assert.deepEqual(h.events.at(-1), { type: "agent_end", willRetry: false });
	assert.equal(h.session.running, false);
});

test("退出后继续 request 立即拒绝，send 静默丢弃", async () => {
	const h = start();
	await h.session.stop();
	await assert.rejects(h.session.request({ type: "get_state" }), /already exited/);
	h.session.send({ type: "get_state" });
});

test("不可解析的行走协议错误通道而不是打断会话", async () => {
	const bad: string[] = [];
	const h = start({
		args: [fileURLToPath(new URL("./fixtures/garbage-out.mjs", import.meta.url))],
		onProtocolError: (line) => bad.push(line),
	});
	await waitFor(() => bad.length > 0);
	assert.deepEqual(bad, ["not json"]);
	assert.equal(h.events.length, 0);
	await h.session.stop();
});

test("合法 JSON 但非对象的帧不得升级为进程级异常", async () => {
	const bad: string[] = [];
	const h = start({
		args: [fileURLToPath(new URL("./fixtures/bad-frames.mjs", import.meta.url))],
		onProtocolError: (line) => bad.push(line),
	});
	await waitFor(() => h.events.length > 0);
	assert.deepEqual(bad, ["null", "123", '"str"', "not json"]);
	// 坏帧之后的正常事件仍然照常投递
	assert.deepEqual(h.events, [{ type: "agent_start" }]);
	await h.session.stop();
});

test("stop() 与并发写入不产生 write-after-end 崩溃", async () => {
	const h = start();
	const stopping = h.session.stop();
	// 同一 tick 内还有一条已入队的客户端消息
	h.session.send({ type: "get_state" });
	await assert.rejects(h.session.request({ type: "get_state" }), /already exited/);
	await stopping;
	assert.equal(h.session.running, false);
});

test("超时后迟到的响应不会二次 resolve，且 pending 已清空", async () => {
	const h = start({ requestTimeoutMs: 60 });
	await assert.rejects(h.session.request({ type: "late" }), /timed out: late/);
	assert.equal(h.session.pendingCount, 0);
	await waitFor(() => h.responses.some((r) => r.command === "late"));
	assert.equal(h.session.pendingCount, 0);
	await h.session.stop();
});

test("SIGTERM 被忽略时按 graceMs 升级为 SIGKILL", async () => {
	const h = start({ args: [fileURLToPath(new URL("./fixtures/stubborn.mjs", import.meta.url))] });
	await waitFor(() => h.events.some((e) => e.type === "ready"));
	await h.session.stop(150);
	const info = await h.exited;
	assert.equal(info.signal, "SIGKILL");
});

test("pi 不存在时优雅失败，不挂死", async () => {
	const h = start({ bin: "definitely-not-a-real-binary-xyz", args: [] });
	await assert.rejects(h.session.request({ type: "get_state" }), /ENOENT|exited/);
	const info = await h.exited;
	assert.equal(info.code, null);
	await h.session.stop();
});
