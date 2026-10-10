import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SandboxWiring {
	/** 模型代理凭据只用于可信网关，从不写入沙箱。两个代理仍用静态 token。 */
	proxyToken: string;
	/** 沙箱只持有 git 代理凭据，必须与模型/浏览器 token 分开。 */
	gitProxyToken?: string;
	/** 模型网关地址，如 http://model-gateway.internal:8080/v1 */
	modelGatewayUrl?: string;
	/** 可信网关模型目录的名字。 */
	model?: string;
	/**
	 * 提交身份。**容器里必须给** —— 沙箱 HOME 是全新空目录、hostname 通常无域，
	 * git 会以 `unable to auto-detect email address (got 'x@y.(none)')` 拒绝提交。
	 * 本机 macOS 能自动推断所以看不出来，而 K8s 沙箱正是产品的目标运行环境：
	 * commit 一挂，`git add && git commit && git push` 整条就静默不发生。
	 * 顺带让上游提交可归属到发起会话的人。
	 */
	authorName?: string;
	authorEmail?: string;
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
	/** 工具执行环境的 HOME，必须在工作区之外。 */
	home: string;
}

/**
 * 沙箱 HOME 只生成 git 重写配置；删除迁移前的 .pi，避免遗留模型 token。
 * HOME 在 workspace 外，git add -A 不会把代理凭据带进提交。
 */
export function writeSandboxConfig(home: string, w: SandboxWiring): SandboxConfig {
	for (const value of [w.authorName, w.authorEmail]) if (value && /[\x00-\x1f\x7f]/.test(value)) throw new Error("git 作者不能包含控制字符");
	if (!w.proxyToken) throw new Error("wiring.proxyToken 必填");
	if (w.gitProxyUrl && (!w.gitProxyToken || w.gitProxyToken === w.proxyToken)) throw new Error("gitProxyToken 必填且必须与模型 token 不同");

	mkdirSync(home, { recursive: true });
	rmSync(join(home, ".pi"), { recursive: true, force: true });

	if (w.gitProxyUrl && w.scmHosts?.length) {
		const proxy = new URL(w.gitProxyUrl);
		// token 必须编码：含 / @ : % 的 token 会把 URL 解析歪，
		// 表现为连不上而不是报错。base64 形式的 token 很常见。
		const cred = `x-session:${encodeURIComponent(w.gitProxyToken!)}`;
		const sections = w.scmHosts
			.map((host) => {
				const rewritten = `${proxy.protocol}//${cred}@${proxy.host}${proxy.pathname.replace(/\/$/, "")}/${host}/`;
				// 同时覆盖 https 与 ssh 形式，否则 agent 换个协议就绕过了代理
				return `[url "${rewritten}"]\n\tinsteadOf = https://${host}/\n\tinsteadOf = git@${host}:\n`;
			})
			.join("");
		// 关掉凭据 helper：沙箱里不该有任何本地凭据存储，
		// 也不该在代理返回 401 时去别处找凭据
		const user = `[user]\n\tname = ${w.authorName ?? "perimeter-agent"}\n\temail = ${w.authorEmail ?? "agent@perimeter.local"}\n`;
		writeFileSync(join(home, ".gitconfig"), `${sections}${user}[credential]\n\thelper =\n`);
	}

	return { home };
}
