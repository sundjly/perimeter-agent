import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AuditLog } from "../src/audit/log.ts";
import { type ExecutionBackend, LocalBackend } from "../src/gateway/execution-backend.ts";
import { Session } from "../src/gateway/session.ts";
import type { ClientEvent } from "../src/protocol/types.ts";

/**
 * pi 启动前到达的命令。
 *
 * 这组用例必须能真的失败：把 session.ts 里那道 `#piStarted` 守卫删掉，
 * 第一条就应当报 `Cannot read properties of undefined (reading 'send')`。
 * 用真网关测不出来 —— LocalBackend 没有 prepare，start() 里唯一的挂起点
 * 求值成 `await undefined`，只让出一个微任务，而 WebSocket 消息要等下一轮
 * I/O 回调，所以 pi 必然已经起来了。这里用一个可控的 prepare 闸门把
 * 会话卡在「pi 尚未 spawn」的状态上。
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups) await c();
});

function gatedSession(): { session: Session; release: () => void; events: ClientEvent[] } {
	const dir = mkdtempSync(join(tmpdir(), "guard-"));
	const audit = AuditLog.open(join(dir, "audit.jsonl"));
	const local = new LocalBackend({ PATH: process.env.PATH });
	// release 要等 start() 真正调到 prepare 才产生，所以包一层
	let releaseFn: (() => void) | null = null;
	const backend: ExecutionBackend = {
		kind: "local",
		launch: (c) => local.launch(c),
		// 会话会一直停在这里，直到测试调用 release()
		prepare: () => new Promise<void>((r) => (releaseFn = r)),
	};
	const events: ClientEvent[] = [];
	const session = new Session({
		sessionId: "guard-1",
		actor: "t@local",
		repo: "r",
		team: "t",
		workspace: join(dir, "ws"),
		policyFile: join(REPO, "config/policy.yaml"),
		audit,
		piArgs: ["--no-session"],
		backend,
		send: (ev) => events.push(ev),
	});
	// 顺序要紧：stop() 会写 session.end，审计必须在那之后才关
	cleanups.push(async () => {
		await session.stop();
		audit.close();
	});
	return { session, release: () => releaseFn?.(), events };
}

test("pi 未启动时 abort 不会打到未初始化的进程上", async () => {
	const { session, release } = gatedSession();
	void session.start();
	await new Promise((r) => setTimeout(r, 30)); // 停在 prepare 里

	// 删掉守卫时这一行直接抛 TypeError，并连带杀掉整个网关进程
	session.handle({ type: "abort" });
	void release;
});

test("pi 未启动时 prompt 排队而不是下发", async () => {
	const { session, release, events } = gatedSession();
	void session.start();
	await new Promise((r) => setTimeout(r, 30));
	session.handle({ type: "prompt", text: "早到的 prompt" });
	// 排队意味着此刻不该有任何 prompt 的审计条目
	assert.ok(!events.some((e) => e.type === "audit.entry" && e.entry.kind === "prompt"));
	void release;
});

test("abort 会清掉排队的 prompt —— 用户按了停止，队列就不该在启动后照样跑", async () => {
	const { session, release, events } = gatedSession();
	void session.start();
	await new Promise((r) => setTimeout(r, 30));
	session.handle({ type: "prompt", text: "先排一条" });
	session.handle({ type: "abort" });
	// 队列被清空后再灌满上限也不该告警：说明之前那条已经不在队里了
	for (let i = 0; i < 32; i++) session.handle({ type: "prompt", text: `${i}` });
	assert.ok(!events.some((e) => e.type === "error" && e.message.includes("排队消息过多")));
	void release;
});

test("排队有上限，不会被无限 push 撑爆", async () => {
	const { session, release, events } = gatedSession();
	void session.start();
	await new Promise((r) => setTimeout(r, 30));
	for (let i = 0; i < 40; i++) session.handle({ type: "prompt", text: `第 ${i} 条` });
	assert.ok(
		events.some((e) => e.type === "error" && e.message.includes("排队消息过多")),
		"超过上限应当告知客户端，而不是静默囤积",
	);
	void release;
});

test("prepare 失败的会话仍然写 session.end —— 审计里不能有 start 无 end", async () => {
	const dir = mkdtempSync(join(tmpdir(), "guard-fail-"));
	const auditFile = join(dir, "audit.jsonl");
	const audit = AuditLog.open(auditFile);
	const local = new LocalBackend({ PATH: process.env.PATH });
	const session = new Session({
		sessionId: "guard-2",
		actor: "t@local",
		repo: "r",
		team: "t",
		workspace: join(dir, "ws"),
		policyFile: join(REPO, "config/policy.yaml"),
		audit,
		backend: {
			kind: "local",
			launch: (c) => local.launch(c),
			prepare: () => Promise.reject(new Error("沙箱没起来")),
		},
		send: () => {},
	});
	await session.start();
	audit.close();

	const kinds: string[] = [];
	for await (const e of AuditLog.replay(auditFile)) kinds.push(e.kind);
	assert.ok(kinds.includes("session.start"));
	assert.ok(kinds.includes("error"), "失败原因要留痕");
	assert.ok(kinds.includes("session.end"), "只置 #alive 的话这条永远不会写");
});
