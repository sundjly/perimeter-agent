import { RULES } from "../modelgw/secrets.ts";
import type { AuditEntry, AuditKind } from "./log.ts";

/**
 * 审计日志 → SIEM。
 *
 * 这一层的核心不是格式转换，是**边界**：导出会把数据送出 Data Plane，
 * 而 SIEM 通常在客户网络的另一头、甚至是托管服务。所以这里按**白名单**
 * 挑字段，而不是把 AuditEntry 整个铺开 —— 后者意味着以后往审计里加一个
 * 字段，就悄悄多导出一份东西。
 *
 * `command` 是唯一需要判断的字段。审计里存它的原文是有意的（SOC 分析师
 * 看到 `argsHash: 3f9a…` 什么也做不了），但那份原文同样承载源码与凭据 ——
 * heredoc 写文件、`curl -H "Authorization: …"` 都在里面。所以导出默认
 * **不带 command**，要带必须显式打开，并且知道自己在把什么送出去。
 */

export type SiemFormat = "ecs" | "cef";

/**
 * 命令原文的导出档位。
 *
 * - `off`（默认）：完全不带命令，**summary 也要重建** —— 见下。
 * - `redacted`：带命令，但**已知形态**的凭据被打码（复用模型网关那套正则）。
 *   两个局限必须对客户说清楚，不能笼统说成「已脱敏」：挡不住 heredoc 里的
 *   源码，也挡不住不符合已知形态的凭据（自定义前缀、短于 16 字符的 token）。
 * - `raw`：原样带出。你应当知道 SIEM 在谁的网络里。
 */
export type CommandMode = "off" | "redacted" | "raw";

export interface ExportOptions {
	/** 见 CommandMode。默认 off */
	command?: CommandMode;
	/** 产品名，进 CEF 头与 ECS 的 service 字段 */
	product?: string;
}

/**
 * summary 对 bash 事件由 summarizeAction 生成，形如
 * `${tool}: ${命令前 120 字符}` —— **它本身就承载命令原文**。
 * 所以只把 `command` 字段关掉是不够的：那 120 个字符恰好覆盖命令最敏感的
 * 开头（`curl -H "Authorization: …"`、heredoc 的首行都在里面）。
 * 这是「默认不导出命令」这条保证的真正落点。
 */
function exportSummary(entry: AuditEntry, mode: CommandMode): string {
	if (!entry.command) return entry.summary; // 非命令类事件，summary 本就安全
	if (mode === "raw") return entry.summary;
	if (mode === "redacted") return redactSecrets(entry.summary);
	return entry.tool ? `${entry.tool}（命令未导出）` : "（命令未导出）";
}

/** 复用模型网关那套凭据正则，把命中处就地打码 */
function redactSecrets(text: string): string {
	let out = text;
	for (const rule of RULES) {
		rule.re.lastIndex = 0;
		out = out.replace(new RegExp(rule.re.source, rule.re.flags), (m) =>
			m.length <= 12 ? `${m.slice(0, 2)}***` : `${m.slice(0, 4)}***${m.slice(-4)}`,
		);
	}
	return out;
}

function exportCommand(entry: AuditEntry, mode: CommandMode): string | null {
	if (!entry.command || mode === "off") return null;
	return mode === "redacted" ? redactSecrets(entry.command) : entry.command;
}

/** 事件严重度。SIEM 侧的告警规则通常直接建在这个字段上 */
function severityOf(entry: AuditEntry): number {
	if (entry.kind === "error") return 6;
	// 审批被拒要排在策略拦截之前判定 —— 反过来的话 deny 那条先命中，
	// 这个分支永远取不到 6，而 severityOf 是告警规则的输入
	if (entry.kind === "approval.decision") return entry.verdict === "deny" ? 6 : 4;
	if (entry.verdict === "deny") return 8;
	if (entry.kind === "approval.request") return 5;
	if (entry.kind === "git.push") return 5;
	return 2;
}

