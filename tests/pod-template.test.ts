import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { k8sNameFragment, renderPodManifest } from "../src/deploy/pod-template.ts";

/**
 * 每会话 Pod 的渲染。纯函数，所以这些断言测的是真实内容而不是「没抛错」。
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATE = join(REPO, "deploy/sandbox.yaml");

function renderRaw(overrides: Partial<Parameters<typeof renderPodManifest>[1]> = {}): string {
	return renderPodManifest(TEMPLATE, {
		name: "perimeter-abc123",
		sessionId: "abc123",
		image: "registry.internal/customer-build:v7",
		repo: "payments",
		team: "platform",
		namespace: "perimeter",
		...overrides,
	});
}

function render(overrides: Partial<Parameters<typeof renderPodManifest>[1]> = {}) {
	return parseYaml(renderRaw(overrides));
}

test("Pod 名由调用方给定 —— 两处各拼一次会建出 wait/cleanup 找不到的 Pod", () => {
	const pod = render();
	assert.equal(pod.kind, "Pod");
	assert.equal(pod.metadata.name, "perimeter-abc123");
});

test("产物里不残留任何占位符", () => {
	assert.ok(!/SESSION_ID|CUSTOMER_BUILD_IMAGE|REPO_NAME|TEAM_NAME/.test(renderRaw()));
});

test("session label 必须渲染出来 —— NetworkPolicy 的 selector 靠它", () => {
	// 漏掉这个 label 的后果最不该静默：Pod 照常起来，egress 限制却没生效
	const pod = render();
	// label value 存的是规范化后的片段，不是原始 sessionId ——
	// 原始值可能含大写/下划线或超长，K8s 会直接拒
	assert.equal(pod.metadata.labels["perimeter.dev/session"], k8sNameFragment("abc123"));

	const netpol = parseYaml(readFileSync(join(REPO, "deploy/networkpolicy.yaml"), "utf8"));
	const selector = netpol.spec.podSelector.matchLabels;
	// selector 为空时下面的循环不执行，这条测试会静默通过而什么都没测
	assert.ok(Object.keys(selector).length > 0, "NetworkPolicy 的 selector 不能为空");
	for (const [k, v] of Object.entries(selector)) {
		assert.equal(pod.metadata.labels[k], v, `Pod 缺少 NetworkPolicy 依赖的 label ${k}`);
	}
	// Pod 与 NetworkPolicy 必须同 namespace：netpol 是 namespace-scoped 的，
	// Pod 落到别的 ns 就完全不受 egress 约束
	assert.equal(pod.metadata.namespace, netpol.metadata.namespace);
});

test("镜像与策略作用域被写进去", () => {
	const pod = render();
	const c = pod.spec.containers[0];
	assert.equal(c.image, "registry.internal/customer-build:v7");
	const env = Object.fromEntries(c.env.map((e: { name: string; value: string }) => [e.name, e.value]));
	assert.equal(env.PERIMETER_REPO, "payments");
	assert.equal(env.PERIMETER_TEAM, "platform");
	// 策略文件路径来自模板，不该被覆盖
	assert.equal(env.PERIMETER_POLICY_FILE, "/etc/perimeter/policy.yaml");
});

test("runtimeClass 可显式去掉 —— 集群没装 gVisor 时留着会让 Pod 一直 pending", () => {
	assert.equal(render().spec.runtimeClassName, "gvisor", "默认保留模板里的值");
	assert.equal(render({ runtimeClass: null }).spec.runtimeClassName, undefined);
	assert.equal(render({ runtimeClass: "kata" }).spec.runtimeClassName, "kata");
});

test("模板里的安全设置原样保留 —— 渲染不该稀释它们", () => {
	const sc = render().spec.containers[0].securityContext;
	assert.equal(sc.readOnlyRootFilesystem, true);
	assert.equal(sc.allowPrivilegeEscalation, false);
	assert.deepEqual(sc.capabilities.drop, ["ALL"]);
	assert.equal(render().spec.securityContext.runAsNonRoot, true);
});

test("gatewayId 进 label —— 两个网关共用一个集群时不会互删对方的 Pod", () => {
	assert.equal(render().metadata.labels["perimeter.dev/gateway"], undefined);
	assert.equal(render({ gatewayId: "gw-a" }).metadata.labels["perimeter.dev/gateway"], "gw-a");
});

test("模板不是 Pod 时直接报错，而不是 apply 一份垃圾", () => {
	assert.throws(() => renderPodManifest(join(REPO, "deploy/networkpolicy.yaml"), {
		name: "n",
		sessionId: "x",
		image: "i",
		repo: "r",
		team: "t",
	}), /不是 Pod/);
});

test("sessionId 规范化后必须满足 K8s 的名字与 label 约束", () => {
	// sessionId 是客户端可指定的（网关只校验 [A-Za-z0-9_-]{1,64}），
	// 而 K8s 的 Pod 名要符合 DNS-1123、label value 上限 63 字符。
	// schema 校验对这两条完全看不出来 —— 官方 schema 里它们都是裸 string。
	const DNS1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
	const LABEL = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;

	const inputs = [
		"a",
		"abc123",
		"Fix_Bug", // 大写 + 下划线：K8s 拒
		"abc-", // 以连字符结尾：K8s 拒
		"-abc",
		"___",
		"UPPER_CASE_ID",
		"x".repeat(64), // 顶格长度：label value 会超 63
		"9startswithdigit",
		"a-b_c-D",
	];
	for (const id of inputs) {
		const frag = k8sNameFragment(id);
		assert.ok(DNS1123.test(`perimeter-${frag}`), `Pod 名非法：${id} → perimeter-${frag}`);
		assert.ok(LABEL.test(frag) && frag.length <= 63, `label value 非法：${id} → ${frag}（${frag.length} 字符）`);
	}
});

test("规范化不同的 sessionId 不会撞名", () => {
	// Fix_Bug 与 fix-bug 规范化后同形，靠原始值的 hash 区分 ——
	// 撞名会让两个会话共用一个 Pod，或让后一个 create 失败
	assert.notEqual(k8sNameFragment("Fix_Bug"), k8sNameFragment("fix-bug"));
	assert.notEqual(k8sNameFragment("a_b"), k8sNameFragment("a-b"));
	// 同一个输入必须稳定，否则 cleanup 找不回自己建的 Pod
	assert.equal(k8sNameFragment("Fix_Bug"), k8sNameFragment("Fix_Bug"));
});
