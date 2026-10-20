// receive-pack 命令区 parser/stream-chunk 纯 unit（R51 H2 同缝模块；resource-free：
// 零网络/零 timer/零 FS/零子进程）。与真实 route 消费同一 PktHeaderScanner/parsePktCommands。
// 本文件为源码交付，未运行（R51 执行禁令；由 coor 新轮预审实际脚本后执行）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { PktHeaderScanner, parsePktCommands, createIdentityForward, CMD_BAND_MAX_BYTES, PKT_MAX } from "../src/gitproxy/receive-pack.ts";

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });
const pkt = (payload: string, caps = ""): Buffer => {
	const line = caps ? `${payload}\0${caps}\n` : `${payload}\n`;
	const len = 4 + Buffer.byteLength(line);
	return Buffer.from(len.toString(16).padStart(4, "0") + line, "latin1");
};
const FLUSH = Buffer.from("0000", "latin1");
const CMD = `${"a".repeat(40)} ${"b".repeat(40)} refs/heads/main`;

function feedInChunks(scanner: PktHeaderScanner, chunks: Buffer[]): void {
	for (const c of chunks) scanner.push(c);
}

test("scanner：单 chunk 完整命令区+flush 精确一次；same-chunk pack 后缀不丢", () => {
	const s = new PktHeaderScanner();
	const pack = Buffer.from("PACK-bytes-after-flush");
	feedInChunks(s, [Buffer.concat([pkt(CMD, "report-status"), FLUSH, pack])]);
	assert.equal(s.state$.phase, "done");
	if (s.state$.phase !== "done") return;
	assert.equal(s.state$.headerLen, pkt(CMD, "report-status").length + 4, "headerLen 含 flush 4 字节一次");
	const header = s.header();
	assert.ok(header.subarray(-4).equals(FLUSH), "flush 包含在 header 内（不剥离）");
});

test("scanner：任意 len 字段/chunk 分割（含头字段跨 chunk、payload 跨 chunk）都正确定位", () => {
	const whole = Buffer.concat([pkt(CMD, "report-status"), pkt(`${"c".repeat(40)} ${"d".repeat(40)} refs/heads/dev`), FLUSH]);
	// 逐字节切分（最恶劣分割）都收敛到同一结论
	for (const splitAt of [1, 2, 3, 4, 5, 7, 17]) {
		const s = new PktHeaderScanner();
		const chunks: Buffer[] = [];
		for (let i = 0; i < whole.length; i += splitAt) chunks.push(whole.subarray(i, i + splitAt));
		feedInChunks(s, chunks);
		assert.equal(s.state$.phase, "done", `split=${splitAt}`);
		if (s.state$.phase === "done") assert.equal(s.state$.headerLen, whole.length, `split=${splitAt} flush 后无丢失`);
	}
});

test("scanner：create/delete 全零 OID 不被误认 flush（按 pkt 边界推进，非字节搜索）", () => {
	const zeroOld = pkt(`${"0".repeat(40)} ${"b".repeat(40)} refs/heads/new-branch`);
	const zeroNew = pkt(`${"a".repeat(40)} ${"0".repeat(40)} refs/heads/delete-me`);
	const s = new PktHeaderScanner();
	feedInChunks(s, [Buffer.concat([zeroOld, zeroNew, FLUSH])]);
	assert.equal(s.state$.phase, "done");
	if (s.state$.phase !== "done") return;
	assert.equal(s.state$.headerLen, zeroOld.length + zeroNew.length + 4, "两个全零 OID 命令后 flush 才终结");
});

test("scanner：header 累计 ≤64KiB（pack 字节不计入）；超限即 error（上游零消费语义由调用方 cancel）", () => {
	const s = new PktHeaderScanner();
	const big = pkt(`${"a".repeat(40)} ${"b".repeat(40)} refs/heads/big`); // ~90B
	const count = Math.floor((CMD_BAND_MAX_BYTES - 4) / big.length) + 1;
	const chunks: Buffer[] = [];
	for (let i = 0; i < count; i++) chunks.push(big);
	feedInChunks(s, chunks);
	assert.equal(s.state$.phase, "error");
	if (s.state$.phase === "error") assert.match(s.state$.reason, /64KiB/);
});

test("scanner：非 hex 长度字段/超 PKT_MAX 即语法 error", () => {
	const bad = new PktHeaderScanner();
	feedInChunks(bad, [Buffer.concat([pkt(CMD), Buffer.from("zzzz")])]);
	assert.equal(bad.state$.phase, "error");
	const big2 = new PktHeaderScanner();
	feedInChunks(big2, [Buffer.concat([pkt(CMD), Buffer.from(`${(PKT_MAX + 10).toString(16)}x`)])]);
	assert.equal(big2.state$.phase, "error");
});

