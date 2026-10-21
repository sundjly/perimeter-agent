#!/usr/bin/env node
/**
 * S3d：stateRoot + workspaceRoot 的一致备份（handoff §3.3 第 4-5 条）。
 *
 * 前提与固定类别：要求网关已停止 —— 检测 stateRoot 独占锁（复用 src/gateway/state-lock.ts
 * 的同一判定原语）：活锁（本机活进程）/ 他机锁 / 锁不可解析 → 一律拒绝备份，不猜、不降级；
 * 仅「陈旧锁」（同主机持有进程已死，崩溃残留）放行并在 manifest 注明。
 *
 * SQLite 处理选型 —— VACUUM INTO，依据：
 * - 备份前提是网关已停止（无写者），本进程逐库打开后 `VACUUM INTO` 产出单一自洽文件；
 *   读连接看到的是含 WAL 帧的最新提交，天然折叠 -wal/-shm，不存在「只拷主文件丢 WAL」的丢失面；
 * - 源库尽量以只读连接打开（VACUUM INTO 支持只读源，备份全程不写源库）；只读打开失败
 *   （如崩溃残留 -wal 而无 -shm 的 WAL 只读限制）时回退读写，两种模式数据口径不变；
 * - 拷贝前对源库 integrity_check，产物再查一次 —— 源损坏与拷贝损坏都在备份时暴露；
 * - 附带收益：清碎片、恢复侧无需处理 WAL/SHM 配对顺序。
 *
 * 产物布局：<out>/backup-<UTC 时间戳>/
 *   state/…        镜像 stateRoot（排除 gateway.lock 与瞬态文件；sqlite 走 VACUUM INTO 通道）
 *   workspaces/…   镜像 workspaceRoot（排除 .homes —— 内含 git 代理凭据，恢复后由网关重签）
 *   audit/<basename>  --audit-file 给出且存在时；否则仅在 manifest 注明
 *   manifest.json  最后写：相对路径、大小、sha256、每会话 git HEAD/未提交改动、receipt 数、来源 epoch
 *
 * 权限：目录 0700、文件 0600。
 */
import { DatabaseSync } from "node:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { BackupError, copyTreeSync, countTables, gitFacts, sha256File, walkFiles } from "./backup-common.ts";
import { inspectGatewayLock } from "../src/gateway/state-lock.ts";

export interface BackupManifest {
	version: 1;
	createdAt: string;
	source: {
		stateRoot: string;
		workspaceRoot: string;
		/** 来源网关的 git grants epoch（每次网关启动换新，作为启动标识）；无 gitGrants 配置/损坏时为 null */
		epoch: string | null;
		/** stateRoot 锁状态：none=无锁；stale=陈旧锁（崩溃残留，已放行） */
		lockFound: "none" | "stale";
		notes: string[];
	};
	files: { path: string; size: number; sha256: string; /** sqlite 专有：关键表行数快照（非 sqlite 文件无此字段）；恢复时逐表比对，不一致即拒 */ rows?: Record<string, number | null> }[];
	sessions: {
		sessionId: string;
		metaStatus: "ok" | "missing" | "corrupt";
		quarantined: boolean;
		receiptCount: number;
		workspacePresent: boolean;
		gitHead: string | null;
		dirty: boolean;
		unpushed: { count: number; noUpstream: boolean } | null;
	}[];
}

/** 网关已停止的前提下，把一个 sqlite 库折叠成单一自洽备份文件，双侧 integrity_check + 行数比对（countTables 在 backup-common，备份/恢复两侧共用） */
function vacuumSqliteInto(src: string, dest: string): Record<string, number | null> {
	mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
	let db: DatabaseSync;
	try {
		db = new DatabaseSync(src, { readOnly: true }); // 只读：备份全程不写源库、不重排页
	} catch {
		// 只读 WAL 限制（崩溃残留 -wal 而无 -shm）：回退读写，数据口径不变（VACUUM INTO 全量读）
		try {
			db = new DatabaseSync(src);
		} catch (err) {
			throw new BackupError("sqlite_open_failed", `源 SQLite 打开失败，拒绝备份（固定类别）：${basename(src)}（${String(err)}）`);
		}
	}
	let sourceRows: Record<string, number | null>;
	try {
		const check = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
		if (!check || check.integrity_check !== "ok") {
			throw new BackupError("sqlite_corrupt", `源 SQLite integrity_check 未通过，拒绝备份（固定类别）：${basename(src)}`);
		}
		sourceRows = countTables(db);
		// VACUUM INTO 的目标路径按 SQL 字面量转义单引号；目标必须不存在（sqlite 自行创建）
		db.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
	} finally {
		db.close(); // 收尾 checkpoint：源库上崩溃残留的 -wal/-shm 被折叠清理
	}
	const copy = new DatabaseSync(dest, { readOnly: true });
	let copyRows: Record<string, number | null>;
	try {
		const check = copy.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
		if (!check || check.integrity_check !== "ok") {
			throw new BackupError("sqlite_backup_corrupt", `备份产物 integrity_check 未通过（固定类别）：${basename(dest)}`);
		}
		copyRows = countTables(copy);
		for (const [table, count] of Object.entries(sourceRows)) {
			if (copyRows[table] !== count) {
				throw new BackupError("sqlite_vacuum_incomplete", `备份产物与源库行数不一致（固定类别；${table}: 源=${String(count)} 备份=${String(copyRows[table])}）：${basename(dest)}`);
			}
		}
	} finally {
		copy.close();
	}
	try { chmodSync(dest, 0o600); } catch { /* mode 受 umask 影响时的兜底 */ }
	return copyRows;
}

