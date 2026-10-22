import { initialState, reduce, type ViewState } from "../../web/view-model.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { AuditLog, contentHash, type AuditEntry } from "../audit/log.ts";
import type { ClientCommand, ClientEvent, SessionView, Role, MessageView } from "../protocol/types.ts";
import { HISTORY_MAX_PAGE_ITEMS } from "../protocol/validate.ts";
import { isSafeScopedIdentityValue, mintScopedToken } from "../modelgw/scoped-token.ts";
import { HarnessHost } from "../runtime/harness-host.ts";
import type { ModelGateway } from "../runtime/models.ts";
import type { EnvironmentHandle } from "../runtime/execution-env.ts";
import type { ApprovalContext } from "../runtime/approvals.ts";
import { type ExecutionBackend, LocalBackend } from "./execution-backend.ts";
import { type SandboxWiring, writeSandboxConfig } from "./sandbox-config.ts";

export interface SessionOptions {
	sessionId: string; actor: string; repo: string; team: string; workspace: string; policyFile: string; audit: AuditLog;
	stateDirectory?: string;
	model?: ModelGateway;
	/**
	 * S4c：模型 scoped 凭证签发密钥（与 modelgw scopedTokenKey 同一密钥，≥32B；网关
	 * 构造期已做强度与凭据域互异校验）。配置后本会话的模型 Authorization 改为按调用
	 * mint 的短期 scoped token：归属三元组取服务端会话归属（owner principal/team/sessionId），
	 * 静态 proxyToken 不再上行模型网关。密钥不进沙箱/客户端/审计/快照。
	 */
	modelScopedKey?: Buffer;
	backend?: ExecutionBackend;
	approvalTimeoutMs?: number;
	wiring?: SandboxWiring;
	sandboxHome?: string;
	repoUrl?: string;
	cloneTimeoutMs?: number;
	send: (event: ClientEvent, seq: number, target?: unknown) => void;
	isAuthorized?: (actor: string) => boolean;
	isProduction?: boolean;
	getRole?: (actor: string) => Role | undefined;
	getPrincipal?: (actor: string) => string | undefined;
	/** B2：会话 dispose 首步回调（签发方先撤 git grant 登记与 jti 再继续 cleanup） */
	onDisposed?: () => void;
	/** B2：aclVersion 变更回调（签发方撤销旧 grant，代理 ≤pollMs 生效） */
	onAclChanged?: (aclVersion: number) => void;
	/** B2（R51 H4）：初始 aclVersion 在 mint/构造时正确建立，只有真实 bump 才触发 revoke */
	aclVersion?: number;
	/** S3c：prompt 幂等账本条目上限。超限固定拒绝新任务（**不淘汰旧键**——淘汰会让同键重复生成
	 * 变成无提示窗口）；默认 10_000，需运维归档轮替。网关构造期校验正整数 */
	promptLedgerMaxEntries?: number;
	/** S5a：初始快照 tail 与每页历史的上限（项数与序列化字节，取更严）。默认 200 项 / 1MiB
	 * （handoff §3.2）。配置需保证 maxBytes + 单项截断余量 < 网关 maxFrameBytes，否则快照帧必超限 */
	historyTail?: { maxItems?: number; maxBytes?: number };
}

const DEFAULT_PROMPT_LEDGER_MAX_ENTRIES = 10_000;

/** S5a：初始 tail 与单页的默认上限（handoff §3.2：初始 tail 200 项且 ≤1MiB） */
const DEFAULT_HISTORY_TAIL_ITEMS = 200;
const DEFAULT_HISTORY_TAIL_BYTES = 1024 * 1024;
/** S5a：单项展示上限（text/thinking 各自按 UTF-8 字节裁剪，码点边界对齐），超限带 truncated 标记与原始长度 */
export const HISTORY_MAX_ITEM_BYTES = 64 * 1024;

/**
 * S4c：模型 scoped 凭证的短 TTL（10min）—— 被窃凭证的可用窗口有界；tokenProvider
 * 每次模型调用重签，长会话无感。归属只在签发时由网关进程写入，不经任何客户端输入。
 */
const MODEL_SCOPED_TOKEN_TTL_MS = 10 * 60_000;

