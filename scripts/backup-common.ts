import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

/**
 * S3d：backup.ts / restore.ts 共用的最小工具集（固定类别错误、hash、拷贝、git 事实）。
 * 刻意不依赖网关内部模块，脚本可独立于网关代码演进；锁语义经 src/gateway/state-lock.ts
 * 的只读探测取得，不在此重复实现。
 */

/** 固定类别错误：code 供调用方按类别处理；message 面向运维，可直接回显 */
export class BackupError extends Error {
	code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "BackupError";
		this.code = code;
	}
}

/** durable 库关键表：行数清单用于备份/恢复两侧证明数据完整性（非 durable 库计 null） */
const DURABLE_TABLES = ["durable_metadata", "conversations", "entries", "submissions", "tasks", "documents", "document_revisions"] as const;

export function countTables(db: DatabaseSync): Record<string, number | null> {
	const out: Record<string, number | null> = {};
	for (const table of DURABLE_TABLES) {
		try {
			const row = db.prepare(`SELECT count(*) AS c FROM "${table}"`).get() as { c: number } | undefined;
			out[table] = row ? Number(row.c) : null;
		} catch {
			out[table] = null; // 表不存在（非 durable 库）：如实记 null，不虚构 0
		}
	}
	return out;
}

/** 分块读文件的 sha256（工作区可能很大，不整读进内存） */
export function sha256File(path: string): string {
	const hash = createHash("sha256");
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(1024 * 1024);
		for (;;) {
			const n = readSync(fd, buf, 0, buf.length, null);
			if (n === 0) break;
			hash.update(buf.subarray(0, n));
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

export interface WalkedFile { abs: string; rel: string }

/** 递归列出常规文件（posix 相对路径，稳定排序）；符号链接等非常规文件一律拒绝（恢复侧逃逸面） */
export function walkFiles(root: string): WalkedFile[] {
	const out: WalkedFile[] = [];
	const walk = (dir: string, rel: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
		} catch {
			return; // 根不存在 / 不可读：调用方按空目录处理
		}
		for (const entry of entries) {
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(join(dir, entry.name), childRel);
			else if (entry.isFile()) out.push({ abs: join(dir, entry.name), rel: childRel });
			else throw new BackupError("special_file", `遇到非常规文件（符号链接等），拒绝处理（固定类别）：${childRel}`);
		}
	};
	walk(root, "");
	return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

export interface CopyFilter {
	/** posix 相对路径；返回 true 排除该文件 */
	excludeFile?: (rel: string) => boolean;
	/** posix 相对路径；返回 true 跳过整个目录 */
	excludeDir?: (rel: string) => boolean;
}

/**
 * 递归拷贝：目录 0700、文件 0600；不跟随符号链接（拷贝符号链接会在恢复侧产生逃逸面）。
 * 返回已拷贝文件的相对路径（posix 分隔符）。
 */
export function copyTreeSync(srcRoot: string, destRoot: string, filter: CopyFilter = {}): string[] {
	const copied: string[] = [];
	const walk = (dir: string, rel: string): void => {
		if (rel && filter.excludeDir?.(rel)) return;
		mkdirSync(join(destRoot, rel), { recursive: true, mode: 0o700 });
		try { chmodSync(join(destRoot, rel), 0o700); } catch { /* mode 受 umask 影响时的兜底 */ }
		for (const entry of readdirSync(dir, { withFileTypes: true, encoding: "utf8" })) {
			if (entry.isSymbolicLink()) throw new BackupError("special_file", `源中含符号链接，拒绝拷贝（固定类别）：${rel ? `${rel}/` : ""}${entry.name}`);
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				walk(join(dir, entry.name), childRel);
				continue;
			}
			if (!entry.isFile()) throw new BackupError("special_file", `源中含非常规文件，拒绝拷贝（固定类别）：${childRel}`);
			if (filter.excludeFile?.(childRel)) continue;
			copyFileSync(join(dir, entry.name), join(destRoot, childRel));
			try { chmodSync(join(destRoot, childRel), 0o600); } catch { /* 同上 */ }
			copied.push(childRel);
		}
	};
	walk(srcRoot, "");
	return copied;
}

export interface Unpushed { count: number; noUpstream: boolean }

export interface GitFacts {
	/** null = 无 .git 或 rev-parse 失败（不虚构 HEAD） */
	gitHead: string | null;
	/** 是否有未提交改动（status --porcelain 非空；无 .git 时恒 false） */
	dirty: boolean;
	/** 未推送提交数；无 upstream 时按全部本地提交计并标注 noUpstream */
	unpushed: Unpushed | null;
	workspacePresent: boolean;
}

function git(args: string[], cwd: string): { ok: boolean; stdout: string } {
	const res = spawnSync("git", args, { cwd, encoding: "utf8" });
	return { ok: res.status === 0, stdout: typeof res.stdout === "string" ? res.stdout : "" };
}

/** workspace 的 git 事实：HEAD、未提交改动、未推送提交数。绝不 reset/checkout —— 只读 */
export function gitFacts(workspace: string): GitFacts {
	if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
		return { gitHead: null, dirty: false, unpushed: null, workspacePresent: false };
	}
	if (!existsSync(join(workspace, ".git"))) return { gitHead: null, dirty: false, unpushed: null, workspacePresent: true };
	const head = git(["rev-parse", "HEAD"], workspace);
	const trimmed = head.stdout.trim();
	const gitHead = head.ok && /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
	const status = git(["status", "--porcelain"], workspace);
	const dirty = status.ok && status.stdout.trim().length > 0;
	const upstream = git(["rev-list", "--count", "@{upstream}..HEAD"], workspace);
	if (upstream.ok) {
		const count = Number.parseInt(upstream.stdout.trim(), 10);
		return { gitHead, dirty, unpushed: Number.isSafeInteger(count) ? { count, noUpstream: false } : null, workspacePresent: true };
	}
	const local = git(["rev-list", "--count", "HEAD"], workspace);
	const count = local.ok ? Number.parseInt(local.stdout.trim(), 10) : Number.NaN;
	return { gitHead, dirty, unpushed: Number.isSafeInteger(count) ? { count, noUpstream: true } : null, workspacePresent: true };
}
