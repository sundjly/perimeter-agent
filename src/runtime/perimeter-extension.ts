import { defineExtension, hook, section, ToolTask, GenerationTask, type ToolHooks, type HookApi } from "@earendil-works/pi-durable";
import type { AuditInput } from "../audit/log.ts";
import { contentHash } from "../audit/log.ts";
import type { PolicyEngine } from "../policy/engine.ts";
import type { ClientEvent } from "../protocol/types.ts";
import { toActionDescriptor } from "../protocol/translate.ts";
import type { Approvals, ApprovalContext } from "./approvals.ts";
import { isContextReliable } from "./approvals.ts";
import { GUARD_CATEGORY_WHITELIST, type ResolvedGuardPath } from "./path-guard.ts";

export interface PerimeterOptions {
	repo: string;
	team: string;
	policy: PolicyEngine;
	actor: (api: HookApi) => Promise<string>;
	actorPrincipal?: (api: HookApi) => Promise<string | undefined>;
	approvals: () => Approvals;
	approvalTimeoutMs: number;
	audit: (input: Omit<AuditInput, "sessionId" | "repo" | "team">) => void;
	emit: (event: ClientEvent) => void;
	getContext?: () => Promise<ApprovalContext> | ApprovalContext;
	isProduction?: boolean;
	/** S3c：审计通道健康探针（AuditLog.healthy）。假 → 工具执行面 fail-closed（含恢复路径与审批后执行），
	 * 仍允许 abort/deny/清理；不再尝试写审计（写不了），仅保客户端可见事件与模型可见 block（固定类别） */
	auditHealthy?: () => boolean;
	/** 方案B：一次受控 exec helper 在同一 ExecutionEnv 内完成 canonical 目标+同 namespace 根解析
	 *（harness-host 注入；失败/不可用必须 reject，调用方 fail-closed）。第二参数已合并工具取消与守卫 deadline，
	 * resolver 内 await exec 真实收尾（杀 helper 进程组），无早返回。 */
	resolveGuardPath?: (rawPath: string, signal?: AbortSignal) => Promise<ResolvedGuardPath>;
	/** 单次路径守卫（=一次 helper 阶段）的总预算（默认 3s）；审批人工等待不计入，获批后复检是新一次阶段 */
	guardTimeoutMs?: number;
}

