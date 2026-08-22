import assert from "node:assert/strict";
import { test } from "node:test";
import { drop, head, tail } from "./slice.js";

test("正常取值", () => {
	assert.deepEqual(head([1, 2, 3], 2), [1, 2]);
	assert.deepEqual(tail([1, 2, 3], 2), [2, 3]);
	assert.deepEqual(drop([1, 2, 3], 1), [2, 3]);
});

test("越界一律抛 RangeError", () => {
	for (const f of [head, tail, drop]) {
		assert.throws(() => f([1, 2], 5), RangeError);
		assert.throws(() => f([1, 2], -1), RangeError);
		assert.throws(() => f([1, 2], 1.5), RangeError);
	}
});
