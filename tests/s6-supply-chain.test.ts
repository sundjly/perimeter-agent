/**
 * S6 供应链交付物（scripts/s6-supply-chain.ts）fixture 测试。
 *
 * 四条线，全部离线、零子进程、零网络：
 * 1. 完整性：直接 + 传递依赖全部入册（含嵌套 node_modules 同名异版本）、scoped purl、
 *    按 purl 去重且保留安装位证据（s6:lock:alsoAt）。
 * 2. 证据纪律：license 仅在有锁证据时写且一律 license.name 保留锁原文（不冒充 SPDX id：
 *    UNLICENSED/LicenseRef 类自定义名也只是锁内原文，不是可断言的标准 id）；sha512 integrity →
 *    SHA-512 hex；dev/optional/hasInstallScript 只来自锁内布尔证据。
 * 3. 未知字段：锁条目里不认识的字段一律忽略，不影响产出。
 * 4. 无效输入不悄悄成功：每个固定错误类别断言 SbomError.code；CLI 失败返回非零且
 *    不写出目标文件；revision 缺失如实写 unknown。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildBom, main, parseLock, readGitRevision, SbomError, serializeBom, toPurl } from "../scripts/s6-supply-chain.ts";

function assertSbomError(fn: () => unknown, code: string): void {
	assert.throws(fn, (err: unknown) => err instanceof SbomError && err.code === code, `应抛固定类别 ${code}`);
}

/** 64 字节 'a' 的 sha512-<base64> 形态 integrity（解码后 hex = "61"×64） */
const SHA512_A = `sha512-${Buffer.from("a".repeat(64)).toString("base64")}`;

interface FixtureEntry {
	version: string;
	license?: string;
	dev?: boolean;
	optional?: boolean;
	hasInstallScript?: boolean;
	integrity?: string;
	name?: string;
	[key: string]: unknown;
}

function fixtureLock(entries: Record<string, FixtureEntry>, lockfileVersion: number | string = 3): string {
	return JSON.stringify({
		name: "fixture-app",
		version: "2.0.0",
		lockfileVersion,
		packages: { "": { name: "fixture-app", version: "2.0.0", dependencies: { a: "^1" } }, ...entries },
	});
}

function bomOf(entries: Record<string, FixtureEntry>): Record<string, unknown> {
	return buildBom(parseLock(fixtureLock(entries)), { lockSource: "fixture/package-lock.json", repoRevision: "unknown", now: new Date(0) });
}

describe("s6-supply-chain：完整性与 purl", () => {
	test("直接 + 传递依赖全部入册，嵌套同名异版本不丢", () => {
		const bom = bomOf({
			"node_modules/a": { version: "1.0.0", license: "MIT", integrity: SHA512_A, dependencies: { c: "^3" } },
			"node_modules/b": { version: "1.0.0" },
			"node_modules/b/node_modules/c": { version: "3.1.0", license: "(MIT OR Apache-2.0)" },
			"node_modules/c": { version: "3.0.0", license: "Apache-2.0" },
		});
		const meta = bom["metadata"] as Record<string, unknown>;
		const root = meta["component"] as Record<string, unknown>;
		assert.equal(bom["bomFormat"], "CycloneDX");
		assert.equal(bom["specVersion"], "1.6");
		assert.equal(bom["version"], 1);
		assert.ok(String(bom["serialNumber"]).startsWith("urn:uuid:"));
		assert.equal(root["type"], "application");
		assert.equal(root["name"], "fixture-app");
		assert.equal(root["version"], "2.0.0");
		const comps = bom["components"] as Record<string, unknown>[];
		// 按 purl 排序：a, b, c@3.0.0, c@3.1.0（嵌套异版本必须保留）
		assert.deepEqual(
			comps.map((c) => [c["name"], c["version"]]),
			[["a", "1.0.0"], ["b", "1.0.0"], ["c", "3.0.0"], ["c", "3.1.0"]],
		);
		const props = (meta["properties"] as { name: string; value: string }[]).reduce<Record<string, string>>((acc, p) => { acc[p.name] = p.value; return acc; }, {});
		assert.equal(props["s6:lock:entryCount"], "4");
		assert.equal(props["s6:lock:componentCount"], "4");
	});

	test("scoped 包 purl：%40 编码、小写、version 百分号编码", () => {
		assert.equal(toPurl("@scope/pkg", "1.0.0"), "pkg:npm/%40scope/pkg@1.0.0");
		assert.equal(toPurl("@scope/pkg", "1.0.0-beta.1"), "pkg:npm/%40scope/pkg@1.0.0-beta.1");
		const bom = bomOf({ "node_modules/@scope/pkg": { version: "1.0.0" } });
		const comps = bom["components"] as Record<string, unknown>[];
		assert.equal(comps[0]!["purl"], "pkg:npm/%40scope/pkg@1.0.0");
		assert.equal(comps[0]!["bom-ref"], "pkg:npm/%40scope/pkg@1.0.0");
	});

	test("同名同版本嵌套重复按 purl 去重，安装位记入 alsoAt 证据", () => {
		const bom = bomOf({
			"node_modules/a": { version: "1.0.0" },
			"node_modules/@scope/pkg": { version: "1.0.0", license: "MIT" },
			"node_modules/a/node_modules/@scope/pkg": { version: "1.0.0" },
		});
		const comps = bom["components"] as Record<string, unknown>[];
		assert.equal(comps.length, 2);
		const scoped = comps.find((c) => c["name"] === "@scope/pkg")!;
		const props = (scoped["properties"] as { name: string; value: string }[]).map((p) => `${p.name}=${p.value}`);
		assert.ok(props.includes("s6:lock:alsoAt=node_modules/a/node_modules/@scope/pkg"), `应含嵌套安装位证据，实际：${props.join(";")}`);
		assert.equal(((bom["metadata"] as Record<string, unknown>)["properties"] as { name: string; value: string }[]).find((p) => p.name === "s6:lock:componentCount")!.value, "2");
	});

	test("序列化可往返且带尾换行", () => {
		const text = serializeBom(bomOf({ "node_modules/a": { version: "1.0.0" } }));
		assert.ok(text.endsWith("}\n"));
		const round = JSON.parse(text) as Record<string, unknown>;
		assert.equal(round["specVersion"], "1.6");
	});
});

