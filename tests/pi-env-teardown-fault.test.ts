/**
 * teardown 结算硬化回归（vendor-faithful 故障注入；S2 SDK blocker 修复验证）。
 *
 * 修复对象：vendor/pi-env/patch/env-session-pin.patch 中 Connection#teardown——修复前 end()/kill()
 * 同步抛出会跳过「reject 全部 pending」结算（且 #session 先清导致重试 close no-op，pending 永悬）。
 * 修复后：结算在独立 finalizer 中执行，end/kill 同步抛不阻断彼此、不跳过 pending reject；
 * close 幂等；正常 sessionPin/G1 语义与协议零变化。
 *
 * vendor-faithful 口径：加载【真实安装】node_modules/@earendil-works/pi-env/dist/connection.js
 * （import 前逐字节 hash == vendor manifest.patched）与 vendor/pi-env/original/connection.js
 * （red 对照；hash == manifest.original）；唯一注入缝是 module resolve hook 把该模块的
 * `node:child_process` 导入重定向到受控 fake spawn——SDK 源码字节零改动。
 * 断言「pending 真 settled」：实际 await 全部 pending promise 的 reject（非只看首次抛错前的 fake 状态）。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { loadPatchManifest } from "../src/runtime/pi-env-patch.ts";

const REPO = join(import.meta.dirname, "..");
const INSTALLED = join(REPO, "node_modules", "@earendil-works", "pi-env", "dist", "connection.js");
const ORIGINAL = join(REPO, "vendor", "pi-env", "original", "connection.js");
const manifest = loadPatchManifest(REPO);

const sha256 = (s: string): string => createHash("sha256").update(readFileSync(s)).digest("hex");
assert.equal(sha256(INSTALLED), manifest.files["connection.js"]!.patched, "安装 dist 必须与 manifest.patched 一致（vendor-faithful 前置）");
assert.equal(sha256(ORIGINAL), manifest.files["connection.js"]!.original, "original 副本必须与 manifest.original 一致（red 对照前置）");

// ── 注入缝：fake child_process 模块（owned temp；resolve hook 仅对 connection.js 父模块生效）──

const tmp = mkdtempSync(join(tmpdir(), "teardown-fault-"));
const fakeModulePath = join(tmp, "fake-child-process.mjs");
writeFileSync(fakeModulePath, "export function spawn(p, a, o) { return globalThis.__piEnvFaultSpawn(p, a, o); }\nexport default { spawn };\n");

const deregister = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "node:child_process" && typeof context.parentURL === "string" && context.parentURL.includes("connection.js")) {
			return { url: pathToFileURL(fakeModulePath).href, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
}) as unknown as (() => void) | undefined;

interface FaultConfig { endThrows?: boolean; killThrows?: boolean }
let current: FaultConfig = {};

const FRAME_REQUEST = 1;
const FRAME_RESULT = 2;

function frameBytes(type: number, id: number, json: object): Buffer {
	const body = Buffer.from(JSON.stringify(json), "utf8");
	const header = Buffer.alloc(13);
	header.writeUInt32BE(9 + body.length, 0);
	header.writeUInt8(type, 4);
	header.writeUInt32BE(id, 5);
	header.writeUInt32BE(body.length, 9);
	return Buffer.concat([header, body]);
}

let childSeq = 0;

class FakeChild extends EventEmitter {
	pid: number;
	killCalls = 0;
	endCalls = 0;
	requestWrites = 0;
	argv: string[] = [];
	helloReplied = false;
	stdin: { write: (b: Buffer) => void; end: () => void; on: (e: string, fn: () => void) => void };
	stdout: EventEmitter;
	stderr: EventEmitter;

	cfg: FaultConfig;

	constructor(cfg: FaultConfig) {
		super();
		this.cfg = cfg;
		this.pid = 400_000 + (++childSeq % 100_000);
		const child = this;
		this.stdout = new EventEmitter();
		this.stderr = new EventEmitter();
		this.stdin = {
			write: (b: Buffer) => {
				// hello 请求（首个 REQUEST 帧）→ 回同步 marker + RESULT，模拟 daemon 握手
				if (b.readUInt8(4) === FRAME_REQUEST) {
					child.requestWrites += 1;
					if (!child.helloReplied) {
						child.helloReplied = true;
						const token = child.argv[child.argv.indexOf("--token") + 1] ?? "";
						const id = b.readUInt32BE(5);
						const payload = Buffer.concat([Buffer.from(`PI-ENV ${token}\n`, "utf8"), frameBytes(FRAME_RESULT, id, { protocol: 1 })]);
						setImmediate(() => child.stdout.emit("data", payload));
					}
				}
			},
			end: () => {
				child.endCalls += 1;
				if (child.cfg.endThrows) throw new Error("end fault injected");
			},
			on: () => {},
		};
	}
	kill(): boolean {
		this.killCalls += 1;
		if (this.cfg.killThrows) throw new Error("kill fault injected");
		return true;
	}
}

let lastChild: FakeChild | undefined;
(globalThis as unknown as { __piEnvFaultSpawn: unknown }).__piEnvFaultSpawn = (_program: string, args: string[]) => {
	const child = new FakeChild(current);
	child.argv = args;
	lastChild = child;
	return child;
};

interface ConnectionLike {
	session(): Promise<number>;
	request(op: string, json: object, options?: object): Promise<unknown>;
	close(): void;
}
type ConnectionModule = {
	Connection: new (o: { command: () => Promise<string[]> }) => ConnectionLike;
	RemoteError: abstract new (f: object) => Error;
};

const loadConnection = async (path: string, expectSha: string): Promise<ConnectionModule> => {
	assert.equal(sha256(path), expectSha);
	return await import(pathToFileURL(path).href + `?t=${Math.random().toString(36).slice(2)}`) as unknown as ConnectionModule;
};

const isClosedError = (RemoteError: ConnectionModule["RemoteError"]) => (e: unknown) => {
	assert.ok(e instanceof RemoteError, "必须是该模块的 RemoteError");
	assert.equal((e as Error).message, "Connection closed");
	return true;
};

const lostError = (e: unknown) => (e as { fields?: { lost?: boolean } }).fields?.lost === true;

const settledWithin = (p: Promise<unknown>, ms: number): Promise<boolean> =>
	Promise.race([p.then(() => true, () => true), new Promise<false>((r) => setTimeout(() => r(false), ms))]);

/** 让 request() 的 await #connect() 微任务真实完成：REQUEST 帧已写出、pending 已入队。
 *  不做这一步，同步 close() 会先于 #send 执行，pending 实际走的是 lost 快速拒绝——不是被测的结算路径。 */
