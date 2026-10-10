import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AuditLog } from "../src/audit/log.ts";
import { writeSandboxConfig } from "../src/gateway/sandbox-config.ts";
import { GitCredentialProxy } from "../src/gitproxy/server.ts";

/**
 * Week 3 的验收标准：**沙箱内 git clone + git push 成功，
 * 且沙箱侧看不到任何 git 凭据。**
 *
 * 全程用真实的 git 客户端与真实的 git smart HTTP 上游，不是 mock HTTP。
 *
 * 一个踩过的坑记在这里：这组测试必须用**异步** execFile。早先版本用
 * execFileSync，同步阻塞会让 node:test 的 test-timeout 完全失效 ——
 * 表现为整个测试进程挂死几分钟而不是超时失败，极难定位。
 */

const GIT_SERVER = fileURLToPath(new URL("./fixtures/git-http-server.mjs", import.meta.url));
const UPSTREAM_TOKEN = "glpat-upstream-token-only-in-proxy";
const UPSTREAM_AUTH = `Basic ${Buffer.from(`x-access-token:${UPSTREAM_TOKEN}`).toString("base64")}`;
const PROXY_TOKEN = "sandbox-proxy-token";

const exec = promisify(execFile);

/** 递归收集目录下所有文件 */
function readAllFiles(dir: string, out: { path: string; text: string }[] = []): { path: string; text: string }[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) readAllFiles(p, out);
		else {
			try {
				out.push({ path: p, text: readFileSync(p, "utf8") });
			} catch {
				// 二进制或不可读文件跳过 —— token 是文本，不会藏在这里
			}
		}
	}
	return out;
}
const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups) await c();
});

/** 沙箱里的 git：HOME 指向网关生成的配置，环境里没有任何凭据 */
function git(args: string[], cwd: string, home?: string) {
	return exec("git", args, {
		cwd,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: home ?? cwd,
			GIT_AUTHOR_NAME: "agent",
			GIT_AUTHOR_EMAIL: "agent@sandbox",
			GIT_COMMITTER_NAME: "agent",
			GIT_COMMITTER_EMAIL: "agent@sandbox",
			GIT_TERMINAL_PROMPT: "0",
		},
	});
}

/** 建一个带一次提交的裸仓库作为上游 */
async function makeUpstream(): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), "up-"));
	const work = mkdtempSync(join(tmpdir(), "upwork-"));
	await git(["init", "-q", "-b", "main"], work);
	writeFileSync(join(work, "README.md"), "# 上游仓库\n");
	await git(["add", "."], work);
	await git(["commit", "-qm", "初始提交"], work);
	await git(["init", "-q", "--bare", join(root, "app.git")], root);
	// 允许推送到已检出的分支（裸仓库默认就行，这里显式设一下更稳）
	await git(["config", "receive.denyCurrentBranch", "ignore"], join(root, "app.git"));
	await git(["remote", "add", "origin", join(root, "app.git")], work);
	await git(["push", "-q", "origin", "main"], work);
	return root;
}

async function startUpstreamServer(root: string): Promise<number> {
	const proc: ChildProcess = spawn(process.execPath, [GIT_SERVER, root, UPSTREAM_AUTH], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	cleanups.push(() => void proc.kill());
	return new Promise((r) => proc.stdout?.once("data", (d) => r(JSON.parse(d.toString()).port)));
}

/** 默认放行推送：多数用例要验的是「push 能到上游」。代理本身默认只读，
 *  所以这里必须显式给 —— 那正是新默认要求的。 */
async function startProxy(upstreamPort: number, opts: { allowPush?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "gp-"));
	const auditFile = join(dir, "audit.jsonl");
	const audit = AuditLog.open(auditFile);
	cleanups.push(() => audit.close());
	const proxy = new GitCredentialProxy({
		port: 0,
		host: "127.0.0.1",
		token: PROXY_TOKEN,
		audit,
		repos: [
			{
				// 与 sandbox-config 的重写规则一致：<host>/<repo>
				name: "git.internal/app.git",
				upstream: `http://127.0.0.1:${upstreamPort}/app.git`,
				username: "x-access-token",
				token: UPSTREAM_TOKEN,
				allowPush: opts.allowPush ?? true,
			},
		],
	});
	cleanups.push(() => proxy.close());
	return { auditFile, port: await proxy.listen() };
}

