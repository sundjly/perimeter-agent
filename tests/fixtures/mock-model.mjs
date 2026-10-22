/**
 * OpenAI 兼容的 mock 模型端点，按脚本返回工具调用。
 *
 * 存在的理由有两个，都不是「为了测试方便」：
 * 1. tool_call 钩子只能由真实的模型工具调用触发，而验证「0 例绕过审批门」
 *    是 Phase 1 的验收标准之一 —— 没有它这条标准无法回归。
 * 2. 策略文档要求 demo 有「演示环境挂掉时的保险」。整条链路能在零凭据、
 *    零外网的机器上跑通，本身就是那份保险。
 *
 * 用法：node mock-model.mjs <port> <scriptJson>
 * script 形如 [{ "tool": "bash", "args": {...} }, { "text": "done" }]，
 * 第 N 次请求返回第 N 条。scriptJson 以 @ 开头时改为从该路径读 JSON 文件
 * （大脚本经 argv 会撞 E2BIG，S5a 长历史测试用；不以 @ 开头时行为不变）。
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 0);
const scriptArg = process.argv[3] ?? "[]";
const script = JSON.parse(scriptArg.startsWith("@") ? readFileSync(scriptArg.slice(1), "utf8") : scriptArg);
let turn = 0;

function sse(res, obj) {
	res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const server = createServer((req, res) => {
	if (!req.url?.includes("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	req.on("data", (c) => {
		body += c;
	});
	req.on("end", async () => {
		if (process.argv[4]) appendFileSync(process.argv[4], JSON.stringify({ body: JSON.parse(body), sessionId: req.headers.session_id }) + "\n");
		const step = script[turn] ?? { text: "no more script" };
		turn += 1;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });

		if (step.tool) {
			sse(res, {
				id: `chatcmpl-${turn}`,
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: "mock-model",
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: `call_${turn}`,
									type: "function",
									function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) },
								},
							],
						},
						finish_reason: null,
					},
				],
			});
			sse(res, {
				id: `chatcmpl-${turn}`,
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: "mock-model",
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
				usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
			});
		} else {
			for (const chunk of step.chunks ?? [step.text ?? ""]) {
			sse(res, {
				id: `chatcmpl-${turn}`,
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: "mock-model",
				choices: [{ index: 0, delta: { role: "assistant", content: chunk }, finish_reason: null }],
			});
			if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
			}
			sse(res, {
				id: `chatcmpl-${turn}`,
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: "mock-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
			});
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

server.listen(port, "127.0.0.1", () => {
	// 端口交给父进程，避免固定端口在 CI 上冲突
	process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});
