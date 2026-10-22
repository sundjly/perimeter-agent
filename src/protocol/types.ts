/**
 * 自有事件协议 —— 浏览器与网关之间的唯一契约。
 *
 * 铁律：前端永远不直接消费 pi 的 RPC 事件格式。Phase 1 走 RPC 网关、
 * Phase 2 迁到 AgentHarness 直连时，只有 translate.ts 被替换，本文件与前端零改动。
 * 因此本文件不引用任何 pi 类型。
 */

/** 网关 → 浏览器 */
export type ClientEvent =
	| { type: "session.ready"; sessionId: string; workspace: string; model: string | null }
	| { type: "session.state"; streaming: boolean; messageCount: number; model: string | null }
	| { type: "session.snapshot"; view: SessionView }
	| { type: "inbox.update"; items: { id: string; mode: string }[] }
	| { type: "session.presence"; participants: Participant[]; role?: Role }
	| { type: "agent.start" }
	| { type: "agent.end"; willRetry: boolean }
	| { type: "agent.settled" }
	/** 长时间静默期的解释（重试 / 上下文压缩），否则界面会无理由卡住几十秒 */
	| { type: "agent.status"; phase: AgentPhase; detail: string }
	| { type: "message.start"; messageId: string; role: "user" | "assistant"; actor?: string; order?: number }
	/** delta：增量，前端 append */
	| { type: "message.text"; messageId: string; delta: string }
	/** delta：增量，前端 append */
	| { type: "message.thinking"; messageId: string; delta: string }
	| { type: "message.end"; messageId: string; text: string; thinking?: string; entryId?: string; order?: number }
	| { type: "tool.start"; callId: string; action: ActionDescriptor; summary: string }
	/** output：累计快照，前端 replace（不是增量）。S5b：超过单项上限时服务端截断并带标记；
	 * 事件上的 originalBytes 只指本事件 output 字段的原始字节（快照 ToolView 上是各展示字段之和） */
	| { type: "tool.progress"; callId: string; output: string; truncated?: boolean; originalBytes?: number }
	| { type: "tool.end"; callId: string; ok: boolean; output: string; action?: ActionDescriptor; order?: number; truncated?: boolean; originalBytes?: number }
	| { type: "approval.request"; approvalId: string; action: ActionDescriptor; reason: string; expiresAt: number; actor?: string; argsHash?: string }
	| { type: "approval.resolved"; approvalId: string; decision: Decision; actor: string }
	| { type: "policy.denied"; action: ActionDescriptor; rule: string; reason: string; callId?: string }
	| { type: "audit.entry"; entry: AuditEntryView }
	/** 累计快照，前端 replace（不是增量，累加会得到天文数字） */
	| { type: "usage"; usage: Usage }
	/** S3b：显式创建的定向应答（只发回发起连接，不广播、不带 seq）。replayed=true 表示
	 * 命中既有收据原样返回；stage/outcome 如实透传收据（outcome_unknown 不当成功） */
	| { type: "session.created"; operationId: string; requestId: string; sessionId: string; stage: string; outcome: string; replayed: boolean }
	/** S5a：历史分页应答。只定向发回发起连接（不广播）；items 按「旧→新」排列，
	 * total/oldestIncluded 是服务端当前权威元信息，cursor 为空表示已到最早 */
	| { type: "history.page"; items: MessageView[]; total: number; oldestIncluded: number; cursor: string | null }
	| { type: "error"; code: ErrorCode; message: string };

/**
 * ClientEvent 的全部 type 值，运行时可枚举。
 *
 * 存在的理由：`web/` 是零构建原生 JS，不在 tsconfig 的 include 里，
 * 类型系统够不着它 —— 往 ClientEvent 加事件而忘了前端，浏览器会静默丢弃。
 * 测试要拿这份清单去核对前端的覆盖，而 ClientEvent 是纯类型、运行时不存在。
 *
 * 下面的双向穷尽性检查保证这个数组与联合类型同步：漏一个或多一个都编译不过。
 * 这比从源码正则提取可靠得多 —— 正则会漏掉不合它字符集的命名
 * （`quota_warning`、`toolV2.start`），而那种漏检是静默的。
 */
export const CLIENT_EVENT_TYPES = [
	"session.ready",
	"session.state",
	"session.snapshot",
	"session.presence",
	"inbox.update",
	"agent.start",
	"agent.end",
	"agent.settled",
	"agent.status",
	"message.start",
	"message.text",
	"message.thinking",
	"message.end",
	"tool.start",
	"tool.progress",
	"tool.end",
	"approval.request",
	"approval.resolved",
	"policy.denied",
	"audit.entry",
	"usage",
	"session.created",
	"history.page",
	"error",
] as const;

// 双向包含：数组少了某个事件、或含有联合里没有的值，这两行之一会报错
type _EventsCovered = ClientEvent["type"] extends (typeof CLIENT_EVENT_TYPES)[number] ? true : never;
type _NoExtras = (typeof CLIENT_EVENT_TYPES)[number] extends ClientEvent["type"] ? true : never;
const _eventsCovered: _EventsCovered = true;
const _noExtras: _NoExtras = true;
void _eventsCovered;
void _noExtras;

