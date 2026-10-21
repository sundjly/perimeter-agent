/**
 * 凭据与 PII 检测。
 *
 * 模式与历史（事实口径，非 v1 原样）：v1 只做 audit-only（检测/告警/留痕不改写流），
 * 理由见策略文档；B3/R40 起网关已有生产默认 **block** 模式（server.ts：完整 body 在任何
 * 上游副作用前扫描，命中即 403），audit 仅限显式获批低敏部署且扫描器故障仍 fail-closed。
 * 改写（而非阻断）模式仍需真实误报率数据支撑，暂不引入。
 * 误报控制是规则设计的硬约束：40 位 commit sha、base64 夹具、UUID 常量都不得误伤。
 */

export interface SecretFinding {
	kind: string;
	/** 命中位置的前后文，本身不含完整凭据 */
	hint: string;
}

interface Rule {
	kind: string;
	re: RegExp;
}

/** 凭据形态的正则表。审计导出层复用它做脱敏 —— 同一份规则，两处用 */
export const RULES: Rule[] = [
	{ kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
	{ kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
	{ kind: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
	{ kind: "openai-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
	{ kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
	{ kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
	{ kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ kind: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
	{ kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
	{ kind: "authorization-header", re: /\b[Aa]uthorization["'\s:]+(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g },
	// 形如 password= / api_key: 的赋值，值不是占位符。
	// B3：允许 JSON 转义形态 —— 请求体是 JSON 时引号以 `\"` 出现，
	// 不容忍反斜杠会让 `"password":"..."` 这类真实载体漏检（tests/modelgw.test.ts 对照集固定）。
	{ kind: "credential-assignment", re: /\b(?:password|passwd|secret|api[_-]?key|token)["'\\\s]*[:=]["'\\\s]*(?!(?:xxx|placeholder|changeme|your))[A-Za-z0-9._~+/=-]{12,}/gi },
];

/** 扫描文本，返回命中项。绝不返回凭据本身 —— 告警会进日志与 SIEM。 */
export function scanSecrets(text: string, limit = 20): SecretFinding[] {
	const found: SecretFinding[] = [];
	for (const rule of RULES) {
		rule.re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = rule.re.exec(text)) !== null) {
			found.push({ kind: rule.kind, hint: redact(m[0]) });
			if (found.length >= limit) return found;
			if (m.index === rule.re.lastIndex) rule.re.lastIndex += 1;
		}
	}
	return found;
}

/** 只留头尾各 4 个字符，其余打码 —— 告警要能定位，但不能自己变成泄漏源 */
export function redact(s: string): string {
	if (s.length <= 12) return `${s.slice(0, 2)}***`;
	return `${s.slice(0, 4)}***${s.slice(-4)}（${s.length} 字符）`;
}

// ── R41/R43：完整 body 语义解码扫描 ─────────────────────
// 裸文本扫描对 JSON 的 \uXXXX 逃逸不可见（上游 JSON 解码后会收到明文 secret）——
// 因此必须先严格解码再扫描，同时保留 raw 扫描。所有异常形态 fail-closed。
// R43（R-Q42-1）：结构化 body 里 key 与 value 是 JSON.parse 后的两个独立字符串，
// 各自独立扫描互相不可见（逃逸 key 无 [:=]、值无凭据前缀形态 → 双层全空 → 200 透传）。
// 因此解码扫描必须把「同一对象条目内 key→value 的语义关联」纳入判定：同条目 key 命中
// 凭据名时，对冒号后紧邻原始位置上的本条目字符串 value 合成赋值串过规则（只拼本条目，
// 绝不跨字段/兄弟字段/数组元素拼接）。JSON.parse 会把重复键塌缩为最后一处 —— 塌缩不得
// 当作「完整原始 body 已扫描」的证明，故重复解码 key（含转义重复键）一律保守拒（fail-
// closed 403，任务允许的保守拒歧义路径），token 流另设独立数量上限。

/** 已知规则类别（响应/审计只允许这些固定类别，不接受任意 raw kind） */
export const KNOWN_KINDS: ReadonlySet<string> = new Set(RULES.map((r) => r.kind));

/** 解码遍历上限：超过即 fail-closed（不无界遍历、不对无界嵌套赌运气） */
export const MAX_JSON_DEPTH = 64;
export const MAX_JSON_NODES = 8192;

export class BodyScanError extends Error {
	readonly category: "invalid_utf8" | "invalid_json" | "json_bounds_exceeded" | "json_duplicate_key" | "scan_invalid_return";
	constructor(category: BodyScanError["category"]) {
		super(`body scan fail-closed: ${category}`);
		this.name = "BodyScanError";
		this.category = category;
	}
}

/** 严格 UTF-8 解码：有损替换序列（U+FFFD 注入）一律拒绝，不给混淆编码留通道 */
export function decodeStrictUtf8(buf: Buffer): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buf);
	} catch {
		throw new BodyScanError("invalid_utf8");
	}
}

/**
 * 扫描器返回形状校验（对注入实现与默认实现同一把尺）：
 * 必须是 {kind,hint} 数组；kind ∈ KNOWN_KINDS（不收任意 raw kind）；hint 必须是短字符串
 * （脱敏产物；超长/非串=非法返回）。非法一律抛 BodyScanError —— 由网关 fail-closed。
 */
export function validateFindings(findings: unknown): SecretFinding[] {
	if (!Array.isArray(findings)) throw new BodyScanError("scan_invalid_return");
	const out: SecretFinding[] = [];
	for (const f of findings) {
		if (typeof f !== "object" || f === null) throw new BodyScanError("scan_invalid_return");
		const kind = (f as { kind?: unknown }).kind;
		const hint = (f as { hint?: unknown }).hint;
		if (typeof kind !== "string" || !KNOWN_KINDS.has(kind)) throw new BodyScanError("scan_invalid_return");
		if (typeof hint !== "string" || hint.length === 0 || hint.length > 128) throw new BodyScanError("scan_invalid_return");
		out.push({ kind, hint });
	}
	return out;
}

/**
 * 解码后语义扫描：
 * 1. JSON.parse 成功 + 有界遍历（深度≤64、节点≤8192，超限 fail-closed）——结构合法性与
 *    预算守门；但塌缩后的文档**不**当作完整原始 body 已扫描的证明；
 * 2. 线性 token 扫描（extractJsonStringTokens）：直接从原始 body 文本按 JSON 字符串文法
 *    提取全部字符串出现（含原始 raw 位置），每个字符串独立过规则；token 数超
 *    MAX_JSON_NODES → fail-closed（重复键可让 token 数超塌缩文档节点数，不能拿塌缩
 *    文档的 nodes 充当原始 token 流的上界）；
 * 3. 同条目 key→value 语义关联：凭据名 key 与**冒号后紧邻原始位置上的字符串 value**
 *    合成赋值串 `${key}: ${value}` 过规则 —— 只拼本条目自身，绝不跨字段/兄弟字段/数组
 *    元素拼接（token 序相邻不等于 own value：[{"password":null},"12+字符串"] 不得命中）;
 * 4. 保守拒歧义：解码后重复 key（含转义重复键）→ fail-closed 403。重复键经 JSON.parse
 *    塌缩会让前条值不可见，token 流也无真实 bounds 兜底——原任务明确允许保守拒歧义。
 * value 仅限字符串形态（数组/对象/null/number/bool 不在此判定范围）。
 */
export function scanJsonDecoded(raw: string, scan: (s: string) => SecretFinding[] = scanSecrets): SecretFinding[] {
	let doc: unknown;
	try {
		doc = JSON.parse(raw);
	} catch {
		throw new BodyScanError("invalid_json");
	}
	let nodes = 0;
	const walk = (node: unknown, depth: number): void => {
		if (depth > MAX_JSON_DEPTH || ++nodes > MAX_JSON_NODES) throw new BodyScanError("json_bounds_exceeded");
		if (Array.isArray(node)) {
			for (const v of node) walk(v, depth + 1);
			return;
		}
		if (typeof node === "object" && node !== null) {
			for (const v of Object.values(node)) walk(v, depth + 1);
		}
	};
	walk(doc, 0);

	// token 扫描（有界）：同一对象内真重复键保守拒（塌缩让前条值不可见，任务允许保守拒）
	// + 原始结构深度与 token 累计数上限都在抽取过程中当场强制（非抽取后判断）。
	// 嵌套同名键（如各层 type）合法。
	const tokens = extractJsonStringTokens(raw, {
		maxDepth: MAX_JSON_DEPTH,
		maxTokens: MAX_JSON_NODES,
		onFail: (kind) => {
			throw new BodyScanError(kind);
		},
	});
	const findings: SecretFinding[] = [];
	const push = (s: string): void => {
		findings.push(...validateFindings(scan(s)));
	};
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		push(t.text);
		const next = tokens[i + 1];
		// own value 判定：紧邻 key 冒号后的原始位置上就是一个字符串开头（不是 token 序相邻）。
		// 不再用窄名册筛选 key：每个 own pair 直接以合成串过完整现有 RULES —— 与 raw 规则的
		// 词边界语义天然一致（my-password/auth-token/authorization+Bearer 可达，xpassword/
		// 无关 pass+word 跨字段不误拼：合成只引入本条目自己的 `: ` 分隔，名册词边界由规则自判）。
		if (t.isKey && next && !next.isKey && next.rawStart === t.valueAt) {
			push(`${t.text}: ${next.text}`);
		}
	}
	// 同一命中可能被「独立扫描 + 合成串扫描」重复报告（值内含完整凭据形态时）——按 kind+hint 去重
	const seen = new Set<string>();
	return findings.filter((f) => {
		const k = `${f.kind}\u0000${f.hint}`;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

export interface JsonStringToken {
	/** 解码后的字符串内容 */
	text: string;
	/** 是否为对象条目的 key（其后跳过空白是 `:`；数组元素/独立值为 false） */
	isKey: boolean;
	/** 开引号在原始 body 中的位置（own value 判定用） */
	rawStart: number;
	/** key 专属：冒号后第一个非空白字符的位置（own value 必须从这里开始） */
	valueAt: number;
}

/**
 * 线性提取原始 JSON 文本中的全部字符串出现（保序、含原始位置、带对象嵌套栈）。
 * 同一对象内的真重复 key 经 onFail("json_duplicate_key") 上报（JSON.parse 塌缩会让前条
 * 值不可见，保守拒）；原始结构深度超 maxDepth 或 token 累计数达 maxTokens 时在抽取过程中
 * 当场经 onFail("json_bounds_exceeded") 上报（不先完整提取再判断——重复键炸弹不能绕过
 * 原始资源界）。
 * 前提：调用方已用 JSON.parse 验证过结构合法（转义序列合法性由其保证）。
 * O(n) 单遍、栈式非递归 —— 预算由 maxDepth/maxTokens 把守。
 */
export function extractJsonStringTokens(
	raw: string,
	bounds?: { maxDepth: number; maxTokens?: number; onFail: (kind: "json_duplicate_key" | "json_bounds_exceeded") => void },
): JsonStringToken[] {
	const tokens: JsonStringToken[] = [];
	const n = raw.length;
	const skipWs = (i: number): number => {
		let k = i;
		while (k < n && (raw[k] === " " || raw[k] === "\t" || raw[k] === "\n" || raw[k] === "\r")) k++;
		return k;
	};
	// 对象嵌套栈：每层 object 维护自己的 key 集合（同一对象真重复才拒，嵌套同名键合法）
	const stack: { isObject: boolean; keys: Set<string> }[] = [];
	let i = 0;
	while (i < n) {
		const c = raw[i];
		if (c === "{") {
			stack.push({ isObject: true, keys: new Set() });
			if (bounds && stack.length > bounds.maxDepth) bounds.onFail("json_bounds_exceeded");
			i++;
			continue;
		}
		if (c === "[") {
			stack.push({ isObject: false, keys: new Set() });
			if (bounds && stack.length > bounds.maxDepth) bounds.onFail("json_bounds_exceeded");
			i++;
			continue;
		}
		if (c === "}" || c === "]") {
			stack.pop();
			i++;
			continue;
		}
		if (c !== '"') {
			i++;
			continue;
		}
		const rawStart = i;
		let decoded = "";
		let j = i + 1;
		while (j < n && raw[j] !== '"') {
			const ch = raw[j];
			if (ch === "\\") {
				const esc = raw[j + 1];
				if (esc === "u") {
					const code = parseInt(raw.slice(j + 2, j + 6), 16);
					if (code >= 0xd800 && code <= 0xdbff && raw[j + 6] === "\\" && raw[j + 7] === "u") {
						const low = parseInt(raw.slice(j + 8, j + 12), 16);
						if (low >= 0xdc00 && low <= 0xdfff) {
							decoded += String.fromCharCode(code, low);
							j += 12;
							continue;
						}
					}
					decoded += String.fromCharCode(code);
					j += 6;
					continue;
				}
				decoded += esc === "n" ? "\n" : esc === "t" ? "\t" : esc === "r" ? "\r" : esc === "b" ? "\b" : esc === "f" ? "\f" : (esc ?? "");
				j += 2;
				continue;
			}
			decoded += ch;
			j++;
		}
		// key 判定：闭引号后跳过空白是 `:`；valueAt=冒号后第一个非空白位置（own value 错）
		const afterClose = skipWs(j + 1);
		const isKey = raw[afterClose] === ":";
		const valueAt = isKey ? skipWs(afterClose + 1) : -1;
		if (isKey && bounds) {
			const top = stack[stack.length - 1];
			if (top && top.isObject) {
				if (top.keys.has(decoded)) bounds.onFail("json_duplicate_key");
				top.keys.add(decoded);
			}
		}
		// token 累计上限在抽取过程中当场强制：达上限即 fail，不先完整提取再判断
		// （重复键炸弹不能绕过原始资源界）。
		if (bounds?.maxTokens !== undefined && tokens.length >= bounds.maxTokens) {
			bounds.onFail("json_bounds_exceeded");
		}
		tokens.push({ text: decoded, isKey, rawStart, valueAt });
		i = j + 1;
	}
	return tokens;
}
