import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalBackend } from "../src/gateway/execution-backend.ts";
import { type ApprovalMode, formatReport, runTask, summarize, type TaskResult } from "../src/evals/runner.ts";
import { loadSuite } from "../src/evals/suite.ts";

/**
 * 跑 golden task suite。
 *
 *   node scripts/eval.ts --provider anthropic --model claude-opus-5
 *   node scripts/eval.ts --task range-sum-off-by-one --approve
 *   node scripts/eval.ts --json report.json
 *
 * 模型配置来自可信网关的环境变量，不读取沙箱或全局 pi 配置。
 * 没有模型凭据不能跑出基线，完成率须对应具体模型。
 *
 * 只支持 local 后端：验收命令因此在本机跑，没有隔离。
 * docker / kubectl 形态请直接调 runTask 并传对应 backend ——
 * 它们要的镜像、挂载、namespace 参数不适合塞进命令行。
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

const provider = arg("provider");
const model = arg("model");
const only = arg("task");
const approvals: ApprovalMode = has("approve") ? "approve" : "deny";

const tasks = loadSuite(join(REPO, "evals/tasks"), join(REPO, "evals/repos")).filter((t) => !only || t.id === only);
if (tasks.length === 0) {
	console.error(only ? `没有 id 为 ${only} 的任务` : "任务集是空的");
	process.exit(2);
}

const runRoot = mkdtempSync(join(tmpdir(), "perimeter-eval-"));
const backend = new LocalBackend();
// 警告要在**跑之前**打。放到报告末尾的话，人已经看到数字了才被告知
// 那批数字是在无隔离环境下产生的 —— 顺序决定它是提醒还是免责声明
console.error(`⚠ ${backend.kind} 后端：验收命令以你自己的身份、在本机直接跑 agent 写的代码，没有隔离`);
console.error(`工作区与审计日志：${runRoot}\n`);
const results: TaskResult[] = [];
for (const task of tasks) {
	process.stderr.write(`▶ ${task.id} … `);
	const r = await runTask(task, {
		repoRoot: REPO,
		reposRoot: join(REPO, "evals/repos"),
		runRoot,
		model: { baseUrl: process.env.PERIMETER_MODEL_GATEWAY_URL ?? "http://127.0.0.1:8080/v1", token: process.env.PERIMETER_MODEL_PROXY_TOKEN ?? "", model: model ?? process.env.PERIMETER_MODEL ?? "default", provider },
		backend,
		approvals,
	});
	results.push(r);
	process.stderr.write(`${!r.counted ? "—" : r.completed ? "✓" : "✗"} ${(r.durationMs / 1000).toFixed(1)}s\n`);
}

const report = summarize(results, {
	// 报告里记的是**实际用的**模型标识。缺省时 pi 用它自己的默认配置，
	// 这里如实写成 default 而不是编一个名字 —— 基线对不上模型就没用了
	provider: [provider, model].filter(Boolean).join("/") || "pi-default",
	// 从后端自己读，不手填字符串 —— 标注要跟得住，就不能靠调用方记得改
	backend: backend.kind,
	approvals,
});
console.log(`\n${formatReport(report)}`);

const out = arg("json");
if (out) {
	writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
	console.error(`\n报告已写入 ${out}`);
}

// 完成率没到门槛时以非零退出，好让 CI 直接当 gate 用。
// counted 为 0（这批根本没测成）同样算失败 —— 它不该被读成「通过」
process.exit(report.completionRate !== null && report.completionRate > 0.5 ? 0 : 1);