const flushRequests = async (): Promise<void> => {
	for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r));
};

after(() => {
	if (typeof deregister === "function") deregister();
	rmSync(tmp, { recursive: true, force: true });
});

// ── 场景：end 同步抛 → close 不抛，全部 pending 被独立 finalizer reject，session 释放，close 幂等 ──

test("end() 同步抛出：close 不抛、pending 真 settled、session 释放、close 幂等", async () => {
	const mod = await loadConnection(INSTALLED, manifest.files["connection.js"]!.patched);
	current = { endThrows: true };
	const conn = new mod.Connection({ command: () => Promise.resolve(["/bin/false"]) });
	const sid = await conn.session();
	assert.equal(typeof sid, "number");
	const p1 = conn.request("exec", { argv: ["x"] });
	const p2 = conn.request("exec", { argv: ["y"] });
	await flushRequests();
	assert.ok(lastChild && lastChild.requestWrites >= 3, `真 pending 前置：hello+2 请求帧已写出（实际 ${lastChild?.requestWrites}）`);
	const closed = isClosedError(mod.RemoteError);
	assert.doesNotThrow(() => conn.close(), "end 抛出不得穿透 close()");
	await assert.rejects(p1, closed, "pending 1 必须被 settle");
	await assert.rejects(p2, closed, "pending 2 必须被 settle");
	// session 已释放：持旧 session 的请求立即 lost（不悬挂）
	await assert.rejects(conn.request("exec", {}, { session: sid }), lostError);
	// close 后不再重连
	await assert.rejects(conn.session(), closed);
	// 幂等：重复 close 不抛、无副作用
	assert.doesNotThrow(() => conn.close());
	assert.doesNotThrow(() => conn.close());
});

