import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/audit/log.ts";
import { Gateway } from "../src/gateway/server.ts";
import { GitCredentialProxy } from "../src/gitproxy/server.ts";
import { ModelGateway } from "../src/modelgw/server.ts";

/**
 * 一键起演示环境：mock 模型 → 模型网关 → 网关 → pi。
 *
 * 三个进程按真实架构接线，而不是让 pi 直连 provider：
 * agent 只拿到一个指向模型网关的 baseUrl，apiKey 是会话 token；
 * 「上游凭据」只存在于模型网关进程里。演示时可以当场 `env` 给客户看。
 *
 * 用 mock 模型而不是真实 provider，是因为策略文档要求 demo 有
 * 「演示环境挂掉时的保险」—— 这条链路在零凭据、零外网的机器上也跑得通。
 * 接真实模型：设 PERIMETER_DEMO_REAL=1 并按 pi 的常规方式配好 provider。
 */

const root = join(import.meta.dirname, "..");

/**
 * 等子进程报告端口。必须有兜底：子进程启动失败时 stdout 永远不会来数据，
 * 没有超时的话 demo 会静默挂死，连 banner 都不打印 —— 最难排查的失败形态。
 */
function waitForPort(proc: { stdout: NodeJS.ReadableStream | null }, what: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${what} 启动超时`)), 10_000);
		proc.stdout?.once("data", (d: Buffer) => {
			clearTimeout(timer);
			try {
				resolve(JSON.parse(d.toString()).port);
			} catch (e) {
				reject(new Error(`${what} 未报告端口：${String(e)}`));
			}
		});
	});
}

import { randomBytes } from "node:crypto";
const TOKEN = process.env.PERIMETER_TOKEN ?? "demo-token";
// 模型、git 与浏览器凭据分域；模型 token 只在可信网关。
const PROXY_TOKEN = process.env.PERIMETER_PROXY_TOKEN ?? "demo-proxy-token";
// B2：共享静态 git token 已废除。masterKey/internalToken 随机生成一次，demo 双进程
// （网关 + git 代理）各持一份；每个会话的 grant 由网关签发、沙箱 .gitconfig 只见 grant 串。
const GIT_GRANT_MASTER_KEY = randomBytes(32);
const GIT_REGISTRY_INTERNAL_TOKEN = randomBytes(24).toString("base64url");
const real = process.env.PERIMETER_DEMO_REAL === "1";

// 演示脚本：agent 先改一个源码文件（放行），再试图改 CI（拒绝），最后 push（审批）
const script = [
	{ tool: "write", args: { path: "src/session.ts", content: "// 超时从 5s 调整为 30s\nexport const TIMEOUT_MS = 30_000;\n" } },
	{ tool: "write", args: { path: ".github/workflows/deploy.yml", content: "on: push" } },
	{ tool: "bash", args: { command: "git add -A && git commit -qm '修复登录超时' && git push origin main" } },
	{ text: "已把登录超时从 5 秒调整为 30 秒。CI 配置的改动被策略拒绝，推送在等你批准。" },
];

mkdirSync(join(root, "audit-data"), { recursive: true });
const auditFile = join(root, "audit-data/demo.jsonl");
const workspaceRoot = mkdtempSync(join(tmpdir(), "perimeter-demo-"));
// R72-v5 教训：默认 stateRoot 是 workspaceRoot+".state" 的字符串拼接（无路径分隔符）。
// demo 显式配置并自建目录（网关不代建），会话元数据/吊销表/注册表落位确定。
const stateRoot = join(root, "audit-data/state");
mkdirSync(stateRoot, { recursive: true });

let gitProxyRef: GitCredentialProxy | undefined;
let wiring:
	| { gitProxyToken: string; proxyToken: string; modelGatewayUrl: string; model: string; gitProxyUrl: string; scmHosts: string[] }
	| undefined;
let repoUrl: string | undefined;
let upstreamRepo: string | undefined;

if (!real) {
	// ① mock 模型端点 —— 扮演 Bedrock / Vertex / vLLM 的位置
	const mock = spawn(process.execPath, [join(root, "tests/fixtures/mock-model.mjs"), "0", JSON.stringify(script)], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	const mockPort = await waitForPort(mock, "mock 模型");
	process.on("exit", () => mock.kill());

	// ② 模型网关 —— 唯一持有上游凭据的进程
	const modelAudit = AuditLog.open(join(root, "audit-data/modelgw.jsonl"));
	const modelGw = new ModelGateway({
		port: 0,
		host: "127.0.0.1",
		token: PROXY_TOKEN,
		upstreams: [
			{
				id: "upstream",
				baseUrl: `http://127.0.0.1:${mockPort}/v1`,
				// 这把「上游密钥」从头到尾不出这个进程
				apiKey: "UPSTREAM-SECRET-KEY-never-leaves-this-process",
			},
		],
		egressAllowlist: ["127.0.0.1"],
		audit: modelAudit,
	});
	const modelPort = await modelGw.listen();
	process.on("exit", () => void modelGw.close());

	// ③ 一个真实的上游 git 仓库（扮演 GitLab 的位置）
	const scmRoot = mkdtempSync(join(tmpdir(), "perimeter-scm-"));
	upstreamRepo = join(scmRoot, "app.git");
	const seed = mkdtempSync(join(tmpdir(), "perimeter-seed-"));
	const g = (args: string[], cwd: string) =>
		execFileSync("git", args, {
			cwd,
			env: { PATH: process.env.PATH ?? "", HOME: cwd, GIT_AUTHOR_NAME: "seed", GIT_AUTHOR_EMAIL: "s@s", GIT_COMMITTER_NAME: "seed", GIT_COMMITTER_EMAIL: "s@s" },
		});
	g(["init", "-q", "-b", "main"], seed);
	writeFileSync(join(seed, "src.txt"), "登录超时目前写死 5 秒\n");
	g(["add", "."], seed);
	g(["commit", "-qm", "初始提交"], seed);
	g(["init", "-q", "--bare", upstreamRepo], scmRoot);
	g(["remote", "add", "origin", upstreamRepo], seed);
	g(["push", "-q", "origin", "main"], seed);

	const scmAuth = `Basic ${Buffer.from("x-access-token:UPSTREAM-GIT-TOKEN-never-leaves-proxy").toString("base64")}`;
	const scm = spawn(process.execPath, [join(root, "tests/fixtures/git-http-server.mjs"), scmRoot, scmAuth], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	const scmPort = await waitForPort(scm, "git 上游服务");
	process.on("exit", () => scm.kill());

	// ④ git 凭据代理 —— 唯一持有 git token 的进程
	const gitAudit = AuditLog.open(join(root, "audit-data/gitproxy.jsonl"));
	const gitProxy = new GitCredentialProxy({
		port: 0,
		host: "127.0.0.1",
		mode: "dev", // demo 双进程：显式 dev 模式
		masterKey: GIT_GRANT_MASTER_KEY,
		// 真实轮询网关 internal registry 端点（C3：禁止内存 stub 替代轮询路径）。
		// gwPort 在下方 Gateway listen 后可得——用 late-bound 占位对象在 listen 后回填。
		registry: {
			url: "",
			internalToken: GIT_REGISTRY_INTERNAL_TOKEN,
			// R76/R2：pollMs 真实驱动轮询节奏（interval=min(pollMs, maxAuthAge−1s)）；
			// dev maxAuthAge 30s 配 4s → 吊销/轮换 ≤4s 生效（合同 C2 ≤5s）。
			pollMs: 4_000,
		},
		audit: gitAudit,
		repos: [
			{
				name: "git.internal/app.git",
				upstream: `http://127.0.0.1:${scmPort}/app.git`,
				username: "x-access-token",
				token: "UPSTREAM-GIT-TOKEN-never-leaves-proxy",
				// 代理默认只读，推送必须显式授权 —— demo 第三段正要演示
				// 「审批通过后推送真的到达上游」
				allowPush: true,
			},
		],
	});
	const gitProxyPort = await gitProxy.listen();
	gitProxyRef = gitProxy;
	process.on("exit", () => void gitProxy.close());

	// ⑤ 接线：沙箱只看到两个代理的地址 + 代理 token
	wiring = {
		// B2：wiring.gitProxyToken 最终值由网关在会话接入（#acceptConnection）时用
		// gitGrants 签发的 per-session grant 覆盖（见下方 Gateway gitGrants 接线）。
		gitProxyToken: "",
		proxyToken: PROXY_TOKEN,
		modelGatewayUrl: `http://127.0.0.1:${modelPort}/v1`,
		model: "mock-model",
		gitProxyUrl: `http://127.0.0.1:${gitProxyPort}`,
		scmHosts: ["git.internal"],
	};
	repoUrl = "https://git.internal/app.git";
}