export type AgentPhase = "retrying" | "compacting" | "idle";

export type ErrorCode = "aborted" | "agent_error" | "extension_error" | "command_failed" | "policy_error";

/** 浏览器 → 网关 */
export type ClientCommand =
	| { type: "prompt"; text: string; requestId: string }
	| { type: "steer"; text: string; requestId: string }
	| { type: "share"; actor: string; role: "editor" | "approver" | "viewer" }
	| { type: "unshare"; actor: string }
	| { type: "abort" }
	| { type: "approve"; approvalId: string; decision: Decision }
	/** S3b：显式创建会话。operationId 是幂等键（按 principal 作用域隔离）；requestHash
	 * 是客户端对创建内容的指纹（缺省按空内容记账），同键不同内容固定拒绝 */
	| { type: "create"; operationId: string; requestHash?: string }
	/** S5a：向更早方向翻页。cursor 由服务端签发（绑定 sessionId 的不透明 HMAC 串），
	 * limit 可省略（取服务端 tail 项数上限）。只读命令：任何成员角色可发 */
	| { type: "history.page"; sessionId: string; cursor: string; limit?: number };

export type Decision = "allow" | "deny";

/**
 * token 计量。cacheRead 通常是 coding agent 的大头，
 * 按团队配额与计费都依赖它，不能只记 input/output。
 */
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
	cacheHitRate: number | null;
}

/** 策略引擎与审计共用的动作描述 —— 与具体执行后端无关 */
export interface ActionDescriptor {
	/** 工具名，如 bash / write / edit / read */
	tool: string;
	/** bash 的命令行；文件类工具为 undefined */
	command?: string;
	/** 文件类工具的目标路径；bash 为 undefined */
	path?: string;
	/**
	 * 原始参数，仅供策略引擎与审计在服务端使用。
	 * 不下发浏览器：write/edit 的参数含整份文件内容与全部改动文本。
	 */
	args?: unknown;
}

/** 推给前端的审计条目视图（完整条目在审计日志里，这里只给可展示字段） */
export interface AuditEntryView {
	seq: number;
	at: string;
	kind: string;
	summary: string;
	verdict?: string;
	actor?: string;
	approver?: string;
}

export type Role = "owner" | "editor" | "approver" | "viewer";
export interface Participant { actor: string; role: Role; clients: number }
/** S5a：单条消息的截断标记——文本/思考超过单项上限时按确定性规则裁剪，原始字节长度保留 */
export interface MessageView { id: string; order?: number; role: "user" | "assistant"; text: string; thinking: string; actor?: string; truncated?: boolean; originalBytes?: number }
/** S5a/S5a2：快照与分页应答携带的历史元信息。oldestIncluded 是尾页首条在服务端
 * 权威 messages 数组中的下标（常态追加只增；durable 压缩会 splice 前缀并前置摘要
 * 重构数组，此时旧游标按锚点核对固定失效，不静默错位）；cursor 指向「比它更早」
 * 的一页，由服务端签发并绑定 sessionId+边界锚点，客户端只能原样回传 */
export interface SessionHistoryMeta { total: number; oldestIncluded: number; cursor: string | null }
/** S5b：快照 tools 出口裁剪的元信息（与 SessionHistoryMeta 同构）。本轮不做 tools 分页：
 * 游标机制绑定 messages 数组结构（锚点=消息 id），tools 语义不同（含进行中的
 * MAX_SAFE_INTEGER order 项、与 durable 压缩的交互不同），元信息先行、分页待需要时另设计 */
export interface SessionToolsMeta { total: number; oldestIncluded: number }
/** S5b：单条工具视图的截断标记 —— output/command/path 各展示字段 ≤64KiB，任一超限
 * 确定性截断；originalBytes 是各展示字段未裁前的字节和（与 MessageView 同口径） */
export interface ToolView { callId: string; order?: number; action: ActionDescriptor; output: string; ok?: boolean; truncated?: boolean; originalBytes?: number }
export interface SessionView {
	sessionId: string; model: string | null; streaming: boolean; messages: MessageView[]; tools: ToolView[];
	inbox: { id: string; mode: string }[]; approvals: { approvalId: string; action: ActionDescriptor; reason: string; actor?: string; expiresAt: number; argsHash?: string }[];
	participants: Participant[]; usage: Usage; audit: AuditEntryView[]; role: Role;
	/** S5a：快照为有界尾页时必带；全量快照（旧服务端）缺省 */
	history?: SessionHistoryMeta;
	/** S5b：tools 出口裁剪元信息（total=权威 tools 总数，oldestIncluded=尾页首项下标）。
	 * 旧服务端缺省；客户端不得假设每次快照都携带（与 history 同一漂移语义） */
	toolsHistory?: SessionToolsMeta;
}
