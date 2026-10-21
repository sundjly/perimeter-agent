/**
 * R-Q9e：ledger 安全投影/白名单 producer 泄漏负控（纯 fake，无真实 PID/daemon/Docker）。
 *
 * 威胁模型：driver.identity.command 含 SDK `serve --token <值>` 临时 RPC 认据（已结束测试资源的临时值，
 * 非用户上游 secret，不泛化事故）。producer 必须保证：
 * - 持久化 ledger 绝不出现 command 原文/--token 值/嵌套 env/token 字段/raw Error.message；
 * - 保留可审计字段：nonce/localpid/pgid/ppid/birth/session/完整CID/commandMatchesMarker；
 * - 新 ledger 文件 mode 0600；已存在文件保留现权限（POSIX 语义，如实不妄称改旧权限）。
 * 走实际 appendLedgerEvent/projectSafeIdentity 生产路径（非 mock 自测）。
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { appendLedgerEvent, projectSafeIdentity, runAllCleanups, waitOwnerGone, type ObservedIdentity } from "./helpers/ps-observer.ts";
import { DaemonResource } from "./helpers/daemon-resource.ts";

const dirs: string[] = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CANARY_TOKEN = "CANARY_RPC_ONLY_FROML_TEST";
const canaryIdentity: ObservedIdentity = {
	ppid: 111,
	pgid: 222,
	birth: "Sat Oct 17 10:00:00 2026",
	command: `docker exec -i perimeter-pgxledger-pg-ledger-${CANARY_TOKEN} pi-env serve --token ${CANARY_TOKEN}`,
};

/** canary 扫描：文件全文不得含 token 值/--token/嵌套敏感键 */
function assertNoCanary(filePath: string): void {
	const content = readFileSync(filePath, "utf8");
	assert.equal(content.includes(CANARY_TOKEN), false, "ledger 不得含 canary token 值");
	assert.equal(content.includes("--token"), false, "ledger 不得含 --token 旗标");
	assert.equal(content.includes("docker exec -i"), false, "ledger 不得含完整命令行 argv");
	assert.equal(content.includes('"env"'), false, "ledger 不得含嵌套 env 字段");
	assert.equal(content.includes('"token"'), false, "ledger 不得含 token 字段");
}

test("投影：command 只以 commandMatchesMarker 布尔表达，无原文", () => {
	const projected = projectSafeIdentity(canaryIdentity, "/opt/daemon/pi-env");
	assert.deepEqual(Object.keys(projected).sort(), ["birth", "commandMatchesMarker", "pgid", "ppid"]);
	assert.equal(projected.commandMatchesMarker, false, "canary command 不匹配 marker");
	assert.equal(JSON.stringify(projected).includes(CANARY_TOKEN), false, "投影不得含 token");
	assert.equal(JSON.stringify(projected).includes("docker exec"), false, "投影不得含命令行");
});

test("canary 门①：driver 事件走实际 producer → ledger 无 canary/完整 argv，安全字段可审计，新文件 0600", () => {
	const dir = mkdtempSync(join(tmpdir(), "pin-privacy-"));
	dirs.push(dir);
	const ledgerPath = join(dir, "ledger-docker.jsonl");
	const projection = projectSafeIdentity(canaryIdentity, "/opt/daemon/pi-env");
	const result = appendLedgerEvent(ledgerPath, {
		event: "inspect",
		nonce: "canary-1",
		container: `perimeter-pgxledger-pg-ledger-${CANARY_TOKEN.slice(0, 8)}`,
		cid: "c".repeat(64),
		driver: projection,
		outcome: "driver-probed",
		// 故意混入未白名单的敏感键：producer 必须丢弃
		token: CANARY_TOKEN,
		env: { SECRET: "x" },
		rawCommand: canaryIdentity.command,
	});
	assert.equal(result.modeApplied, "new-0600", "新 ledger 必须 0600");
	const mode = statSync(ledgerPath).mode & 0o777;
	assert.equal(mode.toString(8), "600", `新文件必须 0600（实际 ${mode.toString(8)}）`);
	const content = readFileSync(ledgerPath, "utf8");
	assert.equal(content.includes(CANARY_TOKEN), false);
	assert.equal(content.includes("docker exec -i"), false);
	assert.equal(content.includes('"token"'), false);
	assert.equal(content.includes('"env"'), false);
	const record = JSON.parse(content) as Record<string, unknown>;
	assert.equal(record.driver && (record.driver as Record<string, unknown>).commandMatchesMarker, false, "安全布尔可审计");
	assert.ok((record.driver as Record<string, unknown>).birth, "birth 保留可审计");
});

