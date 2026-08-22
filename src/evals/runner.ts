import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { type ExecutionBackend, LocalBackend, TIMEOUT_EXIT } from "../gateway/execution-backend.ts";
import { Gateway } from "../gateway/server.ts";
import type { ClientEvent } from "../protocol/types.ts";
import type { TaskSpec } from "./suite.ts";

/**
 * Golden task suite 的执行器。
 *
 * 它跑的是**完整的产品路径** —— 真实网关、真实策略引擎、真实审批门、
 * 真实审计。评测若绕开这些直接调 pi，测出来的完成率就不是这个产品的
 * 完成率，而回归基线的意义正在于"改了策略之后完成率掉了多少"。
 *
 * ## 审批在无人值守的评测里怎么办
 *
 * 三种选择，默认选了最保守的那个：
 * - 全自动批准 → 等于关掉审批门。测出来的数字好看，但不对应任何真实体验。
 * - **全自动拒绝（默认）** → 能回答一个更要紧的问题：策略是不是紧到把
 *   正常工作也挡了。审批次数同时就是「人工干预次数」这个指标。
 * - 显式打开 approve → 用来量审批门的成本：两个数字之差就是它。
 *
 * ## 为什么有起点预检
 *
 * 重构与依赖升级类任务的起点测试本来就是绿的。没有预检的话，agent
 * 什么都不做也能算完成，而这种任务会悄悄混进任务集把完成率抬上去。
 * 预检在 agent 跑之前做 —— 跑之后就分不清「起点就绿」和「agent 修好了」。
 */

export type ApprovalMode = "deny" | "approve";

export interface RunOptions {
	/** perimeter-agent 仓库根，用来定位 config/policy.yaml 与 web/ */
	repoRoot: string;
	/** 仓库快照所在目录 */
	reposRoot: string;
	/** 本次运行的临时根目录（工作区与审计日志都落在这里） */
	runRoot: string;
	piArgs: string[];
	piEnv: NodeJS.ProcessEnv;
	/**
	 * 验收命令的执行环境。不给则按 piEnv 构造 LocalBackend。
	 *
	 * ⚠️ 自己传 LocalBackend 时**必须把 piEnv 传给它的构造函数**：
	 * Session 只在 backend 缺省时才注入 piEnv（`opts.backend ?? new LocalBackend(opts.piEnv)`），
	 * 传了自定义实例就绕过那一步，pi 会因为读不到 models.json 而报
	 * 「Unknown provider」—— 症状离原因很远。
	 */
	backend?: ExecutionBackend;
	approvals?: ApprovalMode;
}

/** 预检不通过。与「任务失败」是两件事，所以用独立的类型区分，不靠字符串匹配 */
class PrecheckError extends Error {}

export interface VerifyResult {
	command: string;
	code: number;
	ok: boolean;
	/** 命令超时。含义与「测试没通过」完全不同，但退出码上分不开，所以单独记 */
	timedOut: boolean;
	/** 失败时的尾部输出，够定位就行 —— 完整输出可能含 agent 写的任意内容 */
	tail?: string;
}

export interface TaskResult {
	id: string;
	type: string;
	/** 全部验收通过才算完成。预检失败时恒为 false，且 counted=false */
	completed: boolean;
	/**
	 * 是否计入完成率。预检失败（任务集自身坏了）与 harness 异常不计入 ——
	 * 把它们算成"任务失败"会让一个打错的目录名表现为模型变差。
	 */
	counted: boolean;
	verify: VerifyResult[];
	/** 审批请求次数 = 人工干预次数。策略文档的指标是 < 2 次/任务 */
	approvals: number;
	/**
	 * 干预次数是否在任务声明的预算内。
	 * 刻意**不**并进 completed —— 「做完了但要人批三次」和「没做完」
	 * 是两种不同的产品问题，混成一个数就没法分别改进
	 */
	withinApprovalBudget: boolean;
	/** 策略直接拒绝的次数 */
	denials: number;
	durationMs: number;
	/** 预检或 harness 层面的问题，不是任务失败 */
	harnessError?: string;
}

