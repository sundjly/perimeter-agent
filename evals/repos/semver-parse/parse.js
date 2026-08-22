/** 解析 "1.2.3" / "1.2.3-beta.1"；非法输入返回 null */
export function parse(input) {
	const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(input);
	if (!m) return null;
	const [, major, minor, patch, pre] = m;
	return { major: +major, minor: +minor, patch: +patch, prerelease: pre ?? null };
}

/** a 比 b 新则 > 0。预发布版本排在同版号正式版之前 */
export function compare(a, b) {
	for (const k of ["major", "minor", "patch"]) {
		if (a[k] !== b[k]) return a[k] - b[k];
	}
	if (a.prerelease === b.prerelease) return 0;
	if (a.prerelease === null) return 1;
	if (b.prerelease === null) return -1;
	return a.prerelease < b.prerelease ? -1 : 1;
}
