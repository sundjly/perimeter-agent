import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BENCHMARK_FIXTURE_TASKS, SUITE_VERSION, type BenchmarkFixtureTask } from "./benchmark-fixtures.ts";
import { BenchmarkPipeline, type BenchmarkMeasurement } from "./benchmark-pipeline.ts";

export interface RunnerOptions {
	repoRoot: string;
	tasks?: string[];
	modes?: ("cold" | "warm" | "recovery")[];
	repetitions?: number;
	outputPath?: string;
	negative?: boolean;
	deadlineMs?: number;
}

export interface ActualBenchmarkReport {
	timestamp: string;
	suiteVersion: string;
	suiteProvenance: {
		source: "local-mock-pipeline";
		framework: "Gateway + HarnessHost (Durable SQLite) + LocalBackend + ModelGateway + LocalBenchmarkMockServer";
		totalFixtureTasks: number;
		fixtureHashes: Record<string, string>;
	};
	executionMeta: {
		totalRuns: number;
		repetitions: number;
		deadlineMs: number;
		actualElapsedMs: number;
		timedOut: boolean;
	};
	costDeclaration: {
		environment: "local-mock";
		isProduction: false;
		realCommercialCostDollars: null;
		realCostStatus: "unknown / external_blocked";
		mockConfiguredUnitPriceDollars: 0.0;
		note: "所有模型金额按 mock 配置为 $0.00，真实商业模型上游通道与对账未打通，不代表真实经济效益。";
	};
	summary: {
		totalTasks: number;
		totalMeasurements: number;
		cold: {
			total: number;
			passed: number;
			passRate: number;
			avgDurationMs: number;
			avgTtftMs: number;
		};
		warm: {
			total: number;
			passed: number;
			passRate: number;
			avgDurationMs: number;
			avgTtftMs: number;
			estimatedCacheReuseTokensAvg: number | null;
		};
		recovery: {
			total: number;
			passed: number;
			passRate: number;
			avgDurationMs: number;
			avgRecoveryTimeToOperableMs: number;
			artifactContinuityRate: number;
			processMode: "real-independent-os-subprocess-ab";
		};
		overallPassRate: number;
		avgDurationMs: number;
		peakRssBytes: number;
		memorySummary: {
			target: "runner_process";
			pid: number;
			peakRssBytes: number;
			note: "Peak RSS 测量主体为 runner 运行进程自身，非 Gateway/Harness 子进程";
		};
		executionEnvironment: {
			backend: "LocalBackend";
			isolation: "host-subprocess (non-isolated; enterprise sandbox S2 unimplemented)";
		};
		totalInputTokens: number;
		totalOutputTokens: number;
	};
	measurements: BenchmarkMeasurement[];
}

