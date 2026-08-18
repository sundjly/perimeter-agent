/**
 * 凭据与 PII 检测。
 *
 * **v1 刻意只做 audit-only：检测、告警、留痕，不改写流。**
 * 理由写在策略文档里，这里复述一遍以免后人「顺手」把它改成阻断模式：
 * 对代码流做正则/熵改写的误伤率很高 —— 一个 40 位的 git commit sha、
 * 一段 base64 编码的测试夹具、一个 UUID 常量，都会被熵检测命中。
 * 改写它们会直接破坏模型看到的代码，生成质量下降且极难排查。
 * 阻断/改写模式要等有了真实误报率数据再上。
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

const RULES: Rule[] = [
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
	// 形如 password= / api_key: 的赋值，值不是占位符
	{ kind: "credential-assignment", re: /\b(?:password|passwd|secret|api[_-]?key|token)["'\s]*[:=]["'\s]*(?!(?:xxx|placeholder|changeme|your))[A-Za-z0-9._~+/=-]{12,}/gi },
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
