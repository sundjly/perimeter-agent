import { createHash } from "node:crypto";

/**
 * S0 基准评测 30 个固定版本任务的标准 Fixtures
 * 
 * 严格对齐 FIXED_BENCHMARK_TASKS (src/evals/benchmark-skeleton.ts)
 * 采用 Base64 编码生成确定的文件写入与断言命令，零字符转义副作用。
 */

export const SUITE_VERSION = "S0-v1.1.0-actual-mock";

export interface BenchmarkFixtureTask {
	id: string;
	category: "bug-fix" | "test-coverage" | "dependency-upgrade" | "refactor";
	description: string;
	complexity: "low" | "medium" | "high";
	prompt: string;
	files: Record<string, string>;
	verify: string[];
	failsAtStart: number[];
	mockToolCall: { tool: string; args: Record<string, unknown> };
	negativeMockToolCall: { tool: string; args: Record<string, unknown> };
	fixtureHash: string;
}

export function writeCmd(file: string, content: string): string {
	const b64 = Buffer.from(content).toString("base64");
	return `node -e 'require("node:fs").writeFileSync("${file}",Buffer.from("${b64}","base64"))'`;
}

export function appendCmd(file: string, content: string): string {
	const b64 = Buffer.from(content).toString("base64");
	return `node -e 'require("node:fs").appendFileSync("${file}",Buffer.from("${b64}","base64"))'`;
}

export function assertContainsCmd(file: string, expectedSubstring: string): string {
	const b64 = Buffer.from(expectedSubstring).toString("base64");
	return `node -e 'const c=require("node:fs").readFileSync("${file}","utf8");if(!c.includes(Buffer.from("${b64}","base64").toString("utf8")))process.exit(1);'`;
}

export function assertNotContainsCmd(file: string, disallowedSubstring: string): string {
	const b64 = Buffer.from(disallowedSubstring).toString("base64");
	return `node -e 'const c=require("node:fs").readFileSync("${file}","utf8");if(c.includes(Buffer.from("${b64}","base64").toString("utf8")))process.exit(1);'`;
}

interface RawFixtureDefinition {
	id: string;
	category: "bug-fix" | "test-coverage" | "dependency-upgrade" | "refactor";
	description: string;
	complexity: "low" | "medium" | "high";
	prompt: string;
	files: Record<string, string>;
	verify: string[];
	failsAtStart: number[];
	mockBash: string;
	negativeMockBash: string;
}

