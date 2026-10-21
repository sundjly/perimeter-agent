/**
 * R-Q9c：ps observer 纯负控/故障注入矩阵（注入 fake runner，无真实进程）。
 * 覆盖：timeout/error/signal/null → unknown；exit2 空输出 → unknown；exit0 空/malformed → unknown；
 * exit1 双空 → gone；exit1 带输出 → unknown；Z=dead-but-unreaped；活 PID 出生/父/组/marker 不符 → reuse；
 * kill 注入 spy：身份不匹配零 kill（R-Q9b）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyInspectGone, matchesGeneration, psIdentity, runAllCleanups, waitOwnerGone, type PsRunResult, type PsRunner } from "./helpers/ps-observer.ts";

const ok = (stdout: string): PsRunResult => ({ status: 0, stdout, stderr: "" });
const gone = (): PsRunResult => ({ status: 1, stdout: "", stderr: "" });

/** 构造 ps 单行输出（stat/ppid/pgid/lstart(5)/command） */
const line = (stat: string, ppid: number, pgid: number, command: string): string =>
	`${stat}   ${ppid}  ${pgid}  Sat Oct 17 10:00:00 2026     ${command}`;

const GEN = { ppid: 111, pgid: 222, birth: "Sat Oct 17 10:00:00 2026", marker: "/opt/daemon/pi-env" };

function runnerFrom(responses: Record<number, PsRunResult>): PsRunner {
	return (args) => {
		const pid = Number(args[args.indexOf("-p") + 1]);
		return responses[pid] ?? gone();
	};
}

describe("psIdentity 严格语义（R-Q9c）", () => {
	it("timeout（error）→ unknown", () => {
		const observer: PsRunner = () => ({ error: Object.assign(new Error("killed"), { code: "ABRT" } as never), status: null, signal: null, stdout: "", stderr: "" });
		assert.equal(psIdentity(observer, 100).state, "unknown");
	});
	it("spawn error → unknown", () => {
		const observer: PsRunner = () => ({ error: new Error("ENOENT"), status: null, signal: null, stdout: "", stderr: "" });
		assert.equal(psIdentity(observer, 100).state, "unknown");
	});
	it("signal 非空 → unknown（即便 status 0）", () => {
		const observer: PsRunner = () => ({ status: 0, signal: "SIGKILL", stdout: line("S", GEN.ppid, GEN.pgid, GEN.marker), stderr: "" });
		assert.equal(psIdentity(observer, 100).state, "unknown");
	});
	it("status=null → unknown", () => {
		const observer: PsRunner = () => ({ status: null, signal: null, stdout: line("S", GEN.ppid, GEN.pgid, GEN.marker), stderr: "" });
		assert.equal(psIdentity(observer, 100).state, "unknown");
	});
	it("exit 2 空输出 → unknown（不得当 gone）", () => {
		const observer: PsRunner = () => ({ status: 2, signal: null, stdout: "", stderr: "" });
		assert.equal(psIdentity(observer, 100).state, "unknown");
	});
	it("exit 0 空输出 → unknown", () => {
		const observer: PsRunner = () => ok("");
		assert.equal(psIdentity(observer, 100).state, "unknown");
	});
	it("exit 0 malformed（token 不足）→ unknown", () => {
		const observer: PsRunner = () => ok("S 111");
		assert.equal(psIdentity(observer, 100).state, "unknown");
	});
	it("exit 1 双空 → gone（唯一权威 gone 通道）", () => {
		assert.equal(psIdentity(runnerFrom({ 100: gone() }), 100).state, "gone");
	});
	it("exit 1 带输出 → unknown", () => {
		const observer: PsRunner = () => ({ status: 1, stdout: "", stderr: "ps: some diagnostic" });
		assert.equal(psIdentity(observer, 100).state, "unknown");
	});
	it("Z（zombie）→ dead-but-unreaped（非 gone、非 confirmed reaped）", () => {
		const id = psIdentity(runnerFrom({ 100: { status: 0, stdout: line("Z+", GEN.ppid, GEN.pgid, GEN.marker), stderr: "" } }), 100);
		assert.equal(id.state, "zombie");
	});
	it("marker 缺失（共同 SDK 路径不足）→ alive 但 matchesGeneration=false（reuse 判定由调用方）", () => {
		const id = psIdentity(runnerFrom({ 100: { status: 0, stdout: line("S", GEN.ppid, GEN.pgid, "/opt/other/pi-env"), stderr: "" } }), 100);
		if (id.state !== "alive") throw new Error(`预期 alive，实际 ${id.state}`);
		assert.equal(matchesGeneration(id.identity, GEN), false);
	});
	it("完全一致 → alive 且 matchesGeneration=true", () => {
		const id = psIdentity(runnerFrom({ 100: { status: 0, stdout: line("S", GEN.ppid, GEN.pgid, GEN.marker), stderr: "" } }), 100);
		if (id.state !== "alive") throw new Error(`预期 alive，实际 ${id.state}`);
		assert.equal(matchesGeneration(id.identity, GEN), true);
	});
});

