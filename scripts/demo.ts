import { execFileSync, spawn, spawnSync } from "node:child_process";
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

// pi 不是 npm 依赖（本仓库只用它的 RPC 模式，不锁版本）。不预检的话，
// 失败形态是最难排查的那种：banner 与地址照常打印，客户点开链接才收到
// 「spawn pi ENOENT」—— 演示时看起来一切正常，一开口就死。
const probe = spawnSync("pi", ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
	console.error(
		"找不到 pi。请先全局安装（实测版本 0.84.2）：\n" +
			"  npm i -g @earendil-works/pi-coding-agent\n" +
			"装好后确认 pi 在 PATH 上：pi --version",
	);
	process.exit(1);
}

const TOKEN = process.env.PERIMETER_TOKEN ?? "demo-token";
// 代理 token 与网关 token 必须不同 —— 演示时这正是最有说服力的一点：
// 打开沙箱的 models.json，里面那串和浏览器地址栏里的不一样，
// 说明「连网关的身份」与「访问代理的凭据」是两个域。
const PROXY_TOKEN = process.env.PERIMETER_PROXY_TOKEN ?? "demo-proxy-token";
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
const piEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: process.env.LANG };
// 真实模型模式下不接线，pi 需要操作员的 HOME 才能读到常规 provider 配置
if (real) piEnv.HOME = process.env.HOME;

let wiring:
	| { proxyToken: string; modelGatewayUrl: string; model: string; gitProxyUrl: string; scmHosts: string[] }
	| undefined;
let repoUrl: string | undefined;
let upstreamRepo: string | undefined;
let piArgs = process.env.PERIMETER_PI_ARGS?.split(" ").filter(Boolean) ?? [];

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
		token: PROXY_TOKEN,
		audit: gitAudit,
		repos: [
			{
				name: "git.internal/app.git",
				upstream: `http://127.0.0.1:${scmPort}/app.git`,
				username: "x-access-token",
				token: "UPSTREAM-GIT-TOKEN-never-leaves-proxy",
			},
		],
	});
	const gitProxyPort = await gitProxy.listen();
	process.on("exit", () => void gitProxy.close());

	// ⑤ 接线：沙箱只看到两个代理的地址 + 代理 token
	wiring = {
		proxyToken: PROXY_TOKEN,
		modelGatewayUrl: `http://127.0.0.1:${modelPort}/v1`,
		model: "mock-model",
		gitProxyUrl: `http://127.0.0.1:${gitProxyPort}`,
		scmHosts: ["git.internal"],
	};
	repoUrl = "https://git.internal/app.git";
	piArgs = ["--no-session"];
}

const gw = new Gateway({
	port: Number(process.env.PORT ?? 8787),
	host: "127.0.0.1",
	token: TOKEN,
	policyFile: join(root, "config/policy.yaml"),
	auditFile,
	workspaceRoot,
	webRoot: join(root, "web"),
	piArgs,
	piEnv,
	wiring,
	repoUrl,
	approvalTimeoutMs: 120_000,
	resolveScope: () => ({ repo: "demo-app", team: "platform" }),
});

const port = await gw.listen();
console.log(`
演示环境就绪（pi ${probe.stdout.trim()}${real ? "，真实模型" : "，mock 模型，无需凭据"}）

  打开：http://127.0.0.1:${port}/?token=${TOKEN}
  工作区：${workspaceRoot}
  审计日志：${auditFile}
${real ? "" : `
链路：浏览器 → 网关 → pi（沙箱）→ 模型网关 → mock 模型
                              └→ git 凭据代理 → 上游仓库

会话启动时网关已经经凭据代理 clone 了仓库。三种凭据分处三地：
  · 网关 token（${TOKEN}）      —— 浏览器用，沙箱看不到
  · 代理 token（${PROXY_TOKEN}）—— 沙箱用，只能访问两个代理
  · 上游 API key 与 git token   —— 只在两个代理进程里，沙箱与浏览器都看不到
沙箱侧的 models.json 与 .gitconfig 里写的是代理 token，演示时当场打开给客户看。
HOME 在 workspace 之外，agent 的 git commit 带不走它。

审批通过后推送会真的到达上游仓库，可以当场验证：
  git -C ${upstreamRepo ?? ""} log --oneline -2 main
`}
试着发一句「修复登录超时的 bug」，会看到：
  1. 改源码 → 放行，审计里出现 policy.verdict allow
  2. 改 .github/workflows/ → 被策略拒绝，界面上出现红色条目
  3. git push → 审批门拦下，等你点批准或拒绝（超时按拒绝）

校验审计链完整性：
  node -e "import('./src/audit/log.ts').then(async m => console.log(await m.AuditLog.verify('${auditFile}')))"
`);

process.on("SIGINT", () => {
	void gw.close().then(() => process.exit(0));
});
