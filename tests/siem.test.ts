import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AuditLog } from "../src/audit/log.ts";
import { toCef, toEcs } from "../src/audit/siem.ts";
import { summarizeAction, toActionDescriptor } from "../src/protocol/translate.ts";

/**
 * SIEM 导出。
 *
 * 这一层要守的不是格式细节，是**边界**：导出把数据送出 Data Plane，
 * 而 SIEM 常在客户网络的另一头甚至是托管服务。所以最要紧的两条是
 * 「默认不带命令原文」与「按白名单挑字段」。
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const exec = promisify(execFile);
const cleanups: (() => void)[] = [];
const tmpDirs: string[] = [];
after(() => {
	for (const c of cleanups) c();
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** 造一份含各类事件的审计日志 */
function makeLog(): { file: string; entries: ReturnType<AuditLog["append"]>[] } {
	const dir = mkdtempSync(join(tmpdir(), "siem-"));
	tmpDirs.push(dir);
	const file = join(dir, "audit.jsonl");
	const log = AuditLog.open(file);
	cleanups.push(() => log.close());
	const base = { sessionId: "s1", actor: "alice@corp", repo: "web", team: "platform" };
	// **用真实的 summarizeAction 产物**，不手写。上一版夹具写死了
	// summary: "bash: cat .env"，于是「默认不导出命令」这条保证一路绿灯，
	// 而生产里 summary = `${tool}: ${命令前 120 字符}`，凭据就在里面。
	// 用真实长度的 token：凭据规则要求 ≥16 字符，拿一个 15 字符的假值测
	// 等于在测一个现实中不存在的形态
	const cmd = 'curl -H "Authorization: Bearer sk-liveKEY0000111122223333444455556666" https://api.x';
	const action = toActionDescriptor("bash", { command: cmd });
	const entries = [
		log.append({ ...base, kind: "session.start", summary: "会话开始" }),
		log.append({
			...base,
			kind: "tool.call",
			summary: summarizeAction(action),
			tool: "bash",
			command: cmd,
			callId: "call_abc",
			argsHash: "a".repeat(64),
		}),
		log.append({ ...base, kind: "policy.verdict", summary: "拒绝：写 CI 配置", verdict: "deny", rule: "ci-iac-secrets-off-limits" }),
		log.append({ ...base, kind: "approval.decision", summary: "已批准 git push", verdict: "allow", approver: "bob@corp" }),
		log.append({ ...base, kind: "usage", summary: "计量", tokensTotal: 1234, cost: 0.02 }),
	];
	log.close();
	return { file, entries };
}

test("默认不导出命令原文 —— summary 也要重建，否则这条保证是装饰性的", () => {
	const { entries } = makeLog();
	const toolCall = entries[1]!;
	assert.ok(toolCall.command?.includes("sk-liveKEY0000111122223333444455556666"), "前提：审计里确实存了原文");
	// 关键前提：summary 本身就含命令原文，只关掉 command 字段是不够的
	assert.ok(toolCall.summary.includes("sk-liveKEY0000111122223333444455556666"), "前提：summary 由 summarizeAction 生成，含命令前 120 字符");

	const ecs = JSON.stringify(toEcs(toolCall));
	const cef = toCef(toolCall);
	assert.ok(!ecs.includes("sk-liveKEY0000111122223333444455556666"), "ECS 默认不得带出命令原文");
	assert.ok(!cef.includes("sk-liveKEY0000111122223333444455556666"), "CEF 默认不得带出命令原文");
	// 但 hash 要在 —— SOC 侧据此关联，而它不泄漏内容
	assert.equal(toEcs(toolCall)["perimeter.args_hash"], "a".repeat(64));
});

test("raw 档才带命令原文", () => {
	const { entries } = makeLog();
	const ecs = toEcs(entries[1]!, { command: "raw" });
	assert.match(String(ecs["process.command_line"]), /sk-liveKEY0000111122223333444455556666/);
	// 断言值本身，不只是标签 —— cs5= 为空也能匹配上标签
	// CEF 扩展值里可以有空格（右边界靠下一个 `key=` 判定），所以别用 [^ ]*
	assert.match(toCef(entries[1]!, { command: "raw" }), /cs5Label=command cs5=.*sk-liveKEY/);
});

test("redacted 档：带命令但凭据被打码", () => {
	const { entries } = makeLog();
	const ecs = toEcs(entries[1]!, { command: "redacted" });
	const line = String(ecs["process.command_line"]);
	assert.ok(line.includes("curl"), "命令结构要留着，SOC 才知道 agent 干了什么");
	assert.ok(!line.includes("sk-liveKEY0000111122223333444455556666"), "已知形态的凭据必须打码");
	// summary 同样走脱敏
	assert.ok(!String(ecs.message).includes("sk-liveKEY0000111122223333444455556666"));
});

