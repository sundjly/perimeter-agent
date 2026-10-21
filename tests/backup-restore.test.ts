import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { WebSocket } from "ws";
import { AuditLog } from "../src/audit/log.ts";
import { acquireGatewayLock, releaseGatewayLock } from "../src/gateway/state-lock.ts";
import { ModelGateway } from "../src/modelgw/server.ts";
import type { ClientEvent } from "../src/protocol/types.ts";
import { runBackup } from "../scripts/backup.ts";
import { BackupError, sha256File } from "../scripts/backup-common.ts";
import { runRestore } from "../scripts/restore.ts";
import { initialState, reduce } from "../web/view-model.js";

const TOKEN = "test-gateway-token";

function launchGateway(rootDir: string, modelUrl: string): Promise<{ child: ChildProcess; port: number }> {
	const child = spawn(process.execPath, ["tests/fixtures/gateway-process.ts"], {
		env: { PATH: process.env.PATH, PERIMETER_TEST_ROOT: rootDir, PERIMETER_TEST_MODEL_URL: modelUrl },
		stdio: ["ignore", "pipe", "inherit"],
	});
	return once(child.stdout!, "data").then(([chunk]) => ({ child, port: (JSON.parse(String(chunk)) as { port: number }).port }));
}

async function stopGateway(child: ChildProcess): Promise<void> {
	const exit = once(child, "exit");
	child.kill("SIGTERM");
	await exit;
}

function connect(port: number, query: string): { ws: WebSocket; events: ClientEvent[]; controls: { control?: string; message?: string }[] } {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}&${query}`);
	const events: ClientEvent[] = [];
	const controls: { control?: string; message?: string }[] = [];
	ws.on("message", (raw) => {
		const frame = JSON.parse(String(raw)) as { event?: ClientEvent; control?: string; message?: string };
		if (frame.event) events.push(frame.event);
		else controls.push(frame);
	});
	return { ws, events, controls };
}

async function waitUntil(predicate: () => boolean, what: string, dump?: () => string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`等待超时：${what}${dump ? `\n${dump()}` : ""}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

const roleTexts = (state: { messages: { role: string; text: string }[] }) =>
	state.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => [m.role, m.text]);

