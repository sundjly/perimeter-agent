import assert from "node:assert/strict";
import { test } from "node:test";
import { sumRange } from "./sum.js";

test("闭区间要含右端点", () => {
	assert.equal(sumRange(1, 5), 15);
	assert.equal(sumRange(3, 3), 3);
});