test("callId 被导出 —— 否则 SIEM 里没法把 call 与 result 配对", () => {
	const { entries } = makeLog();
	assert.equal(toEcs(entries[1]!)["process.entity_id"], "call_abc");
	assert.match(toCef(entries[1]!), /cs9Label=callId cs9=call_abc/);
});

test("ECS 必填字段与告警维度", () => {
	const { entries } = makeLog();
	// ecs.version 是 ECS 里唯一的必填字段
	assert.equal(toEcs(entries[0]!)["ecs.version"], "8.11.0");
	// deny 走 alert：Elastic Security 的告警面板按 event.kind 取事件
	assert.equal(toEcs(entries[2]!)["event.kind"], "alert");
	assert.equal(toEcs(entries[2]!)["event.type"], "denied");
	assert.equal(toEcs(entries[0]!)["event.kind"], "event");
	// 放行不该进 IDS 分类，否则每次工具调用都有一条，仪表盘会被淹没
	assert.equal(toEcs(entries[2]!)["event.category"], "intrusion_detection");
	assert.notEqual(toEcs(entries[3]!)["event.category"], "intrusion_detection");
});

test("审批被拒的严重度低于策略拦截 —— 之前那个分支不可达", () => {
	const { entries } = makeLog();
	// approval.decision + deny 曾被 `verdict === deny → 8` 先命中，
	// 意图里的 6 永远取不到，而 severityOf 是告警规则的输入
	const denied = { ...entries[3]!, verdict: "deny" };
	assert.equal(toEcs(denied)["event.severity"], 6);
	assert.equal(toEcs(entries[2]!)["event.severity"], 8);
});

test("CEF 与 ECS 的字段覆盖对齐 —— 用 CEF 的客户不该少拿哈希链", () => {
	const { entries } = makeLog();
	const cef = toCef(entries[2]!);
	assert.match(cef, /cs6Label=prevHash/, "没有 prevHash 就无法验证链的连续性");
	assert.match(cef, /cs7Label=repo/);
	assert.match(cef, /cs8Label=team/);
});

test("按白名单挑字段 —— 审计里加字段不会悄悄多导出一份", () => {
	const { entries } = makeLog();
	// 往条目上塞一个导出层不认识的字段
	const withExtra = { ...entries[0]!, secretNote: "内部备注不该出边界" } as never;
	const ecs = JSON.stringify(toEcs(withExtra));
	assert.ok(!ecs.includes("secretNote"), "未登记的字段不得进导出");
	assert.ok(!ecs.includes("内部备注"), "未登记字段的值同样不得进导出");
	assert.ok(!toCef(withExtra).includes("内部备注"));
});

test("哈希链一并导出 —— SIEM 侧据此发现日志被改过", () => {
	const { entries } = makeLog();
	const ecs = toEcs(entries[2]!);
	assert.equal(ecs["perimeter.hash"], entries[2]!.hash);
	assert.equal(ecs["perimeter.prev_hash"], entries[2]!.prevHash);
	// 相邻两条要能对上，否则 SIEM 侧没法验证连续性
	assert.equal(toEcs(entries[2]!)["perimeter.prev_hash"], entries[1]!.hash);
});

test("拒绝与审批的严重度高于普通事件 —— 告警规则建在这个字段上", () => {
	const { entries } = makeLog();
	const sev = (i: number) => Number(toEcs(entries[i]!)["event.severity"]);
	assert.ok(sev(2) > sev(0), "策略拒绝必须比会话开始更显眼");
	assert.ok(sev(3) > sev(0), "审批决定同理");
	assert.equal(toEcs(entries[2]!)["event.outcome"], "failure", "deny 的 outcome 必须是 failure");
});

