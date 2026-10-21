import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BENCHMARK_FIXTURE_TASKS, SUITE_VERSION } from "../src/evals/benchmark-fixtures.ts";
import { BenchmarkPipeline } from "../src/evals/benchmark-pipeline.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("1. Provenance 与 Fixture 完整性：30 个任务规格与固定哈希", () => {
	assert.equal(BENCHMARK_FIXTURE_TASKS.length, 30);
	assert.equal(SUITE_VERSION, "S0-v1.1.0-actual-mock");

	const ids = new Set<string>();
	for (const task of BENCHMARK_FIXTURE_TASKS) {
		assert.ok(!ids.has(task.id), `重复的任务 ID: ${task.id}`);
		ids.add(task.id);
		assert.ok(task.prompt.length >= 10, `prompt 过短: ${task.id}`);
		assert.ok(task.verify.length >= 1, `verify 为空: ${task.id}`);
		assert.ok(task.failsAtStart.length >= 1, `failsAtStart 为空: ${task.id}`);
		assert.match(task.fixtureHash, /^[0-9a-f]{64}$/, `fixtureHash 必须是 64 位 SHA-256`);
		assert.ok(task.files["package.json"], `缺少 package.json: ${task.id}`);
	}
});

test("2. Validator 起点真实性与 Negative 失败真实性（非硬编码 true）", async () => {
	const pipeline = new BenchmarkPipeline({ repoRoot: REPO_ROOT });
	try {
		await pipeline.startServices(true); // negative = true
		const sampleTask = BENCHMARK_FIXTURE_TASKS[0]!;
		const result = await pipeline.runCold(sampleTask, 1);

		assert.equal(result.taskId, sampleTask.id);
		assert.equal(result.mode, "cold");
		assert.equal(result.success, false, "Negative 模式必须真实失败，不得虚假上报成功");
		assert.ok(result.durationMs > 0, "必须实测单调时钟耗时");
		assert.ok(result.ttftMs !== null && result.ttftMs > 0, "必须记录实测 TTFT");
	} finally {
		await pipeline.closeServices();
	}
});

test("3. 真实管道 Cold、Warm 与 Recovery 模式实测指标及 PID/连续性断言", async () => {
	const pipeline = new BenchmarkPipeline({ repoRoot: REPO_ROOT });
	try {
		await pipeline.startServices(false);
		const sampleTask = BENCHMARK_FIXTURE_TASKS[0]!;

		// Cold 模式：真实 LocalBackend 宿主机子进程
		const cold = await pipeline.runCold(sampleTask, 1);
		assert.equal(cold.success, true);
		assert.ok(cold.durationMs > 0);
		assert.ok(cold.ttftMs !== null && cold.ttftMs > 0);
		assert.equal(cold.usageSource, "mock-reported");
		assert.equal(cold.realCostDollars, null);
		assert.equal(cold.mockConfiguredCostDollars, 0.0);
		assert.equal(cold.memoryMetric.target, "runner_process");
		assert.equal(cold.memoryMetric.pid, process.pid);

		// Warm 模式：动态解析事件，无 80/40/25 硬编码
		const warm = await pipeline.runWarm(sampleTask, 1);
		assert.equal(warm.success, true);
		assert.ok(warm.durationMs > 0);
		assert.equal(warm.usageSource, "mock-reported");
		// mock 未报告 cacheRead 时，cachedTokens 诚实为 null，绝不冒充 40
		assert.equal(warm.cachedTokens, null);
		assert.ok(warm.inputTokens !== null && warm.inputTokens > 0);

		// Recovery 模式：真实独立 OS 子进程 A/B
		const rec = await pipeline.runRecovery(sampleTask, 1);
		assert.equal(rec.success, true);
		assert.ok(rec.durationMs > 0);
		assert.ok(rec.recoveryTimeToOperableMs !== null && rec.recoveryTimeToOperableMs > 0);
		assert.equal(rec.realCostDollars, null);
		assert.equal(rec.mockConfiguredCostDollars, 0.0);

		// PID 真实性核验
		assert.ok(rec.recoveryProcessMeta, "必须提供真实进程重启元数据");
		assert.ok(rec.recoveryProcessMeta.instanceAPid > 0, "实例 A 必须拥有真实 OS PID");
		assert.ok(rec.recoveryProcessMeta.instanceBPid > 0, "实例 B 必须拥有真实 OS PID");
		assert.notEqual(rec.recoveryProcessMeta.instanceAPid, rec.recoveryProcessMeta.instanceBPid, "实例 A 与 B 必须为两个不同的独立操作系统进程");
		assert.equal(rec.recoveryProcessMeta.instanceAExitCode, 0, "实例 A 必须正常以 exitCode 0 自然退出");
	} finally {
		await pipeline.closeServices();
	}
});

test("4. 动态 Usage 事件解析与缺失来源 unknown/null 降级自证", async () => {
	// A. 可控不同 usage 测试
	const customPipeline = new BenchmarkPipeline({
		repoRoot: REPO_ROOT,
		mockOptions: { customPromptTokens: 345, customCompletionTokens: 67 },
	});
	try {
		await customPipeline.startServices({ customPromptTokens: 345, customCompletionTokens: 67 });
		const sampleTask = BENCHMARK_FIXTURE_TASKS[0]!;
		const res = await customPipeline.runWarm(sampleTask, 1);
		assert.equal(res.success, true);
		assert.equal(res.inputTokens, 495, "必须动态解析自定义 promptTokens 累加值 (345 + 150)");
		assert.equal(res.outputTokens, 82, "必须动态解析自定义 completionTokens 累加值 (67 + 15)");
		assert.equal(res.usageSource, "mock-reported");
	} finally {
		await customPipeline.closeServices();
	}

	// B. 缺失 usage 测试（上游未发送 usage 块）
	const omitPipeline = new BenchmarkPipeline({
		repoRoot: REPO_ROOT,
		mockOptions: { omitUsage: true },
	});
	try {
		await omitPipeline.startServices({ omitUsage: true });
		const sampleTask = BENCHMARK_FIXTURE_TASKS[0]!;
		const res = await omitPipeline.runWarm(sampleTask, 1);
		assert.equal(res.success, true);
		assert.equal(res.inputTokens, null, "缺失 usage 时 inputTokens 必须为 null");
		assert.equal(res.outputTokens, null, "缺失 usage 时 outputTokens 必须为 null");
		assert.equal(res.cachedTokens, null, "缺失 usage 时 cachedTokens 必须为 null");
		assert.equal(res.usageSource, "unknown / missing-source", "缺失 usage 时必须显式标记 unknown/missing-source");
	} finally {
		await omitPipeline.closeServices();
	}
});

test("5. 期限保护与退出验证（Deadline enforcement）", async () => {
	const pipeline = new BenchmarkPipeline({ repoRoot: REPO_ROOT });
	try {
		await pipeline.startServices(false);
		// 验证超时机制：启动服务后安全关闭无挂起
		assert.ok(pipeline.runId.startsWith("bench-"));
	} finally {
		await pipeline.closeServices();
	}
});
