import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { AuditLog } from "../src/audit/log.ts";
import { Gateway } from "../src/gateway/server.ts";
import { GatewayLockError, LOCK_FILE_NAME } from "../src/gateway/state-lock.ts";
import type { ClientEvent } from "../src/protocol/types.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MOCK = join(REPO, "tests/fixtures/mock-model.mjs");
const TOKEN = "test-token";

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups.reverse()) await c();
});

function newGateway(stateRoot: string, extra: Partial<ConstructorParameters<typeof Gateway>[0]> = {}): Gateway {
	return new Gateway({
		mode: "demo",
		port: 0,
		host: "127.0.0.1",
		token: TOKEN,
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(stateRoot, "audit.jsonl"),
		workspaceRoot: join(stateRoot, "workspaces"),
		stateRoot,
		webRoot: join(REPO, "web"),
		...extra,
	});
}

async function startGateway(extra: Partial<ConstructorParameters<typeof Gateway>[0]> = {}): Promise<{ url: string; gateway: Gateway; stateRoot: string; auditFile: string }> {
	const stateRoot = mkdtempSync(join(tmpdir(), "s3a-"));
	const gateway = newGateway(stateRoot, extra);
	cleanups.push(() => gateway.close());
	const port = await gateway.listen();
	return { url: `http://127.0.0.1:${port}`, gateway, stateRoot, auditFile: join(stateRoot, "audit.jsonl") };
}

/** S3a-cd/drain-timeout 用：mock 模型 + 慢流式脚本，让会话真实处于 busy */
async function startGatewayWithModel(script: unknown[]): Promise<{ url: string; gateway: Gateway; stateRoot: string; auditFile: string }> {
	const mock: ChildProcess = spawn(process.execPath, [MOCK, "0", JSON.stringify(script)], { stdio: ["ignore", "pipe", "inherit"] });
	cleanups.push(() => void mock.kill());
	const mockPort: number = await new Promise((r, j) => {
		const timer = setTimeout(() => j(new Error("mock 模型启动超时")), 10_000);
		mock.stdout?.once("data", (d: Buffer) => { clearTimeout(timer); r(JSON.parse(d.toString()).port); });
	});
	return startGateway({ model: { baseUrl: `http://127.0.0.1:${mockPort}/v1`, token: "dummy", model: "mock-model" } });
}

interface Client {
	ws: WebSocket;
	events: ClientEvent[];
	controls: { control?: string; message?: string }[];
	waitFor: (pred: () => boolean, ms?: number) => Promise<void>;
	find: <T extends ClientEvent["type"]>(type: T) => Extract<ClientEvent, { type: T }> | undefined;
	send: (cmd: Record<string, unknown>) => void;
}

async function connect(url: string, query = ""): Promise<Client> {
	const ws = new WebSocket(`${url.replace("http", "ws")}/?token=${TOKEN}${query}`);
	const events: ClientEvent[] = [];
	const controls: { control?: string; message?: string }[] = [];
	ws.on("message", (raw) => {
		const msg = JSON.parse(String(raw));
		if (msg.type === "control") { controls.push(msg); return; }
		events.push(msg.event);
	});
	await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
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
		controls,
		waitFor,
		find: (type) => events.find((e) => e.type === type) as never,
		send: (cmd) => {
			const withId = ["prompt", "steer"].includes(String(cmd.type)) ? { requestId: `r-${Math.random().toString(36).slice(2)}`, ...cmd } : cmd;
			ws.send(JSON.stringify(withId));
		},
	};
}

async function auditEntries(file: string): Promise<{ kind: string; summary: string }[]> {
	const out: { kind: string; summary: string }[] = [];
	for await (const e of AuditLog.replay(file)) out.push(e);
	return out;
}

async function waitExit(child: ChildProcess, ms: number): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("子进程退出超时")), ms);
		child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
	});
}

function assertGroupDead(pid: number): void {
	// detached 子进程是进程组组长；kill(-pid,0) 返回 ESRCH 说明组内无残留进程
	let alive = true;
	let detail = "进程组内仍有残留进程";
	try {
		process.kill(-pid, 0);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ESRCH") alive = false;
		else detail = `进程组探测返回 ${code ?? String(err)}，期望 ESRCH`;
	}
	assert.equal(alive, false, detail);
}

