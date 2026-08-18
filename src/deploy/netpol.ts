import { PolicyEngine } from "../policy/engine.ts";

export interface NetpolOptions {
	namespace: string;
	/** 沙箱 Pod 的标签选择器 */
	podLabel: Record<string, string>;
	/** 集群内 DNS 服务所在命名空间，沙箱必须能解析主机名 */
	dnsNamespace?: string;
}

/**
 * 从 config/policy.yaml 的 egress allowlist 生成 NetworkPolicy。
 *
 * **刻意生成而不是手写**：allowlist 是四条铁律里唯一真正的技术边界
 * （另外三条要么是流程、要么依赖它）。如果 YAML 里写一份、YAML manifest
 * 里再写一份，两份迟早会漂移，而漂移的方向通常是「网络策略比策略文件更宽」——
 * 那就等于边界没了，且没人会发现。
 *
 * 生成出来的策略是 **默认 deny all**，只放通：
 * - allowlist 里的内部服务（模型网关、git 代理）
 * - 集群 DNS（否则连这两个名字都解析不了）
 *
 * 注意这里放通的是**集群内**的两个服务名。沙箱到公网的出口一律没有 ——
 * 模型与 SCM 的实际外拨由那两个服务代为完成，它们才是唯一的外部出口。
 */
export function generateNetworkPolicy(policyYaml: string, opts: NetpolOptions): string {
	const allowlist = PolicyEngine.fromYaml(policyYaml).egressAllowlist;
	if (allowlist.length === 0) {
		throw new Error("egress allowlist 为空：这会生成一条完全无法出网的策略，沙箱连模型都调不到");
	}

	const selector = Object.entries(opts.podLabel)
		.map(([k, v]) => `      ${k}: ${v}`)
		.join("\n");

	const egressRules = allowlist
		.map(
			(host) => `    # 放通 ${host}（由 config/policy.yaml 的 egress.deny_all_except 生成）
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: ${serviceName(host)}
      ports:
        - protocol: TCP
          port: 8080`,
		)
		.join("\n");

	return `# 本文件由 \`npm run gen:netpol\` 从 config/policy.yaml 生成，请勿手改。
# 唯一事实来源是 policy.yaml 的 egress.deny_all_except。
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: perimeter-sandbox-egress
  namespace: ${opts.namespace}
spec:
  podSelector:
    matchLabels:
${selector}
  policyTypes:
    - Ingress
    - Egress
  # 入站全拒：沙箱不需要被任何人连进来，网关是主动连出去的一侧
  ingress: []
  egress:
${egressRules}
    # DNS 必须放通，否则上面那些主机名解析不了
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ${opts.dnsNamespace ?? "kube-system"}
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
`;
}

/** model-gateway.internal → model-gateway */
function serviceName(host: string): string {
	return host.split(".")[0] ?? host;
}