test("canary 门②：含凭据的 Error 诊断经 unknown outcome → ledger 无凭据（固定类别不透传 message）", () => {
	const dir = mkdtempSync(join(tmpdir(), "pin-privacy-"));
	dirs.push(dir);
	const ledgerPath = join(dir, "ledger-err.jsonl");
	const credentialDiagnostic = `connect failed with token ${CANARY_TOKEN} at /opt/daemon/pi-env`;
	// 模拟 producer 侧固定类别映射：unknown 诊断只落固定类别，不透传 raw message
	const fixedCategory = credentialDiagnostic.includes("token") ? "inspect-gone unknown（诊断类别：连接/凭据类，细节不透传）" : "inspect-gone unknown";
	appendLedgerEvent(ledgerPath, { event: "unknown", nonce: "canary-2", outcome: fixedCategory });
	const content = readFileSync(ledgerPath, "utf8");
	assert.equal(content.includes(CANARY_TOKEN), false, "ledger 不得含凭据诊断原文");
	assert.match(content, /unknown/);
});

test("canary 门③：已存在 0644 文件 append → 权限保留（如实不妄称 0600），内容仍无 canary", () => {
	const dir = mkdtempSync(join(tmpdir(), "pin-privacy-"));
	dirs.push(dir);
	const ledgerPath = join(dir, "ledger-keep.jsonl");
	writeFileSync(ledgerPath, '{"event":"seed"}\n', { mode: 0o644 });
	chmodSync(ledgerPath, 0o644);
	const projection = projectSafeIdentity(canaryIdentity, "/opt/daemon/pi-env");
	const result = appendLedgerEvent(ledgerPath, { event: "inspect-gone", nonce: "canary-3", driver: projection, outcome: "driver-gone" });
	assert.equal(result.modeApplied, "kept-existing", "已存在文件如实保留现权限");
	const mode = statSync(ledgerPath).mode & 0o777;
	assert.equal(mode.toString(8), "644", "已存在文件权限不被修改（POSIX 语义如实）");
	assert.equal(readFileSync(ledgerPath, "utf8").includes(CANARY_TOKEN), false);
});

test("mode 边界：0600 新文件 append → 仍 0600（mode 参数只影响新创建，已存在不动）", () => {
	const dir = mkdtempSync(join(tmpdir(), "pin-privacy-"));
	dirs.push(dir);
	const ledgerPath = join(dir, "ledger-0600.jsonl");
	appendLedgerEvent(ledgerPath, { event: "start", nonce: "m1", outcome: "creating" });
	assert.equal((statSync(ledgerPath).mode & 0o777).toString(8), "600");
	appendLedgerEvent(ledgerPath, { event: "start", nonce: "m2", outcome: "creating" });
	assert.equal((statSync(ledgerPath).mode & 0o777).toString(8), "600");
});

// ─── R-Q9g/h：真实 raw 入口 canary——直接调用实际 producer 喂未处理原始数据（不经预投影/预分类替身）───

test("raw 门①：原始凭据诊断 outcome 直接入实际 producer → 映射固定类别 unknown，无 canary", () => {
	const dir = mkdtempSync(join(tmpdir(), "pin-privacy-raw-"));
	dirs.push(dir);
	const ledgerPath = join(dir, "ledger-raw-outcome.jsonl");
	// 直接喂原始诊断（生产中 waitOwnerGone/inspect 异常的形态），不经任何测试本地分类
	const rawDiagnostic = `connect failed: pi-env serve --token ${CANARY_TOKEN} exit 1`;
	appendLedgerEvent(ledgerPath, { event: "unknown", nonce: "raw-1", outcome: rawDiagnostic });
	const record = JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, unknown>;
	assert.equal(record.outcome, "unknown", "任意非枚举 outcome 必须映射固定类别 unknown");
	assertNoCanary(ledgerPath);
});

test("raw 门②：嵌套 raw identity（command/env/token）直接入实际 producer → 深投影无 canary/完整 argv", () => {
	const dir = mkdtempSync(join(tmpdir(), "pin-privacy-raw-"));
	dirs.push(dir);
	const ledgerPath = join(dir, "ledger-raw-driver.jsonl");
	// 直接喂 raw driverProbe shape（R8 泄漏的确切形态：identity.command 含 token + 嵌套 env）
	appendLedgerEvent(ledgerPath, {
		event: "inspect",
		nonce: "raw-2",
		outcome: "driver-probed",
		driver: { pid: 1234, identity: { ppid: 111, pgid: 222, birth: "Sat Oct 17 10:00:00 2026", command: canaryIdentity.command, env: { token: CANARY_TOKEN } } },
	});
	const record = JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, unknown>;
	const driver = record.driver as Record<string, unknown>;
	assert.deepEqual(Object.keys(driver).sort(), ["birth", "pgid", "pid", "ppid"], "raw identity 必须被深挑为安全子字段");
	assert.equal(driver.pid, 1234);
	assert.equal(driver.ppid, 111);
	assert.equal(driver.pgid, 222);
	assertNoCanary(ledgerPath);
});

