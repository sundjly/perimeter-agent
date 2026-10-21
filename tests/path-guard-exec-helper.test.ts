/**
 * 方案B（受控 exec helper 路径守卫）专项测试。
 *
 * 核心证据链（全部真实进程/真实容器，非 fakePromise/自报完成）：
 * - NodeExecutionEnv 真实 helper：相对/绝对/多级新建文件回溯、~、file://、ELOOP、EACCES、词法 .. 外逃；
 * - 受控不响应 helper + 孙进程：exec timeout 与 in-flight abort 都真实杀进程组——
 *   精确出生/组身份核验（ps command marker）+ 死亡确认按 ≤3s 总 deadline 轮询（区分 活进程/zombie/PID复用），
 *   组空 + sentinel 无伤核心断言保留；
 * - 协议健壮性：非 0 退出/坏 JSON/缺字段/超量 stdout（按 UTF-8 字节，跨 chunk/多字节/临界负控）/类别越界 → fail-closed；
 * - G1（R4）：guard 路径零 info() await——无打开元数据的 Remote env 立即 fail-closed，不被 SDK 连接预算吞掉；
 * - Docker 真实 RPC：helper 在容器内跑，root=/workspace（namespace 归属正确，非宿主路径硬映射），
 *   容器内 kill 证明（/proc pid:state:pgid 轮询组空），取消后无新 pi-env 连接子进程尾巴，
 *   owned 容器 create→inspect→cleanup→inspect-gone 精确生命周期，daemon 断连如实 fail-closed。
 *
 * 边界（准确，不绝对化）：Local deny 返回时 helper 已真实退出（已证）；Remote deny 返回时组杀已由 daemon
 * 发起但客户端不 await 死亡确认（pending/unknown，R4 实测 close 路径 helper 晚 46ms 消失）；
 * 真实集群 Pod 的 kill/close 不在本文件验证范围（本地 docker mock），保持 unknown。
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DockerBackend, containerName } from "../src/gateway/execution-backend.ts";
import { PolicyEngine } from "../src/policy/engine.ts";
import { localEnvironment, remoteEnvHome } from "../src/runtime/execution-env.ts";
import { perimeterExtension } from "../src/runtime/perimeter-extension.ts";
import { PATH_GUARD_HELPER_CODE, createPathGuardResolver, execGuardHelper } from "../src/runtime/path-guard.ts";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const POLICY = join(REPO, "config/policy.yaml");
const IMAGE = "perimeter-sandbox:test";
const MINIMAL_ENV = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups) await c();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeWs(): string {
	return mkdtempSync(join(tmpdir(), "pg-helper-"));
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 组内已无任何进程（含孙进程）——精确 PGID 证据 */
function groupEmpty(pgid: number): boolean {
	try { process.kill(-pgid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
}

function psShows(pid: number): boolean {
	const r = spawnSync("ps", ["-o", "pid=", "-p", String(pid)], { timeout: 3000, encoding: "utf8" });
	return r.status === 0 && r.stdout.trim() !== "";
}

/** 等文件出现（受控 deadline，不裸 sleep 赌运气） */
async function waitForFile(path: string, ms: number): Promise<void> {
	const deadline = Date.now() + ms;
	while (!existsSync(path)) {
		if (Date.now() > deadline) throw new Error(`等待探针文件超时: ${path}`);
		await sleep(20);
	}
}

// ─────────────────────────────── helper 直测（node -e 静态代码） ───────────────────────────────

interface HelperVerdict { ok: boolean; canonical?: string; root?: string; error?: string }

function runHelper(raw: string, cwd: string, home: string): HelperVerdict {
	const r = spawnSync(process.execPath, ["-e", PATH_GUARD_HELPER_CODE, "--", raw], { cwd, env: { ...MINIMAL_ENV, HOME: home }, timeout: 10_000, encoding: "utf8" });
	assert.equal(r.status, 0, `helper 意外非零退出: status=${r.status} stderr=${r.stderr?.slice(0, 200)}`);
	const lines = r.stdout.trim().split("\n");
	assert.equal(lines.length, 1, `stdout 必须恰好一行: ${JSON.stringify(r.stdout.slice(0, 200))}`);
	return JSON.parse(lines[0]!);
}

test("helper：相对多级新建文件回溯到最近存在祖先，root=env cwd canonical", () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	mkdirSync(join(ws, "a"));
	writeFileSync(join(ws, "a", "exists.txt"), "x");
	const realWs = realpathSync(ws); // macOS /var → /private/var：helper 输出的是 realpath，这正是正确行为
	const v = runHelper("a/b/c/new.txt", ws, homedir());
	assert.equal(v.ok, true);
	assert.equal(v.canonical, join(realWs, "a", "b", "c", "new.txt"));
	assert.equal(v.root, realWs);
});

test("helper：symlink 命中即 canonical 化（逃逸可见，包含关系由守卫判定）", () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	symlinkSync("/etc/passwd", join(ws, "out"));
	const v = runHelper("out", ws, homedir());
	assert.equal(v.ok, true);
	assert.equal(v.canonical, realpathSync("/etc/passwd")); // /etc 是 macOS symlink，realpath 才是事实
	assert.equal(v.root, realpathSync(ws));
	assert.ok(!v.canonical!.startsWith(v.root! + "/"), "canonical 确实在 root 之外（外逃可检测）");
});

test("helper：~ 按 HOME 解析（多级新建也回溯）", () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	const realWs = realpathSync(ws);
	const v = runHelper("~/sub/dir/new.txt", ws, ws);
	assert.equal(v.ok, true);
	assert.equal(v.canonical, join(realWs, "sub", "dir", "new.txt"));
	assert.equal(v.root, realWs);
});

test("helper：file:// URL 按 fileURLToPath 解析", () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	writeFileSync(join(ws, "existing.txt"), "x");
	const v = runHelper(pathToFileURL(join(ws, "existing.txt")).href, ws, homedir());
	assert.equal(v.ok, true);
	assert.equal(v.canonical, realpathSync(join(ws, "existing.txt")));
});