describe("s6-supply-chain：锁内证据纪律", () => {
	test("license：一律 name 保留锁原文（含非 SPDX 单 token，不冒充 id）；无证据 → 无 licenses 字段", () => {
		const bom = bomOf({
			"node_modules/mit": { version: "1.0.0", license: "MIT" },
			"node_modules/unlic": { version: "1.0.0", license: "UNLICENSED" },
			"node_modules/licref": { version: "1.0.0", license: "LicenseRef-Proprietary" },
			"node_modules/custom": { version: "1.0.0", license: "Foo-License-1.0" },
			"node_modules/compound": { version: "1.0.0", license: "(MIT OR Apache-2.0)" },
			"node_modules/noevidence": { version: "1.0.0" },
		});
		const comps = bom["components"] as Record<string, unknown>[];
		const byName = new Map(comps.map((c) => [c["name"], c] as const));
		assert.deepEqual(byName.get("mit")!["licenses"], [{ license: { name: "MIT" } }]);
		assert.deepEqual(byName.get("unlic")!["licenses"], [{ license: { name: "UNLICENSED" } }]);
		assert.deepEqual(byName.get("licref")!["licenses"], [{ license: { name: "LicenseRef-Proprietary" } }]);
		assert.deepEqual(byName.get("custom")!["licenses"], [{ license: { name: "Foo-License-1.0" } }]);
		assert.deepEqual(byName.get("compound")!["licenses"], [{ license: { name: "(MIT OR Apache-2.0)" } }]);
		assert.ok(!("licenses" in byName.get("noevidence")!), "锁内无 license 证据时不得伪造 licenses/unknown");
	});

	test("sha512 integrity → SHA-512 hex 哈希；dev/optional/hasInstallScript 来自布尔证据", () => {
		const bom = bomOf({
			"node_modules/a": { version: "1.0.0", integrity: SHA512_A, dev: true },
			"node_modules/b": { version: "1.0.0", optional: true },
			"node_modules/c": { version: "1.0.0", hasInstallScript: true },
		});
		const comps = bom["components"] as Record<string, unknown>[];
		const byName = new Map(comps.map((c) => [c["name"], c] as const));
		assert.deepEqual(byName.get("a")!["hashes"], [{ alg: "SHA-512", content: "61".repeat(64) }]);
		const propsOf = (name: string) => ((byName.get(name)!["properties"] as { name: string; value: string }[] | undefined) ?? []).map((p) => p.name);
		assert.ok(propsOf("a").includes("s6:lock:dev"));
		assert.equal(byName.get("b")!["scope"], "optional");
		assert.ok(propsOf("c").includes("s6:lock:hasInstallScript"));
	});

	test("锁条目未知字段一律忽略，不影响产出", () => {
		const bom = bomOf({
			"node_modules/a": {
				version: "1.0.0",
				license: "MIT",
				futureField: { nested: [1, 2, { x: null }] },
				engines: { node: ">=18" },
				funding: [{ type: "github", url: "https://example.invalid/sponsors/x" }],
				peerDependenciesMeta: { zod: { optional: true } },
			},
		});
		const comps = bom["components"] as Record<string, unknown>[];
		assert.equal(comps.length, 1);
		assert.equal(comps[0]!["name"], "a");
		assert.deepEqual(comps[0]!["licenses"], [{ license: { name: "MIT" } }]);
	});
});