function buildManifest(input: { stateRoot: string; workspaceRoot: string; backupDir: string; createdAt: string; lockFound: "none" | "stale"; notes: string[]; sqliteRows: Map<string, Record<string, number | null>> }): BackupManifest {
	const { stateRoot, workspaceRoot, backupDir, notes } = input;
	// epoch：git grants 登记文件的 epoch；无登记或损坏 → null（不虚构启动标识）
	let epoch: string | null = null;
	try {
		const reg = JSON.parse(readFileSync(join(stateRoot, "git-grants-registry.json"), "utf8")) as { epoch?: unknown };
		if (typeof reg.epoch === "string" && reg.epoch.length > 0) epoch = reg.epoch;
	} catch { /* 无登记或损坏：epoch 未知 */ }

	// receipt 计数（按 sessionId）；损坏收据照拷字节，但计数不可得并注明
	const receiptCount = new Map<string, number>();
	try {
		const receiptsRoot = join(stateRoot, "receipts");
		for (const dir of readdirSync(receiptsRoot)) {
			for (const file of readdirSync(join(receiptsRoot, dir))) {
				if (!file.endsWith(".json")) continue;
				try {
					const parsed = JSON.parse(readFileSync(join(receiptsRoot, dir, file), "utf8")) as { sessionId?: unknown };
					if (typeof parsed.sessionId === "string") receiptCount.set(parsed.sessionId, (receiptCount.get(parsed.sessionId) ?? 0) + 1);
				} catch {
					notes.push(`创建收据无法解析（照拷字节，不计数）：receipts/${dir}/${file}`);
				}
			}
		}
	} catch { /* 无 receipts 目录 */ }

	const sessions: BackupManifest["sessions"] = [];
	let sessionDirs: string[] = [];
	try { sessionDirs = readdirSync(join(stateRoot, "sessions")); } catch { /* 无会话目录 */ }
	for (const sessionId of sessionDirs) {
		const sessionDir = join(stateRoot, "sessions", sessionId);
		const metaFile = join(sessionDir, "meta.json");
		let metaStatus: "ok" | "missing" | "corrupt" = "ok";
		if (!existsSync(metaFile)) metaStatus = "missing";
		else {
			try { JSON.parse(readFileSync(metaFile, "utf8")); } catch { metaStatus = "corrupt"; }
		}
		const facts = gitFacts(join(workspaceRoot, sessionId));
		sessions.push({
			sessionId,
			metaStatus,
			quarantined: existsSync(join(sessionDir, "quarantined.json")),
			receiptCount: receiptCount.get(sessionId) ?? 0,
			workspacePresent: facts.workspacePresent,
			gitHead: facts.gitHead,
			dirty: facts.dirty,
			unpushed: facts.unpushed,
		});
	}

	const files = walkFiles(backupDir).map((f) => {
		// sqliteRows 的 key 是相对 stateRoot 的路径；walkFiles 的 rel 相对备份根（带 state/ 前缀）
		const stateRel = f.rel.startsWith("state/") ? f.rel.slice("state/".length) : undefined;
		const rows = stateRel !== undefined ? input.sqliteRows.get(stateRel) : undefined;
		return {
			path: f.rel,
			size: statSync(f.abs).size,
			sha256: sha256File(f.abs),
			...(rows !== undefined ? { rows } : {}),
		};
	});

	return {
		version: 1,
		createdAt: input.createdAt,
		source: { stateRoot, workspaceRoot, epoch, lockFound: input.lockFound, notes },
		files,
		sessions,
	};
}

