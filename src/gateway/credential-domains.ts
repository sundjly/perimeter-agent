// 凭据域互异校验（H1/R-Q50-5）：所有秘值按**实际字节**（Buffer）两两比较——不是 hex/
// 字符串形态比较，同字节不同编码的碰撞也要拒。真实 Gateway 构造路径调用本模块；
// 纯 unit 同缝复用（不写第二把参考尺）。

export interface CredentialDomainEntry {
	/** 域名（错误消息用固定类别，不回显值） */
	name: string;
	/** 秘值原文：string（按 UTF-8 编码取字节）或 Buffer（原字节） */
	value: Buffer | string;
}

export class CredentialDomainError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CredentialDomainError";
	}
}

export function toDomainBytes(value: Buffer | string): Buffer {
	return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
}

/** 两个秘值是否**字节级相同**（跨 string/Buffer 形态） */
export function sameCredentialBytes(a: Buffer | string, b: Buffer | string): boolean {
	const ba = toDomainBytes(a);
	const bb = toDomainBytes(b);
	if (ba.length !== bb.length) return false;
	return Buffer.compare(ba, bb) === 0;
}

/**
 * 两两互异断言：任意两个域字节相同即抛（错误只含域名，不含值）。
 * 允许空值跳过（空 = 未配置该域）；同名条目出现两次且值相同也拒（自比较不豁免）。
 */
export function assertDistinctCredentialDomains(entries: CredentialDomainEntry[]): void {
	const present = entries.filter((e) => {
		const b = toDomainBytes(e.value);
		return b.length > 0;
	});
	for (let i = 0; i < present.length; i++) {
		for (let j = i + 1; j < present.length; j++) {
			if (sameCredentialBytes(present[i]!.value, present[j]!.value)) {
				throw new CredentialDomainError(`凭据域碰撞：${present[i]!.name} 与 ${present[j]!.name} 字节相同（凭据域必须分开）`);
			}
		}
	}
}

/** masterKey 强度：≥32 字节（H1：强度与互异同门，真实构造路径必调） */
export function assertMasterKeyStrength(key: Buffer | string): Buffer {
	const b = toDomainBytes(key);
	if (b.length < 32) throw new CredentialDomainError(`masterKey 强度不足：${b.length}B < 32B`);
	return b;
}