/** 按网关的方式生成沙箱侧配置，返回 HOME */
function sandboxHome(proxyPort: number): string {
	const home = mkdtempSync(join(tmpdir(), "sbhome-"));
	writeSandboxConfig(home, {
		proxyToken: "MODEL-TOKEN-only-in-gateway",
		gitProxyToken: PROXY_TOKEN,
		modelGatewayUrl: "http://127.0.0.1:1/v1",
		gitProxyUrl: `http://127.0.0.1:${proxyPort}`,
		scmHosts: ["git.internal"],
	});
	return home;
}

async function auditEntries(file: string) {
	const out = [];
	for await (const e of AuditLog.replay(file)) out.push(e);
	return out;
}

test("Week 3 验收：沙箱内 clone 成功，凭据由代理注入", async () => {
	const { port } = await startProxy(await startUpstreamServer(await makeUpstream()));
	const home = sandboxHome(port);
	const ws = mkdtempSync(join(tmpdir(), "sandbox-"));

	// agent 用的是**上游的真实地址**，insteadOf 在背后把它重写到代理
	await git(["clone", "-q", "https://git.internal/app.git", "repo"], ws, home);

	assert.match(readFileSync(join(ws, "repo", "README.md"), "utf8"), /上游仓库/);
});

test("Week 3 验收：沙箱内 push 成功，改动真的到了上游", async () => {
	const upstreamRoot = await makeUpstream();
	const { port, auditFile } = await startProxy(await startUpstreamServer(upstreamRoot));
	const home = sandboxHome(port);
	const ws = mkdtempSync(join(tmpdir(), "sandbox-"));

	await git(["clone", "-q", "https://git.internal/app.git", "repo"], ws, home);
	const repo = join(ws, "repo");
	writeFileSync(join(repo, "fix.txt"), "修好了\n");
	await git(["add", "."], repo, home);
	await git(["commit", "-qm", "修复登录超时"], repo, home);
	await git(["push", "-q", "origin", "main"], repo, home);

	// 上游裸仓库里真的有这次提交
	const { stdout } = await git(["log", "--oneline", "-1", "main"], join(upstreamRoot, "app.git"));
	assert.match(stdout, /修复登录超时/);

	// 推送留痕
	const push = (await auditEntries(auditFile)).find((e) => e.kind === "git.push" && e.verdict === "allow");
	assert.ok(push, "推送必须留痕");
	assert.match(push!.summary, /推送到 git\.internal\/app\.git/);
});

test("Week 3 验收：沙箱侧看不到任何 git 凭据（全树遍历）", async () => {
	const { port } = await startProxy(await startUpstreamServer(await makeUpstream()));
	const home = sandboxHome(port);
	const ws = mkdtempSync(join(tmpdir(), "sandbox-"));
	await git(["clone", "-q", "https://git.internal/app.git", "repo"], ws, home);
	const repo = join(ws, "repo");
	writeFileSync(join(repo, "fix.txt"), "改动\n");
	await git(["add", "."], repo, home);
	await git(["commit", "-qm", "改一下"], repo, home);
	await git(["push", "-q", "origin", "main"], repo, home);

	// 遍历 workspace 全树（含 .git/logs、packed-refs、objects），不是只看两个文件
	const wsFiles = readAllFiles(ws);
	assert.ok(wsFiles.length > 5, "应当扫到成组文件，否则这条断言是空转");
	for (const f of wsFiles) {
		assert.ok(!f.text.includes(UPSTREAM_TOKEN), `上游 git 凭据泄漏到 ${f.path}`);
		// 这一条才是真会失效的：代理 token 一旦落进 workspace，
		// agent 一句 git add -A 就把它推到上游去了
		assert.ok(!f.text.includes(PROXY_TOKEN), `代理 token 落进了 workspace：${f.path} —— 会被 commit 推走`);
	}

	// 代理 token 只在 workspace 之外的 HOME 里
	assert.ok(readAllFiles(home).some((f) => f.text.includes(PROXY_TOKEN)), "沙箱要用代理 token 访问代理");
	// .git/config 里存的是原始上游地址，重写只发生在传输层
	assert.match(readFileSync(join(repo, ".git", "config"), "utf8"), /https:\/\/git\.internal\/app\.git/);
});

