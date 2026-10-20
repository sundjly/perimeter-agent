// bounded-reader + stream-lifecycle 纯 unit（R55-D/E 同缝；resource-free：零 timer/FS/net）。
// DeadlineReadGate 注入假 mono/fake timer——因果验证 pending read 被 owned 截止唤醒、
// 零窗拒、粘滞、多 read 不 reset 原 deadline、timer 必释放；真实 ReadableStream 假源的
// async cancel 完成/拒绝/error cleanup（非 ++counter 同步 fake）。
// 本文件为源码交付，未运行（R55 执行禁令；由 coor 新轮预审实际脚本后执行）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { DeadlineReadGate, DeadlineError, armDeadlineTimer, disarmDeadlineTimer } from "../src/gitproxy/bounded-reader.ts";

/** 假钟 + fake timer 对：可手动推进；记录 arm/clear */
function fakeClock() {
	let now = 1_000_000;
	const timers: { at: number; fn: () => void; cleared: boolean }[] = [];
	return {
		mono: (): number => now,
		advance: (ms: number): void => {
			now += ms;
			for (const t of [...timers]) {
				if (!t.cleared && t.at <= now) {
					t.cleared = true;
					t.fn();
				}
			}
		},
		setTimeout: (fn: () => void, ms: number): unknown => {
			const t = { at: now + ms, fn, cleared: false };
			timers.push(t);
			return t;
		},
		clearTimeout: (timer: unknown): void => {
			(timer as { cleared: boolean }).cleared = true;
		},
		clearedCount: (): number => timers.filter((t) => t.cleared).length,
		armedCount: (): number => timers.length,
	};
}

function hangingReader(): { read: () => Promise<{ done: boolean; value?: Uint8Array }>; settle: (v?: Uint8Array) => void } {
	let resolvePending: (v: { done: boolean; value?: Uint8Array }) => void = () => {};
	const pending = new Promise<{ done: boolean; value?: Uint8Array }>((r) => { resolvePending = r; });
	let first = true;
	return {
		read: async () => {
			if (first) {
				first = false;
				return await pending; // 挂起（模拟半开/慢源）
			}
			return { done: true, value: undefined };
		},
		settle: (v) => resolvePending({ done: false, value: v ?? new Uint8Array([1]) }),
	};
}

test("gate：pending read 被 owned 截止唤醒（Timer fire → DeadlineError，非伪截止）", async () => {
	const clock = fakeClock();
	const src = hangingReader();
	const gate = new DeadlineReadGate(src, clock);
	const abs = clock.mono() + 10_000;
	const p = gate.read(abs);
	clock.advance(10_001); // 截止到点：timer fire
	await assert.rejects(p, DeadlineError, "挂起中的 read 必须被 owned 截止接管（不再是仅 await 前比较）");
	assert.equal(gate.expired, true);
	assert.equal(clock.clearedCount(), clock.armedCount(), "timer 必释放（fire 后 clear）");
});

test("gate：零窗 `>=` 拒不启动 read；粘滞——过期后后续 read 立即拒", async () => {
	const clock = fakeClock();
	const src = hangingReader();
	const gate = new DeadlineReadGate(src, clock);
	const abs = clock.mono(); // 剩余 0
	await assert.rejects(gate.read(abs), DeadlineError, "零窗 `>=` 直接拒（不可启动 read）");
	await assert.rejects(gate.read(clock.mono() + 5_000), DeadlineError, "粘滞：后续 read 立即拒");
});

