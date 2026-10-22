import { createHash } from "node:crypto";
import { BENCHMARK_FIXTURE_TASKS } from "./benchmark-fixtures.ts";
import type { ActualBenchmarkReport } from "./benchmark-runner.ts";
import type { BenchmarkMeasurement } from "./benchmark-pipeline.ts";

/**
 * S5 token 基准补充报告（S5d）：对既有 S0 runBenchmark 产物做纯转换。
 *
 * 诚实性原则（handoff §4.4）：
 * - 不另造测量管道、不生成虚假缓存命中；只聚合 runBenchmark 已实测的字段；
 * - 现有链路无法可靠取得的字段（模型调用数/重试数/压缩 token）一律为 null 并注明来源；
 * - 无真实配对基线时，真实成本 / 20% 成本门槛 / 质量与 p95 门槛一律 not_measured 或
 *   external_blocked，绝不报告任何达成；
 * - cacheRead=0 与缺字段在现有管道中归并为同一表现（cachedTokens=null），无法可靠区分，
 *   因此保持 unknown 并说明限制；
 * - 只聚合 taskId/mode/时长/TTFT/token 计数等元数据，不收集 prompt/env/secret。
 */

/**
 * 每模式非空 TTFT 样本低于该值时标记 smallSample。
 * 阈值 90 = 固定 30 任务 × 3 次重复（handoff §4.4 建议的每模式期望总量）；
 * 完整跑批因 deadline 截断或子集运行不足 90 时即标记小样本，避免与全量跑批横向比较。
 */
export const SMALL_SAMPLE_MIN_RUNS = 90;

const CACHE_READ_LIMITATION =
	"mock 上游（LocalBenchmarkMockServer）从不报告 cacheRead；现有管道在事件解析处将缺失字段与 0 归并（e.usage.cacheRead ?? 0），" +
	"测量落库后 cachedTokens 仅在 >0 时非 null。因此无法可靠区分 cacheRead=0 与缺字段，本报告保持 unknown，不虚构缓存命中或 cacheHitRate。";

const NULL_FIELD_NOTE_PREFIX = "现有链路无法可靠取得，保持 null，不虚构。来源：";

export interface S5DurationStats {
	p50: number | null;
	p95: number | null;
	min: number | null;
	max: number | null;
	avg: number | null;
}

export interface S5TtftStats {
	/** 非空 TTFT 样本数 */
	sampleSize: number;
	/** TTFT 缺失（null）的测量条数 */
	missingCount: number;
	p50: number | null;
	p95: number | null;
	smallSample: boolean;
	note: string;
}

export interface S5TokenStats {
	inputTokensSum: number | null;
	outputTokensSum: number | null;
	/** input/output 至少一项非 null 的测量条数 */
	withUsageCount: number;
	usageSourceBreakdown: Record<string, number>;
	cachedTokens: null;
	cacheReadStatus: "unknown";
	note: string;
}

export interface S5ModeStats {
	mode: "cold" | "warm" | "recovery";
	total: number;
	passed: number;
	/** 模式无测量时为 null（未知，不写成 0） */
	passRate: number | null;
	durationMs: S5DurationStats;
	ttft: S5TtftStats;
	tokens: S5TokenStats;
	modelCallCount: null;
	retryCount: null;
	compactionTokens: null;
}

export interface S5FailedConsumption {
	failedCount: number;
	failedWithUsageCount: number;
	failedInputTokensSum: number | null;
	failedOutputTokensSum: number | null;
	passedCount: number;
	passedWithUsageCount: number;
	passedInputTokensSum: number | null;
	passedOutputTokensSum: number | null;
	note: string;
}

export interface S5GateEntry {
	status: "not_measured" | "external_blocked";
	reason: string;
	baseline: null;
	current: null;
}

export interface S5OptimizationGates {
	overallStatus: "not_measured";
	statement: string;
	realModelCost: { status: "external_blocked"; reason: string; valueDollars: null };
	costPerSuccessfulTaskReduction20pct: S5GateEntry;
	completionRateRegressionMax2pp: S5GateEntry;
	ttftP95RegressionMax10pct: S5GateEntry;
}

export interface S5FieldProvenanceEntry {
	status: "null" | "unknown";
	source: string;
}

export interface S5FieldProvenance {
	cacheRead: S5FieldProvenanceEntry;
	modelCallCount: S5FieldProvenanceEntry;
	retryCount: S5FieldProvenanceEntry;
	compactionTokens: S5FieldProvenanceEntry;
}

