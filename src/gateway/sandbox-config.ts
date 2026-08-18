import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SandboxWiring {
	/**
	 * 沙箱访问两个代理用的 token。**必填，且必须与网关的共享 token 不同。**
	 *
	 * 名字叫 proxyToken 而不是 sessionToken 是为了诚实：模型网关与 git 代理
	 * 目前都只认一个静态 token（见各自的 #authorized），所以它是**代理域的
	 * 共享凭据**，不是按会话签发的。做成「每会话不同」需要两个代理都实现
	 * token 校验体系，那是 Phase 2 的事 —— 在那之前不要用一个看起来能按会话
	 * 签发的 API 假装已经做到了。
	 *
	 * 为什么必须与网关 token 不同：这个值会写进沙箱可读的 models.json，
	 * agent 一句 cat 就能拿到。如果它同时是网关的 WebSocket 凭据，agent 就能
	 * 连回网关、以任意 actor 接入自己的会话，然后**批准自己挂起的审批**。
	 * 那等于把审批门的钥匙交给了被审批的一方。
	 */
	proxyToken: string;
	/** 模型网关地址，如 http://model-gateway.internal:8080/v1 */
	modelGatewayUrl?: string;
	/** 模型名。沙箱只知道名字，不知道它背后是哪个 provider、用的哪把 key */
	model?: string;
	/** git 代理地址，如 http://git-proxy.internal:8080 */
	gitProxyUrl?: string;
	/**
	 * 需要经代理访问的上游 SCM 主机，如 ["gitlab.internal", "github.com"]。
	 * 重写后的路径带上主机名（`/<host>/<repo>`），因此 git 代理的
	 * `repos[].name` 必须写成 `gitlab.internal/team/app.git` 这种完整形式 ——
	 * 不带主机名的话，两个上游的同名仓库会塌缩成同一条 allowlist 条目，
	 * agent 请求 github 的仓库会拿到 gitlab 那个仓库的凭据与内容。
	 */
	scmHosts?: string[];
}

export interface SandboxConfig {
	/** 生成出的 HOME 目录，作为 pi 进程的 HOME */
	home: string;
	/** 供 pi 使用的 provider/model 参数 */
	piArgs: string[];
}

const PROVIDER = "perimeter";

/**
 * 为一个会话生成沙箱侧配置 —— 这是「凭据永不进沙箱」在配置层的落地。
 *
 * 沙箱里能看到的只有：
 * - 一个指向**模型网关**的 baseUrl，apiKey 是代理 token
 * - 一条把上游 SCM 重写到 **git 代理**的 insteadOf 规则，密码是代理 token
 *
 * 真正的模型 key 只在模型网关进程里，真正的 git token 只在 git 代理进程里。
 * 代理 token 拿到别处毫无用处：它只能访问这两个代理，且分别被 egress
 * allowlist 与 repo allowlist 二次约束 —— 前提是它不等于网关 token，
 * 这一条由 Gateway 在构造时断言。
 *
 * **home 必须放在 workspace 之外**：放在里面的话，agent 一句
 * `git add -A && git commit` 就会把含 token 的 .gitconfig 提交进仓库，
 * 再经 git 代理推到真实上游。
 */
export function writeSandboxConfig(home: string, w: SandboxWiring): SandboxConfig {
	if (!w.proxyToken) throw new Error("wiring.proxyToken 必填");
	if (w.gitProxyUrl && !w.modelGatewayUrl) {
		// HOME 覆盖是无条件生效的：只配 git 不配模型，pi 会指向一个没有
		// models.json 的空 HOME，任何 provider 都读不到，会话起不来且无解释
		throw new Error("wiring：配了 gitProxyUrl 就必须同时配 modelGatewayUrl，否则沙箱读不到任何 provider");
	}

	const agentDir = join(home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });

	const piArgs: string[] = [];

	if (w.modelGatewayUrl) {
		writeFileSync(
			join(agentDir, "models.json"),
			`${JSON.stringify(
				{
					providers: {
						[PROVIDER]: {
							baseUrl: w.modelGatewayUrl,
							api: "openai-completions",
							// 沙箱拿到的是代理 token；模型网关据此鉴权，再换成真 key 发往上游
							apiKey: w.proxyToken,
							compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
							models: [{ id: w.model ?? "default" }],
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		piArgs.push("--provider", PROVIDER, "--model", w.model ?? "default");
	}

	if (w.gitProxyUrl && w.scmHosts?.length) {
		const proxy = new URL(w.gitProxyUrl);
		// token 必须编码：含 / @ : % 的 token 会把 URL 解析歪，
		// 表现为连不上而不是报错。base64 形式的 token 很常见。
		const cred = `x-session:${encodeURIComponent(w.proxyToken)}`;
		const sections = w.scmHosts
			.map((host) => {
				const rewritten = `${proxy.protocol}//${cred}@${proxy.host}${proxy.pathname.replace(/\/$/, "")}/${host}/`;
				// 同时覆盖 https 与 ssh 形式，否则 agent 换个协议就绕过了代理
				return `[url "${rewritten}"]\n\tinsteadOf = https://${host}/\n\tinsteadOf = git@${host}:\n`;
			})
			.join("");
		// 关掉凭据 helper：沙箱里不该有任何本地凭据存储，
		// 也不该在代理返回 401 时去别处找凭据
		writeFileSync(join(home, ".gitconfig"), `${sections}[credential]\n\thelper =\n`);
	}

	return { home, piArgs };
}
