import { createHash } from "node:crypto";
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
/**
 * 把 sessionId 规范成 K8s 能接受的名字片段。
 *
 * 三条约束，任一违反 Pod 都会被直接拒绝，而 schema 校验**看不出来**
 * （官方 schema 把 name 与 label value 都声明成裸 string）：
 * - Pod 名要符合 DNS-1123：`[a-z0-9]([-a-z0-9]*[a-z0-9])?`，不许大写与下划线
 * - label value 上限 63 字符
 * - 首尾必须是字母数字
 *
 * 而 sessionId 是**客户端可指定**的（网关只校验 `[A-Za-z0-9_-]{1,64}`），
 * 所以 `?session=Fix_Bug` 或一个 64 字符的 id 就能让整个会话起不来。
 * docker 后端不受影响（容器名允许大写和下划线），所以这条一直没暴露。
 *
 * 规范化会让不同的 sessionId 撞名（`Fix_Bug` 与 `fix-bug`），因此补一段
 * 来自原始值的短 hash 保唯一。
 */
export function k8sNameFragment(sessionId: string): string {
	const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
	const lowered = sessionId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
	// 留出 hash 与连接符的位置；总长控制在 label value 的 63 上限内
	const body = lowered.slice(0, 40).replace(/^-+|-+$/g, "");
	return body ? `${body}-${hash}` : hash;
}

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
		// label value 有 63 字符上限且首尾必须是字母数字，直接放 sessionId 会被拒
		"perimeter.dev/session": k8sNameFragment(vars.sessionId),
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
