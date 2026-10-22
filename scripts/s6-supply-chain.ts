#!/usr/bin/env node
/**
 * S6：本机离线 SBOM 生成 CLI（CycloneDX 1.6 JSON）。
 *
 * 语义边界（一条都不能让）：
 * - 零网络、零子进程：只读 lockfile 与 .git 元数据文件（HEAD/refs/packed-refs），
 *   不安装依赖、不执行锁中任何脚本。漏洞扫描（npm audit 等）由协调者在受控环境另行
 *   执行（见 docs/operations/s6-runbook.md），本脚本不产出任何漏洞结论。
 * - licenses 只在锁文件有 license 证据时写，一律以 license.name 保留锁原文：不把任意单 token
 *   冒充已知 SPDX id（UNLICENSED/LicenseRef 类自定义名都不可断言为标准 id）；锁里没有就不写
 *   licenses 字段 —— 不伪造 "unknown"。
 * - 覆盖范围显式标注进 metadata.properties：仅 lockfileVersion 2/3 的 packages 条目；
 *   vendor/ 目录与容器镜像不在本 SBOM 范围；仓库 revision 取自 .git 文件（非 git 命令），
 *   取不到如实写 "unknown"，不虚构。
 * - 输入无效（JSON 损坏、lockfileVersion 1、packages 缺失、键/名称/版本/完整性不合规）
 *   一律非零退出且不写出目标文件，绝不产出部分 SBOM；锁条目里不认识的字段一律忽略。
 *
 * 用法：node scripts/s6-supply-chain.ts [--lock <package-lock.json>] [--repo <repoRoot>] [--out <file>]
 * 省略 --out 时 SBOM 写 stdout；摘要一律走 stderr，不污染产物。
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** 固定错误类别：调用方（测试/CLI）按 code 判定，不解析消息文本 */
export class SbomError extends Error {
	code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

/** 锁条目中本脚本消费的字段；其余未知字段一律忽略（不因不认识而失败，也不改变语义） */
export interface LockPackage {
	key: string;
	name: string;
	version: string;
	/** 仅当锁里有 license 证据时存在 */
	license?: string | string[];
	dev: boolean;
	optional: boolean;
	hasInstallScript: boolean;
	/** 仅当 integrity 是 sha512-<base64> 形态时存在 */
	sha512Base64?: string;
}

export interface ParsedLock {
	lockfileVersion: number;
	rootName: string;
	rootVersion: string;
	entries: LockPackage[];
}

const NODE_MODULES_PREFIX = "node_modules/";
const SHA_PATTERN = /^[0-9a-f]{40,64}$/;

/** 从 packages 键推导包名：node_modules/<name> 或嵌套 node_modules/<pkg>/node_modules/<name> */
function nameOfKey(key: string): string {
	let rest = key.slice(NODE_MODULES_PREFIX.length);
	const nested = rest.lastIndexOf("/node_modules/");
	if (nested >= 0) rest = rest.slice(nested + "/node_modules/".length);
	return rest;
}

function parseEntry(key: string, raw: unknown): LockPackage {
	if (typeof raw !== "object" || raw === null) {
		throw new SbomError("entry_not_object", `packages["${key}"] 必须是 object`);
	}
	const rec = raw as Record<string, unknown>;
	if (!key.startsWith(NODE_MODULES_PREFIX) || key.length === NODE_MODULES_PREFIX.length) {
		throw new SbomError("entry_key_unsupported", `不支持的 packages 键形态（仅支持 node_modules/ 前缀；workspace 等其他形态固定拒）：${key}`);
	}
	const name = nameOfKey(key);
	// scoped 必须是 @scope/name 完整两段；unscoped 不得含 /（裸 @scope、a/b 等形态固定拒）
	const scopedOk = /^@[^/]+\/[^/]+$/.test(name);
	if (name.startsWith("@") ? !scopedOk : name.includes("/")) {
		throw new SbomError("entry_key_unsupported", `由键推导的包名形态非法（应为 name 或 @scope/name）：${key} → ${name}`);
	}
	const entryName = rec["name"];
	if (entryName !== undefined) {
		if (typeof entryName !== "string" || entryName !== name) {
			throw new SbomError("entry_name_mismatch", `键推导包名与条目 name 不一致：${key}（${name} vs ${String(entryName)}）`);
		}
	}
	const version = rec["version"];
	if (typeof version !== "string" || version.length === 0) {
		throw new SbomError("entry_version_missing", `锁条目缺少非空字符串 version：${key}`);
	}
	let license: string | string[] | undefined;
	const rawLicense = rec["license"];
	if (rawLicense !== undefined) {
		if (typeof rawLicense === "string" && rawLicense.length > 0) {
			license = rawLicense;
		} else if (Array.isArray(rawLicense) && rawLicense.length > 0 && rawLicense.every((x) => typeof x === "string")) {
			license = rawLicense as string[];
		} else {
			throw new SbomError("license_unsupported", `license 字段不是有效证据（期望非空 string/string[]）：${key}`);
		}
	}
	const comp: LockPackage = { key, name, version, dev: rec["dev"] === true, optional: rec["optional"] === true, hasInstallScript: rec["hasInstallScript"] === true };
	if (license !== undefined) comp.license = license;
	const rawIntegrity = rec["integrity"];
	if (rawIntegrity !== undefined) {
		if (typeof rawIntegrity !== "string") throw new SbomError("integrity_unsupported", `integrity 类型不受支持：${key}`);
		const m = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(rawIntegrity);
		if (!m) throw new SbomError("integrity_unsupported", `integrity 只支持 sha512-<base64> 形态（${key}）：${rawIntegrity}`);
		comp.sha512Base64 = m[1]!;
	}
	return comp;
}

/** 解析并校验 lockfile 原文；任何形状不符都抛固定类别 SbomError，不做静默降级 */
export function parseLock(raw: string): ParsedLock {
	let doc: unknown;
	try {
		doc = JSON.parse(raw);
	} catch (err) {
		throw new SbomError("lock_not_json", `lockfile 不是合法 JSON（${String(err)}）`);
	}
	if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
		throw new SbomError("lock_not_object", "lockfile 顶层必须是 JSON object");
	}
	const docRec = doc as Record<string, unknown>;
	const lockfileVersion = docRec["lockfileVersion"];
	if (lockfileVersion !== 2 && lockfileVersion !== 3) {
		throw new SbomError("lockfile_version_unsupported", `只支持 lockfileVersion 2/3（packages 布局），实际：${String(lockfileVersion)}`);
	}
	const packages = docRec["packages"];
	if (typeof packages !== "object" || packages === null || Array.isArray(packages)) {
		throw new SbomError("packages_missing", "lockfile 缺少 packages 映射");
	}
	const packagesRec = packages as Record<string, unknown>;
	const rootRaw = packagesRec[""];
	if (typeof rootRaw !== "object" || rootRaw === null) {
		throw new SbomError("root_entry_missing", 'lockfile packages 缺少根条目 ""');
	}
	const root = rootRaw as Record<string, unknown>;
	const rootName = root["name"];
	const rootVersion = root["version"];
	if (typeof rootName !== "string" || rootName.length === 0 || typeof rootVersion !== "string" || rootVersion.length === 0) {
		throw new SbomError("root_entry_invalid", '根条目 "" 缺少非空字符串 name/version');
	}
	const entries: LockPackage[] = [];
	for (const key of Object.keys(packagesRec)) {
		if (key === "") continue;
		entries.push(parseEntry(key, packagesRec[key]));
	}
	return { lockfileVersion, rootName, rootVersion, entries };
}

