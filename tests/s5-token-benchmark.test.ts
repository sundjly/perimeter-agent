import assert from "node:assert/strict";
import { test } from "node:test";
import { BENCHMARK_FIXTURE_TASKS, SUITE_VERSION } from "../src/evals/benchmark-fixtures.ts";
import type { BenchmarkMeasurement } from "../src/evals/benchmark-pipeline.ts";
import type { ActualBenchmarkReport } from "../src/evals/benchmark-runner.ts";
import {
	buildS5Report,
	computeSuiteHash,
	percentile,
	SMALL_SAMPLE_MIN_RUNS,
	validateS0Report,
	validateS5RunSelection,
} from "../src/evals/s5-token-benchmark.ts";

function makeMeasurement(over: Partial<BenchmarkMeasurement>): BenchmarkMeasurement {
	return {
		taskId: "task-01-range-off-by-one",
		mode: "cold",
		repetition: 1,
		success: true,
		durationMs: 200,
		ttftMs: 30,
		recoveryTimeToOperableMs: null,
		memoryMetric: {
			target: "runner_process",
			pid: process.pid,
			rssBytes: 1024,
			note: "测量主体为 runner 宿主进程自身，非 Gateway/Harness 子进程",
		},
		rssBytes: 1024,
		eventsCount: 5,
		inputTokens: 120,
		outputTokens: 25,
		cachedTokens: null,
		usageSource: "mock-reported",
		realCostDollars: null,
		mockConfiguredCostDollars: 0.0,
		...over,
	};
}

function makeBaseReport(measurements: BenchmarkMeasurement[]): ActualBenchmarkReport {
	const fixtureHashes: Record<string, string> = {};
	for (const t of BENCHMARK_FIXTURE_TASKS) fixtureHashes[t.id] = t.fixtureHash;
	return {
		timestamp: "2026-01-01T00:00:00.000Z",
		suiteVersion: SUITE_VERSION,
		suiteProvenance: {
			source: "local-mock-pipeline",
			framework: "Gateway + HarnessHost (Durable SQLite) + LocalBackend + ModelGateway + LocalBenchmarkMockServer",
			totalFixtureTasks: BENCHMARK_FIXTURE_TASKS.length,
			fixtureHashes,
		},
		executionMeta: {
			totalRuns: measurements.length,
			repetitions: 3,
			deadlineMs: 900_000,
			actualElapsedMs: 1000,
			timedOut: false,
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
			totalTasks: 1,
			totalMeasurements: measurements.length,
			cold: { total: 0, passed: 0, passRate: 0, avgDurationMs: 0, avgTtftMs: 0 },
			warm: { total: 0, passed: 0, passRate: 0, avgDurationMs: 0, avgTtftMs: 0, estimatedCacheReuseTokensAvg: null },
			recovery: {
				total: 0, passed: 0, passRate: 0, avgDurationMs: 0,
				avgRecoveryTimeToOperableMs: 0, artifactContinuityRate: 0,
				processMode: "real-independent-os-subprocess-ab",
			},
			overallPassRate: 0,
			avgDurationMs: 0,
			peakRssBytes: 1024,
			memorySummary: {
				target: "runner_process",
				pid: process.pid,
				peakRssBytes: 1024,
				note: "Peak RSS 测量主体为 runner 运行进程自身，非 Gateway/Harness 子进程",
			},
			executionEnvironment: {
				backend: "LocalBackend",
				isolation: "host-subprocess (non-isolated; enterprise sandbox S2 unimplemented)",
			},
			totalInputTokens: 0,
			totalOutputTokens: 0,
		},
		measurements,
	};
}

test("1. 分位数计算：线性插值 p50/p95 与空集 null 缺省", () => {
	assert.equal(percentile([], 50), null, "空集分位数必须为 null，不得报 0");
	assert.equal(percentile([10], 95), 10);
	assert.equal(percentile([10, 20, 30, 40], 50), 25);
	assert.equal(percentile([10, 20, 30, 40], 95), 38.5);
	assert.equal(percentile([40, 10, 30, 20], 50), 25, "输入无需预排序");
});

