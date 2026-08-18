import { StringDecoder } from "node:string_decoder";

/**
 * RPC 模式的 JSONL 帧解析。
 *
 * 两条协议硬约束（pi 官方文档明文，踩中会静默截断消息）：
 * 1. 只按 LF 切分。Node 的 readline 还会在 U+2028 / U+2029 处断行，
 *    而这两个码点在 JSON 字符串内部是合法的 —— 因此 readline 不合规。
 * 2. 容忍并剥掉尾部 CR。
 *
 * 另有一条与协议无关但同样致命的坑：stdout 的 chunk 边界会切断多字节
 * UTF-8 序列，直接 buffer.toString() 会产生替换字符。中文内容几乎必然踩中，
 * 所以走 StringDecoder 跨 chunk 保留半个字符。
 */
export class JsonlFramer {
	#decoder = new StringDecoder("utf8");
	#buf = "";

	/** 喂入一段 stdout，返回其中已完整的行（不含换行符，空行被跳过） */
	push(chunk: Buffer | string): string[] {
		this.#buf += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
		const lines: string[] = [];
		let i: number;
		while ((i = this.#buf.indexOf("\n")) >= 0) {
			const line = stripCr(this.#buf.slice(0, i));
			this.#buf = this.#buf.slice(i + 1);
			if (line) lines.push(line);
		}
		return lines;
	}

	/** 进程退出时调用：取出最后一条没有换行结尾的残留数据 */
	flush(): string[] {
		this.#buf += this.#decoder.end();
		const line = stripCr(this.#buf);
		this.#buf = "";
		return line ? [line] : [];
	}

	/** 尚未成帧的字符数，供上层判定对端是否发来超长行 */
	get pending(): number {
		return this.#buf.length;
	}
}

function stripCr(s: string): string {
	return s.endsWith("\r") ? s.slice(0, -1) : s;
}
