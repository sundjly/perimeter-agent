// receive-pack 命令区预校验（合同 §B6；R51）。同一算法同时服务真实 route 与纯 unit：
// ①PktHeaderScanner——跨 chunk 增量 pkt 边界游标（保存真实 cursor/pending header/剩余
//   payload 长度；不滑动回退字节），定位 flush（len 0）精确一次，header 累计 ≤cap；
// ②parsePktCommands——fatal UTF-8、首条 \0 caps 截断、命令 grammar、refname 一把尺
//   （isValidRefname）、重复 ref、SHA-1 值域；
// ③gzip 语义（R-Q50-4）：整个 body 经单一 gunzip 连续流，header 在**解压后**字节上定位，
//   前缀+剩余解压字节以 identity 单次上游——本模块不负责 gunzip 本身，只消费解压后字节流。
// 所有拒绝形态返回结构化错误（调用方映射固定类别），不透传原始字节内容。
import { isSha1, isValidRefname } from "./grants.ts";

export const CMD_BAND_MAX_BYTES = 64 * 1024;
export const PKT_MAX = 65524; // 0xffff - 4

export type ScanState =
	| { phase: "need-more" }
	| { phase: "done"; headerLen: number } // headerLen 含 flush 的 0000（完整命令区）
	| { phase: "error"; reason: string };

/**
 * 跨 chunk 增量 pkt 头扫描器。push() 逐块喂入（解压后或 identity 原始字节）：
 * - 按 pkt 长度字段推进真实 cursor（pending 保存不完整头/载荷，绝不从 chunk 中部重新猜）；
 * - flush（0000）即 done，headerLen 精确包含 flush 4 字节一次；
 * - 累计 header > capBytes → overflow（64KiB 只限命令区，pack 不计）。
 */
export class PktHeaderScanner {
	private pending: Buffer = Buffer.alloc(0);
	private headerLen = 0;
	private state: ScanState = { phase: "need-more" };
	// R59-F5：strip-only 不支持参数属性——显式字段+普通赋值
	private readonly capBytes: number;

	constructor(capBytes: number = CMD_BAND_MAX_BYTES) {
		this.capBytes = capBytes;
	}

	get state$(): ScanState {
		return this.state;
	}

	/** 已缓冲的完整命令区字节（仅 phase=done 后有意义；不含 flush 之后的 pack 后缀） */
	header(): Buffer {
		return this.pending.subarray(0, this.headerLen);
	}

	/**
	 * R-Q52-1：flush 之后、同 chunk 内的 pack 尾字节。done 后调用；返回的 Buffer 与
	 * pending 共享内存，消费方必须在使用前取走（takeTail 语义见下）。
	 */
	tail(): Buffer {
		return this.pending.subarray(this.headerLen);
	}

	/** tail 的一次性取走（置空内部引用防二次读）；与 header() 配对使用 */
	takeTail(): Buffer {
		const t = this.pending.subarray(this.headerLen);
		this.pending = Buffer.alloc(0);
		return t;
	}

	push(chunk: Uint8Array): void {
		if (this.state.phase !== "need-more") return;
		let buf = this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, Buffer.from(chunk)]);
		// 若上一轮已缓冲超出 headerLen 的尾料（同 chunk 的 pack 后缀），只在命令区内继续扫描
		for (;;) {
			if (this.headerLen + 4 > buf.length) break; // 头字段不完整：等下一块
			const lenHex = buf.toString("latin1", this.headerLen, this.headerLen + 4);
			if (!/^[0-9a-f]{4}$/.test(lenHex)) {
				this.state = { phase: "error", reason: "pkt 长度字段非法" };
				return;
			}
			const len = parseInt(lenHex, 16);
			if (len === 0) {
				this.headerLen += 4; // flush 精确包含一次
				this.state = { phase: "done", headerLen: this.headerLen };
				this.pending = buf;
				return;
			}
			if (len < 4 || len > PKT_MAX) {
				this.state = { phase: "error", reason: "pkt 长度越界" };
				return;
			}
			if (this.headerLen + len > buf.length) break; // 载荷不完整：等下一块
			this.headerLen += len;
		}
		if (buf.length > this.capBytes) {
			this.state = { phase: "error", reason: "命令区超过 64KiB 上限" };
			return;
		}
		this.pending = buf;
	}
}

export interface PktCommand {
	oldSha: string;
	newSha: string;
	refname: string;
}