test("2. null 分位数：TTFT 全缺失时 p50/p95 保持 null，token 同步 null", () => {
	const base = makeBaseReport([
		makeMeasurement({ mode: "cold", repetition: 1, ttftMs: null, inputTokens: null, outputTokens: null, usageSource: "unknown / missing-source" }),
		makeMeasurement({ mode: "cold", repetition: 2, ttftMs: null, inputTokens: null, outputTokens: null, usageSource: "unknown / missing-source" }),
	]);
	const report = buildS5Report(base);

	assert.equal(report.modes.cold.ttft.sampleSize, 0);
	assert.equal(report.modes.cold.ttft.missingCount, 2);
	assert.equal(report.modes.cold.ttft.p50, null, "无非空 TTFT 值时 p50 必须为 null");
	assert.equal(report.modes.cold.ttft.p95, null, "无非空 TTFT 值时 p95 必须为 null");
	assert.equal(report.modes.cold.tokens.inputTokensSum, null, "无 usage 时 token 求和必须为 null");
	assert.equal(report.modes.cold.tokens.outputTokensSum, null);
	assert.equal(report.modes.cold.tokens.withUsageCount, 0);
	assert.equal(report.modes.cold.tokens.cacheReadStatus, "unknown");
	assert.equal(report.modes.cold.tokens.cachedTokens, null);
	assert.equal(report.modes.cold.modelCallCount, null);
	assert.equal(report.modes.cold.retryCount, null);
	assert.equal(report.modes.cold.compactionTokens, null);
});

test("3. 任务时长统计与 TTFT 分位数正确聚合", () => {
	const base = makeBaseReport([
		makeMeasurement({ mode: "warm", repetition: 1, durationMs: 100, ttftMs: 10 }),
		makeMeasurement({ mode: "warm", repetition: 2, durationMs: 200, ttftMs: 20 }),
		makeMeasurement({ mode: "warm", repetition: 3, durationMs: 300, ttftMs: 30 }),
		makeMeasurement({ mode: "warm", repetition: 4, durationMs: 400, ttftMs: 40 }),
	]);
	const report = buildS5Report(base);
	const warm = report.modes.warm;

	assert.equal(warm.total, 4);
	assert.deepEqual(
		{ p50: warm.durationMs.p50, p95: warm.durationMs.p95, min: warm.durationMs.min, max: warm.durationMs.max, avg: warm.durationMs.avg },
		{ p50: 250, p95: 385, min: 100, max: 400, avg: 250 },
	);
	assert.equal(warm.ttft.p50, 25);
	assert.equal(warm.ttft.p95, 38.5);
	assert.equal(warm.ttft.sampleSize, 4);
	assert.equal(warm.ttft.missingCount, 0);
});

test("4. 失败任务消耗单独统计，不与成功任务混算", () => {
	const base = makeBaseReport([
		makeMeasurement({ mode: "cold", repetition: 1, success: true, inputTokens: 100, outputTokens: 10 }),
		makeMeasurement({ mode: "cold", repetition: 2, success: true, inputTokens: 100, outputTokens: 10 }),
		makeMeasurement({ mode: "cold", repetition: 3, success: true, inputTokens: 100, outputTokens: 10 }),
		makeMeasurement({ mode: "cold", repetition: 4, success: false, inputTokens: 50, outputTokens: 5, ttftMs: null }),
		makeMeasurement({ mode: "cold", repetition: 5, success: false, inputTokens: null, outputTokens: null, usageSource: "unknown / missing-source", ttftMs: null }),
	]);
	const report = buildS5Report(base);
	const f = report.failedTaskConsumption;

	assert.equal(f.failedCount, 2);
	assert.equal(f.failedWithUsageCount, 1, "仅统计有真实 usage 的失败测量");
	assert.equal(f.failedInputTokensSum, 50, "失败消耗仅计非 null 实测值");
	assert.equal(f.failedOutputTokensSum, 5);
	assert.equal(f.passedCount, 3);
	assert.equal(f.passedInputTokensSum, 300);
	assert.equal(f.passedOutputTokensSum, 30);
	// 模式内 pass/fail 计数一致
	assert.equal(report.modes.cold.total, 5);
	assert.equal(report.modes.cold.passed, 3);
});

