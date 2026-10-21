/**
 * S2 Phase B（protected-mounts）专项测试。
 *
 * 三层：
 * 1. 纯单元：policy deny_paths → 确定性子路径推导（映射/未覆盖/安全校验/fail-closed）、
 *    宿主侧 stub 预创建与挂载清单（含 .git 流形门控、symlink 拒挂、workspace 缺失跳过）、
 *    DockerBackend.launch argv 集成（挂载排序、GIT_TEMPLATE_DIR、clone 型会话整体让位）。
 * 2. K8s 生成物：deploy/sandbox.yaml 的 RO subPath 挂载清单与 policy 派生目标一致
 *    （external_blocked：kubectl 未配置，未在真实集群验证）。
 * 3. 真实 Docker 红队（需 daemon 与 perimeter-sandbox:test 镜像，否则 skip 并说明）：
 *    bash/node 对每个受保护路径的新建/覆盖/追加/cp/rm/mv/chmod/ln -s 别名写全部被内核
 *    拒绝且宿主侧字节不变；hardlink 行为如实验证并记录（不声称闭合）；正控：普通文件写、
 *    子目录创建、git commit 正常。容器以 --rm 收尾、临时目录 finally 清理，沿用
 *    docker-backend 测试的所有权纪律。
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { DockerBackend } from "../src/gateway/execution-backend.ts";
import { applyProtectedMounts, deriveProtectedTargets } from "../src/gateway/protected-mounts.ts";
import { dockerClientEnv } from "../src/gateway/execution-backend.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const POLICY = join(REPO, "config/policy.yaml");
const IMAGE = process.env.PERIMETER_TEST_IMAGE ?? "perimeter-sandbox:test";

function dockerExec(args: string[], timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", args, {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { PATH: process.env.PATH, ...dockerClientEnv() },
		});
		let stdout = "";
		let stderr = "";
		let exited = false;
		let timedOut = false;
		child.stdout?.on("data", (d) => { stdout += d; });
		child.stderr?.on("data", (d) => { stderr += d; });
		const timer = setTimeout(() => {
			timedOut = true;
			try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch {}
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			if (!exited) { exited = true; reject(err); }
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			if (!exited) {
				exited = true;
				if (timedOut) reject(new Error(`docker 命令超时 (${timeoutMs}ms): docker ${args.join(" ")}`));
				else if (code !== 0) {
					const err = new Error(`docker 命令非零退出 (${code}): ${stderr.trim() || stdout.trim()}`);
					(err as any).code = code;
					reject(err);
				} else resolve({ stdout, stderr });
			}
		});
	});
}

const defaultTestSocket = [
	process.env.DOCKER_HOST,
	process.env.HOME && existsSync(`${process.env.HOME}/.orbstack/run/docker.sock`)
		? `unix://${process.env.HOME}/.orbstack/run/docker.sock`
		: undefined,
].find(Boolean);
if (!process.env.DOCKER_HOST && defaultTestSocket) {
	process.env.DOCKER_HOST = defaultTestSocket;
}

async function dockerReady(): Promise<boolean> {
	try {
		await dockerExec(["version"], 3000);
		await dockerExec(["image", "inspect", IMAGE], 3000);
		return true;
	} catch {
		return false;
	}
}

// ── 期望值（以 config/policy.yaml 实际条目为准，逐条钉死，防漂移） ──

const EXPECTED_FILE_RELS = [
	".clinerules", ".cursorrules", ".env", ".git/config", ".gitconfig", ".gitlab-ci.yml", ".npmrc",
	"AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "Dockerfile", "Jenkinsfile", "azure-pipelines.yml",
];
const EXPECTED_DIR_RELS = [".aws", ".buildkite", ".circleci", ".github/workflows", ".git/hooks", ".pi", ".ssh", "secrets"];
const EXPECTED_ALL_SORTED = [...EXPECTED_DIR_RELS, ...EXPECTED_FILE_RELS].sort();
const EXPECTED_UNCOVERED = ["**/Dockerfile.*", "**/*.tf", "**/*.tfvars", "**/*.tf.json", "**/.env.*"];
/** clone/init 流形下不能预置的 .git 条目（git clone 需空目录） */
const GIT_GATED = [".git/config", ".git/hooks"];