test("helper：循环 symlink → not_supported（不回溯、不逃逸、不误判 allow）", () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	symlinkSync("loop", join(ws, "loop"));
	const v = runHelper("loop/x", ws, homedir());
	assert.equal(v.ok, false);
	assert.equal(v.error, "not_supported");
});

test("helper：词法 .. 解析成真实绝对路径（越界交给守卫）", () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	const v = runHelper("/etc/../etc/passwd", ws, homedir());
	assert.equal(v.ok, true);
	assert.equal(v.canonical, realpathSync("/etc/passwd"), "词法 .. 必须解析成真实绝对路径，不得按词法前缀判包含");
});

test("helper：NUL 不可能经 argv 到达；空串 → invalid", () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	const v = runHelper("", ws, homedir());
	assert.equal(v.ok, false);
	assert.equal(v.error, "invalid");
});

test("helper：父目录 EACCES → permission_denied（非 not_found，不回溯）", { skip: process.getuid?.() === 0 && "root 下 chmod 000 无效" }, () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	mkdirSync(join(ws, "closed"));
	chmodSync(join(ws, "closed"), 0o000);
	try {
		const v = runHelper("closed/secret.txt", ws, homedir());
		assert.equal(v.ok, false);
		assert.equal(v.error, "permission_denied");
	} finally {
		chmodSync(join(ws, "closed"), 0o755);
	}
});

// ─────────────────────────── execGuardHelper 协议健壮性（真实 env + 坏 helper） ───────────────────────────

async function execRaw(env: ExecutionEnv, code: string, home = homedir()) {
	return execGuardHelper(env, [process.execPath, "-e", code, "--", "unused"], { timeoutMs: 3000, home });
}

test("协议：helper 非 0 退出 → fail-closed unknown", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	const env = localEnvironment(ws, homedir());
	cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
	const v = await execRaw(env, "process.exit(3)");
	assert.deepEqual(v, { ok: false, error: "unknown" });
});

test("协议：坏 JSON → fail-closed unknown", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	const env = localEnvironment(ws, homedir());
	cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
	const v = await execRaw(env, 'console.log("not-json")');
	assert.deepEqual(v, { ok: false, error: "unknown" });
});

test("协议：缺字段/多字段/类别越界 → fail-closed（invalid/unknown）", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	const env = localEnvironment(ws, homedir());
	cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
	assert.deepEqual(await execRaw(env, 'console.log(JSON.stringify({ok:true}))'), { ok: false, error: "invalid" });
	assert.deepEqual(await execRaw(env, 'console.log(JSON.stringify({ok:true,canonical:"/x",root:"/y",extra:1}))'), { ok: false, error: "invalid" });
	assert.deepEqual(await execRaw(env, 'console.log(JSON.stringify({ok:true,canonical:"rel",root:"/y"}))'), { ok: false, error: "invalid" });
	assert.deepEqual(await execRaw(env, 'console.log(JSON.stringify({ok:false,error:"not-a-category"}))'), { ok: false, error: "unknown" });
});

test("协议：超量 stdout → fail-closed unknown（不缓冲无限内容）", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	const env = localEnvironment(ws, homedir());
	cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
	const v = await execRaw(env, 'console.log("x".repeat(200000))');
	assert.deepEqual(v, { ok: false, error: "unknown" });
});

// ── G2（R4）：stdout 上限必须按 UTF-8 字节计（跨 chunk/多字节/临界 + ASCII 负控） ──

/** verdict 的 canonical 以 k 个「路」结尾，整行 JSON 恰好 targetBytes UTF-8 字节（运行时解出 k 并断言整除） */
function exactByteVerdict(targetBytes: number): { verdict: { ok: true; canonical: string; root: string; stats: null }; line: string; k: number } {
	const base = JSON.stringify({ ok: true, canonical: "/ws/", root: "/ws", stats: null });
	const baseBytes = Buffer.byteLength(base, "utf8");
	const remaining = targetBytes - baseBytes;
	assert.ok(remaining >= 0, `目标字节数必须不小于基础行：${targetBytes - baseBytes}`);
	// ASCII 垫字节放在多字节段之前：任意目标字节数都能精确对齐（stats 字段加入后基础行字节数已变）
	const k = Math.floor(remaining / 3);
	const pad = remaining - k * 3;
	const verdict = { ok: true, canonical: "/ws/" + "x".repeat(pad) + "路".repeat(k), root: "/ws", stats: null } as const;
	const line = JSON.stringify(verdict);
	assert.equal(Buffer.byteLength(line, "utf8"), targetBytes, "构造行字节数必须精确");
	return { verdict, line, k };
}

test("G2：恰好 4096 UTF-8 字节（多字节 canonical，跨 chunk 且多字节字符被字节级劈开）→ 正常解析", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	const env = localEnvironment(ws, homedir());
	cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
	const { verdict, line, k } = exactByteVerdict(4096);
	// 行结构：prefix(ASCII) + 「路」×k + suffix(`","root":"/ws"}`)。五次 write：prefix / 劈开的「路」2+1 字节 /
	// 其余 k-1 个「路」+ suffix——SDK decoder 必须重组，字节计账精确 = 4096
	const suffix = line.slice(line.length - 28);
	assert.equal(suffix, `","root":"/ws","stats":null}`, "行尾结构假设变化时必须更新本测试");
	const prefix = line.slice(0, line.length - k - 28);
	const rest = line.slice(prefix.length + 1); // 劈开的第一个「路」之后：(k-1)×「路」+ suffix
	const code = `process.stdout.write(${JSON.stringify(prefix)});` +
		`process.stdout.write(Buffer.from([0xe8,0xb7]));process.stdout.write(Buffer.from([0xaf]));` +
		`process.stdout.write(${JSON.stringify(rest)});`;
	const v = await execRaw(env, code);
	assert.deepEqual(v, verdict, `恰好 4096 字节必须被接受：${JSON.stringify(v).slice(0, 120)}`);
});

