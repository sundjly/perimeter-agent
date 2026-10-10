import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { generateNetworkPolicy } from "../src/deploy/netpol.ts";

const POLICY = readFileSync(fileURLToPath(new URL("../config/policy.yaml", import.meta.url)), "utf8");
const GENERATED = readFileSync(fileURLToPath(new URL("../deploy/networkpolicy.yaml", import.meta.url)), "utf8");
const OPTS = { namespace: "perimeter", podLabel: { "app.kubernetes.io/name": "perimeter-sandbox" } };

test("生成的策略默认拒绝入站，且只放通 allowlist 内的服务", () => {
	const yaml = generateNetworkPolicy(POLICY, OPTS);
	assert.match(yaml, /ingress: \[\]/);
	assert.ok(!yaml.includes("name: model-gateway"));
	assert.match(yaml, /name: git-proxy/);
	// 没有任何放通公网的规则：外拨由那两个服务代做
	assert.ok(!yaml.includes("0.0.0.0/0"));
	assert.ok(!yaml.includes("ipBlock"));
});

test("DNS 必须放通，否则 allowlist 里的主机名解析不了", () => {
	const yaml = generateNetworkPolicy(POLICY, OPTS);
	assert.match(yaml, /port: 53/);
});

test("allowlist 为空时拒绝生成 —— 静默产出一条无法出网的策略更难排查", () => {
	assert.throws(() => generateNetworkPolicy("rules: []", OPTS), /egress allowlist 为空/);
});

test("新增出口只需改 policy.yaml，生成物随之变化", () => {
	const yaml = generateNetworkPolicy(
		"egress:\n  deny_all_except: [model-gateway.internal, git-proxy.internal, artifact-mirror.internal]\nrules: []",
		OPTS,
	);
	assert.match(yaml, /name: artifact-mirror/);
});

test("提交的 deploy/networkpolicy.yaml 与 policy.yaml 无漂移", () => {
	// 两份各写一遍必然漂移，且漂移方向通常是网络策略比策略文件更宽 ——
	// 那等于边界没了还没人发现。这条测试就是防线本身。
	assert.equal(GENERATED, generateNetworkPolicy(POLICY, OPTS), "请运行 npm run gen:netpol 重新生成");
});
