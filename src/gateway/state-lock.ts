import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/**
 * S3a：stateRoot 单实例独占锁（handoff §3.3）。
 *
 * 语义边界，一条都不能让：
 * - 独占创建（`wx`）是唯一的判定原语；接管走「rename 隔离 + `wx` 重建」，
 *   rename 原子性保证并发接管时只有一个赢家，输家拒绝启动。
 * - 只在「同主机且 pid 已不存在」时接管陈旧锁。**没有心跳、没有过期时间** ——
 *   时间推断抢不活实例的锁（Paseo supervisor 契约：不用过期心跳抢活锁）。
 * - 锁来自其他主机（无法验证 pid 是否存活）或内容无法解析 → 拒绝启动，
 *   交运维处理，不自动接管。
 * - 锁内容含 pid、主机名、随机启动 nonce、启动时间；释放时只删自己 nonce 的锁，
 *   防止误删已被接管的文件。
 */

export const LOCK_FILE_NAME = "gateway.lock";

export interface LockContent {
	pid: number;
	hostname: string;
	nonce: string;
	startedAt: string;
}

export interface HeldLock {
	path: string;
	nonce: string;
}

/** 固定类别错误：锁获取失败一律是它，调用方按类别处理，不透传底层 errno 原文 */
export class GatewayLockError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GatewayLockError";
	}
}

function parseLockContent(raw: string): LockContent {
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	if (typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) throw new Error("pid 非法");
	if (typeof parsed.hostname !== "string" || parsed.hostname.length === 0) throw new Error("hostname 非法");
	if (typeof parsed.nonce !== "string" || parsed.nonce.length === 0) throw new Error("nonce 非法");
	if (typeof parsed.startedAt !== "string" || parsed.startedAt.length === 0) throw new Error("startedAt 非法");
	return { pid: parsed.pid, hostname: parsed.hostname, nonce: parsed.nonce, startedAt: parsed.startedAt };
}

/** 与 src/audit/log.ts 同一判定约定：EPERM 视为存活（他人的进程，不可信号但存在） */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function createExclusive(path: string, content: LockContent): void {
	writeFileSync(path, JSON.stringify(content), { flag: "wx", mode: 0o600 });
	try { chmodSync(path, 0o600); } catch { /* 刚以 0600 创建；chmod 兜底失败不影响语义 */ }
}

export function acquireGatewayLock(stateRoot: string): HeldLock {
	const path = join(stateRoot, LOCK_FILE_NAME);
	const content: LockContent = { pid: process.pid, hostname: hostname(), nonce: randomUUID(), startedAt: new Date().toISOString() };
	try {
		createExclusive(path, content);
		return { path, nonce: content.nonce };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
			throw new GatewayLockError("stateRoot 独占锁不可创建，拒绝启动（固定类别）");
		}
	}
	// 已有锁：先解析持有者，再决定拒/接管
	let holder: LockContent;
	try {
		holder = parseLockContent(readFileSync(path, "utf8"));
	} catch {
		throw new GatewayLockError("stateRoot 独占锁内容无法解析，拒绝启动（固定类别；交运维处理，不自动接管）");
	}
	if (holder.hostname !== hostname()) {
		throw new GatewayLockError("stateRoot 独占锁由其他主机持有，拒绝启动（固定类别；交运维处理，不自动接管）");
	}
	if (isAlive(holder.pid)) {
		throw new GatewayLockError(`stateRoot 已由本机活实例持有（pid ${holder.pid}），拒绝启动（固定类别）`);
	}
	// 陈旧锁原子接管：rename 到带 nonce 的隔离名，再独占重建。并发接管时 rename 后
	// 只有一个 `wx` 赢家；输家在此拒绝启动，不会覆盖赢家的锁。
	const quarantine = `${path}.${holder.nonce}.quarantine`;
	try {
		renameSync(path, quarantine);
	} catch {
		throw new GatewayLockError("stateRoot 陈旧锁接管失败（已被其他实例接管或不可重命名），拒绝启动（固定类别）");
	}
	try {
		createExclusive(path, content);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			throw new GatewayLockError("stateRoot 独占锁接管竞争失败：已被其他实例抢先接管，拒绝启动（固定类别）");
		}
		throw new GatewayLockError("stateRoot 独占锁接管后重建失败，拒绝启动（固定类别）");
	}
	return { path, nonce: content.nonce };
}

/** 只释放自己 nonce 的锁：文件已易主/已清理/不可读时一律不动 */
export function releaseGatewayLock(lock: HeldLock): void {
	let current: LockContent;
	try {
		current = parseLockContent(readFileSync(lock.path, "utf8"));
	} catch {
		return; // 已被清理或不可读：不是（或不确认是）自己的锁，不删
	}
	if (current.nonce !== lock.nonce) return;
	try {
		unlinkSync(lock.path);
	} catch { /* 已被清理 */ }
}

/** 就绪探测：锁文件仍在且 nonce 属于本实例（防锁被外力删除/覆盖后仍谎报 ready） */
export function lockStillHeld(lock: HeldLock): boolean {
	try {
		const current = parseLockContent(readFileSync(lock.path, "utf8"));
		return current.nonce === lock.nonce && current.pid === process.pid;
	} catch {
		return false;
	}
}