export interface S5Provenance {
	generator: "S5d s5-token-benchmark (pure transform over S0 runBenchmark output)";
	repoRevision: string | null;
	repoRevisionNote: string;
	suiteVersion: string;
	suiteHash: string;
	fixtureHashes: Record<string, string>;
	sourceReport: {
		timestamp: string;
		totalRuns: number;
		repetitions: number;
		timedOut: boolean;
		path: string | null;
	};
	mockDeclaration: {
		environment: "local-mock";
		model: "mock-model (LocalBenchmarkMockServer via ModelGateway)";
		mockConfiguredUnitPriceDollars: 0.0;
		realCostStatus: "unknown / external_blocked";
		note: string;
	};
	backendLimitations: string[];
	privacy: {
		promptCollected: false;
		envCollected: false;
		secretsCollected: false;
		collectedFields: string[];
		note: string;
	};
}

export interface S5TokenBenchmarkReport {
	reportType: "S5-token-benchmark";
	generatedAt: string;
	provenance: S5Provenance;
	overall: {
		totalMeasurements: number;
		passed: number;
		/** 无任何测量时为 null（未知，不写成 0） */
		passRate: number | null;
		durationMs: S5DurationStats;
	};
	modes: {
		cold: S5ModeStats;
		warm: S5ModeStats;
		recovery: S5ModeStats;
	};
	failedTaskConsumption: S5FailedConsumption;
	optimizationGates: S5OptimizationGates;
	fieldProvenance: S5FieldProvenance;
}

function round2(v: number): number {
	return Math.round(v * 100) / 100;
}

/**
 * 线性插值分位数（PERCENTILE.INC 语义）。空集返回 null（诚实缺省，不报 0）。
 */
export function percentile(input: number[], p: number): number | null {
	if (input.length === 0) return null;
	const values = [...input].sort((a, b) => a - b);
	const idx = (p / 100) * (values.length - 1);
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return round2(values[lo]!);
	return round2(values[lo]! + (values[hi]! - values[lo]!) * (idx - lo));
}

function sumOrNull(values: (number | null)[]): number | null {
	let sum = 0;
	let counted = 0;
	for (const v of values) {
		if (v !== null) {
			sum += v;
			counted++;
		}
	}
	return counted > 0 ? sum : null;
}

function durationStats(values: number[]): S5DurationStats {
	if (values.length === 0) return { p50: null, p95: null, min: null, max: null, avg: null };
	return {
		p50: percentile(values, 50),
		p95: percentile(values, 95),
		min: Math.min(...values),
		max: Math.max(...values),
		avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
	};
}

/**
 * 套件哈希：对 "id:fixtureHash" 排序后取 SHA-256，绑定既有 30 任务与 fixture hash。
 */
export function computeSuiteHash(fixtureHashes: Record<string, string>): string {
	const h = createHash("sha256");
	for (const id of Object.keys(fixtureHashes).sort()) {
		h.update(id);
		h.update(":");
		h.update(fixtureHashes[id]!);
		h.update("\n");
	}
	return h.digest("hex");
}

function buildModeStats(mode: S5ModeStats["mode"], runs: BenchmarkMeasurement[]): S5ModeStats {
	const durations = runs.map((m) => m.durationMs);
	const ttftValues = runs.map((m) => m.ttftMs).filter((v): v is number => v !== null);
	const breakdown: Record<string, number> = {};
	for (const m of runs) breakdown[m.usageSource] = (breakdown[m.usageSource] ?? 0) + 1;
	const passed = runs.filter((m) => m.success).length;
	return {
		mode,
		total: runs.length,
		passed,
		passRate: runs.length > 0 ? passed / runs.length : null,
		durationMs: durationStats(durations),
		ttft: {
			sampleSize: ttftValues.length,
			missingCount: runs.length - ttftValues.length,
			p50: percentile(ttftValues, 50),
			p95: percentile(ttftValues, 95),
			smallSample: ttftValues.length < SMALL_SAMPLE_MIN_RUNS,
			note: `TTFT 分位数仅聚合非空实测值（${ttftValues.length}/${runs.length}）；样本数 < ${SMALL_SAMPLE_MIN_RUNS} 时标记 smallSample。`,
		},
		tokens: {
			inputTokensSum: sumOrNull(runs.map((m) => m.inputTokens)),
			outputTokensSum: sumOrNull(runs.map((m) => m.outputTokens)),
			withUsageCount: runs.filter((m) => m.inputTokens !== null || m.outputTokens !== null).length,
			usageSourceBreakdown: breakdown,
			cachedTokens: null,
			cacheReadStatus: "unknown",
			note: CACHE_READ_LIMITATION,
		},
		modelCallCount: null,
		retryCount: null,
		compactionTokens: null,
	};
}