test("G2：4097 字节（+1 ASCII 临界）与 9000 字节级多字节（<4096 UTF-16 单元）→ 一律 overflow unknown", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	const env = localEnvironment(ws, homedir());
	cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
	// +1 字节临界：canonical 尾部多一个 ASCII 字符
	const { verdict, line, k } = exactByteVerdict(4096);
	const bigger = JSON.stringify({ ...verdict, canonical: verdict.canonical + "x" });
	assert.equal(Buffer.byteLength(bigger, "utf8"), 4097, "构造行必须是 4097 字节");
	assert.deepEqual(await execRaw(env, `console.log(${JSON.stringify(bigger)});`), { ok: false, error: "unknown" }, "4097 字节必须 overflow");
	// R4 负控：2900×路 的 canonical ≈ 8700+ 字节但 UTF-16 单元远小于 4096——旧按单元计会误接受
	//（stats:null 四字段协议形态；三字段旧协议形态现在会以 invalid 拒，不再构成 overflow 负控）
	const nineK = JSON.stringify({ ok: true, canonical: "/ws/" + "路".repeat(2900), root: "/ws", stats: null });
	assert.ok(Buffer.byteLength(nineK, "utf8") > 4096 && nineK.length < 4096, "负控行必须 字节>4096 且 单元<4096");
	assert.deepEqual(await execRaw(env, `console.log(${JSON.stringify(nineK)});`), { ok: false, error: "unknown" }, "9000 字节级输出必须 overflow（不得按 UTF-16 单元计）");
	void k; void verdict; void line;
});

// ───────────────── NodeExecutionEnv 集成：真实 helper + 守卫（extension beforeTool） ─────────────────

// 【恢复说明】本节（makeRealExtension + 3 项集成测试）在 R5 G2 块重写时被锚点切片静默删除
//（grok-s2-protected-paths-slice-a-round-5.md §5 required 跟进），现从本会话首写版逐字恢复：
// fixture 与断言均与原版一致，未降断言、未改产品 src。等效 e2e 覆盖另见 tests/protected-paths.test.ts。

function makeRealExtension(envFactory: () => ExecutionEnv, guardTimeoutMs = 3000) {
	const audits: any[] = [];
	const emitted: any[] = [];
	const extension = perimeterExtension({
		repo: "r", team: "t",
		policy: PolicyEngine.fromYaml(readFileSync(POLICY, "utf8")),
		actor: async () => "alice",
		approvals: () => { throw new Error("不应到达审批"); },
		approvalTimeoutMs: 1000,
		audit: (input) => audits.push(input),
		emit: (e) => emitted.push(e),
		resolveGuardPath: createPathGuardResolver(envFactory, guardTimeoutMs),
		guardTimeoutMs,
	});
	const hook = (extension.hooks as readonly { task: string; handlers: { beforeTool: (call: unknown, api: unknown, ctx: unknown) => Promise<{ block?: string } | undefined> } }[])
		.find((h) => h.task === "pi.tool");
	assert.ok(hook, "必须能取到 pi.tool 钩子");
	return { beforeTool: hook.handlers.beforeTool, audits, emitted };
}

test("集成（Local 真实 helper）：多级新建文件不误拒，写路径守卫放行", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	const env = localEnvironment(ws, homedir());
	cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
	const { beforeTool } = makeRealExtension(() => env);
	const result = await beforeTool({ id: "c1", name: "write", arguments: { path: "src/deep/new/dir/file.txt", content: "x" } }, {}, { abortSignal: new AbortController().signal });
	assert.equal(result, undefined, `普通多级新建不得被拒：${JSON.stringify(result)}`);
});

test("集成（Local 真实 helper）：绝对路径在 workspace 内放行", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	const env = localEnvironment(ws, homedir());
	cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
	const { beforeTool } = makeRealExtension(() => env);
	const result = await beforeTool({ id: "c1", name: "write", arguments: { path: join(ws, "abs.txt"), content: "x" } }, {}, { abortSignal: new AbortController().signal });
	assert.equal(result, undefined, `workspace 内绝对路径不得被拒：${JSON.stringify(result)}`);
});

test("集成（Local 真实 helper）：symlink 外逃 / 循环 / NUL / ~ 越界 全部 fail-closed deny", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	symlinkSync("/etc/passwd", join(ws, "out"));
	symlinkSync("loop", join(ws, "loop"));
	const env = localEnvironment(ws, homedir());
	cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
	const { beforeTool, emitted } = makeRealExtension(() => env);
	const call = (path: string, id: string) => beforeTool({ id, name: "write", arguments: { path, content: "x" } }, {}, { abortSignal: new AbortController().signal });
	const escape = await call("out", "e1");
	assert.ok(escape?.block?.includes("越界"), `symlink 外逃必须拒绝：${escape?.block}`);
	const loop = await call("loop/x", "e2");
	assert.ok(loop?.block?.includes("fail-closed") && loop.block.includes("not_supported"), `ELOOP 必须 fail-closed：${loop?.block}`);
	const nul = await call("a\u0000b.txt", "e3");
	assert.ok(nul?.block?.includes("NUL"), `NUL 必须拒绝：${nul?.block}`);
	const tilde = await call("~/pg-escape-new.txt", "e4");
	assert.ok(tilde?.block?.includes("越界"), `~ 解析到宿主 HOME 必须越界拒绝：${tilde?.block}`);
	assert.ok((emitted as any[]).every((e) => e.type !== "policy.denied" || !JSON.stringify(e).includes(homedir())), "denied 事件不得携带宿主路径");
});

