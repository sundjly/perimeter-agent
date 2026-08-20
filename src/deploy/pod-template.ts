import { readFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface PodVars {
	/**
	 * Pod 名。**必须由调用方给**，不能在这里自己拼 ——
	 * 后端的 wait/exec/cleanup 都用 #podName() 算名字，两处各拼一次的话
	 * 建出来的 Pod 和后续操作的 Pod 就不是同一个：wait 干等到超时、
	 * cleanup 删一个不存在的名字（--ignore-not-found 让它静默成功），
	 * 于是每失败一次泄漏一个带 token 的 Pod。
	 */
	name: string;
	sessionId: string;
	image: string;
	repo: string;
	team: string;
	namespace?: string;
	/** gVisor 之类的 runtimeClass。传空字符串表示不指定（集群没装时 Pod 会 pending） */
	runtimeClass?: string | null;
	/** 网关实例标识，进 label。用于孤儿回收，也防止两个网关互删对方的 Pod */
	gatewayId?: string;
}

/**
 * 从 deploy/sandbox.yaml 渲染出一个会话的 Pod manifest。
 *
 * 走 YAML 解析而不是字符串替换：`SESSION_ID` 这类占位符在模板里出现多次
 * （name、label、annotation），逐个字符串替换很容易漏一处，而漏掉 label
 * 的后果是 NetworkPolicy 的 selector 匹配不上 —— Pod 照常起来，
 * egress 限制却没生效。那是最不该静默失败的一条。
 *
 * 同理不做「渲染完就 apply」：manifest 是纯函数产物，可以单测、可以
 * `kubectl diff`。
 *
 * ⚠️ 往返会丢掉模板里的**注释** —— 而 sandbox.yaml 的注释承载了大量安全
 * 说明（「镜像必须有 tar」「不能把 pi 当主进程」等）。对 apply 到集群无影响，
 * 但要给客户安全团队审阅时，应当给他们看 sandbox.yaml 原文而不是这里的产物。
 */
export function renderPodManifest(templatePath: string, vars: PodVars): string {
	const doc = parseYaml(readFileSync(templatePath, "utf8")) as PodSpec;
	if (doc?.kind !== "Pod") throw new Error(`模板不是 Pod：${templatePath}`);

	doc.metadata = doc.metadata ?? {};
	doc.metadata.name = vars.name;
	if (vars.namespace) doc.metadata.namespace = vars.namespace;

	// 这些 label 是 NetworkPolicy 的 selector 依据。漏掉一个，Pod 起得来
	// 但不受 egress 约束 —— 静默失去一条真边界。
	doc.metadata.labels = {
		...doc.metadata.labels,
		"perimeter.dev/session": vars.sessionId,
		...(vars.gatewayId ? { "perimeter.dev/gateway": vars.gatewayId } : {}),
	};

	const spec = doc.spec ?? {};
	doc.spec = spec;
	// runtimeClass 显式传 null 时删掉：集群没装 gVisor 的话，
	// 留着这个字段会让 Pod 一直 pending 且原因不明显
	if (vars.runtimeClass === null) delete spec.runtimeClassName;
	else if (vars.runtimeClass) spec.runtimeClassName = vars.runtimeClass;

	const container = spec.containers?.[0];
	if (!container) throw new Error("模板里没有容器定义");
	container.image = vars.image;
	container.env = setEnv(container.env ?? [], { PERIMETER_REPO: vars.repo, PERIMETER_TEAM: vars.team });

	return stringifyYaml(doc);
}

function setEnv(env: EnvVar[], values: Record<string, string>): EnvVar[] {
	const out = env.map((e) => (values[e.name] !== undefined ? { name: e.name, value: values[e.name]! } : e));
	for (const [name, value] of Object.entries(values)) {
		if (!out.some((e) => e.name === name)) out.push({ name, value });
	}
	return out;
}

interface EnvVar {
	name: string;
	value?: string;
	[k: string]: unknown;
}

interface PodSpec {
	kind?: string;
	metadata?: { name?: string; namespace?: string; labels?: Record<string, string>; [k: string]: unknown };
	spec?: {
		runtimeClassName?: string;
		containers?: { image?: string; env?: EnvVar[]; [k: string]: unknown }[];
		[k: string]: unknown;
	};
	[k: string]: unknown;
}