describe("s6-supply-chain：无效输入不悄悄成功", () => {
	test("各固定错误类别逐一拒绝", () => {
		assertSbomError(() => parseLock("{not json"), "lock_not_json");
		assertSbomError(() => parseLock("[]"), "lock_not_object");
		assertSbomError(() => parseLock('{"lockfileVersion":1,"packages":{}}'), "lockfile_version_unsupported");
		assertSbomError(() => parseLock('{"lockfileVersion":3}'), "packages_missing");
		assertSbomError(() => parseLock('{"lockfileVersion":3,"packages":{"node_modules/a":{"version":"1.0.0"}}}'), "root_entry_missing");
		assertSbomError(() => parseLock('{"lockfileVersion":3,"packages":{"":{"name":"x"}}}'), "root_entry_invalid");
		assertSbomError(() => parseLock(fixtureLock({ "packages/a": { version: "1.0.0" } } as unknown as Record<string, FixtureEntry>)), "entry_key_unsupported");
		assertSbomError(() => parseLock(fixtureLock({ "node_modules/": { version: "1.0.0" } })), "entry_key_unsupported");
		assertSbomError(() => parseLock(fixtureLock({ "node_modules/@lonely": { version: "1.0.0" } })), "entry_key_unsupported");
		assertSbomError(() => parseLock(fixtureLock({ "node_modules/foo": { version: "1.0.0", name: "bar" } })), "entry_name_mismatch");
		assertSbomError(() => parseLock(fixtureLock({ "node_modules/foo": { version: "" } })), "entry_version_missing");
		assertSbomError(() => parseLock(fixtureLock({ "node_modules/foo": { version: "1.0.0", license: 42 } } as unknown as Record<string, FixtureEntry>)), "license_unsupported");
		assertSbomError(() => parseLock(fixtureLock({ "node_modules/foo": { version: "1.0.0", integrity: "sha1-abc" } })), "integrity_unsupported");
		assertSbomError(() => parseLock(fixtureLock({ "node_modules/foo": { version: "1.0.0", integrity: "sha512-not base64!!!" } })), "integrity_unsupported");
	});

	test("CLI：成功写产物并返回 0；失败返回非零且不产出文件", () => {
		const dir = mkdtempSync(join(tmpdir(), "s6-supply-chain-test-"));
		try {
			const lockFile = join(dir, "package-lock.json");
			const outFile = join(dir, "sbom.cdx.json");
			writeFileSync(lockFile, fixtureLock({ "node_modules/a": { version: "1.0.0", license: "MIT" } }));
			assert.equal(main(["--lock", lockFile, "--repo", dir, "--out", outFile]), 0);
			const bom = JSON.parse(readFileSync(outFile, "utf8")) as Record<string, unknown>;
			assert.equal(bom["specVersion"], "1.6");
			const props = ((bom["metadata"] as Record<string, unknown>)["properties"] as { name: string; value: string }[]).reduce<Record<string, string>>((acc, p) => { acc[p.name] = p.value; return acc; }, {});
			assert.equal(props["s6:repo:revision"], "unknown", "空目录无 .git → revision 如实 unknown");

			const badOut = join(dir, "should-not-exist.json");
			writeFileSync(lockFile, "{broken");
			assert.equal(main(["--lock", lockFile, "--out", badOut]), 1);
			assert.ok(!existsSync(badOut), "输入无效时不得产出部分 SBOM");
			assert.equal(main(["--definitely-not-a-flag", "x", "--out", badOut]), 1);
			assert.equal(main(["--lock", join(dir, "missing.json"), "--out", badOut]), 1);
			assert.ok(!existsSync(badOut));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("s6-supply-chain：readGitRevision（纯文件读取，非 git 命令）", () => {
	test("松散 ref / packed-refs / 直连 HEAD / 无 .git 四种形态", () => {
		const dir = mkdtempSync(join(tmpdir(), "s6-git-rev-test-"));
		try {
			const sha = "1234567890abcdef1234567890abcdef12345678";
			const packedSha = "9876543210abcdef9876543210abcdef98765432";
			mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
			writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
			writeFileSync(join(dir, ".git", "refs", "heads", "main"), `${sha}\n`);
			assert.equal(readGitRevision(dir), sha);

			writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/packed-only\n");
			writeFileSync(join(dir, ".git", "packed-refs"), `# pack-refs\n${packedSha} refs/heads/packed-only\n`);
			assert.equal(readGitRevision(dir), packedSha);

			writeFileSync(join(dir, ".git", "HEAD"), `${sha}\n`);
			assert.equal(readGitRevision(dir), sha);

			const empty = mkdtempSync(join(tmpdir(), "s6-no-git-"));
			try {
				assert.equal(readGitRevision(empty), "unknown");
			} finally {
				rmSync(empty, { recursive: true, force: true });
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
