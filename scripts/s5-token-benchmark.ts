import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBenchmark } from "../src/evals/benchmark-runner.ts";
import type { ActualBenchmarkReport } from "../src/evals/benchmark-runner.ts";
import { buildS5Report, validateS0Report, validateS5RunSelection } from "../src/evals/s5-token-benchmark.ts";

/**
 * S5 token 基准本地入口（S5d）。
 *
 * 模式 A（跑批）：复用既有 runBenchmark 真实管道（30 固定任务 × 3 模式，默认每任务 3 次），
 *   在其产物上聚合 S5 补充报告，不另造管道、不制造虚假缓存命中。
 * 模式 B（转换）：对既有 S0 报告 JSON 做纯转换，生成 S5 报告，不重新跑批。
 *
 * 报告诚实性约定见 src/evals/s5-token-benchmark.ts：
 * 调用/重试/压缩 token 无法从现有链路取得时保持 null；无真实配对基线时优化门槛
 * not_measured / external_blocked，绝不报告达成；不收集 prompt/env/secret。
 */

function usage(): never {
	console.error(`Usage:
  node scripts/s5-token-benchmark.ts [--revision <sha>] [--output <path>]
        [--tasks id1,id2] [--modes cold,warm,recovery] [--repetitions 3]
        [--deadline-ms 900000] [--negative] [--base-output <path>]
  node scripts/s5-token-benchmark.ts --from-report <s0-report.json> [--revision <sha>] [--output <path>]

Options:
  --from-report <path>  转换既有 S0 报告 JSON 为 S5 报告（不跑批）
  --revision <sha>      仓库 revision（由协调者传入；缺省保持 null）
  --output <path>       S5 报告输出路径（默认 docs/s5/s5-token-benchmark.json）
  --base-output <path>  跑批模式下 S0 基础报告输出路径（默认 docs/s5/s5-base-report.json）`);
	process.exit(1);
}

function parseArgs(args: string[]): Record<string, string | boolean> {
	const opts: Record<string, string | boolean> = {};
	const valueFlags = new Set([
		"--from-report", "--revision", "--output", "--base-output",
		"--tasks", "--modes", "--repetitions", "--deadline-ms",
	]);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (valueFlags.has(arg)) {
			if (!args[i + 1]) usage();
			opts[arg] = args[++i]!;
		} else if (arg === "--negative") {
			opts[arg] = true;
		} else {
			usage();
		}
	}
	return opts;
}

function writeJson(path: string, data: unknown): void {
	mkdirSync(dirname(resolve(path)), { recursive: true });
	writeFileSync(resolve(path), JSON.stringify(data, null, 2), "utf8");
}

function printSummary(report: ReturnType<typeof buildS5Report>): void {
	const pct = (v: number | null) => (v === null ? "null" : `${v}ms`);
	console.log(`\n================== S5 TOKEN BENCHMARK SUMMARY ==================`);
	console.log(`Report Type:        ${report.reportType}`);
	console.log(`Repo Revision:      ${report.provenance.repoRevision ?? "null (未由协调者传入)"}`);
	console.log(`Suite:              ${report.provenance.suiteVersion} (hash ${report.provenance.suiteHash.slice(0, 12)}…)`);
	for (const mode of ["cold", "warm", "recovery"] as const) {
		const m = report.modes[mode];
		const pass = m.passRate === null ? "null" : `${(m.passRate * 100).toFixed(1)}%`;
		const ttft = m.ttft.p50 === null ? "null" : `p50 ${m.ttft.p50}ms / p95 ${m.ttft.p95}ms`;
		console.log(`${mode.padEnd(9)} n=${m.total} pass=${pass} duration p50=${pct(m.durationMs.p50)} p95=${pct(m.durationMs.p95)} ttft(${m.ttft.sampleSize} 样本${m.ttft.smallSample ? ", 小样本" : ""}) ${ttft}`);
	}
	const f = report.failedTaskConsumption;
	console.log(`Failed Consumed:    ${f.failedCount} 次失败 (input ${f.failedInputTokensSum ?? "null"} / output ${f.failedOutputTokensSum ?? "null"} tok)`);
	console.log(`Optimization Gates: ${report.optimizationGates.overallStatus} (真实成本 external_blocked；无真实配对基线，不报告达成)`);
	console.log(`Cache Read:         unknown (${report.fieldProvenance.cacheRead.status}) — 现有管道无法区分 cacheRead=0 与缺字段`);
	console.log(`Privacy:            仅元数据；prompt/env/secret 未收集`);
	console.log(`================================================================\n`);
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));
	const outputPath = (opts["--output"] as string | undefined) ?? "docs/s5/s5-token-benchmark.json";
	const revision = (opts["--revision"] as string | undefined) ?? null;

	let base: ActualBenchmarkReport;
	let sourceReportPath: string | null = null;

	if (typeof opts["--from-report"] === "string") {
		sourceReportPath = opts["--from-report"];
		// 最小运行时验证：非法输入在此抛错，不写任何产物
		base = validateS0Report(JSON.parse(readFileSync(resolve(sourceReportPath), "utf8")));
	} else {
		const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
		const baseOutput = (opts["--base-output"] as string | undefined) ?? "docs/s5/s5-base-report.json";
		sourceReportPath = baseOutput;
		// 跑批参数边界校验：非法值（0/NaN/负数/空/未知 tasks·modes）在此抛错，
		// 不启动 benchmark、不写任何产物
		const selection = validateS5RunSelection({
			tasks: typeof opts["--tasks"] === "string" ? opts["--tasks"] : undefined,
			modes: typeof opts["--modes"] === "string" ? opts["--modes"] : undefined,
			repetitions: typeof opts["--repetitions"] === "string" ? Number(opts["--repetitions"]) : 3,
			deadlineMs: typeof opts["--deadline-ms"] === "string" ? Number(opts["--deadline-ms"]) : 900_000,
		});
		base = await runBenchmark({
			repoRoot,
			tasks: selection.tasks,
			modes: selection.modes,
			repetitions: selection.repetitions,
			deadlineMs: selection.deadlineMs,
			negative: opts["--negative"] === true,
			outputPath: baseOutput,
		});
	}

	const report = buildS5Report(base, { repoRevision: revision, sourceReportPath });
	writeJson(outputPath, report);
	console.log(`S5 report written to: ${outputPath}`);
	printSummary(report);
}

main().catch((err) => {
	console.error("S5 token benchmark failed:", err);
	process.exit(1);
});