test("G1（R4）：guard 路径零 info() await——无打开元数据的 Remote env 立即 fail-closed，不被 SDK 连接预算吞掉", async () => {
	// 永不应答的 daemon 命令：R4 场景下走 info() 会耗 ~30s SDK 静默预算；现在守卫路径必须同步失败
	const con = new Connection({ command: [process.execPath, "-e", "setInterval(()=>{},1000)"] });
	cleanups.push(() => con.close());
	const env = new RemoteExecutionEnv({ connection: con, id: "g1-inrepo", cwd: "/workspace" });
	// 不经 openEnvironment → remoteEnvHome 无缓存 → resolver 必须立即 reject
	const resolver = createPathGuardResolver(() => env, 3000);
	const started = Date.now();
	await assert.rejects(resolver("x.txt"), (e: NodeJS.ErrnoException) => (e as { code?: string }).code === "unknown");
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 3500, `guard 路径不得等待 SDK 连接预算（实测 ${elapsed}ms，R4 缺口为 30014ms）`);
});

// ───────────────────── kill 证明（Local 真实进程：timeout 与 in-flight abort） ─────────────────────

/** 受控探针：写 PID 文件后挂起，并派生同组孙进程（kill 证明要求精确 PID/PGID 消失）。
 * argv 内嵌唯一 marker：ps command 身份核验用——区分 活进程/zombie/PID 被无关进程复用。 */
const HANG_MARKER_PARENT = "/*pg-hang-probe*/";
const HANG_MARKER_CHILD = "/*pg-hang-child*/";
const HANG_HELPER_CODE = HANG_MARKER_PARENT + 'const fs=require("node:fs");const{spawn}=require("node:child_process");' +
	`const child=spawn(process.execPath,["-e","${HANG_MARKER_CHILD}setInterval(()=>{},100)"],{stdio:"ignore"});` +
	'fs.writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,child:child.pid}));' +
	'setInterval(()=>{},1000);';

interface ProbePids { parent: number; child: number; pgid: number }

async function readLocalProbe(file: string): Promise<ProbePids> {
	// R1：有界轮询直到内容可解析为合法 schema 的完整 JSON（写入中/部分写入不算就绪），非法完整数据报真实失败
	const deadline = Date.now() + 10_000;
	let probe: { parent: number; child: number } | undefined;
	let lastError: unknown;
	for (;;) {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as { parent?: unknown; child?: unknown };
			if (typeof parsed.parent === "number" && Number.isInteger(parsed.parent) && parsed.parent > 0
				&& typeof parsed.child === "number" && Number.isInteger(parsed.child) && parsed.child > 0) {
				probe = { parent: parsed.parent, child: parsed.child };
				break;
			}
			lastError = new Error(`schema 非法: ${JSON.stringify(parsed).slice(0, 120)}`);
		} catch (e) {
			lastError = e; // 部分写入/尚不可解析：继续轮询到 deadline
		}
		if (Date.now() > deadline) {
			throw new Error(`10s 内未读到完整合法探针 JSON: ${String(lastError).slice(0, 160)}`);
		}
		await sleep(20);
	}
	const { parent, child } = probe!;
	// 精确出生/组身份：ps 查 stat+command，marker 必须匹配，且 helper 必须是进程组长（pgid==pid）
	const p = psProc(parent, HANG_MARKER_PARENT);
	const c = psProc(child, HANG_MARKER_CHILD);
	assert.equal(p.state, "alive", `helper ${parent} 出生核验失败: ${p.state}`);
	assert.equal(c.state, "alive", `孙进程 ${child} 出生核验失败: ${c.state}`);
	const ps = spawnSync("ps", ["-o", "pgid=", "-p", String(parent)], { timeout: 3000, encoding: "utf8" });
	assert.equal(ps.status, 0, `探针进程 ${parent} 应存活且 ps 可查`);
	const pgid = Number(ps.stdout.trim());
	assert.equal(pgid, parent, "helper 由 exec detached 派生，必须是进程组长（pgid==pid）");
	return { parent, child, pgid };
}

/** ps 身份查证：gone=不存在或 PID 已被无关进程复用；zombie=已死未收割；alive=带 marker 的运行态 */
function psProc(pid: number, marker: string): { state: "gone" | "zombie" | "alive"; command: string } {
	const r = spawnSync("ps", ["-o", "stat=,command=", "-p", String(pid)], { timeout: 3000, encoding: "utf8" });
	if (r.status !== 0 || r.stdout.trim() === "") return { state: "gone", command: "" };
	const t = r.stdout.trim();
	const sp = t.indexOf(" ");
	const stat = sp === -1 ? t : t.slice(0, sp);
	const command = sp === -1 ? "" : t.slice(sp + 1);
	if (stat.startsWith("Z")) return { state: "zombie", command };
	if (!command.includes(marker)) return { state: "gone", command }; // PID 复用：原进程确已不在
	return { state: "alive", command };
}

/** 死亡确认：≤deadlineMs 总轮询，两个精确 PID 都不再是带 marker 的活进程（zombie=已死，仅未收割） */
async function waitForKilled(probe: ProbePids, deadlineMs = 3000): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		const p = psProc(probe.parent, HANG_MARKER_PARENT);
		const c = psProc(probe.child, HANG_MARKER_CHILD);
		if (p.state !== "alive" && c.state !== "alive") return;
		if (Date.now() > deadline) {
			throw new Error(`${deadlineMs}ms 内未确认死亡：parent=${p.state}:${p.command.slice(0, 60)} child=${c.state}:${c.command.slice(0, 60)}`);
		}
		await sleep(25);
	}
}

function groupMembers(pgid: number): { pid: number; stat: string; command: string }[] {
	const r = spawnSync("ps", ["-eo", "pid=,pgid=,stat=,command="], { timeout: 3000, encoding: "utf8" });
	assert.equal(r.status, 0, "ps 全表扫描失败");
	const out: { pid: number; stat: string; command: string }[] = [];
	for (const line of r.stdout.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
		if (m && Number(m[2]) === pgid) out.push({ pid: Number(m[1]), stat: m[3]!, command: m[4] ?? "" });
	}
	return out;
}

