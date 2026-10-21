/**
 * pi-env session-pin 补丁核心（纯函数，参数化 repoRoot；CLI 见 scripts/pi-env-patch.ts）。
 *
 * 安全属性（R3/R6）：
 * - manifest 严格 schema：files 恰好 4 个已知键、每键恰好 {patched, original} 64-hex；未知键/缺键/坏 hex/路径逃逸一律拒绝。
 * - 路径/链接逃逸面：node_modules 每一级 realpath 边界 + 非 symlink + regular-file；manifest 键仅允许安全 basename。
 * - 硬链接不写穿：写入走「同目录临时文件 + rename」原子替换（rename 换目录项，外部硬链接保持旧 inode）。
 * - 先完整预检（vendor 两侧 hash + 安装态分类）后变更；apply 预验全部 patched、rollback 预验全部 original 副本。
 * - mixed（original+patched 混合）与 unknown 在任何模式下显式拒绝——故障后状态 fail-closed，不静默自愈。
 * - 失败以 throw 报告（CLI 层转受控 exitCode），无 process.exit。
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PATCHED_FILES = ["connection.js", "remote-env.js", "connection.d.ts", "remote-env.d.ts"] as const;
const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_BASENAME = /^[A-Za-z0-9._-]+$/;

export interface PatchManifestEntry { patched: string; original: string }

export interface PatchManifest {
	name: string;
	base: Record<string, unknown>;
	compiler: Record<string, unknown>;
	files: Record<string, PatchManifestEntry>;
	[key: string]: unknown;
}

/** 默认仓库根（src/runtime → src → 仓根）。生产校验固定用这个根，用户路径不能改变校验对象。 */
export function defaultRepoRoot(): string {
	return join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** 加载并严格校验 manifest（schema/键集合/十六进制/路径逃逸）；坏 JSON/缺文件/不合 schema 一律 throw。 */
export function loadPatchManifest(repoRoot: string): PatchManifest {
	const path = join(repoRoot, "vendor", "pi-env", "manifest.json");
	if (!existsSync(path)) throw new Error(`pi-env-patch: manifest 缺失: ${path}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		throw new Error(`pi-env-patch: manifest 不是合法 JSON: ${(e as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("pi-env-patch: manifest 必须是 JSON 对象");
	const m = parsed as Record<string, unknown>;
	for (const key of ["name", "base", "compiler", "files"]) {
		if (!(key in m)) throw new Error(`pi-env-patch: manifest 缺键 ${key}`);
	}
	if (typeof m.name !== "string" || m.name === "") throw new Error("pi-env-patch: manifest.name 必须非空字符串");
	if (typeof m.base !== "object" || m.base === null || Array.isArray(m.base)) throw new Error("pi-env-patch: manifest.base 必须是对象");
	const base = m.base as Record<string, unknown>;
	if (typeof base.targetVersion !== "string" || base.targetVersion === "") throw new Error("pi-env-patch: manifest.base.targetVersion 必须非空");
	if (typeof m.compiler !== "object" || m.compiler === null || Array.isArray(m.compiler)) throw new Error("pi-env-patch: manifest.compiler 必须是对象");
	if (typeof m.files !== "object" || m.files === null || Array.isArray(m.files)) throw new Error("pi-env-patch: manifest.files 必须是对象");
	const files = m.files as Record<string, Record<string, unknown>>;
	const keys = Object.keys(files).sort();
	const expected = [...PATCHED_FILES].sort();
	if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
		throw new Error(`pi-env-patch: manifest.files 键必须恰好为 ${expected.join(",")}（实际 ${keys.join(",") || "空"}）`);
	}
	for (const key of keys) {
		if (!SAFE_BASENAME.test(key) || key.includes("..")) throw new Error(`pi-env-patch: manifest.files 键不安全: ${key}`);
		const entry = files[key];
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`pi-env-patch: files.${key} 必须是对象`);
		const entryKeys = Object.keys(entry).sort();
		if (entryKeys.length !== 2 || entryKeys[0] !== "original" || entryKeys[1] !== "patched") {
			throw new Error(`pi-env-patch: files.${key} 必须恰好含 original/patched 两键`);
		}
		for (const kind of ["original", "patched"] as const) {
			const value = entry[kind];
			if (typeof value !== "string" || !HEX64.test(value)) throw new Error(`pi-env-patch: files.${key}.${kind} 必须是 64 位小写十六进制`);
		}
	}
	return parsed as unknown as PatchManifest;
}

/** 安装目标（node_modules/@earendil-works/pi-env）逐级 realpath/非 symlink 边界 + 版本核验。 */
export function resolveInstallDir(repoRoot: string, manifest: PatchManifest): string {
	const root = realpathSync(repoRoot);
	const nodeModules = join(root, "node_modules");
	const scope = join(nodeModules, "@earendil-works");
	const pkg = join(scope, "pi-env");
	for (const dir of [nodeModules, scope, pkg]) {
		if (!existsSync(dir)) throw new Error(`pi-env-patch: 安装路径缺失: ${dir}`);
		if (lstatSync(dir).isSymbolicLink()) throw new Error(`pi-env-patch: 安装路径是 symlink（拒绝）: ${dir}`);
		if (realpathSync(dir) !== dir) throw new Error(`pi-env-patch: 安装路径 realpath 越界: ${dir}`);
	}
	const version = (JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { version?: unknown }).version;
	if (version !== manifest.base.targetVersion) {
		throw new Error(`pi-env-patch: 包版本 ${String(version)} != ${manifest.base.targetVersion}`);
	}
	const dist = join(pkg, "dist");
	if (!existsSync(dist)) throw new Error(`pi-env-patch: dist 缺失: ${dist}`);
	if (lstatSync(dist).isSymbolicLink()) throw new Error(`pi-env-patch: dist 是 symlink（拒绝）: ${dist}`);
	if (realpathSync(dist) !== dist) throw new Error(`pi-env-patch: dist realpath 越界: ${dist}`);
	return dist;
}

export type FileState = "patched" | "original" | "unknown";

/** R-Q4 检查①：Connection.snapshot 能力存在（旧 SDK 静默忽略未知字段，TS 类型不可信；纯同步零 spawn）。 */
export function assertSnapshotCapability(connection: object): void {
	if (typeof (connection as { snapshot?: unknown }).snapshot !== "function") {
		throw new Error("pi-env session-pin: 安装的 SDK 缺少 Connection.snapshot 能力，拒绝打开远端会话");
	}
}

/** R-Q4 检查②：pinnedSession getter 与快照 id 一致（受控对象/旧 SDK 可隔离验证；纯同步零 spawn）。 */
export function assertPinnedSessionGetter(guardEnv: object, expectedSessionId: number): void {
	const pin = (guardEnv as { pinnedSession?: unknown }).pinnedSession;
	if (pin !== expectedSessionId) {
		throw new Error(`pi-env session-pin: pinnedSession getter（${String(pin)}）与快照 id（${expectedSessionId}）不一致，拒绝打开远端会话`);
	}
}

export function assertSessionPinCapabilities(connection: object, guardEnv: object, expectedSessionId: number): void {
	assertSnapshotCapability(connection);
	assertPinnedSessionGetter(guardEnv, expectedSessionId);
}
export interface InstallState { dist: string; states: Record<string, FileState>; kind: "patched" | "original" | "mixed" | "unknown" }

/** 逐文件分类（patched/original/unknown）；目标必须 regular file 且 realpath 边界内。 */
export function classifyInstall(repoRoot: string, manifest: PatchManifest): InstallState {
	const dist = resolveInstallDir(repoRoot, manifest);
	const states: Record<string, FileState> = {};
	for (const f of PATCHED_FILES) {
		const path = join(dist, f);
		if (!existsSync(path)) throw new Error(`pi-env-patch: 安装文件缺失: dist/${f}`);
		const lstat = lstatSync(path);
		if (lstat.isSymbolicLink()) throw new Error(`pi-env-patch: 安装文件是 symlink（拒绝）: dist/${f}`);
		if (!lstat.isFile()) throw new Error(`pi-env-patch: 安装文件不是 regular file: dist/${f}`);
		if (realpathSync(path) !== path) throw new Error(`pi-env-patch: 安装文件 realpath 越界: dist/${f}`);
		const hash = sha256(path);
		const entry = manifest.files[f]!; // schema 校验已保证四键存在
		states[f] = hash === entry.patched ? "patched" : hash === entry.original ? "original" : "unknown";
	}
	const unique = new Set(Object.values(states));
	const kind = unique.size > 1 ? (unique.has("unknown") ? "unknown" : "mixed") : [...unique][0]!;
	return { dist, states, kind };
}

/** 原子替换：同目录临时文件 + rename（目录项级替换，外部硬链接保持旧 inode，不写穿）。 */
function atomicReplace(dist: string, file: string, sourcePath: string, expectHash: string): void {
	const content = readFileSync(sourcePath);
	const actual = createHash("sha256").update(content).digest("hex");
	if (actual !== expectHash) throw new Error(`pi-env-patch: 源内容 hash 不符（写入前拦截）: ${file}`);
	const temp = join(dist, `.pi-env-patch-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
	writeFileSync(temp, content);
	renameSync(temp, join(dist, file));
}

function preflightVendor(manifest: PatchManifest, repoRoot: string, kind: "patched" | "original"): void {
	// vendor 布局：patched 产物在 dist/，原版副本在 original/
	const subdir = kind === "patched" ? "dist" : "original";
	for (const f of PATCHED_FILES) {
		const path = join(repoRoot, "vendor", "pi-env", subdir, f);
		if (!existsSync(path)) throw new Error(`pi-env-patch: vendor/${subdir}/${f} 缺失`);
		if (lstatSync(path).isSymbolicLink()) throw new Error(`pi-env-patch: vendor/${subdir}/${f} 是 symlink（拒绝）`);
		const hash = sha256(path);
		if (hash !== (manifest.files[f] as PatchManifestEntry)[kind]) throw new Error(`pi-env-patch: vendor/${subdir}/${f} hash 不符（vendor 被篡改或重建方式不同）——拒绝`);
	}
}

function assertNoUnknown(state: InstallState): void {
	for (const [f, s] of Object.entries(state.states)) {
		if (s === "unknown") throw new Error(`pi-env-patch: dist/${f} hash 未知（既非 patched 也非 original）——拒绝，须人工处理`);
	}
}

/** apply：预检（manifest/vendor patched/安装态）→ 原子写入全部 → 事后全量复核。幂等。 */
export function applyPatch(repoRoot: string): InstallState {
	const manifest = loadPatchManifest(repoRoot);
	preflightVendor(manifest, repoRoot, "patched");
	const state = classifyInstall(repoRoot, manifest);
	assertNoUnknown(state);
	if (state.kind === "mixed") {
		throw new Error(`pi-env-patch: 安装处于 mixed 状态（${JSON.stringify(state.states)}）——拒绝，须先人工 rollback 到一致态`);
	}
	if (state.kind === "patched") return state; // 幂等
	for (const f of PATCHED_FILES) atomicReplace(state.dist, f, join(repoRoot, "vendor", "pi-env", "dist", f), (manifest.files[f] as PatchManifestEntry).patched);
	const after = classifyInstall(repoRoot, manifest);
	if (after.kind !== "patched") throw new Error(`pi-env-patch: apply 后状态非 patched（fail-closed）: ${JSON.stringify(after.states)}`);
	return after;
}

/** rollback：预检（manifest/vendor original/安装态）→ 原子写回全部 → 事后全量复核。幂等。 */
export function rollbackPatch(repoRoot: string): InstallState {
	const manifest = loadPatchManifest(repoRoot);
	preflightVendor(manifest, repoRoot, "original");
	const state = classifyInstall(repoRoot, manifest);
	assertNoUnknown(state);
	if (state.kind === "mixed") {
		throw new Error(`pi-env-patch: 安装处于 mixed 状态（${JSON.stringify(state.states)}）——拒绝，须先人工处理到一致态`);
	}
	if (state.kind === "original") return state; // 幂等
	for (const f of PATCHED_FILES) atomicReplace(state.dist, f, join(repoRoot, "vendor", "pi-env", "original", f), (manifest.files[f] as PatchManifestEntry).original);
	const after = classifyInstall(repoRoot, manifest);
	if (after.kind !== "original") throw new Error(`pi-env-patch: rollback 后状态非 original（fail-closed）: ${JSON.stringify(after.states)}`);
	return after;
}

/** verify：不写任何内容；mixed/unknown 也以 throw 报告（CLI 转受控 exitCode）。 */
export function verifyPatch(repoRoot: string): InstallState {
	const manifest = loadPatchManifest(repoRoot);
	const state = classifyInstall(repoRoot, manifest);
	if (state.kind === "mixed" || state.kind === "unknown") {
		throw new Error(`pi-env-patch: 安装状态 ${state.kind}（${JSON.stringify(state.states)}）——拒绝`);
	}
	return state;
}

/** 供 runtime（execution-env）使用的守卫前置核验：生产固定默认仓库根。
 * R-Q3：与 CLI verify 不同，runtime 显式要求 kind === "patched"——original（重装原 1.1）/混合/unknown 一律拒绝。 */
export function verifyPiEnvPatchInstalled(repoRoot: string = defaultRepoRoot()): InstallState {
	const state = verifyPatch(repoRoot);
	if (state.kind !== "patched") {
		throw new Error(`pi-env session-pin: 生产 runtime 要求补丁已应用（当前 ${state.kind}）——运行 node scripts/pi-env-patch.ts apply，不回退 unpinned`);
	}
	return state;
}