export function perimeterExtension(opts: PerimeterOptions) {
	// 方案B 路径守卫：canonical 解析失败/NUL/越界一律 fail-closed；诊断只含错误类别，不携带宿主路径与文件内容。
	// 守卫自带有限 deadline 并派生工具取消信号：deadline/abort → exec 杀 helper 进程组，await 真实收尾后 fail-closed deny。
	const guardTimeoutMs = opts.guardTimeoutMs ?? 3_000;
	// 错误类别白名单（R3 补丁，定义移至 path-guard.ts、内容不变）：拒绝原因/审计只允许这些固定 token，
	// 其余一律 unknown——不返回 Error.message 余文/宿主路径/内容。
	const GUARD_CATEGORY_WHITELIST_SET = new Set(GUARD_CATEGORY_WHITELIST);
	const errCategory = (e: unknown, toolSignal?: AbortSignal, controller?: AbortController): string => {
		if (toolSignal?.aborted) return "aborted"; // 状态优先：工具取消
		if (controller?.signal.aborted) return "deadline"; // 状态优先：守卫 deadline
		const code = (e as { code?: string })?.code;
		return typeof code === "string" && GUARD_CATEGORY_WHITELIST_SET.has(code) ? code : "unknown";
	};
	const guardPath = async (rawPath: string, toolSignal: AbortSignal | undefined): Promise<{ ok: true; canonical: string; stats: ResolvedGuardPath["stats"] } | { ok: false; reason: string; rule: string }> => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), guardTimeoutMs); // deadline 由控制器状态分类，不依赖 Error 文案
		const onToolAbort = () => controller.abort();
		toolSignal?.addEventListener("abort", onToolAbort, { once: true });
		if (toolSignal?.aborted) { clearTimeout(timer); toolSignal.removeEventListener("abort", onToolAbort); return { ok: false, reason: "路径规范化失败（fail-closed，类别=aborted）", rule: "canonical-path-guard" }; }
		try {
			if (rawPath.includes("\0")) return { ok: false, reason: "路径包含非法字符（NUL）", rule: "canonical-path-guard" };
			// 一次受控 exec helper 同时解析 canonical 目标与同 namespace 根：resolver 内 await exec 最终结果，
			// 无 awaitWithContext 早返回。收尾边界：Local 返回时 helper 已真实退出；Remote 返回时组杀已由
			// daemon 发起但客户端不 await 死亡确认（pending/unknown）——deny 均已 fail-closed。
			const resolved = await opts.resolveGuardPath!(rawPath, controller.signal);
			const { canonical, root, stats } = resolved;
			if (canonical !== root && !canonical.startsWith(root + "/")) return { ok: false, reason: "路径越界：canonical 目标逃出 workspace", rule: "canonical-path-guard" };
			// B1 硬链接保守拒：常规文件 nlink>1 说明存在另一个链接，但 inode 无法反查出它的路径——
			// 不能假称“知道别名位置”而放行；也不能只拒“命中 deny 清单”的别名（别名可以是无辜名字）。
			// 保守策略：多链接常规文件一律拒（目录 nlink>1 正常，不受影响；新建文件 stats=null 不受影响）。
			// 这只是进程内纵深，不是 OS 边界（check-then-use 竞态仍在，容器只读挂载才是部署面真边界）。
			if (stats && !stats.dir && stats.nlink > 1) {
				return { ok: false, reason: `目标为多硬链接常规文件（nlink=${stats.nlink}），无法确证另一链接位置，保守拒绝`, rule: "protected-hardlink" };
			}
			return { ok: true, canonical, stats };
		} catch (e) {
			return { ok: false, reason: `路径规范化失败（fail-closed，类别=${errCategory(e, toolSignal, controller)}）`, rule: "canonical-path-guard" };
		} finally {
			clearTimeout(timer);
			toolSignal?.removeEventListener("abort", onToolAbort);
		}
	};
	const denyBlock = (call: { id: string }, actor: string, action: { tool: string; path?: string; command?: string }, rule: string, reason: string) => {
		opts.audit({ kind: "policy.verdict", actor, callId: call.id, summary: `路径守卫拒绝（${(action.path ?? action.command ?? action.tool).slice(0, 80)}）`, verdict: "deny", rule });
		opts.emit({ type: "policy.denied", callId: call.id, action: { tool: action.tool, path: action.path, command: action.command }, rule, reason });
		return { block: `策略阻断（${rule}）：${reason}` } as const;
	};
	const beforeTool: ToolHooks["beforeTool"] = async (call, _api, ctx) => {
		const action = toActionDescriptor(call.name, call.arguments);
		// S3c：审计不可用 → 执行 fail-closed。先于一切审计写入与策略判定；固定类别，
		// 不透传底层错误。恢复路径（重启后续跑）与审批后执行由下方第二道门同样拦截。
		if (opts.auditHealthy && !opts.auditHealthy()) {
			opts.emit({ type: "policy.denied", callId: call.id, action: { tool: action.tool, path: action.path, command: action.command }, rule: "audit-unavailable", reason: "审计写入不可用，fail-closed 拒绝工具执行（固定类别）" });
			return { block: "策略阻断（audit-unavailable）：审计写入不可用，fail-closed" };
		}
		const actor = await opts.actor(_api);
		opts.audit({ kind: "tool.call", actor, callId: call.id, tool: action.tool, path: action.path, command: action.command,
			summary: `工具调用 ${action.tool}`, argsHash: contentHash(call.arguments) });
		const verdict = opts.policy.evaluate(action, { repo: opts.repo, team: opts.team });

		// B1 deny_reads：只读工具在策略配置了 deny_reads 时，与写类工具走同一受控 helper canonical 化
		//（同 resolver、同 fail-closed 语义）；无配置时保持原「只读豁免」行为，不增加无谓 exec。
		const isWriteTool = action.path !== undefined && !opts.policy.isReadOnly(action.tool);
		const readGuardActive = action.path !== undefined && opts.policy.isReadOnly(action.tool) && opts.policy.denyReadsEnabled;
		const needsGuard = (isWriteTool || readGuardActive) && opts.resolveGuardPath !== undefined;

		// 方案B 路径守卫：带 path 且非只读的工具，经与工具同一 ExecutionEnv 的受控 helper 复判。
		// 能力缺失不静默跳过：生产模式 fail-closed 拒绝；demo 明确留审计痕迹后按词法策略继续。
		let effective = verdict;
		let canonicalTarget: string | undefined;
		if ((isWriteTool || readGuardActive) && !opts.resolveGuardPath) {
			if (opts.isProduction === true) {
				return denyBlock(call, actor, action, "canonical-path-guard", "生产模式缺少 canonical 路径解析能力，fail-closed 拒绝路径类工具");
			}
			opts.audit({ kind: "policy.verdict", actor, callId: call.id, summary: "路径守卫未启用（缺少 canonical 能力，demo 语义：仅词法策略）", verdict: verdict.decision === "allow" ? "allow" : verdict.decision, ...(verdict.decision === "allow" ? {} : { rule: verdict.rule }) });
		}
		if (needsGuard) {
			const guard = await guardPath(action.path!, ctx.abortSignal);
			if (!guard.ok) return denyBlock(call, actor, action, guard.rule, guard.reason);
			canonicalTarget = guard.canonical;
			const canonicalVerdict = opts.policy.evaluate({ ...action, path: guard.canonical }, { repo: opts.repo, team: opts.team });
			const rank = { allow: 0, require_approval: 1, deny: 2 } as const;
			effective = rank[canonicalVerdict.decision] > rank[verdict.decision] ? canonicalVerdict : verdict;
			if (effective !== verdict) {
				opts.audit({ kind: "policy.verdict", actor, callId: call.id, summary: `canonical 路径复判 ${effective.decision}`, verdict: effective.decision, ...(effective.decision === "allow" ? {} : { rule: effective.rule }) });
			}
		}

		opts.audit({ kind: "policy.verdict", actor, callId: call.id, summary: `策略 ${effective.decision} ${action.path ?? action.command ?? action.tool}`, verdict: effective.decision,
			...(effective.decision === "allow" ? {} : { rule: effective.rule }) });
		if (effective.decision === "allow") return undefined;
		if (effective.decision === "deny") {
			opts.emit({ type: "policy.denied", callId: call.id, action: { tool: action.tool, path: action.path, command: action.command }, rule: effective.rule, reason: effective.reason });
			return { block: `策略拒绝（${effective.rule}）：${effective.reason}` };
		}

		// 生产环境 fail-closed：上下文不可靠拒不发起待审批请求
		const context = await opts.getContext?.();
		const isProd = opts.isProduction ?? context?.isProduction ?? false;
		if (isProd && !isContextReliable(context, true)) {
			const reason = "审批上下文不可靠：生产环境高风险操作必须绑定有效 Git 仓库版本与仓库标识";
			opts.audit({ kind: "approval.request", actor, callId: call.id, rule: effective.rule, summary: `审批被拒（上下文不可靠）`, argsHash: contentHash(call.arguments) });
			opts.emit({ type: "policy.denied", callId: call.id, action: { tool: action.tool, path: action.path, command: action.command }, rule: effective.rule, reason });
			return { block: `策略阻断（${effective.rule}）：${reason}` };
		}

		const argsHash = contentHash(call.arguments);
		opts.audit({ kind: "approval.request", actor, callId: call.id, rule: effective.rule, summary: `审批 ${action.tool}`, argsHash });
		const principal = await opts.actorPrincipal?.(_api);
		const approved = await opts.approvals().request(
			call.id, action, effective.rule, effective.reason, actor,
			opts.approvalTimeoutMs, ctx.abortSignal ?? new AbortController().signal,
			context, principal, isProd
		);
		if (!approved) return { block: `未获批准（${effective.rule}）` };
		const verified = await opts.approvals().verifyApproved(call.id, action, await opts.getContext?.(), isProd);
		if (!verified.ok) return { block: `审批失效（${effective.rule}）：${verified.reason}` };
		// 方案B 漂移复检：获批后目标以新一次受控 helper 阶段复检（原 args/审批四眼绑定不变），
		// 防等待期 symlink/目标漂移复用。不声称消除检查-使用间全部竞态：仅覆盖本次等待窗口内的目标漂移。
		if (canonicalTarget !== undefined) {
			const recheck = await guardPath(action.path!, ctx.abortSignal);
			if (!recheck.ok || recheck.canonical !== canonicalTarget) {
				const reason = recheck.ok ? "审批等待期路径目标漂移（canonical 不一致）" : `审批等待期路径守卫失败：${recheck.reason}`;
				return denyBlock(call, actor, action, "canonical-path-guard", reason);
			}
		}
		// S3c：审批等待期内审计可能转为不可用 —— 放行执行前最后一道 fail-closed 门
		//（「审批后的执行」同样不得在无审计下发生；abort/deny/清理不经过此钩子，不受影响）。
		if (opts.auditHealthy && !opts.auditHealthy()) {
			opts.emit({ type: "policy.denied", callId: call.id, action: { tool: action.tool, path: action.path, command: action.command }, rule: "audit-unavailable", reason: "审批后审计写入不可用，fail-closed 拒绝执行（固定类别）" });
			return { block: "策略阻断（audit-unavailable）：审批后审计不可用，fail-closed" };
		}
		return undefined;
	};
	return defineExtension({
		name: "perimeter",
		sections: [section("perimeter", () => `你是代码助手。每次工具调用必须经过策略。repo=${opts.repo}\nteam=${opts.team}`)],
		hooks: [hook(ToolTask, { beforeTool, afterTool: async (call, result, api) => {
			opts.audit({ kind: "tool.result", actor: await opts.actor(api), callId: call.id, tool: call.name, ok: !result.isError, summary: `工具结果 ${call.name}` });
			return undefined;
		} }), hook(GenerationTask, { afterResponse: async (message, api) => {
			// 参数校验先于 beforeTool，模型工具意图也要过策略并留下 hash。
			for (const call of message.content) if (call.type === "toolCall") {
				const action = toActionDescriptor(call.name, call.arguments);
				const verdict = opts.policy.evaluate(action, { repo: opts.repo, team: opts.team });
				opts.audit({ kind: "policy.verdict", actor: await opts.actor(api), callId: call.id, tool: action.tool, path: action.path, command: action.command,
					summary: `工具意图预检 ${action.tool}`, verdict: verdict.decision, argsHash: contentHash(call.arguments), ...(verdict.decision === "allow" ? {} : { rule: verdict.rule }) });
			}
		} })],
	});
}
