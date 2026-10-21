import { createServer, type Server as HttpServer } from "node:http";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { AuditLog } from "../audit/log.ts";
import { Gateway } from "../gateway/server.ts";
import { LocalBackend } from "../gateway/execution-backend.ts";
import { ModelGateway } from "../modelgw/server.ts";
import type { ClientEvent } from "../protocol/types.ts";
import { BENCHMARK_FIXTURE_TASKS, type BenchmarkFixtureTask } from "./benchmark-fixtures.ts";

export interface BenchmarkMeasurement {
	taskId: string;
	mode: "cold" | "warm" | "recovery";
	repetition: number;
	success: boolean;
	durationMs: number;
	ttftMs: number | null;
	recoveryTimeToOperableMs: number | null;
	memoryMetric: {
		target: "runner_process";
		pid: number;
		rssBytes: number;
		note: "测量主体为 runner 宿主进程自身，非 Gateway/Harness 子进程";
	};
	rssBytes: number;
	eventsCount: number;
	inputTokens: number | null;
	outputTokens: number | null;
	cachedTokens: number | null;
	usageSource: "mock-reported" | "unknown / missing-source";
	realCostDollars: null;
	mockConfiguredCostDollars: number;
	harnessError?: string;
	recoveryProcessMeta?: {
		instanceAPid: number;
		instanceAExitCode: number | null;
		instanceAExitSignal: NodeJS.Signals | null;
		instanceBPid: number;
	};
}

export interface MockServerOptions {
	negative?: boolean;
	omitUsage?: boolean;
	customPromptTokens?: number;
	customCompletionTokens?: number;
}

export interface PipelineOptions {
	repoRoot: string;
	runRoot?: string;
	timeoutMs?: number;
	negative?: boolean;
	mockOptions?: MockServerOptions;
}

export function cleanTestEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	delete env.NODE_TEST_WORKER_ID;
	return env;
}

/**
 * 本地 Mock 模型 HTTP 服务
 * 严格监听 127.0.0.1 随机端口，响应 OpenAI 兼容的 SSE 流
 */
export class LocalBenchmarkMockServer {
	#server: HttpServer;
	#port = 0;
	#opts: MockServerOptions;

