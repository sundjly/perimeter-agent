// renew 调度 timer 的 owned 生命周期纯缝（R59-F2 同缝）：Gateway 实际生产调用本类做
// 单 slot arm/clear；resourcefree unit 注入 fake timer 直测全路径。
// 语义（R58 §3.1 修法，coor F2 裁决）：
// - 单 slot 配对 clear；closed 每次 arm 复查；close-during-arm 不补写 slot。
// - hook 同步 fire：**不在 timerImpl 栈内执行 onFire**（本 handle 只置 pendingSyncFire
//   标记并返回）——arm 返回后若本层仍当前 gen：视为**单 inline**，同步执行一次 onFire
//   并保证最终恰一有效 future slot（调用方未重排时由本层重排）。
// - 嵌套再同步（同步段内又发生 arm，即总 inline hook）：failclosed（hookIllegal 粘滞 +
//   clear handle + slot 清空），不 microtask 重排、不爆栈、不 spin。
// - 异步 fire 保留迟到句柄防护（gen 不符直接 return）。

export interface OwnedRenewTimerDeps {
	setTimeoutImpl: (fn: () => void, ms: number) => unknown;
	clearTimeoutImpl: (timer: unknown) => void;
	/** 每次 arm 前查询（网关 closed 即不再 arm） */
	closed: () => boolean;
}

export class OwnedRenewTimer {
	#slot: { timer: unknown; clear: (timer: unknown) => void } | null = null;
	#gen = 0;
	#inSync = false;
	#syncFireCount = 0; // 单 inline 连续计数：≥2 = 总 inline hook → failclosed
	#hookIllegal = false;

	get hookIllegal(): boolean {
		return this.#hookIllegal;
	}

	get activeSlot(): boolean {
		return this.#slot !== null;
	}

	/** 取消当前 slot（网关 close/重排前）——幂等 */
	stop(): void {
		// R60-③：stop 须使当前 gen 失效（旧句柄即使被外部手动触发也不再执行 onFire——
		// 与重排防护同构；native clearTimeout 后不会真触发，此为 fake 手动触发边界契约）。
		this.#gen += 1;
		if (this.#slot !== null) {
			this.#slot.clear(this.#slot.timer);
			this.#slot = null;
		}
	}

	arm(delayMs: number, onFire: () => void, deps: OwnedRenewTimerDeps): "armed" | "skipped-closed" | "failed-illegal-hook" {
		if (this.#hookIllegal) return "failed-illegal-hook";
		if (deps.closed()) return "skipped-closed";
		this.stop();
		const gen = ++this.#gen;
		let syncFire = false; // 本 handle 被 timerImpl 同步触发
		let nestedSync = false; // 同步段内又发生 arm（总 inline 信号）
		let timer: unknown;
		const handle = (): void => {
			if (this.#gen !== gen) return; // 迟到句柄（已被更新 slot 取代）
			if (this.#inSync) {
				// 同步段内：首个 fire → 单 inline 标记；再来一个 → 总 inline hook（failclosed）
				if (syncFire) nestedSync = true;
				else syncFire = true;
				return;
			}
			onFire(); // 异步 fire：正常执行（生产 onFire 的 finally 重排 → arm 新 gen）
		};
		this.#inSync = true;
		try {
			timer = deps.setTimeoutImpl(handle, delayMs);
		} finally {
			this.#inSync = false;
		}
		if (deps.closed()) {
			deps.clearTimeoutImpl(timer);
			// R78：与 stop() 同构——close-during-arm 清掉的句柄也要因 gen 失效而不可再
			// 执行 onFire（fake timer 手动触发边界契约；native clearTimeout 后不会真触发）。
			this.#gen += 1;
			return "skipped-closed";
		}
		if (nestedSync) {
			// 总 inline hook：failclosed（clear handle + slot 清空 + 粘滞标记）
			this.#hookIllegal = true;
			deps.clearTimeoutImpl(timer);
			this.#slot = null;
			return "failed-illegal-hook";
		}
		this.#slot = { timer, clear: deps.clearTimeoutImpl };
		if (syncFire) {
			this.#syncFireCount += 1;
			if (this.#syncFireCount >= 2) {
				// 连续两次同步 fire = 总 inline hook（每次 arm 都立即 fire）：failclosed
				this.#hookIllegal = true;
				deps.clearTimeoutImpl(timer);
				this.#slot = null;
				return "failed-illegal-hook";
			}
			// 单 inline：同步执行一次 onFire（其内重排会经 arm 换 slot）
			onFire();
			if (this.#gen === gen && this.#slot !== null && this.#slot.timer === timer) {
				// 调用方未重排：本层保证最终恰一有效 future slot（重建下拍 timer，新 gen
				// 使旧 handle 失效）；重建前复查 closed（R59-v2 minor）
				deps.clearTimeoutImpl(timer);
				if (deps.closed()) return "skipped-closed";
				const gen2 = ++this.#gen;
				const t2 = deps.setTimeoutImpl(() => {
					if (this.#gen !== gen2) return;
					onFire();
				}, delayMs);
				(t2 as { unref?: () => void }).unref?.();
				this.#slot = { timer: t2, clear: deps.clearTimeoutImpl };
			}
		} else {
			this.#syncFireCount = 0; // R59-v2 minor：无同步 fire 的正常 arm 归零（只罚“连续”）
		}
		return "armed";
	}
}
