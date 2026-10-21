// OwnedRenewTimer 全路径纯 unit（R59-⑤ 同缝；resource-free：注入 fake timer，零真实等待）。
// 总 inline fail-closed（不爆栈/不 spin）、单次 inline 恰一 slot、close-during-arm 不补写、
// 配对 clear。消费真实生产模块 owned-renew-timer.ts（非测试副本）。
// 本文件为源码交付，未运行（R59 执行禁令；由 coor 新轮预审实际脚本后执行）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { OwnedRenewTimer } from "../src/gateway/owned-renew-timer.ts";

test("owned-timer：正常 arm → fire → 重排（异步语义，恰一 slot）", () => {
	const t = new OwnedRenewTimer();
	let fired = 0;
	const timers: { fn: () => void; cleared: boolean }[] = [];
	const outcome = t.arm(100, () => { fired += 1; }, {
		setTimeoutImpl: (fn) => { const o = { fn, cleared: false }; timers.push(o); return o; },
		clearTimeoutImpl: (x) => { (x as { cleared: boolean }).cleared = true; },
		closed: () => false,
	});
	assert.equal(outcome, "armed");
	assert.equal(timers.length, 1);
	timers[0]!.fn();
	assert.equal(fired, 1, "fire 恰一次（迟到句柄不重放）");
});

test("owned-timer：总 inline hook（hook 内重入 arm 且立即 fire）→ fail-closed，不爆栈不 spin", () => {
	const t = new OwnedRenewTimer();
	let fires = 0;
	let depth = 0;
	const armRecursive = (): string =>
		t.arm(100, () => {
			fires += 1;
			depth += 1;
			if (depth < 50) armRecursive(); // 总同步 fire：每次 fire 立即重入 arm（模拟非法 always-inline hook）
		}, {
			setTimeoutImpl: (fn) => {
				fn(); // 总 inline：timerImpl 同步执行 fire
				return {};
			},
			clearTimeoutImpl: () => {},
			closed: () => false,
		});
	const outcome = armRecursive();
	assert.equal(outcome, "armed", "外层（首次）arm 正常占 slot；重入的内层被判非法拒续");
	assert.ok(depth < 10, `有界递归（实际深度 ${depth}，不爆栈）`);
	assert.equal(t.hookIllegal, true, "非法 hook 粘滞标记");
	assert.ok(fires >= 1, "至少一次 fire 发生（语义面）");
	// 粘滞：后续 arm 直接拒
	assert.equal(t.arm(100, () => { fires += 1; }, {
		setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {}, closed: () => false,
	}), "failed-illegal-hook");
});

test("owned-timer：单次 inline（首次同步 fire 一次后停）→ 恰一有效 future slot；后续异步 fire 仍能重排", () => {
	const t = new OwnedRenewTimer();
	const timers: { fn: () => void; cleared: boolean }[] = [];
	let fired = 0;
	let inline = true;
	const outcome = t.arm(100, () => { fired += 1; }, {
		setTimeoutImpl: (fn) => {
			const o = { fn, cleared: false };
			timers.push(o);
			if (inline) {
				inline = false;
				fn(); // 仅首 arm 同步 fire 一次（arm 返回后同步执行 onFire 并重排 future slot）
			}
			return o;
		},
		clearTimeoutImpl: (x) => { (x as { cleared: boolean }).cleared = true; },
		closed: () => false,
	});
	assert.equal(outcome, "armed");
	assert.equal(fired, 1, "单次 inline fire 恰一次（同步执行）");
	const live = timers.filter((x) => !x.cleared);
	assert.equal(live.length, 1, "最终恰一个未清 timer（重排后的有效 future slot）");
	live[0]!.fn(); // 后续异步 fire：仍能执行（重排后的 slot 有效）
	assert.equal(fired, 2, "单 inline 后再次异步 fire 仍能重排/执行");
});

test("owned-timer：close-during-arm 不补写 slot；closed → skipped", () => {
	let closed = false;
	const t = new OwnedRenewTimer();
	assert.equal(t.arm(100, () => {}, {
		setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {}, closed: () => closed,
	}), "armed");
	// arm 期间 closed 翻转（hook 外部 close）：
	const outcome = t.arm(100, () => {}, {
		setTimeoutImpl: () => { closed = true; return {}; }, // timerImpl 内同步置 closed
		clearTimeoutImpl: () => {},
		closed: () => closed,
	});
	assert.equal(outcome, "skipped-closed", "close-during-arm 不补写 slot");
	assert.equal(t.activeSlot, false);
	// 已 closed：
	assert.equal(t.arm(100, () => {}, {
		setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {}, closed: () => true,
	}), "skipped-closed");
});

test("owned-timer：stop 配对 clear；stop 后旧句柄 fire 不执行（迟到句柄防护）", () => {
	const t = new OwnedRenewTimer();
	let fired = 0;
	const timers: { fn: () => void; cleared: boolean }[] = [];
	t.arm(100, () => { fired += 1; }, {
		setTimeoutImpl: (fn) => { const o = { fn, cleared: false }; timers.push(o); return o; },
		clearTimeoutImpl: (x) => { (x as { cleared: boolean }).cleared = true; },
		closed: () => false,
	});
	t.stop();
	assert.equal(timers[0]!.cleared, true, "stop 配对 clear");
	timers[0]!.fn(); // 迟到触发：slot 已空 → 不执行
	assert.equal(fired, 0, "迟到 fire 不执行");
});

test("owned-timer：close-during-arm 清掉的句柄因 gen 失效，手动触发不执行 onFire（R78）", () => {
	// 与 stop() 同构的 fake-timer 边界（native clearTimeout 后不会真触发，此为手动触发契约）：
	// close-during-arm 分支此前只 clear 不 bump gen——被清句柄仍可被手动触发执行 onFire。
	let closed = false;
	let fired = 0;
	const t = new OwnedRenewTimer();
	const captured: { fn: () => void }[] = [];
	const outcome = t.arm(100, () => { fired += 1; }, {
		setTimeoutImpl: (fn) => { closed = true; const o = { fn }; captured.push(o); return o; }, // timerImpl 内同步置 closed
		clearTimeoutImpl: () => {},
		closed: () => closed,
	});
	assert.equal(outcome, "skipped-closed", "close-during-arm 不补写 slot");
	assert.equal(t.activeSlot, false);
	captured[0]!.fn(); // 迟到句柄（fake 手动触发）：gen 已失效 → 不得执行
	assert.equal(fired, 0, "close-during-arm 清掉的句柄不得再执行 onFire");
});
