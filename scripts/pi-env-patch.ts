#!/usr/bin/env node
/**
 * pi-env session-pin 补丁 CLI（人工调用；核心逻辑在 src/runtime/pi-env-patch.ts，本文件只做参数与受控退出）。
 *
 *   node scripts/pi-env-patch.ts apply|verify|rollback [repoRoot]
 *
 * - repoRoot 缺省为本仓根（生产校验对象固定，不接受任意用户路径改变校验语义——核心函数按需参数化仅供 isolated 测试）。
 * - 失败路径：核心 throw → 本 CLI 捕获后 stderr 输出并置 process.exitCode=1 自然退出（无 process.exit）。
 * - 不涉及 npm 生命周期；apply/rollback 均先完整预检再原子变更。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch, rollbackPatch, verifyPatch } from "../src/runtime/pi-env-patch.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDir, "..");
const mode = process.argv[2] ?? "verify";
const repoRoot = process.argv[3] ? resolve(process.argv[3]) : defaultRoot;

try {
	const state = mode === "apply" ? applyPatch(repoRoot) : mode === "rollback" ? rollbackPatch(repoRoot) : mode === "verify" ? verifyPatch(repoRoot) : null;
	if (state === null) {
		console.error(`pi-env-patch: 未知模式 ${mode}（可用 apply|verify|rollback）`);
		process.exitCode = 1;
	} else {
		console.log(`pi-env-patch: ${mode} 完成（repoRoot=${repoRoot}）state=${state.kind}`);
		for (const [file, s] of Object.entries(state.states)) console.log(`  ${s.padEnd(8)} dist/${file}`);
	}
} catch (error) {
	console.error(`pi-env-patch: FAIL ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