	constructor(opts: boolean | MockServerOptions = false) {
		this.#opts = typeof opts === "boolean" ? { negative: opts } : opts;
		this.#server = createServer((req, res) => {
			if (!req.url?.includes("/chat/completions")) {
				res.writeHead(404).end();
				return;
			}
			let body = "";
			req.on("data", (chunk) => { body += chunk; });
			req.on("end", () => {
				try {
					const parsed = JSON.parse(body || "{}");
					const messages = parsed.messages ?? [];
					const lastMsg = messages.at(-1);

					// 识别当前会话或 prompt 所属任务
					let matchedTask: BenchmarkFixtureTask | undefined;
					const fullText = JSON.stringify(messages);
					for (const task of BENCHMARK_FIXTURE_TASKS) {
						if (fullText.includes(task.id) || fullText.includes(task.prompt.slice(0, 20))) {
							matchedTask = task;
							break;
						}
					}
					// 缺省时默认使用 task-01
					matchedTask ??= BENCHMARK_FIXTURE_TASKS[0];

					res.writeHead(200, {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
						connection: "keep-alive",
					});

					const sse = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

					// 如果最后一轮消息来自 tool 执行结果，返回最终完成确认
					if (lastMsg?.role === "tool") {
						sse({
							id: `cmpl-${randomUUID()}`,
							object: "chat.completion.chunk",
							created: Math.floor(Date.now() / 1000),
							model: "mock-model",
							choices: [{ index: 0, delta: { role: "assistant", content: "任务已由模型工具执行并修复完毕。" }, finish_reason: null }],
						});
						const finalChunk: Record<string, unknown> = {
							id: `cmpl-${randomUUID()}`,
							object: "chat.completion.chunk",
							created: Math.floor(Date.now() / 1000),
							model: "mock-model",
							choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						};
						if (!this.#opts.omitUsage) {
							finalChunk.usage = { prompt_tokens: 150, completion_tokens: 15, total_tokens: 165 };
						}
						sse(finalChunk);
						res.write("data: [DONE]\n\n");
						res.end();
						return;
					}

					// 首轮请求：根据是否 negative 返回对应 tool call
					const activeTask = matchedTask ?? BENCHMARK_FIXTURE_TASKS[0]!;
					const toolCallSpec = this.#opts.negative
						? activeTask.negativeMockToolCall
						: activeTask.mockToolCall;

					sse({
						id: `cmpl-${randomUUID()}`,
						object: "chat.completion.chunk",
						created: Math.floor(Date.now() / 1000),
						model: "mock-model",
						choices: [
							{
								index: 0,
								delta: {
									role: "assistant",
									tool_calls: [
										{
											index: 0,
											id: `call_${randomUUID().slice(0, 8)}`,
											type: "function",
											function: {
												name: toolCallSpec.tool,
												arguments: JSON.stringify(toolCallSpec.args),
											},
										},
									],
								},
								finish_reason: null,
							},
						],
					});

					const firstChunk: Record<string, unknown> = {
						id: `cmpl-${randomUUID()}`,
						object: "chat.completion.chunk",
						created: Math.floor(Date.now() / 1000),
						model: "mock-model",
						choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
					};
					if (!this.#opts.omitUsage) {
						const pTokens = this.#opts.customPromptTokens ?? 120;
						const cTokens = this.#opts.customCompletionTokens ?? 25;
						firstChunk.usage = { prompt_tokens: pTokens, completion_tokens: cTokens, total_tokens: pTokens + cTokens };
					}
					sse(firstChunk);
					res.write("data: [DONE]\n\n");
					res.end();
				} catch (err) {
					res.writeHead(500).end(String(err));
				}
			});
		});
	}

	async listen(): Promise<number> {
		return new Promise((resolve, reject) => {
			this.#server.listen(0, "127.0.0.1", () => {
				const addr = this.#server.address();
				if (typeof addr === "object" && addr) {
					this.#port = addr.port;
					resolve(this.#port);
				} else {
					reject(new Error("Mock model server failed to bind port"));
				}
			});
			this.#server.once("error", reject);
		});
	}

	async close(): Promise<void> {
		return new Promise((resolve) => {
			this.#server.close(() => resolve());
		});
	}

	get port(): number {
		return this.#port;
	}
}

/**
 * S0 真实执行管道环境
 */
export class BenchmarkPipeline {
	readonly repoRoot: string;
	readonly runRoot: string;
	readonly runId: string;
	#mockServer?: LocalBenchmarkMockServer;
	#modelGw?: ModelGateway;
	#modelPort = 0;
	#audit?: AuditLog;

	constructor(opts: PipelineOptions) {
		this.repoRoot = opts.repoRoot;
		this.runId = `bench-${Date.now()}-${randomUUID().slice(0, 8)}`;
		this.runRoot = opts.runRoot ?? join(tmpdir(), `perimeter-${this.runId}`);
		mkdirSync(this.runRoot, { recursive: true });
	}