test("沙箱 gitconfig 带提交身份 —— 容器里 hostname 无域时 git 会拒绝提交", async () => {
	const { port } = await startProxy(await startUpstreamServer(await makeUpstream()));
	const home = sandboxHome(port);
	const cfg = readFileSync(join(home, ".gitconfig"), "utf8");
	assert.match(cfg, /\[user\]/);
	assert.match(cfg, /email = /);

	// 不给 GIT_AUTHOR_* 也能提交（模拟容器里的真实环境）
	const ws = mkdtempSync(join(tmpdir(), "sandbox-"));
	await git(["clone", "-q", "https://git.internal/app.git", "repo"], ws, home);
	const repo = join(ws, "repo");
	writeFileSync(join(repo, "a.txt"), "x\n");
	await exec("git", ["add", "."], { cwd: repo, env: { PATH: process.env.PATH ?? "", HOME: home } });
	await exec("git", ["commit", "-qm", "无环境身份也能提交"], { cwd: repo, env: { PATH: process.env.PATH ?? "", HOME: home } });
});

test("只读仓库：clone 允许，push 被代理拒绝且不到达上游", async () => {
	const upstreamRoot = await makeUpstream();
	const { port, auditFile } = await startProxy(await startUpstreamServer(upstreamRoot), { allowPush: false });
	const home = sandboxHome(port);
	const ws = mkdtempSync(join(tmpdir(), "sandbox-"));

	await git(["clone", "-q", "https://git.internal/app.git", "repo"], ws, home);
	const repo = join(ws, "repo");
	writeFileSync(join(repo, "x.txt"), "x\n");
	await git(["add", "."], repo, home);
	await git(["commit", "-qm", "不该推上去"], repo, home);

	await assert.rejects(git(["push", "-q", "origin", "main"], repo, home), /403|forbidden|只读|未显式授权/i);

	// 上游没有这次提交
	const { stdout } = await git(["log", "--oneline", "-1", "main"], join(upstreamRoot, "app.git"));
	assert.ok(!stdout.includes("不该推上去"));
	assert.ok((await auditEntries(auditFile)).some((e) => e.verdict === "deny" && e.summary.includes("未显式授权推送")));
});

test("allowlist 之外的仓库：clone 直接失败", async () => {
	const { port } = await startProxy(await startUpstreamServer(await makeUpstream()));
	const home = sandboxHome(port);
	const ws = mkdtempSync(join(tmpdir(), "sandbox-"));

	// 代理只放行 git.internal/app.git
	await assert.rejects(git(["clone", "-q", "https://git.internal/other-team.git", "x"], ws, home), /403|forbidden|not in|allowlist/i);
	assert.equal(existsSync(join(ws, "x", ".git")), false);
});

test("工作区已有仓库时跳过 clone —— 否则网关重启后同名会话再也起不来", async () => {
	const { port } = await startProxy(await startUpstreamServer(await makeUpstream()));
	const home = sandboxHome(port);
	const ws = mkdtempSync(join(tmpdir(), "sandbox-"));

	// 第一次：正常 clone 到工作区根
	await git(["clone", "-q", "--", "https://git.internal/app.git", "."], ws, home);
	assert.ok(existsSync(join(ws, ".git")));

	// 第二次直接 clone 会失败（目标目录非空），这正是 #cloneRepo 要跳过的场景
	await assert.rejects(
		git(["clone", "-q", "--", "https://git.internal/app.git", "."], ws, home),
		/already exists|not an empty directory/i,
	);
});

test("repoUrl 以 - 开头会被 git 当成选项 —— `--` 分隔是必需的", async () => {
	const ws = mkdtempSync(join(tmpdir(), "sandbox-"));
	// 不带 `--` 时，git 把它解析成选项而不是地址
	await assert.rejects(git(["clone", "-q", "--upload-pack=touch /tmp/pwned", "x"], ws), /./);
	assert.equal(existsSync("/tmp/pwned"), false);
});
