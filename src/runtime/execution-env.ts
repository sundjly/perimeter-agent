import { execFile } from "node:child_process";
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
	close(): Promise<void>;
}

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
		await connection.info();
		const env = new RemoteExecutionEnv({ connection, id: plan.command.join(" "), cwd: plan.cwd });
		return { env, close: async () => connection.close() };
	} catch (error) {
		connection.close();
		throw error;
	}
}