const RAW_TASKS: RawFixtureDefinition[] = [
	{
		id: "task-01-range-off-by-one",
		category: "bug-fix",
		description: "修复区间求和边界差一错误",
		complexity: "low",
		prompt: "sumRange(1, 5) 应返回 15，sumRange(3, 3) 应返回 3。修复 sum.js 中的边界差一错误让 node --test 通过。",
		files: {
			"package.json": JSON.stringify({ name: "task-01", type: "module" }),
			"sum.js": "export function sumRange(a, b) { let s = 0; for (let i = a; i < b; i++) s += i; return s; }",
			"sum.test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { sumRange } from "./sum.js";
test("sumRange", () => { assert.equal(sumRange(1, 5), 15); assert.equal(sumRange(3, 3), 3); });`,
		},
		verify: ["node --test"],
		failsAtStart: [0],
		mockBash: writeCmd("sum.js", "export function sumRange(a, b) { let s = 0; for (let i = a; i <= b; i++) s += i; return s; }"),
		negativeMockBash: writeCmd("sum.js", "export function sumRange() { return 0; }"),
	},
	{
		id: "task-02-semver-coverage",
		category: "test-coverage",
		description: "补齐语义化版本解析边界测试",
		complexity: "low",
		prompt: "补齐 parse.js 的测试覆盖率，在 test.js 中增加非法输入返回 null 以及 prerelease 版本 compare 比较断言。",
		files: {
			"package.json": JSON.stringify({ name: "task-02", type: "module" }),
			"parse.js": `export function parseSemver(v) {
  const m = /^(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null };
}
export function compare(a, b) {
  const pa = parseSemver(a); const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (!pa.prerelease && pb.prerelease) return 1;
  return 0;
}`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { parseSemver, compare } from "./parse.js";
test("basic", () => {
  const r = parseSemver("1.2.3");
  assert.equal(r?.major, 1);
  assert.equal(r?.minor, 2);
  assert.equal(r?.patch, 3);
});`,
		},
		verify: ["node --test", assertContainsCmd("test.js", "compare(")],
		failsAtStart: [1],
		mockBash: appendCmd("test.js", `
test("coverage", () => {
  assert.equal(parseSemver("bad"), null);
  assert.equal(compare("1.0.0-alpha", "1.0.0"), -1);
});`),
		negativeMockBash: appendCmd("test.js", "\n// no coverage"),
	},
	{
		id: "task-03-legacy-url-migration",
		category: "dependency-upgrade",
		description: "迁移废弃 url 接口至标准 WHATWG URL",
		complexity: "medium",
		prompt: "links.js 使用了已弃用的 url.parse，请迁移为 WHATWG new URL() 并保持 describeUrl 返回格式一致。",
		files: {
			"package.json": JSON.stringify({ name: "task-03", type: "module" }),
			"links.js": `import url from "node:url";
export function describeUrl(input) {
  const parsed = url.parse(input);
  return { host: parsed.host, path: parsed.pathname, query: (parsed.query ?? "").replace(/^\\?/, "") };
}`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { describeUrl } from "./links.js";
test("describeUrl", () => { assert.deepEqual(describeUrl("https://example.com/foo?bar=1"), { host: "example.com", path: "/foo", query: "bar=1" }); });`,
		},
		verify: ["node --test", assertNotContainsCmd("links.js", "url.parse")],
		failsAtStart: [1],
		mockBash: writeCmd("links.js", `export function describeUrl(input) {
  const u = new URL(input);
  return { host: u.host, path: u.pathname, query: u.search.replace(/^\\?/, "") };
}`),
		negativeMockBash: appendCmd("links.js", "// no change"),
	},
	{
		id: "task-04-slice-dedupe-refactor",
		category: "refactor",
		description: "重构切片去重逻辑，提升时间复杂度",
		complexity: "medium",
		prompt: "重构 slice.js 的去重逻辑，消除双重嵌套循环，提升时间复杂度至 O(N)。",
		files: {
			"package.json": JSON.stringify({ name: "task-04", type: "module" }),
			"slice.js": `export function dedupe(arr) {
  const res = [];
  for (let i = 0; i < arr.length; i++) {
    let exists = false;
    for (let j = 0; j < res.length; j++) {
      if (res[j] === arr[i]) { exists = true; break; }
    }
    if (!exists) res.push(arr[i]);
  }
  return res;
}`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { dedupe } from "./slice.js";
test("dedupe", () => { assert.deepEqual(dedupe([1, 2, 2, 3, 1]), [1, 2, 3]); });`,
		},
		verify: ["node --test", assertNotContainsCmd("slice.js", "for (let j")],
		failsAtStart: [1],
		mockBash: writeCmd("slice.js", `export function dedupe(arr) { return Array.from(new Set(arr)); }`),
		negativeMockBash: appendCmd("slice.js", "// keep loop"),
	},
	{
		id: "task-05-null-pointer-guard",
		category: "bug-fix",
		description: "处理多层嵌套结构解构空指针",
		complexity: "low",
		prompt: "修复 access.js 的 getNested 函数，处理 obj 为 null 或属性不存在时的空指针异常并返回 undefined。",
		files: {
			"package.json": JSON.stringify({ name: "task-05", type: "module" }),
			"access.js": `export function getNested(obj, path) {
  const parts = path.split(".");
  let curr = obj;
  for (const p of parts) { curr = curr[p]; }
  return curr;
}`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { getNested } from "./access.js";
test("getNested", () => {
  assert.equal(getNested({ a: { b: 1 } }, "a.b"), 1);
  assert.equal(getNested(null, "a.b"), undefined);
  assert.equal(getNested({ a: null }, "a.b.c"), undefined);
});`,
		},
		verify: ["node --test"],
		failsAtStart: [0],
		mockBash: writeCmd("access.js", `export function getNested(obj, path) {
  const parts = path.split(".");
  let curr = obj;
  for (const p of parts) { if (curr == null) return undefined; curr = curr[p]; }
  return curr;
}`),
		negativeMockBash: writeCmd("access.js", `export function getNested() { return 0; }`),
	},
	{
		id: "task-06-hex-color-parser",
		category: "test-coverage",
		description: "增加十六进制颜色缩写与 alpha 测试覆盖",
		complexity: "low",
		prompt: "在 test.js 中增加 parseHex 对 4 位与 8 位含 alpha 的十六进制颜色（#rgba 和 #rrggbbaa）测试覆盖。",
		files: {
			"package.json": JSON.stringify({ name: "task-06", type: "module" }),
			"color.js": `export function parseHex(h) {
  const hex = h.replace(/^#/, "");
  if (hex.length === 3) return { r: parseInt(hex[0]+hex[0], 16), g: parseInt(hex[1]+hex[1], 16), b: parseInt(hex[2]+hex[2], 16), a: 1 };
  if (hex.length === 4) return { r: parseInt(hex[0]+hex[0], 16), g: parseInt(hex[1]+hex[1], 16), b: parseInt(hex[2]+hex[2], 16), a: parseInt(hex[3]+hex[3], 16) / 255 };
  if (hex.length === 6) return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
  if (hex.length === 8) return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: parseInt(hex.slice(6, 8), 16) / 255 };
  return null;
}`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { parseHex } from "./color.js";
test("hex6", () => { assert.deepEqual(parseHex("#ffffff"), { r: 255, g: 255, b: 255, a: 1 }); });`,
		},
		verify: ["node --test", assertContainsCmd("test.js", "#f00f")],
		failsAtStart: [1],
		mockBash: appendCmd("test.js", `
test("hex4", () => { assert.deepEqual(parseHex("#f00f"), { r: 255, g: 0, b: 0, a: 1 }); });
test("hex8", () => { assert.deepEqual(parseHex("#ff0000ff"), { r: 255, g: 0, b: 0, a: 1 }); });`),
		negativeMockBash: appendCmd("test.js", "\n// no coverage"),
	},
	{
		id: "task-07-stream-backpressure-leak",
		category: "bug-fix",
		description: "修复背压未暂停导致的内存持续增长",
		complexity: "high",
		prompt: "修复 pump.js 中流对接逻辑，dest.write 返回 false 时 pause 源端，收到 drain 时 resume。",
		files: {
			"package.json": JSON.stringify({ name: "task-07", type: "module" }),
			"pump.js": `export function pump(src, dest) {
  src.on("data", (chunk) => { dest.write(chunk); });
}`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { EventEmitter } from "node:events"; import { pump } from "./pump.js";
test("backpressure", () => {
  let paused = false; let resumed = false;
  const src = new EventEmitter();
  src.pause = () => { paused = true; };
  src.resume = () => { resumed = true; };
  const dest = new EventEmitter();
  dest.write = () => false;
  pump(src, dest);
  src.emit("data", "hello");
  assert.equal(paused, true);
  dest.emit("drain");
  assert.equal(resumed, true);
});`,
		},
		verify: ["node --test"],
		failsAtStart: [0],
		mockBash: writeCmd("pump.js", `export function pump(src, dest) {
  src.on("data", (chunk) => {
    const can = dest.write(chunk);
    if (!can) {
      src.pause();
      dest.once("drain", () => src.resume());
    }
  });
}`),
		negativeMockBash: writeCmd("pump.js", "export function pump() {}"),
	},
	{
		id: "task-08-uuid-v4-validator",
		category: "test-coverage",
		description: "补全 UUID v4 严格字符集与正则测试",
		complexity: "low",
		prompt: "在 uuid.js 中实现严格 RFC 4122 v4 UUID 格式校验，确保版本与变体正确。",
		files: {
			"package.json": JSON.stringify({ name: "task-08", type: "module" }),
			"uuid.js": `export function isUuidV4(str) { return /^[0-9a-f-]+$/i.test(str); }`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { isUuidV4 } from "./uuid.js";
test("uuid", () => {
  assert.equal(isUuidV4("c9a646d3-9c61-4cc9-bc01-123456789abc"), true);
  assert.equal(isUuidV4("c9a646d3-9c61-1cc9-bc01-123456789abc"), false);
  assert.equal(isUuidV4("c9a646d3-9c61-4cc9-3c01-123456789abc"), false);
});`,
		},
		verify: ["node --test"],
		failsAtStart: [0],
		mockBash: writeCmd("uuid.js", `export function isUuidV4(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
}`),
		negativeMockBash: writeCmd("uuid.js", "export function isUuidV4() { return true; }"),
	},
	{
		id: "task-09-crypto-timing-attack",
		category: "bug-fix",
		description: "替换普通等号为 timingSafeEqual 防御时序攻击",
		complexity: "medium",
		prompt: "将 auth.js 中的简单比较改为 crypto.timingSafeEqual，防御时序分析攻击。",
		files: {
			"package.json": JSON.stringify({ name: "task-09", type: "module" }),
			"auth.js": `export function compareTokens(a, b) { return a === b; }`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { compareTokens } from "./auth.js";
test("compareTokens", () => {
  assert.equal(compareTokens("secret123", "secret123"), true);
  assert.equal(compareTokens("secret123", "secret456"), false);
  assert.equal(compareTokens("short", "longer-string"), false);
});`,
		},
		verify: ["node --test", assertContainsCmd("auth.js", "timingSafeEqual")],
		failsAtStart: [1],
		mockBash: writeCmd("auth.js", `import crypto from "node:crypto";
export function compareTokens(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}`),
		negativeMockBash: writeCmd("auth.js", "export function compareTokens(a, b) { return a === b; }"),
	},
	{
		id: "task-10-event-emitter-leak",
		category: "bug-fix",
		description: "移除临时 listener 消除未释放监听器告警",
		complexity: "low",
		prompt: "修复 listen.js 中的 onceWithTimeout 函数，超时或成功时必须解除事件监听，防止未释放泄漏。",
		files: {
			"package.json": JSON.stringify({ name: "task-10", type: "module" }),
			"listen.js": `export function onceWithTimeout(emitter, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    emitter.on(event, (data) => resolve(data));
    setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
}`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { EventEmitter } from "node:events"; import { onceWithTimeout } from "./listen.js";
test("cleanup", { timeout: 300 }, async () => {
  const em = new EventEmitter();
  await assert.rejects(onceWithTimeout(em, "ping", 50));
  assert.equal(em.listenerCount("ping"), 0);
});`,
		},
		verify: ["node --test"],
		failsAtStart: [0],
		mockBash: writeCmd("listen.js", `export function onceWithTimeout(emitter, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer;
    const onEv = (d) => { clearTimeout(timer); emitter.removeListener(event, onEv); resolve(d); };
    timer = setTimeout(() => { emitter.removeListener(event, onEv); reject(new Error("timeout")); }, timeoutMs);
    emitter.on(event, onEv);
  });
}`),
		negativeMockBash: writeCmd("listen.js", "export function onceWithTimeout(emitter, event) { emitter.on(event, () => {}); return Promise.reject(new Error(\"timeout\")); }"),
	},
	{
		id: "task-11-json-depth-limit",
		category: "bug-fix",
		description: "入站 JSON 解析层增加递归深度防护",
		complexity: "medium",
		prompt: "在 parse.js 中为 JSON 递归解析增加深度限制防护，超出深度上限时抛出 DepthLimit 错误。",
		files: {
			"package.json": JSON.stringify({ name: "task-11", type: "module" }),
			"parse.js": `export function parseDeep(raw) { return JSON.parse(raw); }`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { parseDeep } from "./parse.js";
test("depth", () => {
  assert.deepEqual(parseDeep("{\\"a\\":1}", 5), { a: 1 });
  const deep = JSON.stringify({ a: { b: { c: { d: 1 } } } });
  assert.throws(() => parseDeep(deep, 3), /DepthLimit/);
});`,
		},
		verify: ["node --test"],
		failsAtStart: [0],
		mockBash: writeCmd("parse.js", `export function parseDeep(raw, maxDepth = 10) {
  const obj = JSON.parse(raw);
  function chk(v, d) {
    if (d > maxDepth) throw new Error("DepthLimit");
    if (v && typeof v === "object") for (const k of Object.keys(v)) chk(v[k], d + 1);
  }
  chk(obj, 1);
  return obj;
}`),
		negativeMockBash: writeCmd("parse.js", "export function parseDeep(raw) { return JSON.parse(raw); }"),
	},
	{
		id: "task-12-retry-exponential-jitter",
		category: "refactor",
		description: "为重试退避增加全抖动 (Full Jitter)",
		complexity: "medium",
		prompt: "为 retry.js 的指数退避增加 Full Jitter 随机抖动计算。",
		files: {
			"package.json": JSON.stringify({ name: "task-12", type: "module" }),
			"retry.js": `export function computeBackoff(attempt, baseMs) { return baseMs * (2 ** attempt); }`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { computeBackoff } from "./retry.js";
test("jitter", () => { const b = computeBackoff(2, 100); assert.ok(b >= 0 && b <= 400); });`,
		},
		verify: ["node --test", assertContainsCmd("retry.js", "Math.random")],
		failsAtStart: [1],
		mockBash: writeCmd("retry.js", `export function computeBackoff(attempt, baseMs) {
  return Math.random() * baseMs * (2 ** attempt);
}`),
		negativeMockBash: writeCmd("retry.js", "export function computeBackoff() { return 0; }"),
	},
	{
		id: "task-13-cookie-samesite-parser",
		category: "bug-fix",
		description: "修复 SameSite 属性大小写不敏感解析",
		complexity: "low",
		prompt: "修复 cookie.js 的 parseSameSite 函数，实现大小写不敏感解析。",
		files: {
			"package.json": JSON.stringify({ name: "task-13", type: "module" }),
			"cookie.js": `export function parseSameSite(attr) { if (attr === "Strict") return "Strict"; if (attr === "Lax") return "Lax"; return "None"; }`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { parseSameSite } from "./cookie.js";
test("case", () => {
  assert.equal(parseSameSite("strict"), "Strict");
  assert.equal(parseSameSite("LAX"), "Lax");
  assert.equal(parseSameSite("none"), "None");
});`,
		},
		verify: ["node --test"],
		failsAtStart: [0],
		mockBash: writeCmd("cookie.js", `export function parseSameSite(attr) {
  const s = String(attr ?? "").toLowerCase();
  if (s === "strict") return "Strict";
  if (s === "lax") return "Lax";
  return "None";
}`),
		negativeMockBash: writeCmd("cookie.js", "export function parseSameSite() { return \"bad\"; }"),
	},
	{
		id: "task-14-query-param-array-merge",
		category: "bug-fix",
		description: "URL 同名查询参数合并为数组时避免原型污染",
		complexity: "medium",
		prompt: "防御 query.js 中的原型污染，当解析到 __proto__ 或 constructor 时予以忽略。",
		files: {
			"package.json": JSON.stringify({ name: "task-14", type: "module" }),
			"query.js": `export function parseQuery(str) {
  const res = {};
  for (const part of str.split("&")) { const [k, v] = part.split("="); res[k] = v; }
  return res;
}`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { parseQuery } from "./query.js";
test("proto", () => {
  const q = parseQuery("__proto__=polluted");
  assert.equal(({}).polluted, undefined);
  assert.equal(q.__proto__, undefined);
});`,
		},
		verify: ["node --test"],
		failsAtStart: [0],
		mockBash: writeCmd("query.js", `export function parseQuery(str) {
  const res = Object.create(null);
  for (const part of str.split("&")) {
    const [k, v] = part.split("=");
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    res[k] = v;
  }
  return res;
}`),
		negativeMockBash: writeCmd("query.js", "export function parseQuery() { return {}; }"),
	},
	{
		id: "task-15-utf8-surrogate-split",
		category: "bug-fix",
		description: "修复定长分片切断 UTF-8 代理对产生的乱码",
		complexity: "medium",
		prompt: "修复 split.js 中的 safeChunk 函数，避免把 UTF-16 代理对截断产生孤立 surrogate 字符。",
		files: {
			"package.json": JSON.stringify({ name: "task-15", type: "module" }),
			"split.js": `export function safeChunk(str, maxChars) { return [str.slice(0, maxChars), str.slice(maxChars)]; }`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { safeChunk } from "./split.js";
test("surrogate", () => {
  const s = "hi👋world";
  const [c1, c2] = safeChunk(s, 3);
  assert.ok(!/[\\uD800-\\uDBFF]$/.test(c1));
  assert.equal(c1 + c2, s);
});`,
		},
		verify: ["node --test"],
		failsAtStart: [0],
		mockBash: writeCmd("split.js", `export function safeChunk(str, maxChars) {
  let cut = maxChars;
  if (cut > 0 && cut < str.length && /[\\uD800-\\uDBFF]/.test(str[cut - 1])) cut -= 1;
  return [str.slice(0, cut), str.slice(cut)];
}`),
		negativeMockBash: writeCmd("split.js", "export function safeChunk() { return [\"\", \"\"]; }"),
	},
	{
		id: "task-16-base64url-padding",
		category: "bug-fix",
		description: "规范化无填充 base64url 解码",
		complexity: "low",
		prompt: "修复 b64.js 中的 decodeB64Url 函数，支持无填充 base64url 解码。",
		files: {
			"package.json": JSON.stringify({ name: "task-16", type: "module" }),
			"b64.js": `export function decodeB64Url(s) { return ""; }`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { decodeB64Url } from "./b64.js";
test("decode", () => { assert.equal(decodeB64Url("eyJhIjoxfQ"), JSON.stringify({ a: 1 })); });`,
		},
		verify: ["node --test"],
		failsAtStart: [0],
		mockBash: writeCmd("b64.js", `export function decodeB64Url(s) {
  return Buffer.from(s, "base64url").toString("utf8");
}`),
		negativeMockBash: writeCmd("b64.js", "export function decodeB64Url() { return \"\"; }"),
	},
	{
		id: "task-17-abort-controller-cascade",
		category: "refactor",
		description: "级联传递 AbortSignal 防止孤儿异步操作",
		complexity: "medium",
		prompt: "在 runner.js 中实现 chainSignal 函数，级联监听 parentSignal 的 abort 事件并中止 child。",
		files: {
			"package.json": JSON.stringify({ name: "task-17", type: "module" }),
			"runner.js": `export function chainSignal(parentSignal) { const child = new AbortController(); return child; }`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { chainSignal } from "./runner.js";
test("cascade", () => {
  const parent = new AbortController();
  const child = chainSignal(parent.signal);
  parent.abort();
  assert.equal(child.signal.aborted, true);
});`,
		},
		verify: ["node --test", assertContainsCmd("runner.js", "addEventListener")],
		failsAtStart: [0],
		mockBash: writeCmd("runner.js", `export function chainSignal(parentSignal) {
  const child = new AbortController();
  if (parentSignal.aborted) child.abort();
  else parentSignal.addEventListener("abort", () => child.abort(), { once: true });
  return child;
}`),
		negativeMockBash: writeCmd("runner.js", "export function chainSignal() { return new AbortController(); }"),
	},
	{
		id: "task-18-header-casing-fold",
		category: "refactor",
		description: "HTTP Header 键名规范化折叠",
		complexity: "low",
		prompt: "在 headers.js 中规范化键名小写并折叠同名请求头。",
		files: {
			"package.json": JSON.stringify({ name: "task-18", type: "module" }),
			"headers.js": `export function mergeHeaders(list) { const res = {}; for (const [k, v] of list) res[k] = v; return res; }`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { mergeHeaders } from "./headers.js";
test("fold", () => {
  const m = mergeHeaders([["Content-Type", "text/plain"], ["content-type", "charset=utf-8"]]);
  assert.deepEqual(m, { "content-type": "text/plain, charset=utf-8" });
});`,
		},
		verify: ["node --test"],
		failsAtStart: [0],
		mockBash: writeCmd("headers.js", `export function mergeHeaders(list) {
  const res = {};
  for (const [k, v] of list) {
    const lower = k.toLowerCase();
    res[lower] = res[lower] ? res[lower] + ", " + v : v;
  }
  return res;
}`),
		negativeMockBash: writeCmd("headers.js", "export function mergeHeaders() { return {}; }"),
	},
	{
		id: "task-19-etag-weak-validator",
		category: "test-coverage",
		description: "增加弱 ETag (W/) 匹配断言测试",
		complexity: "low",
		prompt: "在 test.js 中补充弱 ETag (W/\"...\") 匹配断言测试。",
		files: {
			"package.json": JSON.stringify({ name: "task-19", type: "module" }),
			"etag.js": `export function matchesETag(stored, header) { return stored === header; }`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { matchesETag } from "./etag.js";
test("strong", () => { assert.equal(matchesETag("\\"1234\\"", "\\"1234\\""), true); });`,
		},
		verify: ["node --test", assertContainsCmd("test.js", "W/")],
		failsAtStart: [1],
		mockBash: appendCmd("test.js", `
test("weak", () => { assert.equal(matchesETag("W/\\"123\\"", "W/\\"123\\""), true); });`),
		negativeMockBash: appendCmd("test.js", "\n// no weak"),
	},
	{
		id: "task-20-status-code-range-assert",
		category: "test-coverage",
		description: "增加非法 HTTP 状态码抛错测试",
		complexity: "low",
		prompt: "在 response.js 的 createResponse 中增加 HTTP 状态码必须在 100~599 范围的断言校验。",
		files: {
			"package.json": JSON.stringify({ name: "task-20", type: "module" }),
			"response.js": `export function createResponse(status) { return { status }; }`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { createResponse } from "./response.js";
test("status", () => {
  assert.equal(createResponse(200).status, 200);
  assert.throws(() => createResponse(99), RangeError);
  assert.throws(() => createResponse(600), RangeError);
});`,
		},
		verify: ["node --test"],
		failsAtStart: [0],
		mockBash: writeCmd("response.js", `export function createResponse(status) {
  if (status < 100 || status > 599) throw new RangeError("Invalid status");
  return { status };
}`),
		negativeMockBash: writeCmd("response.js", "export function createResponse(status) { return { status }; }"),
	},
	{
		id: "task-21-jwt-clock-skew-edge",
		category: "test-coverage",
		description: "JWT 时钟漂移边界极限用例",
		complexity: "medium",
		prompt: "在 test.js 中补齐 JWT 时钟漂移 clockSkew 边界情况测试。",
		files: {
			"package.json": JSON.stringify({ name: "task-21", type: "module" }),
			"jwt.js": `export function isTokenValid(expSec, nowSec, clockSkewSec = 0) { return nowSec <= expSec + clockSkewSec; }`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { isTokenValid } from "./jwt.js";
test("valid", () => { assert.equal(isTokenValid(100, 90), true); });`,
		},
		verify: ["node --test", assertContainsCmd("test.js", "clockSkew")],
		failsAtStart: [1],
		mockBash: appendCmd("test.js", `
test("clockSkew", () => {
  assert.equal(isTokenValid(100, 120, 30), true);
  assert.equal(isTokenValid(100, 140, 30), false);
});`),
		negativeMockBash: appendCmd("test.js", "\n// no skew"),
	},
	{
		id: "task-22-file-descriptor-close",
		category: "bug-fix",
		description: "确保异常抛出路径下文件描述符被安全关闭",
		complexity: "medium",
		prompt: "确保 fd.js 在 fn 抛出异常时在 finally 中正确调用 fs.closeSync 关闭描述符。",
		files: {
			"package.json": JSON.stringify({ name: "task-22", type: "module" }),
			"fd.js": `import fs from "node:fs";
export function safeRead(file, fn) {
  const fd = fs.openSync(file, "r");
  const res = fn(fd);
  fs.closeSync(fd);
  return res;
}`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import { safeRead } from "./fd.js";
test("safeClose", () => {
  fs.writeFileSync("tmp.txt", "data");
  let closed = false;
  const origClose = fs.closeSync;
  fs.closeSync = (fd) => { closed = true; return origClose(fd); };
  try {
    assert.throws(() => safeRead("tmp.txt", () => { throw new Error("boom"); }));
    assert.equal(closed, true);
  } finally {
    fs.closeSync = origClose;
    fs.unlinkSync("tmp.txt");
  }
});`,
		},
		verify: ["node --test"],
		failsAtStart: [0],
		mockBash: writeCmd("fd.js", `import fs from "node:fs";
export function safeRead(file, fn) {
  const fd = fs.openSync(file, "r");
  try { return fn(fd); } finally { fs.closeSync(fd); }
}`),
		negativeMockBash: writeCmd("fd.js", "export function safeRead() { throw new Error(); }"),
	},
	{
		id: "task-23-safe-path-join",
		category: "bug-fix",
		description: "防御路径拼接穿越穿越到父级目录",
		complexity: "medium",
		prompt: "防御 path.js 中的路径遍历漏洞，防止解析路径跳出根目录。",
		files: {
			"package.json": JSON.stringify({ name: "task-23", type: "module" }),
			"path.js": `import path from "node:path";
export function safeJoin(root, target) { return path.join(root, target); }`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { safeJoin } from "./path.js";
test("traversal", () => {
  assert.equal(safeJoin("/app", "sub/file"), "/app/sub/file");
  assert.throws(() => safeJoin("/app", "../../etc/passwd"), /PathTraversal/);
});`,
		},
		verify: ["node --test"],
		failsAtStart: [0],
		mockBash: writeCmd("path.js", `import path from "node:path";
export function safeJoin(root, target) {
  const r = path.resolve(root);
  const full = path.resolve(r, target);
  if (!full.startsWith(r)) throw new Error("PathTraversal");
  return full;
}`),
		negativeMockBash: writeCmd("path.js", "export function safeJoin(r, t) { return t; }"),
	},
	{
		id: "task-24-regex-redos-mitigation",
		category: "refactor",
		description: "优化指数回溯正则为非回溯状态机",
		complexity: "high",
		prompt: "重构 matcher.js 中的正则，消除 ReDoS 回溯漏洞。",
		files: {
			"package.json": JSON.stringify({ name: "task-24", type: "module" }),
			"matcher.js": `export function matchPattern(str) { return /^(a+)+$/.test(str); }`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { matchPattern } from "./matcher.js";
test("matcher", () => {
  assert.equal(matchPattern("aaaa"), true);
  assert.equal(matchPattern("aaab"), false);
});`,
		},
		verify: ["node --test", assertNotContainsCmd("matcher.js", "(a+)+")],
		failsAtStart: [1],
		mockBash: writeCmd("matcher.js", `export function matchPattern(str) { return /^a+$/.test(str); }`),
		negativeMockBash: appendCmd("matcher.js", "// re-dos"),
	},
	{
		id: "task-25-bigint-serialization",
		category: "bug-fix",
		description: "防止序列化时丢失 BigInt 精度",
		complexity: "low",
		prompt: "在 serialize.js 中支持 BigInt 的安全序列化。",
		files: {
			"package.json": JSON.stringify({ name: "task-25", type: "module" }),
			"serialize.js": `export function safeStringify(obj) { return JSON.stringify(obj); }`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { safeStringify } from "./serialize.js";
test("bigint", () => {
  const out = safeStringify({ id: 9007199254740995n });
  assert.equal(out, "{\\"id\\":\\"9007199254740995n\\"}");
});`,
		},
		verify: ["node --test"],
		failsAtStart: [0],
		mockBash: writeCmd("serialize.js", `export function safeStringify(obj) {
  return JSON.stringify(obj, (_, v) => typeof v === "bigint" ? v.toString() + "n" : v);
}`),
		negativeMockBash: writeCmd("serialize.js", "export function safeStringify() { return \"{}\"; }"),
	},
	{
		id: "task-26-websocket-frame-masking",
		category: "test-coverage",
		description: "补齐客户端 WS 帧必须掩码 (Masking) 的测试",
		complexity: "medium",
		prompt: "在 test.js 中补齐客户端帧掩码异或还原测试。",
		files: {
			"package.json": JSON.stringify({ name: "task-26", type: "module" }),
			"ws.js": `export function maskFrame(payload, maskKey) {
  const buf = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) buf[i] = payload[i] ^ maskKey[i % 4];
  return buf;
}`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { maskFrame } from "./ws.js";
test("basic", () => { assert.equal(maskFrame(Buffer.from([0,0]), [1,2,3,4]).length, 2); });`,
		},
		verify: ["node --test", assertContainsCmd("test.js", "unmask")],
		failsAtStart: [1],
		mockBash: appendCmd("test.js", `
test("unmask", () => {
  const orig = Buffer.from("hello");
  const key = [1,2,3,4];
  const masked = maskFrame(orig, key);
  const unmasked = maskFrame(masked, key);
  assert.deepEqual(unmasked, orig);
});`),
		negativeMockBash: appendCmd("test.js", "\n// empty placeholder"),
	},
	{
		id: "task-27-lru-cache-eviction",
		category: "refactor",
		description: "为 LRU 缓存添加确定性容量淘汰机制",
		complexity: "medium",
		prompt: "为 lru.js 中的 LruCache 实现基于访问顺序的确定性淘汰。",
		files: {
			"package.json": JSON.stringify({ name: "task-27", type: "module" }),
			"lru.js": `export class LruCache {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(k) { return this.map.get(k); }
  set(k, v) { this.map.set(k, v); }
}`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { LruCache } from "./lru.js";
test("evict", () => {
  const l = new LruCache(2);
  l.set("a", 1);
  l.set("b", 2);
  l.get("a");
  l.set("c", 3);
  assert.equal(l.get("b"), undefined);
  assert.equal(l.get("a"), 1);
  assert.equal(l.get("c"), 3);
});`,
		},
		verify: ["node --test"],
		failsAtStart: [0],
		mockBash: writeCmd("lru.js", `export class LruCache {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(k, v);
  }
}`),
		negativeMockBash: writeCmd("lru.js", "export class LruCache { constructor() {} get() {} set() {} }"),
	},
	{
		id: "task-28-graceful-drain-timeout",
		category: "refactor",
		description: "进程退出时给在途请求 5s drain 超时",
		complexity: "medium",
		prompt: "在 drain.js 中为 gracefulClose 增加超时保护，超时抛出 DrainTimeout 异常。",
		files: {
			"package.json": JSON.stringify({ name: "task-28", type: "module" }),
			"drain.js": `export function gracefulClose(server) { return new Promise((res) => server.close(res)); }`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { gracefulClose } from "./drain.js";
test("timeout", { timeout: 200 }, async () => {
  const fake = { close: (_cb) => {} };
  await assert.rejects(gracefulClose(fake, 50), /DrainTimeout/);
});`,
		},
		verify: ["node --test"],
		failsAtStart: [0],
		mockBash: writeCmd("drain.js", `export function gracefulClose(server, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("DrainTimeout")), timeoutMs);
    server.close((err) => {
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    });
  });
}`),
		negativeMockBash: writeCmd("drain.js", "export function gracefulClose() { return Promise.resolve(); }"),
	},
	{
		id: "task-29-circular-reference-inspect",
		category: "bug-fix",
		description: "格式化日志时检测对象循环引用",
		complexity: "low",
		prompt: "在 inspect.js 中处理对象循环引用，避免调用 JSON.stringify 时栈溢出。",
		files: {
			"package.json": JSON.stringify({ name: "task-29", type: "module" }),
			"inspect.js": `export function safeInspect(obj) { return JSON.stringify(obj); }`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import { safeInspect } from "./inspect.js";
test("circular", () => {
  const o = { a: 1 };
  o.self = o;
  assert.equal(safeInspect(o), "{\\"a\\":1,\\\"self\\\":\\\"[Circular]\\\"}");
});`,
		},
		verify: ["node --test"],
		failsAtStart: [0],
		mockBash: writeCmd("inspect.js", `export function safeInspect(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (k, v) => {
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
    }
    return v;
  });
}`),
		negativeMockBash: writeCmd("inspect.js", "export function safeInspect() { return \"\"; }"),
	},
	{
		id: "task-30-atomic-file-replace",
		category: "refactor",
		description: "使用 tmp 文件加 renameSync 实现原子文件覆盖",
		complexity: "medium",
		prompt: "在 atomic.js 中通过临时文件加 fs.renameSync 实现原子文件写入。",
		files: {
			"package.json": JSON.stringify({ name: "task-30", type: "module" }),
			"atomic.js": `import fs from "node:fs";