test("S3d 备份→恢复→新网关：transcript/未提交改动/receipt replay 一致（handoff §3.3）", async () => {
	const dirA = mkdtempSync(join(tmpdir(), "s3d-a-"));
	const dirB = mkdtempSync(join(tmpdir(), "s3d-b-"));
	const audit = AuditLog.open(join(dirA, "model.jsonl"));
	const mock = spawn(process.execPath, ["tests/fixtures/mock-model.mjs", "0", JSON.stringify([{ text: "第一轮回复" }])]);
	const [chunk] = await once(mock.stdout!, "data");
	const model = new ModelGateway({ port: 0, host: "127.0.0.1", token: "test-model-token", upstreams: [{ id: "mock", baseUrl: `http://127.0.0.1:${(JSON.parse(String(chunk)) as { port: number }).port}/v1`, apiKey: "dummy" }], egressAllowlist: ["127.0.0.1"], audit });
	const modelPort = await model.listen();
	let gwA: ChildProcess | undefined;
	let gwB: ChildProcess | undefined;
	const sockets: WebSocket[] = [];
	try {
		const a = await launchGateway(dirA, `http://127.0.0.1:${modelPort}/v1`);
		gwA = a.child;
		const conn = connect(a.port, "session=bak&actor=owner");
		sockets.push(conn.ws);
		await once(conn.ws, "open");
		await waitUntil(() => conn.events.some((e) => e.type === "session.ready"), "会话就绪");
		conn.ws.send(JSON.stringify({ type: "prompt", text: "你好", requestId: "r1" }));
		await waitUntil(() => conn.events.some((e) => e.type === "agent.end"), "第一轮完成");
		conn.ws.send(JSON.stringify({ type: "create", operationId: "op-e2e", requestHash: "reqhash-e2e" }));
		await waitUntil(() => conn.events.some((e) => e.type === "session.created"), "显式创建收据");
		const created = conn.events.find((e) => e.type === "session.created");
		if (!created || created.type !== "session.created") throw new Error("缺少显式创建收据");
		assert.equal(created.replayed, false);
		const s2 = created.sessionId;
		const stateA = conn.events.reduce(reduce, initialState());
		conn.ws.close();
		await stopGateway(gwA);

		// 工作区事实：一次本地提交 + 一份未提交改动（恢复后必须原样保留，不 reset/checkout）
		const wsDir = join(dirA, "workspaces", "bak");
		writeFileSync(join(wsDir, "README.md"), "base\n");
		const g = (args: string[]) => spawnSync("git", args, { cwd: wsDir, encoding: "utf8" });
		g(["init", "-q", "-b", "main"]);
		g(["add", "-A"]);
		g(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
		writeFileSync(join(wsDir, "uncommitted.txt"), "未提交改动\n");

		const backup = runBackup({ stateRoot: join(dirA, "state"), workspaceRoot: join(dirA, "workspaces"), out: join(dirA, "backups"), auditFile: join(dirA, "gateway.jsonl") });
		const m = backup.manifest;
		assert.ok(m.files.some((f) => f.path === "state/sessions/bak/session.sqlite"));
		assert.ok(m.files.some((f) => f.path === "state/sessions/bak/meta.json"));
		assert.ok(m.files.some((f) => f.path === "state/revocations.json"));
		assert.ok(m.files.some((f) => f.path === "audit/gateway.jsonl"));
		const sqliteEntry = m.files.find((f) => f.path === "state/sessions/bak/session.sqlite");
		assert.ok(sqliteEntry);
		assert.ok((sqliteEntry.rows?.entries ?? 0) >= 1); // 备份确实捕获了 transcript 行（行数清单在 manifest）
		assert.equal(m.files.some((f) => f.path.includes("gateway.lock")), false);
		const bakEntry = m.sessions.find((s) => s.sessionId === "bak");
		assert.ok(bakEntry);
		assert.match(bakEntry.gitHead ?? "", /^[0-9a-f]{40}$/);
		assert.equal(bakEntry.dirty, true);
		assert.ok((bakEntry.receiptCount ?? 0) >= 1); // 隐式创建的 auto- 收据
		assert.ok(m.sessions.find((s) => s.sessionId === s2 && s.receiptCount >= 1));
		// 权限：备份目录 0700、文件 0600
		assert.equal(statSync(backup.backupDir).mode & 0o777, 0o700);
		assert.equal(statSync(join(backup.backupDir, "state/sessions/bak/meta.json")).mode & 0o777, 0o600);

		const report = await runRestore({ backup: backup.backupDir, stateRoot: join(dirB, "state"), workspaceRoot: join(dirB, "workspaces"), auditFile: join(dirB, "gateway.jsonl") });
		assert.equal(report.restorePoint.createdAt, m.createdAt);
		assert.ok(report.sessions.find((s) => s.sessionId === "bak" && s.headMatches && s.dirty));
		assert.equal(existsSync(join(dirB, "workspaces", "bak", "uncommitted.txt")), true);
		const statusB = spawnSync("git", ["status", "--porcelain"], { cwd: join(dirB, "workspaces", "bak"), encoding: "utf8" });
		assert.ok(String(statusB.stdout ?? "").trim().length > 0); // 未提交改动原样保留
		assert.equal(report.pendingApprovals.length, 0);
		assert.equal(report.pendingApprovalsKnown, true);

		// 用恢复后的目录启动新网关：会话可 re-attach，transcript 与原一致
		const b = await launchGateway(dirB, `http://127.0.0.1:${modelPort}/v1`);
		gwB = b.child;
		const connB = connect(b.port, "session=bak&actor=owner");
		sockets.push(connB.ws);
		await once(connB.ws, "open");
		await waitUntil(() => connB.events.some((e) => e.type === "session.ready"), "恢复后会话就绪");
		// Session.#start 先 emit ready 再 emit snapshot：必须等快照帧到达后才能比对 transcript
		await waitUntil(() => connB.events.some((e) => e.type === "session.snapshot"), "恢复后快照");
		const stateB = connB.events.reduce(reduce, initialState());
		assert.deepEqual(roleTexts(stateB), roleTexts(stateA));

		// receipt replay 返回原 sessionId（connB 的第一个 session.created 就是重放；connA 那次不在本流里）
		connB.ws.send(JSON.stringify({ type: "create", operationId: "op-e2e", requestHash: "reqhash-e2e" }));
		await waitUntil(
			() => connB.events.filter((e) => e.type === "session.created").length >= 1,
			"receipt 重放",
			() => `已收到事件：${connB.events.map((e) => e.type).join(", ") || "（无）"}` +
				(connB.events.some((e) => e.type === "error") ? `；error=${JSON.stringify(connB.events.find((e) => e.type === "error"))}` : ""),
		);
		assert.equal(connB.events.some((e) => e.type === "error"), false); // 重放失败不得被 error 事件掩盖
		const replayed = connB.events.filter((e) => e.type === "session.created").at(-1);
		if (!replayed || replayed.type !== "session.created") throw new Error("缺少重放收据");
		assert.equal(replayed.sessionId, s2);
		assert.equal(replayed.replayed, true);
	} finally {
		for (const socket of sockets) socket.terminate();
		for (const child of [gwA, gwB]) {
			if (child && child.exitCode === null && child.signalCode === null) await stopGateway(child).catch(() => {});
		}
		try {
			await model.close();
		} finally {
			audit.close();
			mock.kill();
			rmSync(dirA, { recursive: true, force: true });
			rmSync(dirB, { recursive: true, force: true });
		}
	}
});

test("活锁存在时备份拒绝（固定类别）", () => {
	const dir = mkdtempSync(join(tmpdir(), "s3d-lock-"));
	try {
		const stateRoot = join(dir, "state");
		mkdirSync(stateRoot, { recursive: true });
		mkdirSync(join(dir, "workspaces"), { recursive: true });
		const lock = acquireGatewayLock(stateRoot);
		try {
			assert.throws(
				() => runBackup({ stateRoot, workspaceRoot: join(dir, "workspaces"), out: join(dir, "out") }),
				(err: unknown) => err instanceof BackupError && err.code === "gateway_running",
			);
		} finally {
			releaseGatewayLock(lock);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function fabricateState(dir: string): { backupDir: string } {
	const stateRoot = join(dir, "state");
	const workspaceRoot = join(dir, "workspaces");
	mkdirSync(stateRoot, { recursive: true });
	mkdirSync(workspaceRoot, { recursive: true });
	writeFileSync(join(stateRoot, "revocations.json"), JSON.stringify({ revoked: [] }), { mode: 0o600 });
	const db = new DatabaseSync(join(stateRoot, "probe.sqlite"));
	db.exec("CREATE TABLE t(v TEXT)");
	db.close();
	return { backupDir: runBackup({ stateRoot, workspaceRoot, out: join(dir, "backups") }).backupDir };
}

test("恢复到非空目录拒绝（固定类别，绝不覆盖）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s3d-r-"));
	const dir2 = mkdtempSync(join(tmpdir(), "s3d-r2-"));
	try {
		const f = fabricateState(dir);
		const target = join(dir2, "state");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "occupied.txt"), "x");
		await assert.rejects(
			() => runRestore({ backup: f.backupDir, stateRoot: target, workspaceRoot: join(dir2, "workspaces") }),
			(err: unknown) => err instanceof BackupError && err.code === "target_not_empty",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(dir2, { recursive: true, force: true });
	}
});

test("篡改备份一个字节 → 恢复拒绝并列出差异（固定类别）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s3d-t-"));
	const dir2 = mkdtempSync(join(tmpdir(), "s3d-t2-"));
	try {
		const f = fabricateState(dir);
		const victim = join(f.backupDir, "state", "revocations.json");
		writeFileSync(victim, readFileSync(victim, "utf8").replace("]", " ]"), { mode: 0o600 });
		await assert.rejects(
			() => runRestore({ backup: f.backupDir, stateRoot: join(dir2, "state"), workspaceRoot: join(dir2, "workspaces") }),
			(err: unknown) => err instanceof BackupError && err.code === "checksum_mismatch" && err.message.includes("state/revocations.json"),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(dir2, { recursive: true, force: true });
	}
});

