import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

/**
 * 策略配置与 pi 工具集的对齐。
 *
 * `read_only_tools` 决定了一件要紧的事：**不在名单里的工具，只要带 path
 * 参数就受 deny_paths 约束**。这个方向是 fail-closed 的（pi 新增编辑类工具
 * 会自动被覆盖），但反过来 —— 一旦有人把 `write` 或 `edit` 写进名单，
 * 整份 CI/IaC/secrets 的路径防线对它就**静默失效**。
 *
 * 因此安全断言必须在**每台机器**上跑，不能依赖本地有没有 pi 源码：
 * 工具清单固化在 `tests/fixtures/pi-tools.json` 里，日常断言比对它；
 * 有 pi 源码时才额外校验 fixture 有没有过期。
 * 第一版把安全断言关在了 skip 块里 —— CI 上一条都不执行，等于没有。
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
/** 可用 PERIMETER_PI_SRC 覆盖，方便别人在自己的 checkout 上跑 */
const PI_SRC =
	process.env.PERIMETER_PI_SRC ?? "/Users/sundy/projects/pi-mono/packages/coding-agent/src/core/tools/index.ts";

interface PiTools {
	piVersion: string;
	allTools: string[];
	readOnlyTools: string[];
}

const fixture: PiTools = JSON.parse(readFileSync(join(REPO, "tests/fixtures/pi-tools.json"), "utf8"));

function readOnlyInPolicy(): string[] {
	const doc = parseYaml(readFileSync(join(REPO, "config/policy.yaml"), "utf8")) as { read_only_tools?: string[] };
	return doc.read_only_tools ?? [];
}

// ── 安全断言：不依赖 pi 源码，每台机器都跑 ──────────────────

test("会改文件的工具绝不能出现在 read_only_tools 里", () => {
	// 这是本文件的核心：write/edit 一旦被豁免，整份 deny_paths
	// （CI 配置、IaC、secrets、.git/config）对它就静默失效。
	// bash 也列在这里做纵深防御，但它的失效路径不同 —— bash 不带 path
	// 参数，deny_paths 对它本来就不生效（见 engine.ts 的类注释）。
	const mutating = fixture.allTools.filter((t) => !fixture.readOnlyTools.includes(t));
	const leaked = mutating.filter((t) => readOnlyInPolicy().includes(t));
	assert.deepEqual(leaked, [], `这些工具会改文件，却被当成只读豁免了路径规则：${leaked.join(", ")}`);
});

test("pi 的只读工具都在名单里 —— 漏一个就会让 agent 读文件也要审批", () => {
	// 审批疲劳本身就是安全失效：每次读 package.json 都弹一次，
	// 几轮之后操作员就无脑点同意了
	const missing = fixture.readOnlyTools.filter((t) => !readOnlyInPolicy().includes(t));
	assert.deepEqual(missing, [], `这些只读工具不在名单里，会触发不必要的审批：${missing.join(", ")}`);
});

test("read_only_tools 里不该有 pi 根本没有的工具", () => {
	// 不是安全问题，但会让人以为覆盖了它。曾经写过 glob、tree、image，
	// 而 pi 一个都没有（image.ts 是 read 工具用的 MIME 嗅探辅助，不是工具）
	const ghosts = readOnlyInPolicy().filter((t) => !fixture.allTools.includes(t));
	assert.deepEqual(ghosts, [], `pi 没有这些工具，名单是死配置：${ghosts.join(", ")}`);
});

// ── fixture 是否过期：需要本地 pi 源码 ──────────────────────

describe("fixture 与 pi 源码对齐（需要本地 pi-mono）", { skip: existsSync(PI_SRC) ? false : `找不到 ${PI_SRC}` }, () => {
	function parsePiSource(): { all: string[]; readOnly: string[] } {
		const src = readFileSync(PI_SRC, "utf8");
		// 权威单点：一处声明胜过扫 7 个工具文件，改成常量引用也不会静默漏掉
		const allMatch = /allToolNames: Set<ToolName> = new Set\(\[([^\]]+)\]\)/.exec(src);
		assert.ok(allMatch, "pi 源码里找不到 allToolNames，工具装配方式变了 —— 这正是该报警的时刻");
		const roMatch = /createReadOnlyToolDefinitions[\s\S]*?return \[([\s\S]*?)\];/.exec(src);
		assert.ok(roMatch, "pi 源码里找不到 createReadOnlyToolDefinitions");
		return {
			all: [...allMatch[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!).sort(),
			readOnly: [...roMatch[1]!.matchAll(/create(\w+?)ToolDefinition/g)].map((m) => m[1]!.toLowerCase()).sort(),
		};
	}

	test("fixture 没有过期", () => {
		const pi = parsePiSource();
		assert.deepEqual(fixture.allTools, pi.all, "pi 的工具集变了，请重新生成 tests/fixtures/pi-tools.json");
		assert.deepEqual(fixture.readOnlyTools, pi.readOnly, "pi 的只读工具集变了，请重新生成 fixture");
	});

	test("解析假设成立 —— 否则上一条是空转", () => {
		const pi = parsePiSource();
		assert.ok(pi.all.length >= 5, `只解析到 ${pi.all.length} 个工具名`);
		assert.ok(pi.all.includes("bash") && pi.all.includes("write"), `解析结果缺核心工具：${pi.all.join(", ")}`);
		assert.ok(pi.readOnly.length > 0 && pi.readOnly.every((t) => pi.all.includes(t)));
	});
});
