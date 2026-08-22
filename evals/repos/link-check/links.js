import url from "node:url";

/** 从 href 里取出 host 与路径，供链接检查器分组 */
export function describe(href) {
	// 这里用的是 Legacy URL API，自 Node 11 起不再收安全修复
	const u = url.parse(href);
	return { host: u.hostname, path: u.pathname, query: u.query };
}