test("manifest 被篡改删除 sqlite 行数清单 → 恢复固定拒（守卫不得静默跳过）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s3d-m-"));
	const dir2 = mkdtempSync(join(tmpdir(), "s3d-m2-"));
	try {
		const f = fabricateState(dir);
		const manifestPath = join(f.backupDir, "manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: { path: string; rows?: unknown }[] };
		const entry = manifest.files.find((e) => e.path === "state/probe.sqlite");
		assert.ok(entry);
		delete entry.rows; // manifest 自身不在 files 清单内，sha256 校验拦不住这种篡改 —— 只能靠行数比对守卫
		writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
		await assert.rejects(
			() => runRestore({ backup: f.backupDir, stateRoot: join(dir2, "state"), workspaceRoot: join(dir2, "workspaces") }),
			(err: unknown) => err instanceof BackupError && err.code === "sqlite_integrity_failed" && err.message.includes("行数清单"),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(dir2, { recursive: true, force: true });
	}
});

test("R1：manifest 路径遍历/绝对路径/符号链接源 → 固定拒，目标根之外零写入", async () => {
	const dirA = mkdtempSync(join(tmpdir(), "s3d-p-"));
	const dirB = mkdtempSync(join(tmpdir(), "s3d-p2-"));
	try {
		const f = fabricateState(dirA);
		// 哨兵在备份根与目标根之外：断言拒绝后原样未动、且逃逸产物不存在
		const sentinelA = join(dirA, "sentinel-a.txt");
		const sentinelB = join(dirA, "sentinel-b.txt");
		const sentinelC = join(dirA, "sentinel-c.txt");
		const make = (p: string) => { writeFileSync(p, "sentinel\n", { mode: 0o600 }); return sha256File(p); };
		const shaOfA = make(sentinelA);
		make(sentinelB);
		const shaOfC = make(sentinelC);
		// 符号链接源：备份内 state/link.txt → 指向备份外哨兵（copyFileSync 会跟随）
		symlinkSync(sentinelC, join(f.backupDir, "state", "link.txt"));
		const manifestPath = join(f.backupDir, "manifest.json");
		type ManifestFile = { path: string; size: number; sha256: string };
		// 深拷贝 runBackup 产出的完整 manifest（保留 version/createdAt/source/sessions 全部字段），
		// 每例只改 files；否则 restore 在形状校验处就拒，走不到路径防御
		const readManifest = () => JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown> & { files: ManifestFile[] };
		const baseFiles = readManifest().files;
		const writeWith = (entry: ManifestFile) => {
			const manifest = readManifest();
			manifest.files = [...baseFiles, entry];
			writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
		};

		// ① .. 段逃逸：size/sha 故意给对 —— 证明拒绝来自路径防御而非校验失败
		writeWith({ path: "state/../../sentinel-a.txt", size: statSync(sentinelA).size, sha256: shaOfA });
		await assert.rejects(
			() => runRestore({ backup: f.backupDir, stateRoot: join(dirB, "s1"), workspaceRoot: join(dirB, "w1") }),
			(err: unknown) => err instanceof BackupError && err.code === "unsafe_path",
		);
		assert.equal(existsSync(join(dirB, "sentinel-a.txt")), false);

		// ② 绝对路径：不拦的话会覆盖哨兵本身
		writeWith({ path: sentinelB, size: statSync(sentinelB).size, sha256: sha256File(sentinelB) });
		await assert.rejects(
			() => runRestore({ backup: f.backupDir, stateRoot: join(dirB, "s2"), workspaceRoot: join(dirB, "w2") }),
			(err: unknown) => err instanceof BackupError && err.code === "unsafe_path",
		);

		// ③ 符号链接源：布局合法、sha 正确（statSync/哈希均跟随链接），必须被 lstat 常规文件检查拦下
		writeWith({ path: "state/link.txt", size: statSync(sentinelC).size, sha256: shaOfC });
		await assert.rejects(
			() => runRestore({ backup: f.backupDir, stateRoot: join(dirB, "s3"), workspaceRoot: join(dirB, "w3") }),
			(err: unknown) => err instanceof BackupError && err.code === "unsafe_source",
		);

		// 目标根之外零写入：三个哨兵全部原样
		assert.equal(readFileSync(sentinelA, "utf8"), "sentinel\n");
		assert.equal(readFileSync(sentinelB, "utf8"), "sentinel\n");
		assert.equal(readFileSync(sentinelC, "utf8"), "sentinel\n");
	} finally {
		rmSync(dirA, { recursive: true, force: true });
		rmSync(dirB, { recursive: true, force: true });
	}
});