test("S3a-a: 同 stateRoot 第二实例构造失败（固定类别），失败不留资源；close 后可重建", async () => {
	const env = await startGateway();
	const lockPath = join(env.stateRoot, LOCK_FILE_NAME);
	// 锁在位，内容含 pid/主机名/nonce/启动时间
	const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; hostname: string; nonce: string; startedAt: string };
	assert.equal(lock.pid, process.pid);
	assert.equal(lock.hostname, hostname());
	assert.equal(typeof lock.nonce, "string");
	assert.ok(lock.nonce.length > 0);
	assert.equal(typeof lock.startedAt, "string");
	// 第二实例（同 auditFile）：锁失败先于审计打开
	assert.throws(() => newGateway(env.stateRoot), GatewayLockError);
	// 第二实例（不同 auditFile）：锁失败，且不留任何已打开资源（审计锁文件不存在）
	const audit2 = join(env.stateRoot, "audit2.jsonl");
	assert.throws(() => newGateway(env.stateRoot, { auditFile: audit2 }), GatewayLockError);
	assert.equal(existsSync(`${audit2}.lock`), false, "锁失败不得留下审计锁文件");
	// 第一个实例不受影响
	const res = await fetch(`${env.url}/readyz`);
	assert.equal(res.status, 200);
	// close 释放锁后，第三实例可成功启动
	await env.gateway.close();
	assert.equal(existsSync(lockPath), false, "close 必须删除锁文件");
	const g3 = newGateway(env.stateRoot);
	const port = await g3.listen();
	assert.ok(port > 0);
	await g3.close();
	assert.equal(existsSync(lockPath), false);
});

test("S3a-b: 陈旧锁（同主机死 pid）原子接管；他机锁与损坏锁拒绝启动", async () => {
	// 制造一个确定的死 pid
	const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
	await new Promise((r) => dead.once("exit", r));
	const deadPid = dead.pid!;

	// 陈旧锁接管：同主机、pid 已不存在 → rename 隔离 + 独占重建
	const dir1 = mkdtempSync(join(tmpdir(), "s3a-stale-"));
	const lockPath = join(dir1, LOCK_FILE_NAME);
	const staleNonce = `stale-${Math.random().toString(36).slice(2)}`;
	writeFileSync(lockPath, JSON.stringify({ pid: deadPid, hostname: hostname(), nonce: staleNonce, startedAt: new Date().toISOString() }), { mode: 0o600 });
	const g1 = newGateway(dir1);
	cleanups.push(() => g1.close());
	await g1.listen();
	const current = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; nonce: string };
	assert.equal(current.pid, process.pid);
	assert.notEqual(current.nonce, staleNonce);
	assert.equal(existsSync(`${lockPath}.${staleNonce}.quarantine`), true, "旧锁必须被 rename 到带 nonce 的隔离名");
	await g1.close();
	assert.equal(existsSync(lockPath), false);

	// 他机锁：无法验证 pid 是否存活 → 拒绝启动，不自动接管
	const dir2 = mkdtempSync(join(tmpdir(), "s3a-host-"));
	const foreign = join(dir2, LOCK_FILE_NAME);
	writeFileSync(foreign, JSON.stringify({ pid: process.pid, hostname: "other-host.invalid", nonce: "x", startedAt: new Date().toISOString() }));
	assert.throws(() => newGateway(dir2), GatewayLockError);
	assert.equal(readFileSync(foreign, "utf8").includes("other-host.invalid"), true, "拒绝时不得改动他机锁");

	// 损坏锁：内容无法解析 → 拒绝启动，交运维处理
	const dir3 = mkdtempSync(join(tmpdir(), "s3a-corrupt-"));
	writeFileSync(join(dir3, LOCK_FILE_NAME), "not-json{");
	assert.throws(() => newGateway(dir3), GatewayLockError);
});

test("S3a-c: /livez 恒 200；/readyz 正常 200", async () => {
	const env = await startGateway();
	const live = await fetch(`${env.url}/livez`);
	assert.equal(live.status, 200);
	assert.equal(await live.text(), "ok");
	const ready = await fetch(`${env.url}/readyz`);
	assert.equal(ready.status, 200);
	assert.equal(await ready.text(), "ok");
	// 健康端点只给固定短文本，不得回显路径/配置/错误原文
	const again = await fetch(`${env.url}/readyz`);
	const body = await again.text();
	assert.ok(!body.includes("stateRoot") && !body.includes("/"));
});

