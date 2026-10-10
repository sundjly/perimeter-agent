import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
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
	close(): Promise<void>;
}

export async function openEnvironment(plan: EnvironmentPlan): Promise<EnvironmentHandle> {
	if (plan.start) await promisify(execFile)(plan.start.bin, plan.start.args, { env: { PATH: process.env.PATH, ...plan.start.env }, timeout: 30_000 });
	if (!plan.command) {
		const env = new NodeExecutionEnv({ cwd: plan.cwd, shellEnv: { PATH: process.env.PATH, ...(plan.home ? { HOME: plan.home } : {}) } });
		return { env, close: () => env.cleanup(BACKGROUND_CONTEXT) };
	}
	const connection = new Connection({ command: plan.command });
	try {
		await connection.info();
		const env = new RemoteExecutionEnv({ connection, id: plan.command.join(" "), cwd: plan.cwd });
		return { env, close: async () => connection.close() };
	} catch (error) {
		connection.close();
		throw error;
	}
}
