/**
 * 路径与命令的通配匹配 —— 自己实现（约 60 行），不引 path-browserify 或 glob 依赖。
 *
 * 两种语义刻意分开：路径里的 `*` 不跨 `/`，命令里的 `*` 跨一切。
 */

// `?` 必须在列内：命令模式里的 `?` 是字面量（如 URL 的 query），
// 漏转义会让 `x?y` 变成「y 可选」从而漏匹配，且 `?foo` 会让正则构造直接抛错。
const SPECIAL = /[.+^${}()|[\]\\?*]/g;

function escapeLiteral(s: string): string {
	return s.replace(SPECIAL, "\\$&");
}

/**
 * 路径通配：`*` 不跨路径分隔符，`**` 跨任意层级，`?` 匹配单个非分隔符字符。
 * `**​/` 允许匹配零层目录，因此 `**​/Dockerfile` 能命中根部的 Dockerfile。
 *
 * 大小写不敏感：本产品的沙箱是 Linux（大小写敏感），但开发者本机常是 macOS
 * 的大小写不敏感 FS，那里 `.GitHub/workflows/x.yml` 与 `.github/...` 是同一个
 * 文件。按不敏感匹配在 Linux 上只会多拒不会少拒，方向安全。
 */
export function pathGlobToRegex(pattern: string): RegExp {
	// 折叠连续的 `**/`：`**/**/x` 与 `**/x` 语义相同，但展开成相邻的两个
	// 「零或多段」量词就产生了嵌套歧义，匹配失败时会指数级回溯。
	// 策略文件是客户可编辑的，一条 `**/a/**/b/**/c` 足以把 beforeToolCall
	// 钩子静默挂死 —— 而钩子挂死是 try/catch 覆盖不到的一类失败。
	const glob = pattern.replace(/(?:\*\*\/)+/g, "**/");
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === "*") {
			if (glob[i + 1] === "*") {
				// `**/` 与 `/**` 都要能匹配零层。
				// 用 `(?:[^/]*/)*` 而不是 `(?:.*/)?`：后者在多个 `**` 叠加时
				// 存在嵌套歧义，会导致指数级回溯 —— 策略文件是客户可编辑的，
				// 一条 `**/a/**/b/**/c` 就能把 beforeToolCall 钩子静默挂死。
				if (glob[i + 2] === "/") {
					re += "(?:[^/]*/)*";
					i += 2;
				} else if (re.endsWith("/")) {
					re = `${re.slice(0, -1)}(?:/[^/]*)*`;
					i += 1;
				} else {
					re += "[^/]*(?:/[^/]*)*";
					i += 1;
				}
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += escapeLiteral(c);
		}
	}
	return new RegExp(`^${re}$`, "i");
}

/** 命令通配：`*` 匹配任意字符（含空格），用于 `git push*` / `curl * | *sh` 这类模式 */
export function commandGlobToRegex(glob: string): RegExp {
	const re = glob
		.split("*")
		.map(escapeLiteral)
		.join(".*");
	return new RegExp(`^${re}$`);
}

/**
 * 路径归一化：解析 `.` 与 `..`，统一分隔符，剥掉前导 `./`。
 * 不做这一步的话 `./x/../.github/workflows/ci.yml` 能绕过 deny_paths。
 */
export function normalizePath(p: string): string {
	const isAbsolute = p.startsWith("/");
	const out: string[] = [];
	for (const seg of p.replace(/\\/g, "/").split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			// 越过根部的 `..` 保留下来，让调用方能看出这是逃逸尝试
			if (out.length > 0 && out.at(-1) !== "..") out.pop();
			else if (!isAbsolute) out.push("..");
		} else {
			out.push(seg);
		}
	}
	return (isAbsolute ? "/" : "") + out.join("/");
}
