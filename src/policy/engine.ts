import { parse as parseYaml } from "yaml";
import type { ActionDescriptor } from "../protocol/types.ts";
import { commandGlobToRegex, normalizePath, pathGlobToRegex } from "./glob.ts";

export type Verdict =
	| { decision: "allow" }
	| { decision: "deny"; rule: string; reason: string }
	| { decision: "require_approval"; rule: string; reason: string };

/** 会话上下文。两个字段必填：缺上下文时静默放行等于策略故障变成放行。 */
export interface PolicyContext {
	repo: string;
	team: string;
}

interface Matcher {
	src: string;
	re: RegExp;
}

interface CompiledRule {
	name: string;
	tool: string;
	repos: string[] | null;
	teams: string[] | null;
	denyPaths: Matcher[];
	denyPatterns: Matcher[];
	approvalPatterns: Matcher[];
	approvalPaths: Matcher[];
}

const RULE_KEYS = new Set([
	"name",
	"tool",
	"repos",
	"teams",
	"deny_paths",
	"deny_patterns",
	"require_approval",
	"require_approval_paths",
]);

/**
 * 策略引擎 v1。
 *
 * 挂载点是 durable beforeTool（见 runtime/perimeter-extension.ts）。
 * durable 的钩子抛错即 block；evaluate 仍兜住异常，
 * 异常时返回 deny —— 策略引擎自身故障不能变成放行。
 * 与之相对，fromYaml 刻意 fail-fast：策略文件写错要在启动时炸掉，
 * 而不是带着一条静默失效的规则跑起来。
 *
 * 关于这一层能力的边界，必须说清楚，销售材料里也不要夸大：
 * - 命令模式匹配是**启发式**，不是安全边界。shell 的求值方式（变量展开、
 *   base64 解码、别名、间接调用）注定了黑名单可被绕过。
 * - 真正的安全边界是另外三条：egress 默认 deny、凭据不进沙箱、每会话独占沙箱。
 *   本引擎的价值在于「拦下不可逆操作交人工确认」与「留痕」，不在于挡住有意的攻击者。
 * - deny_paths 只对**带 path 参数的工具**生效。bash 里的
 *   `echo x > .github/workflows/ci.yml` 本引擎看不见路径，只能靠命令模式兜。
 *   路径规则要真正统一，得等 Phase 2 的 RemoteExecutionEnv 在 FS 层收口。
 * - 路径规则按仓库相对路径的形状书写；工作区之外的绝对路径要靠沙箱挂载限制，
 *   不是靠这里的规则。
 */
export class PolicyEngine {
	#rules: CompiledRule[];
	#egressAllowlist: string[];
	#readOnlyTools: Set<string>;

	private constructor(rules: CompiledRule[], egressAllowlist: string[], readOnlyTools: Set<string>) {
		this.#rules = rules;
		this.#egressAllowlist = egressAllowlist;
		this.#readOnlyTools = readOnlyTools;
	}

	static fromYaml(text: string): PolicyEngine {
		const doc = (parseYaml(text) ?? {}) as Record<string, unknown>;
		const rawRules = doc.rules ?? [];
		if (!Array.isArray(rawRules)) throw new Error("policy: rules 必须是数组");
		const rules = rawRules.map((r, i) => compile(r, i));
		return new PolicyEngine(rules, readEgress(doc.egress), new Set(readStringList(doc.read_only_tools, "read_only_tools")));
	}