/** 组空确认：≤deadlineMs 总轮询；zombie 视为已死但仍要求收割完成（父死 → launchd 立即收割，3s 充裕） */
async function waitForGroupEmpty(pgid: number, deadlineMs = 3000): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		const members = groupMembers(pgid);
		if (members.length === 0) return;
		if (Date.now() > deadline) {
			const brief = members.map((m) => `${m.pid}:${m.stat}:${m.command.slice(0, 40)}`).join(" | ");
			throw new Error(`进程组 ${pgid} 在 ${deadlineMs}ms 后仍非空（zombie 也算未收尾）: ${brief}`);
		}
		await sleep(25);
	}
}

/** 不相关 sentinel：独立进程组，证明组杀不伤无辜 */
async function startSentinel(dir: string): Promise<{ pid: number; stop: () => Promise<void> }> {
	const file = join(dir, "sentinel.pid");
	const child = spawn(process.execPath, ["-e", 'const fs=require("node:fs");fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);', "--", file], { stdio: "ignore", detached: true });
	await waitForFile(file, 10_000);
	const pid = Number(readFileSync(file, "utf8"));
	assert.ok(alive(pid), "sentinel 必须存活");
	return {
		pid,
		stop: async () => {
			try { child.kill("SIGKILL"); } catch {}
			await new Promise<void>((r) => { const t = setTimeout(r, 2000); child.once("exit", () => { clearTimeout(t); r(); }); });
		},
	};
}

test("kill 证明（Local）：exec timeout 真实杀 helper 组，精确 PID/PGID 消失，sentinel 无伤，await 真实收尾", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	const env = localEnvironment(ws, homedir());
	cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
	const probeFile = join(ws, "probe.json");
	const sentinel = await startSentinel(ws);
	cleanups.push(sentinel.stop);

	const started = Date.now();
	const pending = execGuardHelper(env, [process.execPath, "-e", HANG_HELPER_CODE, "--", probeFile], { timeoutMs: 1000, home: homedir() });
	const probe = await readLocalProbe(probeFile);
	assert.ok(alive(probe.parent) && alive(probe.child), "超时前 helper 与孙进程都应存活");
	const verdict = await pending;
	const elapsed = Date.now() - started;

	assert.deepEqual(verdict, { ok: false, error: "deadline" });
	assert.ok(elapsed >= 900, `必须真实等待 exec timeout（实际 ${elapsed}ms，早返回嫌疑）`);
	assert.ok(elapsed < 10_000, `timeout 后必须及时收尾（实际 ${elapsed}ms）`);
	// 精确证据：父、孙、进程组全部消失——≤3s 总 deadline 轮询确认（区分 活进程/zombie/PID复用），不立即断言、不固定 sleep
	await waitForKilled(probe);
	await waitForGroupEmpty(probe.pgid);
	assert.ok(alive(sentinel.pid), "sentinel 必须无伤");
});

test("kill 证明（Local）：in-flight abort 真实杀 helper 组（不等 exec timeout 到点）", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	const env = localEnvironment(ws, homedir());
	cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
	const probeFile = join(ws, "probe.json");
	const sentinel = await startSentinel(ws);
	cleanups.push(sentinel.stop);

	const controller = new AbortController();
	const started = Date.now();
	const pending = execGuardHelper(env, [process.execPath, "-e", HANG_HELPER_CODE, "--", probeFile], { timeoutMs: 30_000, signal: controller.signal, home: homedir() });
	const probe = await readLocalProbe(probeFile);
	controller.abort();
	const verdict = await pending;
	const elapsed = Date.now() - started;

	assert.deepEqual(verdict, { ok: false, error: "aborted" });
	assert.ok(elapsed < 15_000, `abort 必须 promptly 杀组收尾，不得等满 30s exec timeout（实际 ${elapsed}ms）`);
	await waitForKilled(probe);
	await waitForGroupEmpty(probe.pgid);
	assert.ok(alive(sentinel.pid), "sentinel 必须无伤");
});

// ───────────────────────── Docker 真实 RPC：容器内 helper、namespace 根、容器内 kill 证明 ─────────────────────────

async function dockerReady(): Promise<boolean> {
	const v = spawnSync("docker", ["version"], { timeout: 4000, encoding: "utf8", stdio: "ignore" });
	if (v.status !== 0) return false;
	const img = spawnSync("docker", ["image", "inspect", IMAGE], { timeout: 4000, stdio: "ignore" });
	return img.status === 0;
}

interface DockerFixture { backend: DockerBackend; handle: { env: ExecutionEnv; guardEnv?: ExecutionEnv; close(): Promise<void> }; sessionId: string; wsHost: string; home: string; exec(cmd: string, timeoutMs?: number): Promise<{ code: number; stdout: string }> }

async function startDockerEnv(tag: string): Promise<DockerFixture> {
	const wsHost = makeWs();
	const backend = new DockerBackend({ image: IMAGE, repoRoot: REPO, network: "none", gatewayId: `pgx${process.pid}${tag}` });
	const sessionId = `pg-${tag}`;
	const handle = await backend.environment({ sessionId, workspace: wsHost, home: undefined, extensionPath: "", policyFile: "", env: {} });
	const name = containerName(sessionId, `pgx${process.pid}${tag}`);
	// 精确 owned 生命周期 create→inspect：打开后容器必须可按精确名 inspect（不算全局/label 计数）
	const up = spawnSync("docker", ["inspect", name], { timeout: 5000, stdio: "ignore" });
	assert.equal(up.status, 0, `owned 容器 ${name} 打开后必须可 inspect`);
	// G1：打开时元数据已入 remoteEnvHome 缓存；fixture 从缓存读 home（证明 guard 路径无需再 info()）
	const cachedHome = remoteEnvHome.get(handle.env);
	assert.ok(typeof cachedHome === "string" && cachedHome !== "", "openEnvironment 必须在打开时缓存 daemon home");
	const home = cachedHome!;
	let closed = false;
	const closeOnce = async () => {
		if (closed) return;
		closed = true;
		await handle.close();
		await backend.cleanup(sessionId);
		// cleanup→gone：精确名 inspect 确认消失；仍在则记 unconfirmed 并显式失败（不按 label/名称强杀、不忽略）
		const gone = spawnSync("docker", ["inspect", name], { timeout: 5000, stdio: "ignore" });
		if (gone.status === 0) throw new Error(`owned 容器清理后仍存在（unconfirmed，需人工 reconcile）: ${name}`);
		rmSync(wsHost, { recursive: true, force: true });
	};
	cleanups.push(closeOnce);
	return {
		backend, handle, sessionId, wsHost, home,
		exec: (cmd, timeoutMs = 8000) => backend.exec(sessionId, wsHost, cmd, timeoutMs),
	};
}

