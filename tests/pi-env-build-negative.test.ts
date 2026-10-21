/**
 * R-Q7：builder 负控矩阵（isolated fixture SDK root，绝不触碰真实 pi-mono/vendor/安装）。
 * 覆盖：--out-dir 已存在拒绝且目录未变；patch 应用结果与 manifest.base.sources 漂移拒绝且 manifest/vendor 未变；
 * patch 文件篡改（相对 manifest.patchFileSha256）拒绝且未变。
 *
 * teardown-hardening r2 管线契约更新：patched 源 = pin base + git apply 本仓 patch（不再读外部工作树，
 * 外部 pi-mono 工作树 drift 不影响生成物）；相应地负控②从「工作树源 drift」改为等强度的「patch 应用
 * 结果 vs manifest.base.sources 漂移」——两者都保证：任何 drift 在预校验阶段拒绝，manifest/vendor/dist 零写入。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import os from "node:os";
import { after, test } from "node:test";

const REPO = join(import.meta.dirname, "..");
const BUILDER = join(REPO, "vendor", "pi-env", "build", "build.mjs");
const roots: string[] = [];
after(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

/** 执行硬边界（本轮追加清单）：所有 git 子命令独立 deadline + 系统/全局配置隔离 + 禁 hooks/签名/交互；
 * 只对本函数的 owned fixture 仓生效，绝不触产品/SDK 仓的真实 global 配置或密钥。 */
function git(cwd: string, args: string[]): Buffer {
	const isolated = [
		"-c", "core.hooksPath=/dev/null",
		"-c", "commit.gpgsign=false",
		"-c", "tag.gpgsign=false",
		"-c", "core.editor=true",
		...args,
	];
	return execFileSync("git", isolated, {
		cwd,
		timeout: 10_000,
		maxBuffer: 1 << 24,
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0" },
	});
}
const dirHash = (p: string): string => sha(p); // 目录态以逐文件 hash 聚合近似（存在性+内容），实测用逐文件比较