test("raw 门③：raw 未知对象/附加字段直接入实际 producer → 丢弃或安全占位，无 canary 泄漏", () => {
	const dir = mkdtempSync(join(tmpdir(), "pin-privacy-raw-"));
	dirs.push(dir);
	const ledgerPath = join(dir, "ledger-raw-extra.jsonl");
	appendLedgerEvent(ledgerPath, {
		event: "unknown",
		nonce: "raw-3",
		outcome: { nested: `--token ${CANARY_TOKEN}` }, // 非字符串 outcome（对象）
		driver: null,
		extraUnknown: { token: CANARY_TOKEN }, // 未白名单顶层键
		stderr: `raw stderr --token ${CANARY_TOKEN}`, // 未白名单顶层键
	} as Record<string, unknown>);
	const record = JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, unknown>;
	assert.equal(record.outcome, "unknown", "非字符串 outcome 映射 unknown");
	assert.equal("extraUnknown" in record, false, "未白名单顶层键丢弃");
	assert.equal("stderr" in record, false, "未白名单顶层键丢弃");
	assertNoCanary(ledgerPath);
});

test("raw 门④：创建即 0600——不存在 0644 创建后 chmod 补的权限窗口（stat 在首写后立即可验）", () => {
	const dir = mkdtempSync(join(tmpdir(), "pin-privacy-raw-"));
	dirs.push(dir);
	const ledgerPath = join(dir, "ledger-atomic-mode.jsonl");
	appendLedgerEvent(ledgerPath, { event: "start", nonce: "raw-4", outcome: "creating" });
	// 首写后立即验证：文件创建即 0600（writeFileSync mode 选项＝ O_CREAT mode，无中间态）
	assert.equal((statSync(ledgerPath).mode & 0o777).toString(8), "600");
});

// ─── R-Q10b：OUTCOME 枚举生产固定类别序列化往返保真（真实 producer 落盘读回，非 producer 前 spy）───

// grok round-10 R-Q10b：生产可达但此前 OUTCOME_ALLOWED 缺失的 7 个固定类别（原文精确串，源码为准）
const PRODUCTION_OUTCOME_STRINGS = [
	"generation 未采得/无效而 owner 存活——identity 未知，拒绝判 reuse/gone",
	"gone-pid-reused（birth 不同）",
	"identity drift（同 birth，ppid/pgid/marker 变更）",
	"inspect-gone: live",
	"driver-gone-pid-reused",
	"gone",
	"zombie",
] as const;

test("R-Q10b：7 个生产固定类别经实际 appendLedgerEvent 序列化往返保真（不被静默改写 unknown）", () => {
	const dir = mkdtempSync(join(tmpdir(), "pin-privacy-enum-"));
	dirs.push(dir);
	for (const [i, outcome] of PRODUCTION_OUTCOME_STRINGS.entries()) {
		const ledgerPath = join(dir, `ledger-enum-${i}.jsonl`);
		appendLedgerEvent(ledgerPath, { event: "inspect", nonce: `enum-${i}`, outcome });
		const record = JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, unknown>;
		assert.equal(record.outcome, outcome, `固定类别必须原样落盘，不得坍缩 unknown: ${outcome}`);
	}
});

test("R-Q10b：枚举外 outcome（拼接 canary）经实际 producer 仍映射 unknown，无泄漏", () => {
	const dir = mkdtempSync(join(tmpdir(), "pin-privacy-enum-"));
	dirs.push(dir);
	const ledgerPath = join(dir, "ledger-enum-canary.jsonl");
	appendLedgerEvent(ledgerPath, { event: "unknown", nonce: "enum-canary", outcome: `gone-pid-reused（birth 不同）--token ${CANARY_TOKEN}` });
	const record = JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, unknown>;
	assert.equal(record.outcome, "unknown", "枚举外任意串（含 canary 拼接）必须映射固定 unknown");
	assertNoCanary(ledgerPath);
});

