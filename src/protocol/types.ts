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
	| { type: "agent.start" }
	| { type: "agent.end"; willRetry: boolean }
	| { type: "agent.settled" }
	/** 长时间静默期的解释（重试 / 上下文压缩），否则界面会无理由卡住几十秒 */
	| { type: "agent.status"; phase: AgentPhase; detail: string }
	| { type: "message.start"; messageId: string; role: "user" | "assistant" }
	/** delta：增量，前端 append */
	| { type: "message.text"; messageId: string; delta: string }
	/** delta：增量，前端 append */
	| { type: "message.thinking"; messageId: string; delta: string }
	| { type: "message.end"; messageId: string; text: string }
	| { type: "tool.start"; callId: string; action: ActionDescriptor; summary: string }
	/** output：累计快照，前端 replace（不是增量） */
	| { type: "tool.progress"; callId: string; output: string }
	| { type: "tool.end"; callId: string; ok: boolean; output: string }
	| { type: "approval.request"; approvalId: string; action: ActionDescriptor; reason: string; expiresAt: number }
	| { type: "approval.resolved"; approvalId: string; decision: Decision; actor: string }
	| { type: "policy.denied"; action: ActionDescriptor; rule: string; reason: string }
	| { type: "audit.entry"; entry: AuditEntryView }
	/** 累计快照，前端 replace（不是增量，累加会得到天文数字） */
	| { type: "usage"; usage: Usage }
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
	| { type: "prompt"; text: string }
	| { type: "steer"; text: string }
	| { type: "abort" }
	| { type: "approve"; approvalId: string; decision: Decision }
	| { type: "resume"; since: number };

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
}