function buildFailedConsumption(measurements: BenchmarkMeasurement[]): S5FailedConsumption {
	const failed = measurements.filter((m) => !m.success);
	const passed = measurements.filter((m) => m.success);
	const withUsage = (list: BenchmarkMeasurement[]) =>
		list.filter((m) => m.inputTokens !== null || m.outputTokens !== null).length;
	return {
		failedCount: failed.length,
		failedWithUsageCount: withUsage(failed),
		failedInputTokensSum: sumOrNull(failed.map((m) => m.inputTokens)),
		failedOutputTokensSum: sumOrNull(failed.map((m) => m.outputTokens)),
		passedCount: passed.length,
		passedWithUsageCount: withUsage(passed),
		passedInputTokensSum: sumOrNull(passed.map((m) => m.inputTokens)),
		passedOutputTokensSum: sumOrNull(passed.map((m) => m.outputTokens)),
		note:
			"失败任务消耗单独统计，不摊入成功任务均值；token 求和仅计非 null 实测值。" +
			"mock 单价为 $0.00，不换算金额；真实商业成本 external_blocked。",
	};
}

function buildGates(): S5OptimizationGates {
	return {
		overallStatus: "not_measured",
		statement:
			"初始优化门槛（每成功任务成本较基线下降≥20%、完成率下降≤2个百分点、首 token p95 回退≤10%）" +
			"在无真实模型成本与真实配对基线时一律 not_measured / external_blocked；本报告不报告任何达成。",
		realModelCost: {
			status: "external_blocked",
			reason: "真实商业模型上游通道与对账未打通（S4 external_blocked）；当前 mock 单价 $0.00 不代表真实经济效益。",
			valueDollars: null,
		},
		costPerSuccessfulTaskReduction20pct: {
			status: "external_blocked",
			reason: "依赖真实模型成本计量（S4 external_blocked）与真实配对基线，两者均未具备。",
			baseline: null,
			current: null,
		},
		completionRateRegressionMax2pp: {
			status: "not_measured",
			reason: "无真实配对基线报告可比，仅本地 mock 固定任务集，不构成质量门槛实测。",
			baseline: null,
			current: null,
		},
		ttftP95RegressionMax10pct: {
			status: "not_measured",
			reason: "无真实配对基线报告可比；本报告的 p95 为绝对观测值，非与基线的回归对比。",
			baseline: null,
			current: null,
		},
	};
}

function buildFieldProvenance(): S5FieldProvenance {
	return {
		cacheRead: { status: "unknown", source: CACHE_READ_LIMITATION },
		modelCallCount: {
			status: "null",
			source: NULL_FIELD_NOTE_PREFIX +
				"管道仅记录 eventsCount（WS 客户端事件总数），未隔离模型请求数，不虚构调用数。",
		},
		retryCount: {
			status: "null",
			source: NULL_FIELD_NOTE_PREFIX +
				"现有链路（ClientEvent 流与测量落库）未暴露逐请求重试事件，不虚构重试数。",
		},
		compactionTokens: {
			status: "null",
			source: NULL_FIELD_NOTE_PREFIX +
				"现有链路无上下文压缩（compaction/summarization）计量点，mock 会话为单轮工具调用，不虚构压缩 token。",
		},
	};
}

export interface BuildS5ReportOptions {
	/** 仓库 revision（协调者传入）；未传入时保持 null，不假设。 */
	repoRevision?: string | null;
	/** 基础 S0 报告 JSON 路径（仅记录出处，不读取内容）。 */
	sourceReportPath?: string;
}

const S0_SHA256_HEX = /^[0-9a-f]{64}$/;
const S0_USAGE_SOURCES = ["mock-reported", "unknown / missing-source"] as const;
const S0_MODES = ["cold", "warm", "recovery"] as const;

function s0ValidationError(path: string, reason: string): never {
	throw new Error(`S0 报告验证失败 @ ${path}: ${reason}`);
}