test("parser：合法命令（首条 caps/多条）→ commands；grammar 逐字段保真", () => {
	const header = Buffer.concat([pkt(CMD, "report-status agent=git/2.40"), pkt(`${"c".repeat(40)} ${"d".repeat(40)} refs/heads/dev`), FLUSH]);
	const r = parsePktCommands(header, fatalUtf8);
	assert.ok(r.ok);
	if (r.ok) {
		assert.equal(r.commands.length, 2);
		assert.deepEqual(r.commands[0], { oldSha: "a".repeat(40), newSha: "b".repeat(40), refname: "refs/heads/main" });
		assert.equal(r.commands[1]!.refname, "refs/heads/dev");
	}
});

test("parser：create/delete 全零 OID 命令合法（SHA-1 值域内 40 hex）", () => {
	const header = Buffer.concat([pkt(`${"0".repeat(40)} ${"b".repeat(40)} refs/heads/new`), FLUSH]);
	const r = parsePktCommands(header, fatalUtf8);
	assert.ok(r.ok);
});

test("parser：null/throw 防线——非首条 NUL、无效 UTF-8、重复 ref、refname 非法（a^b 等）、SHA 值域", () => {
	// 非首条含 NUL
	const nul = Buffer.concat([pkt(CMD, "caps"), pkt(`${"c".repeat(40)} ${"d".repeat(40)} refs/heads/x\0extra`), FLUSH]);
	assert.ok(!parsePktCommands(nul, fatalUtf8).ok);
	// 无效 UTF-8（refname 内 0xFF）
	const raw = pkt("placeholder");
	const len = 4 + 3;
	const badUtf8 = Buffer.concat([Buffer.from(len.toString(16).padStart(4, "0"), "latin1"), Buffer.from([0x72, 0xff, 0x0a]), pkt(CMD, "caps"), FLUSH]);
	assert.ok(!parsePktCommands(badUtf8, fatalUtf8).ok);
	void raw;
	// 重复 ref
	const dup = Buffer.concat([pkt(CMD), pkt(CMD.replace("a".repeat(40), "c".repeat(40))), FLUSH]);
	const rd = parsePktCommands(dup, fatalUtf8);
	assert.ok(!rd.ok);
	if (!rd.ok) assert.equal(rd.category, "拒绝：重复 ref 命令");
	// refname 非法：a^b（H2 指认旧行内正则漏 refs/heads/a^b）、分量 .lock、@{、~
	for (const bad of ["refs/heads/a^b", "refs/heads/.locked", "refs/heads/x.lock", "refs/@{x", "refs/heads/a~b", "refs//x", "refs/heads/a..b"]) {
		const h = Buffer.concat([pkt(`${"a".repeat(40)} ${"b".repeat(40)} ${bad}`), FLUSH]);
		const rr = parsePktCommands(h, fatalUtf8);
		assert.ok(!rr.ok, `refname ${bad} 必须拒`);
	}
	// SHA 值域（39 位/非 hex）
	const short = Buffer.concat([pkt(`${"a".repeat(39)} ${"b".repeat(40)} refs/heads/x`), FLUSH]);
	assert.ok(!parsePktCommands(short, fatalUtf8).ok);
	// 空命令区
	assert.ok(!parsePktCommands(FLUSH, fatalUtf8).ok);
});

// ── R-Q52-1 转发等价（生产同缝 createIdentityForward；gzip 解码后同函数）──

/** 模拟 src.read()：按给定 wire chunks 顺序逐块返回（可任意切分）；记录 cancel */
function chunkReader(chunks: Uint8Array[]): { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel: () => Promise<void>; canceled: boolean } {
	let i = 0;
	let canceled = false;
	return {
		get canceled() { return canceled; },
		read: async () => {
			if (i >= chunks.length) return { done: true, value: undefined };
			const v = chunks[i]!;
			i += 1;
			return { done: false, value: v };
		},
		cancel: async () => { canceled = true; },
	};
}

async function drainForward(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
	const reader = stream.getReader();
	const parts: Uint8Array[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) parts.push(value);
	}
	return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