const gw = new Gateway({
	mode: "demo",
	port: Number(process.env.PORT ?? 8787),
	host: "127.0.0.1",
	token: TOKEN,
	// B2：会话级 scoped git grant 签发（C3 真实双进程接线）——网关持 masterKey 与
	// internal 端点，代理轮询消费；grant 只经 wiring 进沙箱 HOME 外 .gitconfig。
	gitGrants: {
		masterKey: GIT_GRANT_MASTER_KEY,
		internalToken: GIT_REGISTRY_INTERNAL_TOKEN,
		writeRefs: ["refs/heads/*"],
		repos: [{ name: "git.internal/app.git", allowPush: true }],
		// R-Q50-3：活会话 grant 续签（10min < 15min TTL，后台长活动会话也真有触发）
		renewIntervalMs: 10 * 60_000,
	},
	policyFile: join(root, "config/policy.yaml"),
	auditFile,
	stateRoot,
	workspaceRoot,
	webRoot: join(root, "web"),
	model: real ? { baseUrl: process.env.PERIMETER_MODEL_GATEWAY_URL ?? "http://127.0.0.1:8080/v1", token: process.env.PERIMETER_MODEL_PROXY_TOKEN ?? "", model: process.env.PERIMETER_MODEL ?? "default" } : undefined,
	wiring,
	repoUrl,
	approvalTimeoutMs: 120_000,
	resolveScope: () => ({ repo: "demo-app", team: "platform" }),
});