/** pkg:npm purl：npm 名全小写；scope 前缀 @ 编码为 %40，namespace/name 用 / 分隔；version 百分号编码 */
export function toPurl(name: string, version: string): string {
	return `pkg:npm/${name.toLowerCase().replace("@", "%40")}@${encodeURIComponent(version)}`;
}

/** license 证据 → CycloneDX licenses：一律 name 保留锁原文，不冒充 SPDX id（评审结论：UNLICENSED 等单 token 非标准 id） */
function licenseChoice(license: string | string[]): { license: { name: string } }[] {
	const list = Array.isArray(license) ? license : [license];
	return list.map((x) => ({ license: { name: x } }));
}

type BomProperty = { name: string; value: string };

function componentOf(e: LockPackage, purl: string): Record<string, unknown> {
	const comp: Record<string, unknown> = { type: "library", "bom-ref": purl, name: e.name, version: e.version, purl };
	if (e.optional) comp["scope"] = "optional";
	if (e.license !== undefined) comp["licenses"] = licenseChoice(e.license);
	if (e.sha512Base64 !== undefined) {
		const hex = Buffer.from(e.sha512Base64, "base64").toString("hex");
		if (hex.length !== 128) throw new SbomError("integrity_invalid", `sha512 base64 解码后不是 64 字节：${e.key}`);
		comp["hashes"] = [{ alg: "SHA-512", content: hex }];
	}
	const props: BomProperty[] = [];
	if (e.dev) props.push({ name: "s6:lock:dev", value: "true" });
	if (e.hasInstallScript) props.push({ name: "s6:lock:hasInstallScript", value: "true" });
	if (props.length > 0) comp["properties"] = props;
	return comp;
}