test("5. 无真实配对基线时门槛一律 not_measured / external_blocked，绝不报告达成", () => {
	const base = makeBaseReport([makeMeasurement({})]);
	const report = buildS5Report(base);
	const gates = report.optimizationGates;

	assert.equal(gates.overallStatus, "not_measured");
	assert.equal(gates.realModelCost.status, "external_blocked");
	assert.equal(gates.realModelCost.valueDollars, null);
	assert.equal(gates.costPerSuccessfulTaskReduction20pct.status, "external_blocked");
	assert.equal(gates.completionRateRegressionMax2pp.status, "not_measured");
	assert.equal(gates.ttftP95RegressionMax10pct.status, "not_measured");

	const serialized = JSON.stringify(gates);
	assert.ok(!serialized.includes('"met"'), "门槛报告不得携带任何达成标记字段");
	for (const gate of [gates.costPerSuccessfulTaskReduction20pct, gates.completionRateRegressionMax2pp, gates.ttftP95RegressionMax10pct]) {
		assert.equal(gate.baseline, null, "无基线时 baseline 必须为 null");
		assert.equal(gate.current, null, "无基线时 current 必须为 null");
	}
});

test("6. 小样本标记与空模式诚实降级", () => {
	const small = buildS5Report(makeBaseReport([
		makeMeasurement({ mode: "warm", repetition: 1, ttftMs: 10 }),
		makeMeasurement({ mode: "warm", repetition: 2, ttftMs: 20 }),
	]));
	assert.equal(small.modes.warm.ttft.sampleSize, 2);
	assert.equal(small.modes.warm.ttft.smallSample, true, "样本数 < SMALL_SAMPLE_MIN_RUNS 必须标记小样本");
	assert.equal(small.modes.cold.total, 0, "未执行的模式必须显式为空");

	const enough = buildS5Report(makeBaseReport(
		Array.from({ length: SMALL_SAMPLE_MIN_RUNS }, (_, i) =>
			makeMeasurement({ mode: "cold", repetition: i + 1, ttftMs: 10 + i })),
	));
	assert.equal(enough.modes.cold.ttft.smallSample, false, `样本数 >= ${SMALL_SAMPLE_MIN_RUNS}（30 任务×3 次）不标记小样本`);

	// 空模式：分位数 null、时长 null（未知不写成 0）、token null、passRate null
	const empty = small.modes.cold;
	assert.equal(empty.ttft.p50, null);
	assert.equal(empty.ttft.smallSample, true);
	assert.deepEqual(Object.values(empty.durationMs), [null, null, null, null, null]);
	assert.equal(empty.passRate, null);
	assert.equal(empty.tokens.inputTokensSum, null);
});

test("7. Provenance：suiteHash 绑定真实 30 任务 fixture，revision/隐私/纯性", () => {
	const base = makeBaseReport([makeMeasurement({})]);
	const before = JSON.stringify(base);
	const report = buildS5Report(base, { repoRevision: "9a603d8", sourceReportPath: "docs/s5/s5-base-report.json" });

	assert.equal(JSON.stringify(base), before, "buildS5Report 必须是纯函数，不得修改输入报告");
	assert.equal(report.reportType, "S5-token-benchmark");
	assert.equal(report.provenance.repoRevision, "9a603d8");
	assert.equal(buildS5Report(base).provenance.repoRevision, null, "未传入 revision 时保持 null，不假设 HEAD");

	const realFixtureHashes: Record<string, string> = {};
	for (const t of BENCHMARK_FIXTURE_TASKS) realFixtureHashes[t.id] = t.fixtureHash;
	assert.equal(report.provenance.suiteHash, computeSuiteHash(realFixtureHashes), "suiteHash 必须绑定既有 30 任务 fixture hash");
	assert.match(report.provenance.suiteHash, /^[0-9a-f]{64}$/);
	assert.equal(report.provenance.suiteVersion, SUITE_VERSION);
	assert.equal(report.provenance.sourceReport.path, "docs/s5/s5-base-report.json");

	assert.equal(report.provenance.privacy.promptCollected, false);
	assert.equal(report.provenance.privacy.envCollected, false);
	assert.equal(report.provenance.privacy.secretsCollected, false);
	assert.equal(report.provenance.mockDeclaration.mockConfiguredUnitPriceDollars, 0.0);
	assert.ok(report.provenance.backendLimitations.some((s) => s.includes("LocalBackend")));
	assert.ok(report.provenance.backendLimitations.some((s) => s.includes("runner")));
	assert.ok(
		!report.provenance.backendLimitations.some((s) => s.includes("未实现")),
		"backendLimitations 不得声称 S2/容器未实现，只能声明本基准覆盖范围",
	);

	assert.equal(report.fieldProvenance.cacheRead.status, "unknown");
	assert.equal(report.fieldProvenance.modelCallCount.status, "null");
	assert.equal(report.fieldProvenance.retryCount.status, "null");
	assert.equal(report.fieldProvenance.compactionTokens.status, "null");

	assert.equal(report.overall.totalMeasurements, base.measurements.length);
	assert.deepEqual(Object.keys(report.modes), ["cold", "warm", "recovery"]);
});

