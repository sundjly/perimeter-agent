import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv, ShellExecOptions } from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";

export interface EnvironmentPlan {
	cwd: string;
	home?: string;
	command?: string[];
	start?: { bin: string; args: string[]; env: NodeJS.ProcessEnv };
}

export interface EnvironmentHandle {
	env: ExecutionEnv;
	/** 守卫专用 pinned env（同一 Connection/sessionPin；仅远端）。缺省＝本地（守卫走 localEnvironment）。 */
	guardEnv?: ExecutionEnv;
	close(): Promise<void>;
}

/**
 * 远端 env 的 daemon 元数据（打开时由 Connection.snapshot() 一次性取得，info+sessionId 同一次 #connect 原子一致）。
 * 守卫（path-guard）同步读取，guard 路径零 info() await——预算不被 SDK 首连/重连吞掉。
 */
export const remoteEnvHome = new WeakMap<object, string>();

// G1（session-pin）SDK 补丁运行时核验：schema/路径边界/哈希比对全部在 pi-env-patch 核心模块（R3/R6）。
// 生产默认仓库根固定（verifyPiEnvPatchInstalled() 无参），用户路径不能改变校验对象。
import { verifyPiEnvPatchInstalled, assertSnapshotCapability, assertPinnedSessionGetter } from "./pi-env-patch.ts";

export { verifyPiEnvPatchInstalled };

export function localEnvironment(cwd: string, home?: string): NodeExecutionEnv {
	const env = new NodeExecutionEnv({ cwd });
	const exec = env.exec.bind(env);
	env.exec = (command: string | readonly string[], options: ShellExecOptions | undefined, context: Context) => exec(command, {
		...options, inheritEnv: false, env: { PATH: process.env.PATH ?? "", ...(home ? { HOME: home } : {}), ...options?.env },
	}, context);
	return env;
}

export async function openEnvironment(plan: EnvironmentPlan): Promise<EnvironmentHandle> {
	if (plan.start) await promisify(execFile)(plan.start.bin, plan.start.args, { env: { PATH: process.env.PATH, ...plan.start.env }, timeout: 30_000 });
	if (!plan.command) {
		const env = localEnvironment(plan.cwd, plan.home);
		return { env, close: () => env.cleanup(BACKGROUND_CONTEXT) };
	}
	const connection = new Connection({ command: plan.command });
	try {
		// G1：R-Q3 runtime 门槛（显式 kind==patched，original 也拒）→ R-Q4 能力检查①（旧 SDK 零 spawn 干净拒绝）
		// → 原子快照（info+sessionId 同一次 #connect）→ 检查② getter 一致性复核。
		verifyPiEnvPatchInstalled();
		assertSnapshotCapability(connection);
		const snap = await connection.snapshot();
		const env = new RemoteExecutionEnv({ connection, id: plan.command.join(" "), cwd: plan.cwd });
		remoteEnvHome.set(env, snap.info.home);
		// 守卫专用 pinned env：同一 Connection、同 cwd，exec 全部 pin 到打开会话；掉线立即 lost，零重连/零新 daemon。
		const guardEnv = new RemoteExecutionEnv({ connection, id: `${plan.command.join(" ")}#guard`, cwd: plan.cwd, sessionPin: snap.sessionId });
		assertPinnedSessionGetter(guardEnv, snap.sessionId);
		remoteEnvHome.set(guardEnv, snap.info.home);
		return { env, guardEnv, close: async () => connection.close() };
	} catch (error) {
		connection.close();
		throw error;
	}
}