const port = await gw.listen();
// B2：网关端口就绪后回填代理 registry url（dev 模式启动窗口；下一轮询拍生效）
gitProxyRef?.setRegistryUrl(`http://127.0.0.1:${port}/internal/git/registry`);
console.log(`
演示环境就绪（Pi Durable 1.1.0${real ? "，真实模型" : "，mock 模型，无需凭据"}）

  打开（owner）：http://127.0.0.1:${port}/#token=${TOKEN}&actor=demo@local
  审批人（第二窗口，<会话ID> 见下方流程①）：
    http://127.0.0.1:${port}/?session=<会话ID>#token=${TOKEN}&actor=approver@local
  工作区：${workspaceRoot}
  审计日志：${auditFile}
${real ? "" : `
链路：浏览器 / CLI → 网关内 Durable → 模型网关 → mock 模型
                              └→ git 凭据代理 → 上游仓库

会话启动时网关已经经凭据代理 clone 了仓库。凭据分域：
  · 网关 token（${TOKEN}）      —— 浏览器用，沙箱看不到
  · 模型代理 token             —— 只在可信网关
  · git 代理 token              —— 沙箱 HOME，不能访问模型/会话网关
  · 上游 API key 与 git token   —— 只在两个代理进程里，沙箱与浏览器都看不到
沙箱只有 .gitconfig，没有 models.json 或模型 token。
HOME 在 workspace 之外，agent 的 git commit 带不走它。

审批通过后推送会真的到达上游仓库，可以当场验证：
  git -C ${upstreamRepo ?? ""} log --oneline -2 main
`}
试着发一句「修复登录超时的 bug」，会看到：
  1. 改源码 → 放行，审计里出现 policy.verdict allow
  2. 改 .github/workflows/ → 被策略拒绝，界面上出现红色条目
  3. git push → 审批门拦下（审批需要 approver 角色，防自批）。双人流程：
     ① owner 连上后，从地址栏复制会话地址（含 ?session=<会话ID>）
     ② 给会话加审批人（网页无此入口，用 attach CLI 另开一个终端）：
        npm run attach -- --url http://127.0.0.1:${port} --session <会话ID> --actor demo@local --token ${TOKEN}
        连接后输入：/share approver@local approver
     ③ 审批人打开第二个浏览器窗口（上方「审批人」模板，替换 <会话ID>），
        对审批点「允许」。share 即刻以新 aclVersion 重签 git grant（agent 无感）；
        批准后推送真的到达上游仓库（审批超时按拒绝）。

校验审计链完整性：
  node -e "import('./src/audit/log.ts').then(async m => console.log(await m.AuditLog.verify('${auditFile}')))"
`);

process.on("SIGINT", () => {
	void gw.close().then(() => process.exit(0));
});