/** 容器内进程证据：/proc 扫描 pid:state:pgid 全表（busybox awk），比 ps 更贴近内核事实 */
async function containerStatTable(fx: DockerFixture): Promise<Map<number, { stat: string; pgid: number }>> {
	const r = await fx.exec("for f in /proc/[0-9]*/stat; do awk '{print $1\":\"$3\":\"$5}' \"$f\" 2>/dev/null; done; true");
	assert.equal(r.code, 0, `容器内 /proc 扫描失败: ${r.stdout.slice(0, 200)}`);
	const table = new Map<number, { stat: string; pgid: number }>();
	for (const line of r.stdout.split("\n")) {
		const m = /^(\d+):(\S+):(\d+)$/.exec(line.trim());
		if (m) table.set(Number(m[1]), { stat: m[2]!, pgid: Number(m[3]) });
	}
	return table;
}

/** 该会话连接的 pi-env 客户端子进程数（精确容器名匹配；before/after 相等=取消未产生新连接尾巴） */
function piEnvClientCount(name: string): number {
	const r = spawnSync("ps", ["-eo", "command="], { timeout: 3000, encoding: "utf8" });
	assert.equal(r.status, 0, "ps 扫描失败");
	return r.stdout.split("\n").filter((l) => l.includes(name) && l.includes(" pi-env") && !l.includes("ps -eo")).length;
}

async function readContainerProbe(fx: DockerFixture, file: string): Promise<ProbePids> {
	const deadline = Date.now() + 15_000;
	let out = "";
	while (Date.now() < deadline) {
		const r = await fx.exec(`cat ${file} 2>/dev/null; true`);
		out = r.stdout.trim();
		if (out !== "") break;
		await sleep(100);
	}
	assert.notEqual(out, "", `容器内探针文件未出现: ${file}`);
	const { parent, child } = JSON.parse(out) as { parent: number; child: number };
	const r = await fx.exec(`awk '{print $5}' /proc/${parent}/stat 2>/dev/null; true`);
	const pgid = Number(r.stdout.trim());
	assert.ok(Number.isInteger(pgid) && pgid > 0, `helper ${parent} 应存活且可读 pgid`);
	return { parent, child, pgid };
}

/** 组空确认：≤3s 总 deadline 轮询 /proc；Z(zombie)=已死仍要求 daemon 收割完成（父进程为 pi-env daemon，会 reap） */
async function assertGroupGoneInContainer(fx: DockerFixture, probe: ProbePids): Promise<void> {
	const deadline = Date.now() + 3000;
	for (;;) {
		const table = await containerStatTable(fx);
		const stillPids = [probe.parent, probe.child].filter((pid) => table.has(pid));
		const liveInGroup = [...table.entries()].filter(([pid, e]) => e.pgid === probe.pgid && !e.stat.startsWith("Z")).map(([pid]) => pid);
		if (stillPids.length === 0 && liveInGroup.length === 0) return;
		if (Date.now() > deadline) {
			throw new Error(`容器内 3s 后组未收尾: stillPids=${JSON.stringify(stillPids)} liveInGroup=${JSON.stringify(liveInGroup)}`);
		}
		await sleep(50);
	}
}

test("Docker：真实 helper 经 RPC 在容器内解析；root=/workspace（同 namespace，非宿主路径）", { skip: !(await dockerReady()) && "docker 或镜像不可用" }, async () => {
	const fx = await startDockerEnv("ns");
	// G1：守卫解析必须走 pinned guardEnv（unpinned 远端 env 被能力守卫拒绝）
	assert.ok(fx.handle.guardEnv, "Docker 会话必须提供 pinned guardEnv");
	const resolver = createPathGuardResolver(() => fx.handle.guardEnv!, 5000);
	const rel = await resolver("src/deep/new/dir/file.txt");
	assert.equal(rel.root, "/workspace", "root 必须是容器内 env cwd 的 canonical");
	assert.notEqual(rel.root, fx.wsHost, "禁止宿主路径硬映射");
	assert.equal(rel.canonical, "/workspace/src/deep/new/dir/file.txt", "多级新建回溯在容器 namespace 内完成");
	const abs = await resolver("/workspace/abs-new.txt");
	assert.equal(abs.canonical, "/workspace/abs-new.txt");
	// 越界可见性：容器内 symlink 到 /etc/passwd → canonical 逃出 root（守卫据此 deny）
	symlinkSync("/etc/passwd", join(fx.wsHost, "out"));
	const escape = await resolver("out");
	assert.equal(escape.canonical, "/etc/passwd");
	assert.ok(!escape.canonical.startsWith(escape.root + "/"));
});

