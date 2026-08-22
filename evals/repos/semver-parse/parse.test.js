import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "./parse.js";

test("解析基本版本号", () => {
	assert.deepEqual(parse("1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: null });
});
