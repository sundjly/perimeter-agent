import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";
import { generateNetworkPolicy } from "../src/deploy/netpol.ts";
import { renderPodManifest } from "../src/deploy/pod-template.ts";

/**
 * 用 Kubernetes 官方 JSON schema 离线校验生成的清单。
 *
 * 为什么值得做：kubectl 的 `--dry-run=client` 其实要连集群拿 openapi，
 * 没有集群就校验不了。而 schema 校验**完全离线**，能抓住一整类真实错误 ——
 * 字段名拼错、类型写错、必填项缺失、把 string 写成 number。
 * 这些在真集群上表现为 apply 被拒，而错误信息往往指向整个对象而非那一行。
 *
 * **边界要说准确**：schema 合法 ≠ 集群会接受。准入控制器、配额、
 * runtimeClass 是否存在、镜像能否拉取，都不在 schema 覆盖范围内。
 * 这一层证明的是「清单的形状是对的」，不是「部署会成功」。
 *
 * schema 来自 kubernetes-json-schema 的 v1.31.0-standalone-strict，
 * 已存进仓库 —— 测试不该依赖网络。
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCHEMA_DIR = join(REPO, "tests/fixtures/k8s-schema");

// ajv 与 ajv-formats 是 CJS 包，在 ESM + type stripping 下用 require 最省事
const require_ = createRequire(import.meta.url);

interface Validator {
	(data: unknown): boolean;
	errors?: unknown;
}

function validator(schemaFile: string): Validator {
	const Ajv = require_("ajv");
	const addFormats = require_("ajv-formats");
	const ajv = new Ajv({ strict: false, allErrors: true });
	addFormats(ajv);
	return ajv.compile(JSON.parse(readFileSync(join(SCHEMA_DIR, schemaFile), "utf8"))) as Validator;
}

function describeErrors(errors: unknown): string {
	return JSON.stringify(errors, null, 2).slice(0, 1500);
}

test("渲染出的每会话 Pod 通过官方 schema 校验", () => {
	const manifest = renderPodManifest(join(REPO, "deploy/sandbox.yaml"), {
		name: "perimeter-abc123",
		sessionId: "abc123",
		image: "registry.internal/customer-build:v7",
		repo: "payments",
		team: "platform",
		namespace: "perimeter",
		gatewayId: "gw-1",
	});
	const validate = validator("pod.json");
	assert.ok(validate(parseYaml(manifest)), `Pod 不符合 K8s schema：\n${describeErrors(validate.errors)}`);
});

test("去掉 runtimeClass 的变体同样合法 —— 集群没装 gVisor 时要用它", () => {
	const manifest = renderPodManifest(join(REPO, "deploy/sandbox.yaml"), {
		name: "p",
		sessionId: "s",
		image: "i:1",
		repo: "r",
		team: "t",
		namespace: "perimeter",
		runtimeClass: null,
	});
	const validate = validator("pod.json");
	assert.ok(validate(parseYaml(manifest)), describeErrors(validate.errors));
});

test("模板本身（未渲染）就是合法的 Pod —— 占位符不能破坏结构", () => {
	// 占位符都在字符串值的位置上；若有人把它写进字段名或数字字段，
	// 渲染后才发现就晚了
	const validate = validator("pod.json");
	const doc = parseYaml(readFileSync(join(REPO, "deploy/sandbox.yaml"), "utf8"));
	assert.ok(validate(doc), describeErrors(validate.errors));
});

test("生成的 NetworkPolicy 通过官方 schema 校验", () => {
	// 它由 npm run gen:netpol 从 config/policy.yaml 生成，
	// 是「egress 默认 deny」这条铁律的载体
	const validate = validator("networkpolicy.json");
	const doc = parseYaml(readFileSync(join(REPO, "deploy/networkpolicy.yaml"), "utf8"));
	assert.ok(validate(doc), `NetworkPolicy 不符合 K8s schema：\n${describeErrors(validate.errors)}`);
});

test("schema 校验确实会拒绝错误的清单 —— 否则上面几条是空转", () => {
	const validate = validator("pod.json");
	// 字段名拼错（container vs containers）
	assert.equal(validate({ apiVersion: "v1", kind: "Pod", metadata: { name: "x" }, spec: { container: [] } }), false);
	// 类型写错：containers 应当是数组
	assert.equal(validate({ apiVersion: "v1", kind: "Pod", metadata: { name: "x" }, spec: { containers: {} } }), false);
	// 嵌套必填项缺失：容器必须有 name
	assert.equal(validate({ apiVersion: "v1", kind: "Pod", metadata: { name: "x" }, spec: { containers: [{}] } }), false);
});

test("schema 校验的能力边界 —— 别把它当成部署会成功的证据", () => {
	const validate = validator("pod.json");
	// standalone schema **不**把 apiVersion/kind/spec 设为必填（它们在文件名
	// 与分发方式里体现）。所以「schema 通过」连「这是个完整的 Pod」都不保证，
	// 更不用说准入控制器、配额、runtimeClass 是否存在、镜像能否拉取。
	assert.equal(validate({ kind: "Pod", metadata: { name: "x" }, spec: { containers: [{ name: "c" }] } }), true);
	assert.equal(validate({ apiVersion: "v1", kind: "Pod", metadata: { name: "x" } }), true);
});

test("运行时依赖只能是 ws 与 yaml —— 这条硬约束此前没有守卫", () => {
	// 沙箱镜像走 npm ci --omit=dev，dependencies 里多一个包就多一份
	// 进沙箱的攻击面。声明在 README 里，但没有任何自动化断言。
	const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
	assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["ws", "yaml"]);
});

test("configmap schema 有判别力 —— 否则下面那条是空转", () => {
	const validate = validator("configmap.json");
	assert.equal(validate({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "x" }, datas: {} }), false);
	assert.equal(validate({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "x" }, data: { a: 1 } }), false);
});

test("生成的策略 ConfigMap 通过官方 schema 校验", () => {
	// sandbox.yaml 引用了这份 ConfigMap；缺了它 Pod 会卡在 ContainerCreating，
	// 而症状看起来像沙箱起不来
	const validate = validator("configmap.json");
	const doc = parseYaml(readFileSync(join(REPO, "deploy/policy-configmap.yaml"), "utf8"));
	assert.ok(validate(doc), describeErrors(validate.errors));
});

test("ConfigMap 的 key 必须与 Pod 里 PERIMETER_POLICY_FILE 的文件名一致", () => {
	// 对不上的话卷挂上了、文件名却不对，扩展在容器里 readFileSync 失败
	const cm = parseYaml(readFileSync(join(REPO, "deploy/policy-configmap.yaml"), "utf8"));
	const pod = parseYaml(readFileSync(join(REPO, "deploy/sandbox.yaml"), "utf8"));
	const env = pod.spec.containers[0].env.find((e: { name: string }) => e.name === "PERIMETER_POLICY_FILE");
	const fileName = String(env.value).split("/").pop() ?? "";
	assert.ok(Object.keys(cm.data).includes(fileName), `ConfigMap 没有 key ${fileName}`);

	// 挂载点也要精确对上。前缀比较会放过 mountPath=/etc 而文件实际在
	// /etc/policy.yaml、env 却指向 /etc/perimeter/policy.yaml 的情况
	const mount = pod.spec.containers[0].volumeMounts.find((m: { name: string }) => m.name === "policy");
	assert.equal(String(env.value), `${mount.mountPath}/${fileName}`);

	// 卷引用的 ConfigMap 名字要和生成的一致
	const vol = pod.spec.volumes.find((v: { name: string }) => v.name === "policy");
	assert.equal(vol.configMap.name, cm.metadata.name);
});

test("ConfigMap 内容与 config/policy.yaml 无漂移", () => {
	// 策略是唯一事实来源，两处各维护一份必然漂移，
	// 而漂移的后果是沙箱按一份过期的规则跑
	const cm = parseYaml(readFileSync(join(REPO, "deploy/policy-configmap.yaml"), "utf8"));
	const source = readFileSync(join(REPO, "config/policy.yaml"), "utf8");
	assert.equal(cm.data["policy.yaml"], source, "请跑 npm run gen:policy-cm");
});

test("NetworkPolicy 与 config/policy.yaml 无漂移", () => {
	// 与 ConfigMap 同一个生成器模式，覆盖不该不对称。
	// egress allowlist 是四条铁律里唯一真正的技术边界，
	// 生成物滞后就意味着沙箱按一份过期的名单跑
	const generated = generateNetworkPolicy(readFileSync(join(REPO, "config/policy.yaml"), "utf8"), {
		namespace: "perimeter",
		podLabel: { "app.kubernetes.io/name": "perimeter-sandbox" },
	});
	const committed = readFileSync(join(REPO, "deploy/networkpolicy.yaml"), "utf8");
	assert.equal(committed, generated, "请跑 npm run gen:netpol");
});