test("CEF 的分隔符被转义 —— 否则内容能撑破字段边界", () => {
	const d = mkdtempSync(join(tmpdir(), "siem-"));
	tmpDirs.push(d);
	const file = join(d, "a.jsonl");
	const log = AuditLog.open(file);
	cleanups.push(() => log.close());
	// summary 进 CEF 头，管道符会被当作字段分隔
	const entry = log.append({
		kind: "error",
		sessionId: "s|1",
		actor: "a=b",
		summary: "出错|中断\n第二行",
	});
	log.close();

	const cef = toCef(entry);
	// 头部是前 7 个**未转义**的 `|`：CEF:0|Vendor|Product|Version|Sig|Name|Severity|Ext
	const unescapedPipes = [...cef.matchAll(/(?<!\\)\|/g)].length;
	assert.equal(unescapedPipes, 7, `头被内容撑破了：${cef}`);
	// CEF 是一行一条，嵌一个换行就把一条日志拆成两条 ——
	// 后半条会被 SIEM 当格式错误丢掉，而丢掉的可能正是那条 deny
	assert.ok(!/\n/.test(cef), "换行会把一条日志拆成两条");
	assert.match(cef, /\\=/, "扩展值里的 = 要转义");
	assert.match(cef, /出错\\\|中断/, "头里的 | 要转义");
});

test("ECS 的时间与时长用标准单位", () => {
	const d = mkdtempSync(join(tmpdir(), "siem-"));
	tmpDirs.push(d);
	const file = join(d, "a.jsonl");
	const log = AuditLog.open(file);
	cleanups.push(() => log.close());
	const entry = log.append({ kind: "repo.clone", sessionId: "s", actor: "a", summary: "clone", durationMs: 120 });
	log.close();

	const ecs = toEcs(entry);
	assert.equal(ecs["@timestamp"], entry.at, "时间戳用 ISO 8601");
	assert.equal(ecs["event.duration"], 120_000_000, "ECS 的 event.duration 单位是纳秒");
});

test("CLI：默认不带命令原文，--include-command 才带", async () => {
	const { file } = makeLog();
	const script = join(REPO, "scripts/export-siem.ts");

	const plain = await exec(process.execPath, [script, file]);
	assert.ok(!plain.stdout.includes("sk-liveKEY0000111122223333444455556666"), "CLI 默认不得导出命令原文");
	assert.equal(plain.stdout.trim().split("\n").length, 5);

	const raw = await exec(process.execPath, [script, file, "--command", "raw"]);
	assert.ok(raw.stdout.includes("sk-liveKEY0000111122223333444455556666"));

	const red = await exec(process.execPath, [script, file, "--command", "redacted"]);
	assert.ok(red.stdout.includes("curl"), "redacted 档要留下命令结构");
	assert.ok(!red.stdout.includes("sk-liveKEY0000111122223333444455556666"));
});

test("CLI：--format cef 与 --since 生效", async () => {
	const { file } = makeLog();
	const script = join(REPO, "scripts/export-siem.ts");

	const cef = await exec(process.execPath, [script, file, "--format", "cef"]);
	assert.ok(cef.stdout.startsWith("CEF:0|Perimeter|"));

	const since = await exec(process.execPath, [script, file, "--since", "3"]);
	assert.equal(since.stdout.trim().split("\n").length, 2, "--since 应当只导出其后的条目");
});

test("CLI：所有畸形输入都要显式失败，不能静默产出", async () => {
	const { file } = makeLog();
	const script = join(REPO, "scripts/export-siem.ts");
	const cases: [string[], string][] = [
		[[file, "--format", "splunk"], "不支持的格式"],
		[[file, "--since", "abc"], "非数字的 --since 会让过滤器整个失效"],
		[[file, "--session"], "缺值的 --session 会静默导出全部会话 —— 方向最糟"],
		[[file, "--format"], "缺值的 --format 会绕过格式校验"],
		[["/nonexistent/audit.jsonl"], "文件不存在时不能伪装成「今天没有事件」"],
	];
	for (const [argv, why] of cases) {
		// execFile 的错误 message 是 "Command failed: …"，不含退出码；查 err.code
		await assert.rejects(
			exec(process.execPath, [script, ...argv]),
			(err: NodeJS.ErrnoException) => {
				assert.equal(err.code, 2, `${why}（退出码应为 2）`);
				return true;
			},
			why,
		);
	}
});

test("CLI：flag 在文件名之前也能正确解析", async () => {
	// `--format cef a.jsonl` 曾把 "cef" 当成文件名，导出 0 条却以退出码 0 结束
	const { file } = makeLog();
	const res = await exec(process.execPath, [join(REPO, "scripts/export-siem.ts"), "--format", "cef", file]);
	assert.equal(res.stdout.trim().split("\n").length, 5);
	assert.ok(res.stdout.startsWith("CEF:0|"));
});

test("CLI：--session 只导出该会话", async () => {
	const { file } = makeLog();
	const res = await exec(process.execPath, [join(REPO, "scripts/export-siem.ts"), file, "--session", "nobody"]);
	assert.equal(res.stdout.trim(), "", "不存在的会话应当导出 0 条");
});