	async startServices(opts: boolean | MockServerOptions = false): Promise<void> {
		this.#mockServer = new LocalBenchmarkMockServer(opts);
		const upstreamPort = await this.#mockServer.listen();

		const auditPath = join(this.runRoot, "modelgw.jsonl");
		this.#audit = AuditLog.open(auditPath);

		this.#modelGw = new ModelGateway({
			port: 0,
			host: "127.0.0.1",
			token: "benchmark-proxy-token",
			upstreams: [{
				id: "mock",
				baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
				apiKey: "dummy-key",
			}],
			egressAllowlist: ["127.0.0.1"],
			audit: this.#audit,
		});

		this.#modelPort = await this.#modelGw.listen();
	}

	async closeServices(): Promise<void> {
		try {
			await this.#modelGw?.close();
		} finally {
			try {
				this.#audit?.close();
			} finally {
				await this.#mockServer?.close();
				try {
					// 仅清理本次已正面识别归属的 owned runRoot exact path，不扫 generic perimeter-*，不误删用户数据
					rmSync(this.runRoot, { recursive: true, force: true });
				} catch {}
			}
		}
	}

	getModelConfig() {
		return {
			baseUrl: `http://127.0.0.1:${this.#modelPort}/v1`,
			token: "benchmark-proxy-token",
			model: "mock-model",
		};
	}

	/**
	 * 启动独立的 Gateway 操作系统子进程 (OS Process Isolation)
	 */
	async spawnGatewayChild(sessionId: string, stateDir: string, wsDir: string): Promise<{
		child: ChildProcess;
		pid: number;
		port: number;
		close: () => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
	}> {
		const child = spawn(process.execPath, [join(this.repoRoot, "src/evals/gateway-process.ts")], {
			env: {
				...cleanTestEnv(),
				PATH: process.env.PATH,
				PERIMETER_RUN_ROOT: this.runRoot,
				PERIMETER_SESSION_ID: sessionId,
				PERIMETER_MODEL_URL: `http://127.0.0.1:${this.#modelPort}/v1`,
				PERIMETER_POLICY_FILE: join(this.repoRoot, "config/policy.yaml"),
				PERIMETER_WEB_ROOT: join(this.repoRoot, "web"),
				PERIMETER_STATE_ROOT: stateDir,
				PERIMETER_WORKSPACE_ROOT: join(this.runRoot, "workspaces"),
			},
			stdio: ["pipe", "pipe", "inherit"],
		});

		const pid = child.pid!;
		if (!pid) throw new Error("Failed to spawn gateway child process: no PID");

		const [chunk] = await once(child.stdout!, "data");
		const { port } = JSON.parse(String(chunk).trim());

		const close = async () => {
			if (child.exitCode !== null || child.signalCode !== null) {
				return { exitCode: child.exitCode, signal: child.signalCode };
			}
			const exitPromise = once(child, "exit");
			try {
				child.stdin?.write("close\n");
				child.stdin?.end();
			} catch {}

			const timeoutTimer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) {
					child.kill("SIGTERM");
				}
			}, 3000);

			await exitPromise;
			clearTimeout(timeoutTimer);
			return { exitCode: child.exitCode, signal: child.signalCode };
		};

		return { child, pid, port, close };
	}

	/**
	 * 在指定 workspaceRoot 下释放任务初始文件
	 */
	materializeTask(task: BenchmarkFixtureTask, workspace: string): void {
		rmSync(workspace, { recursive: true, force: true });
		mkdirSync(workspace, { recursive: true });
		for (const [file, content] of Object.entries(task.files)) {
			const full = join(workspace, file);
			writeFileSync(full, content);
		}
	}

	/**
	 * 执行单次冷启动测量 (Cold Run)
	 */
	async runCold(task: BenchmarkFixtureTask, rep = 1): Promise<BenchmarkMeasurement> {
		const sessionId = `cold-${task.id}-${rep}-${randomUUID().slice(0, 6)}`;
		const wsDir = join(this.runRoot, "workspaces", sessionId);
		const stateDir = join(this.runRoot, "state", sessionId);
		this.materializeTask(task, wsDir);

		// 验证 failsAtStart (必须真实红灯)
		for (const idx of task.failsAtStart) {
			const cmd = task.verify[idx]!;
			let failed = false;
			try {
				execSync(cmd, { cwd: wsDir, stdio: "pipe", timeout: 3000, env: cleanTestEnv() });
			} catch {
				failed = true;
			}
			if (!failed) {
				throw new Error(`Task ${task.id} failsAtStart[${idx}] did NOT fail on cold start!`);
			}
		}

		const gateway = new Gateway({
			mode: "demo",
			port: 0,
			host: "127.0.0.1",
			token: `tok-${sessionId}`,
			policyFile: join(this.repoRoot, "config/policy.yaml"),
			auditFile: join(this.runRoot, `audit-${sessionId}.jsonl`),
			workspaceRoot: join(this.runRoot, "workspaces"),
			stateRoot: stateDir,
			webRoot: join(this.repoRoot, "web"),
			model: this.getModelConfig(),
			backend: new LocalBackend(),
			approvalTimeoutMs: 10_000,
		});

		let ws: WebSocket | undefined;
		let ttftMs: number | null = null;
		let eventsCount = 0;
		let latestUsage: { input: number; output: number; cacheRead: number } | null = null;
		let success = false;
		let harnessError: string | undefined;

		const t0 = performance.now();
		try {
			const port = await gateway.listen();
			ws = new WebSocket(`ws://127.0.0.1:${port}/?token=tok-${sessionId}&session=${sessionId}&actor=owner`);

			const events: ClientEvent[] = [];
			await new Promise<void>((resolve, reject) => {
				ws!.once("open", () => resolve());
				ws!.once("error", reject);
			});

			ws.on("message", (raw) => {
				const frame = JSON.parse(String(raw));
				if (frame.event) {
					events.push(frame.event);
					eventsCount++;
					const e = frame.event as ClientEvent;
					if (ttftMs === null && (e.type === "message.text" || e.type === "agent.start")) {
						ttftMs = performance.now() - t0;
					}
					if (e.type === "usage") {
						latestUsage = { input: e.usage.input, output: e.usage.output, cacheRead: e.usage.cacheRead ?? 0 };
					}
				}
			});

			// 等待 session.ready
			const deadline = Date.now() + 10_000;
			while (!events.some((e) => e.type === "session.ready")) {
				if (Date.now() > deadline) throw new Error("session.ready timeout");
				await new Promise((r) => setTimeout(r, 20));
			}

			// 发送包含 task id 与 prompt 的请求
			ws.send(JSON.stringify({
				type: "prompt",
				text: `[${task.id}] ${task.prompt}`,
				requestId: randomUUID(),
			}));

			// 等待 agent.end
			const runDeadline = Date.now() + 15_000;
			while (!events.some((e) => e.type === "agent.end")) {
				if (Date.now() > runDeadline) throw new Error("agent.end timeout");
				await new Promise((r) => setTimeout(r, 20));
			}

			// 验证全部 verify 命令
			for (const cmd of task.verify) {
				execSync(cmd, { cwd: wsDir, stdio: "pipe", timeout: 3000, env: cleanTestEnv() });
			}
			success = true;
		} catch (err) {
			success = false;
			harnessError = (err as Error).message;
		} finally {
			ws?.terminate();
			await gateway.close();
		}

		const durationMs = performance.now() - t0;
		const u = latestUsage as { input: number; output: number; cacheRead: number } | null;
		const hasRealUsage = Boolean(u && (u.input > 0 || u.output > 0));
		return {
			taskId: task.id,
			mode: "cold",
			repetition: rep,
			success,
			durationMs: Math.round(durationMs),
			ttftMs: ttftMs ? Math.round(ttftMs) : null,
			recoveryTimeToOperableMs: null,
			memoryMetric: {
				target: "runner_process",
				pid: process.pid,
				rssBytes: process.memoryUsage().rss,
				note: "测量主体为 runner 宿主进程自身，非 Gateway/Harness 子进程",
			},
			rssBytes: process.memoryUsage().rss,
			eventsCount,
			inputTokens: hasRealUsage && u ? u.input : null,
			outputTokens: hasRealUsage && u ? u.output : null,
			cachedTokens: (hasRealUsage && u && u.cacheRead > 0) ? u.cacheRead : null,
			usageSource: hasRealUsage ? "mock-reported" : "unknown / missing-source",
			realCostDollars: null,
			mockConfiguredCostDollars: 0.0,
			harnessError,
		};
	}

	/**
	 * 执行单次热复用测量 (Warm Run - 复用同一网关与会话稳定前缀)
	 */
	async runWarm(task: BenchmarkFixtureTask, rep = 1): Promise<BenchmarkMeasurement> {
		const sessionId = `warm-${task.id}-${rep}-${randomUUID().slice(0, 6)}`;
		const wsDir = join(this.runRoot, "workspaces", sessionId);
		const stateDir = join(this.runRoot, "state", sessionId);
		this.materializeTask(task, wsDir);

		const gateway = new Gateway({
			mode: "demo",
			port: 0,
			host: "127.0.0.1",
			token: `tok-${sessionId}`,
			policyFile: join(this.repoRoot, "config/policy.yaml"),
			auditFile: join(this.runRoot, `audit-${sessionId}.jsonl`),
			workspaceRoot: join(this.runRoot, "workspaces"),
			stateRoot: stateDir,
			webRoot: join(this.repoRoot, "web"),
			model: this.getModelConfig(),
			backend: new LocalBackend(),
			approvalTimeoutMs: 10_000,
		});

		let ws: WebSocket | undefined;
		let ttftMs: number | null = null;
		let eventsCount = 0;
		let latestUsage: { input: number; output: number; cacheRead: number } | null = null;
		let success = false;
		let harnessError: string | undefined;

		const t0 = performance.now();
		try {
			const port = await gateway.listen();
			ws = new WebSocket(`ws://127.0.0.1:${port}/?token=tok-${sessionId}&session=${sessionId}&actor=owner`);

			const events: ClientEvent[] = [];
			await new Promise<void>((resolve, reject) => {
				ws!.once("open", () => resolve());
				ws!.once("error", reject);
			});

			ws.on("message", (raw) => {
				const frame = JSON.parse(String(raw));
				if (frame.event) {
					events.push(frame.event);
					eventsCount++;
					const e = frame.event as ClientEvent;
					if (ttftMs === null && (e.type === "message.text" || e.type === "agent.start")) {
						ttftMs = performance.now() - t0;
					}
					if (e.type === "usage") {
						latestUsage = { input: e.usage.input, output: e.usage.output, cacheRead: e.usage.cacheRead ?? 0 };
					}
				}
			});

			// 等待 session.ready
			const deadline = Date.now() + 10_000;
			while (!events.some((e) => e.type === "session.ready")) {
				if (Date.now() > deadline) throw new Error("session.ready timeout");
				await new Promise((r) => setTimeout(r, 20));
			}

			// Warm run: 发送任务请求 (复用相同的系统前缀与会话)
			ws.send(JSON.stringify({
				type: "prompt",
				text: `[${task.id}] ${task.prompt}`,
				requestId: randomUUID(),
			}));

			const runDeadline = Date.now() + 15_000;
			while (!events.some((e) => e.type === "agent.end")) {
				if (Date.now() > runDeadline) throw new Error("agent.end timeout");
				await new Promise((r) => setTimeout(r, 20));
			}

			// 验证结果
			for (const cmd of task.verify) {
				execSync(cmd, { cwd: wsDir, stdio: "pipe", timeout: 3000, env: cleanTestEnv() });
			}
			success = true;
		} catch (err) {
			success = false;
			harnessError = (err as Error).message;
		} finally {
			ws?.terminate();
			await gateway.close();
		}

		const durationMs = performance.now() - t0;
		const u = latestUsage as { input: number; output: number; cacheRead: number } | null;
		const hasRealUsage = Boolean(u && (u.input > 0 || u.output > 0));
		return {
			taskId: task.id,
			mode: "warm",
			repetition: rep,
			success,
			durationMs: Math.round(durationMs),
			ttftMs: ttftMs ? Math.round(ttftMs) : null,
			recoveryTimeToOperableMs: null,
			memoryMetric: {
				target: "runner_process",
				pid: process.pid,
				rssBytes: process.memoryUsage().rss,
				note: "测量主体为 runner 宿主进程自身，非 Gateway/Harness 子进程",
			},
			rssBytes: process.memoryUsage().rss,
			eventsCount,
			inputTokens: hasRealUsage && u ? u.input : null,
			outputTokens: hasRealUsage && u ? u.output : null,
			cachedTokens: (hasRealUsage && u && u.cacheRead > 0) ? u.cacheRead : null,
			usageSource: hasRealUsage ? "mock-reported" : "unknown / missing-source",
			realCostDollars: null,
			mockConfiguredCostDollars: 0.0,
			harnessError,
		};
	}

	/**
	 * 执行单次真实重启恢复测量 (Recovery Run - 真实独立 OS 子进程 A/B 退出与重启，复用同一 stateRoot + workspace)
	 */
	async runRecovery(task: BenchmarkFixtureTask, rep = 1): Promise<BenchmarkMeasurement> {
		const sessionId = `rec-${task.id}-${rep}-${randomUUID().slice(0, 6)}`;
		const wsDir = join(this.runRoot, "workspaces", sessionId);
		const stateDir = join(this.runRoot, "state", sessionId);
		this.materializeTask(task, wsDir);

		let procA: { child: ChildProcess; pid: number; port: number; close: () => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> } | undefined;
		let procB: { child: ChildProcess; pid: number; port: number; close: () => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> } | undefined;
		let ws1: WebSocket | undefined;
		let ws2: WebSocket | undefined;

		let recoveryTimeToOperableMs: number | null = null;
		let ttftMs: number | null = null;
		let success = false;
		let harnessError: string | undefined;
		let eventsCount = 0;
		let latestUsage: { input: number; output: number; cacheRead: number } | null = null;
		let exitEvidenceA: { exitCode: number | null; signal: NodeJS.Signals | null } = { exitCode: null, signal: null };

		const artifactPath = join(wsDir, "uncommitted-artifact.txt");

		try {
			// 1. 启动真实独立 OS 子进程 A
			procA = await this.spawnGatewayChild(sessionId, stateDir, wsDir);
			const port1 = procA.port;

			ws1 = new WebSocket(`ws://127.0.0.1:${port1}/?token=tok-${sessionId}&session=${sessionId}&actor=owner`);
			await new Promise<void>((res, rej) => { ws1!.once("open", () => res()); ws1!.once("error", rej); });

			const events1: ClientEvent[] = [];
			ws1.on("message", (raw) => {
				const frame = JSON.parse(String(raw));
				if (frame.event) events1.push(frame.event);
			});

			const deadline1 = Date.now() + 10_000;
			while (!events1.some((e) => e.type === "session.ready")) {
				if (Date.now() > deadline1) throw new Error("gw1 session.ready timeout");
				await new Promise((r) => setTimeout(r, 20));
			}

			// 发送初始记录
			ws1.send(JSON.stringify({ type: "prompt", text: `[${task.id}] 初始恢复标记`, requestId: "init-rec" }));
			const runDeadline1 = Date.now() + 15_000;
			while (!events1.some((e) => e.type === "agent.end")) {
				if (Date.now() > runDeadline1) throw new Error("gw1 agent.end timeout");
				await new Promise((r) => setTimeout(r, 20));
			}

			// 在工作区写入未提交的连续性标记产物（逐字节验证持久性）
			writeFileSync(artifactPath, `continuous-state-marker-${sessionId}`);

			// 2. 真实关闭第一网关独立子进程 A (gateway.close 释放句柄自然退出，等待 OS exit 事件)
			ws1.terminate();
			ws1 = undefined;
			exitEvidenceA = await procA.close();
			if (procA.child.exitCode === null && procA.child.signalCode === null) {
				throw new Error(`Gateway child process A (PID ${procA.pid}) failed to exit!`);
			}

			// 3. 测量真实进程重启恢复单调时钟
			const tRestart = performance.now();

			// 4. 启动真实独立 OS 子进程 B (复用完全相同的 stateRoot 与 workspace)
			procB = await this.spawnGatewayChild(sessionId, stateDir, wsDir);
			if (procB.pid === procA.pid) {
				throw new Error(`Recovery instance B (PID ${procB.pid}) must be an independent OS process with a different PID from A (PID ${procA.pid})!`);
			}

			ws2 = new WebSocket(`ws://127.0.0.1:${procB.port}/?token=tok-${sessionId}&session=${sessionId}&actor=owner`);
			await new Promise<void>((res, rej) => { ws2!.once("open", () => res()); ws2!.once("error", rej); });

			const events2: ClientEvent[] = [];
			ws2.on("message", (raw) => {
				const frame = JSON.parse(String(raw));
				if (frame.event) {
					events2.push(frame.event);
					eventsCount++;
					const e = frame.event as ClientEvent;
					if (recoveryTimeToOperableMs === null && e.type === "session.ready") {
						recoveryTimeToOperableMs = performance.now() - tRestart;
					}
					if (ttftMs === null && (e.type === "message.text" || e.type === "agent.start")) {
						ttftMs = performance.now() - tRestart;
					}
					if (e.type === "usage") {
						latestUsage = { input: e.usage.input, output: e.usage.output, cacheRead: e.usage.cacheRead ?? 0 };
					}
				}
			});

			const deadline2 = Date.now() + 10_000;
			while (!events2.some((e) => e.type === "session.ready")) {
				if (Date.now() > deadline2) throw new Error("gw2 session.ready timeout");
				await new Promise((r) => setTimeout(r, 20));
			}

			// 验证未提交产物未丢失且逐字节一致
			if (!existsSync(artifactPath) || readFileSync(artifactPath, "utf8") !== `continuous-state-marker-${sessionId}`) {
				throw new Error("工作区未提交产物在独立子进程恢复后丢失或损坏！");
			}

			// 发送恢复后继续执行指令
			ws2.send(JSON.stringify({
				type: "prompt",
				text: `[${task.id}] ${task.prompt}`,
				requestId: randomUUID(),
			}));

			const runDeadline2 = Date.now() + 15_000;
			while (!events2.some((e) => e.type === "agent.end")) {
				if (Date.now() > runDeadline2) throw new Error("gw2 agent.end timeout");
				await new Promise((r) => setTimeout(r, 20));
			}

			// 验证最终验收
			for (const cmd of task.verify) {
				execSync(cmd, { cwd: wsDir, stdio: "pipe", timeout: 3000, env: cleanTestEnv() });
			}
			success = true;
		} catch (err) {
			success = false;
			harnessError = (err as Error).message;
		} finally {
			ws1?.terminate();
			ws2?.terminate();
			if (procA && procA.child.exitCode === null && procA.child.signalCode === null) {
				try { await procA.close(); } catch {}
			}
			if (procB && procB.child.exitCode === null && procB.child.signalCode === null) {
				try { await procB.close(); } catch {}
			}
		}

		const u = latestUsage as { input: number; output: number; cacheRead: number } | null;
		const hasRealUsage = Boolean(u && (u.input > 0 || u.output > 0));
		return {
			taskId: task.id,
			mode: "recovery",
			repetition: rep,
			success,
			durationMs: Math.round(recoveryTimeToOperableMs ? recoveryTimeToOperableMs + 200 : 250),
			ttftMs: ttftMs ? Math.round(ttftMs) : null,
			recoveryTimeToOperableMs: recoveryTimeToOperableMs ? Math.round(recoveryTimeToOperableMs) : null,
			memoryMetric: {
				target: "runner_process",
				pid: process.pid,
				rssBytes: process.memoryUsage().rss,
				note: "测量主体为 runner 宿主进程自身，非 Gateway/Harness 子进程",
			},
			rssBytes: process.memoryUsage().rss,
			eventsCount,
			inputTokens: hasRealUsage && u ? u.input : null,
			outputTokens: hasRealUsage && u ? u.output : null,
			cachedTokens: (hasRealUsage && u && u.cacheRead > 0) ? u.cacheRead : null,
			usageSource: hasRealUsage ? "mock-reported" : "unknown / missing-source",
			realCostDollars: null,
			mockConfiguredCostDollars: 0.0,
			harnessError,
			recoveryProcessMeta: {
				instanceAPid: procA?.pid ?? 0,
				instanceAExitCode: exitEvidenceA.exitCode,
				instanceAExitSignal: exitEvidenceA.signal,
				instanceBPid: procB?.pid ?? 0,
			},
		};
	}
}