export interface BomOptions {
	/** 锁文件来源（路径或标识），仅作证据标注记入 metadata */
	lockSource: string;
	/** 仓库 revision；取不到时由调用方传 "unknown"，本函数不虚构成具体值 */
	repoRevision: string;
	/** 生成时间；缺省 now（测试注入固定值） */
	now?: Date;
}

/** 由已解析的锁构建 CycloneDX 1.6 BOM 对象（未序列化） */
export function buildBom(parsed: ParsedLock, opts: BomOptions): Record<string, unknown> {
	// npm 允许同名同版本包在嵌套 node_modules 多次出现（同一 purl 多个安装位）；
	// CycloneDX bom-ref 必须唯一，故按 purl 合并为一个 component，其余安装位记入属性。
	const byPurl = new Map<string, Record<string, unknown>>();
	for (const e of parsed.entries) {
		const purl = toPurl(e.name, e.version);
		const existing = byPurl.get(purl);
		if (existing !== undefined) {
			const props = (existing["properties"] as BomProperty[] | undefined) ?? [];
			props.push({ name: "s6:lock:alsoAt", value: e.key });
			existing["properties"] = props;
			continue;
		}
		byPurl.set(purl, componentOf(e, purl));
	}
	const components = [...byPurl.values()].sort((a, b) => {
		const ra = String(a["bom-ref"]);
		const rb = String(b["bom-ref"]);
		return ra < rb ? -1 : ra > rb ? 1 : 0;
	});
	return {
		bomFormat: "CycloneDX",
		specVersion: "1.6",
		serialNumber: `urn:uuid:${randomUUID()}`,
		version: 1,
		metadata: {
			timestamp: (opts.now ?? new Date()).toISOString(),
			tools: { components: [{ type: "application", name: "s6-supply-chain", version: "1.0.0" }] },
			component: { type: "application", "bom-ref": `${parsed.rootName}@${parsed.rootVersion}`, name: parsed.rootName, version: parsed.rootVersion },
			properties: [
				{ name: "s6:lock:sourceFile", value: opts.lockSource },
				{ name: "s6:lock:lockfileVersion", value: String(parsed.lockfileVersion) },
				{ name: "s6:lock:entryCount", value: String(parsed.entries.length) },
				{ name: "s6:lock:componentCount", value: String(byPurl.size) },
				{ name: "s6:repo:revision", value: opts.repoRevision },
				{ name: "s6:coverage:vendor", value: "not-covered" },
				{ name: "s6:coverage:containerImage", value: "not-covered" },
				{ name: "s6:coverage:vulnerabilityScan", value: "not-performed; see docs/operations/s6-runbook.md" },
			],
		},
		components,
	};
}