test("R-Q10b 附注：driver {unknown:…} 形态保固定安全类别（不返回空对象、不透 raw 未知串）", () => {
	const dir = mkdtempSync(join(tmpdir(), "pin-privacy-driver-"));
	dirs.push(dir);
	const p1 = join(dir, "driver-shape-1.jsonl");
	// driverProbe 不可观测分支的实际传入形态：{unknown:"未找到 driver 进程"}
	appendLedgerEvent(p1, { event: "inspect", nonce: "drv-1", outcome: "driver-probed", driver: { unknown: "未找到 driver 进程" } });
	const r1 = JSON.parse(readFileSync(p1, "utf8")) as Record<string, unknown>;
	assert.deepEqual(r1.driver, { unknown: "未找到 driver 进程" }, "固定安全串必须保留，不得坍缩空对象");
	const p2 = join(dir, "driver-shape-2.jsonl");
	// raw 未知形态串（可能内嵌诊断）必须收敛固定类别，不透传原文
	appendLedgerEvent(p2, { event: "inspect", nonce: "drv-2", outcome: "driver-probed", driver: { unknown: `ps 非零 --token ${CANARY_TOKEN}` } });
	const r2 = JSON.parse(readFileSync(p2, "utf8")) as Record<string, unknown>;
	assert.deepEqual(r2.driver, { unknown: "未找到 driver 进程" }, "raw 未知串必须收敛固定类别");
	assertNoCanary(p2);
});

// ─── R-Q10a：throw/聚合通道负控——fake canary 诊断直接进真实 throw/聚合路径（不经测试本地预消毒）───

test("R-Q10a：waitOwnerGone unknown throw 固定类别+pid，message 无 canary（r17 oracle 同构负控）", async () => {
	const CANARY = "THROW_CHANNEL_CANARY_WAITOWNERGONE";
	const events: Array<Record<string, unknown>> = [];
	await assert.rejects(
		waitOwnerGone({
			observer: () => ({ status: 1, stdout: `--token ${CANARY}`, stderr: "" }),
			pid: 100,
			generation: { ppid: 101, pgid: 102, birth: "Sat Oct 17 10:00:00 2026", marker: "purefake-marker" },
			nonce: "throw-canary",
			deadlineMs: 50,
			ledger: (e) => { events.push(e); },
		}),
		(error: Error) => {
			assert.match(error.message, /unknown/, "固定类别保留在 throw（失败语义不削弱）");
			assert.match(error.message, /100/, "必要 pid 保留");
			assert.equal(error.message.includes(CANARY), false, "throw message 不得含 raw ps 输出");
			assert.equal(error.message.includes("--token"), false);
			return true;
		},
	);
	assert.equal(events.at(-1)?.outcome, "unknown", "ledger 固定类别保留");
});

test("R-Q10a：observeBirth unknown throw 固定类别+pid，message 无 canary（真实 DaemonResource.track 路径）", async () => {
	const CANARY = "THROW_CHANNEL_CANARY_OBSERVEBIRTH";
	const events: Array<Record<string, unknown>> = [];
	await assert.rejects(
		DaemonResource.track({
			connection: { snapshot: async () => ({ info: { pid: 4242 }, sessionId: 7 }), close: () => {} },
			observer: () => ({ status: 1, stdout: `--token ${CANARY}`, stderr: "" }),
			kill: () => {},
			ledger: (e) => { events.push(e); },
			register: () => {},
			nonce: "birth-canary",
			daemonMarker: "/opt/daemon/pi-env",
			expectedParentPid: process.pid,
			deadlineMs: 100,
		}),
		(error: Error) => {
			assert.match(error.message, /unknown/, "固定类别保留在 throw");
			assert.equal(error.message.includes(CANARY), false, "throw message 不得含 raw ps 输出");
			return true;
		},
	);
	assert.ok(events.some((e) => e.outcome === "birth-observe-unknown"), "ledger 固定类别保留");
});

test("R-Q10a：runAllCleanups 聚合只出固定类别+索引+计数，raw message 不透传，全部 callback 执行", async () => {
	const CANARY = "THROW_CHANNEL_CANARY_AGGREGATE";
	const executed: string[] = [];
	const error = await runAllCleanups([
		() => { executed.push("a"); throw new Error(`first token ${CANARY}`); },
		() => { executed.push("b"); },
		() => { executed.push("c"); throw new Error(`second --token ${CANARY}`); },
	]);
	assert.ok(error instanceof Error);
	assert.deepEqual(executed, ["a", "b", "c"], "全部 cleanup 必须执行");
	assert.match(error.message, /2\/3/, "聚合计数保真");
	assert.match(error.message, /#1/);
	assert.match(error.message, /#3/);
	assert.equal(error.message.includes(CANARY), false, "聚合 message 不得含 raw 失败原文");
});
