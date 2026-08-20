import { stringify as stringifyYaml } from "yaml";

/**
 * 从 config/policy.yaml 生成 Pod 要挂的 ConfigMap。
 *
 * 为什么必须有：`deploy/sandbox.yaml` 引用了名为 `perimeter-policy` 的
 * ConfigMap，而此前仓库里没有任何东西创建它 —— K8s 对缺失的 configMap 卷
 * 会让 Pod 卡在 ContainerCreating，永远不 Ready，`kubectl exec` 也就无从谈起。
 * 症状离原因很远：看起来像沙箱起不来，实际是少了一份清单。
 *
 * 与 NetworkPolicy 同理，**刻意生成而不是手写**：策略文件是唯一事实来源，
 * 两处各维护一份必然漂移，而漂移的后果是沙箱按一份过期的规则跑。
 */
export interface PolicyConfigMapOptions {
	namespace: string;
}

/** ConfigMap 的名字，与 sandbox.yaml 的 volumes[].configMap.name 对应 */
const NAME = "perimeter-policy";
/**
 * ConfigMap 里的 key。**必须与 sandbox.yaml 中 PERIMETER_POLICY_FILE
 * 路径的最后一段一致** —— 不一致的话卷挂上了、文件名却对不上，
 * 扩展会在容器里 readFileSync 失败。两者的一致性有测试守着。
 */
const KEY = "policy.yaml";

export function generatePolicyConfigMap(policyYaml: string, opts: PolicyConfigMapOptions): string {
	const header = "# 本文件由 npm run gen:policy-cm 从 config/policy.yaml 生成，请勿手改。\n";
	return header + stringifyYaml({
		apiVersion: "v1",
		kind: "ConfigMap",
		metadata: {
			name: NAME,
			namespace: opts.namespace,
			labels: { "app.kubernetes.io/name": "perimeter-sandbox" },
		},
		data: { [KEY]: policyYaml },
	});
}