function mutatedS0(fn: (r: Record<string, unknown>) => void): unknown {
	const r = structuredClone(makeBaseReport([makeMeasurement({})])) as unknown as Record<string, unknown>;
	fn(r);
	return r;
}

function firstMeasurement(r: Record<string, unknown>): Record<string, unknown> {
	return (r.measurements as Record<string, unknown>[])[0]!;
}

function invalidS0(fn: (r: Record<string, unknown>) => void, pathPattern: RegExp): void {
	assert.throws(() => validateS0Report(mutatedS0(fn)), pathPattern);
}

function firstFixtureId(): string {
	return BENCHMARK_FIXTURE_TASKS[0]!.id;
}

function secondFixtureId(): string {
	return BENCHMARK_FIXTURE_TASKS[1]!.id;
}

test("8. 转换入口验证：非 S0 local-mock 报告一律拒绝，负控断言带字段路径", () => {
	// 合法合成报告通过且原样返回（不修改、不重构造）
	const valid = makeBaseReport([makeMeasurement({})]);
	assert.equal(validateS0Report(valid), valid);

	// 顶层 mock 环境与来源声明
	invalidS0((r) => { (r.suiteProvenance as Record<string, unknown>).source = "synthetic"; }, /suiteProvenance\.source/);
	invalidS0((r) => { (r.suiteProvenance as Record<string, unknown>).framework = "mock-only"; }, /framework/);
	invalidS0((r) => { (r.costDeclaration as Record<string, unknown>).environment = "production"; }, /costDeclaration/);

	// 固定 30 任务 fixture hash
	invalidS0((r) => { (r.suiteProvenance as Record<string, unknown>).fixtureHashes = {}; }, /fixtureHashes/);
	invalidS0(
		(r) => { const h = (r.suiteProvenance as Record<string, unknown>).fixtureHashes as Record<string, string>; h[secondFixtureId()] = "zz"; },
		new RegExp(`fixtureHashes\\.${secondFixtureId()}`),
	);
	// task ID 集合必须与当前 BENCHMARK_FIXTURE_TASKS 一致（改名后数量仍 30 也必须拒绝）
	invalidS0((r) => {
		const h = (r.suiteProvenance as Record<string, unknown>).fixtureHashes as Record<string, string>;
		delete h[secondFixtureId()];
		h["task-99-renamed"] = "a".repeat(64);
	}, /不一致/);

	// 基本字段
	invalidS0((r) => { r.measurements = []; }, /measurements/);
	invalidS0((r) => { r.summary = undefined; }, /summary/);
	invalidS0((r) => { r.timestamp = ""; }, /\.timestamp/);
	invalidS0((r) => { delete (r as Record<string, unknown>).timestamp; }, /\.timestamp/);

	// executionMeta / summary：转换读取的数字字段必须有限非负
	invalidS0((r) => { (r.executionMeta as Record<string, unknown>).totalRuns = -1; }, /executionMeta\.totalRuns/);
	invalidS0((r) => { (r.executionMeta as Record<string, unknown>).repetitions = "3"; }, /executionMeta\.repetitions/);
	invalidS0((r) => { (r.executionMeta as Record<string, unknown>).timedOut = "no"; }, /executionMeta\.timedOut/);
	invalidS0((r) => { (r.summary as Record<string, unknown>).peakRssBytes = "big"; }, /summary\.peakRssBytes/);
	invalidS0((r) => { delete (r.summary as Record<string, unknown>).totalInputTokens; }, /summary\.totalInputTokens/);
	invalidS0((r) => { delete (r.summary as Record<string, unknown>).cold; }, /summary\.cold/);

	// 逐 measurement 校验
	invalidS0((r) => { firstMeasurement(r).taskId = "task-unknown"; }, /taskId/);
	invalidS0((r) => { firstMeasurement(r).taskId = firstFixtureId().toUpperCase(); }, /taskId/);
	invalidS0((r) => { firstMeasurement(r).mode = "hot"; }, /\.mode/);
	invalidS0((r) => { firstMeasurement(r).durationMs = -1; }, /durationMs/);
	invalidS0((r) => { firstMeasurement(r).durationMs = Number.POSITIVE_INFINITY; }, /durationMs/);
	invalidS0((r) => { firstMeasurement(r).ttftMs = "30"; }, /ttftMs/);
	invalidS0((r) => { firstMeasurement(r).inputTokens = -5; }, /inputTokens/);
	invalidS0((r) => { firstMeasurement(r).usageSource = "guessed"; }, /usageSource/);
	invalidS0((r) => { firstMeasurement(r).realCostDollars = 0.5; }, /realCostDollars/);
	invalidS0((r) => { firstMeasurement(r).mockConfiguredCostDollars = 0.01; }, /mockConfiguredCostDollars/);

	// null 合法性：ttftMs=null 是合法缺省，不得误拒
	const noTtft = mutatedS0((r) => { firstMeasurement(r).ttftMs = null; });
	assert.doesNotThrow(() => validateS0Report(noTtft));
});

