import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { LocalBackend, TIMEOUT_EXIT } from "../src/gateway/execution-backend.ts";
import { formatReport, type RunOptions, runTask, summarize, type TaskResult } from "../src/evals/runner.ts";
import { loadSuite, type TaskSpec } from "../src/evals/suite.ts";

/**
 * Golden task suite 的测试。
 *
 * 这里要守住的核心性质只有一条：**runner 会判失败**。
 * 一个恒返回 completed 的 runner 能让所有任务"通过"，而完成率正是
 * Phase 1 的验收指标 —— 那种 runner 比没有 runner 更糟。
 * 因此下面每一条 pass 断言都配了一条 fail 断言。
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MOCK = join(REPO, "tests/fixtures/mock-model.mjs");
const TASKS = join(REPO, "evals/tasks");
const REPOS = join(REPO, "evals/repos");

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	// 每步各自兜住。一个 cleanup 抛异常就跳过后面全部 —— 会话生命周期那轮
	// 在同一个形状上踩过三次，这里的后果是临时目录只增不减
	for (const c of cleanups) {
		try {
			await c();
		} catch (err) {
			console.error("清理失败（继续处理后续项）:", err);
		}
	}
});

const suite = loadSuite(TASKS, REPOS);
/** 临时任务集默认复用真实的仓库快照目录 */
const loadTmp = (dir: string) => loadSuite(dir, REPOS);
function taskById(id: string): TaskSpec {
	const t = suite.find((t) => t.id === id);
	assert.ok(t, `任务集里应有 ${id}`);
	return t;
}