/** ECS 的 event.type，Elastic 的检测规则最常用的维度 */
function eventType(entry: AuditEntry): string {
	if (entry.verdict === "deny") return "denied";
	if (entry.verdict === "allow") return "allowed";
	if (entry.kind === "session.start") return "start";
	if (entry.kind === "session.end") return "end";
	if (entry.kind === "repo.clone") return "creation";
	return "info";
}

/** ECS 的 event.category，让 SIEM 的既有仪表盘能直接用上 */
const CATEGORY: Record<AuditKind, string> = {
	"session.start": "session",
	"session.end": "session",
	prompt: "web",
	"tool.call": "process",
	"tool.result": "process",
	// 只有 deny 进 intrusion_detection（见 categoryOf）—— 放行事件每次工具调用
	// 都有一条，全塞进去会把 SOC 的 IDS 仪表盘淹没
	"policy.verdict": "process",
	// 审批是**授权**决策，不是身份认证。落在 authentication 会把它混进
	// 登录失败告警的基线里；ECS 为此有 iam
	"approval.request": "iam",
	"approval.decision": "iam",
	usage: "web",
	"repo.clone": "file",
	"git.push": "file",
	error: "process",
};

/**
 * Elastic Common Schema。字段名对齐 ECS 8.x 的常用子集，
 * 自有字段放 `perimeter.*` 命名空间下 —— 不占用 ECS 的保留前缀。
 */
export function toEcs(entry: AuditEntry, opts: ExportOptions = {}): Record<string, unknown> {
	const out: Record<string, unknown> = {
		"@timestamp": entry.at,
		// ECS 里唯一的必填字段，Elastic 的内置规则据它判断文档是否 ECS 兼容
		"ecs.version": "8.11.0",
		// deny 走 alert：Elastic Security 的告警面板正是按 event.kind 取事件的
		"event.kind": entry.verdict === "deny" ? "alert" : "event",
		"event.type": eventType(entry),
		"event.category": entry.verdict === "deny" ? "intrusion_detection" : (CATEGORY[entry.kind] ?? "process"),
		"event.action": entry.kind,
		"event.severity": severityOf(entry),
		"event.sequence": entry.seq,
		"event.outcome": entry.verdict === "deny" ? "failure" : entry.ok === false ? "failure" : "success",
		message: exportSummary(entry, opts.command ?? "off"),
		"service.name": opts.product ?? "perimeter-agent",
		"user.name": entry.actor,
		"perimeter.session_id": entry.sessionId,
		// 哈希链：SIEM 侧可以据此发现「日志被改过」，这是导出的主要价值之一
		"perimeter.hash": entry.hash,
		"perimeter.prev_hash": entry.prevHash,
	};
	// 下面全部按存在与否决定，不写 undefined —— SIEM 的字段映射不喜欢空值
	if (entry.repo) out["perimeter.repo"] = entry.repo;
	if (entry.team) out["perimeter.team"] = entry.team;
	if (entry.approver) out["perimeter.approver"] = entry.approver;
	if (entry.tool) out["process.name"] = entry.tool;
	if (entry.path) out["file.path"] = entry.path;
	if (entry.verdict) out["perimeter.verdict"] = entry.verdict;
	if (entry.rule) out["rule.name"] = entry.rule;
	if (entry.argsHash) out["perimeter.args_hash"] = entry.argsHash;
	if (entry.diffHash) out["perimeter.diff_hash"] = entry.diffHash;
	if (entry.durationMs !== undefined) out["event.duration"] = entry.durationMs * 1_000_000; // ECS 用纳秒
	if (entry.tokensTotal !== undefined) out["perimeter.tokens_total"] = entry.tokensTotal;
	if (entry.cost !== undefined) out["perimeter.cost"] = entry.cost;
	if (entry.exitCode !== undefined) out["process.exit_code"] = entry.exitCode;
	if (entry.callId) out["process.entity_id"] = entry.callId; // SOC 靠它把 call 与 result 配对
	out["perimeter.schema_version"] = entry.schemaVersion;
	// 默认不带：命令原文同样承载源码与凭据
	const cmd = exportCommand(entry, opts.command ?? "off");
	if (cmd) out["process.command_line"] = cmd;
	return out;
}