test("9. CLI 跑批参数负控：0/NaN/负值/空与未知 tasks·modes 拒绝，不进入跑批", () => {
	// 合法：缺省 tasks/modes 为 undefined（runner 默认全集），数值透传
	const ok = validateS5RunSelection({ repetitions: 3, deadlineMs: 900_000 });
	assert.equal(ok.tasks, undefined);
	assert.equal(ok.modes, undefined);
	assert.equal(ok.repetitions, 3);
	assert.equal(ok.deadlineMs, 900_000);

	// repetitions：0/负/NaN/非整数/Infinity 拒绝
	for (const bad of [0, -1, NaN, 1.5, Number.POSITIVE_INFINITY]) {
		assert.throws(() => validateS5RunSelection({ repetitions: bad, deadlineMs: 900_000 }), /--repetitions/);
	}

	// deadline-ms：0/负/NaN/Infinity 拒绝
	for (const bad of [0, -1000, NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(() => validateS5RunSelection({ repetitions: 3, deadlineMs: bad }), /--deadline-ms/);
	}

	// tasks：空/全空白/未知 ID 拒绝
	assert.throws(() => validateS5RunSelection({ tasks: "", repetitions: 3, deadlineMs: 1000 }), /--tasks/);
	assert.throws(() => validateS5RunSelection({ tasks: " , , ", repetitions: 3, deadlineMs: 1000 }), /--tasks/);
	assert.throws(() => validateS5RunSelection({ tasks: "task-99-nope", repetitions: 3, deadlineMs: 1000 }), /未知任务 ID: task-99-nope/);

	// modes：空/未知值拒绝
	assert.throws(() => validateS5RunSelection({ modes: "", repetitions: 3, deadlineMs: 1000 }), /--modes/);
	assert.throws(() => validateS5RunSelection({ modes: "hot,cold", repetitions: 3, deadlineMs: 1000 }), /未知模式: hot/);

	// 合法子集：解析并透传
	const subset = validateS5RunSelection({
		tasks: `${firstFixtureId()}, ${secondFixtureId()}`,
		modes: "cold,warm",
		repetitions: 1,
		deadlineMs: 1000,
	});
	assert.deepEqual(subset.tasks, [firstFixtureId(), secondFixtureId()]);
	assert.deepEqual(subset.modes, ["cold", "warm"]);
});