/**
 * 仓库 revision（离线，读 .git 元数据文件，不调用 git 命令）：
 * HEAD 直连 sha → 用之；"ref: ..." → 先读 refs 文件，再查 packed-refs；取不到 → "unknown"。
 */
export function readGitRevision(repoRoot: string): string {
	try {
		const gitDir = join(resolve(repoRoot), ".git");
		const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
		if (SHA_PATTERN.test(head)) return head;
		if (head.startsWith("ref: ")) {
			const ref = head.slice("ref: ".length).trim();
			if (ref.length > 0 && !ref.includes("..")) {
				try {
					const sha = readFileSync(join(gitDir, ref), "utf8").trim();
					if (SHA_PATTERN.test(sha)) return sha;
				} catch { /* 松散 ref 不存在 → 查 packed-refs */ }
				for (const line of readFileSync(join(gitDir, "packed-refs"), "utf8").split("\n")) {
					const trimmed = line.trim();
					if (trimmed.startsWith("#") || trimmed.startsWith("^")) continue;
					const sep = trimmed.indexOf(" ");
					if (sep <= 0) continue;
					if (trimmed.slice(sep + 1) === ref && SHA_PATTERN.test(trimmed.slice(0, sep))) return trimmed.slice(0, sep);
				}
			}
		}
	} catch { /* 无 .git 或不可读：revision unknown，不虚构 */ }
	return "unknown";
}

/** BOM 序列化：tab 缩进（与仓库风格一致）+ 尾换行，输出确定性（除 serialNumber/timestamp 外逐字节稳定） */
export function serializeBom(bom: Record<string, unknown>): string {
	return `${JSON.stringify(bom, null, "\t")}\n`;
}

/** CLI 入口；返回退出码（不直接 process.exit，沿用本仓 bounded runner 纪律） */
export function main(argv: string[]): number {
	try {
		let lockPath: string | undefined;
		let repoPath: string | undefined;
		let outPath: string | undefined;
		for (let i = 0; i < argv.length; i++) {
			const arg = argv[i]!;
			const value = argv[i + 1];
			if (value === undefined) throw new SbomError("usage", `参数 ${arg} 缺少值。用法：node scripts/s6-supply-chain.ts [--lock <package-lock.json>] [--repo <repoRoot>] [--out <file>]`);
			if (arg === "--lock") { lockPath = value; i++; }
			else if (arg === "--repo") { repoPath = value; i++; }
			else if (arg === "--out") { outPath = value; i++; }
			else throw new SbomError("usage", `未知参数：${arg}。用法：node scripts/s6-supply-chain.ts [--lock <package-lock.json>] [--repo <repoRoot>] [--out <file>]`);
		}
		const repo = resolve(repoPath ?? join(import.meta.dirname, ".."));
		const lockFile = resolve(lockPath ?? join(repo, "package-lock.json"));
		let raw: string;
		try {
			raw = readFileSync(lockFile, "utf8");
		} catch (err) {
			throw new SbomError("lock_unreadable", `lockfile 不可读：${lockFile}（${String(err)}）`);
		}
		const parsed = parseLock(raw);
		const bom = buildBom(parsed, { lockSource: lockFile, repoRevision: readGitRevision(repo) });
		const text = serializeBom(bom);
		if (outPath !== undefined) {
			writeFileSync(outPath, text);
			const components = (bom["components"] as unknown[]).length;
			console.error(`s6-supply-chain: lock=${lockFile} entries=${parsed.entries.length} components=${components} -> ${outPath}`);
		} else {
			process.stdout.write(text);
		}
		return 0;
	} catch (err) {
		if (err instanceof SbomError) console.error(`s6-supply-chain: ${err.code}: ${err.message}`);
		else console.error(`s6-supply-chain: unexpected_error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
		return 1;
	}
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
	process.exitCode = main(process.argv.slice(2));
}