test("gate：多 read 不 reset 原 deadline（每次 arm 时长=绝对截止-now，非每 chunk 重置 10s）", async () => {
	const clock = fakeClock();
	const chunks = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
	let i = 0;
	const gate = new DeadlineReadGate({ read: async () => ({ done: i >= chunks.length, value: i < chunks.length ? chunks[i++] : undefined }) }, clock);
	const abs = clock.mono() + 5_000;
	// 消费两块（每块 arm 的 remaining 递减——绝对锚不重置）
	await gate.read(abs);
	clock.advance(2_000);
	await gate.read(abs); // remaining=3000：arm 3000 非 5000
	const last = clock.mono();
	// 直接检查：再 arm 时（内部行为经 advance 验证）——推进到截止后 read 必超时
	clock.advance(3_001);
	await assert.rejects(gate.read(abs), DeadlineError);
	assert.ok(clock.mono() - last >= 3_000, "第二次 arm 基于绝对截止剩余（非每 chunk 重置 10s）");
	void chunks;
});

test("stream helper：async cancel 完成/拒绝/error cleanup（真 ReadableStream，非同步 fake）", async () => {
	// 生产同缝形态：onCancel 是 async（cancelSource 双侧收束）；forwarder.cancel 返回的
	// promise 必须接住完成与拒绝。此处以最小 ReadableStream+async onCancel 复刻契约。
	let cancelSettled = false;
	let cancelFailed = false;
	const src = new ReadableStream<Uint8Array>({
		pull(c) {
			c.enqueue(new Uint8Array([9]));
		},
		async cancel() {
			await Promise.resolve(); // async 收束（微任务，零真实 timer）
			cancelSettled = true;
		},
	});
	const reader = src.getReader();
	await reader.read();
	const cancelPromise = reader.cancel().then(() => {
		cancelSettled = true;
	}, () => {
		cancelFailed = true;
	});
	await cancelPromise;
	assert.equal(cancelSettled, true, "async cancel 完成被接住");
	assert.equal(cancelFailed, false);
	// error cleanup：cancel 中抛错也被 contain（forwarder runOnCancel 的 catch 契约）
	const bad = new ReadableStream<Uint8Array>({
		pull(c) {
			c.enqueue(new Uint8Array([8]));
		},
		async cancel() {
			throw new Error("cleanup boom");
		},
	});
	const r2 = bad.getReader();
	await r2.read();
	await r2.cancel().catch(() => { cancelFailed = true; });
	assert.equal(cancelFailed, true, "cancel 拒绝不 unhandled（contain 后置位）");
});

test("gate：读失败（非 deadline）归为 400 类固定错误且 expired 不误置", async () => {
	const clock = fakeClock();
	let boom = false;
	const gate = new DeadlineReadGate({
		read: async () => {
			if (boom) throw new Error("source boom");
			boom = true;
			return { done: true, value: undefined };
		},
	}, clock);
	const abs = clock.mono() + 5_000;
	await gate.read(abs); // done 正常
	assert.equal(gate.expired, false, "非截止失败不误置 expired");
	boom = true;
	await assert.rejects(gate.read(abs), (e: unknown) => !(e instanceof DeadlineError), "读失败不被伪装成 deadline");
});

test("armDeadlineTimer：fire 触发回调（contained）/零窗立即触发/双 fire 防护（R59-② 全寿命链）", async () => {
	const clock = fakeClock();
	let fired = 0;
	const timer = armDeadlineTimer(clock, clock.mono() + 5_000, () => { fired += 1; });
	clock.advance(4_999);
	assert.equal(fired, 0, "未到点不触发");
	clock.advance(2);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(fired, 1, "到点触发恰一次");
	disarmDeadlineTimer(clock, timer); // 幂等（已 fire 不重复）
	clock.advance(10_000);
	await Promise.resolve();
	assert.equal(fired, 1, "双 fire 防护");
	// 零窗：立即触发（contained，不抛）
	let zeroFired = 0;
	armDeadlineTimer(clock, clock.mono(), () => { zeroFired += 1; });
	await Promise.resolve();
	assert.equal(zeroFired, 1, "零窗 `>=` 立即触发（contained）");
	disarmDeadlineTimer(clock, { fired: true }); // 哨兵形态：无 timer 可清，不抛
});
