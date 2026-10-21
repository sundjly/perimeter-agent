#!/usr/bin/env node
/**
 * S3d：恢复到隔离目录（handoff §3.3 第 4-5 条）。
 *
 * 语义边界，一条都不能让：
 * - 只恢复到「新的、空的隔离目录」：stateRoot / workspaceRoot / 审计目标任一非空即拒绝，
 *   绝不覆盖既有状态（固定类别 target_not_empty）。
 * - R1：manifest 路径是对抗面 —— 形状防御（拒 .. 段/绝对路径/空段/反斜杠/NUL）+ join 后
 *   包含性校验（path.relative 不以 .. 开头且非绝对）+ 恢复源 lstat 必须常规文件
 *   （拒符号链接/目录/设备），任一违反固定类别拒绝，绝不写出目标根之外。
 * - 先按 manifest 逐文件校验 sha256，不一致拒绝并列出全部差异（固定类别 checksum_mismatch）；
 *   备份内出现 gateway.lock 视为布局非法，拒绝恢复。
 * - 恢复后对每个 sqlite 跑 integrity_check；逐会话校验 workspace git HEAD 与 manifest 一致。
 *   **绝不 reset/checkout**：未提交改动原样保留（字节级拷贝本来就不碰工作树）。
 * - 输出恢复报告（stdout JSON）：恢复点、每会话未推送提交数、有未提交改动的会话、
 *   outcome_unknown / 未终态收据、pending 审批（按恢复后的审计链配对；审计未随备份时如实标 unknown）。
 *
 * 用法：npm run restore -- --backup <dir> --state-root <dir> --workspace-root <dir> [--audit-file <out>] [--report <file>]
 */
import { DatabaseSync } from "node:sqlite";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AuditLog } from "../src/audit/log.ts";
import { BackupError, countTables, gitFacts, sha256File, walkFiles } from "./backup-common.ts";
import type { BackupManifest } from "./backup.ts";

export interface RestoreReport {
	restorePoint: { backupDir: string; createdAt: string; sourceEpoch: string | null };
	stateRoot: string;
	workspaceRoot: string;
	audit: { restored: boolean; path: string | null };
	sessions: {
		sessionId: string;
		gitHead: string | null;
		manifestHead: string | null;
		headMatches: boolean;
		dirty: boolean;
		unpushed: { count: number; noUpstream: boolean } | null;
		workspacePresent: boolean;
	}[];
	receipts: {
		total: number;
		outcomeUnknown: { operationId: string; sessionId: string }[];
		nonTerminal: { operationId: string; sessionId: string; stage: string }[];
		corrupt: string[];
	};
	pendingApprovals: { sessionId: string; callId: string; at: string }[];
	/** false = 审计未随备份，审批状态 unknown（不虚构） */
	pendingApprovalsKnown: boolean;
	warnings: string[];
}

function loadManifest(backupDir: string): BackupManifest {
	const manifestFile = join(backupDir, "manifest.json");
	if (!existsSync(manifestFile)) throw new BackupError("backup_manifest_missing", `备份缺少 manifest.json，拒绝恢复（固定类别）：${backupDir}`);
	let manifest: BackupManifest;
	try {
		manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as BackupManifest;
	} catch (err) {
		throw new BackupError("backup_manifest_corrupt", `manifest.json 无法解析，拒绝恢复（固定类别）（${String(err)}）`);
	}
	if (manifest.version !== 1 || !Array.isArray(manifest.files)) {
		throw new BackupError("backup_manifest_unsupported", `manifest 版本或形状不受支持，拒绝恢复（固定类别）：version=${String(manifest.version)}`);
	}
	return manifest;
}

/** R1：manifest 路径形状防御 —— 拒 .. 段/绝对路径/盘符/空段/反斜杠/NUL；非法返回 undefined */
function safeRelPath(path: string): string | undefined {
	if (path.length === 0 || path.includes("\0") || path.includes("\\")) return undefined;
	if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return undefined;
	for (const seg of path.split("/")) {
		if (seg.length === 0 || seg === "." || seg === "..") return undefined;
	}
	return path;
}

