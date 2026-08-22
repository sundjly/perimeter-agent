import assert from "node:assert/strict";
import { test } from "node:test";
import { describe as d } from "./links.js";

test("拆出 host 与路径", () => {
	assert.deepEqual(d("https://example.com/a/b?x=1"), { host: "example.com", path: "/a/b", query: "x=1" });
});