function isFiniteNonNegative(v: unknown): boolean {
	return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function validateS0Measurement(raw: unknown, path: string, fixtureHashes: Record<string, string>): void {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) s0ValidationError(path, "必须是对象");
	const m = raw as Record<string, unknown>;
	if (typeof m.taskId !== "string" || !(m.taskId in fixtureHashes)) {
		s0ValidationError(`${path}.taskId`, "未知任务（不在 suiteProvenance.fixtureHashes 中）");
	}
	if (!S0_MODES.includes(m.mode as never)) s0ValidationError(`${path}.mode`, `非法 mode: ${JSON.stringify(m.mode)}`);
	if (typeof m.success !== "boolean") s0ValidationError(`${path}.success`, "必须是 boolean");
	if (!Number.isInteger(m.repetition) || (m.repetition as number) < 1) s0ValidationError(`${path}.repetition`, "必须是正整数");
	if (!isFiniteNonNegative(m.durationMs)) s0ValidationError(`${path}.durationMs`, "必须是有限非负数");
	for (const field of ["ttftMs", "recoveryTimeToOperableMs", "inputTokens", "outputTokens", "cachedTokens", "rssBytes", "eventsCount"] as const) {
		const v = m[field];
		if (v !== null && !isFiniteNonNegative(v)) s0ValidationError(`${path}.${field}`, "必须是 null 或有限非负数");
	}
	if (!S0_USAGE_SOURCES.includes(m.usageSource as never)) {
		s0ValidationError(`${path}.usageSource`, `非法 usageSource: ${JSON.stringify(m.usageSource)}`);
	}
	if (m.realCostDollars !== null) s0ValidationError(`${path}.realCostDollars`, "local-mock 报告必须为 null");
	if (m.mockConfiguredCostDollars !== 0) s0ValidationError(`${path}.mockConfiguredCostDollars`, "local-mock 单价必须为 0");
}

/**
 * 转换模式入口验证：最小运行时验证输入确实是 S0 local-mock 报告，
 * 防止任意 JSON 被伪装成 local-mock 报告转换。非法输入抛 Error（带字段路径），
 * 由调用方保证不写任何产物。
 */