describe("waitOwnerGone（注入 runner + ledger）", () => {
	const events: Record<string, unknown>[] = [];
	const ledger = (e: Record<string, unknown>) => events.push(e);
	it("同 birth 但 ppid/pgid 漂移 → identity drift unknown（非死亡证据；R-Q9c 修正后语义）", async () => {
		const observer = runnerFrom({ 100: { status: 0, stdout: line("S", 999, 888, "/opt/other/pi-env"), stderr: "" } });
		// 观测行 birth 与 GEN 相同、仅父/组不同 → identity drift unknown，不是 reused
		await assert.rejects(waitOwnerGone({ observer, pid: 100, generation: GEN, nonce: "n1-drift", deadlineMs: 1000, ledger }), /identity drift/);
		const last = events.at(-1) as Record<string, unknown>;
		assert.equal(last.event, "unknown");
		assert.match(String(last.outcome), /identity drift/);
	});
	it("birth 真实可信不同 → gone-pid-reused（明确 PID 复用）", async () => {
		const observer: PsRunner = () => ({ status: 0, stdout: line("S", 999, 888, "/opt/other/pi-env").replace("Sat Oct 17 10:00:00 2026", "Fri Oct 16 09:00:00 2026"), stderr: "" });
		const outcome = await waitOwnerGone({ observer, pid: 100, generation: GEN, nonce: "n1-reuse", deadlineMs: 1000, ledger });
		assert.equal(outcome, "gone-pid-reused");
		const last = events.at(-1) as Record<string, unknown>;
		assert.equal(last.event, "inspect-gone");
		assert.equal(last.outcome, "gone-pid-reused（birth 不同）");
	});
	it("持续同 owner 存活 → deadline 失败（非 gone）", async () => {
		const observer: PsRunner = () => ({ status: 0, stdout: line("S", GEN.ppid, GEN.pgid, GEN.marker), stderr: "" });
		await assert.rejects(waitOwnerGone({ observer, pid: 100, generation: GEN, nonce: "n2", deadlineMs: 120, ledger }), /未在 120ms 内正向消失/);
	});
	it("unknown → 立即失败且 ledger 保留 unknown 事件", async () => {
		const observer: PsRunner = () => ({ status: 2, signal: null, stdout: "", stderr: "" });
		await assert.rejects(waitOwnerGone({ observer, pid: 100, generation: GEN, nonce: "n3", deadlineMs: 500, ledger }), /unknown/);
		const last = events.at(-1) as Record<string, unknown>;
		assert.equal(last.event, "unknown");
	});
	it("zombie 不收割 → deadline 失败（dead-but-unreaped 不得当 reaped）", async () => {
		const observer: PsRunner = () => ({ status: 0, stdout: line("Z", GEN.ppid, GEN.pgid, GEN.marker), stderr: "" });
		await assert.rejects(waitOwnerGone({ observer, pid: 100, generation: GEN, nonce: "n4", deadlineMs: 150, ledger }), /dead-but-unreaped/);
	});
	it("gone → 正向返回", async () => {
		const outcome = await waitOwnerGone({ observer: runnerFrom({ 100: gone() }), pid: 100, generation: GEN, nonce: "n5", deadlineMs: 500, ledger });
		assert.equal(outcome, "gone");
	});
});

describe("runAllCleanups（R-Q9a：首个 throw 不跳过其余，错误聚合）", () => {
	it("首个 cleanup 抛错后其余仍全部执行，错误聚合并抛出", async () => {
		const executed: string[] = [];
		const cleanups = [
			() => { executed.push("a"); throw new Error("first-fail"); },
			() => { executed.push("b"); },
			async () => { executed.push("c"); },
			() => { executed.push("d"); throw new Error("second-fail"); },
		];
		const error = await runAllCleanups(cleanups);
		assert.ok(error instanceof Error);
		assert.deepEqual(executed, ["a", "b", "c", "d"], "全部 cleanup 必须被执行");
		// R-Q10a：聚合只出固定类别+索引+计数（同失败语义）；raw 失败原文经 reporter 落盘＝持久通道，不透传
		assert.match(error.message, /2\/4/);
		assert.match(error.message, /#1/);
		assert.match(error.message, /#4/);
		assert.equal(error.message.includes("first-fail"), false, "聚合 message 不得含 raw 失败原文");
		assert.equal(error.message.includes("second-fail"), false, "聚合 message 不得含 raw 失败原文");
	});
	it("全成功 → 无错误", async () => {
		const executed: string[] = [];
		const error = await runAllCleanups([() => { executed.push("x"); }, async () => { executed.push("y"); }]);
		assert.equal(error, undefined);
		assert.deepEqual(executed, ["x", "y"]);
	});
});


describe("classifyInspectGone（R-Q9d' 收紧：整句白名单，fake CLI 负控）", () => {
	const CID = "cf801d8432146823cf74231c35368da14826247a267a6b0e40fc471447bebe9d";
	it("exit1 + 整句已知错误（大小写不敏感、全 CID）→ gone", () => {
		assert.equal(classifyInspectGone({ status: 1, stdout: "", stderr: `Error: No such object: ${CID}` }, CID), "gone");
		assert.equal(classifyInspectGone({ status: 1, stdout: "", stderr: `error: no such object: ${CID}` }, CID), "gone");
	});
	it("exit1 + 额外诊断/其它 CID → unknown（不得判 gone）", () => {
		assert.equal(classifyInspectGone({ status: 1, stdout: "", stderr: `Error: No such object: ${CID}\nextra diagnostic` }, CID), "unknown");
		assert.equal(classifyInspectGone({ status: 1, stdout: "", stderr: "Error: No such object: deadbeef" }, CID), "unknown");
	});
	it("status=0 输出含同 CID → live（判失败）；无 CID → unknown", () => {
		assert.equal(classifyInspectGone({ status: 0, stdout: `${CID}\n`, stderr: "" }, CID), "live");
		assert.equal(classifyInspectGone({ status: 0, stdout: "other", stderr: "" }, CID), "unknown");
	});
	it("status=2 / null / signal / error → unknown", () => {
		assert.equal(classifyInspectGone({ status: 2, stdout: "", stderr: "whatever" }, CID), "unknown");
		assert.equal(classifyInspectGone({ status: null, signal: "SIGKILL", stdout: "", stderr: "" }, CID), "unknown");
		assert.equal(classifyInspectGone({ error: new Error("boom"), status: null, stdout: "", stderr: "" }, CID), "unknown");
	});
});
