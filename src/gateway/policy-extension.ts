import { readFileSync } from "node:fs";
import { PolicyEngine } from "../policy/engine.ts";
import { toActionDescriptor } from "../protocol/translate.ts";

/** 网关据此把判决上报从普通通知里分离出来 */
export const AUDIT_PREFIX = "@@perimeter-audit@@";

/** 审批选项。两侧共用同一份常量：各写一份的话，值对不上时表现为「点了批准也被拒」 */
export const APPROVE = "批准";
export const REJECT = "拒绝";

/**
 * 注入 pi 的 `tool_call` 钩子，把策略引擎接到工具执行之前。
 *
 * 这解决的是路线 C（RPC 网关）的一个结构性问题：网关只能在事件流上
 * 「看到」tool_execution_start，看不到也拦不住执行本身，粒度只有「中」。
 * 而 Phase 1 的验收标准要求「100% 工具调用有记录、0 例绕过审批门」。
 * 扩展跑在 pi 进程内，`tool_call` 钩子在工具执行前触发且**可以 block**，
 * 于是不必等到 Phase 2 迁路线 A，现在就能拿到钩子级粒度。
 *
 * 与网关的两条通道都走 pi 现成的扩展 UI 子协议，不额外开端口：
 * - 审批：ctx.ui.select() → stdout 的 extension_ui_request → 网关 → 浏览器，
 *   人工决定后原路回到这里。带 timeout，超时按拒绝处理。
 * - 留痕：ctx.ui.notify()（fire-and-forget）把判决送回网关，由网关写审计。
 *   审计日志刻意只有网关一个写入者 —— 两个写入者会把哈希链写成分叉。
 *
 * **钩子存活握手**：会话开始时立刻发一条 hook-armed。没有它的话，
 * pi 若改了事件名，注册会静默失败（实测 pi 0.84.2：对未知事件名不报错、
 * 不发 extension_error，工具照常执行）—— 生产环境会变成静默全量放行，
 * 而「0 例绕过审批门」这条验收就只剩测试套件在保证、运行时没有证据。
 * 网关在收到握手之前拒绝下发任何 prompt。
 *
 * 配置经环境变量传入，因为扩展由 pi 加载，不经过我们的构造函数。
 */
export default function policyExtension(pi: {
	on: (event: string, handler: (event: ToolCallEvent, ctx: ExtensionCtx) => Promise<BlockResult | undefined>) => void;
}): void {
	const policyPath = process.env.PERIMETER_POLICY_FILE;
	const ctx = {
		repo: process.env.PERIMETER_REPO ?? "unknown",
		team: process.env.PERIMETER_TEAM ?? "unknown",
	};
	const approvalTimeoutMs = Number(process.env.PERIMETER_APPROVAL_TIMEOUT_MS ?? 120_000);

	// 策略加载失败时不静默放行：没有策略就没有边界，这种状态不该能跑起来
	if (!policyPath) throw new Error("policy-extension: 缺少 PERIMETER_POLICY_FILE");
	const engine = PolicyEngine.fromYaml(readFileSync(policyPath, "utf8"));

	pi.on("tool_call", async (event, ui) => {
		const action = toActionDescriptor(event.toolName, event.input);
		const verdict = engine.evaluate(action, ctx);
		// 下发给网关的动作描述不带原始参数：write/edit 的参数含整份文件内容
		const view = { tool: action.tool, path: action.path, command: action.command };

		if (verdict.decision === "allow") {
			report(ui, { kind: "allow", action: view, callId: event.toolCallId });
			return undefined;
		}

		if (verdict.decision === "deny") {
			report(ui, { kind: "deny", action: view, callId: event.toolCallId, rule: verdict.rule, reason: verdict.reason });
			return { block: true, reason: `策略拒绝（${verdict.rule}）：${verdict.reason}` };
		}

		// 这条通知必然紧邻在 select 之前（同一进程、同一 stdout、await 之前的同步调用），
		// 网关据此把 callId 与随后那个对话框的 UI id 绑定起来 —— 不靠「同时只有一个
		// 挂起审批」这种外部不变量去反推。
		report(ui, {
			kind: "approval.request",
			action: view,
			callId: event.toolCallId,
			rule: verdict.rule,
			reason: verdict.reason,
		});
		const choice = await ui.ui.select(describe(view, verdict.reason), [APPROVE, REJECT], { timeout: approvalTimeoutMs });
		// 超时返回 undefined，取消也返回 undefined —— 两者都按拒绝处理。
		// 默认拒绝是审批门的基本要求：无人应答不等于同意。
		const approved = choice === APPROVE;
		report(ui, {
			kind: "approval.decision",
			action: view,
			callId: event.toolCallId,
			rule: verdict.rule,
			approved,
			timedOut: choice === undefined,
		});
		return approved ? undefined : { block: true, reason: `未获批准（${verdict.rule}）` };
	});

	// 会话一开始就宣告钩子已挂，网关据此放行第一条 prompt
	pi.on("session_start", async (_e, ui) => {
		report(ui, { kind: "hook-armed", rules: engine.ruleCount });
		return undefined;
	});
}

/**
 * 审批对话框的标题。必须带上工具与具体目标 ——
 * 只给规则模式的话，`git push --force origin main` 与
 * `git push origin feature` 在审批人眼里长得一模一样，
 * 而看不清就批正是审批疲劳的成因。
 */
function describe(view: { tool: string; path?: string; command?: string }, reason: string): string {
	const target = view.command ?? view.path ?? "";
	return target ? `${view.tool}: ${target}（${reason}）` : `${view.tool}（${reason}）`;
}

/** 判决经 notify 送回网关；网关是审计日志的唯一写入者 */
function report(ui: ExtensionCtx, payload: Record<string, unknown>): void {
	try {
		ui.ui.notify(`${AUDIT_PREFIX}${JSON.stringify(payload)}`, "info");
	} catch {
		// 钩子契约：不许 throw。留痕失败不应连带阻断工具执行 ——
		// 网关侧另有 tool_execution_start 事件兜底，不会出现完全无记录的调用。
	}
}

interface ToolCallEvent {
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
}

interface BlockResult {
	block: true;
	reason?: string;
	terminate?: boolean;
}

interface ExtensionCtx {
	ui: {
		select: (title: string, options: string[], opts?: { timeout?: number }) => Promise<string | undefined>;
		notify: (message: string, level: string) => void;
	};
}