export function validateS0Report(data: unknown): ActualBenchmarkReport {
	if (typeof data !== "object" || data === null || Array.isArray(data)) s0ValidationError("$", "必须是 JSON 对象");
	const r = data as Record<string, unknown>;

	// mock 环境与真实管道来源声明
	const prov = r.suiteProvenance;
	if (typeof prov !== "object" || prov === null || Array.isArray(prov)) s0ValidationError("$.suiteProvenance", "缺失");
	const p = prov as Record<string, unknown>;
	if (p.source !== "local-mock-pipeline") s0ValidationError("$.suiteProvenance.source", `必须是 local-mock-pipeline，实际 ${JSON.stringify(p.source)}`);
	if (typeof p.framework !== "string" || !p.framework.includes("LocalBackend")) {
		s0ValidationError("$.suiteProvenance.framework", "必须声明真实执行框架（含 LocalBackend）");
	}

	// 固定 30 任务 fixture hash
	if (typeof p.fixtureHashes !== "object" || p.fixtureHashes === null || Array.isArray(p.fixtureHashes)) {
		s0ValidationError("$.suiteProvenance.fixtureHashes", "缺失");
	}
	const hashEntries = Object.entries(p.fixtureHashes as Record<string, unknown>);
	if (hashEntries.length !== BENCHMARK_FIXTURE_TASKS.length) {
		s0ValidationError("$.suiteProvenance.fixtureHashes", `必须包含 ${BENCHMARK_FIXTURE_TASKS.length} 个任务 hash，实际 ${hashEntries.length}`);
	}
	const fixtureHashes: Record<string, string> = {};
	for (const [id, h] of hashEntries) {
		if (typeof h !== "string" || !S0_SHA256_HEX.test(h)) s0ValidationError(`$.suiteProvenance.fixtureHashes.${id}`, "必须是 64 位十六进制 SHA-256");
		fixtureHashes[id] = h;
	}

	// task ID 集合必须与当前 BENCHMARK_FIXTURE_TASKS 完全一致（不只是数量）
	const expectedIds = BENCHMARK_FIXTURE_TASKS.map((t) => t.id).sort();
	const actualIds = hashEntries.map(([id]) => id).sort();
	for (let i = 0; i < expectedIds.length; i++) {
		if (expectedIds[i] !== actualIds[i]) {
			s0ValidationError(
				"$.suiteProvenance.fixtureHashes",
				`task ID 集合与当前 ${BENCHMARK_FIXTURE_TASKS.length} 任务 fixtures 不一致（差异：${expectedIds[i]!} vs ${actualIds[i] ?? "缺失"}）`,
			);
		}
	}

	if (typeof r.suiteVersion !== "string" || r.suiteVersion.length === 0) s0ValidationError("$.suiteVersion", "缺失");
	if (typeof r.timestamp !== "string" || r.timestamp.length === 0) s0ValidationError("$.timestamp", "必须是非空字符串（转换读取其进 provenance.sourceReport.timestamp）");
	const cost = r.costDeclaration;
	if (typeof cost !== "object" || cost === null || Array.isArray(cost) || (cost as Record<string, unknown>).environment !== "local-mock") {
		s0ValidationError("$.costDeclaration.environment", "必须声明 local-mock 环境");
	}

	// executionMeta：转换读取（sourceReport）的数字字段必须为有限非负数
	const meta = r.executionMeta;
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) s0ValidationError("$.executionMeta", "缺失");
	const em = meta as Record<string, unknown>;
	for (const field of ["totalRuns", "repetitions", "deadlineMs", "actualElapsedMs"] as const) {
		if (!isFiniteNonNegative(em[field])) s0ValidationError(`$.executionMeta.${field}`, "必须是有限非负数");
	}
	if (typeof em.timedOut !== "boolean") s0ValidationError("$.executionMeta.timedOut", "必须是 boolean");

	// summary：对象存在检查在读成员前完成，非法输入抛带字段路径错误而非 TypeError
	if (typeof r.summary !== "object" || r.summary === null || Array.isArray(r.summary)) s0ValidationError("$.summary", "缺失");
	const summary = r.summary as Record<string, unknown>;
	for (const field of ["totalTasks", "totalMeasurements", "overallPassRate", "avgDurationMs", "peakRssBytes", "totalInputTokens", "totalOutputTokens"] as const) {
		if (!isFiniteNonNegative(summary[field])) s0ValidationError(`$.summary.${field}`, "必须是有限非负数");
	}
	for (const mode of S0_MODES) {
		if (typeof summary[mode] !== "object" || summary[mode] === null) s0ValidationError(`$.summary.${mode}`, "缺失");
	}

	if (!Array.isArray(r.measurements) || r.measurements.length === 0) s0ValidationError("$.measurements", "必须是非空数组");
	r.measurements.forEach((m, i) => validateS0Measurement(m, `$.measurements[${i}]`, fixtureHashes));

	return data as ActualBenchmarkReport;
}

/**
 * 纯转换：从 runBenchmark 产出的 ActualBenchmarkReport 聚合 S5 补充报告。
 * 不修改输入对象，不做任何 I/O，不收集 prompt/env/secret。
 */
