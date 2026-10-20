import type { ClientCommand } from "./types.ts";

/** 入站命令的运行时校验。`as ClientCommand` 不是校验：类型、长度、枚举、未知字段都在这里拒绝 */
export const PROMPT_MAX_BYTES = 64 * 1024;
const ID_MAX = 256;
const KEYS: Record<string, string[]> = {
	prompt: ["type", "text", "requestId"],
	steer: ["type", "text", "requestId"],
	share: ["type", "actor", "role"],
	unshare: ["type", "actor"],
	abort: ["type"],
	approve: ["type", "approvalId", "decision"],
};

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** 合法返回命令，非法返回原因（不回显输入内容） */
export function parseCommand(raw: unknown, maxPromptBytes = PROMPT_MAX_BYTES): { ok: true; cmd: ClientCommand } | { ok: false; error: string } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "命令必须是对象" };
	const c = raw as Record<string, unknown>;
	const allowed = typeof c.type === "string" && Object.hasOwn(KEYS, c.type) ? KEYS[c.type] : undefined;
	if (!allowed) return { ok: false, error: "未知命令类型" };
	if (Object.keys(c).some((key) => !allowed.includes(key))) return { ok: false, error: "命令含未知字段" };
	if (c.type === "prompt" || c.type === "steer") {
		if (typeof c.text !== "string" || !c.text.trim() || Buffer.byteLength(c.text) > maxPromptBytes) return { ok: false, error: "消息为空或超过长度上限" };
		if (!str(c.requestId, ID_MAX)) return { ok: false, error: "requestId 无效" };
	} else if (c.type === "share" || c.type === "unshare") {
		if (!str(c.actor, ID_MAX)) return { ok: false, error: "共享对象无效" };
		if (c.type === "share" && c.role !== "editor" && c.role !== "approver" && c.role !== "viewer") return { ok: false, error: "共享角色无效" };
	} else if (c.type === "approve") {
		if (!str(c.approvalId, ID_MAX) || (c.decision !== "allow" && c.decision !== "deny")) return { ok: false, error: "审批命令无效" };
	}
	return { ok: true, cmd: c as unknown as ClientCommand };
}
