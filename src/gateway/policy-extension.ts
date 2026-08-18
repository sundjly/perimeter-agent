import { readFileSync } from "node:fs";
import { PolicyEngine } from "../policy/engine.ts";
import { toActionDescriptor } from "../protocol/translate.ts";

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

		if (verdict.decision === "allow") {
			report(ui, { kind: "allow", action, callId: event.toolCallId });
			return undefined;
		}

		if (verdict.decision === "deny") {
			report(ui, { kind: "deny", action, callId: event.toolCallId, rule: verdict.rule, reason: verdict.reason });
			return { block: true, reason: `策略拒绝（${verdict.rule}）：${verdict.reason}` };
		}

		report(ui, { kind: "approval.request", action, callId: event.toolCallId, rule: verdict.rule, reason: verdict.reason });
		const choice = await ui.ui.select(`需要审批：${verdict.reason}`, [APPROVE, REJECT], { timeout: approvalTimeoutMs });
		// 超时返回 undefined，取消也返回 undefined —— 两者都按拒绝处理。
		// 默认拒绝是审批门的基本要求：无人应答不等于同意。
		const approved = choice === APPROVE;
		report(ui, {
			kind: "approval.decision",
			action,
			callId: event.toolCallId,
			rule: verdict.rule,
			approved,
			timedOut: choice === undefined,
		});
		return approved ? undefined : { block: true, reason: `未获批准（${verdict.rule}）` };
	});
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

/** 网关据此把判决上报从普通通知里分离出来 */
export const AUDIT_PREFIX = "@@perimeter-audit@@";

const APPROVE = "批准";
const REJECT = "拒绝";

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