test("S3a-cd: 运行中关闭 —— readyz 立即 503、livez 仍 200、新 WS 与新 prompt 被拒，任务在 drain 内完成", async () => {
	// 5 段 × 500ms 慢流：保证调用 shutdown 时会话真实 busy
	const env = await startGatewayWithModel([{ text: "", chunks: ["a", "b", "c", "d", "e"], delayMs: 500 }]);
	const c = await connect(env.url);
	await c.waitFor(() => c.find("session.ready") !== undefined);
	c.send({ type: "prompt", text: "跑一个慢任务" });
	await c.waitFor(() => c.events.some((e) => e.type === "agent.start"));

	const done = env.gateway.shutdown({ drainMs: 20_000 });
	// drain 窗口内：readiness 立即翻红，liveness 不受影响
	const ready = await fetch(`${env.url}/readyz`);
	assert.equal(ready.status, 503);
	assert.equal(await ready.text(), "not ready");
	const live = await fetch(`${env.url}/livez`);
	assert.equal(live.status, 200);
	// 新 WS 连接被拒（503，升级前拒绝）
	const blocked = new WebSocket(`${env.url.replace("http", "ws")}/?token=${TOKEN}`);
	await assert.rejects(
		new Promise((r, j) => { blocked.once("open", r); blocked.once("error", j); }),
		/503/,
	);
	// 原连接新 prompt 被拒：走既有 sendError→ClientEvent(error/command_failed) 通道
	//（与「无权执行命令/资源权限已撤销」同缝；仅解析前的失败才走 control 帧），仍断固定文本
	c.send({ type: "prompt", text: "这条应该被拒" });
	await c.waitFor(() => c.events.some((e) => e.type === "error" && e.code === "command_failed" && String(e.message).includes("网关正在关闭")));

	await done; // 任务在 drain 窗口内自然完成 → 干净关闭
	assert.equal(existsSync(join(env.stateRoot, LOCK_FILE_NAME)), false, "关闭后锁已释放");
	const entries = await auditEntries(env.auditFile);
	assert.ok(!entries.some((e) => e.summary.includes("关闭时未确定操作")), "drain 成功不得记未确定操作");
});

test("S3a-d: drain 超时 → 审计「关闭时未确定操作」并中止，审计链保持自洽", async () => {
	// 40 段 × 300ms = 12s 流式，drainMs 只有 500ms → 必然超时走 abort 收束
	const env = await startGatewayWithModel([{ text: "", chunks: Array.from({ length: 40 }, () => "x"), delayMs: 300 }]);
	const c = await connect(env.url);
	await c.waitFor(() => c.find("session.ready") !== undefined);
	c.send({ type: "prompt", text: "长任务" });
	await c.waitFor(() => c.events.some((e) => e.type === "agent.start"));

	await env.gateway.shutdown({ drainMs: 500 });
	const entries = await auditEntries(env.auditFile);
	const undetermined = entries.filter((e) => e.summary.includes("关闭时未确定操作"));
	assert.ok(undetermined.length >= 1, "drain 超时必须留下「未确定操作」审计");
	const verify = await AuditLog.verify(env.auditFile);
	assert.equal(verify.ok, true, "关闭过程的审计写入不得破坏哈希链");
	assert.equal(existsSync(join(env.stateRoot, LOCK_FILE_NAME)), false);
});

test("S3a-e: 子进程级 —— 网关主入口收到 SIGTERM 有界退出、锁清理、无残留进程", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s3a-proc-"));
	const child = spawn(process.execPath, [join(REPO, "src/gateway/server.ts")], {
		env: {
			...process.env,
			PERIMETER_MODE: "demo",
			PERIMETER_TOKEN: TOKEN,
			PORT: "0",
			PERIMETER_WORKSPACES: join(dir, "ws"),
			PERIMETER_AUDIT_FILE: join(dir, "audit.jsonl"),
		},
		stdio: ["ignore", "pipe", "pipe"],
		detached: true, // 独立进程组：退出后可整组检查残留
	});
	cleanups.push(() => { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } });
	// 入口把实际端口打到 stdout（demo 分支打印「网关已启动」）
	await new Promise<void>((resolve, reject) => {
		let buf = "";
		const timer = setTimeout(() => reject(new Error(`网关入口启动超时：${buf.slice(0, 300)}`)), 15_000);
		child.stdout!.on("data", (d: Buffer) => {
			buf += d.toString();
			if (buf.includes("网关已启动")) { clearTimeout(timer); resolve(); }
		});
		child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`网关入口提前退出，code=${code}`)); });
	});
	const lockPath = join(`${dir}/ws.state`, LOCK_FILE_NAME);
	assert.equal(existsSync(lockPath), true, "运行中的子进程必须持有锁");

	child.kill("SIGTERM");
	const code = await waitExit(child, 20_000);
	assert.equal(code, 0, "SIGTERM 有序关闭必须以 0 退出");
	assert.equal(existsSync(lockPath), false, "退出后锁文件必须被清理");
	assertGroupDead(child.pid!);
});
