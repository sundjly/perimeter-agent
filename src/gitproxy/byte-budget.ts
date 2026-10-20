// receive 字节预算纯计数缝（R58-4 同缝）：header、同 chunk tail、后续 PACK 的 decoded 与
// raw（identity 时 raw==decoded）全部经同一实现累计与检查——初段/EOF/流式任何时点越限
// 即报，不做整包缓存/spool。生产 gitproxy 与 resourcefree unit 消费同一实现。

export type ByteBudgetVerdict = "ok" | "over-decoded" | "over-raw";

export class ByteBudget {
	#maxDecodedBytes: number;
	#maxRawBytes: number;
	#decoded = 0;
	#raw = 0;
	#overDecoded = false;
	#overRaw = false;

	// R59-F5：strip-only 不支持参数属性——显式字段+普通赋值
	constructor(maxDecodedBytes: number, maxRawBytes: number) {
		this.#maxDecodedBytes = maxDecodedBytes;
		this.#maxRawBytes = maxRawBytes;
	}

	get decodedTotal(): number {
		return this.#decoded;
	}

	get rawTotal(): number {
		return this.#raw;
	}

	get overDecoded(): boolean {
		return this.#overDecoded;
	}

	get overRaw(): boolean {
		return this.#overRaw;
	}

	/**
	 * 累计并即时判定。decoded：解压后字节（identity 时 == raw）；raw：identity 原始字节
	 *（gzip 的 raw 由泵独立累计，不进本类，避免双轨不同源）。任何一次 add 越限后 verdict
	 * 粘滞（后续仍 over，防边界抖动漏检）。
	 */
	add(decodedBytes: number, rawBytes: number): ByteBudgetVerdict {
		this.#decoded += decodedBytes;
		this.#raw += rawBytes;
		if (this.#decoded > this.#maxDecodedBytes) this.#overDecoded = true;
		if (this.#raw > this.#maxRawBytes) this.#overRaw = true;
		if (this.#overDecoded) return "over-decoded";
		if (this.#overRaw) return "over-raw";
		return "ok";
	}

	/** 一次性导入既有累计（如 header+tail 初段），带即时判定 */
	seed(decodedBytes: number, rawBytes: number): ByteBudgetVerdict {
		return this.add(decodedBytes, rawBytes);
	}
}
