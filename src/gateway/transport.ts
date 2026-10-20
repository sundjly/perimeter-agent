/** 连接级发送：所有帧（快照/控制/错误/增量）都经过 Outbox，统一计字节并检查 bufferedAmount */
export interface Limits {
	/** 入站 WS 帧上限（ws maxPayload） */
	maxInboundBytes: number;
	maxPromptBytes: number;
	/** 单帧上限 */
	maxFrameBytes: number;
	/** 每连接应用层待发送字节上限 */
	maxQueuedBytes: number;
	/** 物理 socket 发送缓冲硬水位（ws.bufferedAmount） */
	maxBufferedBytes: number;
	maxConnections: number;
	maxConnectionsPerPrincipal: number;
	/** 每连接每秒入站命令数 */
	maxCommandsPerSecond: number;
}

export const DEFAULT_LIMITS: Limits = {
	maxInboundBytes: 1 << 20,
	maxPromptBytes: 64 * 1024,
	maxFrameBytes: 2 << 20,
	maxQueuedBytes: 2 << 20,
	maxBufferedBytes: 8 << 20,
	maxConnections: 200,
	maxConnectionsPerPrincipal: 10,
	maxCommandsPerSecond: 20,
};

export function validateLimits(limits: Limits): void {
	for (const [k, v] of Object.entries(limits)) {
		if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v <= 0) {
			throw new Error(`配置非法：limits.${k} 必须为有限正整数，当前为 ${v}`);
		}
	}
}

export interface WsLike {
	readyState: number;
	readonly OPEN: number;
	bufferedAmount: number;
	send(data: string, cb?: (error?: Error) => void): void;
	close(code?: number, reason?: string): void;
	terminate(): void;
}

export class Outbox {
	#queue: { payload: string; bytes: number }[] = [];
	#queuedBytes = 0;
	#sending = false;
	#dead = false;
	#ws: WsLike;
	#limits: Pick<Limits, "maxFrameBytes" | "maxQueuedBytes" | "maxBufferedBytes">;
	constructor(ws: WsLike, limits: Pick<Limits, "maxFrameBytes" | "maxQueuedBytes" | "maxBufferedBytes">) {
		this.#ws = ws;
		this.#limits = limits;
	}
	get length(): number { return this.#queue.length; }
	get queuedBytes(): number { return this.#queuedBytes; }
	get dead(): boolean { return this.#dead; }
	clear(): void { this.#queue.length = 0; this.#queuedBytes = 0; }

	/** 返回 false 表示帧被拒绝且连接已被终止；超限只终止这一条连接 */
	send(payload: string): boolean {
		if (this.#dead || this.#ws.readyState !== this.#ws.OPEN) return false;
		const bytes = Buffer.byteLength(payload);
		if (bytes > this.#limits.maxFrameBytes) return this.#kill(1009, "帧过大，请缩小会话后重连");
		if (this.#queuedBytes + bytes > this.#limits.maxQueuedBytes || this.#ws.bufferedAmount > this.#limits.maxBufferedBytes) return this.#kill(1013, "连接过慢");
		this.#queue.push({ payload, bytes });
		this.#queuedBytes += bytes;
		this.#pump();
		return true;
	}
	#kill(code: number, reason: string): false {
		this.#dead = true;
		this.clear();
		// 慢端不等对端确认 close 握手：直接丢弃发送缓冲
		if (code === 1013) this.#ws.terminate(); else this.#ws.close(code, reason);
		return false;
	}
	#pump(): void {
		if (this.#sending || this.#dead) return;
		const item = this.#queue.shift();
		if (!item) return;
		this.#queuedBytes -= item.bytes;
		if (this.#ws.readyState !== this.#ws.OPEN) return;
		if (this.#ws.bufferedAmount + item.bytes > this.#limits.maxBufferedBytes) { this.#kill(1013, "连接过慢"); return; }
		this.#sending = true;
		this.#ws.send(item.payload, (error) => {
			this.#sending = false;
			if (error) this.#kill(1011, "发送失败"); else this.#pump();
		});
	}
}

/** 令牌桶式限速：每秒 limit 条，超过即返回 false */
export class RateLimiter {
	#windowStart = 0;
	#count = 0;
	#limit: number;
	#now: () => number;
	constructor(limit: number, now: () => number = Date.now) {
		this.#limit = limit;
		this.#now = now;
	}
	allow(): boolean {
		const t = this.#now();
		if (t - this.#windowStart >= 1000) { this.#windowStart = t; this.#count = 0; }
		return ++this.#count <= this.#limit;
	}
}

/** Host / Origin 精确匹配（不做子串/后缀/通配）。allowed 为 null 时由调用方走默认规则 */
export function hostAllowed(host: string | undefined, allowed: ReadonlySet<string>): boolean {
	return !!host && allowed.has(host.toLowerCase());
}

/** 浏览器会带 Origin；没有 Origin 的只可能是非浏览器客户端（CLI），由调用方决定是否接受 */
export function originAllowed(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
	return origin !== undefined && allowed.has(origin.toLowerCase());
}
