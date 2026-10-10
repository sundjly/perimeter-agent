import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, type Conversation, type AgentEventStream, watchEvents } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { AuditLog } from "../audit/log.ts";
import type { ClientEvent } from "../protocol/types.ts";
import { PolicyEngine } from "../policy/engine.ts";
import { Approvals } from "./approvals.ts";
import { gatewayModels, type ModelGateway } from "./models.ts";
import { perimeterExtension } from "./perimeter-extension.ts";

export interface HostOptions {
	sessionId: string;
	file: string;
	workspace: string;
	repo: string;
	team: string;
	actor: string;
	policyFile: string;
	audit: AuditLog;
	model: ModelGateway;
	env?: ExecutionEnv;
	approvalTimeoutMs?: number;
	emit: (event: ClientEvent) => void;
}

export class HarnessHost {
	readonly harness: Harness;
	readonly root: Conversation;
	readonly approvals: Approvals;
	#opts: HostOptions;
	#actor: string;
	private constructor(harness: Harness, root: Conversation, approvals: Approvals, opts: HostOptions, actor: { value: string }) {
		this.harness = harness;
		this.root = root;
		this.approvals = approvals;
		this.#opts = opts;
		this.#actor = actor.value;
	}

	static async open(opts: HostOptions): Promise<HarnessHost> {
		mkdirSync(dirname(opts.file), { recursive: true });
		mkdirSync(opts.workspace, { recursive: true });
		const registry = createRegistry();
		registry.install(CodingTools);
		let approvals: Approvals;
		const actor = { value: opts.actor };
		registry.install(perimeterExtension({
			repo: opts.repo, team: opts.team, actor: () => actor.value,
			policy: PolicyEngine.fromYaml(readFileSync(opts.policyFile, "utf8")),
			approvals: () => approvals, approvalTimeoutMs: opts.approvalTimeoutMs ?? 120_000, emit: opts.emit,
			audit: (input) => {
				const entry = opts.audit.append({ ...input, sessionId: opts.sessionId, repo: opts.repo, team: opts.team });
				opts.emit({ type: "audit.entry", entry: { seq: entry.seq, at: entry.at, kind: entry.kind, summary: entry.summary, verdict: entry.verdict } });
			},
		}));
		const storage = await openNodeSqliteStorage(opts.file);
		let harness: Harness | undefined;
		try {
			harness = await Harness.open(storage, {
				models: gatewayModels(opts.model), registry,
				env: () => opts.env ?? new NodeExecutionEnv({ cwd: opts.workspace, shellEnv: { PATH: process.env.PATH } }),
				settings: { toolExecution: "sequential", compaction: { backgroundTokens: 32768 } },
			}, BACKGROUND_CONTEXT);
			const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "perimeter", modelId: opts.model.model }, cwd: opts.workspace } });
			approvals = new Approvals(root, opts.emit, (item) => {
				opts.audit.append({ kind: "approval.decision", sessionId: opts.sessionId, actor: item.actor, approver: item.approver, callId: item.callId, rule: item.rule, verdict: item.status === "allow" ? "allow" : "deny", summary: `审批 ${item.status}` });
			});
			await approvals.expirePending();
			const host = new HarnessHost(harness, root, approvals, opts, actor);
			await host.assertGuard();
			harness.resume();
			return host;
		} catch (error) {
			if (harness) await harness.close(BACKGROUND_CONTEXT);
			else await storage.close(BACKGROUND_CONTEXT);
			throw error;
		}
	}

	async assertGuard(): Promise<void> {
		const agent = await this.root.agent(BACKGROUND_CONTEXT);
		if (!agent.extensions.some((extension) => extension.name === "perimeter" && extension.hooks?.some((hook) => hook.task === "pi.tool" && typeof (hook.handlers as Partial<{ beforeTool: unknown }>).beforeTool === "function"))) {
			throw new Error("策略扩展未选中，拒绝运行");
		}
	}

	async submit(text: string, requestId: string, whenBusy: "followUp" | "steer" = "followUp", actor = this.#actor) {
		await this.assertGuard();
		this.#opts.audit.append({ kind: "prompt", sessionId: this.#opts.sessionId, actor, summary: `prompt（${text.length} 字符）` });
		return this.root.submit({ type: "input", content: text, requestId, whenBusy }, BACKGROUND_CONTEXT);
	}

	watch(): Promise<AgentEventStream> { return watchEvents(this.harness, this.root.id, BACKGROUND_CONTEXT); }
	abort(): Promise<void> { return this.root.abort(BACKGROUND_CONTEXT); }
	close(): Promise<void> { return this.harness.close(BACKGROUND_CONTEXT); }
}