/** 每次运行一个独立的临时根，跑完删掉 —— 否则一轮测试留下十几个目录 */
function runRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "eval-run-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** 起一个按脚本行事的 mock 模型，返回可直接给 runTask 的选项 */
async function optsFor(script: unknown[], approvals: "deny" | "approve" = "deny"): Promise<RunOptions> {
	const mock: ChildProcess = spawn(process.execPath, [MOCK, "0", JSON.stringify(script)], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	cleanups.push(() => void mock.kill());
	const port: number = await new Promise((r) => mock.stdout?.once("data", (d) => r(JSON.parse(d.toString()).port)));

	const home = mkdtempSync(join(tmpdir(), "eval-home-"));
	cleanups.push(() => rmSync(home, { recursive: true, force: true }));
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(
		join(home, ".pi", "agent", "models.json"),
		JSON.stringify({
			providers: {
				mock: {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "dummy",
					compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
					models: [{ id: "mock-model" }],
				},
			},
		}),
	);
	return {
		repoRoot: REPO,
		reposRoot: REPOS,
		runRoot: runRoot(),
		piArgs: ["--no-session", "--provider", "mock", "--model", "mock-model"],
		piEnv: { PATH: process.env.PATH, HOME: home },
		// 必须把 piEnv 交给它，否则 pi 读不到 models.json（见 RunOptions.backend）
		backend: new LocalBackend({ PATH: process.env.PATH, HOME: home }),
		approvals,
	};
}

/** 修好 range-utils 的正确内容 */
const FIXED_SUM = `/** 闭区间 [from, to] 的整数和 */
export function sumRange(from, to) {
\tlet total = 0;
\tfor (let i = from; i <= to; i++) total += i;
\treturn total;
}
`;

test("agent 真的修好了 → 判完成；什么都不做 → 判失败", async () => {
	const task = taskById("range-sum-off-by-one");

	const idle = await runTask(task, await optsFor([{ text: "我看了一下，代码没问题" }]));
	assert.equal(idle.counted, true, `这是正常任务，应计入完成率；harnessError=${idle.harnessError}`);
	assert.equal(idle.completed, false, "什么都没改却判完成，说明 runner 恒真");
	assert.equal(idle.verify[0]?.ok, false);

	const fixed = await runTask(
		task,
		await optsFor([{ tool: "write", args: { path: "sum.js", content: FIXED_SUM } }, { text: "已修复" }]),
	);
	assert.equal(fixed.completed, true, `应判完成，实际验收：${JSON.stringify(fixed.verify)}`);
	assert.equal(fixed.harnessError, undefined);
});

test("验收命令跑在任务工作区里，不是网关仓库根", async () => {
	// LocalBackend.exec 漏设 cwd 时，验收会跑在 perimeter-agent 仓库根上：
	// `node --test` 去跑网关自己的测试套件，还会递归发现 evals/repos 下的
	// 同一份任务测试 —— 于是「输出里有 sumRange」这类断言照样通过，等于没守住。
	// 所以这里直接问命令「你在哪」，不拿输出内容当判据。
	const task: TaskSpec = {
		...taskById("range-sum-off-by-one"),
		id: "cwd-probe",
		verify: ['test "$(basename "$(pwd)")" = "cwd-probe"', "test -f never-written"],
		failsAtStart: [1],
	};
	const r = await runTask(task, await optsFor([{ text: "不动" }]));
	assert.equal(r.verify[0]?.ok, true, `验收的 cwd 不是会话工作区：${r.verify[0]?.tail ?? r.harnessError}`);
	assert.equal(r.completed, false);
});

test("起点就满足验收的任务被预检挡下，且不计入完成率", async () => {
	// failsAtStart 指向一条起点必然通过的命令 —— 这模拟的是任务集退化：
	// 有人改了仓库快照，或者验收判据写松了
	const broken: TaskSpec = { ...taskById("range-sum-off-by-one"), verify: ["true"], failsAtStart: [0] };
	const r = await runTask(broken, await optsFor([{ text: "无所谓" }]));
	assert.equal(r.counted, false, "任务集自身坏了不该算进完成率");
	assert.equal(r.completed, false);
	assert.match(String(r.harnessError), /起点预检失败/);
});

test("审批默认自动拒绝，计为人工干预，且命令不执行", async () => {
	const task: TaskSpec = {
		...taskById("range-sum-off-by-one"),
		id: "approval-probe",
		// 验收就查那条被审批门挡住的命令有没有产生副作用
		verify: ["test -f pwned.txt"],
		failsAtStart: [0],
	};
	const r = await runTask(
		task,
		await optsFor([{ tool: "bash", args: { command: "git push --force origin main && touch pwned.txt" } }, { text: "完事" }]),
	);
	assert.equal(r.approvals, 1, "force push 应触发一次审批请求");
	assert.equal(r.completed, false, "自动拒绝下命令不该执行，pwned.txt 不该存在");
});

test("每次运行从干净快照开始 —— 上一次的改动不带到下一次", async () => {
	const task = taskById("range-sum-off-by-one");
	const first = await runTask(
		task,
		await optsFor([{ tool: "write", args: { path: "sum.js", content: FIXED_SUM } }, { text: "改好了" }]),
	);
	assert.equal(first.completed, true);
	// 源快照必须原封不动，否则第二次跑的起点已经是修好的
	assert.match(readFileSync(join(REPOS, "range-utils/sum.js"), "utf8"), /i < to/, "源快照被就地改写了");
	const second = await runTask(task, await optsFor([{ text: "不动" }]));
	assert.equal(second.completed, false, "第二次应从未修复的状态开始");
});

// —— 规格层：任务集退化的闸门 ——

/** 写一个临时任务集目录，返回路径 */
function suiteDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "eval-suite-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
	return dir;
}

const OK_TASK = `id: probe
type: bug-fix
repo: range-utils
prompt: 这是一段足够长的任务描述，说明要修什么
verify: ["node --test"]
failsAtStart: [0]
`;

test("合法规格能加载，四类种子任务都在", () => {
	assert.equal(loadTmp(suiteDir({ "a.yaml": OK_TASK }))[0]?.id, "probe");
	const types = new Set(suite.map((t) => t.type));
	// R7 限定的四类各要有种子，否则 byType 的分类统计天生缺项
	for (const t of ["bug-fix", "test-coverage", "dependency-upgrade", "refactor"]) {
		assert.ok(types.has(t as never), `任务集缺少 ${t} 类的种子任务`);
	}
});