export function atomicWrite(path, content) { fs.writeFileSync(path, content); }`,
			"test.js": `import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import { atomicWrite } from "./atomic.js";
test("atomic", () => {
  atomicWrite("target.txt", "data");
  assert.equal(fs.readFileSync("target.txt", "utf8"), "data");
  fs.unlinkSync("target.txt");
});`,
		},
		verify: ["node --test", assertContainsCmd("atomic.js", "renameSync")],
		failsAtStart: [1],
		mockBash: writeCmd("atomic.js", `import fs from "node:fs"; import crypto from "node:crypto";
export function atomicWrite(path, content) {
  const tmp = path + ".tmp." + crypto.randomUUID();
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, path);
}`),
		negativeMockBash: writeCmd("atomic.js", "export function atomicWrite() {}"),
	},
];

export function computeFixtureHash(task: RawFixtureDefinition): string {
	const h = createHash("sha256");
	h.update(task.id);
	h.update(task.prompt);
	for (const [k, v] of Object.entries(task.files).sort()) {
		h.update(k);
		h.update(v);
	}
	for (const c of task.verify) h.update(c);
	for (const idx of task.failsAtStart) h.update(String(idx));
	return h.digest("hex");
}

export const BENCHMARK_FIXTURE_TASKS: BenchmarkFixtureTask[] = RAW_TASKS.map((t) => ({
	id: t.id,
	category: t.category,
	description: t.description,
	complexity: t.complexity,
	prompt: t.prompt,
	files: t.files,
	verify: t.verify,
	failsAtStart: t.failsAtStart,
	mockToolCall: { tool: "bash", args: { command: t.mockBash } },
	negativeMockToolCall: { tool: "bash", args: { command: t.negativeMockBash } },
	fixtureHash: computeFixtureHash(t),
}));
