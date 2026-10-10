import { defineExtension, hook, section, ToolTask, GenerationTask, type ToolHooks, type HookApi } from "@earendil-works/pi-durable";
import type { AuditInput } from "../audit/log.ts";
import { contentHash } from "../audit/log.ts";
import type { PolicyEngine } from "../policy/engine.ts";
import type { ClientEvent } from "../protocol/types.ts";
import { toActionDescriptor } from "../protocol/translate.ts";
import type { Approvals } from "./approvals.ts";

export interface PerimeterOptions {
	repo: string;
	team: string;
	policy: PolicyEngine;
	actor: (api: HookApi) => Promise<string>;
	approvals: () => Approvals;
	approvalTimeoutMs: number;
	audit: (input: Omit<AuditInput, "sessionId" | "repo" | "team">) => void;
	emit: (event: ClientEvent) => void;
}

export function perimeterExtension(opts: PerimeterOptions) {
	const beforeTool: ToolHooks["beforeTool"] = async (call, _api, ctx) => {
		const action = toActionDescriptor(call.name, call.arguments);
		const actor = await opts.actor(_api);
		opts.audit({ kind: "tool.call", actor, callId: call.id, tool: action.tool, path: action.path, command: action.command,
			summary: `工具调用 ${action.tool}`, argsHash: contentHash(call.arguments) });
		const verdict = opts.policy.evaluate(action, { repo: opts.repo, team: opts.team });
		opts.audit({ kind: "policy.verdict", actor, callId: call.id, summary: `策略 ${verdict.decision} ${action.path ?? action.command ?? action.tool}`, verdict: verdict.decision,
			...(verdict.decision === "allow" ? {} : { rule: verdict.rule }) });
		if (verdict.decision === "allow") return undefined;
		if (verdict.decision === "deny") {
			opts.emit({ type: "policy.denied", callId: call.id, action: { tool: action.tool, path: action.path, command: action.command }, rule: verdict.rule, reason: verdict.reason });
			return { block: `策略拒绝（${verdict.rule}）：${verdict.reason}` };
		}
		opts.audit({ kind: "approval.request", actor, callId: call.id, rule: verdict.rule, summary: `审批 ${action.tool}` });
		const approved = await opts.approvals().request(call.id, action, verdict.rule, verdict.reason, actor, opts.approvalTimeoutMs, ctx.abortSignal ?? new AbortController().signal);
		return approved ? undefined : { block: `未获批准（${verdict.rule}）` };
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