/**
 * R-Q52-1 同缝转发器（identity 形态；gzip 在解压后字节上同样使用）：转发序列 =
 * 完整命令区（含 flush）→ 同 chunk tail → 后续 reader 逐块（每 pull 一块，真背压）；
 * 转发字节流 == 原始（解压后）流，无丢失无重复。取消时 onCancel 收束底层
 * （reader.cancel/gunzip.destroy 由调用方注入），错误一次性上抛给流 error。
 */
export function createIdentityForward(
	header: Buffer,
	tail: Buffer,
	readChunk: () => Promise<{ done: boolean; value?: Uint8Array }>,
	onCancel: () => Promise<void> | void,
): ReadableStream<Uint8Array> {
	const prefix = new Uint8Array(header);
	const tailCopy = new Uint8Array(tail); // takeTail 后内部引用已置空；这里再拷贝隔离
	const parts: Uint8Array[] = [];
	if (prefix.length > 0) parts.push(prefix);
	if (tailCopy.length > 0) parts.push(tailCopy);
	let idx = 0;
	// R55-E：onCancel 是 async（cancelSource 两侧收束）；cancel 返回 promise 接住完成/
	// 拒绝（contain，不 unhandled）；readChunk 失败也走 onCancel 清底层后再 error。
	const runOnCancel = (): Promise<void> => Promise.resolve(onCancel()).catch(() => { /* 收束失败不掩盖原因 */ });
	return new ReadableStream<Uint8Array>({
		async pull(c) {
			if (idx < parts.length) {
				c.enqueue(parts[idx]!);
				idx += 1;
				return;
			}
			try {
				const { done, value } = await readChunk();
				if (done) c.close();
				else if (value) c.enqueue(value);
			} catch (e) {
				await runOnCancel(); // 读失败也清理底层（src/gunzip/rawReader）
				c.error(e instanceof Error ? e : new Error("forward source read failed"));
			}
		},
		cancel() {
			return runOnCancel();
		},
	});
}

export type ParseResult =
	| { ok: true; commands: PktCommand[] }
	| { ok: false; category: string }; // 固定安全类别（不透传原始行内容）

/**
 * 严格解析命令区（fatal UTF-8、首条 \0 caps、grammar、refname 一把尺、重复 ref、SHA-1）。
 * 失败返回固定类别——这些串直接进 deny summary/审计，不得含客户端可控原文。
 */
export function parsePktCommands(header: Buffer, fatalUtf8: TextDecoder): ParseResult {
	const commands: PktCommand[] = [];
	let i = 0;
	let first = true;
	const seen = new Set<string>();
	while (i + 4 <= header.length) {
		const lenHex = header.toString("latin1", i, i + 4);
		const len = parseInt(lenHex, 16);
		if (len === 0) break; // 尾部 flush（scanner 已含）
		if (len < 4 || len > PKT_MAX || i + len > header.length) return { ok: false, category: "拒绝：pkt 长度越界" };
		let line: string;
		try {
			line = fatalUtf8.decode(header.subarray(i + 4, i + len));
		} catch {
			return { ok: false, category: "拒绝：命令区编码非法（非 UTF-8）" };
		}
		i += len;
		line = line.endsWith("\n") ? line.slice(0, -1) : line;
		let payload = line;
		if (first) {
			const nul = payload.indexOf("\0");
			if (nul >= 0) payload = payload.slice(0, nul); // 首条可带 capabilities，截断
			first = false;
		} else if (payload.includes("\0")) {
			return { ok: false, category: "拒绝：非首条命令含 capabilities 段" };
		}
		const parts = payload.split(" ");
		if (parts.length !== 3) return { ok: false, category: "拒绝：命令格式非法（old SP new SP refname）" };
		const refname = parts[2]!;
		if (!isValidRefname(refname)) return { ok: false, category: "拒绝：refname 非法（Git 参照规则）" };
		if (seen.has(refname)) return { ok: false, category: "拒绝：重复 ref 命令" };
		seen.add(refname);
		if (!isSha1(parts[0]!) || !isSha1(parts[1]!)) return { ok: false, category: "拒绝：命令 SHA 值域非法（仅 SHA-1 仓库）" };
		commands.push({ oldSha: parts[0]!, newSha: parts[1]!, refname });
	}
	if (commands.length === 0) return { ok: false, category: "拒绝：空命令区（首包即 flush）" };
	return { ok: true, commands };
}