test("Docker：RPC exec timeout 真实杀容器内 helper 组 + 健康后续请求正控", { skip: !(await dockerReady()) && "docker 或镜像不可用" }, async () => {
	const fx = await startDockerEnv("t1");
	const probeFile = "/tmp/pg-probe-t1.json";
	const name = containerName(fx.sessionId, `pgx${process.pid}t1`);
	const clientsBefore = piEnvClientCount(name);
	const started = Date.now();
	const pending = execGuardHelper(fx.handle.env, ["node", "-e", HANG_HELPER_CODE, "--", probeFile], { timeoutMs: 2000, home: fx.home });
	const probe = await readContainerProbe(fx, probeFile);
	const verdict = await pending;
	const elapsed = Date.now() - started;
	assert.deepEqual(verdict, { ok: false, error: "deadline" });
	assert.ok(elapsed >= 1900, `必须真实等待 RPC timeout（实际 ${elapsed}ms）`);
	assert.ok(elapsed < 30_000, `timeout 后必须及时收尾（实际 ${elapsed}ms）`);
	await assertGroupGoneInContainer(fx, probe);
	assert.equal(piEnvClientCount(name), clientsBefore, "取消后不得出现新的 pi-env 连接子进程尾巴");
	// 健康后续：同一 daemon 上普通守卫（pinned，同会话存活）解析与普通 exec 都正常（cleanup 未伤会话）
	assert.ok(fx.handle.guardEnv, "Docker 会话必须提供 pinned guardEnv");
	const resolver = createPathGuardResolver(() => fx.handle.guardEnv!, 5000);
	const after = await resolver("followup/new.txt");
	assert.equal(after.canonical, "/workspace/followup/new.txt");
	const echo = await fx.exec("echo ok-after-kill");
	assert.equal(echo.code, 0);
	assert.match(echo.stdout, /ok-after-kill/);
});

test("Docker：in-flight abort 真实杀容器内 helper 组（不等 daemon timeout）", { skip: !(await dockerReady()) && "docker 或镜像不可用" }, async () => {
	const fx = await startDockerEnv("t2");
	const probeFile = "/tmp/pg-probe-t2.json";
	const name = containerName(fx.sessionId, `pgx${process.pid}t2`);
	const clientsBefore = piEnvClientCount(name);
	const controller = new AbortController();
	const started = Date.now();
	const pending = execGuardHelper(fx.handle.env, ["node", "-e", HANG_HELPER_CODE, "--", probeFile], { timeoutMs: 30_000, signal: controller.signal, home: fx.home });
	const probe = await readContainerProbe(fx, probeFile);
	controller.abort();
	const verdict = await pending;
	const elapsed = Date.now() - started;
	assert.deepEqual(verdict, { ok: false, error: "aborted" });
	assert.ok(elapsed < 15_000, `abort 必须 promptly 收尾（实际 ${elapsed}ms）`);
	await assertGroupGoneInContainer(fx, probe);
	assert.equal(piEnvClientCount(name), clientsBefore, "取消后不得出现新的 pi-env 连接子进程尾巴");
});

test("Docker：daemon 断连（容器停止）→ deny fail-closed；返回时点 helper 死亡为 pending（随容器生命周期收尾），不虚报单请求已结束", { skip: !(await dockerReady()) && "docker 或镜像不可用" }, async () => {
	const fx = await startDockerEnv("t3");
	const probeFile = "/tmp/pg-probe-t3.json";
	const pending = execGuardHelper(fx.handle.env, ["node", "-e", HANG_HELPER_CODE, "--", probeFile], { timeoutMs: 60_000, home: fx.home });
	await readContainerProbe(fx, probeFile);
	const name = containerName(fx.sessionId, `pgx${process.pid}t3`);
	const stop = spawnSync("docker", ["stop", name], { timeout: 30_000, encoding: "utf8" });
	assert.equal(stop.status, 0, `docker stop 失败: ${stop.stderr}`);
	// exec 请求必须真实 settle（断连/杀组结果如实带回），有界等待防悬挂
	const verdict = await Promise.race([
		pending,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("断连后 exec 60s 未 settle——真实收尾证据缺失")), 30_000)),
	]);
	assert.equal(verdict.ok, false, "断连必须 fail-closed（不是成功）");
	// 边界（R4/G3）：close 路径的返回由 daemon 断连/生命周期兜底驱动，单请求粒度的 helper 死亡确认
	// 不由客户端 await——此处不断言 helper 已死于 settle 前（R4 实测 settle 后 46ms 才消失）。
	// 容器随 stop 生命周期收尾（非单请求证明），有界轮询确认 owned 容器消失，由 closeOnce 的 inspect 复核。
});

// ── B1：helper stats 投影 + 硬链接保守拒 ─────────────────────

test("B1 helper：真实存在目标返回 stats{nlink,dir}；新建文件（回溯解析）stats=null", () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	writeFileSync(join(ws, "plain.txt"), "x");
	mkdirSync(join(ws, "adir"));
	const file = runHelper("plain.txt", ws, ws) as { ok: boolean; stats?: { nlink: number; dir: boolean } | null };
	assert.equal(file.ok, true);
	assert.ok(file.stats && file.stats.nlink >= 1 && file.stats.dir === false, `常规文件 stats 必须投影 nlink/dir: ${JSON.stringify(file.stats)}`);
	const dir = runHelper("adir", ws, ws) as { ok: boolean; stats?: { nlink: number; dir: boolean } | null };
	assert.equal(dir.ok, true);
	assert.ok(dir.stats && dir.stats.dir === true, "目录必须 dir=true（目录 nlink>1 正常，不做硬链接拒）");
	const fresh = runHelper("deep/new/file.txt", ws, ws) as { ok: boolean; stats?: unknown };
	assert.equal(fresh.ok, true);
	assert.equal(fresh.stats, null, "目标不存在（回溯解析）必须 stats=null，不假称知道目标链接数");
});

test("B1 协议：stats 形状非法（非 null 且缺字段/负数/多字段）→ fail-closed invalid", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	const env = localEnvironment(ws, homedir());
	cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
	assert.deepEqual(await execRaw(env, 'console.log(JSON.stringify({ok:true,canonical:"/x",root:"/y",stats:{nlink:1}}))'), { ok: false, error: "invalid" });
	assert.deepEqual(await execRaw(env, 'console.log(JSON.stringify({ok:true,canonical:"/x",root:"/y",stats:{nlink:-1,dir:false}}))'), { ok: false, error: "invalid" });
	assert.deepEqual(await execRaw(env, 'console.log(JSON.stringify({ok:true,canonical:"/x",root:"/y",stats:{nlink:1,dir:false,extra:2}}))'), { ok: false, error: "invalid" });
	assert.deepEqual(await execRaw(env, 'console.log(JSON.stringify({ok:true,canonical:"/x",root:"/y",stats:"nlink=2"}))'), { ok: false, error: "invalid" });
});

