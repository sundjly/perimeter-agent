import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { PiCommand, PiEvent, PiResponse } from "./types.ts";
import { JsonlFramer } from "./framing.ts";

export interface PiSessionOptions {
	/** 工作区目录 —— agent 只能看到这里 */
	cwd: string;
	bin?: string;
	/** 额外的 pi 参数，如 --provider / --model / --extension */
	args?: string[];
	sessionDir?: string;
	/** 传给 pi 进程的环境变量。策略文件路径、会话上下文都经这里注入 */
	env?: NodeJS.ProcessEnv;
	requestTimeoutMs?: number;
	/** 单行字符数上限，超过即判定对端异常并终止会话。默认 6400 万，
	 * 足以容纳 pi 读大文件产生的 MB 级 tool 结果 */
	maxLineChars?: number;
	onEvent: (ev: PiEvent) => void;
	onResponse: (res: PiResponse) => void;
	onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
	onStderr?: (text: string) => void;
	/** 收到不可解析的行时调用；不提供则丢弃 */
	onProtocolError?: (line: string, err: unknown) => void;
}

interface Pending {
	resolve: (res: PiResponse) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout | null;
}

/**
 * 一个 `pi --mode rpc` 子进程的生命周期与协议关联。
 *
 * 这是 Phase 1（路线 C）唯一接触 pi 进程的地方。Phase 2 换成直接 embed
 * AgentHarness 时，本文件连同 protocol/translate.ts 一起被替换。
 *
 * 一条贯穿全文件的约束：网关为每个浏览器会话持有一个 PiSession，
 * 因此**单个会话的任何异常都不允许升级成进程级 uncaught exception**。
 */
export class PiSession {
	#proc: ChildProcessWithoutNullStreams;
	#framer = new JsonlFramer();
	#stderrDecoder = new StringDecoder("utf8");
	#pending = new Map<string, Pending>();
	#seq = 0;
	#exited = false;
	/** stop() 一进入就置真：stdin.end() 之后、exit 事件之前仍会有写入尝试 */
	#closing = false;
	#opts: PiSessionOptions;
	#maxLineChars: number;

	constructor(opts: PiSessionOptions) {
		this.#opts = opts;
		this.#maxLineChars = opts.maxLineChars ?? 64_000_000;
		// opts.args 排在强制参数之前，以便 bin 是 wrapper 时透传其自身参数
		// （如 Phase 2 的 `kubectl exec -it <pod> -- pi`，或测试里的 `node <fake>.mjs`）
		const args = [...(opts.args ?? []), "--mode", "rpc", ...(opts.sessionDir ? ["--session-dir", opts.sessionDir] : [])];
		this.#proc = spawn(opts.bin ?? "pi", args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });

		this.#proc.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
		this.#proc.stderr.on("data", (chunk: Buffer) => opts.onStderr?.(this.#stderrDecoder.write(chunk)));
		// stdin 上的错误若无监听器会升级成 uncaught exception
		this.#proc.stdin.on("error", (err) => opts.onProtocolError?.("<stdin>", err));
		this.#proc.on("error", (err) => this.#shutdown(null, null, err));
		// 'close' 而非 'exit'：exit 触发时 stdio 可能尚未排空
		this.#proc.on("close", (code, signal) => {
			this.#ingest(this.#framer.flush());
			this.#shutdown(code, signal, null);
		});
	}

	get running(): boolean {
		return !this.#exited && !this.#closing;
	}

	get pid(): number | undefined {
		return this.#proc.pid;
	}

	/** 在途请求数，用于健康检查与泄漏排查 */
	get pendingCount(): number {
		return this.#pending.size;
	}

	/**
	 * 发送命令并等待与之关联的响应。
	 * timeoutMs 传 0 表示不超时 —— bash 命令的响应要等命令跑完才回，
	 * 用统一的 30s 会把正常的长构建误判为超时。
	 */
	request(cmd: PiCommand, timeoutMs = this.#opts.requestTimeoutMs ?? 30_000): Promise<PiResponse> {
		if (!this.running) return Promise.reject(new Error("pi session already exited"));
		const id = `q${++this.#seq}`;
		return new Promise<PiResponse>((resolve, reject) => {
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							this.#pending.delete(id);
							reject(new Error(`pi command timed out: ${cmd.type}`));
						}, timeoutMs)
					: null;
			this.#pending.set(id, { resolve, reject, timer });
			this.#write({ ...cmd, id });
		});
	}

	/**
	 * 发送命令，不等待响应。
	 * **保留调用方自带的 id**：extension_ui_response 用 id 关联它要回答的
	 * 那个对话框，剥掉就等于审批永远送不回去。request() 用 q<N> 自行覆盖 id，
	 * 撞号风险本就不存在。
	 */
	send(cmd: PiCommand): void {
		if (!this.running) return;
		this.#write(cmd);
	}

	/** 优雅停止：SIGTERM，超时后 SIGKILL */
	async stop(graceMs = 2000): Promise<void> {
		if (this.#exited) return;
		this.#closing = true;
		const done = new Promise<void>((resolve) => this.#proc.once("close", () => resolve()));
		this.#proc.stdin.end();
		this.#proc.kill("SIGTERM");
		const killer = setTimeout(() => this.#proc.kill("SIGKILL"), graceMs);
		await done;
		clearTimeout(killer);
	}

	#write(cmd: PiCommand): void {
		// 命令本身也必须是单行 JSONL：JSON.stringify 会把内容里的换行转义，天然满足
		this.#proc.stdin.write(`${JSON.stringify(cmd)}\n`);
	}

	#onStdout(chunk: Buffer): void {
		const lines = this.#framer.push(chunk);
		if (this.#framer.pending > this.#maxLineChars) {
			this.#proc.kill("SIGKILL");
			this.#opts.onProtocolError?.("<oversized-line>", new Error(`line exceeded ${this.#maxLineChars} chars`));
			return;
		}
		this.#ingest(lines);
	}

	#ingest(lines: string[]): void {
		for (const line of lines) {
			let frame: unknown;
			try {
				frame = JSON.parse(line);
				// null / 数字 / 字符串都是合法 JSON，属性访问必须在守卫之后
				if (typeof frame !== "object" || frame === null) throw new Error("frame is not an object");
			} catch (err) {
				this.#opts.onProtocolError?.(line, err);
				continue;
			}
			if ((frame as { type?: unknown }).type === "response") this.#onResponse(frame as PiResponse);
			else this.#opts.onEvent(frame as PiEvent);
		}
	}

	#onResponse(res: PiResponse): void {
		const id = typeof res.id === "string" ? res.id : null;
		const p = id ? this.#pending.get(id) : undefined;
		if (p && id) {
			this.#pending.delete(id);
			if (p.timer) clearTimeout(p.timer);
			p.resolve(res);
		}
		// 无论是否被 request 等待，响应都要过一遍上层：失败响应要变成用户可见的错误
		this.#opts.onResponse(res);
	}

	#shutdown(code: number | null, signal: NodeJS.Signals | null, err: Error | null): void {
		if (this.#exited) return;
		this.#exited = true;
		const reason = err ?? new Error(`pi session exited (code=${code}, signal=${signal})`);
		for (const [, p] of this.#pending) {
			if (p.timer) clearTimeout(p.timer);
			p.reject(reason);
		}
		this.#pending.clear();
		this.#opts.onExit({ code, signal });
	}
}
