import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, LiveDoc, createRegistry, type Conversation, type HarnessSettings, type Storage, type SnapshotEvent, watchEvents } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { localEnvironment } from "./execution-env.ts";
import { createPathGuardResolver } from "./path-guard.ts";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { AuditLog } from "../audit/log.ts";
import { contentHash } from "../audit/log.ts";
import type { ClientEvent } from "../protocol/types.ts";
import { PolicyEngine } from "../policy/engine.ts";
import { snapshotView, newTranslateState, toClientEvent } from "../protocol/translate.ts";
import { AuthorsDoc } from "./authors.ts";
import { Approvals, ApprovalsDoc, type ApprovalContext } from "./approvals.ts";
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
	getContext?: () => Promise<ApprovalContext> | ApprovalContext;
	getPrincipal?: (actor: string) => string | undefined;
	isProduction?: boolean;
	/** 路径守卫单阶段（一次受控 exec helper）的总预算；审批人工等待不计入，获批后复检是新一次阶段 */
	guardTimeoutMs?: number;
	/** 远端会话的守卫专用 pinned env（同一 Connection/sessionPin；openEnvironment 提供，缺省=本地走 localEnvironment） */
	guardEnv?: ExecutionEnv;
}

export const RUNTIME_SETTINGS: HarnessSettings = { toolExecution: "sequential", compaction: { backgroundTokens: 32768 } };

/**
 * 路径守卫的单阶段总预算（一次受控 exec helper，覆盖 helper 启动与全部解析，不按层拆分）。
 * 方案B：Slice A 的不可取消 canonicalPath RPC + awaitWithContext 早返回包装已整体移除——
 * 守卫改走同一 ExecutionEnv.exec 的受控 helper，deadline/abort 真实杀 helper 进程组并 await 真实收尾。
 * 边界（如实）：远端 exec 取消=daemon 内杀进程组（协议保证，本地容器已验证）；
 * Pod 场景真实集群 kill/close 未验证，保持 unknown；主动 setsid 逃逸出组的后代不在覆盖范围。
 */
const DEFAULT_GUARD_TIMEOUT_MS = 3_000;

export interface RuntimeStream {
	snapshot: Awaited<ReturnType<HarnessHost["view"]>>;
	start(listener: (events: ClientEvent[]) => Promise<void>): void;
	stop(): Promise<unknown>;
}

export class HarnessHost {
	readonly harness: Harness;
	readonly root: Conversation;
	readonly approvals: Approvals;
	#opts: HostOptions;
	#actor: string;
	#storage: Storage;
	private constructor(harness: Harness, root: Conversation, approvals: Approvals, opts: HostOptions, actor: { value: string }, storage: Storage) {
		this.harness = harness;
		this.root = root;
		this.approvals = approvals;
		this.#opts = opts;
		this.#actor = actor.value;
		this.#storage = storage;
	}