	/** 沙箱 NetworkPolicy 的唯一事实来源，由部署清单生成器消费 */
	get egressAllowlist(): string[] {
		return [...this.#egressAllowlist];
	}

	get ruleCount(): number {
		return this.#rules.length;
	}

	evaluate(action: ActionDescriptor, ctx: PolicyContext): Verdict {
		try {
			return this.#evaluate(action, ctx);
		} catch (err) {
			return {
				decision: "deny",
				rule: "policy-engine-failure",
				reason: `策略求值失败，按拒绝处理：${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	#evaluate(action: ActionDescriptor, ctx: PolicyContext): Verdict {
		const applicable = this.#rules.filter((r) => matchesScope(r, action.tool, ctx));
		const commands = action.command ? splitCommand(action.command) : [];
		// 只读工具不受路径规则约束：否则 agent 每次读 package.json 都要人批一次，
		// 几轮之后操作员就会无脑点同意 —— 审批疲劳本身就是安全失效。
		const path = action.path && !this.#readOnlyTools.has(action.tool) ? normalizePath(action.path) : null;

		// deny 优先于 require_approval：一条规则拒绝就不再问人
		for (const r of applicable) {
			const hit = firstHit(r.denyPatterns, commands) ?? (path ? firstMatch(r.denyPaths, path) : null);
			if (hit) return { decision: "deny", rule: r.name, reason: `命中拒绝规则：${hit}` };
		}
		for (const r of applicable) {
			const hit = firstHit(r.approvalPatterns, commands) ?? (path ? firstMatch(r.approvalPaths, path) : null);
			if (hit) return { decision: "require_approval", rule: r.name, reason: `不可逆或高风险操作：${hit}` };
		}
		return { decision: "allow" };
	}
}

function compile(raw: unknown, index: number): CompiledRule {
	if (typeof raw !== "object" || raw === null) throw new Error(`policy: rules[${index}] 必须是对象`);
	const r = raw as Record<string, unknown>;
	// 拒绝未知键：`deny_pattern` 少写一个 s 会让整条规则静默失效，这类错误必须在启动时暴露
	for (const key of Object.keys(r)) {
		if (!RULE_KEYS.has(key)) throw new Error(`policy: rules[${index}] 含未知字段 ${key}`);
	}
	const tool = r.tool === undefined ? "*" : String(r.tool);
	return {
		name: typeof r.name === "string" ? r.name : `rule-${index + 1}(${tool})`,
		tool,
		repos: r.repos === undefined ? null : readStringList(r.repos, `rules[${index}].repos`),
		teams: r.teams === undefined ? null : readStringList(r.teams, `rules[${index}].teams`),
		denyPaths: compileList(r.deny_paths, `rules[${index}].deny_paths`, pathGlobToRegex),
		denyPatterns: compileList(r.deny_patterns, `rules[${index}].deny_patterns`, commandGlobToRegex),
		approvalPatterns: compileList(r.require_approval, `rules[${index}].require_approval`, commandGlobToRegex),
		approvalPaths: compileList(r.require_approval_paths, `rules[${index}].require_approval_paths`, pathGlobToRegex),
	};
}

function compileList(raw: unknown, where: string, toRegex: (glob: string) => RegExp): Matcher[] {
	return readStringList(raw, where).map((src) => ({ src, re: toRegex(src) }));
}

function readStringList(raw: unknown, where: string): string[] {
	if (raw === undefined || raw === null) return [];
	// 漏写 `- ` 时 YAML 给出的是字符串，直接当数组用会退化成逐字符匹配
	if (!Array.isArray(raw)) throw new Error(`policy: ${where} 必须是数组`);
	return raw.map((v, i) => {
		if (typeof v !== "string" || v.length === 0) throw new Error(`policy: ${where}[${i}] 必须是非空字符串`);
		return v;
	});
}

/** egress allowlist 是真正的安全边界，因此校验最严：宁可启动失败也不放行通配 */
function readEgress(raw: unknown): string[] {
	if (raw === undefined || raw === null) return [];
	if (typeof raw !== "object") throw new Error("policy: egress 必须是对象");
	const list = readStringList((raw as { deny_all_except?: unknown }).deny_all_except, "egress.deny_all_except");
	for (const host of list) {
		if (host === "*" || host === "0.0.0.0/0" || host === "::/0" || host.includes(" ")) {
			throw new Error(`policy: egress.deny_all_except 不接受放通一切的条目：${host}`);
		}
	}
	return list;
}

function matchesScope(r: CompiledRule, tool: string, ctx: PolicyContext): boolean {
	if (r.tool !== "*" && r.tool !== tool) return false;
	if (r.repos && !r.repos.includes(ctx.repo)) return false;
	if (r.teams && !r.teams.includes(ctx.team)) return false;
	return true;
}

/**
 * 把一条 shell 命令拆成「整条 + 各个子命令」。
 * `npm test && git push` 里的 git push 必须能被 `git push*` 命中，
 * 而 `curl x | sh` 这类模式又要求保留整条来匹配管道。两者都要。
 */
function splitCommand(command: string): string[] {
	const whole = collapse(command);
	const parts = whole
		.split(/\|\||&&|[;\n|&(){}]/)
		.map((p) => stripLeadingTokens(collapse(p)))
		.filter((s) => s.length > 0);
	const all = [whole, stripLeadingTokens(whole), ...parts];
	return [...new Set(all)].filter((s) => s.length > 0);
}

/**
 * 折叠空白，并给 shell 操作符补上两侧空格。
 * `curl x|bash` 与 `curl x | bash` 必须等价 —— 否则规则命中与否取决于
 * 模型有没有打空格，而 `>/dev/tcp/...` 这种不带空格的写法才是常见形式。
 */
function collapse(s: string): string {
	return s
		.replace(/(\|\||&&|[|&;><])/g, " $1 ")
		.trim()
		.replace(/\s+/g, " ");
}

/**
 * 剥掉不改变命令语义的前导 token，让 `^cmd` 锚定的模式不被绕过。
 * `AWS_PROFILE=prod aws s3 rb ...` 与 `sudo git push` 在 CI 场景里极常见，
 * 且通常并无恶意 —— 漏掉它们意味着该问人的时候没问。
 */
const PREFIX_TOKENS = new Set(["sudo", "env", "time", "nohup", "command", "exec", "xargs", "nice", "stdbuf"]);

function stripLeadingTokens(cmd: string): string {
	let out = cmd;
	for (;;) {
		const next = out.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)/, "");
		const head = next.split(" ")[0] ?? "";
		if (next !== out) {
			out = next;
			continue;
		}
		if (PREFIX_TOKENS.has(head)) {
			out = next.slice(head.length).trim();
			continue;
		}
		return out;
	}
}

/** 返回命中的**模式**而不是命令原文：审计要回答的是「哪条规则拦的」 */
function firstHit(matchers: Matcher[], commands: string[]): string | null {
	for (const cmd of commands) {
		for (const m of matchers) {
			if (m.re.test(cmd)) return m.src;
		}
	}
	return null;
}

function firstMatch(matchers: Matcher[], path: string): string | null {
	return matchers.find((m) => m.re.test(path))?.src ?? null;
}