test("kill() 同步抛出：close 不抛、pending 真 settled、session 释放", async () => {
	const mod = await loadConnection(INSTALLED, manifest.files["connection.js"]!.patched);
	current = { killThrows: true };
	const conn = new mod.Connection({ command: () => Promise.resolve(["/bin/false"]) });
	const sid = await conn.session();
	const p1 = conn.request("exec", { argv: ["x"] });
	await flushRequests();
	assert.ok(lastChild && lastChild.requestWrites >= 2, `真 pending 前置（实际 ${lastChild?.requestWrites}）`);
	const closed = isClosedError(mod.RemoteError);
	assert.doesNotThrow(() => conn.close());
	await assert.rejects(p1, closed);
	await assert.rejects(conn.request("exec", {}, { session: sid }), lostError);
});

test("end 与 kill 均抛：两步清理都仍被尝试（失败不中断后续清理），pending 真 settled", async () => {
	const mod = await loadConnection(INSTALLED, manifest.files["connection.js"]!.patched);
	current = { endThrows: true, killThrows: true };
	const conn = new mod.Connection({ command: () => Promise.resolve(["/bin/false"]) });
	await conn.session();
	const p1 = conn.request("exec", { argv: ["x"] });
	const p2 = conn.request("exec", { argv: ["y"] });
	await flushRequests();
	assert.ok(lastChild && lastChild.requestWrites >= 3, `真 pending 前置（实际 ${lastChild?.requestWrites}）`);
	assert.doesNotThrow(() => conn.close());
	assert.ok(lastChild, "fake child 必须已创建");
	assert.equal(lastChild!.killCalls, 1, "end 抛出后 kill 仍被尝试");
	await assert.rejects(p1, isClosedError(mod.RemoteError));
	await assert.rejects(p2, isClosedError(mod.RemoteError));
});

test("无故障 close：pending 以 closed reject（原语义保持，不回归）", async () => {
	const mod = await loadConnection(INSTALLED, manifest.files["connection.js"]!.patched);
	current = {};
	const conn = new mod.Connection({ command: () => Promise.resolve(["/bin/false"]) });
	await conn.session();
	const p1 = conn.request("exec", { argv: ["x"] });
	await flushRequests();
	assert.ok(lastChild && lastChild.requestWrites >= 2, `真 pending 前置（实际 ${lastChild?.requestWrites}）`);
	conn.close();
	await assert.rejects(p1, isClosedError(mod.RemoteError));
});

test("red 对照（original 副本）：end 抛出时 close 抛错且 pending 永不 settle（修复前缺陷在案）", async () => {
	const mod = await loadConnection(ORIGINAL, manifest.files["connection.js"]!.original);
	current = { endThrows: true };
	const conn = new mod.Connection({ command: () => Promise.resolve(["/bin/false"]) });
	await conn.session();
	const p1 = conn.request("exec", { argv: ["x"] });
	await flushRequests();
	assert.ok(lastChild && lastChild.requestWrites >= 2, `真 pending 前置（实际 ${lastChild?.requestWrites}）`);
	assert.throws(() => conn.close(), /end fault injected/, "修复前：end 异常穿透 close()");
	const settledFast = await settledWithin(p1, 150);
	assert.equal(settledFast, false, "修复前：pending 永不被 reject（悬挂缺陷实证）");
	current = {};
});
