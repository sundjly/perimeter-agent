// receive 字节预算纯 unit（R59-③ 同缝；resource-free）。直测生产 ByteBudget：
// header+同 chunk tail 初段 seed 即时检查（fetch 前拒/upstream0）、EOF 不跳过、identity
// raw 双轨、多 chunk 合法正反、粘滞。
// 本文件为源码交付，未运行（R59 执行禁令；由 coor 新轮预审实际脚本后执行）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { ByteBudget } from "../src/gitproxy/byte-budget.ts";

test("byte-budget：初段 seed（header+同chunk tail）超限即拒——fetch 前 upstream 0", () => {
	// maxDecoded=1000：header(100)+tail(950)=1050 超限——seed 即 verdict（不依赖 EOF/read）
	const b = new ByteBudget(1000, Number.MAX_SAFE_INTEGER);
	assert.equal(b.seed(1050, 0), "over-decoded"); // R60：实参对齐注释意图（100+950）
	assert.equal(b.overDecoded, true);
});

test("byte-budget：EOF 不跳过——最后一块超限即时报（非读完才检）", () => {
	const b = new ByteBudget(1000, Number.MAX_SAFE_INTEGER);
	assert.equal(b.add(600, 0), "ok");
	assert.equal(b.add(500, 0), "over-decoded", "最后一块越限必须即时报");
});

test("byte-budget：identity raw 双轨——raw 独立上限触发（decoded 未超）", () => {
	const b = new ByteBudget(1_000_000, 500); // decoded 上限宽松、raw 上限 500
	assert.equal(b.add(400, 400), "ok");
	assert.equal(b.add(200, 200), "over-raw", "raw 600>500 触发（decoded 600<1M）");
	assert.equal(b.overRaw, true);
});

test("byte-budget：gzip 双轨——decoded 走本类、raw 由泵独立（本类 raw 不计）", () => {
	const b = new ByteBudget(1000, 10); // gzip 场景 raw 上限极小也不触发（raw 恒 0 入参）
	assert.equal(b.add(500, 0), "ok", "gzip decoded 走 decoded 轨");
	assert.equal(b.add(600, 0), "over-decoded");
	assert.equal(b.overRaw, false);
});

test("byte-budget：边界与多 chunk 合法正反", () => {
	const b = new ByteBudget(1000, Number.MAX_SAFE_INTEGER);
	assert.equal(b.add(500, 0), "ok");
	assert.equal(b.add(500, 0), "ok", "恰好等于上限合法（> 才越限）");
	assert.equal(b.add(1, 0), "over-decoded");
	// 粘滞：越限后仍 over
	assert.equal(b.overDecoded, true);
});
