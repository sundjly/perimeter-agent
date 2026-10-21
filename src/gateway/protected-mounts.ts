/**
 * S2 Phase B：受保护路径的内核级只读挂载（deny_paths → 确定性子路径 → RO bind）。
 *
 * 背景：deny_paths 对带 path 的工具按词法生效，bash/python 看不见路径。
 * Phase B 把策略清单里「可映射为 workspace 内确定子路径」的条目在容器启动时
 * 以只读 bind 挂到容器里，使 bash 写这些路径（新建/覆盖/rm/mv/chmod）被内核
 * 拒绝（EROFS）。这是 OS 边界，与词法策略互为纵深，不替代它。
 *
 * 映射规则（对每条 deny_paths glob；为免提前闭合本块注释，示例里的 "**\/" 带反斜杠转义）：
 * - "**\/P/**"（P 无通配符）→ 目录 P：前导 "**\/" 可匹配零层（见 policy/glob.ts 语义），
 *   因此保护「根部 P」即覆盖词法策略命中的根部写入面。
 * - "**\/P"（P 无通配符）→ 文件 P。
 * - 不带 "**\/" 前缀的无通配符 glob 同样按其字面路径映射。
 * - 余下形状（`Dockerfile.*`、`*.tf`、`.env.*` 等含通配符段）**无法映射为确定
 *   子路径**，如实列入 uncovered，不假装覆盖；任意深度的同名嵌套路径同样不在
 *   挂载面内（只能靠词法策略），残余如实声明。
 *
 * 安全约束：
 * - 挂载参数只由服务端从 policy 派生，不接受任何客户端输入。
 * - 目标必须规范化：拒绝 `..`、绝对路径、NUL、空路径；禁止 RO 挂载 workspace
 *   根本身与 `.git` 整体（后者会破坏 git 的 index/objects 可写要求）。
 * - 祖先目录已挂载时子孙条目去重（祖先 RO 已覆盖）。
 *
 * 流形门控（关键事实，来自 gateway/session.ts 的启动顺序）：
 * - 会话内 clone（repoUrl 配置）发生在容器启动**之后**，而 `git clone` 要求
 *   目标目录为空 —— 因此 clone 型会话在启动时**整体跳过** stub 预创建与受保护
 *   挂载（任何预置都会让 clone 失败），这是结构性限制，列为已知残余。
 * - `.git/config` / `.git/hooks` 只在 `.git` 已存在（平台预克隆/预置仓库）时
 *   挂载；`.git` 不存在时不能预置（理由同上），此时 hooks/config 的 FS 面是
 *   已知残余，词法策略仍拦 path 工具。
 * - `.git/hooks` 在 `.git` 缺席流形下的绕道：容器注入空的只读 GIT_TEMPLATE_DIR
 *   （见 execution-backend），使容器内 `git init/clone` 不向 .git/hooks 拷贝
 *   模板，预创建的空 RO hooks 目录因此不破坏 init 流程。
 */
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

/** 容器内空的只读 git 模板目录（tmpfs ro 挂载，见 execution-backend.launch）。
 * 刻意不放 /opt/perimeter 下：那是网关代码挂载命名空间，durable 容器的
 * 「不挂 /opt/perimeter」断言要保持钝而可靠 */
export const GIT_TEMPLATE_DIR = "/var/perimeter/git-templates";

export interface ProtectedTarget {
	/** workspace 相对路径（POSIX，已规范化，不含前导 ./） */
	rel: string;
	/** glob 以 /** 结尾 → 明确是目录；否则按文件对待（存在时以实际类型挂载） */
	explicitDir: boolean;
}

export interface UncoveredEntry {
	glob: string;
	/** 固定类别原因（不含宿主路径与文件内容） */
	reason: string;
}

interface Derived {
	targets: ProtectedTarget[];
	uncovered: UncoveredEntry[];
}

const UNCOVERED_WILDCARD = "通配符段无法映射为 workspace 内确定子路径";
const UNCOVERED_TRAVERSAL = "含遍历段（..），拒绝映射";
const UNCOVERED_FORBIDDEN = "目标为 workspace 根或 .git 本身，禁止挂载";

/** 禁止作为 RO 挂载目标的路径（workspace 根会锁死全仓；.git 整体会锁死 index/objects） */
const FORBIDDEN_RELS = new Set(["", ".", ".git"]);

/** 判定一个 glob 是否为无通配符的固定路径形状 */
function hasWildcard(s: string): boolean {
	return /[*?[\]{}\\]/.test(s);
}

