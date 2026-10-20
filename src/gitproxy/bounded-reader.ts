// 受界读取门（R55-D 同缝纯缝）：header 阶段每块读取挂**一次性** owned timer（绝对 mono
// 锚 = 请求起点，非每 chunk 重置）；timer fire 后不再等待 pending read（调用方 cancel 底层
// 使其 settle）——伪截止（仅 await 前比较）根除。零窗（剩余 ≤0）`>=` 语义直接拒，不启动
// read。timer 在 read settle 的 finally 必释放（无跨 chunk 累积 reaction）；expired promise
// 每 read 一个新实例。生产 gitproxy 与 resourcefree unit 消费同一实现（注入 mono/timer）。

export class DeadlineError extends Error {
	constructor() {
		super("bounded read deadline exceeded（owned 截止）");
		this.name = "DeadlineError";
	}
}

export interface DeadlineReadResult {
	done: boolean;
	value?: Uint8Array;
}

export interface DeadlineDeps {
	mono: () => number;
	setTimeout: (fn: () => void, ms: number) => unknown;
	clearTimeout: (timer: unknown) => void;
}

export class DeadlineReadGate {
	#timedOut = false;
	#src: { read(): Promise<DeadlineReadResult> };
	#deps: DeadlineDeps;
	// R57-1：strip-only 不支持 TS 参数属性，私有字段必须显式声明（原参数属性三重红）
	constructor(src: { read(): Promise<DeadlineReadResult> }, deps: DeadlineDeps) {
		this.#src = src;
		this.#deps = deps;
	}

	get expired(): boolean {
		return this.#timedOut;
	}

	/** 在绝对 mono 截止内读一块；截止触发即抛 DeadlineError（粘滞：后续 read 立即拒） */
	async read(absDeadlineMonoMs: number): Promise<DeadlineReadResult> {
		if (this.#timedOut) throw new DeadlineError();
		const remaining = absDeadlineMonoMs - this.#deps.mono();
		if (remaining <= 0) {
			// 零窗 `>=` 拒：不可启动 read
			this.#timedOut = true;
			throw new DeadlineError();
		}
		let fire: (err: DeadlineError) => void = () => {};
		const expired = new Promise<never>((_, reject) => {
			fire = (err) => {
				this.#timedOut = true;
				reject(err);
			};
		});
		const timer = this.#deps.setTimeout(() => fire(new DeadlineError()), remaining);
		try {
			return await Promise.race([this.#src.read(), expired]);
		} finally {
			this.#deps.clearTimeout(timer); // timer 必释放（read settle/超时/异常三路）
		}
	}
}

/**
 * R59-②：一次性全寿命截止 timer（同缝纯函数；Gateway #deadlineArm 委托本实现）。
 * 绝对 mono 锚；fire = contained 调 onFire（固定类别已由调用方置）；零窗立即触发；
 * 返回句柄供 disarm（{fired:true} 哨兵 = 零窗形态无 timer 可清）。
 */
export function armDeadlineTimer(
	deps: DeadlineDeps,
	absDeadlineMonoMs: number,
	onFire: () => Promise<void> | void,
): unknown {
	const remaining = absDeadlineMonoMs - deps.mono();
	if (remaining <= 0) {
		void Promise.resolve(onFire()).catch(() => {}); // contained
		return { fired: true };
	}
	let fired = false;
	const timer = deps.setTimeout(() => {
		if (fired) return;
		fired = true;
		void Promise.resolve(onFire()).catch(() => {}); // contain
	}, remaining);
	(timer as { unref?: () => void }).unref?.(); // 缺省 native timer 挂 unref（注入自理）
	return timer;
}

/** disarm：零窗哨兵（{fired:true}）直接跳过；真 timer 交 clearTimeout */
export function disarmDeadlineTimer(deps: DeadlineDeps, timer: unknown): void {
	if (timer === null || timer === undefined) return;
	if (typeof timer === "object" && "fired" in (timer as Record<string, unknown>)) return;
	deps.clearTimeout(timer);
}
