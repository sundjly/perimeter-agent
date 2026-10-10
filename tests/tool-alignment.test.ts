import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { CodingTools } from "@earendil-works/pi-durable/tools";

test("工具白名单以已安装 Durable 源码为准，写工具绝不豁免路径规则", () => {
	const policy = parse(readFileSync("config/policy.yaml", "utf8"));
	const names = CodingTools.tools!.map((tool) => tool.name);
	assert.deepEqual(names, ["read", "write", "edit", "bash"]);
	assert.deepEqual(policy.read_only_tools, ["read"]);
	assert.ok(!policy.read_only_tools.includes("write") && !policy.read_only_tools.includes("edit"));
});