	static async open(opts: HostOptions): Promise<HarnessHost> {
		mkdirSync(dirname(opts.file), { recursive: true });
		mkdirSync(opts.workspace, { recursive: true });
		const registry = createRegistry();
		registry.install(CodingTools);
		let approvals: Approvals;
		let harness: Harness | undefined;
		const actor = { value: opts.actor };
		const envFactory = () => opts.env ?? localEnvironment(opts.workspace);
		// 守卫专用 pinned env（远端）；捕获为局部常量以便类型收窄。绝不回退到 unpinned 远端 env。
		const guardEnv = opts.guardEnv;
		const guardEnvFactory = guardEnv ? () => guardEnv : envFactory;
		registry.install(perimeterExtension({
			repo: opts.repo, team: opts.team, actor: async (api) => {
				const live = await api.snapshot(LiveDoc, api.conversationId, BACKGROUND_CONTEXT);
				const input = live?.run?.inputs.at(-1);
				const record = input ? await (await harness?.submission(input, BACKGROUND_CONTEXT))?.status(BACKGROUND_CONTEXT) : undefined;
				const authors = await api.snapshot(AuthorsDoc, api.conversationId, BACKGROUND_CONTEXT);
				return record?.requestId ? authors?.requests[record.requestId] ?? opts.actor : opts.actor;
			},
			actorPrincipal: async (api) => {
				const live = await api.snapshot(LiveDoc, api.conversationId, BACKGROUND_CONTEXT);
				const input = live?.run?.inputs.at(-1);
				const record = input ? await (await harness?.submission(input, BACKGROUND_CONTEXT))?.status(BACKGROUND_CONTEXT) : undefined;
				const authors = await api.snapshot(AuthorsDoc, api.conversationId, BACKGROUND_CONTEXT);
				const act = record?.requestId ? authors?.requests[record.requestId] ?? opts.actor : opts.actor;
				return opts.getPrincipal?.(act) ?? act;
			},
			getContext: opts.getContext,
			isProduction: opts.isProduction,
			// S3c：审计健康探针 → 执行面 fail-closed（含重启恢复后的续跑与审批后执行）
			auditHealthy: () => opts.audit.healthy,
			// 守卫解析器绑定 pinned guardEnv（远端）；本地沿用 envFactory。绝不回退到 unpinned 远端 env。
			resolveGuardPath: createPathGuardResolver(guardEnvFactory, opts.guardTimeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS),
			guardTimeoutMs: opts.guardTimeoutMs,
			policy: PolicyEngine.fromYaml(readFileSync(opts.policyFile, "utf8")),
			approvals: () => approvals, approvalTimeoutMs: opts.approvalTimeoutMs ?? 120_000, emit: opts.emit,
			audit: (input) => {
				const entry = opts.audit.append({ ...input, sessionId: opts.sessionId, repo: opts.repo, team: opts.team });
				opts.emit({ type: "audit.entry", entry: {
					seq: entry.seq, at: entry.at, kind: entry.kind, summary: entry.summary,
					verdict: entry.verdict, actor: entry.actor, approver: entry.approver,
				} });
			},
		}));
		const storage = await openNodeSqliteStorage(opts.file);
		try {
			harness = await Harness.open(storage, {
				models: gatewayModels(opts.model), registry,
				env: envFactory,
				settings: { ...RUNTIME_SETTINGS, stream: { headers: { "x-perimeter-team": opts.team, "x-perimeter-session": opts.sessionId } } },
			}, BACKGROUND_CONTEXT);
			const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "perimeter", modelId: opts.model.model }, cwd: opts.workspace } });
			const agent = await root.agent(BACKGROUND_CONTEXT);
			if (agent.model?.modelId !== opts.model.model) await root.configure({ model: { provider: "perimeter", modelId: opts.model.model } }, BACKGROUND_CONTEXT);
			approvals = new Approvals(root, opts.emit, (item) => {
				const entry = opts.audit.append({
					kind: "approval.decision", sessionId: opts.sessionId, actor: item.actor, approver: item.approver,
					callId: item.callId, rule: item.rule, verdict: item.status === "allow" ? "allow" : "deny", summary: `审批 ${item.status}`,
				});
				opts.emit({ type: "audit.entry", entry: {
					seq: entry.seq, at: entry.at, kind: entry.kind, summary: entry.summary,
					verdict: entry.verdict, actor: entry.actor, approver: entry.approver,
				} });
			});
			await approvals.expirePending();
			const host = new HarnessHost(harness, root, approvals, opts, actor, storage);
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
		if (!agent.extensions.some((extension) => extension.name === "perimeter" && extension.hooks?.some((hook) =>
			hook.task === "pi.tool" && typeof (hook.handlers as Partial<{ beforeTool: unknown }>).beforeTool === "function"))) {
			throw new Error("策略扩展未选中，拒绝运行");
		}
	}

	async submit(text: string, requestId: string, whenBusy: "followUp" | "steer" = "followUp", actor = this.#actor) {
		await this.assertGuard();
		const entry = this.#opts.audit.append({ kind: "prompt", sessionId: this.#opts.sessionId, actor, summary: `prompt（${text.length} 字符）`, argsHash: contentHash(text) });
		this.#opts.emit({ type: "audit.entry", entry: { seq: entry.seq, at: entry.at, kind: entry.kind, summary: entry.summary, actor: entry.actor } });
		const scopedId = JSON.stringify([actor, requestId]);
		await this.root.commit(async (tx) => { (await tx.doc(AuthorsDoc, this.root.id)).requests[scopedId] ??= actor; }, BACKGROUND_CONTEXT);
		return this.root.submit({ type: "input", content: text, requestId: scopedId, whenBusy }, BACKGROUND_CONTEXT);
	}

	async view() {
		const stream = await watchEvents(this.harness, this.root.id, BACKGROUND_CONTEXT);
		try { return await this.#view(stream.snapshot); } finally { await stream.stop(); }
	}

	async #view(snapshot: SnapshotEvent) {
		const view = snapshotView(snapshot, this.#opts.sessionId);
		const approvals = await this.harness.snapshot(ApprovalsDoc, this.root.id, BACKGROUND_CONTEXT);
		view.approvals = (approvals?.items ?? []).filter((item) => item.status === "pending").map((item) => ({
			approvalId: item.id, action: item.action, reason: item.reason, actor: item.requester ?? item.actor, expiresAt: item.expiresAt, argsHash: item.argsHash,
		}));
		const authors = await this.harness.snapshot(AuthorsDoc, this.root.id, BACKGROUND_CONTEXT);
		const messages = new Map(view.messages.map((message) => [message.id, message]));
		let submissions = await this.#storage.scanSubmissions({ conversationId: this.root.id }, 1000, undefined, BACKGROUND_CONTEXT);
		for (;;) {
			for (const record of submissions.items) if (record.entry !== undefined && record.requestId) {
				const message = messages.get(String(record.entry));
				if (message) message.actor = authors?.requests[record.requestId];
			}
			if (!submissions.next) break;
			submissions = await this.#storage.scanSubmissions({ conversationId: this.root.id }, 1000, submissions.next, BACKGROUND_CONTEXT);
		}
		return view;
	}

	async watch(): Promise<RuntimeStream> {
		const stream = await watchEvents(this.harness, this.root.id, BACKGROUND_CONTEXT);
		let state = newTranslateState(stream.snapshot);
		return {
			snapshot: await this.#view(stream.snapshot),
			start: (listener) => stream.start(async (events) => {
				const authors = events.some((event) => event.type === "submission")
					? await this.harness.snapshot(AuthorsDoc, this.root.id, BACKGROUND_CONTEXT) : undefined;
				const actors = new Map(events.flatMap((event) => event.type === "submission" && event.record.entry !== undefined && event.record.requestId
					? [[String(event.record.entry), authors?.requests[event.record.requestId]] as const] : []));
				const converted: ClientEvent[] = [];
				for (let i = 0; i < events.length; i++) {
					const event = events[i]!;
					// durable 自身的队列溢出才用快照恢复。
					if (event.type === "snapshot") {
						state = newTranslateState(event);
						converted.push({ type: "session.snapshot", view: await this.#view(event) });
						continue;
					}
					const batch = toClientEvent(event, state);
					if (event.type === "message_start" && event.message.role === "user") {
						const end = events.slice(i + 1).find((item) => item.type === "message_end");
						const start = batch[0];
						if (start?.type === "message.start" && end?.type === "message_end") start.actor = actors.get(String(end.entry.id));
					}
					converted.push(...batch);
				}
				await listener(converted);
			}),
			stop: () => stream.stop(),
		};
	}
	abort(): Promise<void> { return this.root.abort(BACKGROUND_CONTEXT); }
	close(): Promise<void> { return this.harness.close(BACKGROUND_CONTEXT); }
}