/** 把快照复制成干净副本。原地跑的话第一次运行就污染第二次 */
function materialize(task: TaskSpec, opts: RunOptions, sessionId: string): string {
	const workspaceRoot = join(opts.runRoot, "workspaces");
	mkdirSync(workspaceRoot, { recursive: true });
	const ws = join(workspaceRoot, sessionId);
	cpSync(join(opts.reposRoot, task.repo), ws, { recursive: true });
	return ws;
}

export async function runTask(task: TaskSpec, opts: RunOptions): Promise<TaskResult> {
	const started = Date.now();
	const sessionId = task.id;
	const result: TaskResult = {
		id: task.id,
		type: task.type,
		completed: false,
		counted: true,
		verify: [],
		approvals: 0,
		withinApprovalBudget: true,
		denials: 0,
		durationMs: 0,
	};

	const workspace = materialize(task, opts, sessionId);
	const workspaceRoot = join(opts.runRoot, "workspaces");
	// 缺省时自己构造，把 piEnv 一并交给它 —— 见 RunOptions.backend 上的警告
	const backend = opts.backend ?? new LocalBackend(opts.piEnv);
	// 验收命令的上限沿用任务的墙钟上限。硬编码一个更小的值会让慢机器上的
	// 覆盖率任务超时，而超时和「测试没过」在退出码上分不开
	const verifyTimeoutMs = Math.min(task.timeoutMs, 300_000);
	const exec = async (command: string): Promise<VerifyResult> => {
		if (!backend.exec) throw new Error(`执行后端 ${backend.kind} 不支持 exec，无法跑验收命令`);
		const r = await backend.exec(sessionId, workspace, command, verifyTimeoutMs);
		return {
			command,
			code: r.code,
			ok: r.code === 0,
			timedOut: r.code === TIMEOUT_EXIT,
			tail: r.code === 0 ? undefined : `${r.stdout}${r.stderr}`.trim().slice(-600),
		};
	};

	const token = `eval-${task.id}`;
	const gateway = new Gateway({
		port: 0,
		host: "127.0.0.1",
		token,
		policyFile: join(opts.repoRoot, "config/policy.yaml"),
		auditFile: join(opts.runRoot, `audit-${task.id}.jsonl`),
		workspaceRoot,
		webRoot: join(opts.repoRoot, "web"),
		piArgs: opts.piArgs,
		piEnv: opts.piEnv,
		backend,
		approvalTimeoutMs: Math.min(task.timeoutMs, 60_000),
	});

	let ws: WebSocket | undefined;
	try {
		const port = await gateway.listen();
		ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}&session=${sessionId}`);
		const socket = ws;
		const events: ClientEvent[] = [];
		let fatal: string | undefined;

		// 连上之后的 error 也要有人接。只在 open 阶段挂一次性监听的话，
		// 后续任何一次传输错误都会成为未捕获异常，把整个评测进程带走
		socket.on("error", (err) => {
			fatal ??= `websocket: ${(err as Error).message}`;
		});

		socket.on("message", (raw) => {
			const m = JSON.parse(String(raw));
			if (m.type === "control") return;
			const e = m.event as ClientEvent;
			events.push(e);
			if (e.type === "approval.request") {
				result.approvals += 1;
				const decision = (opts.approvals ?? "deny") === "approve" ? "allow" : "deny";
				socket.send(JSON.stringify({ type: "approve", approvalId: e.approvalId, decision }));
			}
			if (e.type === "policy.denied") result.denials += 1;
			// error 是否致命，判据不是 code 而是**agent 起没起来**。
			// 「No API key found」报的就是 command_failed，而那种会话不会再有
			// agent.end —— 按 code 放行的话每个任务都白等满超时。
			// agent.start 之后的 error（某条命令失败）不算致命：agent 会接着跑。
			if (e.type === "error" && !events.some((x) => x.type === "agent.start")) {
				fatal = `${e.code}: ${e.message}`;
			}
		});

		await new Promise<void>((res, rej) => {
			socket.once("open", () => res());
			socket.once("error", rej);
		});

		const waitFor = async (pred: () => boolean, ms: number) => {
			const deadline = Date.now() + ms;
			while (!pred()) {
				if (fatal) throw new Error(fatal);
				if (Date.now() > deadline) throw new Error(`超时 ${ms}ms；收到 ${events.map((e) => e.type).join(",")}`);
				await new Promise((r) => setTimeout(r, 25));
			}
		};

		try {
			await waitFor(() => events.some((e) => e.type === "session.ready"), 60_000);

			// —— 起点预检：failsAtStart 指的命令现在必须是失败的 ——
			// 位置很讲究：必须在 session.ready **之后**（docker/kubectl 后端要等
			// 沙箱真的存在，否则 `docker exec <不存在的容器>` 归一成退出码 1，
			// 预检会把「容器没起来」误读成「起点确实失败」而永远放行），
			// 又必须在发 prompt **之前**（跑完就分不清「起点就绿」和「agent 修好了」）。
			for (const [i, command] of task.verify.entries()) {
				if (!task.failsAtStart.includes(i)) continue;
				const pre = await exec(command);
				if (pre.timedOut) throw new PrecheckError(`预检命令超时：${command}`);
				if (pre.ok) throw new PrecheckError(`起点预检失败：verify[${i}] 在 agent 动手之前就通过了（${command}）`);
			}

			socket.send(JSON.stringify({ type: "prompt", text: task.prompt }));
			// willRetry 必须查：agent.end 带它为 true 时 agent 还会继续，
			// 只认事件名的话会在半道上收尾，把「还没做完」记成「做完了没通过」
			const done = () => events.some((e) => e.type === "agent.end" && !e.willRetry);
			await waitFor(done, task.timeoutMs);
		} catch (err) {
			if (err instanceof PrecheckError) {
				// 任务集自身坏了，不是模型的表现
				result.counted = false;
				result.harnessError = err.message;
				return result;
			}
			// agent 没跑完仍然要跑验收 —— 超时的任务也可能已经改对了文件，
			// 而「超时」本身由 durationMs 体现
			result.harnessError = (err as Error).message;
			// 但 agent 若从未启动，这就不是模型的表现而是环境问题（没配 API key、
			// provider 名字打错）。算进完成率的话，一台没配凭据的机器会让基线
			// 显示「完成率 0%」—— 那个数字会被当成模型变差
			if (!events.some((e) => e.type === "agent.start")) result.counted = false;
		}

		// 验收之前必须让 agent 真的停下。关掉 WebSocket 是不够的 ——
		// 网关那侧的 close 只是把这条传输从广播集合里摘掉，任务照常在服务端跑
		// （那是「关浏览器不受影响」这个产品特性的实现）。不 abort 的话，
		// 超时任务的 verify 会读到 agent 正写到一半的文件：同一份代码跑两次
		// 结果不同，而回归基线的全部价值就是可重复。
		if (events.some((e) => e.type === "agent.start")) {
			socket.send(JSON.stringify({ type: "abort" }));
			// abort 之后 agent 未必立刻收尾，但也不能无限等 —— 等不到就照跑，
			// 并在报告里留痕，让「这次结果可能不稳」看得见
			try {
				await waitFor(() => events.some((e) => e.type === "agent.end" && !e.willRetry), 15_000);
			} catch {
				result.harnessError = `${result.harnessError ? `${result.harnessError}；` : ""}abort 后 agent 未在 15s 内收尾，验收可能读到写了一半的文件`;
			}
		}

		for (const command of task.verify) result.verify.push(await exec(command));
		result.completed = result.verify.every((v) => v.ok);
		// 验收命令超时和「测试没通过」在退出码上分不开，但含义完全不同：
		// 前者是机器慢，记成任务失败会让完成率悄悄掉一档
		if (result.verify.some((v) => v.timedOut)) {
			result.counted = false;
			result.completed = false;
			result.harnessError = `验收命令超时（${verifyTimeoutMs}ms），这不是模型的表现`;
		}
		result.withinApprovalBudget = result.approvals <= task.maxApprovals;
	} catch (err) {
		result.counted = false;
		result.harnessError = `harness 异常：${(err as Error).message}`;
	} finally {
		ws?.close();
		await gateway.close();
		result.durationMs = Date.now() - started;
	}

	return result;
}

export interface SuiteReport {
	at: string;
	/**
	 * 这批数字是谁跑的。**必须记** —— 完成率脱离模型就没有意义，
	 * 而回归基线的用法正是「同一套任务、换个模型/prompt，看差多少」。
	 */
	provider: string;
	/** local / docker / kubectl。local 意味着验收命令在网关宿主机上跑，无隔离 */
	backend: string;
	approvals: ApprovalMode;
	total: number;
	/** 计入完成率的任务数（排除预检失败与 harness 异常） */
	counted: number;
	completed: number;
	/**
	 * completed / counted。counted 为 0 时是 null 而不是 0 ——
	 * 0 会被读成「完成率 0%」，而实际情况是「这批根本没测成」。
	 */
	completionRate: number | null;
	/** 平均人工干预次数。策略文档的指标是 < 2 次/任务 */
	avgApprovals: number | null;
	byType: Record<string, { counted: number; completed: number }>;
	tasks: TaskResult[];
}

export function summarize(
	tasks: TaskResult[],
	meta: { provider: string; backend: string; approvals: ApprovalMode },
): SuiteReport {
	const counted = tasks.filter((t) => t.counted);
	const completed = counted.filter((t) => t.completed);
	const byType: Record<string, { counted: number; completed: number }> = {};
	for (const t of counted) {
		const b = (byType[t.type] ??= { counted: 0, completed: 0 });
		b.counted += 1;
		if (t.completed) b.completed += 1;
	}
	return {
		at: new Date().toISOString(),
		...meta,
		total: tasks.length,
		counted: counted.length,
		completed: completed.length,
		completionRate: counted.length === 0 ? null : completed.length / counted.length,
		avgApprovals: counted.length === 0 ? null : counted.reduce((s, t) => s + t.approvals, 0) / counted.length,
		byType,
		tasks,
	};
}

/** 人读的摘要。`diff 接受率`这个指标要人看 diff，这里给不出，也不假装给 */
export function formatReport(r: SuiteReport): string {
	const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(0)}%`);
	const lines = [
		`Golden task suite · ${r.at}`,
		`模型 ${r.provider} · 后端 ${r.backend} · 审批 ${r.approvals === "deny" ? "自动拒绝" : "自动批准"}`,
		"",
	];
	for (const t of r.tasks) {
		const mark = !t.counted ? "—" : t.completed ? "✓" : "✗";
		const budget = t.counted && !t.withinApprovalBudget ? " ⚠超预算" : "";
		lines.push(`${mark} ${t.id} [${t.type}] ${(t.durationMs / 1000).toFixed(1)}s 审批 ${t.approvals}${budget} 拒绝 ${t.denials}`);
		// 只取首行：pi 的错误常带多行文档链接，四个任务复述一遍就把报告淹了
		if (t.harnessError) lines.push(`    ⚠ ${t.harnessError.split("\n")[0]}`);
		for (const v of t.verify.filter((v) => !v.ok)) lines.push(`    ✗ ${v.command} → ${v.code}`);
	}
	lines.push(
		"",
		`完成率 ${pct(r.completionRate)}（${r.completed}/${r.counted}，门槛 >50%）· 平均干预 ${
			r.avgApprovals === null ? "—" : r.avgApprovals.toFixed(1)
		}（门槛 <2）`,
	);
	if (r.counted < r.total) lines.push(`${r.total - r.counted} 个任务未计入（预检失败或 harness 异常，见上方 ⚠）`);
	if (r.backend === "local") lines.push("⚠ local 后端：验收命令在网关宿主机上跑，没有隔离。这批数字不代表生产形态");
	return lines.join("\n");
}