function validateSegments(rel: string): "ok" | "traversal" | "forbidden" {
	if (FORBIDDEN_RELS.has(rel)) return "forbidden";
	for (const seg of rel.split("/")) {
		if (seg === "..") return "traversal";
		if (seg === "" || seg === ".") return "forbidden";
		if (seg.includes("\u0000")) return "forbidden";
	}
	return "ok";
}

/**
 * 从 policy 文本推导可挂载的受保护目标。
 *
 * 只读 deny_paths；require_approval_paths / deny_reads 不产生挂载（前者要的是
 * 审批不是拒绝，后者是读面，RO 挂载不拦读）。策略形状非法时抛错 —— 调用方
 * （DockerBackend.launch）以此 fail-closed 拒绝会话启动。
 */
export function deriveProtectedTargets(policyText: string): Derived {
	const doc = (parseYaml(policyText) ?? {}) as Record<string, unknown>;
	const rawRules = doc.rules ?? [];
	if (!Array.isArray(rawRules)) throw new Error("policy: rules 必须是数组");

	const byRel = new Map<string, ProtectedTarget>();
	const uncovered: UncoveredEntry[] = [];
	for (const [ri, r] of rawRules.entries()) {
		if (typeof r !== "object" || r === null) throw new Error(`policy: rules[${ri}] 必须是对象`);
		const raw = (r as Record<string, unknown>).deny_paths;
		if (raw === undefined || raw === null) continue;
		if (!Array.isArray(raw)) throw new Error(`policy: rules[${ri}].deny_paths 必须是数组`);
		for (const [gi, g] of raw.entries()) {
			if (typeof g !== "string" || g.length === 0) {
				throw new Error(`policy: rules[${ri}].deny_paths[${gi}] 必须是非空字符串`);
			}
			// 折叠连续 `**/`（与 pathGlobToRegex 同语义）：`**/**/P` ≡ `**/P`
			const glob = g.replace(/(?:\*\*\/)+/g, "**/");
			const rest = glob.startsWith("**/") ? glob.slice(3) : glob;
			if (rest.length === 0 || rest === "**") {
				// `**/` 是空路径；`**` 整体等于 workspace 根，都在禁止挂载之列
				uncovered.push({ glob: g, reason: UNCOVERED_FORBIDDEN });
				continue;
			}
			// 先识别并剥离结尾 "/**"（目录条目哨兵），再对剥离后的 rel 查通配符：
			// ".github/workflows/**" 的星在结尾哨兵里，不代表 rel 本身含通配符
			const explicitDir = rest.endsWith("/**");
			const rel = explicitDir ? rest.slice(0, -3) : rest;
			if (hasWildcard(rel)) {
				// "Dockerfile.*"、".env.*"、"a/**/b"（中间通配）等无法映射为确定子路径
				uncovered.push({ glob: g, reason: UNCOVERED_WILDCARD });
				continue;
			}
			// 规范化：折叠 `//` 与 `./` 段后再校验（与 normalizePath 同方向；这里输入
			// 已无通配符，残余的 `.` 段只是书写噪声）
			const normalized = rel.split("/").filter((s) => s !== "" && s !== ".").join("/");
			const verdict = validateSegments(normalized);
			if (verdict === "traversal") {
				uncovered.push({ glob: g, reason: UNCOVERED_TRAVERSAL });
				continue;
			}
			if (verdict === "forbidden") {
				uncovered.push({ glob: g, reason: UNCOVERED_FORBIDDEN });
				continue;
			}
			const prev = byRel.get(normalized);
			// 同路径 file/dir 冲突时 dir 胜（目录 RO 覆盖面更大）
			byRel.set(normalized, { rel: normalized, explicitDir: (prev?.explicitDir ?? false) || explicitDir });
		}
	}

	// 祖先已挂载时去重：祖先 RO bind 已覆盖子孙的写入面
	const targets = [...byRel.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	const covered = new Set<string>();
	for (const t of targets) {
		const segs = t.rel.split("/");
		for (let i = 1; i < segs.length; i++) {
			if (byRel.has(segs.slice(0, i).join("/"))) {
				covered.add(t.rel);
				break;
			}
		}
	}
	return { targets: targets.filter((t) => !covered.has(t.rel)), uncovered };
}

export interface PlannedMount {
	rel: string;
	kind: "dir" | "file";
	/** 宿主侧来源路径（不存在时已按类型补 stub，绝不改写已有内容） */
	hostSource: string;
	/** 容器内挂载点 */
	containerTarget: string;
}

export interface ApplyResult {
	mounts: PlannedMount[];
	skipped: { rel: string; reason: string }[];
}

const SENSITIVE_DIRS = new Set([".ssh", ".aws", "secrets"]);

/**
 * 在宿主侧补齐 stub 并产出 RO bind 挂载清单。
 *
 * - 目录不存在 → 宿主侧创建空目录（敏感目录 0700，其余 0755）；
 *   文件不存在 → 创建空文件（0644）。**已存在的路径一律原样挂载、绝不改写**
 *   —— 保护的是「不被写」，不是「内容是什么」。
 * - `.git/*` 条目要求 `.git` 已存在（预置仓库流形）；不存在时跳过并给固定
 *   类别原因（clone 需空目录，见模块头注释）。
 * - 符号链接目标一律跳过：不把宿主侧任意位置经链接挂进容器。
 * - workspace 本身缺失 → 全部跳过（纯函数测试用的假路径不该被 mkdir 出来）。
 */
export function applyProtectedMounts(workspace: string, targets: ProtectedTarget[], containerRoot = "/workspace"): ApplyResult {
	const mounts: PlannedMount[] = [];
	const skipped: { rel: string; reason: string }[] = [];
	let wsStat;
	try {
		wsStat = lstatSync(workspace);
	} catch {
		for (const t of targets) skipped.push({ rel: t.rel, reason: "workspace 不存在，跳过（不产生副作用）" });
		return { mounts, skipped };
	}
	if (!wsStat.isDirectory() || wsStat.isSymbolicLink()) {
		for (const t of targets) skipped.push({ rel: t.rel, reason: "workspace 非常规目录，跳过" });
		return { mounts, skipped };
	}

	// `.git` 流形判定：一次判定，全体 .git/* 条目共用
	let gitReady: "ready" | "absent" | "unsafe";
	try {
		const st = lstatSync(join(workspace, ".git"));
		gitReady = st.isDirectory() && !st.isSymbolicLink() ? "ready" : "unsafe";
	} catch {
		gitReady = "absent";
	}

	for (const t of targets) {
		const hostSource = resolve(workspace, t.rel);
		// 双保险：resolve 后必须仍在 workspace 之下（不含假前缀）
		if (hostSource !== workspace && !hostSource.startsWith(workspace + sep)) {
			skipped.push({ rel: t.rel, reason: "包含性校验失败（逃出 workspace）" });
			continue;
		}
		if (t.rel === ".git" || t.rel.startsWith(".git/")) {
			if (gitReady !== "ready") {
				skipped.push({
					rel: t.rel,
					reason: gitReady === "absent"
						? "clone/init 流形：.git 尚不存在，不能预置（git clone 需空目录）——FS 面已知残余，词法策略仍生效"
						: ".git 形状异常（非目录或符号链接），跳过",
				});
				continue;
			}
		}
		let st;
		try {
			st = lstatSync(hostSource);
		} catch {
			st = undefined;
		}
		if (st?.isSymbolicLink()) {
			skipped.push({ rel: t.rel, reason: "目标为符号链接，拒绝挂载" });
			continue;
		}
		if (!st) {
			// stub 预创建：只补缺失，绝不改写已有内容
			try {
				if (t.explicitDir) {
					mkdirSync(hostSource, { recursive: true, mode: 0o755 });
					chmodSync(hostSource, SENSITIVE_DIRS.has(t.rel) ? 0o700 : 0o755);
				} else {
					mkdirSync(join(hostSource, ".."), { recursive: true });
					writeFileSync(hostSource, "", { flag: "wx", mode: 0o644 });
					chmodSync(hostSource, 0o644);
				}
			} catch {
				skipped.push({ rel: t.rel, reason: "stub 预创建失败" });
				continue;
			}
		}
		let isDir: boolean;
		try {
			isDir = lstatSync(hostSource).isDirectory();
		} catch {
			skipped.push({ rel: t.rel, reason: "目标状态不可读，跳过" });
			continue;
		}
		mounts.push({
			rel: t.rel,
			kind: isDir ? "dir" : "file",
			hostSource,
			containerTarget: `${containerRoot}/${t.rel}`,
		});
	}
	// argv 确定性：按容器内挂载点排序
	mounts.sort((a, b) => (a.containerTarget < b.containerTarget ? -1 : a.containerTarget > b.containerTarget ? 1 : 0));
	return { mounts, skipped };
}
