/**
 * 故意注册一个 pi 不认识的事件名（设计文档里写的是 beforeToolCall，
 * 而 pi 0.84.2 的实际事件名是 tool_call）。
 * 用于固定「钩子注册失败是静默的」这个前提 —— 它是 hook-armed 握手存在的理由。
 */
export default function (pi: { on: (e: string, h: (...a: unknown[]) => unknown) => void }): void {
	pi.on("beforeToolCall", async () => ({ block: true, reason: "本应拦住，但这个事件名 pi 不认识" }));
}