/**
 * CEF 头里的这些字符必须转义，否则字段边界会被内容撑破。
 * **换行尤其要处理**：CEF 是一行一条，头里嵌一个换行就把一条日志
 * 拆成两条 —— 后半条会被 SIEM 当成格式错误丢掉，而丢掉的可能正是
 * 那条 deny 记录。
 */
function cefHeader(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

/**
 * CEF 扩展值。`=` 是键值分隔符、换行是记录分隔符，都要转义。
 * `|` 在扩展部分严格说不是分隔符，但各家 SIEM 解析器对它的处理并不一致 ——
 * summary 与 sessionId 都可能带它，转掉成本为零。
 */
function cefValue(s: string): string {
	return s
		.replace(/\\/g, "\\\\")
		.replace(/=/g, "\\=")
		.replace(/\|/g, "\\|")
		.replace(/[\r\n]+/g, " ");
}

/**
 * ArcSight CEF。Splunk 与多数商业 SIEM 都能直接吃。
 * 格式：CEF:0|Vendor|Product|Version|SignatureID|Name|Severity|Extension
 */
export function toCef(entry: AuditEntry, opts: ExportOptions = {}): string {
	const product = opts.product ?? "perimeter-agent";
	const ext: string[] = [
		`rt=${new Date(entry.at).getTime()}`,
		`suser=${cefValue(entry.actor)}`,
		`cs1Label=sessionId cs1=${cefValue(entry.sessionId)}`,
		`cs2Label=hash cs2=${cefValue(entry.hash)}`,
		`cn1Label=seq cn1=${entry.seq}`,
	];
	if (entry.tool) ext.push(`cs3Label=tool cs3=${cefValue(entry.tool)}`);
	if (entry.path) ext.push(`fname=${cefValue(entry.path)}`);
	if (entry.verdict) ext.push(`act=${cefValue(entry.verdict)}`);
	if (entry.rule) ext.push(`cs4Label=rule cs4=${cefValue(entry.rule)}`);
	if (entry.approver) ext.push(`duser=${cefValue(entry.approver)}`);
	if (entry.verdict === "deny" || entry.ok === false) ext.push("outcome=failure");
	// 与 ECS 对齐：CEF 侧此前少了这几个，用 CEF 的客户拿不到哈希链与归属上下文
	ext.push(`cs6Label=prevHash cs6=${cefValue(entry.prevHash)}`);
	if (entry.repo) ext.push(`cs7Label=repo cs7=${cefValue(entry.repo)}`);
	if (entry.team) ext.push(`cs8Label=team cs8=${cefValue(entry.team)}`);
	if (entry.callId) ext.push(`cs9Label=callId cs9=${cefValue(entry.callId)}`);
	if (entry.exitCode !== undefined) ext.push(`cn2Label=exitCode cn2=${entry.exitCode}`);
	if (entry.durationMs !== undefined) ext.push(`cn3Label=durationMs cn3=${entry.durationMs}`);
	const cmd = exportCommand(entry, opts.command ?? "off");
	if (cmd) ext.push(`cs5Label=command cs5=${cefValue(cmd)}`);

	return [
		"CEF:0",
		"Perimeter",
		cefHeader(product),
		"1",
		cefHeader(entry.kind),
		cefHeader(exportSummary(entry, opts.command ?? "off")),
		String(severityOf(entry)),
		ext.join(" "),
	].join("|");
}

export function formatEntry(entry: AuditEntry, format: SiemFormat, opts: ExportOptions = {}): string {
	return format === "cef" ? toCef(entry, opts) : JSON.stringify(toEcs(entry, opts));
}