function policyWith(...globs: string[]): string {
	return `rules:\n  - name: t\n    tool: "*"\n    deny_paths:\n${globs.map((g) => `      - ${JSON.stringify(g)}`).join("\n")}\n`;
}

function freshDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

// ── 纯单元：deriveProtectedTargets ──────────────────────────

test("推导：真实 policy 的 21 个确定目标与 5 个未覆盖条目（逐条钉死）", () => {
	const { targets, uncovered } = deriveProtectedTargets(readFileSync(POLICY, "utf8"));
	assert.deepEqual(targets.map((t) => t.rel), EXPECTED_ALL_SORTED);
	assert.deepEqual(
		targets.filter((t) => t.explicitDir).map((t) => t.rel).sort(),
		[...EXPECTED_DIR_RELS].sort(),
		"以 /** 结尾的 glob 必须映射为目录",
	);
	assert.deepEqual(uncovered.map((u) => u.glob), EXPECTED_UNCOVERED, "通配符条目必须如实列出不覆盖");
	for (const u of uncovered) assert.equal(u.reason, "通配符段无法映射为 workspace 内确定子路径");
});

test("推导：安全校验——遍历段/根本身/.git 整体不得映射", () => {
	const { targets, uncovered } = deriveProtectedTargets(policyWith(
		"**/../evil", "**/a/../../b", "**", "**/", "**/.git",
		"**/ok-dir/**", "**/ok-file.md",
	));
	assert.deepEqual(targets.map((t) => t.rel), ["ok-dir", "ok-file.md"]);
	const reasons = new Map(uncovered.map((u) => [u.glob, u.reason]));
	assert.equal(reasons.get("**/../evil"), "含遍历段（..），拒绝映射");
	assert.equal(reasons.get("**/a/../../b"), "含遍历段（..），拒绝映射");
	assert.equal(reasons.get("**"), "目标为 workspace 根或 .git 本身，禁止挂载");
	assert.equal(reasons.get("**/"), "目标为 workspace 根或 .git 本身，禁止挂载");
	assert.equal(reasons.get("**/.git"), "目标为 workspace 根或 .git 本身，禁止挂载");
	assert.ok(!targets.some((t) => t.rel === "" || t.rel === "." || t.rel === ".git"), "根与 .git 本身绝不出现在挂载目标");
});

test("推导：祖先目录覆盖子孙条目（去重），file/dir 冲突 dir 胜", () => {
	const nested = deriveProtectedTargets(policyWith("**/a/b/**", "**/a/b/c/**", "**/a/b/d.md"));
	assert.deepEqual(nested.targets.map((t) => t.rel), ["a/b"], "祖先 RO 已覆盖子孙");
	const conflict = deriveProtectedTargets(policyWith("**/x", "**/x/**"));
	assert.deepEqual(conflict.targets, [{ rel: "x", explicitDir: true }]);
});

test("推导：策略形状非法必须抛错（fail-closed，不给静默零挂载）", () => {
	assert.throws(() => deriveProtectedTargets("rules: nope\n"), /rules 必须是数组/);
	assert.throws(() => deriveProtectedTargets("rules:\n  - deny_paths: 42\n"), /必须是数组/);
	assert.throws(() => deriveProtectedTargets("rules:\n  - deny_paths:\n    - \"\"\n"), /非空字符串/);
	assert.throws(() => deriveProtectedTargets("rules:\n  - deny_paths:\n    - 7\n"), /非空字符串/);
});

// ── 纯单元：applyProtectedMounts ────────────────────────────