test("只拷 sqlite 主文件不带 WAL 会丢数据；主+WAL 一并拷贝才一致（备份通道必要性的反例）", () => {
	const dir = mkdtempSync(join(tmpdir(), "s3d-wal-"));
	try {
		const main = join(dir, "probe.sqlite");
		const db = new DatabaseSync(main);
		db.exec("PRAGMA journal_mode=WAL");
		db.exec("CREATE TABLE t(v TEXT)");
		db.prepare("INSERT INTO t VALUES (?)").run("wal-only-row");
		// 刻意不 close、不 checkpoint：该行只存在于 -wal
		copyFileSync(main, join(dir, "copy-main.sqlite"));
		const broken = new DatabaseSync(join(dir, "copy-main.sqlite"));
		const brokenSchema = broken.prepare("SELECT count(*) AS c FROM sqlite_master").get() as { c: number };
		broken.close();
		assert.equal(brokenSchema.c, 0); // 只有主文件：连 schema 都不在 —— 数据丢失
		copyFileSync(main, join(dir, "copy-pair.sqlite"));
		copyFileSync(`${main}-wal`, join(dir, "copy-pair.sqlite-wal"));
		const pair = new DatabaseSync(join(dir, "copy-pair.sqlite"));
		const pairRows = pair.prepare("SELECT count(*) AS c FROM t").get() as { c: number };
		pair.close();
		assert.equal(pairRows.c, 1); // 主+WAL 一并拷贝：一致
		db.close(); // 收尾 checkpoint
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("meta.json 缺失/损坏 → 会话 quarantined、连接被拒、不产生新 owner（固定类别 + 审计留痕）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s3d-q-"));
	let gw: ChildProcess | undefined;
	const sockets: WebSocket[] = [];
	try {
		const first = await launchGateway(dir, "http://127.0.0.1:1/v1");
		gw = first.child;
		await stopGateway(gw); // 初始化 stateRoot 后停止（锁随 close 释放）
		// ① meta 损坏
		mkdirSync(join(dir, "state", "sessions", "corrupt"), { recursive: true });
		writeFileSync(join(dir, "state", "sessions", "corrupt", "meta.json"), "{corrupt", { mode: 0o600 });
		// ② meta 缺失但已有 durable 状态（无守卫时后来者会成为新 owner 的最危险形态）
		mkdirSync(join(dir, "state", "sessions", "ghost"), { recursive: true });
		writeFileSync(join(dir, "state", "sessions", "ghost", "session.sqlite"), "not-a-db", { mode: 0o600 });
		// ③ 空目录（部署面预 mkdir 的形态）→ 视为未创建，走正常新建，不得隔离
		mkdirSync(join(dir, "state", "sessions", "fresh"), { recursive: true });
		// ④ 仅含 meta.json.tmp 半成品（#buildSession tmp+rename 崩溃窗口的真实残留形态）→ 同按未创建
		mkdirSync(join(dir, "state", "sessions", "tmponly"), { recursive: true });
		writeFileSync(join(dir, "state", "sessions", "tmponly", "meta.json.tmp"), "{partial", { mode: 0o600 });
		const second = await launchGateway(dir, "http://127.0.0.1:1/v1");
		gw = second.child;
		for (const [sid, actor] of [["corrupt", "intruder"], ["ghost", "owner"]] as const) {
			const conn = connect(second.port, `session=${sid}&actor=${actor}`);
			sockets.push(conn.ws);
			await once(conn.ws, "open");
			await waitUntil(() => conn.controls.some((c) => (c.message ?? "").includes("隔离")), `隔离拒绝：${sid}`);
		}
		// 已隔离后（marker 命中路径）依旧拒绝
		const again = connect(second.port, "session=ghost&actor=stranger");
		sockets.push(again.ws);
		await once(again.ws, "open");
		await waitUntil(() => again.controls.some((c) => (c.message ?? "").includes("隔离")), "marker 拒绝");
		// 空目录按新建处理：meta 正常落盘、无隔离标记（模型不可达只影响 start，与隔离无关）
		const fresh = connect(second.port, "session=fresh&actor=owner");
		sockets.push(fresh.ws);
		await once(fresh.ws, "open");
		await waitUntil(() => existsSync(join(dir, "state", "sessions", "fresh", "meta.json")), "空目录按新建处理");
		assert.equal(existsSync(join(dir, "state", "sessions", "fresh", "quarantined.json")), false);
		// meta.json.tmp 半成品同按未创建：meta 正常落盘、无隔离标记
		const tmponly = connect(second.port, "session=tmponly&actor=owner");
		sockets.push(tmponly.ws);
		await once(tmponly.ws, "open");
		await waitUntil(() => existsSync(join(dir, "state", "sessions", "tmponly", "meta.json")), "tmp 半成品按新建处理");
		assert.equal(existsSync(join(dir, "state", "sessions", "tmponly", "quarantined.json")), false);
		// 磁盘事实：标记存在；meta 不被重建、不改写（无新 owner）
		assert.equal(existsSync(join(dir, "state", "sessions", "corrupt", "quarantined.json")), true);
		assert.equal(readFileSync(join(dir, "state", "sessions", "corrupt", "meta.json"), "utf8"), "{corrupt");
		assert.equal(existsSync(join(dir, "state", "sessions", "ghost", "meta.json")), false);
		assert.equal(existsSync(join(dir, "state", "sessions", "ghost", "quarantined.json")), true);
		// 审计留痕
		const auditText = readFileSync(join(dir, "gateway.jsonl"), "utf8");
		assert.ok(auditText.split("\n").some((line) => line.includes("quarantined")));
		await stopGateway(gw);
	} finally {
		for (const socket of sockets) socket.terminate();
		if (gw && gw.exitCode === null && gw.signalCode === null) await stopGateway(gw).catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	}
});