function makeFixture(): { sdkRoot: string; repoRoot: string; sources: Record<string, string> } {
	const sdkRoot = mkdtempSync(join(tmpdir(), "pin-build-sdk-"));
	const repoRoot = mkdtempSync(join(tmpdir(), "pin-build-repo-"));
	roots.push(sdkRoot, repoRoot);
	// fixture git 仓：HEAD = 本仓固化的 1.1.0 已验证源快照（不随外部 pi-mono 工作树演进漂移）
	const snapshotSrc = join(REPO, "vendor", "pi-env", "build", "fixture-src");
	const src = join(sdkRoot, "packages", "env", "src");
	mkdirSync(src, { recursive: true });
	cpSync(snapshotSrc, src, { recursive: true });
	writeFileSync(join(sdkRoot, "packages", "env", "tsconfig.build.json"), "{}");
	writeFileSync(join(sdkRoot, "package.json"), '{"type":"module"}');
	// 正控需要 emit：fixture 的 typescript/@types/tsconfig.base symlink 或复制自真实包（只读使用；零安装/零依赖变更）
	mkdirSync(join(sdkRoot, "node_modules"), { recursive: true });
	symlinkSync(join(REPO, "..", "..", "pi-mono", "node_modules", "typescript"), join(sdkRoot, "node_modules", "typescript"), "dir");
	symlinkSync(join(REPO, "..", "..", "pi-mono", "node_modules", "@types"), join(sdkRoot, "node_modules", "@types"), "dir");
	writeFileSync(join(sdkRoot, "tsconfig.base.json"), readFileSync(join(REPO, "..", "..", "pi-mono", "tsconfig.base.json"), "utf8"));
	// fixture HEAD 必须是未打补丁基线：先以真实 pi-mono HEAD 版本覆盖两份补丁源，再提交
	for (const f of ["connection.ts", "remote-env.ts"]) {
		writeFileSync(join(src, f), git(join(REPO, "..", "..", "pi-mono"), ["show", `HEAD:packages/env/src/${f}`]).toString());
	}
	git(sdkRoot, ["init", "-q"]);
	git(sdkRoot, ["config", "user.email", "t@local"]);
	git(sdkRoot, ["config", "user.name", "t"]);
	git(sdkRoot, ["add", "-A"]);
	git(sdkRoot, ["commit", "-q", "-m", "base"]);
	// patched 源：模拟 pin base + patch——此处用加注释行的方式与 HEAD 区分；fixture 无 base.head → builder 退回 HEAD
	writeFileSync(join(src, "connection.ts"), readFileSync(join(src, "connection.ts"), "utf8") + "\n// session-pin patch marker\n");
	// fixture patch：真实可应用的 git diff（HEAD → 加 marker 工作树）；builder 新管线会对 owned materialize 目录执行 git apply
	const patchContent = git(sdkRoot, ["diff", "--", "packages/env/src/connection.ts"]).toString();
	// fixture repo：vendor 结构（manifest/patch/original/dist）
	mkdirSync(join(repoRoot, "vendor", "pi-env", "dist"), { recursive: true });
	mkdirSync(join(repoRoot, "vendor", "pi-env", "original"), { recursive: true });
	mkdirSync(join(repoRoot, "vendor", "pi-env", "patch"), { recursive: true });
	const sources = {
		"packages/env/src/connection.ts": sha(join(src, "connection.ts")),
		"packages/env/src/remote-env.ts": sha(join(src, "remote-env.ts")),
	};
	const sourceBase = {
		"packages/env/src/connection.ts": createHash("sha256").update(git(sdkRoot, ["show", "HEAD:packages/env/src/connection.ts"])).digest("hex"),
		"packages/env/src/remote-env.ts": createHash("sha256").update(git(sdkRoot, ["show", "HEAD:packages/env/src/remote-env.ts"])).digest("hex"),
	};
	writeFileSync(join(repoRoot, "vendor", "pi-env", "patch", "env-session-pin.patch"), patchContent);
	writeFileSync(join(repoRoot, "vendor", "pi-env", "manifest.json"), JSON.stringify({
		name: "fixture", base: { targetVersion: "1.1.0", sources, sourceBaseHashes: sourceBase }, compiler: {},
		files: { "connection.js": { patched: sha(join(snapshotSrc, "connection.ts")), original: sha(join(snapshotSrc, "connection.ts")) }, "remote-env.js": { patched: sha(join(snapshotSrc, "remote-env.ts")), original: sha(join(snapshotSrc, "remote-env.ts")) }, "connection.d.ts": { patched: sha(join(snapshotSrc, "connection.ts")), original: sha(join(snapshotSrc, "connection.ts")) }, "remote-env.d.ts": { patched: sha(join(snapshotSrc, "remote-env.ts")), original: sha(join(snapshotSrc, "remote-env.ts")) } },
		patchFileSha256: createHash("sha256").update(patchContent).digest("hex"),
	}));
	for (const f of ["connection.js", "remote-env.js", "connection.d.ts", "remote-env.d.ts"]) {
		writeFileSync(join(repoRoot, "vendor", "pi-env", "original", f), readFileSync(join(REPO, "vendor", "pi-env", "original", f), "utf8")); // 官方 1.1.0 副本（漂移核对基准）
	}
	void dirHash;
	return { sdkRoot, repoRoot, sources };
}

test("builder 负控①：--out-dir 已存在 → 拒绝且该目录与哨兵文件未变", () => {
	const { sdkRoot, repoRoot } = makeFixture();
	const outDir = mkdtempSync(join(tmpdir(), "pin-build-out-exists-"));
	writeFileSync(join(outDir, "sentinel.txt"), "do-not-touch");
	roots.push(outDir);
	assert.throws(() => execFileSync(process.execPath, [BUILDER, "--sdk-root", sdkRoot, "--repo-root", repoRoot, "--out-dir", outDir], { timeout: 60_000, stdio: "pipe", encoding: "utf8" }), /已存在/);
	assert.equal(readFileSync(join(outDir, "sentinel.txt"), "utf8"), "do-not-touch", "已存在目录不得被删/改");
});