/** R1：join 后校验仍在 root 内（path.relative 不以 .. 开头且非绝对），防规范化逃出目录 */
function joinContained(root: string, rel: string, what: string): string {
	const abs = join(root, rel);
	const r = relative(root, abs);
	if (r === "" || r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r)) {
		throw new BackupError("unsafe_path", `${what}路径逃出目标根，拒绝恢复（固定类别）：${rel}`);
	}
	return abs;
}

/**
 * 布局防御：只认 state/、workspaces/、audit/ 三个前缀；gateway.lock 出现即拒绝；
 * manifest 路径形状逐条核验，非法路径全部列出后一次固定拒。
 */
function validateLayout(manifest: BackupManifest): void {
	const unsafe: string[] = [];
	let auditFiles = 0;
	for (const f of manifest.files) {
		if (safeRelPath(f.path) === undefined) { unsafe.push(f.path); continue; }
		if (f.path.includes("gateway.lock")) { unsafe.push(`${f.path}（含 gateway.lock）`); continue; }
		if (f.path.startsWith("state/") || f.path.startsWith("workspaces/")) continue;
		if (f.path.startsWith("audit/")) { auditFiles++; continue; }
		unsafe.push(f.path);
	}
	if (unsafe.length > 0) {
		throw new BackupError("unsafe_path", `manifest 内含非法或布局不符路径，拒绝恢复（固定类别）：\n${unsafe.join("\n")}`);
	}
	if (auditFiles > 1) throw new BackupError("audit_layout", `备份含 ${auditFiles} 个审计文件，拒绝恢复（固定类别；只支持单审计文件）`);
}

function ensureEmptyTarget(dir: string, what: string): void {
	if (!existsSync(dir)) return;
	if (!statSync(dir).isDirectory()) throw new BackupError("target_not_empty", `${what} 已存在且不是目录，拒绝恢复（固定类别）：${dir}`);
	if (readdirSync(dir).length > 0) throw new BackupError("target_not_empty", `${what} 非空，拒绝恢复（固定类别；绝不覆盖既有状态）：${dir}`);
	try { chmodSync(dir, 0o700); } catch { /* umask 兜底 */ }
}

function mapTarget(path: string, stateRoot: string, workspaceRoot: string): string {
	if (path.startsWith("state/")) return joinContained(stateRoot, path.slice("state/".length), "恢复目标");
	if (path.startsWith("workspaces/")) return joinContained(workspaceRoot, path.slice("workspaces/".length), "恢复目标");
	throw new BackupError("unexpected_layout", `manifest 内出现未知布局路径，拒绝恢复（固定类别）：${path}`);
}

