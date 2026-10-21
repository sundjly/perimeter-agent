/**
 * R3/R6：installer/runtime verify 负控矩阵（isolated fixture，绝不触碰真实安装）。
 *
 * 覆盖：happy apply/rollback/幂等、tampered 安装、mixed/unknown 拒绝、wrong version、
 * manifest 缺键/多键/坏 hex/路径逃逸/坏 JSON、symlink 文件与目录、hardlink 不写穿、
 * vendor 两侧 hash 预检（apply/rollback 各自）、partial-copy 启动拒绝、参数化 repoRoot。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { applyPatch, assertPinnedSessionGetter, assertSnapshotCapability, classifyInstall, loadPatchManifest, rollbackPatch, verifyPatch, verifyPiEnvPatchInstalled } from "../src/runtime/pi-env-patch.ts";

const roots: string[] = [];
after(async () => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const FILES = ["connection.js", "remote-env.js", "connection.d.ts", "remote-env.d.ts"];
const ORIGINAL: Record<string, string> = Object.fromEntries(FILES.map((f) => [f, `original-content-of-${f}\n`]));
const PATCHED: Record<string, string> = Object.fromEntries(FILES.map((f) => [f, `patched-content-of-${f}\n`]));

interface FixtureOptions {
	version?: string;
	installed?: Record<string, string>;
	vendorPatched?: Record<string, string> | "default";
	vendorOriginal?: Record<string, string> | "default";
	manifest?: (base: { files: Record<string, { patched: string; original: string }> }) => unknown;
	distDirSymlink?: string;
	fileSymlink?: string;
	hardlinkFrom?: string;
}

function makeFixture(options: FixtureOptions = {}): string {
	const root = mkdtemp();
	const version = options.version ?? "1.1.0";
	const dist = join(root, "node_modules", "@earendil-works", "pi-env", "dist");
	mkdirSync(dist, { recursive: true });
	writeFileSync(join(root, "node_modules", "@earendil-works", "pi-env", "package.json"), JSON.stringify({ name: "@earendil-works/pi-env", version }));
	const installed = options.installed ?? ORIGINAL;
	for (const f of FILES) {
		if (installed[f] !== undefined) writeFileSync(join(dist, f), installed[f]); // 缺失项真缺失（partial-copy 场景）
	}
	if (options.distDirSymlink !== undefined) {
		rmSync(dist, { recursive: true, force: true });
		symlinkSync(options.distDirSymlink, dist, "dir");
	}
	if (options.fileSymlink !== undefined) {
		rmSync(join(dist, options.fileSymlink), { force: true });
		symlinkSync("/etc/hosts", join(dist, options.fileSymlink)); // 指向存在的文件，构造非悬挂 symlink
	}
	if (options.hardlinkFrom !== undefined) {
		writeFileSync(options.hardlinkFrom, installed[options.hardlinkFrom.split("/").pop()!] ?? "");
	}
	mkdirSync(join(root, "vendor", "pi-env", "dist"), { recursive: true });
	mkdirSync(join(root, "vendor", "pi-env", "original"), { recursive: true });
	const vendorPatched = options.vendorPatched === "default" || options.vendorPatched === undefined ? PATCHED : options.vendorPatched;
	const vendorOriginal = options.vendorOriginal === "default" || options.vendorOriginal === undefined ? ORIGINAL : options.vendorOriginal;
	for (const f of FILES) writeFileSync(join(root, "vendor", "pi-env", "dist", f), vendorPatched[f] ?? "");
	for (const f of FILES) writeFileSync(join(root, "vendor", "pi-env", "original", f), vendorOriginal[f] ?? "");
	// manifest 永远以 canonical 期望值为准（vendor 被篡改时预检才能发现不一致），不从被篡改副本反推
	const files = Object.fromEntries(FILES.map((f) => [f, { patched: sha(PATCHED[f]!), original: sha(ORIGINAL[f]!) }]));
	const manifest = options.manifest ? options.manifest({ files }) : { name: "test", base: { targetVersion: "1.1.0" }, compiler: { typescript: "5.9.3" }, files };
	writeFileSync(join(root, "vendor", "pi-env", "manifest.json"), JSON.stringify(manifest));
	return root;
}

function mkdtemp(): string {
	const root = mkdtempSync(join(tmpdir(), "patch-fixture-"));
	roots.push(root);
	return root;
}

const installedSnapshot = (root: string): Record<string, string> => {
	const dist = join(root, "node_modules", "@earendil-works", "pi-env", "dist");
	return Object.fromEntries(FILES.map((f) => [f, existsRead(join(dist, f))]));
};
const existsRead = (p: string): string => {
	try { return readFileSync(p, "utf8"); } catch { return "<missing>"; }
};

test("happy：original → apply → patched（内容精确匹配 vendor）；rollback → original；各自幂等", () => {
	const root = makeFixture();
	const s1 = applyPatch(root);
	assert.equal(s1.kind, "patched");
	for (const f of FILES) assert.equal(existsRead(join(root, "node_modules/@earendil-works/pi-env/dist", f)), PATCHED[f]);
	const s2 = applyPatch(root);
	assert.equal(s2.kind, "patched", "重复 apply 幂等");
	const s3 = rollbackPatch(root);
	assert.equal(s3.kind, "original");
	for (const f of FILES) assert.equal(existsRead(join(root, "node_modules/@earendil-works/pi-env/dist", f)), ORIGINAL[f]);
	const s4 = rollbackPatch(root);
	assert.equal(s4.kind, "original", "重复 rollback 幂等");
	const s5 = verifyPatch(root);
	assert.equal(s5.kind, "original");
});

test("tampered 安装（原版 hash 不符）→ apply 在写入前拒绝，文件未变", () => {
	const installed: Record<string, string> = { ...ORIGINAL, "connection.js": "TAMPERED" };
	const root = makeFixture({ installed });
	assert.throws(() => applyPatch(root), /未知/);
	for (const f of FILES) assert.equal(existsRead(join(root, "node_modules/@earendil-works/pi-env/dist", f)), installed[f], "拒绝后文件不得被改");
});

test("mixed 状态（2 patched + 2 original）→ apply 与 rollback 都显式拒绝", () => {
	const installed: Record<string, string> = { ...ORIGINAL, "connection.js": PATCHED["connection.js"]!, "remote-env.js": PATCHED["remote-env.js"]! };
	const root = makeFixture({ installed });
	assert.throws(() => applyPatch(root), /mixed/);
	assert.throws(() => rollbackPatch(root), /mixed/);
	for (const f of FILES) assert.equal(existsRead(join(root, "node_modules/@earendil-works/pi-env/dist", f)), installed[f]);
});

test("unknown 状态（hash 既非 patched 也非 original）→ 拒绝", () => {
	const installed: Record<string, string> = { ...ORIGINAL, "connection.js": "neither-hash-matches\n" };
	const root = makeFixture({ installed });
	assert.throws(() => verifyPatch(root), /unknown|未知/);
});

test("wrong version → 拒绝", () => {
	const root = makeFixture({ version: "1.2.0" });
	assert.throws(() => verifyPatch(root), /1\.1\.0/);
});

test("manifest 负控：缺键/多键/坏 hex/路径逃逸键/坏 JSON → 全部拒绝", () => {
	const missing = makeFixture({ manifest: ({ files }) => ({ name: "t", base: { targetVersion: "1.1.0" }, compiler: {}, files: { "connection.js": files["connection.js"] } }) });
	assert.throws(() => loadPatchManifest(missing), /键必须恰好/);
	const extra = makeFixture({ manifest: ({ files }) => ({ name: "t", base: { targetVersion: "1.1.0" }, compiler: {}, files: { ...files, "evil.js": files["connection.js"] } }) });
	assert.throws(() => loadPatchManifest(extra), /键必须恰好/);
	const badHex = makeFixture({ manifest: ({ files }) => ({ name: "t", base: { targetVersion: "1.1.0" }, compiler: {}, files: { ...files, "connection.js": { ...files["connection.js"], patched: "zz" } } }) });
	assert.throws(() => loadPatchManifest(badHex), /十六进制/);
	const escape = makeFixture({ manifest: ({ files }) => ({ name: "t", base: { targetVersion: "1.1.0" }, compiler: {}, files: { ...files, "../escape.js": files["connection.js"] } }) });
	assert.throws(() => loadPatchManifest(escape), /键必须恰好|不安全/);
	const badJson = makeFixture();
	writeFileSync(join(badJson, "vendor/pi-env/manifest.json"), "{ not json");
	assert.throws(() => loadPatchManifest(badJson), /JSON/);
});

test("dist 目录或文件 symlink → 拒绝（realpath 边界）", () => {
	const outside = mkdtemp();
	const symDir = makeFixture({ distDirSymlink: outside });
	assert.throws(() => verifyPatch(symDir), /symlink|realpath/);
	const symFile = makeFixture({ fileSymlink: "connection.js" });
	assert.throws(() => verifyPatch(symFile), /symlink/);
});

test("hardlink 不写穿：apply 用 rename 替换目录项，外部硬链接内容保持不变", () => {
	const root = makeFixture();
	const external = join(root, "external-hardlink.js");
	const distFile = join(root, "node_modules/@earendil-works/pi-env/dist/connection.js");
	// 使 dist/connection.js 与 external 互为硬链接（同一 inode）
	linkSync(distFile, external);
	assert.equal(statSync(distFile).nlink, 2, "fixture 必须构造出硬链接");
	applyPatch(root);
	assert.equal(existsRead(external), ORIGINAL["connection.js"], "外部硬链接不得被写穿");
	assert.equal(existsRead(distFile), PATCHED["connection.js"], "安装文件必须已更新");
});

test("vendor 两侧 hash 预检：patched 篡改拒 apply、original 篡改拒 rollback（均在写入前）", () => {
	const tamperedPatched: Record<string, string> = { ...PATCHED, "connection.js": "VENDOR-TAMPERED" };
	const r1 = makeFixture({ vendorPatched: tamperedPatched });
	const before1 = installedSnapshot(r1);
	assert.throws(() => applyPatch(r1), /hash 不符/);
	assert.deepEqual(installedSnapshot(r1), before1, "拒绝后安装不得被改");
	const tamperedOriginal: Record<string, string> = { ...ORIGINAL, "connection.js": "VENDOR-ORIGINAL-TAMPERED" };
	const r2 = makeFixture({ installed: { ...PATCHED }, vendorOriginal: tamperedOriginal });
	const before2 = installedSnapshot(r2);
	assert.throws(() => rollbackPatch(r2), /hash 不符/);
	assert.deepEqual(installedSnapshot(r2), before2, "拒绝后安装不得被改");
});

test("partial-copy 启动拒绝：缺一个安装文件 → classify/verify 即失败", () => {
	const installed: Record<string, string> = { ...ORIGINAL };
	delete installed["remote-env.js"];
	const root = makeFixture({ installed });
	assert.throws(() => classifyInstall(root, loadPatchManifest(root)), /缺失/);
	assert.throws(() => verifyPatch(root), /缺失/);
});

test("生产默认根：真实安装当前为 patched，无参 verify 通过", () => {
	const state = verifyPiEnvPatchInstalled();
	assert.equal(state.kind, "patched");
});

// ─── R-Q3/Q4：runtime 层负控（与 CLI verify 不同：runtime 显式要求 patched；能力门纯同步零 spawn）───

test("R-Q3 runtime gate：original 安装 → verifyPiEnvPatchInstalled 拒绝（CLI verify 允许、runtime 不允许）", () => {
	const root = makeFixture(); // original 安装 + 合法 manifest
	assert.throws(() => verifyPiEnvPatchInstalled(root), /补丁已应用|不回退 unpinned/);
	// 对照：同一 root 上 CLI 语义 verifyPatch 允许 original（两套语义并存且不同）
	assert.equal(verifyPatch(root).kind, "original");
});

test("R-Q4 旧 SDK：无 snapshot 能力 → 能力门拒绝，纯同步零 I/O（受控对象方法零调用）", () => {
	const calls: string[] = [];
	const oldSdkConnection = { close: () => { calls.push("close"); } }; // 受控旧 SDK 对象（无 snapshot）
	assert.throws(() => assertSnapshotCapability(oldSdkConnection), /缺少 Connection\.snapshot/);
	assert.deepEqual(calls, [], "能力门必须零 I/O：不得触发受控对象任何方法/连接启动");
});

test("R-Q4 缺 pinnedSession getter / getter 不一致 → 拒绝", () => {
	assert.throws(() => assertPinnedSessionGetter({}, 1), /pinnedSession/);
	assert.throws(() => assertPinnedSessionGetter({ pinnedSession: 2 }, 1), /不一致/);
	assert.doesNotThrow(() => assertPinnedSessionGetter({ pinnedSession: 1 }, 1));
});