export function buildS5Report(base: ActualBenchmarkReport, opts: BuildS5ReportOptions = {}): S5TokenBenchmarkReport {
	const measurements = base.measurements;
	const byMode = (mode: S5ModeStats["mode"]) => measurements.filter((m) => m.mode === mode);
	const durations = measurements.map((m) => m.durationMs);
	const passed = measurements.filter((m) => m.success).length;

	return {
		reportType: "S5-token-benchmark",
		generatedAt: new Date().toISOString(),
		provenance: {
			generator: "S5d s5-token-benchmark (pure transform over S0 runBenchmark output)",
			repoRevision: opts.repoRevision ?? null,
			repoRevisionNote: "repoRevision 由协调者显式传入；未传入时保持 null，不假设当前 HEAD。",
			suiteVersion: base.suiteVersion,
			suiteHash: computeSuiteHash(base.suiteProvenance.fixtureHashes),
			fixtureHashes: base.suiteProvenance.fixtureHashes,
			sourceReport: {
				timestamp: base.timestamp,
				totalRuns: base.executionMeta.totalRuns,
				repetitions: base.executionMeta.repetitions,
				timedOut: base.executionMeta.timedOut,
				path: opts.sourceReportPath ?? null,
			},
			mockDeclaration: {
				environment: "local-mock",
				model: "mock-model (LocalBenchmarkMockServer via ModelGateway)",
				mockConfiguredUnitPriceDollars: 0.0,
				realCostStatus: "unknown / external_blocked",
				note: "所有模型金额按 mock 配置为 $0.00；真实商业模型通道与对账未打通，本报告不代表真实经济效益。",
			},
			backendLimitations: [
				"执行后端为 LocalBackend（宿主机子进程）；本基准仅覆盖 LocalBackend 路径，不覆盖 S2 容器隔离后端。",
				"Peak RSS 测量主体为 runner 运行进程自身，非 Gateway/Harness 子进程。",
				"模型端点为本地 mock（不产生真实成本与真实缓存行为），recovery 模式为真实独立 OS 子进程 A/B 重启。",
				"recovery 的 durationMs 沿用 S0 口径 = recoveryTimeToOperableMs+200（不可操作时常量 250），是派生值而非真实任务墙钟时长，跨模式时长对比无效；recovery 的 TTFT 与恢复就绪耗时为重启后真实单调钟观测。",
				"任务集固定为 30 个 fixture 任务（suiteHash 绑定），默认每任务 3 次重复。",
			],
			privacy: {
				promptCollected: false,
				envCollected: false,
				secretsCollected: false,
				collectedFields: [
					"taskId", "mode", "repetition", "success", "durationMs", "ttftMs",
					"recoveryTimeToOperableMs", "eventsCount", "inputTokens", "outputTokens",
					"cachedTokens", "usageSource", "rssBytes",
				],
				note: "collectedFields 为允许读取的源元数据白名单：转换仅读取白名单内字段做聚合，未列入的源字段一律忽略；报告体只发射统计结果，不逐条复制源测量。不读取、不发射 prompt、环境变量与 secret。",
			},
		},
		overall: {
			totalMeasurements: measurements.length,
			passed,
			passRate: measurements.length > 0 ? passed / measurements.length : null,
			durationMs: durationStats(durations),
		},
		modes: {
			cold: buildModeStats("cold", byMode("cold")),
			warm: buildModeStats("warm", byMode("warm")),
			recovery: buildModeStats("recovery", byMode("recovery")),
		},
		failedTaskConsumption: buildFailedConsumption(measurements),
		optimizationGates: buildGates(),
		fieldProvenance: buildFieldProvenance(),
	};
}

export interface S5RunSelectionInput {
	/** 原始 --tasks 字符串（未提供时 undefined，runner 默认全集） */
	tasks?: string;
	/** 原始 --modes 字符串（未提供时 undefined，runner 默认三模式） */
	modes?: string;
	repetitions: number;
	deadlineMs: number;
}

export interface S5RunSelection {
	tasks: string[] | undefined;
	modes: ("cold" | "warm" | "recovery")[] | undefined;
	repetitions: number;
	deadlineMs: number;
}

/**
 * 模式 A（跑批）参数边界校验：非法值抛错（带参数名）。
 * 由 CLI 在启动 benchmark 前调用，保证非法输入不启动跑批、不写任何产物。
 */
export function validateS5RunSelection(input: S5RunSelectionInput): S5RunSelection {
	const fail = (arg: string, reason: string): never => {
		throw new Error(`S5 CLI 参数非法 @ ${arg}: ${reason}`);
	};
	if (!Number.isInteger(input.repetitions) || input.repetitions < 1) {
		fail("--repetitions", `必须是有限正整数，实际 ${input.repetitions}`);
	}
	if (!Number.isFinite(input.deadlineMs) || input.deadlineMs <= 0) {
		fail("--deadline-ms", `必须是有限正数，实际 ${input.deadlineMs}`);
	}
	let tasks: string[] | undefined;
	if (input.tasks !== undefined) {
		const ids = input.tasks.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
		if (ids.length === 0) fail("--tasks", "不能为空（空或全逗号/空白）");
		const known = new Set(BENCHMARK_FIXTURE_TASKS.map((t) => t.id));
		for (const id of ids) {
			if (!known.has(id)) fail("--tasks", `未知任务 ID: ${id}`);
		}
		tasks = ids;
	}
	let modes: ("cold" | "warm" | "recovery")[] | undefined;
	if (input.modes !== undefined) {
		const list = input.modes.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
		if (list.length === 0) fail("--modes", "不能为空（空或全逗号/空白）");
		for (const m of list) {
			if (!S0_MODES.includes(m as never)) fail("--modes", `未知模式: ${m}`);
		}
		modes = list as ("cold" | "warm" | "recovery")[];
	}
	return { tasks, modes, repetitions: input.repetitions, deadlineMs: input.deadlineMs };
}
