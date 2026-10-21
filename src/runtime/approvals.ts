import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Conversation } from "@earendil-works/pi-durable";
import { contentHash } from "../audit/log.ts";
import type { ActionDescriptor, ClientEvent, Decision, Role } from "../protocol/types.ts";

export type ApprovalStatus = "pending" | "allow" | "deny" | "expired" | "invalidated";

export interface ApprovalContext {
	sessionIdentity: string;
	tenantIdentity: string;
	repoIdentity: string;
	gitRevision: string;
	policyHash: string;
	aclVersion: number;
	reliable?: boolean;
	isProduction?: boolean;
}

export function isContextReliable(ctx?: Partial<ApprovalContext>, isProduction = false): boolean {
	if (!ctx) return !isProduction;
	if (ctx.reliable === false) return false;
	if (isProduction || ctx.isProduction) {
		if (!ctx.sessionIdentity || typeof ctx.sessionIdentity !== "string" || !ctx.sessionIdentity.trim()) return false;
		if (!ctx.tenantIdentity || typeof ctx.tenantIdentity !== "string" || !ctx.tenantIdentity.trim()) return false;
		if (!ctx.repoIdentity || typeof ctx.repoIdentity !== "string" || !ctx.repoIdentity.trim()) return false;
		if (!ctx.gitRevision || !/^[a-f0-9]{40}$/.test(ctx.gitRevision) || ctx.gitRevision === "0".repeat(40)) return false;
		if (!ctx.policyHash || !/^[a-f0-9]{64}$/.test(ctx.policyHash) || ctx.policyHash === "0".repeat(64)) return false;
		if (typeof ctx.aclVersion !== "number" || ctx.aclVersion < 1) return false;
		return true;
	}
	return true;
}

export type Approval = {
	id: string;
	callId: string;
	action: { tool: string; path?: string; command?: string };
	argsHash: string;
	rule: string;
	reason: string;
	actor: string;
	requester: string;
	requesterPrincipal?: string;
	expiresAt: number;
	status: ApprovalStatus;
	approver?: string;
	approverPrincipal?: string;
	sessionIdentity: string;
	tenantIdentity: string;
	repoIdentity: string;
	gitRevision: string;
	policyHash: string;
	aclVersion: number;
	reliable?: boolean;
	isProduction?: boolean;
};

export const ApprovalsDoc = defineDoc<{ items: Approval[] }>({
	kind: "perimeter.approvals", version: 1, scope: "conversation", history: "latest",
	fork: "initial", initial: () => ({ items: [] }),
});

export class Approvals {
	#root: Conversation;
	#emit: (event: ClientEvent) => void;
	#audit: (item: Approval) => void;
	#waiters = new Map<string, (approved: boolean) => void>();

	constructor(root: Conversation, emit: (event: ClientEvent) => void, privateAudit: (item: Approval) => void) {
		this.#root = root;
		this.#emit = emit;
		this.#audit = privateAudit;
	}

	async expirePending(): Promise<void> {
		const expiredIds: string[] = [];
		await this.#root.commit(async (tx) => {
			for (const item of (await tx.doc(ApprovalsDoc, this.#root.id)).items) {
				if (item.status === "pending") {
					item.status = "expired";
					item.approver = "system";
					expiredIds.push(item.id);
					this.#audit({ ...item });
				}
			}
		}, BACKGROUND_CONTEXT);
		for (const id of expiredIds) {
			this.#emit({ type: "approval.resolved", approvalId: id, decision: "deny", actor: "system" });
			this.#waiters.get(id)?.(false);
		}
	}

	async expirePendingForActor(actor: string): Promise<void> {
		const expiredIds: string[] = [];
		await this.#root.commit(async (tx) => {
			for (const item of (await tx.doc(ApprovalsDoc, this.#root.id)).items) {
				if (item.status === "pending" && (item.actor === actor || item.requester === actor || item.approver === actor)) {
					item.status = "expired";
					item.approver = "system";
					expiredIds.push(item.id);
					this.#audit({ ...item });
				}
			}
		}, BACKGROUND_CONTEXT);
		for (const id of expiredIds) {
			this.#emit({ type: "approval.resolved", approvalId: id, decision: "deny", actor: "system" });
			this.#waiters.get(id)?.(false);
		}
	}