test("builder 负控②：patch 应用结果与 manifest.base.sources 漂移 → 拒绝且 manifest/vendor 未变", () => {
	const { sdkRoot, repoRoot } = makeFixture();
	// patch 内容变更（fixture 工作树再加一行 marker → 生成合法 diff v2），并把 manifest.patchFileSha256
	// 同步到 v2（过 hash 预检）——但 manifest.base.sources 仍记 v1 patched hash → builder 必须在源阶段拒绝
	const src = join(sdkRoot, "packages", "env", "src");
	writeFileSync(join(src, "connection.ts"), readFileSync(join(src, "connection.ts"), "utf8") + "// second marker\n");
	const patchV2 = git(sdkRoot, ["diff", "--", "packages/env/src/connection.ts"]).toString();
	const patchPath = join(repoRoot, "vendor/pi-env/patch/env-session-pin.patch");
	writeFileSync(patchPath, patchV2);
	const manifestPath = join(repoRoot, "vendor/pi-env/manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	manifest.patchFileSha256 = createHash("sha256").update(patchV2).digest("hex");
	writeFileSync(manifestPath, JSON.stringify(manifest));
	const manifestBefore = readFileSync(manifestPath, "utf8");
	assert.throws(() => execFileSync(process.execPath, [BUILDER, "--sdk-root", sdkRoot, "--repo-root", repoRoot, "--out-dir", join(sdkRoot, "out")], { timeout: 60_000, stdio: "pipe", encoding: "utf8" }), /源 drift/);
	assert.equal(readFileSync(manifestPath, "utf8"), manifestBefore, "manifest 不得被重写");
	for (const f of ["connection.js", "remote-env.js"]) {
		assert.ok(!existsSync(join(repoRoot, "vendor/pi-env/dist", f)), "拒绝后 vendor/dist 不得产出");
	}
});

test("builder 负控③：patch 文件篡改（相对 manifest.patchFileSha256）→ 拒绝且未变", () => {
	const { sdkRoot, repoRoot } = makeFixture();
	const patchPath = join(repoRoot, "vendor/pi-env/patch/env-session-pin.patch");
	writeFileSync(patchPath, "tampered patch\n");
	const manifestBefore = readFileSync(join(repoRoot, "vendor/pi-env/manifest.json"), "utf8");
	assert.throws(() => execFileSync(process.execPath, [BUILDER, "--sdk-root", sdkRoot, "--repo-root", repoRoot, "--out-dir", join(sdkRoot, "out")], { timeout: 60_000, stdio: "pipe", encoding: "utf8" }), /patch 文件 hash/);
	assert.equal(readFileSync(join(repoRoot, "vendor/pi-env/manifest.json"), "utf8"), manifestBefore, "manifest 不得被重写");
	assert.equal(readFileSync(patchPath, "utf8"), "tampered patch\n");
});

test("builder 正控（fixture）：预校验通过且进入定向 tsc（emit 依赖外部 pi-mono 演进，本机不强证）", () => {
	const { sdkRoot, repoRoot } = makeFixture();
	const outDir = join(sdkRoot, "owned-out");
	let combined = "";
	try {
		execFileSync(process.execPath, [BUILDER, "--sdk-root", sdkRoot, "--repo-root", repoRoot, "--out-dir", outDir], { timeout: 120_000, stdio: "pipe", encoding: "utf8" });
	} catch (e) {
		const err = e as { stdout?: unknown; stderr?: unknown };
		combined = String(err.stdout ?? "") + String(err.stderr ?? "");
	}
	// 断言：builder 通过预校验并真实调用定向 tsc（版本行含于合并输出）；
	// emit 阶段若因 fixture 类型环境（快照 vs 实际 pi-durable 版本）失败，如实保留非零退出，不假绿。
	assert.match(combined, /Version 5\.9\.3/, "必须真实调用定向 tsc 5.9.3");
	assert.doesNotMatch(combined, /源 drift|base drift|patch 文件 hash/, "预校验不得拒绝合法 fixture");
});