export function runBackup(opts: { stateRoot: string; workspaceRoot: string; out: string; auditFile?: string }): { backupDir: string; manifest: BackupManifest } {
	const stateRoot = resolve(opts.stateRoot);
	const workspaceRoot = resolve(opts.workspaceRoot);
	const notes: string[] = [];
	if (!existsSync(stateRoot)) throw new BackupError("state_root_missing", "stateRoot 不存在，拒绝备份（固定类别）");
	if (!existsSync(workspaceRoot)) throw new BackupError("workspace_root_missing", "workspaceRoot 不存在，拒绝备份（固定类别）");

	// 前提：网关已停止。活锁/他机锁/不可解析锁一律拒绝；仅陈旧锁（崩溃残留）放行并注明
	const lock = inspectGatewayLock(stateRoot);
	if (lock.state === "live") throw new BackupError("gateway_running", "stateRoot 由本机活实例持有（网关未停止），拒绝备份（固定类别；先停止网关再备份）");
	if (lock.state === "foreign-host") throw new BackupError("lock_foreign_host", "stateRoot 锁由其他主机持有，拒绝备份（固定类别；交运维处理）");
	if (lock.state === "unparseable") throw new BackupError("lock_unparseable", "stateRoot 锁不可解析，拒绝备份（固定类别；交运维处理）");
	const lockFound: "none" | "stale" = lock.state === "stale" ? "stale" : "none";
	if (lockFound === "stale") notes.push("发现陈旧锁（持有进程已死亡的崩溃残留），已放行备份");

	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
	const outRoot = resolve(opts.out);
	try { mkdirSync(outRoot, { recursive: true, mode: 0o700 }); } catch { /* 已存在 */ }
	try { chmodSync(outRoot, 0o700); } catch { /* umask 兑底 */ }
	const backupDir = join(outRoot, `backup-${stamp}`);
	try {
		mkdirSync(backupDir, { mode: 0o700 }); // 不带 recursive：仅接受全新目录，绝不复用/覆盖（同秒冲突固定拒）
	} catch {
		throw new BackupError("backup_dir_exists", `备份目标目录已存在或不可创建，拒绝备份（固定类别）：${backupDir}`);
	}
	try { chmodSync(backupDir, 0o700); } catch { /* umask 兜底 */ }

	// stateRoot 镜像：gateway.lock 绝不进备份；瞬态文件（tmp 半成品 / readyz 探针）与
	// sqlite 的 -wal/-shm 不走普通拷贝 —— sqlite 统一走下方 VACUUM INTO 单文件通道
	const sqliteFiles: string[] = [];
	const sqliteRows = new Map<string, Record<string, number | null>>();
	copyTreeSync(stateRoot, join(backupDir, "state"), {
		excludeFile: (rel) => {
			const base = basename(rel);
			if (base === "gateway.lock" || base.startsWith(".readyz-probe-") || /^\..+\.tmp$/.test(base)) return true;
			if (rel.endsWith(".sqlite-wal") || rel.endsWith(".sqlite-shm")) return true;
			if (rel.endsWith(".sqlite")) { sqliteFiles.push(rel); return true; }
			return false;
		},
	});
	for (const rel of sqliteFiles) sqliteRows.set(rel, vacuumSqliteInto(join(stateRoot, rel), join(backupDir, "state", rel)));

	// workspaceRoot 镜像：排除 .homes（沙箱 HOME 内含 git 代理凭据；恢复后由网关在会话启动时重写）
	copyTreeSync(workspaceRoot, join(backupDir, "workspaces"), {
		excludeDir: (rel) => rel === ".homes" || rel.startsWith(".homes/"),
	});
	notes.push(".homes（沙箱 HOME，内含 git 代理凭据）不入备份；恢复后由网关在会话启动时重写");

	// 审计文件在 stateRoot 外：按配置路径一并备份；未提供/不存在则在 manifest 注明
	if (opts.auditFile !== undefined) {
		if (existsSync(opts.auditFile)) {
			mkdirSync(join(backupDir, "audit"), { mode: 0o700 });
			copyFileSync(opts.auditFile, join(backupDir, "audit", basename(opts.auditFile)));
			try { chmodSync(join(backupDir, "audit", basename(opts.auditFile)), 0o600); } catch { /* 同上 */ }
		} else {
			notes.push(`配置的审计文件不存在，未随备份：${opts.auditFile}`);
		}
	} else {
		notes.push("未提供审计文件路径（--audit-file），审计未随备份；恢复报告中的审批状态将为 unknown");
	}

	const manifest = buildManifest({ stateRoot, workspaceRoot, backupDir, createdAt: new Date().toISOString(), lockFound, notes, sqliteRows });
	const manifestFile = join(backupDir, "manifest.json");
	const tmp = `${manifestFile}.tmp`;
	writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
	renameSync(tmp, manifestFile);
	try { chmodSync(manifestFile, 0o600); } catch { /* 刚以 0600 写入 */ }
	return { backupDir, manifest };
}

function argOf(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
	try {
		const stateRoot = argOf("state-root");
		const workspaceRoot = argOf("workspace-root");
		const out = argOf("out");
		if (!stateRoot || !workspaceRoot || !out) {
			throw new BackupError("usage", "用法：npm run backup -- --state-root <dir> --workspace-root <dir> --out <dir> [--audit-file <path>]");
		}
		const result = runBackup({ stateRoot, workspaceRoot, out, auditFile: argOf("audit-file") });
		console.log(JSON.stringify({ backupDir: result.backupDir, files: result.manifest.files.length, sessions: result.manifest.sessions.length }));
	} catch (err) {
		console.error(err instanceof Error ? err.message : err);
		process.exitCode = 1;
	}
}
