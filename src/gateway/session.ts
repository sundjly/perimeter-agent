import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AuditLog } from "../audit/log.ts";
import type { ClientCommand, ClientEvent, SessionView } from "../protocol/types.ts";
import { newTranslateState, snapshotView, toClientEvent } from "../protocol/translate.ts";
import { HarnessHost } from "../runtime/harness-host.ts";
import type { ModelGateway } from "../runtime/models.ts";
import type { EnvironmentHandle } from "../runtime/execution-env.ts";
import { type ExecutionBackend, LocalBackend } from "./execution-backend.ts";
import { type SandboxWiring, writeSandboxConfig } from "./sandbox-config.ts";

export interface SessionOptions {
	sessionId: string; actor: string; repo: string; team: string; workspace: string; policyFile: string; audit: AuditLog;
	stateDirectory?: string;
	model?: ModelGateway;
	backend?: ExecutionBackend;
	approvalTimeoutMs?: number;
	wiring?: SandboxWiring;
	sandboxHome?: string;
	repoUrl?: string;
	cloneTimeoutMs?: number;
	piBin?: string; piArgs?: string[]; piEnv?: NodeJS.ProcessEnv; backlogSize?: number;
	send: (event: ClientEvent, seq: number, target?: unknown) => void;
}

export class Session {
	#opts: SessionOptions;
	#host?: HarnessHost;
	#env?: EnvironmentHandle;
	#backend: ExecutionBackend;
	#alive = true;
	#seq = 0;
	#lastActivity = Date.now();
	#starting?: Promise<void>;
	#stream?: Awaited<ReturnType<HarnessHost["watch"]>>;
	#tstate = newTranslateState();
	#audit: SessionView["audit"] = [];
	#queued: { cmd: ClientCommand; actor: string }[] = [];
	constructor(opts: SessionOptions) {
		this.#opts = opts;
		this.#backend = opts.backend ?? new LocalBackend();
		mkdirSync(opts.workspace, { recursive: true });
	}
	get sessionId(): string { return this.#opts.sessionId; }
	get lastSeq(): number { return this.#seq; }
	get alive(): boolean { return this.#alive; }
	get idleMs(): number { return Date.now() - this.#lastActivity; }
	get busy(): boolean { return this.#view?.streaming ?? false; }
	#view?: SessionView;

	start(): Promise<void> {
		return this.#starting ??= this.#start();
	}
	async #start(): Promise<void> {
		const opts = this.#opts;
		opts.audit.append({ kind: "session.start", sessionId: this.sessionId, actor: opts.actor, repo: opts.repo, team: opts.team, summary: "会话开始" });
		try {
			const home = opts.sandboxHome ?? join(opts.workspace, "..", ".homes", opts.sessionId);
			if (opts.wiring) writeSandboxConfig(home, opts.wiring);
			const ctx = { sessionId: opts.sessionId, workspace: opts.workspace, home, extensionPath: "", policyFile: opts.policyFile, env: {} };
			if (this.#backend.kind !== "kubectl") await this.#backend.prepare?.(ctx);
			if (!this.#alive) return;
			
			if (this.#backend.kind !== "local" && !this.#backend.environment) throw new Error("远程后端缺少执行环境，拒绝回退宿主机");
			this.#env = await (this.#backend.environment?.(ctx) ?? new LocalBackend().environment(ctx));
			if (!this.#alive) { await this.#env.close(); return; }
			if (opts.repoUrl) {
				const git = await this.#env.env.exists(".git", BACKGROUND_CONTEXT);
				if (!git.ok) throw new Error("无法检查工作区");
				if (!git.value) await this.#clone(home);
			}
			let model = opts.model;
			if (!model && opts.wiring?.modelGatewayUrl) model = { baseUrl: opts.wiring.modelGatewayUrl, token: opts.wiring.proxyToken, model: opts.wiring.model ?? "default" };
			if (!model && opts.piEnv?.HOME) {
				const providers = JSON.parse(readFileSync(join(opts.piEnv.HOME, ".pi/agent/models.json"), "utf8")).providers;
				const provider = Object.values(providers)[0] as { baseUrl: string; apiKey: string; models: { id: string }[] };
				model = { baseUrl: provider.baseUrl, token: provider.apiKey, model: provider.models[0]!.id };
			}
			if (!model) throw new Error("缺少可信网关模型配置");
			this.#host = await HarnessHost.open({ sessionId: opts.sessionId, file: join(opts.stateDirectory ?? join(opts.workspace, "..", ".state", opts.sessionId), "session.sqlite"),
				workspace: opts.workspace, repo: opts.repo, team: opts.team, actor: opts.actor, policyFile: opts.policyFile, audit: opts.audit, model,
				env: this.#env.env, approvalTimeoutMs: opts.approvalTimeoutMs, emit: (event) => this.#emit(event) });
			if (!this.#alive) { await this.#host.close(); return; }
			this.#stream = await this.#host.watch();
			this.#view = snapshotView(this.#stream.snapshot, opts.sessionId);
			this.#stream.start(async (events) => {
				for (const event of events) {
					if (event.type === "snapshot") this.#emit({ type: "session.snapshot", view: snapshotView(event, opts.sessionId) });
					else for (const client of toClientEvent(event, this.#tstate)) this.#emit(client);
				}
				if (this.#alive) this.#emit({ type: "session.snapshot", view: await this.snapshot() });
			});
			this.#emit({ type: "session.ready", sessionId: opts.sessionId, workspace: opts.workspace, model: model.model });
			this.#emit({ type: "session.snapshot", view: await this.snapshot() });
			this.#opts.audit.append({ kind: "session.start", sessionId: this.sessionId, actor: opts.actor, repo: opts.repo, team: opts.team, summary: "会话就绪，策略扩展已确认" });
			for (const item of this.#queued.splice(0)) this.handle(item.cmd, item.actor);
		} catch (error) {
			try { opts.audit.append({ kind: "error", sessionId: this.sessionId, actor: opts.actor, summary: `会话启动失败：${String(error)}` }); } catch {}
			this.#emit({ type: "error", code: "agent_error", message: `会话启动失败：${String(error)}` });
			this.#alive = false;
			await this.#cleanup("会话启动失败");
		}
	}

	async #clone(home: string): Promise<void> {
		if (!this.#opts.wiring?.gitProxyUrl) throw new Error("配置 repoUrl 必须有 git 代理");
		const result = await this.#env!.env.exec(["git", "clone", "-q", "--", this.#opts.repoUrl!, "."], { timeout: this.#opts.cloneTimeoutMs ?? 30_000 }, BACKGROUND_CONTEXT);
		if (!result.ok || result.value.exitCode !== 0) { await this.#env!.env.remove(".git", { recursive: true, force: true }, BACKGROUND_CONTEXT); throw new Error("clone 失败"); }
		this.#opts.audit.append({ kind: "repo.clone", sessionId: this.sessionId, actor: this.#opts.actor, summary: "clone 完成" });
	}

	async snapshot(): Promise<SessionView> {
		if (!this.#host) return this.#view ?? { sessionId: this.sessionId, model: null, streaming: false, messages: [], tools: [], inbox: [], approvals: [], participants: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 }, audit: [], role: "owner" };
		this.#view = await this.#host.view();
		return { ...this.#view, audit: this.#audit };
	}

	handle(cmd: ClientCommand, actor = this.#opts.actor, _from?: unknown): void {
		this.#lastActivity = Date.now();
		if (!cmd || typeof cmd !== "object" || !["prompt", "steer", "approve", "abort"].includes(cmd.type)) { this.#emit({ type: "error", code: "command_failed", message: "非法命令" }); return; }
		if ((cmd.type === "prompt" || cmd.type === "steer") && (typeof cmd.text !== "string" || !cmd.text.trim())) { this.#emit({ type: "error", code: "command_failed", message: "消息不能为空" }); return; }
		if (!this.#alive) return;
		if (!this.#host) {
			if (cmd.type === "abort") this.#queued.length = 0;
			else if (this.#queued.length < 32) this.#queued.push({ cmd, actor });
			else this.#emit({ type: "error", code: "command_failed", message: "排队消息过多" });
			return;
		}
		void this.#command(cmd, actor).catch((error) => this.#emit({ type: "error", code: "command_failed", message: String(error) }));
	}
	async #command(cmd: ClientCommand, actor: string): Promise<void> {
		if (cmd.type === "abort") await this.#host!.abort();
		else if (cmd.type === "approve") {
			if (typeof cmd.approvalId !== "string" || !["allow", "deny"].includes(cmd.decision)) throw new Error("非法审批命令");
			await this.#host!.approvals.decide(cmd.approvalId, cmd.decision, actor);
		} else if (cmd.type === "prompt" || cmd.type === "steer") await this.#host!.submit(cmd.text, cmd.requestId ?? randomUUID(), cmd.type === "steer" ? "steer" : "followUp", actor);
	}
	#emit(event: ClientEvent): void {
		if (event.type === "agent.start" && this.#view) this.#view.streaming = true;
		if (event.type === "agent.settled" && this.#view) this.#view.streaming = false;
		if (event.type === "audit.entry") { this.#audit.push(event.entry); if (this.#audit.length > 100) this.#audit.shift(); }
		this.#opts.send(event, ++this.#seq);
	}
	async snapshotFrame(): Promise<{ seq: number; event: ClientEvent }> {
		for (;;) {
			const seq = this.#seq;
			const view = await this.snapshot();
			if (seq === this.#seq) return { seq, event: { type: "session.snapshot", view } };
		}
	}
	async stop(reason = "会话结束"): Promise<void> {
		if (!this.#alive) return;
		this.#alive = false;
		await this.#starting?.catch(() => {});
		await this.#cleanup(reason);
	}
	async #cleanup(reason: string): Promise<void> {
		const errors: unknown[] = [];
		try { this.#opts.audit.append({ kind: "session.end", sessionId: this.sessionId, actor: this.#opts.actor, summary: reason }); } catch (error) { errors.push(error); }
		for (const cleanup of [() => this.#stream?.stop(), () => this.#host?.close(), () => this.#env?.close(), () => this.#backend.cleanup?.(this.sessionId)]) {
			try { await cleanup(); } catch (error) { errors.push(error); }
		}
		if (errors.length) throw errors[0];
	}
}