export class Session {
	#opts: SessionOptions;
	#host?: HarnessHost;
	#env?: EnvironmentHandle;
	#backend: ExecutionBackend;
	#alive = true;
	#seq = 0;
	#lastActivity = Date.now();
	#starting?: Promise<void>;
	#cleaning?: Promise<void>;
	#stream?: Awaited<ReturnType<HarnessHost["watch"]>>;
	#audit: SessionView["audit"] = [];
	#queued: { cmd: ClientCommand; actor: string }[] = [];
	/** S3b：prompt 幂等账本（key=actor+requestId → 内容 hash），随 durable 提交前落盘，跨重启有效 */
	#promptLedger?: Map<string, string>;
	#ledgerFile: string;
	/** S5a：有界 tail/每页上限与游标签发密钥（密钥只在网关进程内存，每会话实例随机） */
	#tailItems: number;
	#tailBytes: number;
	#historyCursorKey: Buffer;
	constructor(opts: SessionOptions) {
		this.#opts = opts;
		this.#aclVersion = opts.aclVersion ?? 1;
		this.#backend = opts.backend ?? new LocalBackend();
		// 与 HarnessHost 的 sqlite 默认目录同一推导，保证账本与转录同生命周期
		this.#ledgerFile = join(opts.stateDirectory ?? join(opts.workspace, "..", ".state", opts.sessionId), "prompt-ledger.json");
		// S5a：tail 上限配置构造期 fail-fast（与 promptLedgerMaxEntries 同尺）
		const tail = opts.historyTail;
		if (tail !== undefined) {
			for (const [name, value] of Object.entries(tail)) {
				if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`配置非法：historyTail.${name} 必须为正整数`);
			}
		}
		this.#tailItems = tail?.maxItems ?? DEFAULT_HISTORY_TAIL_ITEMS;
		this.#tailBytes = tail?.maxBytes ?? DEFAULT_HISTORY_TAIL_BYTES;
		// S5a/S5a2：游标 HMAC 密钥。签名覆盖 sessionId+idx+锚消息 id：伪造/篡改/跨会话
		// 一律验签失败；权威数组重构（durable 压缩 splice 前缀）由锚点核对检出、固定失效。
		// 网关重启或会话回收后旧游标同样失效（客户端重新 attach 取新尾页），不持久化 —— 导航态不值得密钥管理
		this.#historyCursorKey = randomBytes(32);
		mkdirSync(opts.workspace, { recursive: true });
	}
	get sessionId(): string { return this.#opts.sessionId; }
	get lastSeq(): number { return this.#seq; }
	get alive(): boolean { return this.#alive; }
	get idleMs(): number { return Date.now() - this.#lastActivity; }
	get busy(): boolean { return this.#view?.streaming ?? false; }
	#view?: ViewState;

	start(): Promise<void> {
		return this.#starting ??= this.#start();
	}
	async #start(): Promise<void> {
		const opts = this.#opts;
		try {
		const pendingCalls = new Map<string, AuditEntry>();
		const resolvedCalls = new Set<string>();
		const alreadyFlagged = new Set<string>();
		for await (const entry of AuditLog.replay(opts.audit.path)) if (entry.sessionId === this.sessionId) {
			this.#audit.push({ seq: entry.seq, at: entry.at, kind: entry.kind, summary: entry.summary, verdict: entry.verdict, actor: entry.actor, approver: entry.approver });
			if (this.#audit.length > 100) this.#audit.shift();
			if (!entry.callId) continue;
			if (entry.kind === "tool.call") pendingCalls.set(entry.callId, entry);
			else if (entry.kind === "tool.result" || entry.kind === "approval.request" || entry.kind === "approval.decision") resolvedCalls.add(entry.callId);
			else if (entry.kind === "policy.verdict" && entry.verdict === "deny") resolvedCalls.add(entry.callId);
			else if (entry.kind === "error" && entry.summary.includes("工具结果未知")) alreadyFlagged.add(entry.callId);
		}
		opts.audit.append({ kind: "session.start", sessionId: this.sessionId, actor: opts.actor, repo: opts.repo, team: opts.team, summary: "会话开始" });
		// S3c：崩溃残留的「执行中 unsafe 工具」→ outcome_unknown，对会话成员可见 + 审计留痕。
		// durable 对非 replay:"safe" 工具崩溃后不重跑（恢复时给模型 interrupted 错误结果），
		// 这里只补可见性：tool.call 有而 tool.result 无，且该 callId 无审批/拒绝记录（被拦或
		// 待审批者从未执行）；重复重启不重标。git push 类附「先核对远端 ref」固定提示。
		for (const [callId, call] of pendingCalls) {
			if (resolvedCalls.has(callId) || alreadyFlagged.has(callId)) continue;
			const target = (call.command ?? call.path ?? call.tool ?? "未知工具").slice(0, 80);
			const hint = typeof call.command === "string" && call.command.includes("git push")
				? "push 类：先核对远端 ref，不要直接再推。"
				: "原执行进程可能仍在运行（本层无从判断，不得声称已终止），需人工核对工作区 diff 与残留进程。";
			const summary = `工具结果未知（崩溃打断，不自动重放；阶段=执行中）：callId=${callId} ${target} ${hint}`;
			const actor = call.actor ?? opts.actor;
			try {
				const flagged = opts.audit.append({ kind: "error", sessionId: this.sessionId, actor, callId, argsHash: call.argsHash, summary, verdict: "deny" });
				this.#emit({ type: "audit.entry", entry: { seq: flagged.seq, at: flagged.at, kind: flagged.kind, summary: flagged.summary, verdict: flagged.verdict, actor: flagged.actor } });
			} catch {
				// 审计写入失败时可见性不缺席（seq=0 标识本条仅为会话内视图，未落链）
				this.#emit({ type: "audit.entry", entry: { seq: 0, at: new Date().toISOString(), kind: "error", summary, verdict: "deny", actor } });
			}
		}
			const home = opts.sandboxHome ?? join(opts.workspace, "..", ".homes", opts.sessionId);
			mkdirSync(home, { recursive: true });
			rmSync(join(home, ".pi"), { recursive: true, force: true });
			if (opts.wiring) writeSandboxConfig(home, opts.wiring);
			const ctx = {
				sessionId: opts.sessionId, workspace: opts.workspace, home, extensionPath: "", policyFile: opts.policyFile,
				env: { PERIMETER_REPO: opts.repo, PERIMETER_TEAM: opts.team },
				// 透传给后端：非空表示启动后还有一次容器内 clone，受保护挂载必须让位（git clone 需空目录）
				repoUrl: opts.repoUrl,
			};
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
			if (!model && opts.wiring?.modelGatewayUrl) {
				let baseUrl = opts.wiring.modelGatewayUrl;
				try {
					const u = new URL(baseUrl);
					if (u.hostname.toLowerCase() === "host.docker.internal") {
						u.hostname = "127.0.0.1";
						baseUrl = u.href;
					}
				} catch {}
				model = { baseUrl, token: opts.wiring.proxyToken, model: opts.wiring.model ?? "default" };
			}

			if (!model || !model.token || !model.baseUrl || !model.model) throw new Error("缺少可信网关模型配置");
			// S4c：scoped 模式 —— 归属三元组只取服务端会话归属（owner/team/sessionId），
			// 不取客户端输入；每次模型调用重签。启动期先校验可签发性：坏归属字段在会话
			// 启动就 fail-closed（固定类别），不拖到第一次模型调用才在 resolve 里炸。
			// 未配置 modelScopedKey 时完全不走这支，行为不变。
			if (opts.modelScopedKey) {
				for (const [name, value] of [["tenant", opts.actor], ["team", opts.team], ["sessionId", opts.sessionId]] as const) {
					if (!isSafeScopedIdentityValue(value)) throw new Error(`modelScopedKey 归属字段非法（${name}，固定类别），拒绝会话启动`);
				}
				const scopedKey = opts.modelScopedKey;
				model = {
					...model,
					tokenProvider: () => mintScopedToken(scopedKey, { tenant: opts.actor, team: opts.team, sessionId: opts.sessionId, ttlMs: MODEL_SCOPED_TOKEN_TTL_MS }),
				};
			}
			this.#host = await HarnessHost.open({ sessionId: opts.sessionId, file: join(opts.stateDirectory ?? join(opts.workspace, "..", ".state", opts.sessionId), "session.sqlite"),
				workspace: opts.workspace, repo: opts.repo, team: opts.team, actor: opts.actor, policyFile: opts.policyFile, audit: opts.audit, model,
				env: this.#env.env, guardEnv: this.#env.guardEnv, approvalTimeoutMs: opts.approvalTimeoutMs, emit: (event) => this.#emit(event),
				getContext: () => this.getApprovalContext(),
				getPrincipal: opts.getPrincipal,
				isProduction: opts.isProduction,
			});
			if (!this.#alive) { await this.#host.close(); return; }
			this.#stream = await this.#host.watch();
			this.#view = reduce(initialState(), { type: "session.snapshot", view: this.#stream.snapshot });
			this.#stream.start(async (events) => {
				for (const event of events) this.#emit(event);
			});
			this.#emit({ type: "session.ready", sessionId: opts.sessionId, workspace: opts.workspace, model: model.model });
			this.#emit({ type: "session.snapshot", view: this.snapshot() });
			this.#opts.audit.append({ kind: "session.start", sessionId: this.sessionId, actor: opts.actor, repo: opts.repo, team: opts.team, summary: "会话就绪，策略扩展已确认" });
			for (const item of this.#queued.splice(0)) {
				if (this.#opts.isAuthorized && !this.#opts.isAuthorized(item.actor)) continue;
				this.handle(item.cmd, item.actor);
			}
		} catch (error) {
			try { opts.audit.append({ kind: "error", sessionId: this.sessionId, actor: opts.actor, summary: `会话启动失败：${String(error)}` }); } catch {}
			this.#emit({ type: "error", code: "agent_error", message: `会话启动失败：${String(error)}` });
			this.#alive = false;
			await this.#cleanup("会话启动失败");
		}
	}

	#aclVersion: number;
	setAclVersion(v: number): void {
		// R51 H4：同值重设（attach 重建）不可误撤刚签 grant；只有真实 bump 才触发撤销
		if (v === this.#aclVersion) return;
		this.#aclVersion = v;
		try {
			this.#opts.onAclChanged?.(v);
		} catch {
			// R51 H3：撤销失败不静默——固定类别审计可见，fail-closed（旧 grant 若未被撤销，
			// 签发方在登记侧 aclVersion 未变仍会拒：onAclChanged 抛错时登记未更新）
			try { this.#opts.audit.append({ kind: "error", sessionId: this.sessionId, actor: this.#opts.actor, summary: "git grant acl 变更回调失败（撤销未完成，固定类别）" }); } catch { /* 审计也失败：保留异常可见 */ }
		}
	}
	getAclVersion(): number { return this.#aclVersion; }

	async getApprovalContext(): Promise<ApprovalContext> {
		const policyContent = existsSync(this.#opts.policyFile) ? readFileSync(this.#opts.policyFile, "utf8") : "";
		const policyHash = contentHash(policyContent);
		let gitRevision = "0".repeat(40);
		let reliable = false;
		if (this.#env?.env) {
			try {
				let stdout = "";
				const res = await this.#env.env.exec(["git", "rev-parse", "HEAD"], {
					onOutput: (text) => { stdout += text; },
				}, BACKGROUND_CONTEXT);
				if (res.ok && res.value.exitCode === 0) {
					const rev = stdout.trim();
					if (rev && /^[a-f0-9]{40}$/.test(rev) && rev !== "0".repeat(40)) {
						gitRevision = rev;
						reliable = true;
					}
				}
			} catch {}
		}
		const isProd = this.#opts.isProduction ?? false;
		if (isProd && (!reliable || !this.#opts.repo)) {
			reliable = false;
		}
		return {
			sessionIdentity: this.sessionId,
			tenantIdentity: this.#opts.team,
			repoIdentity: this.#opts.repo,
			gitRevision,
			policyHash,
			aclVersion: this.#aclVersion,
			reliable,
			isProduction: isProd,
		};
	}

	async expirePending(actor?: string): Promise<void> {
		if (this.#host) {
			if (actor) await this.#host.approvals.expirePendingForActor(actor);
			else await this.#host.approvals.expirePending();
		}
	}

	async #clone(home: string): Promise<void> {
		if (!this.#opts.wiring?.gitProxyUrl) throw new Error("配置 repoUrl 必须有 git 代理");
		const result = await this.#env!.env.exec(["git", "clone", "-q", "--", this.#opts.repoUrl!, "."], { timeout: this.#opts.cloneTimeoutMs ?? 30_000 }, BACKGROUND_CONTEXT);
		if (!result.ok || result.value.exitCode !== 0) { await this.#env!.env.remove(".git", { recursive: true, force: true }, BACKGROUND_CONTEXT); throw new Error("clone 失败"); }
		this.#opts.audit.append({ kind: "repo.clone", sessionId: this.sessionId, actor: this.#opts.actor, summary: "clone 完成" });
	}

	snapshot(): SessionView {
		if (!this.#host) return this.#view ?? { sessionId: this.sessionId, model: null, streaming: false, messages: [], tools: [], inbox: [], approvals: [], participants: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, cacheHitRate: null }, audit: [], role: "owner" };
		// 只快照已发布的状态，避免 durable commit 领先事件回调而重放旧 delta。
		const { errors: _errors, phase: _phase, ...view } = this.#view!;
		return { ...view, audit: [...this.#audit] };
	}

	// ── S5a：有界快照与历史分页（handoff §3.2：初始 tail 200 项且 ≤1MiB，超限返回分页游标）──

	/** 单条超大消息按确定性规则裁剪（每字段 ≤HISTORY_MAX_ITEM_BYTES，UTF-8 码点边界对齐），
	 * 带 truncated 标记与原始字节长度 —— 不让单项撑爆 tail 预算与帧上限 */
	#clipMessage(message: MessageView): MessageView {
		const textBytes = Buffer.byteLength(message.text, "utf8");
		const thinkingBytes = Buffer.byteLength(message.thinking, "utf8");
		if (textBytes <= HISTORY_MAX_ITEM_BYTES && thinkingBytes <= HISTORY_MAX_ITEM_BYTES) return message;
		const clip = (s: string, bytes: number): string => {
			if (bytes <= HISTORY_MAX_ITEM_BYTES) return s;
			const buf = Buffer.from(s, "utf8");
			let end = HISTORY_MAX_ITEM_BYTES;
			while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
			return buf.subarray(0, end).toString("utf8");
		};
		return { ...message, text: clip(message.text, textBytes), thinking: clip(message.thinking, thinkingBytes),
			truncated: true, originalBytes: textBytes + thinkingBytes };
	}

	/** 从数组尾部向前收集：条数与序列化字节双上限（取更严）；最新一项始终保留，
	 * 否则配小上限时空会话没有可渲染内容。返回的 oldestIncluded 是首项在原数组中的下标 */
	#boundedTail(messages: MessageView[], maxItems: number, maxBytes: number): { items: MessageView[]; oldestIncluded: number } {
		const clipped = messages.map((message) => this.#clipMessage(message));
		let start = messages.length;
		let count = 0;
		let bytes = 0;
		for (let i = messages.length - 1; i >= 0; i--) {
			const size = Buffer.byteLength(JSON.stringify(clipped[i]), "utf8");
			if (count > 0 && (count + 1 > maxItems || bytes + size > maxBytes)) break;
			count++;
			bytes += size;
			start = i;
		}
		return { items: clipped.slice(start), oldestIncluded: start };
	}

	/** 对外快照视图：内部 #view 保持全量（权威历史留在服务端），只有出口被裁成有界尾页并附历史元信息 */
	#outboundView(view: SessionView): SessionView {
		const { items, oldestIncluded } = this.#boundedTail(view.messages, this.#tailItems, this.#tailBytes);
		return { ...view, messages: items,
			history: { total: view.messages.length, oldestIncluded, cursor: oldestIncluded > 0 ? this.#mintCursor(oldestIncluded) : null } };
	}

	/** S5a2：游标 v2 —— 语义是「messages[idx] 之前的全部条目」，签名与锚点绑定：anchor
	 * 取 messages[idx-1].id（被游标覆盖范围的最新一条；idx ≥ 1 时必存在，且不会是生成中的
	 * "live" —— live 恒在数组末尾、只会被包含在尾页内）。常态追加不动该位置；pi-durable
	 * 压缩会 splice 前缀并前置摘要，重构后锚失配 → 验证固定失效。anchor 随游标携带
	 * （本就是客户端可见的 MessageView.id，无新增泄漏），验证时与当前数组核对 */
	#mintCursor(idx: number): string {
		const anchor = this.#view?.messages[idx - 1]?.id ?? "";
		const sig = createHmac("sha256", this.#historyCursorKey).update(`${this.sessionId}\u0000history\u0000${idx}\u0000${anchor}`).digest("hex").slice(0, 32);
		return `v2.${idx}.${anchor}.${sig}`;
	}

	/** S5a2：invalid=形状/签名不通过（伪造/篡改/跨会话）。签名只证「游标出自本会话且未被
	 * 改」；「指向的结构是否还在」（锚点与当前权威数组是否一致）由 #historyPage 核对，
	 * 失配属 stale → 也固定类别、不返回任何数据 */
	#verifyCursor(cursor: string): { state: "ok"; idx: number; anchor: string } | { state: "invalid" } {
		const match = /^v2\.(\d{1,12})\.([A-Za-z0-9_-]{1,64})\.([0-9a-f]{32})$/.exec(cursor);
		if (!match) return { state: "invalid" };
		const idx = Number(match[1]);
		const anchor = match[2]!;
		const expected = createHmac("sha256", this.#historyCursorKey).update(`${this.sessionId}\u0000history\u0000${idx}\u0000${anchor}`).digest("hex").slice(0, 32);
		const got = Buffer.from(match[3]!, "hex");
		const want = Buffer.from(expected, "hex");
		if (got.length !== want.length || !timingSafeEqual(got, want)) return { state: "invalid" };
		return { state: "ok", idx, anchor };
	}

	handle(cmd: ClientCommand, actor = this.#opts.actor, _from?: unknown): void {
		this.#lastActivity = Date.now();
		if (!cmd || typeof cmd !== "object" || !["prompt", "steer", "approve", "abort", "history.page"].includes(cmd.type)) {
			this.#emit({ type: "error", code: "command_failed", message: "非法命令" }); return;
		}
		const role = this.#opts.getRole?.(actor);
		if ((cmd.type === "prompt" || cmd.type === "steer" || cmd.type === "abort") && role && role !== "owner" && role !== "editor") {
			this.#emit({ type: "error", code: "command_failed", message: "无权执行命令：只有 owner 与 editor 可发起任务或中止" }); return;
		}
		if (cmd.type === "approve" && role && role !== "approver") {
			this.#emit({ type: "error", code: "command_failed", message: "无权审批：只有 approver 角色可审批" }); return;
		}
		if ((cmd.type === "prompt" || cmd.type === "steer") && (typeof cmd.text !== "string" || !cmd.text.trim()
			|| typeof cmd.requestId !== "string" || !cmd.requestId || cmd.requestId.length > 256)) {
			this.#emit({ type: "error", code: "command_failed", message: "消息与 requestId 必须有效" }); return;
		}
		if (!this.#alive) { this.#emit({ type: "error", code: "agent_error", message: "会话已关闭，请重新接入" }); return; }
		if (this.#opts.isAuthorized && !this.#opts.isAuthorized(actor)) {
			this.#emit({ type: "error", code: "command_failed", message: "资源权限已撤销" }); return;
		}
		if (cmd.type === "history.page") {
			// S5a：只读分页 —— 任何成员角色（含 viewer）可读；不进队列（排队语义只对写命令有意义），
			// 未就绪固定拒绝；错误只定向回发起连接（与分页应答同一通道，不广播）
			if (!this.#host) { this.#opts.send({ type: "error", code: "command_failed", message: "会话尚未就绪（固定类别）" }, ++this.#seq, _from); return; }
			void this.#historyPage(cmd, _from).catch((error: unknown) => {
				// 已知的固定类别拒绝（游标无效/会话不匹配）保留原文；未知异常不透传内部细节
				const known = error instanceof Error && error.message.includes("固定类别");
				this.#opts.send({ type: "error", code: "command_failed",
					message: known ? (error as Error).message : "历史分页失败（固定类别）" }, ++this.#seq, _from);
			});
			return;
		}
		if (!this.#host) {
			if (cmd.type === "abort") this.#queued.length = 0;
			else if (this.#queued.length < 32) this.#queued.push({ cmd, actor });
			else this.#emit({ type: "error", code: "command_failed", message: "排队消息过多" });
			return;
		}
		void this.#command(cmd, actor).catch((error) => this.#emit({ type: "error", code: "command_failed", message: String(error) }));
	}
	async #command(cmd: ClientCommand, actor: string): Promise<void> {
		if (this.#opts.isAuthorized && !this.#opts.isAuthorized(actor)) throw new Error("资源权限已撤销");
		const role = this.#opts.getRole?.(actor);
		if (cmd.type === "abort") {
			if (role && role !== "owner" && role !== "editor") throw new Error("无权执行命令");
			await this.#host!.abort();
		} else if (cmd.type === "approve") {
			if (typeof cmd.approvalId !== "string" || !["allow", "deny"].includes(cmd.decision)) throw new Error("非法审批命令");
			if (role && role !== "approver") throw new Error(`无权审批：角色 ${role} 禁止审批`);
			await this.#host!.approvals.decide(cmd.approvalId, cmd.decision, actor, {
				isAuthorized: this.#opts.isAuthorized,
				approverPrincipal: this.#opts.getPrincipal?.(actor),
				approverRole: role,
				getContext: () => this.getApprovalContext(),
				isProduction: this.#opts.isProduction,
			});
		} else if (cmd.type === "prompt" || cmd.type === "steer") {
			if (role && role !== "owner" && role !== "editor") throw new Error(`无权执行命令：角色 ${role} 禁止发起任务`);
			// S3c：审计不可用 → 拒绝新任务（固定类别，不透传底层 IO 错误）；abort/approve 不做此门
			try { this.#opts.audit.checkWritable(); } catch { throw new Error("审计不可用，拒绝新任务（固定类别）"); }
			// S3b 消息幂等：同 actor 同 requestId 不同内容 → 固定类别拒绝；同键同内容重复 →
			// 不再提交，不重复模型生成。账本在 durable 提交前落盘（先记账再副作用），跨重启有效；
			// durable 侧 scopedId 幂等仍是第二道（见 durable-runtime 测试）。
			this.#checkPromptIdempotency(actor, cmd.requestId, contentHash(cmd.text));
			await this.#host!.submit(cmd.text, cmd.requestId, cmd.type === "steer" ? "steer" : "followUp", actor);
		}
	}
	/** S3b：prompt 幂等账本（stateDirectory 下 0600）。损坏即 fail-closed 拒绝新任务，不静默重建 */
	#loadPromptLedger(): Map<string, string> {
		if (this.#promptLedger) return this.#promptLedger;
		if (!existsSync(this.#ledgerFile)) {
			this.#promptLedger = new Map();
			return this.#promptLedger;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.#ledgerFile, "utf8"));
		} catch {
			throw new Error("prompt 幂等账本损坏，拒绝新任务（固定类别）");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("prompt 幂等账本损坏，拒绝新任务（固定类别）");
		const map = new Map<string, string>();
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value !== "string") throw new Error("prompt 幂等账本损坏，拒绝新任务（固定类别）");
			map.set(key, value);
		}
		this.#promptLedger = map;
		return map;
	}

	/** 先记账再提交：同键异内容拒绝、同键同内容不重复提交。账本写入失败回滚内存并拒绝（不留无账本的提交） */
	#checkPromptIdempotency(actor: string, requestId: string, hash: string): void {
		const ledger = this.#loadPromptLedger();
		const key = `${actor}\u0000${requestId}`;
		const prev = ledger.get(key);
		if (prev !== undefined) {
			if (prev !== hash) throw new Error("requestId 已用于不同内容，拒绝重复使用（固定类别）");
			throw new Error("重复请求：同 requestId 同内容已受理，不重复生成（固定类别）");
		}
		// S3c：条目上限——超限拒新不淘汰（淘汰会让同键重复生成变成无提示窗口）
		const configured = this.#opts.promptLedgerMaxEntries;
		const max = configured !== undefined && Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_PROMPT_LEDGER_MAX_ENTRIES;
		if (ledger.size >= max) throw new Error(`prompt 幂等账本已满（上限 ${max} 条），拒绝新任务（固定类别；不淘汰旧键，需运维归档轮替）`);
		ledger.set(key, hash);
		const tmp = `${this.#ledgerFile}.${process.pid}.${randomUUID()}.tmp`;
		try {
			mkdirSync(dirname(this.#ledgerFile), { recursive: true });
			writeFileSync(tmp, JSON.stringify(Object.fromEntries(ledger)), { mode: 0o600 });
			renameSync(tmp, this.#ledgerFile);
			try { chmodSync(this.#ledgerFile, 0o600); } catch { /* 刚以 0600 写入；chmod 兜底失败不影响语义 */ }
		} catch {
			ledger.delete(key);
			try { unlinkSync(tmp); } catch { /* 未写出或已清理 */ }
			throw new Error("prompt 幂等账本写入失败，拒绝新任务（固定类别）");
		}
	}

	/** S5a/S5a2：向更早方向翻一页。游标 HMAC 绑定 sessionId+idx+锚消息 id（timing-safe）。
	 * idx 边界在「常态追加」下稳定：新消息只追加、既有条目只原地更新（message.end 原地
	 * 换 id），分页期间的新消息不会造成重复或跳项；但追加-only 不是不变量 —— pi-durable
	 * 压缩会 splice 权威前缀并前置摘要（vendor view.js:132-138），重构由锚点核对检出，
	 * 旧游标固定类别失效（不静默错位）。页条数/字节上限与初始 tail 同尺 */
	async #historyPage(cmd: Extract<ClientCommand, { type: "history.page" }>, from?: unknown): Promise<void> {
		if (cmd.sessionId !== this.sessionId) throw new Error("会话不匹配（固定类别）");
		const messages = this.#view?.messages ?? [];
		const total = messages.length;
		const verified = this.#verifyCursor(cmd.cursor);
		if (verified.state === "invalid") throw new Error("游标无效（固定类别）");
		// 锚点核对：当前数组 idx-1 位置的 id 必须与签发时一致，且 idx 不越界 —— 不一致
		// 说明权威数组已被重构（如 durable 压缩 splice 前缀），旧游标指向的内容不可再定位
		if (verified.idx > total || (messages[verified.idx - 1]?.id ?? "") !== verified.anchor) {
			throw new Error("游标已失效，请重新接入（固定类别）");
		}
		const idx = verified.idx;
		const limit = Math.min(cmd.limit ?? this.#tailItems, this.#tailItems, HISTORY_MAX_PAGE_ITEMS);
		// 从 idx-1 向更早收集，条数/字节双上限，至少一项（idx>0 时），保证客户端总能前进
		const items: MessageView[] = [];
		let start = idx;
		let bytes = 0;
		for (let i = idx - 1; i >= 0; i--) {
			const item = this.#clipMessage(messages[i]!);
			const size = Buffer.byteLength(JSON.stringify(item), "utf8");
			if (items.length > 0 && (items.length + 1 > limit || bytes + size > this.#tailBytes)) break;
			items.unshift(item);
			bytes += size;
			start = i;
		}
		// 定向应答（只发回发起连接，不广播）：历史对各成员相同，但没必要让所有端都收一份
		this.#opts.send({ type: "history.page", items, total, oldestIncluded: start,
			cursor: start > 0 ? this.#mintCursor(start) : null }, ++this.#seq, from);
	}

	#emit(event: ClientEvent): void {
		if (this.#view) this.#view = reduce(this.#view, event);
		if (event.type === "audit.entry") { this.#audit.push(event.entry); if (this.#audit.length > 100) this.#audit.shift(); }
		if (event.type === "session.snapshot") {
			// S5a：内部 #view 吃全量（上面 reduce 已完成），出口换成有界尾页 ——
			// 长会话/慢端不再被整段历史撑爆单帧（maxFrameBytes 超限会 1009 断连）
			this.#opts.send({ type: "session.snapshot", view: this.#outboundView({ ...event.view, audit: [...this.#audit] }) }, ++this.#seq);
			return;
		}
		this.#opts.send(event, ++this.#seq);
	}
	publish(event: ClientEvent): void { this.#emit(event); }
	auditCommand(actor: string, summary: string): void {
		this.#lastActivity = Date.now();
		try {
			const entry = this.#opts.audit.append({ kind: "prompt", sessionId: this.sessionId, actor, summary: `命令 ${summary}` });
			this.#emit({ type: "audit.entry", entry: { seq: entry.seq, at: entry.at, kind: entry.kind, summary: entry.summary, actor: entry.actor } });
		} catch { /* S3c：审计不可用不阻断命令面——abort/deny 必须保持可用；缺口由 readyz 503 与拒新任务兜底 */ }
	}
	async snapshotFrame(deliver?: (frame: { seq: number; event: ClientEvent }) => void): Promise<{ seq: number; event: ClientEvent }> {
		for (;;) {
			const seq = this.#seq;
			const view = this.#outboundView(await this.snapshot());
			if (seq === this.#seq) {
				const frame = { seq, event: { type: "session.snapshot" as const, view } };
				deliver?.(frame);
				return frame;
			}
		}
	}
	async stop(reason = "会话结束"): Promise<void> {
		if (!this.#alive && this.#gitGrantRevokedOk) return;
		this.#alive = false;
		// R-Q52-6：git 能力撤销放在**第一个长 await 之前**；撤销失败**不得逃出 stop**
		//（#reap 已先删 session，逃出后无 cleanup 入口 → 沙箱泄漏）。内存先撤、try 记录
		//（固定类别审计），继续 startup 收束与 #cleanup（#dispose 内独立重试）。
		try {
			this.#revokeGitGrantOnce();
		} catch {
			try { this.#opts.audit.append({ kind: "error", sessionId: this.sessionId, actor: this.#opts.actor, summary: "git grant 停止前撤销失败（内存态已撤销优先；固定类别）" }); } catch { /* 审计也失败：不阻 stop */ }
		}
		await this.#starting?.catch(() => {});
		await this.#cleanup(reason);
	}

	#gitGrantRevokedOk = false;
	/** 幂等单飞：成功一次即不再调；失败保留待重试（异常向调用方传播，不吞） */
	#revokeGitGrantOnce(): void {
		if (this.#gitGrantRevokedOk) return;
		if (!this.#opts.onDisposed) { this.#gitGrantRevokedOk = true; return; }
		this.#opts.onDisposed();
		this.#gitGrantRevokedOk = true;
	}
	async #cleanup(reason: string): Promise<void> {
		return this.#cleaning ??= this.#dispose(reason);
	}
	async #dispose(reason: string): Promise<void> {
		const errors: unknown[] = [];
		// B2：先撤签发方 git grant 登记与 jti（同步持久化），再进入可能很长的 cleanup——
		// 吊销不被 Docker stop 等清理拖住后才发生（合同 C2 顺序要求）。R51 H3：幂等单飞，
		// stop 已撤过则跳过；失败计入 errors 且保留待重试（不置位）。
		try { this.#revokeGitGrantOnce(); } catch (error) { errors.push(error); }
		try { this.#opts.audit.append({ kind: "session.end", sessionId: this.sessionId, actor: this.#opts.actor, summary: reason }); } catch (error) { errors.push(error); }
		try { await this.#host?.abort(); } catch {}
		const withDeadline = async (fn: () => unknown, ms = 5000) => {
			let timer: NodeJS.Timeout;
			try {
				await Promise.race([
					Promise.resolve().then(() => fn()),
					new Promise<void>((_, reject) => {
						timer = setTimeout(() => reject(new Error("cleanup step timeout")), ms);
					}),
				]);
			} finally {
				clearTimeout(timer!);
			}
		};
		for (const cleanup of [() => this.#stream?.stop(), () => this.#host?.close(), () => this.#env?.close(), () => this.#backend.cleanup?.(this.sessionId)]) {
			try { await withDeadline(cleanup, 5000); } catch (error) { errors.push(error); }
		}
		if (errors.length) throw errors[0];
	}
}