export async function runBenchmark(opts: RunnerOptions): Promise<ActualBenchmarkReport> {
	const tStart = performance.now();
	const deadlineMs = opts.deadlineMs ?? 900_000; // 默认 15 分钟全局硬性 deadline
	const repetitions = opts.repetitions ?? 3;
	const modes = opts.modes ?? ["cold", "warm", "recovery"];
	const taskList: BenchmarkFixtureTask[] = opts.tasks && opts.tasks.length > 0
		? BENCHMARK_FIXTURE_TASKS.filter((t) => opts.tasks!.includes(t.id))
		: BENCHMARK_FIXTURE_TASKS;

	const pipeline = new BenchmarkPipeline({
		repoRoot: opts.repoRoot,
		negative: opts.negative,
	});

	const measurements: BenchmarkMeasurement[] = [];
	let timedOut = false;
	let peakRss = 0;

	try {
		await pipeline.startServices(opts.negative ?? false);
		const totalExpected = taskList.length * modes.length * repetitions;
		let executed = 0;

		console.log(`\n============================================================`);
		console.log(`Perimeter S0 Benchmark Runner (Real Local Mock Pipeline)`);
		console.log(`Tasks: ${taskList.length} | Modes: ${modes.join(",")} | Repetitions: ${repetitions}`);
		console.log(`Total Scheduled Runs: ${totalExpected} | Deadline: ${deadlineMs / 1000}s`);
		console.log(`============================================================\n`);

		for (const task of taskList) {
			for (const mode of modes) {
				for (let rep = 1; rep <= repetitions; rep++) {
					if (performance.now() - tStart > deadlineMs) {
						timedOut = true;
						console.warn(`[WARN] Global deadline of ${deadlineMs}ms exceeded. Stopping batch.`);
						break;
					}

					let m: BenchmarkMeasurement;
					if (mode === "cold") {
						m = await pipeline.runCold(task, rep);
					} else if (mode === "warm") {
						m = await pipeline.runWarm(task, rep);
					} else {
						m = await pipeline.runRecovery(task, rep);
					}

					measurements.push(m);
					executed++;
					peakRss = Math.max(peakRss, m.rssBytes);

					const statusMark = m.success ? "✓" : "✗";
					const ttftStr = m.ttftMs !== null ? `${m.ttftMs}ms` : "—";
					const recStr = m.recoveryTimeToOperableMs !== null ? `rec=${m.recoveryTimeToOperableMs}ms` : "";
					console.log(
						`[${executed}/${totalExpected}] ${statusMark} ${task.id} [${mode}#${rep}] ${m.durationMs}ms (TTFT: ${ttftStr}${recStr ? ` ${recStr}` : ""}) RSS: ${(m.rssBytes / (1024 * 1024)).toFixed(1)}MB`
					);
				}
				if (timedOut) break;
			}
			if (timedOut) break;
		}
	} finally {
		await pipeline.closeServices();
	}

	const elapsedMs = performance.now() - tStart;

	// 汇总指标计算
	const coldRuns = measurements.filter((m) => m.mode === "cold");
	const warmRuns = measurements.filter((m) => m.mode === "warm");
	const recRuns = measurements.filter((m) => m.mode === "recovery");

	const avg = (nums: number[]) => (nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0);
	const passRate = (list: BenchmarkMeasurement[]) => (list.length ? list.filter((m) => m.success).length / list.length : 0);

	const fixtureHashes: Record<string, string> = {};
	for (const t of BENCHMARK_FIXTURE_TASKS) fixtureHashes[t.id] = t.fixtureHash;

	const report: ActualBenchmarkReport = {
		timestamp: new Date().toISOString(),
		suiteVersion: SUITE_VERSION,
		suiteProvenance: {
			source: "local-mock-pipeline",
			framework: "Gateway + HarnessHost (Durable SQLite) + LocalBackend + ModelGateway + LocalBenchmarkMockServer",
			totalFixtureTasks: BENCHMARK_FIXTURE_TASKS.length,
			fixtureHashes,
		},
		executionMeta: {
			totalRuns: measurements.length,
			repetitions,
			deadlineMs,
			actualElapsedMs: Math.round(elapsedMs),
			timedOut,
		},
		costDeclaration: {
			environment: "local-mock",
			isProduction: false,
			realCommercialCostDollars: null,
			realCostStatus: "unknown / external_blocked",
			mockConfiguredUnitPriceDollars: 0.0,
			note: "所有模型金额按 mock 配置为 $0.00，真实商业模型上游通道与对账未打通，不代表真实经济效益。",
		},
		summary: {
			totalTasks: taskList.length,
			totalMeasurements: measurements.length,
			cold: {
				total: coldRuns.length,
				passed: coldRuns.filter((m) => m.success).length,
				passRate: passRate(coldRuns),
				avgDurationMs: avg(coldRuns.map((m) => m.durationMs)),
				avgTtftMs: avg(coldRuns.map((m) => m.ttftMs ?? 0)),
			},
			warm: {
				total: warmRuns.length,
				passed: warmRuns.filter((m) => m.success).length,
				passRate: passRate(warmRuns),
				avgDurationMs: avg(warmRuns.map((m) => m.durationMs)),
				avgTtftMs: avg(warmRuns.map((m) => m.ttftMs ?? 0)),
				estimatedCacheReuseTokensAvg: (() => {
					const valid = warmRuns.map((m) => m.cachedTokens).filter((c): c is number => c !== null);
					return valid.length ? avg(valid) : null;
				})(),
			},
			recovery: {
				total: recRuns.length,
				passed: recRuns.filter((m) => m.success).length,
				passRate: passRate(recRuns),
				avgDurationMs: avg(recRuns.map((m) => m.durationMs)),
				avgRecoveryTimeToOperableMs: avg(recRuns.map((m) => m.recoveryTimeToOperableMs ?? 0)),
				artifactContinuityRate: passRate(recRuns),
				processMode: "real-independent-os-subprocess-ab",
			},
			overallPassRate: passRate(measurements),
			avgDurationMs: avg(measurements.map((m) => m.durationMs)),
			peakRssBytes: peakRss,
			memorySummary: {
				target: "runner_process",
				pid: process.pid,
				peakRssBytes: peakRss,
				note: "Peak RSS 测量主体为 runner 运行进程自身，非 Gateway/Harness 子进程",
			},
			executionEnvironment: {
				backend: "LocalBackend",
				isolation: "host-subprocess (non-isolated; enterprise sandbox S2 unimplemented)",
			},
			totalInputTokens: measurements.reduce((acc, m) => acc + (m.inputTokens ?? 0), 0),
			totalOutputTokens: measurements.reduce((acc, m) => acc + (m.outputTokens ?? 0), 0),
		},
		measurements,
	};

	if (opts.outputPath) {
		mkdirSync(dirname(resolve(opts.outputPath)), { recursive: true });
		writeFileSync(resolve(opts.outputPath), JSON.stringify(report, null, 2), "utf8");
		console.log(`\nReport written to: ${opts.outputPath}`);
	}

	const cacheDisplay = report.summary.warm.estimatedCacheReuseTokensAvg !== null
		? `${report.summary.warm.estimatedCacheReuseTokensAvg} tok`
		: "none reported (unknown/null)";

	console.log(`\n================== SUMMARY ==================`);
	console.log(`Execution Backend:  LocalBackend (host subprocess, non-isolated; S2 strong sandbox pending)`);
	console.log(`Cold Pass Rate:     ${(report.summary.cold.passRate * 100).toFixed(1)}% (avg ${report.summary.cold.avgDurationMs}ms, TTFT: ${report.summary.cold.avgTtftMs}ms)`);
	console.log(`Warm Pass Rate:     ${(report.summary.warm.passRate * 100).toFixed(1)}% (avg ${report.summary.warm.avgDurationMs}ms, TTFT: ${report.summary.warm.avgTtftMs}ms, cache: ${cacheDisplay})`);
	console.log(`Recovery Pass Rate: ${(report.summary.recovery.passRate * 100).toFixed(1)}% (avg ${report.summary.recovery.avgDurationMs}ms, operable: ${report.summary.recovery.avgRecoveryTimeToOperableMs}ms, mode: real-independent-os-subprocess-ab)`);
	console.log(`Overall Pass Rate:  ${(report.summary.overallPassRate * 100).toFixed(1)}%`);
	console.log(`Wall Clock Time:    ${(elapsedMs / 1000).toFixed(2)}s / ${(deadlineMs / 1000).toFixed(0)}s limit`);
	console.log(`Peak RSS:           ${(peakRss / (1024 * 1024)).toFixed(1)} MB (target: runner process PID ${process.pid}, not Gateway/Harness subprocess)`);
	console.log(`Commercial Cost:    $0.00 (Mock configured; real commercial cost unknown / external_blocked)`);
	console.log(`=============================================\n`);

	return report;
}

