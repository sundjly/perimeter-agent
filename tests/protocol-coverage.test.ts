import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CLIENT_EVENT_TYPES } from "../src/protocol/types.ts";

/**
 * 协议与前端的覆盖差集。
 *
 * `web/` 不在 tsconfig 的 include 里（它是零构建的原生 JS），所以类型系统
 * 完全帮不上忙：`reduce()` 是手写 switch 且**没有 default 分支**。
 * 往 ClientEvent 加一个事件而忘了前端，表现是浏览器静默丢弃 ——
 * 界面少一块东西，没有任何报错，排查时先怀疑的是网关。
 *
 * 协议侧不再从源码正则提取：`CLIENT_EVENT_TYPES` 由编译期的双向穷尽性
 * 检查保证与 ClientEvent 同步。正则会漏掉不合其字符集的命名
 * （`quota_warning`、`toolV2.start`），而那种漏检是静默的 ——
 * 我第一版正好踩了这个坑，负面验证用的事件名恰好落在正则内，给了假信心。
 *
 * 前端侧仍需文本解析（原生 JS 没有可 import 的清单），但范围收敛到
 * `reduce()` 函数体内，避免把别处无关的 case 算成已覆盖。
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** 明确不需要前端处理的事件，每条都要写明理由 */
const EXEMPT: Record<string, string> = {
	// S3b：显式创建的定向应答帧，只发回发起连接（不广播、不带 seq），CLI/API 消费；
	// 网页 UI 不切换会话，无需进共享状态
	"session.created": "定向应答：创建方连接自行消费，UI 不切换会话",
};

/** 只取 reduce() 函数体内的 case —— 别处的 switch 不算前端对协议的处理 */
function handledInRender(): string[] {
	const app = readFileSync(join(REPO, "web/view-model.js"), "utf8");
	const start = app.indexOf("function reduce(");
	assert.ok(start >= 0, "web/app.js 里找不到 reduce()，解析假设已失效");
	// 从函数起点做花括号配对，取出函数体
	const open = app.indexOf("{", start);
	let depth = 0;
	let end = -1;
	for (let i = open; i < app.length; i++) {
		if (app[i] === "{") depth++;
		else if (app[i] === "}" && --depth === 0) {
			end = i;
			break;
		}
	}
	assert.ok(end > open, "reduce() 的花括号没配平");
	return [...app.slice(open, end).matchAll(/case "([^"]+)"/g)].map((m) => m[1]!);
}

test("解析假设成立 —— 否则下面几条会静默通过", () => {
	// 协议侧数量由编译期保证，这里钉住它别在重构中被削掉
	assert.equal(CLIENT_EVENT_TYPES.length, 23, "事件数变了：确认是有意增删，再改这个数字");
	assert.ok(handledInRender().length >= 15, `reduce() 里只解析到 ${handledInRender().length} 个 case`);
});

test("每个 ClientEvent 要么被前端处理，要么在豁免清单里", () => {
	const handled = handledInRender();
	const missing = CLIENT_EVENT_TYPES.filter((t) => !handled.includes(t) && !(t in EXEMPT));
	assert.deepEqual(missing, [], `这些事件前端不处理且未登记豁免，会被静默丢弃：${missing.join(", ")}`);
});

test("豁免清单不能过期，理由不能敷衍", () => {
	const handled = handledInRender();
	const stale = Object.keys(EXEMPT).filter((t) => handled.includes(t));
	assert.deepEqual(stale, [], `这些事件前端已经处理了，豁免登记应当删掉：${stale.join(", ")}`);

	const bogus = Object.keys(EXEMPT).filter((t) => !(CLIENT_EVENT_TYPES as readonly string[]).includes(t));
	assert.deepEqual(bogus, [], `协议里没有这些事件：${bogus.join(", ")}`);

	// 强制执行落在 code review 上，所以理由必须写得让 reviewer 能判断
	for (const [type, reason] of Object.entries(EXEMPT)) {
		assert.ok(reason.length > 10, `${type} 的豁免理由太短，写清楚为什么可以不处理`);
	}
});

test("reduce() 不该处理协议里不存在的事件", () => {
	const types = CLIENT_EVENT_TYPES as readonly string[];
	const unknown = handledInRender().filter((h) => !types.includes(h));
	assert.deepEqual(unknown, [], `前端在处理协议里没有的事件（多半是改名后的残留）：${unknown.join(", ")}`);
});