test("forwarder：command+flush+PACK 同 chunk —— forwarded byte-for-byte == 原始流（无丢尾）", async () => {
	const cmd = pkt(CMD, "report-status");
	const pack = Buffer.from("PACK-".repeat(40)); // 同 chunk flush 后的 pack 尾
	const original = Buffer.concat([cmd, FLUSH, pack]);
	const scanner = new PktHeaderScanner();
	scanner.push(original);
	assert.equal(scanner.state$.phase, "done");
	const r = chunkReader([]); // 无后续 wire chunk（全部在首 chunk）
	const fwd = createIdentityForward(Buffer.from(scanner.header()), scanner.takeTail(), r.read, r.cancel);
	const out = await drainForward(fwd);
	assert.ok(out.equals(original), `转发流必须等于原始流（got ${out.length}B want ${original.length}B）`);
});

test("forwarder：任意 chunk 切分 + flush 在 chunk 边界 —— 等价且 header/tail/后reader 各一次", async () => {
	const cmd = pkt(CMD);
	const cmd2 = pkt(`${"c".repeat(40)} ${"d".repeat(40)} refs/heads/dev`);
	const pack = Buffer.from("PACKDATA".repeat(100));
	const original = Buffer.concat([cmd, cmd2, FLUSH, pack]);
	for (const split of [1, 2, 3, 5, 13, 102]) {
		const wire: Buffer[] = [];
		for (let i = 0; i < original.length; i += split) wire.push(original.subarray(i, Math.min(i + split, original.length)));
		const scanner = new PktHeaderScanner();
		for (const c of wire) scanner.push(c);
		if (scanner.state$.phase !== "done") { assert.fail(`split=${split} scanner 必须 done`); }
		const header = Buffer.from(scanner.header());
		const tail = scanner.takeTail();
		const consumed = header.length + tail.length;
		// 剩余 wire chunk = 从 consumed 起（生产 reader 只给未消费部分）
		const rest: Buffer[] = [];
		let acc = 0;
		for (const c of wire) {
			if (acc + c.length <= consumed) { acc += c.length; continue; }
			if (acc < consumed) { rest.push(c.subarray(consumed - acc)); acc += c.length; continue; }
			rest.push(c);
			acc += c.length;
		}
		const r = chunkReader(rest);
		const fwd = createIdentityForward(header, tail, r.read, r.cancel);
		const out = await drainForward(fwd);
		assert.ok(out.equals(original), `split=${split} 转发流必须等于原始流（got ${out.length}B）`);
	}
});

test("forwarder：header 小 + 同 chunk PACK>64KiB —— 不误 413 且尾字节不丢（trace3）", async () => {
	const cmd = pkt(CMD);
	const bigPack = Buffer.alloc(CMD_BAND_MAX_BYTES + 4096, 0x50); // >64KiB pack 同 chunk
	const original = Buffer.concat([cmd, FLUSH, bigPack]);
	const scanner = new PktHeaderScanner();
	scanner.push(original);
	assert.equal(scanner.state$.phase, "done", "flush 先命中，pack 不计入 header cap");
	const r = chunkReader([]);
	const fwd = createIdentityForward(Buffer.from(scanner.header()), scanner.takeTail(), r.read, r.cancel);
	const out = await drainForward(fwd);
	assert.ok(out.equals(original), "大 pack 同 chunk 必须完整转发");
});

test("forwarder：取消时 cancel 底层（onCancel 收束）", async () => {
	const scanner = new PktHeaderScanner();
	scanner.push(Buffer.concat([pkt(CMD), FLUSH]));
	assert.equal(scanner.state$.phase, "done");
	const r = chunkReader([Buffer.from("PACK-REST")]);
	const fwd = createIdentityForward(Buffer.from(scanner.header()), scanner.takeTail(), r.read, r.cancel);
	const reader = fwd.getReader();
	await reader.read(); // 消费一块后取消
	await reader.cancel();
	assert.equal(r.canceled, true, "取消必须 cancel 底层");
});

test("forwarder：gzip 解码后字节走完全同一函数（同缝证明：decode 后同输入同输出；native zlib 集成另列 NOT RUN）", async () => {
	const decompressed = Buffer.concat([pkt(CMD, "report-status"), FLUSH, Buffer.from("DECOMP-PACK")]);
	const scanner = new PktHeaderScanner();
	scanner.push(decompressed);
	assert.equal(scanner.state$.phase, "done");
	const r = chunkReader([]);
	const fwd = createIdentityForward(Buffer.from(scanner.header()), scanner.takeTail(), r.read, r.cancel);
	const out = await drainForward(fwd);
	assert.ok(out.equals(decompressed), "解压后流必须完整转发（与 identity 同函数同语义）");
});
