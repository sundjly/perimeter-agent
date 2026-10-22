import type { ClientCommand } from "./types.ts";

/** 入站命令的运行时校验。`as ClientCommand` 不是校验：类型、长度、枚举、未知字段都在这里拒绝 */
export const PROMPT_MAX_BYTES = 64 * 1024;
const ID_MAX = 256;
/** S3b：operationId 直接参与收据文件名，限死字符集（不含点/斜杠，路径不可由客户端字符串构造） */
const OPERATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** S3b：requestHash 是不透明指纹（客户端自选摘要算法），只限字符集与长度 */
const REQUEST_HASH = /^[A-Za-z0-9_-]{1,128}$/;
/** S5a：sessionId 与网关 SESSION_ID 同尺（不参与路径，但保持同一字符集口径） */
const SESSION_ID_SAFE = /^[A-Za-z0-9_-]{1,64}$/;
/** S5a/S5a2：cursor v2 形如 v2.<idx>.<锚消息id>.<hmac32>。锚 id 本就是客户端可见的
 * MessageView.id，随游标携带不算新增信息泄漏；形状只验字符集，语义（含锚与当前
 * 权威数组是否一致）在服务端核验 */
const CURSOR_SAFE = /^v2\.[0-9]{1,12}\.[A-Za-z0-9_-]{1,64}\.[0-9a-f]{32}$/;
/** S5a：单页项数上限（与默认 tail 项数同值；服务端还会按会话配置取更严） */
export const HISTORY_MAX_PAGE_ITEMS = 200;
const KEYS: Record<string, string[]> = {
	prompt: ["type", "text", "requestId"],
	steer: ["type", "text", "requestId"],
	share: ["type", "actor", "role"],
	unshare: ["type", "actor"],
	abort: ["type"],
	approve: ["type", "approvalId", "decision"],
	create: ["type", "operationId", "requestHash"],
	"history.page": ["type", "sessionId", "cursor", "limit"],
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
	} else if (c.type === "create") {
		if (typeof c.operationId !== "string" || !OPERATION_ID.test(c.operationId)) return { ok: false, error: "operationId 无效" };
		if (c.requestHash !== undefined && (typeof c.requestHash !== "string" || !REQUEST_HASH.test(c.requestHash))) return { ok: false, error: "requestHash 无效" };
	} else if (c.type === "history.page") {
		// S5a：cursor 必填（无游标的分页语义含混，不如让客户端带上次应答里的 cursor）
		if (typeof c.sessionId !== "string" || !SESSION_ID_SAFE.test(c.sessionId)) return { ok: false, error: "sessionId 无效" };
		if (typeof c.cursor !== "string" || !CURSOR_SAFE.test(c.cursor)) return { ok: false, error: "cursor 无效" };
		if (c.limit !== undefined && (typeof c.limit !== "number" || !Number.isSafeInteger(c.limit) || c.limit < 1 || c.limit > HISTORY_MAX_PAGE_ITEMS)) return { ok: false, error: "limit 无效" };
	}
	return { ok: true, cmd: c as unknown as ClientCommand };
}