// CLI 入口
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const args = process.argv.slice(2);
	let tasksArg: string[] | undefined;
	let modesArg: ("cold" | "warm" | "recovery")[] | undefined;
	let repetitions = 3;
	let outputPath = "docs/s0/actual-local-mock-benchmark.json";
	let negative = false;
	let deadlineMs = 900_000;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--tasks" && args[i + 1]) {
			tasksArg = args[++i]!.split(",").map((s) => s.trim());
		} else if (args[i] === "--modes" && args[i + 1]) {
			modesArg = args[++i]!.split(",").map((s) => s.trim()) as ("cold" | "warm" | "recovery")[];
		} else if (args[i] === "--repetitions" && args[i + 1]) {
			repetitions = Number(args[++i]);
		} else if (args[i] === "--output" && args[i + 1]) {
			outputPath = args[++i]!;
		} else if (args[i] === "--negative") {
			negative = true;
		} else if (args[i] === "--deadline-ms" && args[i + 1]) {
			deadlineMs = Number(args[++i]);
		}
	}

	const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
	runBenchmark({
		repoRoot,
		tasks: tasksArg,
		modes: modesArg,
		repetitions,
		outputPath,
		negative,
		deadlineMs,
	}).then(() => {
		process.exit(0);
	}).catch((err) => {
		console.error("Benchmark runner failed:", err);
		process.exit(1);
	});
}
