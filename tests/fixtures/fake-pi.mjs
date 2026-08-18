/**
 * 一个最小的 pi RPC 替身，用于测 PiSession 的进程与协议关联，
 * 不依赖真实模型凭据。行为刻意包含几个真实会踩的边界：
 * 输出裸 U+2028、跨 chunk 切断多字节字符、退出时残留无换行的一行。
 */
import { StringDecoder } from "node:string_decoder";

const decoder = new StringDecoder("utf8");
let buf = "";

function out(obj) {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

process.stdin.on("data", (chunk) => {
	buf += decoder.write(chunk);
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i).replace(/\r$/, "");
		buf = buf.slice(i + 1);
		if (line) handle(JSON.parse(line));
	}
});

function handle(cmd) {
	switch (cmd.type) {
		case "get_state":
			out({ id: cmd.id, type: "response", command: "get_state", success: true, data: { isStreaming: false, messageCount: 0, model: { id: "fake-model" } } });
			break;
		case "prompt":
			out({ id: cmd.id, type: "response", command: "prompt", success: true });
			out({ type: "agent_start" });
			out({ type: "message_start", message: { role: "assistant" } });
			// 裸 U+2028 + 中文，走一次真实的成帧压力
			out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "第一行 第二行" } });
			out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "第一行 第二行" }] } });
			out({ type: "agent_settled" });
			break;
		case "fail":
			out({ id: cmd.id, type: "response", command: "fail", success: false, error: "boom" });
			break;
		case "late":
			// 迟于请求超时才回，用于验证 pending 不被二次 resolve
			setTimeout(() => out({ id: cmd.id, type: "response", command: "late", success: true }), 150);
			break;
		case "silent":
			// 刻意不响应，用于测请求超时
			break;
		case "crash":
			// 先吐半行再退出，验证 flush 与 pending 拒绝
			process.stdout.write('{"type":"agent_end","willRetry":false}');
			process.exit(3);
			break;
		default:
			out({ id: cmd.id, type: "response", command: cmd.type, success: true });
	}
}