export async function runRestore(opts: { backup: string; stateRoot: string; workspaceRoot: string; auditFile?: string }): Promise<RestoreReport> {
	const backupDir = resolve(opts.backup);
	const stateRoot = resolve(opts.stateRoot);
	const workspaceRoot = resolve(opts.workspaceRoot);
	const auditTarget = opts.auditFile !== undefined ? resolve(opts.auditFile) : undefined;
	const warnings: string[] = [];

	// 1-2. manifest + 布局防御（在任何目标目录被触碰之前完成）
	const manifest = loadManifest(backupDir);
	validateLayout(manifest);
	if (manifest.source?.lockFound === "stale") warnings.push("备份来源存在陈旧锁（崩溃残留），已随 manifest 注明");
	warnings.push(...(manifest.source?.notes ?? []));
	for (const q of (manifest.sessions ?? []).filter((s) => s.quarantined)) {
		warnings.push(`会话已隔离（quarantined），恢复后仍将拒绝接入，仅运维可处理：${q.sessionId}`);
	}
	for (const bad of (manifest.sessions ?? []).filter((s) => s.metaStatus !== "ok")) {
		warnings.push(`会话元数据${bad.metaStatus === "missing" ? "缺失" : "损坏"}（恢复后接入时同口径处理：有状态则隔离；空目录/仅 tmp 残留按未创建新建）：${bad.sessionId}`);
	}

	// 3. 逐文件 sha256 校验，不一致拒绝并列出全部差异。恢复源 lstat 必须是常规文件 ——
	// copyFileSync 会跟随符号链接，不拦的话宿主任意文件会被读进恢复目标
	const mismatches: string[] = [];
	const unsafeSources: string[] = [];
	for (const f of manifest.files) {
		const src = joinContained(backupDir, f.path, "恢复源");
		let st: Stats;
		try {
			st = lstatSync(src);
		} catch {
			mismatches.push(f.path); // 源不存在
			continue;
		}
		if (!st.isFile()) { unsafeSources.push(f.path); continue; }
		if (st.size !== f.size || sha256File(src) !== f.sha256) mismatches.push(f.path);
	}
	if (unsafeSources.length > 0) {
		throw new BackupError("unsafe_source", `恢复源不是常规文件（符号链接/目录/设备），拒绝恢复（固定类别）：\n${unsafeSources.join("\n")}`);
	}
	if (mismatches.length > 0) {
		throw new BackupError("checksum_mismatch", `备份文件校验不一致，拒绝恢复（固定类别）：\n${mismatches.join("\n")}`);
	}

	// 4. 目标必须是新的空目录（任一非空即拒绝，绝不覆盖）
	ensureEmptyTarget(stateRoot, "目标 stateRoot");
	ensureEmptyTarget(workspaceRoot, "目标 workspaceRoot");
	if (auditTarget !== undefined && existsSync(auditTarget)) {
		throw new BackupError("target_not_empty", `审计恢复目标已存在，拒绝恢复（固定类别；绝不覆盖既有审计链）：${auditTarget}`);
	}

	// 5. 拷贝（读源一律 joinContained，且已在步骤 3 经 lstat 验为常规文件；
	// audit/ 前缀按 --audit-file 落位；未提供则跳过并注明）
	let auditRestored = false;
	for (const f of manifest.files) {
		const src = joinContained(backupDir, f.path, "恢复源");
		if (f.path.startsWith("audit/")) {
			if (auditTarget === undefined) {
				warnings.push("备份含审计文件但未提供 --audit-file，审计未恢复（恢复报告审批状态将为 unknown）");
				continue;
			}
			mkdirSync(dirname(auditTarget), { recursive: true, mode: 0o700 });
			copyFileSync(src, auditTarget);
			try { chmodSync(auditTarget, 0o600); } catch { /* umask 兜底 */ }
			auditRestored = true;
			continue;
		}
		const dest = mapTarget(f.path, stateRoot, workspaceRoot);
		mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
		copyFileSync(src, dest);
		try { chmodSync(dest, 0o600); } catch { /* umask 兜底 */ }
	}
	try { chmodSync(stateRoot, 0o700); } catch { /* umask 兜底 */ }
	try { chmodSync(workspaceRoot, 0o700); } catch { /* 同上 */ }

	// 6. 恢复后 sqlite integrity_check + 关键表行数比对 manifest（行数不一致即拒 ——
	// 防止「文件自洽但数据丢了」这类损坏静默通过）
	const broken: string[] = [];
	for (const f of walkFiles(stateRoot)) {
		if (!f.rel.endsWith(".sqlite")) continue;
		try {
			const db = new DatabaseSync(f.abs, { readOnly: true });
			try {
				const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
				if (!row || row.integrity_check !== "ok") { broken.push(f.rel); continue; }
				const recorded = manifest.files.find((entry) => entry.path === `state/${f.rel}`)?.rows;
				if (recorded === undefined) {
					// 备份产物必经 VACUUM INTO 通道，manifest 必带行数清单：缺失即篡改/异构来源，固定拒
					broken.push(`${f.rel}（manifest 缺少 sqlite 行数清单，固定类别）`);
					continue;
				}
				const actual = countTables(db);
				for (const [table, count] of Object.entries(recorded)) {
					if (actual[table] !== count) {
						broken.push(`${f.rel}（表 ${table}: manifest=${String(count)} 恢复=${String(actual[table])}）`);
					}
				}
			} finally {
				db.close();
			}
		} catch {
			broken.push(f.rel);
		}
	}
	if (broken.length > 0) {
		throw new BackupError("sqlite_integrity_failed", `恢复后 SQLite integrity_check 未通过（固定类别）：\n${broken.join("\n")}`);
	}

	// 7. 逐会话校验 workspace git HEAD 与 manifest 一致（绝不 reset/checkout）
	const headMismatches: string[] = [];
	const sessions = (manifest.sessions ?? []).map((entry) => {
		const facts = gitFacts(join(workspaceRoot, entry.sessionId));
		const headMatches = entry.gitHead === null ? true : facts.gitHead === entry.gitHead;
		if (!headMatches) headMismatches.push(entry.sessionId);
		return {
			sessionId: entry.sessionId,
			gitHead: facts.gitHead,
			manifestHead: entry.gitHead,
			headMatches,
			dirty: facts.dirty,
			unpushed: facts.unpushed,
			workspacePresent: facts.workspacePresent,
		};
	});
	if (headMismatches.length > 0) {
		throw new BackupError("session_head_mismatch", `恢复后 workspace git HEAD 与 manifest 不一致（固定类别；不做 reset/checkout）：\n${headMismatches.join("\n")}`);
	}

	// 8. 收据盘点：outcome_unknown / 未终态 / 损坏（运行时按同样口径 fail-closed）
	const receipts = { total: 0, outcomeUnknown: [] as { operationId: string; sessionId: string }[], nonTerminal: [] as { operationId: string; sessionId: string; stage: string }[], corrupt: [] as string[] };
	try {
		for (const f of walkFiles(join(stateRoot, "receipts"))) {
			if (!f.rel.endsWith(".json")) continue;
			try {
				const parsed = JSON.parse(readFileSync(f.abs, "utf8")) as { operationId?: unknown; sessionId?: unknown; stage?: unknown; outcome?: unknown };
				receipts.total++;
				const item = { operationId: String(parsed.operationId ?? "?"), sessionId: String(parsed.sessionId ?? "?") };
				if (parsed.stage === "outcome_unknown" || parsed.outcome === "unknown") receipts.outcomeUnknown.push(item);
				else if (parsed.stage === "accepted" || parsed.stage === "workspace_ready") receipts.nonTerminal.push({ ...item, stage: String(parsed.stage) });
			} catch {
				receipts.corrupt.push(f.rel);
			}
		}
	} catch { /* 无 receipts 目录 */ }
	if (receipts.corrupt.length > 0) warnings.push(`存在损坏收据（fail-closed，交运维处理）：${receipts.corrupt.join(", ")}`);

	// 9. pending 审批：按恢复后的审计链配对（approval.request 无对应 approval.decision）。
	// 口径说明：运行时权威是 durable 的审批 doc；恢复报告以审计链为近似事实源。
	const pendingApprovals: { sessionId: string; callId: string; at: string }[] = [];
	let pendingApprovalsKnown = false;
	if (auditRestored && auditTarget !== undefined && existsSync(auditTarget)) {
		pendingApprovalsKnown = true;
		const requested = new Map<string, { sessionId: string; callId: string; at: string }>();
		for await (const entry of AuditLog.replay(auditTarget)) {
			if (!entry.callId) continue;
			if (entry.kind === "approval.request") requested.set(entry.callId, { sessionId: entry.sessionId, callId: entry.callId, at: entry.at });
			else if (entry.kind === "approval.decision") requested.delete(entry.callId);
		}
		pendingApprovals.push(...requested.values());
	}

	const report: RestoreReport = {
		restorePoint: { backupDir, createdAt: manifest.createdAt, sourceEpoch: manifest.source?.epoch ?? null },
		stateRoot,
		workspaceRoot,
		audit: { restored: auditRestored, path: auditRestored && auditTarget !== undefined ? auditTarget : null },
		sessions,
		receipts,
		pendingApprovals,
		pendingApprovalsKnown,
		warnings,
	};
	return report;
}

function argOf(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
	try {
		const backup = argOf("backup");
		const stateRoot = argOf("state-root");
		const workspaceRoot = argOf("workspace-root");
		if (!backup || !stateRoot || !workspaceRoot) {
			throw new BackupError("usage", "用法：npm run restore -- --backup <dir> --state-root <dir> --workspace-root <dir> [--audit-file <out>] [--report <file>]");
		}
		const report = await runRestore({ backup, stateRoot, workspaceRoot, auditFile: argOf("audit-file") });
		const reportFile = argOf("report");
		if (reportFile !== undefined) {
			writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
		}
		console.log(JSON.stringify(report, null, 2));
	} catch (err) {
		console.error(err instanceof Error ? err.message : err);
		process.exitCode = 1;
	}
}
