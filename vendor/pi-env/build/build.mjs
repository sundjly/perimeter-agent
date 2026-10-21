#!/usr/bin/env node
/**
 * G1 session-pin vendor builder（可复现构建；R4/R5；teardown-hardening r2 更新源管线）。
 *
 * 步骤（每步落日志，逐环可验证）：
 *   0) 预校验既有 manifest（base 基线 hash + patch 文件 hash；无 manifest 则为首建；先于 tsc/emit 全部副作用）；
 *   1) 源 hash：base 与 patched 源。base 固定为 manifest.base.head 指向的提交（缺省 HEAD）；
 *      patched 源 = owned 临时目录 materialize base 源 + git apply 本仓 vendor/pi-env/patch/env-session-pin.patch。
 *      不再读取 pi-mono 工作树（外部工作树 drift 8efd314fa 不得影响本仓生成物；patch 文件是唯一事实来源）；
 *   2) 由 tsconfig.env.template.json 生成实际 tsconfig（token：SDKROOT/OUTDIR/PERIMETER_NODE_MODULES；
 *      rootDir/include 覆写到 owned patched 源目录）；
 *   3) 定向 tsc（现装版本）emit 到本轮 owned outDir；
 *   4) 漂移核对：base 源（git show baseRef）同流程 emit vs 安装 dist 的 4 文件逐字节比对（应全 SAME）；
 *   5) postprocess：剥离 4 文件尾部 `//# sourceMappingURL=…`（R5：旧 map 不再被任何读取路径引用；
 *      安装目录中保留的旧 map 文件成为无引用孤儿，可随手清理）；
 *   6) 写 vendor/pi-env/dist/ 4 文件 + 重算 manifest.files[].patched（original 侧不变）+ 记录 map 策略与
 *      postprocess 说明；manifest 的源 hash 同步刷新。
 *
 * 用法：node vendor/pi-env/build/build.mjs [--sdk-root <pi-mono>] [--out-dir <owned tmp>]
 * 默认：sdk-root = 本仓 ../../../../pi-mono 相对推导（仅提供 tsconfig extends/typeRoots/tsc；源不取自工作树）；
 *       out-dir = 系统临时目录下 build-out-<pid>（用后保留供取证）。
 * 约束：不装依赖、不编译其它包、不跑 cargo；tsc 使用现装版本（build 时打印版本）；
 *       对 pi-mono 仅 git show/ls 只读，零写入。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const buildDir = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : fallback;
};
const defaultRepoRoot = resolve(buildDir, "..", "..", "..");
const repoRoot = arg("repo-root", defaultRepoRoot);
const nodeModules = join(defaultRepoRoot, "node_modules");
const sdkRoot = arg("sdk-root", resolve(defaultRepoRoot, "..", "..", "pi-mono"));
// R-Q7：输出目录必须新 owned（mkdtemp）或显式拒绝已存在目标——绝不 rmSync 任何不明/用户非空目录
let outDir;
const providedOutDir = process.argv.includes("--out-dir") ? arg("out-dir", "") : null;
if (providedOutDir) {
	if (existsSync(providedOutDir)) throw new Error(`[build] --out-dir 已存在（拒绝非 owned 目标）: ${providedOutDir}`);
	mkdirSync(providedOutDir, { recursive: true });
	outDir = providedOutDir;
} else {
	outDir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pi-env-build-out-"));
}
const FILES = ["connection.js", "remote-env.js", "connection.d.ts", "remote-env.d.ts"];
const SRC_FILES = ["connection.ts", "remote-env.ts", "errors.ts", "index.ts", "ssh.ts", "watch.ts"];
const PATCH_REL = "packages/env/src";
const step = (message) => console.log(`[build] ${message}`);
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function bounded(cmd, args, options = {}) {
	const result = execFileSync(cmd, args, { timeout: 60_000, encoding: "utf8", ...options });
	return result;
}

function main() {
	const envSrc = join(sdkRoot, "packages/env/src");
	const tsconfigBuild = join(sdkRoot, "packages/env/tsconfig.build.json");
	if (!existsSync(envSrc) || !existsSync(tsconfigBuild)) throw new Error(`SDK root 不含 packages/env: ${sdkRoot}`);

	step(`0) 预校验既有 manifest（R-Q7：防任意来源重写后自信任；无 manifest 则为首建；先于 tsc/emit 全部副作用）`);
	const manifestPath = join(repoRoot, "vendor", "pi-env", "manifest.json");
	const prior = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
	// base 固定 pin：优先 manifest.base.head（真实仓=cdaf6c227）；fixture/首建无 head 时退回 HEAD。
	// 禁止用当前 HEAD 替代 pin：外部仓 drift（如 8efd314fa）不得改写本仓生成物来源。
	const baseRef = prior && typeof prior.base?.head === "string" && /^[0-9a-fA-F]{4,40}$/.test(prior.base.head) ? prior.base.head : "HEAD";
	if (prior) {
		const gitBase = {
			"packages/env/src/connection.ts": sha2str(bounded("git", ["show", `${baseRef}:packages/env/src/connection.ts`], { cwd: sdkRoot })),
			"packages/env/src/remote-env.ts": sha2str(bounded("git", ["show", `${baseRef}:packages/env/src/remote-env.ts`], { cwd: sdkRoot })),
		};
		if (prior.base?.sourceBaseHashes && JSON.stringify(prior.base.sourceBaseHashes) !== JSON.stringify(gitBase)) {
			throw new Error(`[build] base drift：pin ${baseRef} 基线源 hash 与既有 manifest.sourceBaseHashes 不一致——停止`);
		}
		if (typeof prior.patchFileSha256 === "string") {
			const patchPath = join(repoRoot, "vendor", "pi-env", "patch", "env-session-pin.patch");
			if (!existsSync(patchPath)) throw new Error(`[build] manifest 记录的 patch 文件缺失: ${patchPath}`);
			if (sha(patchPath) !== prior.patchFileSha256) throw new Error(`[build] patch 文件 hash 与既有 manifest 记录不符——拒绝`);
		}
		console.log(`    预校验通过（base pin=${baseRef}/patchFile 与既有 manifest 一致；patched 源由 base+patch 派生，不读工作树）`);
	}

	step(`1) 源 hash：base(${baseRef}) 与 patched（owned 临时目录 materialize base + git apply 本仓 patch）`);
	const workTmp = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pi-env-build-cfg-"));
	const patchedRoot = join(workTmp, "patched-src");
	mkdirSync(join(patchedRoot, PATCH_REL), { recursive: true });
	for (const f of SRC_FILES) {
		writeFileSync(join(patchedRoot, PATCH_REL, f), bounded("git", ["show", `${baseRef}:packages/env/src/${f}`], { cwd: sdkRoot }));
	}
	writeFileSync(join(patchedRoot, "package.json"), '{"type":"module"}');
	const patchPath = join(repoRoot, "vendor", "pi-env", "patch", "env-session-pin.patch");
	bounded("git", ["apply", "--check", patchPath], { cwd: patchedRoot });
	bounded("git", ["apply", patchPath], { cwd: patchedRoot });
	const baseSource = {
		"packages/env/src/connection.ts": sha2str(bounded("git", ["show", `${baseRef}:packages/env/src/connection.ts`], { cwd: sdkRoot })),
		"packages/env/src/remote-env.ts": sha2str(bounded("git", ["show", `${baseRef}:packages/env/src/remote-env.ts`], { cwd: sdkRoot })),
	};
	const patchedSource = {
		"packages/env/src/connection.ts": sha(join(patchedRoot, PATCH_REL, "connection.ts")),
		"packages/env/src/remote-env.ts": sha(join(patchedRoot, PATCH_REL, "remote-env.ts")),
	};
	if (prior?.base?.sources && JSON.stringify(prior.base.sources) !== JSON.stringify(patchedSource)) {
		throw new Error(`[build] 源 drift：patch 应用结果与既有 manifest.base.sources 不一致——需人工 rebaseline，不自信任`);
	}
	console.log(`    base=${JSON.stringify(baseSource)}`);
	console.log(`    patched=${JSON.stringify(patchedSource)}`);

	step(`2) 生成实际 tsconfig（token 替换 + rootDir/include 覆写到 owned patched 源）`);
	const template = readFileSync(join(buildDir, "tsconfig.env.template.json"), "utf8");
	const realConfig = template.replaceAll("{{SDKROOT}}", sdkRoot).replaceAll("{{OUTDIR}}", join(outDir, "dist")).replaceAll("{{PERIMETER_NODE_MODULES}}", nodeModules);
	const realConfigJson = JSON.parse(realConfig);
	realConfigJson.compilerOptions.rootDir = join(patchedRoot, PATCH_REL);
	realConfigJson.include = [join(patchedRoot, `${PATCH_REL}/**/*.ts`)];
	writeFileSync(join(workTmp, "tsconfig.env.json"), JSON.stringify(realConfigJson));

	step(`3) 定向 tsc emit → ${outDir}/dist`);
	const tsc = join(sdkRoot, "node_modules", "typescript", "bin", "tsc");
	if (!existsSync(tsc)) throw new Error(`tsc 不存在: ${tsc}（不安装依赖；若缺失请停止并报告）`);
	const version = String(bounded(tsc, ["--version"])).trim();
	console.log(`    ${version}`);
	bounded(tsc, ["-p", join(workTmp, "tsconfig.env.json")]);
	for (const f of FILES) if (!existsSync(join(outDir, "dist", f))) throw new Error(`emit 缺产物: ${f}`);

	step(`4) 漂移核对：base 源（${baseRef}）emit vs vendor/original（官方 1.1.0 副本；应全 SAME——与安装态解耦，安装可为任意合法状态）`);
	mkdirSync(join(workTmp, "base-src"), { recursive: true });
	for (const f of SRC_FILES) {
		writeFileSync(join(workTmp, "base-src", f), bounded("git", ["show", `${baseRef}:packages/env/src/${f}`], { cwd: sdkRoot }));
	}
	writeFileSync(join(workTmp, "base-src", "package.json"), '{"type":"module"}');
	const baseConfigJson = JSON.parse(realConfig);
	baseConfigJson.compilerOptions.outDir = join(outDir, "dist-base");
	baseConfigJson.compilerOptions.rootDir = join(workTmp, "base-src");
	baseConfigJson.include = [join(workTmp, "base-src/**/*.ts")];
	writeFileSync(join(workTmp, "tsconfig.base-emit.json"), JSON.stringify(baseConfigJson));
	bounded(tsc, ["-p", join(workTmp, "tsconfig.base-emit.json")]);
	const originalDist = join(repoRoot, "vendor", "pi-env", "original");
	const drift = {};
	for (const f of FILES) drift[f] = sameFile(join(outDir, "dist-base", f), join(originalDist, f)) ? "SAME" : "DIFF";
	console.log(`    drift=${JSON.stringify(drift)}`);
	for (const f of FILES) {
		if (drift[f] === "DIFF") throw new Error(`漂移核对失败（${f} 与官方 original 副本不一致）——编译环境与官方构建不同，停止`);
	}

	step(`5) postprocess：剥离 sourceMappingURL（R5）`);
	for (const f of FILES) {
		const path = join(outDir, "dist", f);
		const stripped = readFileSync(path, "utf8").replace(/\n?\/\/# sourceMappingURL=.*\n?/g, "\n");
		writeFileSync(path, stripped);
	}

	step(`6) 写 vendor/dist + 更新 manifest`);
	mkdirSync(join(repoRoot, "vendor", "pi-env", "dist"), { recursive: true });
	for (const f of FILES) copyFileSync(join(outDir, "dist", f), join(repoRoot, "vendor", "pi-env", "dist", f));
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	manifest.base.sources = patchedSource;
	manifest.base.sourceBaseHashes = baseSource;
	manifest.patchFileSha256 = sha(join(repoRoot, "vendor", "pi-env", "patch", "env-session-pin.patch"));
	manifest.compiler = {
		typescript: version,
		command: `node <sdk-root>/node_modules/typescript/bin/tsc -p <generated from vendor/pi-env/build/tsconfig.env.template.json>（由 build.mjs 组装；outDir=本轮 owned 临时目录）`,
		builder: "vendor/pi-env/build/build.mjs",
		driftCheck: `未改源同流程 emit vs 安装 dist：${JSON.stringify(drift)}`,
	};
	manifest.sourceMapPolicy = "stripped: 生成 JS/d.ts 的 sourceMappingURL 注释已剥离；安装目录旧 map 成为无引用孤儿（可清理），调试器不再读到过期映射";
	manifest.files = Object.fromEntries(FILES.map((f) => [f, { patched: sha(join(repoRoot, "vendor", "pi-env", "dist", f)), original: manifest.files[f].original }]));
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
	console.log(`    new patched hashes=${JSON.stringify(Object.fromEntries(FILES.map((f) => [f, manifest.files[f].patched.slice(0, 12)])))}`);
	console.log("[build] done");
}

function sha2str(content) {
	return createHash("sha256").update(content).digest("hex");
}

function sameFile(a, b) {
	if (!existsSync(a) || !existsSync(b)) return false;
	return sha(a) === sha(b);
}

main();