test("非法规格一律在加载期报错，不留到运行期", () => {
	const bad = (patch: string, re: RegExp) => {
		assert.throws(() => loadTmp(suiteDir({ "a.yaml": patch })), re, `这份规格本该被拒：\n${patch}`);
	};
	// 类型超出 R7 的四类 —— 混进架构级任务，完成率就不再对应销售口径
	bad(OK_TASK.replace("type: bug-fix", "type: architecture"), /type 必须是/);
	// 快照目录不存在。留到运行期的话，一个打错的目录名会表现为「任务失败」
	bad(OK_TASK.replace("repo: range-utils", "repo: no-such-repo"), /仓库快照不存在/);
	// 起点就满足验收的任务不是任务
	bad(OK_TASK.replace("failsAtStart: [0]", "failsAtStart: []"), /failsAtStart 至少要指一条/);
	bad(OK_TASK.replace("failsAtStart: [0]", "failsAtStart: [3]"), /超出 verify 范围/);
	bad(OK_TASK.replace('verify: ["node --test"]', "verify: []"), /verify 至少一条/);
	bad(OK_TASK.replace("prompt: 这是一段足够长的任务描述，说明要修什么", "prompt: 修一下"), /prompt 必填/);
	bad(OK_TASK.replace("id: probe", "id: Probe_1"), /id 必须是小写短横线形式/);
});

test("id 重复被拒 —— 否则报告里两行指向同一个任务", () => {
	assert.throws(
		() => loadTmp(suiteDir({ "a.yaml": OK_TASK, "b.yaml": OK_TASK })),
		/id 与前一个任务重复/,
	);
});

// —— 汇总层 ——

test("完成率的分母是「计入的任务」，全军覆没时是 null 而不是 0", () => {
	const t = (over: Partial<TaskResult>): TaskResult => ({
		id: "x",
		type: "bug-fix",
		completed: false,
		counted: true,
		verify: [],
		approvals: 0,
		withinApprovalBudget: true,
		denials: 0,
		durationMs: 1,
		...over,
	});
	// 一个完成、一个未完成、一个预检失败 → 1/2 而不是 1/3
	const r = summarize([t({ completed: true }), t({}), t({ counted: false })], {
		provider: "mock",
		backend: "local",
		approvals: "deny",
	});
	assert.equal(r.counted, 2);
	assert.equal(r.completionRate, 0.5);
	assert.equal(r.total, 3);

	// 全部未计入：0 会被读成「完成率 0%」，而实际是「这批根本没测成」
	const none = summarize([t({ counted: false })], { provider: "mock", backend: "local", approvals: "deny" });
	assert.equal(none.completionRate, null);
	assert.equal(none.avgApprovals, null);
	assert.match(formatReport(none), /完成率 —/);
});

test("报告带上模型与后端 —— 脱离它们的完成率没有意义", () => {
	const r = summarize([], { provider: "claude-opus-5", backend: "local", approvals: "approve" });
	const text = formatReport(r);
	assert.match(text, /claude-opus-5/);
	assert.match(text, /自动批准/);
	// local 后端意味着验收命令在网关宿主机上跑，这句必须跟着数字走
	assert.match(text, /没有隔离/);
	assert.doesNotMatch(formatReport(summarize([], { provider: "p", backend: "docker", approvals: "deny" })), /没有隔离/);
});

test("预检跑在沙箱起来之后 —— 否则容器后端上它永远说 OK", async () => {
	// docker/kubectl 后端下，沙箱在会话启动时才创建。预检若跑在那之前，
	// `docker exec <不存在的容器>` 会被归一成退出码 1，预检就把
	// 「容器还没起来」误读成「起点确实失败」而永远放行 ——
	// 这道闸门恰好在为生产准备的两个后端上失效。
	const order: string[] = [];
	const base = new LocalBackend({ PATH: process.env.PATH });
	const opts = await optsFor([{ text: "不动" }]);
	const spy = {
		kind: base.kind,
		launch: (ctx: Parameters<typeof base.launch>[0]) => base.launch(ctx),
		environment: (ctx: Parameters<typeof base.environment>[0]) => {
			order.push("environment");
			return base.environment(ctx);
		},
		exec: (...args: Parameters<NonNullable<typeof base.exec>>) => {
			order.push("exec");
			return base.exec(...args);
		},
	};
	await runTask(taskById("range-sum-off-by-one"), { ...opts, backend: spy });
	assert.equal(order[0], "environment", `第一次 exec 必须在 launch 之后，实际顺序：${order.join(",")}`);
});