test("应用：空 workspace 预创建 stub（敏感目录 0700）、.git 条目门控跳过、argv 有序", () => {
	const ws = freshDir("ppd-apply-");
	try {
		const { targets } = deriveProtectedTargets(readFileSync(POLICY, "utf8"));
		const { mounts, skipped } = applyProtectedMounts(ws, targets);
		assert.deepEqual(mounts.map((m) => m.rel), EXPECTED_ALL_SORTED.filter((r) => !GIT_GATED.includes(r)));
		assert.deepEqual(skipped.map((s) => s.rel).sort(), GIT_GATED, "clone/init 流形下 .git 条目必须跳过");
		assert.ok(skipped.every((s) => s.reason.includes("clone/init 流形")), "跳过原因必须如实标注流形");
		// stub 形状与权限
		assert.equal(statSync(join(ws, ".ssh")).mode & 0o777, 0o700, "敏感目录 0700");
		assert.equal(statSync(join(ws, "secrets")).mode & 0o777, 0o700);
		assert.equal(statSync(join(ws, ".pi")).mode & 0o777, 0o755);
		assert.equal(statSync(join(ws, "Dockerfile")).mode & 0o777, 0o644);
		assert.equal(readFileSync(join(ws, "Dockerfile"), "utf8"), "", "文件 stub 为空");
		assert.ok(!existsSync(join(ws, ".git")), "空 workspace 绝不能被造出 .git（否则会话内 clone 被跳过）");
		// 挂载清单确定性
		assert.ok(mounts.every((m) => m.hostSource.startsWith(ws) && m.containerTarget.startsWith("/workspace/")));
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
});

test("应用：预置仓库流形——.git/config 与 .git/hooks 原样挂载且内容零改写", () => {
	const ws = freshDir("ppd-git-");
	try {
		mkdirSync(join(ws, ".git", "hooks"), { recursive: true });
		writeFileSync(join(ws, ".git/config"), "REAL-CONFIG\n");
		writeFileSync(join(ws, ".git/hooks/pre-commit.sample"), "#!/bin/sh\n");
		const { targets } = deriveProtectedTargets(readFileSync(POLICY, "utf8"));
		const { mounts, skipped } = applyProtectedMounts(ws, targets);
		assert.deepEqual(mounts.map((m) => m.rel), EXPECTED_ALL_SORTED, ".git 就位时 21 条全挂");
		assert.deepEqual(skipped, []);
		const cfg = mounts.find((m) => m.rel === ".git/config")!;
		assert.equal(cfg.kind, "file");
		assert.equal(readFileSync(cfg.hostSource, "utf8"), "REAL-CONFIG\n", "已存在的文件内容绝不能被改写");
		assert.equal(mounts.find((m) => m.rel === ".git/hooks")!.kind, "dir");
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
});

test("应用：已有内容不覆盖、symlink 拒挂、workspace 缺失全跳过、二次调用幂等", () => {
	const ws = freshDir("ppd-idem-");
	try {
		writeFileSync(join(ws, ".env"), "CUSTOM=1\n");
		symlinkSync("/etc", join(ws, ".pi"));
		const { targets } = deriveProtectedTargets(readFileSync(POLICY, "utf8"));
		const first = applyProtectedMounts(ws, targets);
		assert.equal(readFileSync(join(ws, ".env"), "utf8"), "CUSTOM=1\n", "已有文件内容零改写");
		assert.ok(first.skipped.some((s) => s.rel === ".pi" && s.reason.includes("符号链接")), "symlink 目标拒绝挂载");
		assert.ok(!first.mounts.some((m) => m.rel === ".pi"));
		const second = applyProtectedMounts(ws, targets);
		assert.deepEqual(second.mounts.map((m) => m.rel), first.mounts.map((m) => m.rel), "幂等");
		assert.equal(readFileSync(join(ws, ".env"), "utf8"), "CUSTOM=1\n");
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
	const missingWs = freshDir("ppd-nope-");
	try {
		const missing = applyProtectedMounts(join(missingWs, "ghost"), deriveProtectedTargets(readFileSync(POLICY, "utf8")).targets);
		assert.equal(missing.mounts.length, 0, "workspace 不存在：零挂载零副作用");
		assert.equal(missing.skipped.length, EXPECTED_ALL_SORTED.length);
	} finally {
		rmSync(missingWs, { recursive: true, force: true });
	}
});

// ── 纯单元：DockerBackend.launch argv 集成 ──────────────────

const baseCtx = {
	sessionId: "ppt-ctx",
	workspace: "/host/ws",
	home: undefined as string | undefined,
	extensionPath: "/repo/src/gateway/policy-extension.ts",
	policyFile: POLICY,
	env: { PERIMETER_REPO: "web", PERIMETER_TEAM: "platform" },
};

test("launch：真实 policy + 真实 workspace → 19 条受保护 RO 挂载（排序钉死）+ 只读 git 模板目录", () => {
	const ws = freshDir("ppd-argv-");
	try {
		const l = new DockerBackend({ image: IMAGE, repoRoot: REPO }).launch({ ...baseCtx, workspace: ws, home: undefined });
		const mounts = l.argsPrefix.filter((_, i) => l.argsPrefix[i - 1] === "-v");
		assert.equal(mounts[0], `${ws}:/workspace`, "workspace 本体必须最先挂");
		const expectedProtected = EXPECTED_ALL_SORTED.filter((r) => !GIT_GATED.includes(r))
			.map((r) => `${ws}/${r}:/workspace/${r}:ro`);
		assert.deepEqual(mounts.slice(1, 1 + expectedProtected.length), expectedProtected, "受保护挂载紧跟 workspace 且按挂载点排序");
		assert.deepEqual(mounts.slice(-3), [
			`${join(REPO, "src")}:/opt/perimeter/src:ro`,
			`${join(REPO, "config")}:/opt/perimeter/config:ro`,
			`${join(REPO, "node_modules")}:/opt/perimeter/node_modules:ro`,
		], "扩展三棵只读子树保持不变");
		// 只读空 git 模板目录 + 环境变量（位于 /var/perimeter，不占用 /opt/perimeter 网关代码命名空间）
		assert.ok(l.argsPrefix.includes("/var/perimeter/git-templates:ro,nosuid,nodev,noexec,size=1m"));
		const envArgs = l.argsPrefix.filter((_, i) => l.argsPrefix[i - 1] === "-e");
		assert.ok(envArgs.includes("GIT_TEMPLATE_DIR=/var/perimeter/git-templates"));
		// 原有五项收紧不受影响
		const a = l.argsPrefix.join(" ");
		assert.match(a, /--read-only/);
		assert.match(a, /--cap-drop ALL/);
		assert.deepEqual(l.argsPrefix.slice(-2), [IMAGE, "pi-env"]);
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
});

test("launch：clone 型会话（repoUrl 非空）整体让位——零受保护挂载、零 stub 副作用", () => {
	const ws = freshDir("ppd-clone-");
	try {
		const l = new DockerBackend({ image: IMAGE, repoRoot: "/repo" }).launch({ ...baseCtx, workspace: ws, home: undefined, repoUrl: "https://git-proxy.internal/r.git" });
		const mounts = l.argsPrefix.filter((_, i) => l.argsPrefix[i - 1] === "-v");
		assert.deepEqual(mounts, [
			`${ws}:/workspace`,
			"/repo/src:/opt/perimeter/src:ro",
			"/repo/config:/opt/perimeter/config:ro",
			"/repo/node_modules:/opt/perimeter/node_modules:ro",
		], "clone 需空目录：任何预置都会让启动后的 clone 失败");
		assert.ok(!existsSync(join(ws, "Dockerfile")), "不得留下任何 stub 副作用");
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
});

test("launch：策略损坏 fail-closed 抛错；策略缺失保持零挂载（测试假路径现状）；workdir 跟随挂载点", () => {
	const ws = freshDir("ppd-fail-");
	try {
		const badPolicy = join(ws, "bad.yaml");
		writeFileSync(badPolicy, "rules: nope\n");
		assert.throws(
			() => new DockerBackend({ image: IMAGE, repoRoot: "/repo" }).launch({ ...baseCtx, workspace: ws, policyFile: badPolicy }),
			/rules 必须是数组/,
			"策略损坏必须拒绝会话启动",
		);
		const noPolicy = new DockerBackend({ image: IMAGE, repoRoot: "/repo" }).launch({ ...baseCtx, workspace: ws, policyFile: join(ws, "missing.yaml") });
		assert.equal(noPolicy.argsPrefix.filter((_, i) => noPolicy.argsPrefix[i - 1] === "-v").length, 4, "缺策略：维持 workspace+三子树现状");
		const custom = new DockerBackend({ image: IMAGE, repoRoot: "/repo", workdir: "/src" }).launch({ ...baseCtx, workspace: ws });
		assert.ok(custom.argsPrefix.includes(`${ws}/.env:/src/.env:ro`), "容器内挂载点跟随 workdir");
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
});

// ── K8s 生成物（external_blocked：kubectl 未配置，未在真实集群验证） ──

test("K8s 生成物：sandbox.yaml 的 RO subPath 挂载与 policy 派生目标一致", () => {
	const doc = parseYaml(readFileSync(join(REPO, "deploy/sandbox.yaml"), "utf8")) as {
		spec: { containers: { volumeMounts: { name: string; mountPath: string; subPath?: string; readOnly?: boolean }[] }[] };
	};
	const ro = doc.spec.containers[0]!.volumeMounts.filter((m) => m.readOnly === true && typeof m.subPath === "string");
	const { targets } = deriveProtectedTargets(readFileSync(POLICY, "utf8"));
	assert.deepEqual(
		ro.map((m) => m.subPath).sort(),
		targets.map((t) => t.rel).sort(),
		"生成物挂载清单必须与 policy 派生目标同源（防两处漂移）",
	);
	for (const m of ro) assert.equal(m.name, "workspace", "RO subPath 必须复用 workspace emptyDir 卷");
});

// ── 真实 Docker 红队（需要 daemon 与镜像；缺任一则 skip 并说明原因） ──

function seedRepo(ws: string): void {
	mkdirSync(join(ws, ".github", "workflows"), { recursive: true });
	writeFileSync(join(ws, "seed.txt"), "seed\n");
	writeFileSync(join(ws, ".github/workflows/ci.yml"), "ORIGINAL-CI\n");
	writeFileSync(join(ws, ".env"), "SECRET=1\n");
	writeFileSync(join(ws, "AGENTS.md"), "AGENT-RULES\n");
	execFileSync("/bin/sh", ["-c", "git init -q && git config user.name 'P' && git config user.email 'p@local' && git add -A && git commit -q -m seed"], { cwd: ws });
}

async function runSh(ws: string, sessionId: string, script: string): Promise<{ stdout: string; stderr: string }> {
	const l = new DockerBackend({ image: IMAGE, repoRoot: REPO, network: "none" }).launch({
		...baseCtx, sessionId, workspace: ws, home: undefined,
	});
	return dockerExec([...l.argsPrefix.slice(0, -1), "sh", "-c", script]);
}

const DENY_HELPER = 'd() { { eval "$2"; } >/dev/null 2>&1 && echo "BREACH:$1"; }';

describe("S2 Phase B 真实容器红队（需要 docker 与 perimeter-sandbox:test 镜像）", { skip: !(await dockerReady()) && "docker 或镜像不可用" }, () => {
	test("红控：bash 对全部受保护目录的新建/cp/mv/rm/chmod/mkdir 被拒，宿主字节不变", async () => {
		const ws = freshDir("ppd-r1-");
		try {
			seedRepo(ws);
			const before = readFileSync(join(ws, ".github/workflows/ci.yml"));
			const beforeCfg = readFileSync(join(ws, ".git/config"));
			const { stdout } = await runSh(ws, `ppt-${Date.now()}-r1`, `${DENY_HELPER}
for p in .github/workflows .pi .ssh .aws secrets .circleci .buildkite .git/hooks; do
  d "$p-echo" "echo x > '/workspace/$p/evil'"
  d "$p-touch" "touch '/workspace/$p/evil2'"
  d "$p-cp" "cp /workspace/seed.txt '/workspace/$p/copy'"
  d "$p-mv-in" "mv /workspace/seed.txt '/workspace/$p/seed'"
  d "$p-rm" "rm -rf '/workspace/$p'"
  d "$p-mv-away" "mv '/workspace/$p' '/workspace/$p.moved'"
  d "$p-chmod" "chmod 777 '/workspace/$p'"
  d "$p-mkdir" "mkdir '/workspace/$p/sub'"
done
echo ALLDENIED`);
			assert.ok(stdout.includes("ALLDENIED"), `脚本必须跑完：${stdout}`);
			assert.ok(!stdout.includes("BREACH:"), `任何内核级写入成功都是击穿：${stdout}`);
			assert.deepEqual(readFileSync(join(ws, ".github/workflows/ci.yml")), before, "宿主侧 ci.yml 字节不变");
			assert.deepEqual(readFileSync(join(ws, ".git/config")), beforeCfg, "宿主侧 .git/config 字节不变");
			assert.ok(!existsSync(join(ws, ".github/workflows/evil.yml")));
			assert.ok(existsSync(join(ws, ".github/workflows")), "rm -rf 被拒后目录必须原地保留");
			assert.ok(!existsSync(join(ws, ".github/workflows.moved")), "受保护目录不得被 mv 走");
			assert.ok(existsSync(join(ws, "seed.txt")), "mv-in 失败后 seed.txt 必须原地");
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	test("红控：bash 对全部受保护文件的覆盖/追加/cp/rm/mv/ln 替换/chmod 被拒，宿主字节不变", async () => {
		const ws = freshDir("ppd-r2-");
		try {
			seedRepo(ws);
			// before 只能捕获 launch 前已存在的文件（stub 在容器启动时才创建）
			const before = Object.fromEntries(
				[".env", "AGENTS.md", ".git/config"].map((r) => [r, readFileSync(join(ws, r))]));
			const { stdout } = await runSh(ws, `ppt-${Date.now()}-r2`, `${DENY_HELPER}
for p in .env AGENTS.md CLAUDE.md .git/config .gitconfig Dockerfile .gitlab-ci.yml Jenkinsfile .npmrc AGENTS.override.md azure-pipelines.yml .cursorrules .clinerules; do
  d "$p-overwrite" "echo evil > '/workspace/$p'"
  d "$p-append" "echo evil >> '/workspace/$p'"
  d "$p-cp" "cp /workspace/seed.txt '/workspace/$p'"
  d "$p-rm" "rm -f '/workspace/$p'"
  d "$p-mv" "mv '/workspace/$p' '/workspace/$p.bak'"
  d "$p-lnsf" "ln -sf /tmp/x '/workspace/$p'"
  d "$p-chmod" "chmod 600 '/workspace/$p'"
done
echo ALLDENIED`);
			assert.ok(stdout.includes("ALLDENIED"));
			assert.ok(!stdout.includes("BREACH:"), `文件写入成功即击穿：${stdout}`);
			for (const [rel, bytes] of Object.entries(before)) {
				assert.deepEqual(readFileSync(join(ws, rel)), bytes, `${rel} 宿主字节不变`);
			}
			assert.ok(existsSync(join(ws, ".gitconfig")), "stub 必须在位");
			assert.equal(readFileSync(join(ws, "Dockerfile"), "utf8"), "", "stub 必须仍为空文件（未被写穿）");
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	test("红控：ln -s 别名写仍被拒（同一 inode 的挂载点只读）", async () => {
		const ws = freshDir("ppd-r3-");
		try {
			seedRepo(ws);
			const before = readFileSync(join(ws, ".env"));
			const { stdout } = await runSh(ws, `ppt-${Date.now()}-r3`, `${DENY_HELPER}
ln -s /workspace/.github/workflows /workspace/wfalias
d wf-alias-echo "echo x > /workspace/wfalias/evil.yml"
d wf-alias-touch "touch /workspace/wfalias/evil2"
ln -s .env /workspace/envalias
d env-alias-echo "echo x > /workspace/envalias"
d env-alias-append "echo x >> /workspace/envalias"
ln -s /workspace/.git/config /workspace/cfgalias
d cfg-alias-echo "echo x > /workspace/cfgalias"
ln -s /workspace/.git/hooks /workspace/hkalias
d hk-alias "echo x > /workspace/hkalias/evil"
echo ALLDENIED`);
			assert.ok(stdout.includes("ALLDENIED"));
			assert.ok(!stdout.includes("BREACH:"), `经别名写入成功即击穿：${stdout}`);
			assert.deepEqual(readFileSync(join(ws, ".env")), before);
			assert.ok(!existsSync(join(ws, ".github/workflows/evil.yml")));
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	test("红控：解释器（node）写保护路径被拒；python 行为如实记录（镜像未内置 python）", async () => {
		const ws = freshDir("ppd-r4-");
		try {
			seedRepo(ws);
			const before = readFileSync(join(ws, "AGENTS.md"));
			const { stdout } = await runSh(ws, `ppt-${Date.now()}-r4`, `node -e '
const fs = require("fs");
let denied = 0;
const t = (n, f) => { try { f(); console.log("BREACH:" + n); } catch (e) { denied++; } };
t("w-agents", () => fs.writeFileSync("/workspace/AGENTS.md", "EVIL"));
t("append-env", () => fs.appendFileSync("/workspace/.env", "X"));
t("mkdir-pi", () => fs.mkdirSync("/workspace/.pi/sub"));
t("unlink-dockerfile", () => fs.unlinkSync("/workspace/Dockerfile"));
t("rename-gitconfig", () => fs.renameSync("/workspace/.git/config", "/workspace/.git/config.bak"));
t("chmod-hooks", () => fs.chmodSync("/workspace/.git/hooks", 448));
t("rm-workflows", () => fs.rmSync("/workspace/.github/workflows", { recursive: true, force: true }));
console.log("NODE-DENIED:" + denied);
'
{ python3 -c 'open("/workspace/AGENTS.md","w").write("X")' ; } 2>&1 | head -1
echo PY-RECORDED`);
			assert.ok(stdout.includes("NODE-DENIED:7"), `解释器级写入必须全部被拒：${stdout}`);
			assert.ok(!stdout.includes("BREACH:"), `node 写入成功即击穿：${stdout}`);
			assert.ok(stdout.includes("PY-RECORDED"));
			// python3 不在沙箱镜像内（node:22-alpine + git）：记录实际输出；若客户镜像带 python，
			// 同样必须失败（EROFS）——只要求「未写入成功 + 行为留痕」，不虚构具体错误形态
			const pyLine = stdout.split("\n").find((l) => l.includes("python3") || l.includes("Read-only") || l.includes("not found"));
			assert.ok(pyLine !== undefined || !stdout.includes("EVIL"), "python 尝试必须留痕");
			assert.deepEqual(readFileSync(join(ws, "AGENTS.md")), before, "宿主 AGENTS.md 字节不变");
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	test("hardlink：如实验证并记录实际行为（平台差异不虚构；可利用则记已知残余）", async () => {
		const ws = freshDir("ppd-r5-");
		try {
			seedRepo(ws);
			const before = readFileSync(join(ws, ".git/config"));
			const { stdout } = await runSh(ws, `ppt-${Date.now()}-r5`, `if ln /workspace/.git/config /workspace/hl 2>/dev/null; then
  if sh -c 'echo x >> /workspace/hl' 2>/dev/null; then
    echo "HARDLINK-RESIDUAL:write-through-succeeded"
  else
    echo "HARDLINK-PARTIAL:ln-ok-write-denied"
  fi
else
  echo "HARDLINK-BLOCKED:ln-failed"
fi`);
			// 三种结局都如实接受并记录：Linux 上 RO 是挂载旗标非 inode 旗标，
			// ln 成功后经 rw 路径写共享 inode 预期成功 → 已知残余（需 protected_hardlinks
			// sysctl 或 LSM，超出挂载设计，不声称闭合）；OrbStack/macOS 可能 ln 即失败。
			console.log(`[hardlink 实测] ${stdout.trim()}（platform: ${process.platform}）`);
			assert.match(stdout, /HARDLINK-(RESIDUAL|PARTIAL|BLOCKED)/, "必须给出明确结局记录");
			if (stdout.includes("HARDLINK-RESIDUAL")) {
				writeFileSync(join(ws, ".git/config"), before);
				console.log("[hardlink 残余] write-through 成功，宿主 .git/config 已按 before 字节还原；残余已记录，不声称闭合");
			}
			assert.deepEqual(readFileSync(join(ws, ".git/config")), before, "测试结束后宿主 .git/config 必须回到原字节");
			assert.ok(!existsSync(join(ws, "hl")), "硬链接产物必须清理");
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	test("正控：普通文件写、子目录创建、git add/commit 正常（.git/config 与 hooks 只读不碍提交）", async () => {
		const ws = freshDir("ppd-r6-");
		try {
			seedRepo(ws);
			const beforeCfg = readFileSync(join(ws, ".git/config"));
			const { stdout } = await runSh(ws, `ppt-${Date.now()}-r6`, `cat /workspace/AGENTS.md
test -f /workspace/Dockerfile && echo STUB-DOCKERFILE-PRESENT
echo ok > /workspace/plain.txt || echo "FAIL:plain-write"
mkdir -p /workspace/sub && echo nested > /workspace/sub/f.txt || echo "FAIL:subdir"
git add seed.txt plain.txt sub/f.txt && git commit -q -m t2 || echo "FAIL:commit"
git rev-parse HEAD > /dev/null && echo GIT-OK
echo POSITIVE-DONE`);
			assert.ok(stdout.includes("AGENT-RULES"), "已有受保护文件必须可读");
			assert.ok(stdout.includes("STUB-DOCKERFILE-PRESENT"), "stub 必须以空文件形态存在且可读");
			assert.ok(stdout.includes("POSITIVE-DONE"), `正控脚本必须跑完：${stdout}`);
			assert.ok(!stdout.includes("FAIL:"), `正常开发流不得受阻：${stdout}`);
			assert.ok(stdout.includes("GIT-OK"), "容器内 git 必须可用");
			assert.equal(readFileSync(join(ws, "plain.txt"), "utf8"), "ok\n");
			assert.equal(readFileSync(join(ws, "sub/f.txt"), "utf8"), "nested\n");
			const committed = execFileSync("git", ["ls-files"], { cwd: ws }).toString();
			assert.ok(committed.includes("plain.txt") && committed.includes("sub/f.txt"), "提交必须真实落盘");
			assert.ok(!committed.includes("Dockerfile") && !committed.includes("CLAUDE.md"), "stub 未被误提交（只 add 了指定文件）");
			assert.deepEqual(readFileSync(join(ws, ".git/config")), beforeCfg, "提交不需要写 .git/config");
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	test("正控+残余：空 workspace 容器内 git init/add/commit 正常；init 流形下 .git/config 与 .git/hooks 可写为已知残余", async () => {
		const ws = freshDir("ppd-r7-");
		try {
			const { stdout } = await runSh(ws, `ppt-${Date.now()}-r7`, `git init -q /workspace || echo "FAIL:init"
cd /workspace || exit 1
echo hello > app.txt
git add app.txt && git -c user.name=P -c user.email=p@l commit -q -m init || echo "FAIL:commit"
mkdir -p /workspace/.git/hooks 2>/dev/null && { echo x > /workspace/.git/hooks/evil 2>/dev/null && echo "RESIDUAL-RECORDED:hooks-writable-after-init" || true; }
echo x > /workspace/.git/config 2>/dev/null && echo "RESIDUAL-RECORDED:gitconfig-writable-after-init"
echo INITFLOW-DONE`);
			assert.ok(stdout.includes("INITFLOW-DONE"), `init 流形脚本必须跑完：${stdout}`);
			assert.ok(!stdout.includes("FAIL:"), `空 GIT_TEMPLATE_DIR 下 git init/commit 必须正常：${stdout}`);
			// 已知残余（与实现声明一致）：init/clone 流形下 .git/config 与 .git/hooks 由 git
			// 新建于 rw 面，bash 可写；词法策略仍拦 path 工具；pre-seeded 流形（上两组红控）无此残余。
			// Linux 上预期记录到两条 RESIDUAL-RECORDED；若平台侧已闭合则缺席——两者都接受，如实输出。
			console.log(`[init 流形残余实测] ${stdout.includes("gitconfig-writable-after-init") ? ".git/config 可写（残余成立）" : ".git/config 写入被拒（本平台已闭合）"}；${stdout.includes("hooks-writable-after-init") ? ".git/hooks 可写（残余成立）" : ".git/hooks 写入被拒（本平台已闭合）"}`);
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});
});
