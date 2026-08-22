import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Golden task suite —— 任务规格与加载。
 *
 * 策略文档把它列为 Phase 1 的验收依据：「20–30 个真实任务，每个定义输入
 * （issue 描述 + 仓库快照）与验收（测试通过 / 可合并 PR）」，作用是把
 * 「完成率 > 50%」从口号变成可测指标，并当作以后改模型/改 prompt 的回归基线。
 *
 * 这一层刻意只做**规格与校验**，不碰执行。理由是任务集要与客户共建 ——
 * 客户提交的是 YAML 与一个仓库目录，不该需要读懂 runner。
 *
 * 三条约束是从踩过的坑里来的，不是形式主义：
 *
 * 1. **验收命令以仓库根为 cwd 且不带路径参数**（加载期会拒掉引用快照路径的命令）。
 *    `node --test evals/repos/x`
 *    会把目录当入口模块，报 MODULE_NOT_FOUND 而退出码同样是 1 ——
 *    看起来"验收失败"，理由却完全不是任务没做完。带路径的判据会让
 *    整套基线数字在一个假原因上失真。
 * 2. **任务类型限定在 R7 的四类。** 策略文档明确「不承诺全自动开发」，
 *    任务集要是混进架构级任务，完成率这个数字就不再对应销售口径。
 * 3. **仓库快照是目录，运行时复制。** 原地跑的话第一次运行就污染第二次，
 *    而回归基线的全部价值在于可重复。
 */

/** R7 限定的任务类型。销售口径与验收口径必须是同一份清单 */
export const TASK_TYPES = ["bug-fix", "test-coverage", "dependency-upgrade", "refactor"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export interface TaskSpec {
	id: string;
	type: TaskType;
	/** evals/repos/ 下的目录名 */
	repo: string;
	/** 喂给 agent 的任务描述，对应真实场景里的 issue 正文 */
	prompt: string;
	/**
	 * 验收命令，全部退出码 0 才算完成。
	 * 在**沙箱内**、以仓库根为 cwd 执行 —— 它们跑的是 agent 刚写的代码。
	 */
	verify: string[];
	/**
	 * 起点必须失败的那些验收命令（verify 的子集，按下标）。
	 *
	 * 存在的理由：重构与依赖升级类任务的起点测试本来就是绿的，
	 * 只靠「验收全绿」的话 agent 什么都不做也算完成。声明了这个字段，
	 * 加载时就能反向校验「起点确实不满足验收」，把恒真的任务挡在集合之外。
	 */
	failsAtStart: number[];
	/** 人工干预次数上限。策略文档的指标是 < 2 次/任务 */
	maxApprovals: number;
	/** 单任务墙钟上限，毫秒 */
	timeoutMs: number;
}

function fail(file: string, msg: string): never {
	throw new Error(`任务规格 ${file}：${msg}`);
}

function parseTask(file: string, raw: unknown, reposRoot: string): TaskSpec {
	if (typeof raw !== "object" || raw === null) fail(file, "顶层必须是对象");
	const o = raw as Record<string, unknown>;

	if (typeof o.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(o.id)) {
		fail(file, `id 必须是小写短横线形式，实际 ${JSON.stringify(o.id)}`);
	}
	if (typeof o.type !== "string" || !TASK_TYPES.includes(o.type as TaskType)) {
		fail(file, `type 必须是 ${TASK_TYPES.join(" / ")} 之一，实际 ${JSON.stringify(o.type)}`);
	}
	if (typeof o.repo !== "string" || !o.repo) fail(file, "repo 必填");
	const repoDir = join(reposRoot, o.repo);
	// 快照缺失要在加载期就炸。留到运行期的话，一个打错的目录名会表现为
	// 「任务失败」而不是「任务集坏了」—— 前者会被算进完成率
	if (!existsSync(repoDir) || !statSync(repoDir).isDirectory()) fail(file, `仓库快照不存在：${repoDir}`);
	if (typeof o.prompt !== "string" || o.prompt.trim().length < 10) fail(file, "prompt 必填，且不能是一句话占位");

	if (!Array.isArray(o.verify) || o.verify.length === 0) fail(file, "verify 至少一条");
	const verify = o.verify.map((c) => {
		if (typeof c !== "string" || !c.trim()) fail(file, "verify 的每一项必须是非空字符串");
		// 约束 1 的执行部分：验收命令必须以仓库根为 cwd。带上快照路径的话，
		// `node --test evals/repos/x` 会把目录当入口模块报 MODULE_NOT_FOUND，
		// 退出码同样是 1 —— 看起来是「验收失败」，理由却完全不是任务没做完
		if (/evals[/\\]repos/.test(c)) fail(file, `verify 不能引用快照路径，它以仓库根为 cwd：${c}`);
		return c.trim();
	});

	const failsAtStart = o.failsAtStart ?? [];
	if (!Array.isArray(failsAtStart) || failsAtStart.length === 0) {
		fail(file, "failsAtStart 至少要指一条 —— 起点就满足验收的任务不是任务");
	}
	for (const i of failsAtStart) {
		if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= verify.length) {
			fail(file, `failsAtStart 的下标 ${i} 超出 verify 范围`);
		}
	}

	// 只判 typeof number 不够：NaN、负数、0 都能过，而 timeoutMs: 0
	// 会让每个任务立刻超时 —— 那会表现为「模型全军覆没」
	const num = (v: unknown, dflt: number, name: string, min: number): number => {
		if (v === undefined) return dflt;
		if (typeof v !== "number" || !Number.isFinite(v) || v < min) fail(file, `${name} 必须是 ≥${min} 的有限数值`);
		return v;
	};

	return {
		id: o.id,
		type: o.type as TaskType,
		repo: o.repo,
		prompt: o.prompt,
		verify,
		failsAtStart: failsAtStart as number[],
		maxApprovals: num(o.maxApprovals, 2, "maxApprovals", 0),
		timeoutMs: num(o.timeoutMs, 300_000, "timeoutMs", 1_000),
	};
}

/** 加载整个任务集。id 冲突直接报错 —— 重复 id 会让报告里两行指向同一个任务 */
export function loadSuite(tasksDir: string, reposRoot: string): TaskSpec[] {
	const files = readdirSync(tasksDir)
		.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
		.sort();
	const tasks: TaskSpec[] = [];
	const seen = new Set<string>();
	for (const f of files) {
		const path = join(tasksDir, f);
		const task = parseTask(f, parseYaml(readFileSync(path, "utf8")), reposRoot);
		if (seen.has(task.id)) fail(f, `id 与前一个任务重复：${task.id}`);
		seen.add(task.id);
		tasks.push(task);
	}
	return tasks;
}
