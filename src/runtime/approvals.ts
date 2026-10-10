import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Conversation } from "@earendil-works/pi-durable";
import type { ActionDescriptor, ClientEvent, Decision } from "../protocol/types.ts";

export type Approval = {
	id: string;
	callId: string;
	action: { tool: string; path?: string; command?: string };
	rule: string;
	reason: string;
	actor: string;
	expiresAt: number;
	status: "pending" | "allow" | "deny" | "expired";
	approver?: string;
}

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
		await this.#root.commit(async (tx) => {
			for (const item of (await tx.doc(ApprovalsDoc, this.#root.id)).items) {
				if (item.status === "pending") {
					item.status = "expired";
					this.#audit({ ...item, approver: "system" });
				}
			}
		}, BACKGROUND_CONTEXT);
	}

	async request(callId: string, action: ActionDescriptor, rule: string, reason: string, actor: string, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
		const item: Approval = {
			id: randomUUID(), callId, action: { tool: action.tool, ...(action.path ? { path: action.path } : {}), ...(action.command ? { command: action.command } : {}) },
			rule, reason, actor, expiresAt: Date.now() + timeoutMs, status: "pending",
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
			this.#emit({ type: "approval.request", approvalId: item.id, action: item.action, reason, expiresAt: item.expiresAt });
			if (signal.aborted) abort();
		});
	}

	async decide(id: string, decision: Decision, actor: string): Promise<Approval | undefined> {
		const item = await this.#root.commit(async (tx) => {
			const item = (await tx.doc(ApprovalsDoc, this.#root.id)).items.find((item) => item.id === id);
			if (!item || item.status !== "pending") return undefined;
			item.status = Date.now() >= item.expiresAt ? "expired" : decision;
			item.approver = actor;
			return JSON.parse(JSON.stringify(item)) as Approval;
		}, BACKGROUND_CONTEXT);
		if (item) {
			let approved = false;
			try {
				this.#audit(item);
				this.#emit({ type: "approval.resolved", approvalId: id, decision: item.status === "allow" ? "allow" : "deny", actor });
				approved = item.status === "allow";
			} finally {
				this.#waiters.get(id)?.(approved);
			}
		}
		return item;
	}
}