test("验收命令超时算 harness 问题，不算模型没做出来", async () => {
	const task: TaskSpec = {
		...taskById("range-sum-off-by-one"),
		id: "verify-timeout",
		verify: ["sleep 30"],
		failsAtStart: [0],
		timeoutMs: 3_000,
	};
	const r = await runTask(task, await optsFor([{ text: "不动" }]));
	// 预检那次就会超时 —— 同样不能记成任务失败
	assert.equal(r.counted, false, "超时被算进了完成率");
	assert.match(String(r.harnessError), /超时/);
});

test("干预次数超预算单独标注，不并进完成与否", async () => {
	const task: TaskSpec = {
		...taskById("range-sum-off-by-one"),
		id: "budget-probe",
		maxApprovals: 0,
		verify: ["true", "test -f never-written"],
		failsAtStart: [1],
	};
	const r = await runTask(
		task,
		await optsFor([{ tool: "bash", args: { command: "git push --force origin main" } }, { text: "完事" }]),
	);
	assert.equal(r.approvals, 1);
	assert.equal(r.withinApprovalBudget, false, "1 次审批超过了 maxApprovals: 0");
	// 「做完了但要人批三次」和「没做完」是两种问题，混成一个数就没法分别改进
	assert.equal(r.counted, true, "超预算不该让任务退出统计");
});

test("数值字段的非法值在加载期被拒", () => {
	const bad = (patch: string, re: RegExp) => assert.throws(() => loadTmp(suiteDir({ "a.yaml": patch })), re);
	// timeoutMs: 0 会让每个任务立刻超时，表现为「模型全军覆没」
	bad(`${OK_TASK}timeoutMs: 0\n`, /timeoutMs 必须是/);
	bad(`${OK_TASK}timeoutMs: -1\n`, /timeoutMs 必须是/);
	bad(`${OK_TASK}timeoutMs: .nan\n`, /timeoutMs 必须是/);
	bad(`${OK_TASK}maxApprovals: -1\n`, /maxApprovals 必须是/);
	// 带快照路径的验收命令：MODULE_NOT_FOUND 的退出码同样是 1，
	// 会被读成「任务没做完」
	bad(OK_TASK.replace('verify: ["node --test"]', 'verify: ["node --test evals/repos/range-utils"]'), /不能引用快照路径/);
});

test("验收命令超时时整个进程组被杀 —— 孙进程不能留下", async () => {
	// execFile 的 timeout 只杀直接子进程（/bin/sh），验收命令 fork 出来的
	// 孙进程会全部活下来。评测是反复跑的，每次超时泄漏一批。
	// 负面验证做过：同样的命令用 execFile+timeout 跑完残留 2 个进程，
	// 换成 detached + killpg 之后是 0 个。
	const tag = `eval-reap-probe-${process.pid}`;
	const hold = `${process.execPath} -e "setTimeout(()=>{},90000)"`;
	const alive = async () =>
		Number(
			(
				await new Promise<string>((res) => {
					execFile("/bin/sh", ["-c", `pgrep -f ${tag} | wc -l`], (_e, out) => res(out || "0"));
				})
			).trim(),
		);

	assert.equal(await alive(), 0, "探针进程名撞车了，换一个 tag");
	const backend = new LocalBackend({ PATH: process.env.PATH });
	// 前一个放后台（孙进程），后一个占住 sh 让它等到超时
	const r = await backend.exec("s", tmpdir(), `${hold} ${tag}-a & ${hold} ${tag}-b`, 1_500);
	assert.equal(r.code, TIMEOUT_EXIT);
	await new Promise((res) => setTimeout(res, 400));
	assert.equal(await alive(), 0, "超时后仍有进程存活，进程组没杀干净");
});