test("B1 集成（Local 真实 helper）：多硬链接常规文件写入被保守拒（规则=protected-hardlink，且不假称知道别名位置）", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	writeFileSync(join(ws, "origin.txt"), "ORIGINAL");
	// 模拟硬链接绕过：别名用无辜名字 —— canonical 不命中任何 deny 清单，只能靠 nlink>1 发现
	linkSync(join(ws, "origin.txt"), join(ws, "innocent-name.txt"));
	const env = localEnvironment(ws, homedir());
	cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
	const { beforeTool } = makeRealExtension(() => env);
	const result = await beforeTool({ id: "hl1", name: "write", arguments: { path: "innocent-name.txt", content: "EVIL" } }, {}, { abortSignal: new AbortController().signal });
	assert.ok(result?.block?.includes("protected-hardlink"), `多链接常规文件写入必须被保守拒：${JSON.stringify(result)}`);
	assert.equal(readFileSync(join(ws, "origin.txt"), "utf8"), "ORIGINAL", "原文件内容不得被改");
});

test("B1 集成（Local 真实 helper）：单链接普通文件写入不受影响；新建文件不受影响", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	writeFileSync(join(ws, "solo.txt"), "solo");
	const env = localEnvironment(ws, homedir());
	cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
	const { beforeTool } = makeRealExtension(() => env);
	const edit = await beforeTool({ id: "s1", name: "write", arguments: { path: "solo.txt", content: "updated" } }, {}, { abortSignal: new AbortController().signal });
	assert.equal(edit, undefined, `单链接文件写入不得被拒：${JSON.stringify(edit)}`);
	const fresh = await beforeTool({ id: "s2", name: "write", arguments: { path: "brand/new.txt", content: "new" } }, {}, { abortSignal: new AbortController().signal });
	assert.equal(fresh, undefined, `新建文件（stats=null）不得被拒：${JSON.stringify(fresh)}`);
});

// ── R41 修复1负控：realpath 成功后 lstat 失败必须固定类别 fail-closed（不得混同 stats:null）──
// 注入缝=仅对以 victim-* 命名的目标抛 fs 异常的 helper 变体（其余逻辑逐字节同真实 helper）；
// 语义红=当前实现把 lstat 失败折叠成 ok+stats:null（与「不存在回溯」混同，硬链接检查被跳过）。

function helperWithLstatInject(): string {
	return PATH_GUARD_HELPER_CODE.replace(
		"const statOf = (p) => {",
		`const _realLstat = fs.lstatSync.bind(fs);
const lstatInject = (p) => {
  const s = String(p);
  if (s.endsWith("victim-eacces.txt")) { const e = new Error("injected"); e.code = "EACCES"; throw e; }
  if (s.endsWith("victim-enoent.txt")) { const e = new Error("injected"); e.code = "ENOENT"; throw e; }
  if (s.endsWith("victim-eloop.txt")) { const e = new Error("injected"); e.code = "ELOOP"; throw e; }
  return _realLstat(p);
};
fs.lstatSync = lstatInject;
const statOf = (p) => {`,
	);
}

async function execHelperVariant(env: ExecutionEnv, code: string, rawPath: string) {
	return execGuardHelper(env, [process.execPath, "-e", code, "--", rawPath], { timeoutMs: 3000, home: homedir() });
}

test("R41负控：realpath 成功后 lstat EACCES → fail-closed permission_denied（不是 ok+stats:null）", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	writeFileSync(join(ws, "victim-eacces.txt"), "x");
	const env = localEnvironment(ws, homedir());
	cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
	const v = await execHelperVariant(env, helperWithLstatInject(), "victim-eacces.txt");
	// 语义断言：目标真实解析成功后 stat 异常必须拒绝，且类别=固定白名单 token
	assert.ok(v.ok === false, `lstat 异常必须 fail-closed，实际=${JSON.stringify(v)}`);
	assert.equal((v as { error: string }).error, "permission_denied");
});

test("R41负控：realpath 与 lstat 之间竞态删除（ENOENT）→ fail-closed not_found（不得当新建放行）", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	writeFileSync(join(ws, "victim-enoent.txt"), "x");
	const env = localEnvironment(ws, homedir());
	cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
	const v = await execHelperVariant(env, helperWithLstatInject(), "victim-enoent.txt");
	assert.ok(v.ok === false, `竞态 ENOENT 必须 fail-closed，实际=${JSON.stringify(v)}`);
	assert.equal((v as { error: string }).error, "not_found");
});

test("R41负控：lstat ELOOP → fail-closed not_supported", async () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	writeFileSync(join(ws, "victim-eloop.txt"), "x");
	const env = localEnvironment(ws, homedir());
	cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
	const v = await execHelperVariant(env, helperWithLstatInject(), "victim-eloop.txt");
	assert.ok(v.ok === false);
	assert.equal((v as { error: string }).error, "not_supported");
});

test("R41正控：真实不存在目标（祖先回溯）仍然 ok+stats:null；真实多链接常规文件 stats.nlink≥2", () => {
	const ws = makeWs();
	cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
	writeFileSync(join(ws, "plain.txt"), "x");
	linkSync(join(ws, "plain.txt"), join(ws, "alias.txt"));
	const code = helperWithLstatInject();
	const fresh = runHelper("deep/new/file.txt", ws, ws) as { ok: boolean; stats: unknown };
	assert.equal(fresh.ok, true);
	assert.equal(fresh.stats, null, "只有真实 ENOENT 回溯路径才允许 stats=null");
	const linked = runHelper("alias.txt", ws, ws) as { ok: boolean; stats: { nlink: number; dir: boolean } | null };
	assert.equal(linked.ok, true);
	assert.ok(linked.stats && linked.stats.nlink >= 2 && linked.stats.dir === false, `多链接常规文件必须报 nlink≥2：${JSON.stringify(linked.stats)}`);
});