	async request(
		callId: string,
		action: ActionDescriptor,
		rule: string,
		reason: string,
		actor: string,
		timeoutMs: number,
		signal: AbortSignal,
		context?: Partial<ApprovalContext>,
		requesterPrincipal?: string,
		isProduction = false,
	): Promise<boolean> {
		const isProd = isProduction || !!context?.isProduction;
		if (isProd && !isContextReliable(context, true)) {
			// Fail-closed: 生产环境上下文不可靠（无有效 gitRevision 或 repo 等），拒不创建 pending 审批
			return false;
		}
		const rawArgs = action.args !== undefined ? action.args : { tool: action.tool, ...(action.path ? { path: action.path } : {}), ...(action.command ? { command: action.command } : {}) };
		const argsHash = contentHash(rawArgs);
		const ctx: ApprovalContext = {
			sessionIdentity: context?.sessionIdentity ?? "",
			tenantIdentity: context?.tenantIdentity ?? "",
			repoIdentity: context?.repoIdentity ?? "",
			gitRevision: context?.gitRevision ?? "0".repeat(40),
			policyHash: context?.policyHash ?? "0".repeat(64),
			aclVersion: context?.aclVersion ?? 1,
			reliable: isContextReliable(context, isProd),
			isProduction: isProd,
		};
		const item: Approval = {
			id: randomUUID(),
			callId,
			action: { tool: action.tool, ...(action.path ? { path: action.path } : {}), ...(action.command ? { command: action.command } : {}) },
			argsHash,
			rule,
			reason,
			actor,
			requester: actor,
			requesterPrincipal: requesterPrincipal ?? actor,
			expiresAt: Date.now() + timeoutMs,
			status: "pending",
			sessionIdentity: ctx.sessionIdentity,
			tenantIdentity: ctx.tenantIdentity,
			repoIdentity: ctx.repoIdentity,
			gitRevision: ctx.gitRevision,
			policyHash: ctx.policyHash,
			aclVersion: ctx.aclVersion,
			reliable: ctx.reliable,
			isProduction: ctx.isProduction,
		};
		await this.#root.commit(async (tx) => {
			(await tx.doc(ApprovalsDoc, this.#root.id)).items.push(item);
		}, BACKGROUND_CONTEXT);
		return new Promise<boolean>((resolve) => {
			const finish = (approved: boolean) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				this.#waiters.delete(item.id);
				resolve(approved);
			};
			const abort = () => { void this.decide(item.id, "deny", "system").catch(() => finish(false)); };
			const timer = setTimeout(abort, Math.max(0, timeoutMs));
			this.#waiters.set(item.id, finish);
			signal.addEventListener("abort", abort, { once: true });
			this.#emit({
				type: "approval.request",
				approvalId: item.id,
				action: item.action,
				argsHash: item.argsHash,
				reason,
				expiresAt: item.expiresAt,
				actor,
			});
			if (signal.aborted) abort();
		});
	}

	async decide(
		id: string,
		decision: Decision,
		actor: string,
		opts?: {
			isAuthorized?: (actor: string) => boolean;
			approverPrincipal?: string;
			getContext?: () => Promise<ApprovalContext> | ApprovalContext;
			approverRole?: Role;
			isProduction?: boolean;
		} | ((actor: string) => boolean),
	): Promise<Approval | undefined> {
		const isAuthorized = typeof opts === "function" ? opts : opts?.isAuthorized;
		const options = typeof opts === "object" ? opts : undefined;
		const approverRole = options?.approverRole;
		const approverPrincipal = options?.approverPrincipal ?? actor;

		if (decision === "allow" && approverRole && approverRole !== "approver") {
			throw new Error(`无权审批：角色 ${approverRole} 禁止审批高风险操作`);
		}

		let invalidationReason: string | undefined;

		// 1. 查找当前待审批项并完成前置安全断言
		const snapshotItem = await this.#root.commit(async (tx) => {
			const it = (await tx.doc(ApprovalsDoc, this.#root.id)).items.find((item) => item.id === id);
			return it ? (JSON.parse(JSON.stringify(it)) as Approval) : undefined;
		}, BACKGROUND_CONTEXT);
		if (!snapshotItem || snapshotItem.status !== "pending") return undefined;

		const isProd = options?.isProduction ?? snapshotItem.isProduction ?? false;

		if (decision === "allow") {
			const requester = snapshotItem.requester ?? snapshotItem.actor;
			if (actor === requester) {
				throw new Error("自批违规：请求高风险操作的 requester 严禁自批");
			}
			const reqPrincipal = snapshotItem.requesterPrincipal ?? requester;
			if (approverPrincipal && reqPrincipal && approverPrincipal === reqPrincipal) {
				throw new Error("自批违规：同一主体 principal 严禁通过不同凭证自批");
			}
			if (actor === "system" || approverPrincipal === "system") {
				throw new Error("自批违规：自动化服务身份禁止代批 allow 操作");
			}

			// 旧 doc 缺 binding 不可 allow：字段整体缺失任何模式一律失效。
			// 与零值占位区分——demo 无 git 兼容是显式 unreliable 标记（全零 revision），
			// 仅 production 拒，不构成 production 后门。
			const missingBinding =
				!snapshotItem.gitRevision || !snapshotItem.repoIdentity || !snapshotItem.sessionIdentity ||
				!snapshotItem.tenantIdentity || !snapshotItem.policyHash || typeof snapshotItem.aclVersion !== "number";
			if (missingBinding) {
				invalidationReason = "审批记录缺少必需安全绑定（旧数据不可批准高风险）";
			} else if ((isProd || snapshotItem.isProduction) && (snapshotItem.gitRevision === "0".repeat(40) || snapshotItem.policyHash === "0".repeat(64))) {
				invalidationReason = "生产审批绑定不可靠（代码版本或策略哈希为零值占位）";
			}

			// 检查当前上下文双重核验
			if (!invalidationReason && options?.getContext) {
				try {
					const currentCtx = await options.getContext();
					if (!currentCtx || (isProd && !isContextReliable(currentCtx, true))) {
						invalidationReason = "当前工作区上下文不可靠（代码版本或仓库标识丢失）";
					} else {
						if (currentCtx.sessionIdentity !== snapshotItem.sessionIdentity) {
							invalidationReason = `会话标识不一致（当前 ${currentCtx.sessionIdentity} !== 审批时 ${snapshotItem.sessionIdentity}）`;
						} else if (currentCtx.tenantIdentity !== snapshotItem.tenantIdentity) {
							invalidationReason = `租户标识不一致（当前 ${currentCtx.tenantIdentity} !== 审批时 ${snapshotItem.tenantIdentity}）`;
						} else if (currentCtx.repoIdentity !== snapshotItem.repoIdentity) {
							invalidationReason = `仓库标识不一致（当前 ${currentCtx.repoIdentity} !== 审批时 ${snapshotItem.repoIdentity}）`;
						} else if (currentCtx.gitRevision !== snapshotItem.gitRevision) {
							invalidationReason = `代码版本漂移（当前 ${currentCtx.gitRevision} !== 审批时 ${snapshotItem.gitRevision}）`;
						} else if (currentCtx.policyHash !== snapshotItem.policyHash) {
							invalidationReason = "安全策略规则已更新";
						} else if (currentCtx.aclVersion !== snapshotItem.aclVersion) {
							invalidationReason = "会话成员权限已变更";
						}
					}
				} catch (err) {
					invalidationReason = `读取当前上下文失败：${err instanceof Error ? err.message : String(err)}`;
				}
			}
		}

		// 2. 状态机流转与审计成功先决保证
		let finalStatus: ApprovalStatus = "deny";
		let finalApprover = actor;
		let finalApproverPrincipal = approverPrincipal;

		if (decision === "allow") {
			if (invalidationReason) {
				finalStatus = "invalidated";
				finalApprover = "system";
			} else if (isAuthorized && !isAuthorized(snapshotItem.requester ?? snapshotItem.actor)) {
				finalStatus = "expired";
				finalApprover = "system";
			} else if (Date.now() >= snapshotItem.expiresAt) {
				finalStatus = "expired";
				finalApprover = actor;
			} else {
				finalStatus = "allow";
				finalApprover = actor;
				finalApproverPrincipal = approverPrincipal;
			}
		} else {
			finalStatus = Date.now() >= snapshotItem.expiresAt ? "expired" : "deny";
			finalApprover = actor;
			finalApproverPrincipal = approverPrincipal;
		}

		const itemSnapshot: Approval = {
			...snapshotItem,
			status: finalStatus,
			approver: finalApprover,
			approverPrincipal: finalApproverPrincipal,
		};

		// 3. 铁律：在成功可用 allow 之前保证审计成功！
		// 若审计失败，保守失效（invalidated），绝不能留下可用 allow。
		// 非 allow 决策在成功提交后再留痕（步骤 4.5）：输掉竞态的一方不留审计记录。
		if (finalStatus === "allow") {
			try {
				this.#audit(itemSnapshot);
			} catch (auditErr) {
				// 审计写入失败：在存储中将审批条目置为 invalidated（保守失效），唤醒 waiter(false)，并抛出错误
				await this.#root.commit(async (tx) => {
					const it = (await tx.doc(ApprovalsDoc, this.#root.id)).items.find((x) => x.id === id);
					if (it) {
						it.status = "invalidated";
						it.approver = "system";
					}
				}, BACKGROUND_CONTEXT);
				this.#waiters.get(id)?.(false);
				this.#emit({
					type: "approval.resolved",
					approvalId: id,
					decision: "deny",
					actor: "system",
				});
				throw new Error(`审计日志写入失败，安全阻断审批（fail-closed）：${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
			}
		}

		// 4. 持久化到存储
		const committedItem = await this.#root.commit(async (tx) => {
			const it = (await tx.doc(ApprovalsDoc, this.#root.id)).items.find((x) => x.id === id);
			if (!it || it.status !== "pending") return undefined;
			it.status = finalStatus;
			it.approver = finalApprover;
			it.approverPrincipal = finalApproverPrincipal;
			return JSON.parse(JSON.stringify(it)) as Approval;
		}, BACKGROUND_CONTEXT);

		if (!committedItem) {
			this.#waiters.get(id)?.(false);
			return undefined;
		}

		// 4.5 非 allow 决策：仅在成功赢得竞态后留痕，输家不留审计记录
		if (finalStatus !== "allow") {
			try {
				this.#audit({ ...itemSnapshot, status: committedItem.status, approver: committedItem.approver, approverPrincipal: committedItem.approverPrincipal });
			} catch {}
		}

		// 5. 广播事件与唤醒等待者
		try {
			this.#emit({
				type: "approval.resolved",
				approvalId: id,
				decision: committedItem.status === "allow" ? "allow" : "deny",
				actor: committedItem.approver ?? actor,
			});
			this.#waiters.get(id)?.(committedItem.status === "allow");
		} catch (emitErr) {
			if (committedItem.status === "allow") {
				await this.#root.commit(async (tx) => {
					const it = (await tx.doc(ApprovalsDoc, this.#root.id)).items.find((x) => x.id === id);
					if (it) {
						it.status = "invalidated";
						it.approver = "system";
					}
				}, BACKGROUND_CONTEXT);
				this.#waiters.get(id)?.(false);
				throw emitErr;
			}
		}

		if (invalidationReason) {
			throw new Error(`审批意图上下文已失效：${invalidationReason}`);
		}

		return committedItem;
	}

	async verifyApproved(
		callId: string,
		action: ActionDescriptor,
		currentContext?: ApprovalContext,
		isProduction = false,
	): Promise<{ ok: boolean; reason?: string }> {
		const item = await this.#root.commit(async (tx) => {
			const found = (await tx.doc(ApprovalsDoc, this.#root.id)).items.find((it) => it.callId === callId);
			return found ? JSON.parse(JSON.stringify(found)) as Approval : undefined;
		}, BACKGROUND_CONTEXT);
		if (!item) return { ok: false, reason: "未找到审批记录" };
		if (item.status !== "allow") return { ok: false, reason: `审批状态为 ${item.status}` };
		if (Date.now() >= item.expiresAt) return { ok: false, reason: "审批已过期" };

		const isProd = isProduction || !!item.isProduction || !!currentContext?.isProduction;

		// 旧 doc 缺 binding 不可 allow：字段整体缺失任何模式一律拒。
		const missingBinding =
			!item.gitRevision || !item.repoIdentity || !item.sessionIdentity ||
			!item.tenantIdentity || !item.policyHash || typeof item.aclVersion !== "number";
		if (missingBinding) return { ok: false, reason: "审批记录缺少必需安全绑定（旧数据不可批准高风险）" };
		// 零值占位仅 production 拒（demo 无 git 兼容靠 reliable:false 显式标识）。
		if (isProd && (item.gitRevision === "0".repeat(40) || item.policyHash === "0".repeat(64))) {
			return { ok: false, reason: "生产审批绑定不可靠（代码版本或策略哈希为零值占位）" };
		}

		// 意图一致性（tool、path、command 及完整 argsHash，防止同 tool/path 内容篡改）
		const rawArgs = action.args !== undefined ? action.args : { tool: action.tool, ...(action.path ? { path: action.path } : {}), ...(action.command ? { command: action.command } : {}) };
		const currentArgsHash = contentHash(rawArgs);
		if (item.argsHash !== currentArgsHash) {
			return { ok: false, reason: "工具参数与审批意图不符（参数篡改）" };
		}

		// 检查当前上下文可靠性与一致性
		if (isProd && (!currentContext || !isContextReliable(currentContext, true))) {
			return { ok: false, reason: "当前工作区上下文不可靠（无法核验代码版本或仓库绑定）" };
		}

		if (currentContext) {
			if (currentContext.sessionIdentity !== item.sessionIdentity) {
				return { ok: false, reason: `会话标识不一致（当前 ${currentContext.sessionIdentity} !== 审批时 ${item.sessionIdentity}）` };
			}
			if (currentContext.tenantIdentity !== item.tenantIdentity) {
				return { ok: false, reason: `租户标识不一致（当前 ${currentContext.tenantIdentity} !== 审批时 ${item.tenantIdentity}）` };
			}
			if (currentContext.repoIdentity !== item.repoIdentity) {
				return { ok: false, reason: `仓库标识不一致（当前 ${currentContext.repoIdentity} !== 审批时 ${item.repoIdentity}）` };
			}
			if (currentContext.gitRevision !== item.gitRevision) {
				return { ok: false, reason: `代码版本漂移（当前 ${currentContext.gitRevision} !== 审批时 ${item.gitRevision}）` };
			}
			if (currentContext.policyHash !== item.policyHash) {
				return { ok: false, reason: "安全策略规则已更新" };
			}
			if (currentContext.aclVersion !== item.aclVersion) {
				return { ok: false, reason: "会话成员权限已变更" };
			}
		}

		const requester = item.requester ?? item.actor;
		if (requester === item.approver || (item.requesterPrincipal && item.requesterPrincipal === item.approverPrincipal)) {
			return { ok: false, reason: "自批违规" };
		}

		return { ok: true };
	}
}
