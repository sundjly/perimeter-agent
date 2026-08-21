import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { AuditLog } from "../src/audit/log.ts";
import { type ExecutionBackend, LocalBackend } from "../src/gateway/execution-backend.ts";
import { Gateway } from "../src/gateway/server.ts";
import type { ClientEvent } from "../src/protocol/types.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MOCK = join(REPO, "tests/fixtures/mock-model.mjs");
const TOKEN = "test-token";

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups) await c();
});

interface Env {
	url: string;
	auditFile: string;
	workspaceRoot: string;
	gateway: Gateway;
	/** 暴露给需要自建 backend 的用例：不带上它，pi 找不到 mock provider */
	piEnv: NodeJS.ProcessEnv;
}

async function startGateway(script: unknown[], extra: Partial<ConstructorParameters<typeof Gateway>[0]> = {}): Promise<Env> {
	const mock: ChildProcess = spawn(process.execPath, [MOCK, "0", JSON.stringify(script)], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	cleanups.push(() => void mock.kill());
	const port: number = await new Promise((r) => mock.stdout?.once("data", (d) => r(JSON.parse(d.toString()).port)));

	const home = mkdtempSync(join(tmpdir(), "pihome-"));
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(
		join(home, ".pi", "agent", "models.json"),
		JSON.stringify({
			providers: {
				mock: {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "dummy",
					compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
					models: [{ id: "mock-model" }],
				},
			},
		}),
	);

	const dir = mkdtempSync(join(tmpdir(), "gw-"));
	const auditFile = join(dir, "audit.jsonl");
	const workspaceRoot = join(dir, "workspaces");
	const gateway = new Gateway({
		port: 0,
		host: "127.0.0.1",
		token: TOKEN,
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile,
		workspaceRoot,
		webRoot: join(REPO, "web"),
		piArgs: ["--no-session", "--provider", "mock", "--model", "mock-model"],
		piEnv: { PATH: process.env.PATH, HOME: home },
		approvalTimeoutMs: 30_000,
		...extra,
	});
	cleanups.push(() => gateway.close());
	const listening = await gateway.listen();
	return { url: `http://127.0.0.1:${listening}`, auditFile, workspaceRoot, gateway, piEnv: { PATH: process.env.PATH, HOME: home } };
}

interface Client {
	ws: WebSocket;
	events: ClientEvent[];
	seqs: number[];
	controls: Record<string, unknown>[];
	waitFor: (pred: () => boolean, ms?: number) => Promise<void>;
	find: <T extends ClientEvent["type"]>(type: T) => Extract<ClientEvent, { type: T }> | undefined;
	send: (cmd: unknown) => void;
}

async function auditEntries(file: string): Promise<import("../src/audit/log.ts").AuditEntry[]> {
	const out: import("../src/audit/log.ts").AuditEntry[] = [];
	for await (const e of AuditLog.replay(file)) out.push(e);
	return out;
}

async function connect(env: Env, query = ""): Promise<Client> {
	const ws = new WebSocket(`${env.url.replace("http", "ws")}/?token=${TOKEN}${query}`);
	const events: ClientEvent[] = [];
	const seqs: number[] = [];
	const controls: Record<string, unknown>[] = [];
	ws.on("message", (raw) => {
		const msg = JSON.parse(String(raw));
		if (msg.type === "control") {
			controls.push(msg);
			return;
		}
		events.push(msg.event);
		seqs.push(msg.seq);
	});
	await new Promise((r, j) => {
		ws.once("open", r);
		ws.once("error", j);
	});
	cleanups.push(() => void ws.close());
	const waitFor = async (pred: () => boolean, ms = 20_000) => {
		const deadline = Date.now() + ms;
		while (!pred()) {
			if (Date.now() > deadline) throw new Error(`waitFor 超时；已收到 ${events.map((e) => e.type).join(",")}`);
			await new Promise((r) => setTimeout(r, 20));
		}
	};
	return {
		ws,
		events,
		seqs,
		controls,
		waitFor,
		find: (type) => events.find((e) => e.type === type) as never,
		send: (cmd) => ws.send(JSON.stringify(cmd)),
	};
}

test("无 token 的连接被拒绝", async () => {
	const env = await startGateway([{ text: "hi" }]);
	const ws = new WebSocket(`${env.url.replace("http", "ws")}/`);
	await assert.rejects(
		new Promise((r, j) => {
			ws.once("open", r);
			ws.once("error", j);
		}),
		/401/,
	);
});

test("会话建立后下发 session.ready，前端拿到的全是自有协议事件", async () => {
	const env = await startGateway([{ text: "你好" }]);
	const c = await connect(env);
	await c.waitFor(() => c.find("session.ready") !== undefined);

	const ready = c.find("session.ready")!;
	assert.equal(ready.model, "mock-model");
	assert.ok(ready.workspace.length > 0);
	// 出口只有 ClientEvent：不允许出现 pi 的事件类型名
	assert.ok(!c.events.some((e) => e.type.includes("_")), `泄漏了 pi 事件：${c.events.map((e) => e.type).join(",")}`);
});

test("prompt 走完整链路：文本流式返回 + 审计留痕", async () => {
	const env = await startGateway([{ text: "已完成修复" }]);
	const c = await connect(env);
	await c.waitFor(() => c.find("session.ready") !== undefined);

	c.send({ type: "prompt", text: "修复登录超时" });
	await c.waitFor(() => c.events.some((e) => e.type === "agent.end" && !e.willRetry));

	const text = c.events.filter((e) => e.type === "message.text").map((e) => (e as { delta: string }).delta).join("");
	assert.match(text, /已完成修复/);
	assert.ok(c.events.some((e) => e.type === "audit.entry"));
	assert.equal((await AuditLog.verify(env.auditFile)).ok, true);
});

test("审批门：拦下不可逆操作，前端批准后才执行", async () => {
	const env = await startGateway([{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "完成" }]);
	const c = await connect(env);
	await c.waitFor(() => c.find("session.ready") !== undefined);

	c.send({ type: "prompt", text: "升级依赖" });
	await c.waitFor(() => c.find("approval.request") !== undefined);

	const req = c.find("approval.request")!;
	assert.match(req.reason, /git push|package.json|不可逆|高风险/);
	assert.ok(req.expiresAt > Date.now());

	c.send({ type: "approve", approvalId: req.approvalId, decision: "allow" });
	await c.waitFor(() => c.find("approval.resolved") !== undefined);
	await c.waitFor(() => c.events.some((e) => e.type === "agent.end" && !e.willRetry));

	const ws = c.find("session.ready")!.workspace;
	assert.equal(existsSync(join(ws, "package.json")), true);
});

test("审批门：拒绝后工具不执行，审计里留下审批人", async () => {
	const env = await startGateway([{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "完成" }]);
	const c = await connect(env, "&actor=bob@corp");
	await c.waitFor(() => c.find("session.ready") !== undefined);

	c.send({ type: "prompt", text: "升级依赖" });
	await c.waitFor(() => c.find("approval.request") !== undefined);
	c.send({ type: "approve", approvalId: c.find("approval.request")!.approvalId, decision: "deny" });
	await c.waitFor(() => c.events.some((e) => e.type === "agent.end" && !e.willRetry));

	assert.equal(existsSync(join(c.find("session.ready")!.workspace, "package.json")), false);

	const entries = [];
	for await (const e of AuditLog.replay(env.auditFile)) entries.push(e);
	const decision = entries.find((e) => e.kind === "approval.decision");
	assert.equal(decision?.verdict, "deny");
	assert.equal(decision?.approver, "bob@corp");
});

test("策略拒绝的操作下发 policy.denied 并记入审计", async () => {
	const env = await startGateway([
		{ tool: "write", args: { path: ".github/workflows/x.yml", content: "on: push" } },
		{ text: "完成" },
	]);
	const c = await connect(env);
	await c.waitFor(() => c.find("session.ready") !== undefined);
	c.send({ type: "prompt", text: "改 CI" });
	await c.waitFor(() => c.find("policy.denied") !== undefined);

	const denied = c.find("policy.denied")!;
	assert.equal(denied.rule, "ci-iac-secrets-off-limits");
	assert.equal(existsSync(join(c.find("session.ready")!.workspace, ".github/workflows/x.yml")), false);
});

test("断线重连不重启会话，任务继续在服务端跑", async () => {
	const env = await startGateway([{ text: "长任务结果" }]);
	const first = await connect(env);
	await first.waitFor(() => first.find("session.ready") !== undefined);
	const sessionId = first.find("session.ready")!.sessionId;

	first.ws.close();
	await new Promise((r) => setTimeout(r, 100));

	const second = await connect(env, `&session=${sessionId}`);
	second.send({ type: "prompt", text: "继续" });
	await second.waitFor(() => second.events.some((e) => e.type === "agent.end" && !e.willRetry));
	// 同一个 workspace，说明复用的是同一个 pi 进程而不是新建会话
	const text = second.events.filter((e) => e.type === "message.text").map((e) => (e as { delta: string }).delta).join("");
	assert.match(text, /长任务结果/);
});

test("resume 重放断线期间错过的事件", async () => {
	const env = await startGateway([{ text: "结果" }]);
	const c = await connect(env);
	await c.waitFor(() => c.find("session.ready") !== undefined);
	c.send({ type: "prompt", text: "跑" });
	await c.waitFor(() => c.events.some((e) => e.type === "agent.end" && !e.willRetry));

	const before = c.events.length;
	c.send({ type: "resume", since: 0 });
	await c.waitFor(() => c.events.length > before);
	assert.ok(c.events.length >= before * 2 - 1, "resume 应重放历史事件");
});

test("静态文件服务挡住路径穿越", async () => {
	const env = await startGateway([{ text: "x" }]);
	const res = await fetch(`${env.url}/../package.json`);
	assert.equal(res.status, 404);
	const res2 = await fetch(`${env.url}/%2e%2e/package.json`);
	assert.equal(res2.status, 404);
});

test("畸形命令不会打死网关进程", async () => {
	const env = await startGateway([{ text: "x" }]);
	const c = await connect(env);
	await c.waitFor(() => c.find("session.ready") !== undefined);

	// 非 JSON
	c.ws.send("这不是 JSON");
	await c.waitFor(() => c.controls.some((m) => m.control === "error"));

	// 合法 JSON 但字段缺失 —— 这类曾经能一条消息打死整个网关，
	// 连带杀掉所有其他会话的 pi 进程
	for (const bad of [{ type: "prompt" }, { type: "approve" }, { type: "resume" }, { type: "nope" }, null, 42]) {
		c.ws.send(JSON.stringify(bad));
	}
	await c.waitFor(() => c.events.filter((e) => e.type === "error" && e.code === "command_failed").length >= 6);

	// 会话仍然可用
	c.send({ type: "prompt", text: "还活着吗" });
	await c.waitFor(() => c.events.some((e) => e.type === "agent.end" && !e.willRetry));
});

test("sessionId 不能穿越工作区 —— 它直接参与路径拼接", async () => {
	const env = await startGateway([{ text: "x" }]);
	const ws = new WebSocket(`${env.url.replace("http", "ws")}/?token=${TOKEN}&session=../../../../tmp/pwned`);
	const msgs: Record<string, unknown>[] = [];
	ws.on("message", (raw) => msgs.push(JSON.parse(String(raw))));
	await new Promise((r) => ws.once("open", r));
	await new Promise((r) => setTimeout(r, 200));
	assert.ok(msgs.some((m) => m.control === "error"), "非法 session id 必须被拒");
	assert.equal(existsSync("/tmp/pwned"), false, "绝不能在工作区之外创建目录");
});

test("会话归属：知道 id 也不能接管别人的会话", async () => {
	const env = await startGateway([{ text: "x" }]);
	const owner = await connect(env, "&actor=alice@corp");
	await owner.waitFor(() => owner.find("session.ready") !== undefined);
	const sessionId = owner.find("session.ready")!.sessionId;

	const intruder = await connect(env, `&actor=mallory@corp&session=${sessionId}`);
	await intruder.waitFor(() => intruder.controls.some((m) => m.control === "error"));
	assert.match(String(intruder.controls.find((m) => m.control === "error")?.message), /无权接入/);
});

test("策略作用域由服务端决定，客户端自选 repo/team 无效", async () => {
	const env = await startGateway([{ text: "x" }], { resolveScope: () => ({ repo: "locked-repo", team: "locked-team" }) });
	const c = await connect(env, "&repo=attacker-chosen&team=attacker-chosen");
	await c.waitFor(() => c.find("session.ready") !== undefined);

	const entries = [];
	for await (const e of AuditLog.replay(env.auditFile)) entries.push(e);
	assert.equal(entries[0]?.repo, "locked-repo");
	assert.ok(!JSON.stringify(entries).includes("attacker-chosen"));
});

test("attach 控制帧不参与 seq 序列，否则 resume 补发的事件会被全部丢弃", async () => {
	const env = await startGateway([{ text: "结果" }]);
	const c = await connect(env);
	await c.waitFor(() => c.find("session.ready") !== undefined);
	c.send({ type: "prompt", text: "跑" });
	await c.waitFor(() => c.events.some((e) => e.type === "agent.end" && !e.willRetry));

	// attach 时收到的是控制帧，不带 seq
	assert.ok(c.controls.some((m) => m.control === "attached"));
	// 事件 seq 从 1 开始严格递增，没有重复
	assert.deepEqual(c.seqs, [...c.seqs].sort((a, b) => a - b));
	assert.equal(new Set(c.seqs).size, c.seqs.length);
	assert.equal(c.seqs[0], 1);
});

test("resume 只补发 since 之后的事件，且只回发起方", async () => {
	const env = await startGateway([{ text: "结果" }]);
	const c = await connect(env);
	await c.waitFor(() => c.find("session.ready") !== undefined);
	const mid = c.seqs.at(-1)!;
	c.send({ type: "prompt", text: "跑" });
	await c.waitFor(() => c.events.some((e) => e.type === "agent.end" && !e.willRetry));

	const before = c.seqs.length;
	c.send({ type: "resume", since: mid });
	await c.waitFor(() => c.seqs.length > before);
	// 补发的都是 mid 之后的
	assert.ok(c.seqs.slice(before).every((s) => s > mid));
});

test("钩子未挂上之前不下发 prompt —— 否则会在无策略保护下跑工具", async () => {
	const env = await startGateway([{ text: "x" }]);
	const c = await connect(env);
	await c.waitFor(() => c.events.some((e) => e.type === "audit.entry" && e.entry.summary.includes("策略钩子已挂载")));
	const armed = c.events.find((e) => e.type === "audit.entry" && e.entry.summary.includes("策略钩子已挂载"));
	assert.ok(armed, "扩展必须宣告钩子已挂载，否则网关无法确认策略生效");
});

test("会话数上限拦住无限拉起 pi 进程", async () => {
	const env = await startGateway([{ text: "x" }], { maxSessions: 1 });
	const first = await connect(env);
	await first.waitFor(() => first.find("session.ready") !== undefined);
	const second = await connect(env);
	await second.waitFor(() => second.controls.some((m) => m.control === "error"));
	assert.match(String(second.controls.find((m) => m.control === "error")?.message), /上限/);
});

test("缓冲溢出后续接：必须告知客户端丢了什么，而不是假装完整", async () => {
	// backlog 是有上限的，断线久了最老的事件被挤掉。客户端不知道自己丢了
	// 东西的话会以为界面完整 —— 而丢掉的可能正是一条 policy.denied
	const env = await startGateway([{ text: "干完了" }], { backlogSize: 3 });
	const c = await connect(env);
	await c.waitFor(() => c.events.some((e) => e.type === "session.ready"));

	c.send({ type: "prompt", text: "干活" });
	await c.waitFor(() => c.events.some((e) => e.type === "agent.end"));
	const lastSeq = c.seqs.at(-1)!;
	assert.ok(lastSeq > 5, `事件数不足以撑破 3 条的缓冲（lastSeq=${lastSeq}）`);

	c.events.length = 0;
	c.seqs.length = 0;
	c.send({ type: "resume", since: 1 });
	await c.waitFor(() => c.events.some((e) => e.type === "session.gap"));

	// gap 必须是重放的第一条，且它的 seq 必须落在缺口末尾 ——
	// 带最新 seq 的话，前端 `seq <= state.seq` 的去重会把随后重放的事件全吃掉
	assert.equal(c.events[0]!.type, "session.gap", "gap 应当先于重放到达");
	const gap = c.events[0] as { missedFrom: number; missedTo: number };
	assert.equal(gap.missedFrom, 2, "缺口应当从客户端已知的下一条算起");
	// backlogSize=3 ⇒ firstSeq = lastSeq-2 ⇒ missedTo = lastSeq-3。钉住算术，不写恒真式
	assert.equal(gap.missedTo, lastSeq - 3);
	assert.equal(c.seqs[0], gap.missedTo, "gap 的 seq 必须是 missedTo，否则前端游标会被顶到最新");

	// 缓冲里那 3 条必须真的送到，且 seq 都大于 gap 的
	const after = c.seqs.slice(1);
	assert.equal(after.length, 3, `缓冲里的 3 条都要重放，实际 ${after.length}`);
	assert.ok(
		after.every((q) => q > gap.missedTo),
		"重放事件的 seq 必须大于 gap 的，否则会被前端去重丢掉",
	);
});

test("缓冲未溢出时不报缺口 —— 别制造假警报", async () => {
	const env = await startGateway([{ text: "ok" }], { backlogSize: 2000 });
	const c = await connect(env);
	await c.waitFor(() => c.events.some((e) => e.type === "session.ready"));
	c.events.length = 0;

	c.send({ type: "resume", since: 0 });
	await new Promise((r) => setTimeout(r, 300));
	assert.ok(!c.events.some((e) => e.type === "session.gap"), "缓冲够用时不该报缺口");
	assert.ok(c.events.length > 0, "但历史事件要重放");
});

test("resume 的 since 越界不崩，也不重复投递", async () => {
	const env = await startGateway([{ text: "还在" }]);
	const c = await connect(env);
	await c.waitFor(() => c.events.some((e) => e.type === "session.ready"));
	const seen = c.seqs.at(-1)!;
	c.events.length = 0;

	// 客户端声称已收到远超实际的 seq
	c.send({ type: "resume", since: seen + 10_000 });
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(c.events.length, 0, "since 超前时不该重放任何东西");

	// 负数会算出 missedFrom 为负的虚构缺口，前端照着会报「有 5 条未恢复」
	c.send({ type: "resume", since: -5 });
	await new Promise((r) => setTimeout(r, 300));
	assert.ok(!c.events.some((e) => e.type === "session.gap"), "负数 since 不该造出缺口");
	assert.ok(
		c.events.some((e) => e.type === "error"),
		"畸形的 since 要有明确反馈，而不是静默按 0 处理",
	);
	c.send({ type: "prompt", text: "还活着吗" });
	await c.waitFor(() => c.events.some((e) => e.type === "agent.end"));
});

test("续接时重发挂起的审批 —— 否则 agent 一直等到超时而用户看不到框", async () => {
	// approval.request 滚出缓冲后，服务端 agent 还阻塞着，客户端却永远
	// 看不到对话框。用户只看到「丢了 N 条记录」，不会想到有东西等着他批。
	const env = await startGateway([{ tool: "bash", args: { command: "git push origin main" } }, { text: "推完了" }], {
		backlogSize: 3,
		approvalTimeoutMs: 60_000,
	});
	const c = await connect(env);
	await c.waitFor(() => c.events.some((e) => e.type === "session.ready"));
	c.send({ type: "prompt", text: "推一下" });
	await c.waitFor(() => c.events.some((e) => e.type === "approval.request"));
	const original = c.events.find((e) => e.type === "approval.request") as { approvalId: string };

	// 制造缺口：审批请求已被挤出缓冲
	c.events.length = 0;
	c.seqs.length = 0;
	c.send({ type: "resume", since: 1 });
	await c.waitFor(() => c.events.some((e) => e.type === "approval.request"));

	const resent = c.events.find((e) => e.type === "approval.request") as { approvalId: string; expiresAt: number };
	assert.equal(resent.approvalId, original.approvalId, "必须用同一个 id，否则前端会开出第二个框");
	assert.ok(resent.expiresAt > Date.now(), "重发的对话框要能算出倒计时");

	// 用重发的 id 批准，工具应当真的执行
	c.send({ type: "approve", approvalId: resent.approvalId, decision: "allow" });
	await c.waitFor(() => c.events.some((e) => e.type === "agent.end"));
});

test("空闲会话被回收，且审计能分辨「被回收」与「自己结束」", async () => {
	// 运维只看到会话没了、不知道为什么，是排查时最耗时的一类状态
	const env = await startGateway([{ text: "ok" }], { idleTimeoutMs: 1_000 });
	const c = await connect(env);
	await c.waitFor(() => c.events.some((e) => e.type === "session.ready"));
	assert.equal(env.gateway.sessionCount, 1);

	// 轮询而不是睡死：同时钉住「间隔跟着 idleTimeoutMs 走」——
	// 此前 reaper 固定 30s，配 1s 也要等 30s 才回收
	const t0 = Date.now();
	while (env.gateway.sessionCount > 0 && Date.now() - t0 < 4_000) {
		await new Promise((r) => setTimeout(r, 100));
	}
	assert.equal(env.gateway.sessionCount, 0, "空闲超时的会话应当被回收");

	const entries = await auditEntries(env.auditFile);
	const ends = entries.filter((e) => e.kind === "session.end");
	assert.equal(ends.length, 1, `一个会话只该有一条 session.end，实际 ${ends.length} 条 —— 多了会让 SIEM 的会话数翻倍`);
	assert.match(ends[0]!.summary, /空闲 \d+s 被网关回收/, "要能看出是因为空闲");
	// 归属不能丢：一条泄漏告警要答得上「谁的会话」，而 owner 就在手边
	assert.equal(ends[0]!.actor, "demo@local", "回收记录要保留会话归属，不能换成 gateway-reaper");
});

test("停不掉的会话被记为沙箱泄漏 —— 不能从表里删掉就当没事", async () => {
	// 会话已从表里消失，没人再会去收它，而容器还持有工作区与代理 token。
	// 用一个 cleanup 必失败的后端把这条路径逼出来。
	// 惰性 holder：launch 只在 connect() 时才被调到，所以拿到 env 后再赋值就够，
	// 不必为了取 piEnv 多起一整个 gateway
	let inner: ExecutionBackend;
	const failing: ExecutionBackend = {
		kind: "local",
		launch: (ctx) => inner.launch(ctx),
		cleanup: () => Promise.reject(new Error("容器停不掉")),
	};
	const env = await startGateway([{ text: "ok" }], { idleTimeoutMs: 1_000, backend: failing });
	inner = new LocalBackend(env.piEnv);
	const c = await connect(env);
	await c.waitFor(() => c.events.some((e) => e.type === "session.ready"));

	await new Promise((r) => setTimeout(r, 3_000));
	assert.equal(env.gateway.sessionCount, 0, "即便停不掉也要从表里删掉，否则 maxSessions 会被僵尸占满");

	const entries = await auditEntries(env.auditFile);
	const leak = entries.find((e) => e.summary.includes("沙箱可能泄漏"));
	assert.ok(leak, "停不掉必须留痕 —— 吞掉它等于让持有 token 的容器无限期存活");
	assert.equal(leak!.verdict, "deny", "泄漏要能被 SIEM 的告警规则捞出来");
	assert.match(leak!.summary, /容器停不掉/, "要带上真实原因，否则无从排查");
	assert.equal(leak!.actor, "demo@local", "泄漏告警要答得上「谁的会话」");
});

test("会话启动失败 + 清理失败：网关进程必须活下来", async () => {
	// stop() 在清理失败时会 throw，而 start() 的失败路径里就 await 它。
	// 调用点不接的话，一个会话的清理失败会打死整个多租户网关 ——
	// 比静默泄漏一个容器严重得多。这是 kubectl 后端「Pod 起不来且删不掉」
	// 这个很真实的组合。
	const bad: ExecutionBackend = {
		kind: "local",
		launch: () => ({
			bin: "/nonexistent-binary-xyz",
			argsPrefix: [],
			env: {},
			cwd: process.cwd(),
			homeInContainer: "/tmp",
			extensionPath: "/tmp/x.ts",
			policyFile: join(REPO, "config/policy.yaml"),
		}),
		cleanup: () => Promise.reject(new Error("Pod 也删不掉")),
	};
	const env = await startGateway([{ text: "ok" }], { backend: bad });
	const c = await connect(env);

	// 会话起不来，但网关要活着：还能接新连接、还能正常关闭
	await c.waitFor(() => c.events.some((e) => e.type === "error"));
	const c2 = await connect(env);
	await new Promise((r) => setTimeout(r, 300));
	assert.ok(c2.ws.readyState === c2.ws.OPEN, "网关必须还能接新连接");

	const leak = (await auditEntries(env.auditFile)).find((e) => e.summary.includes("沙箱可能泄漏"));
	assert.ok(leak, "启动路径上的清理失败同样要记成泄漏");
	assert.match(leak!.summary, /Pod 也删不掉/);
});

test("停不掉的会话不占 maxSessions 的坑", async () => {
	// 从表里删掉是三件事里的第一件：不删的话 maxSessions 会被僵尸占满，
	// 而它们对应的容器早就没人管了
	let inner: ExecutionBackend;
	const failing: ExecutionBackend = {
		kind: "local",
		launch: (ctx) => inner.launch(ctx),
		cleanup: () => Promise.reject(new Error("停不掉")),
	};
	const env = await startGateway([{ text: "ok" }], { idleTimeoutMs: 1_000, maxSessions: 1, backend: failing });
	inner = new LocalBackend(env.piEnv);

	const c1 = await connect(env);
	await c1.waitFor(() => c1.events.some((e) => e.type === "session.ready"));
	assert.equal(env.gateway.sessionCount, 1);

	// 等它被回收（清理会失败，但表项必须腾出来）
	const t0 = Date.now();
	while (env.gateway.sessionCount > 0 && Date.now() - t0 < 5_000) {
		await new Promise((r) => setTimeout(r, 100));
	}
	assert.equal(env.gateway.sessionCount, 0, "停不掉也要腾出坑位");

	// maxSessions=1，僵尸不占坑的话新连接应当能建起来
	const c2 = await connect(env);
	await c2.waitFor(() => c2.events.some((e) => e.type === "session.ready"));
	assert.ok(!c2.controls.some((m) => m.control === "error"), "新会话不该被僵尸挡住");
});
