import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../src/gateway/server.ts";

/**
 * 一键起演示环境：mock 模型 + 网关 + 一个预置了 bug 的工作区。
 *
 * 用 mock 模型而不是真实 provider，是因为策略文档要求 demo 有
 * 「演示环境挂掉时的保险」—— 这条链路在零凭据、零外网的机器上也跑得通。
 * 接真实模型：设 PERIMETER_DEMO_REAL=1 并按 pi 的常规方式配好 provider。
 */

const root = join(import.meta.dirname, "..");
const TOKEN = process.env.PERIMETER_TOKEN ?? "demo-token";
const real = process.env.PERIMETER_DEMO_REAL === "1";

// 演示脚本：agent 先改一个源码文件（放行），再试图改 CI（拒绝），最后 push（审批）
const script = [
	{ tool: "write", args: { path: "src/session.ts", content: "// 超时从 5s 调整为 30s\nexport const TIMEOUT_MS = 30_000;\n" } },
	{ tool: "write", args: { path: ".github/workflows/deploy.yml", content: "on: push" } },
	{ tool: "bash", args: { command: "git push origin fix/login-timeout" } },
	{ text: "已把登录超时从 5 秒调整为 30 秒。CI 配置的改动被策略拒绝，推送在等你批准。" },
];

const workspaceRoot = mkdtempSync(join(tmpdir(), "perimeter-demo-"));
const piEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG };
let piArgs = process.env.PERIMETER_PI_ARGS?.split(" ").filter(Boolean) ?? [];

if (!real) {
	const mock = spawn(process.execPath, [join(root, "tests/fixtures/mock-model.mjs"), "0", JSON.stringify(script)], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	const port: number = await new Promise((r) => mock.stdout.once("data", (d) => r(JSON.parse(d.toString()).port)));
	const home = mkdtempSync(join(tmpdir(), "perimeter-pihome-"));
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(
		join(home, ".pi", "agent", "models.json"),
		JSON.stringify({
			providers: {
				mock: {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "dummy",
					compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
					models: [{ id: "mock-model" }],
				},
			},
		}),
	);
	piEnv.HOME = home;
	piArgs = ["--no-session", "--provider", "mock", "--model", "mock-model"];
	process.on("exit", () => mock.kill());
}

mkdirSync(join(root, "audit-data"), { recursive: true });
const gw = new Gateway({
	port: Number(process.env.PORT ?? 8787),
	host: "127.0.0.1",
	token: TOKEN,
	policyFile: join(root, "config/policy.yaml"),
	auditFile: join(root, "audit-data/demo.jsonl"),
	workspaceRoot,
	webRoot: join(root, "web"),
	piArgs,
	piEnv,
	approvalTimeoutMs: 120_000,
	resolveScope: () => ({ repo: "demo-app", team: "platform" }),
});

const port = await gw.listen();
console.log(`
演示环境就绪（${real ? "真实模型" : "mock 模型，无需凭据"}）

  打开：http://127.0.0.1:${port}/?token=${TOKEN}
  工作区：${workspaceRoot}
  审计日志：${join(root, "audit-data/demo.jsonl")}

试着发一句「修复登录超时的 bug」，会看到：
  1. 改源码 → 放行，审计里出现 policy.verdict allow
  2. 改 .github/workflows/ → 被策略拒绝，界面上出现红色条目
  3. git push → 审批门拦下，等你点批准或拒绝（超时按拒绝）

校验审计链完整性：
  node -e "import('./src/audit/log.ts').then(async m => console.log(await m.AuditLog.verify('audit-data/demo.jsonl')))"
`);

process.on("SIGINT", () => {
	void gw.close().then(() => process.exit(0));
});
