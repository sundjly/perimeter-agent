import assert from "node:assert/strict";
import { test } from "node:test";
import { JsonlFramer } from "../src/rpc/framing.ts";

test("按 LF 切分，跨 chunk 的半行被保留", () => {
	const f = new JsonlFramer();
	assert.deepEqual(f.push('{"a":1}\n{"b":'), ['{"a":1}']);
	assert.deepEqual(f.push("2}\n"), ['{"b":2}']);
});

test("只剥尾部 CR，行内 CR 原样保留", () => {
	const f = new JsonlFramer();
	assert.deepEqual(f.push("a\rb\r\n"), ["a\rb"]);
	// 只剥一个：文档说的是 stripping a trailing \r，单数
	assert.deepEqual(f.push("c\r\r\n"), ["c\r"]);
});

test("U+2028 / U+2029 在 JSON 字符串内部是合法字符，绝不能当作换行", () => {
	const f = new JsonlFramer();
	const text = "第一段 第二段 第三段";
	// JSON.stringify 不转义这两个码点，它们会原样出现在 stdout 上
	const payload = JSON.stringify({ text });
	assert.ok(payload.includes(" "), "前提：序列化后确实含裸 U+2028");
	const lines = f.push(`${payload}\n`);
	assert.equal(lines.length, 1, "Node readline 会在此处把一条消息误切成三行");
	assert.equal(JSON.parse(lines[0]!).text, text);
});

test("多字节 UTF-8 被 chunk 边界切断时不产生替换字符", () => {
	const f = new JsonlFramer();
	const buf = Buffer.from('{"t":"中文内容"}\n', "utf8");
	// 在「中」字的三个字节中间切开
	const cut = buf.indexOf(Buffer.from("中", "utf8")) + 1;
	assert.deepEqual(f.push(buf.subarray(0, cut)), []);
	const lines = f.push(buf.subarray(cut));
	assert.equal(JSON.parse(lines[0]!).t, "中文内容");
});

test("空行被跳过", () => {
	const f = new JsonlFramer();
	assert.deepEqual(f.push('\n\n{"a":1}\n\n'), ['{"a":1}']);
});

test("一次 chunk 含多行时全部返回", () => {
	const f = new JsonlFramer();
	assert.deepEqual(f.push('{"a":1}\n{"a":2}\n{"a":3}\n'), ['{"a":1}', '{"a":2}', '{"a":3}']);
});

test("flush 取出进程退出时没有换行结尾的残留", () => {
	const f = new JsonlFramer();
	assert.deepEqual(f.push('{"a":1}'), []);
	assert.equal(f.pending, 7);
	assert.deepEqual(f.flush(), ['{"a":1}']);
	assert.deepEqual(f.flush(), []);
});
