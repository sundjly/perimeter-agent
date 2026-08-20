import { existsSync } from "node:fs";
import { AuditLog } from "../src/audit/log.ts";
import { type CommandMode, type SiemFormat, formatEntry } from "../src/audit/siem.ts";

/**
 * 把审计日志导出为 SIEM 可吃的格式。
 *
 *   node scripts/export-siem.ts <audit.jsonl> [--format ecs|cef] [--session <id>]
 *                                             [--since <seq>] [--include-command]
 *
 * 默认 **不导出** bash 命令原文，**连 summary 也会重建** —— summary 由
 * summarizeAction 生成，形如 `bash: <命令前 120 字符>`，本身就承载原文。
 * `--command redacted` 会把已知形态的凭据打码（挡不住 heredoc 里的源码），
 * `--command raw` 原样带出，届时你应当知道 SIEM 在谁的网络里。
 */
const args = process.argv.slice(2);

function fail(msg: string): never {
	console.error(msg);
	process.exit(2);
}

/** 取 flag 的值。缺值或后面跟着另一个 flag 都要报错 —— 静默回落到默认值
 *  在这个模块里方向最糟：用户意图是收窄导出范围，结果却是全量外发。 */
function flag(name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	if (i < 0) return undefined;
	const v = args[i + 1];
	if (v === undefined || v.startsWith("--")) fail(`--${name} 缺少值`);
	return v;
}

const FLAGS_WITH_VALUE = new Set(["--format", "--session", "--since"]);
/** 文件名是第一个既非 flag、又不是某个 flag 的值的参数。
 *  只用 `!startsWith("--")` 的话，`--format cef a.jsonl` 会把 "cef" 当文件名，
 *  导出 0 条并以退出码 0 结束 —— 合规流水线会静默交付空文件。 */
function positional(): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a.startsWith("--")) {
			if (FLAGS_WITH_VALUE.has(a)) i += 1;
			continue;
		}
		return a;
	}
	return undefined;
}

const file = positional();
if (!file) {
	fail("用法：node scripts/export-siem.ts <audit.jsonl> [--format ecs|cef] [--session <id>] [--since <seq>] [--command off|redacted|raw]");
}
if (!existsSync(file)) {
	// 「文件不存在」与「今天没有事件」必须区分开：定时任务喂 SIEM 时，
	// 前者是审计断供，不能伪装成后者
	fail(`审计日志不存在：${file}`);
}

const format = (flag("format") ?? "ecs") as SiemFormat;
if (format !== "ecs" && format !== "cef") fail(`不支持的格式：${format}（只有 ecs 与 cef）`);

const command = (flag("command") ?? "off") as CommandMode;
if (!["off", "redacted", "raw"].includes(command)) fail(`不支持的命令档位：${command}（off | redacted | raw）`);

const sinceRaw = flag("since") ?? "0";
if (!/^\d+$/.test(sinceRaw)) fail(`--since 必须是非负整数：${sinceRaw}`);
const since = Number(sinceRaw);

let n = 0;
for await (const entry of AuditLog.replay(file, flag("session"))) {
	if (entry.seq <= since) continue;
	console.log(formatEntry(entry, format, { command }));
	n += 1;
}
console.error(`已导出 ${n} 条（${format}，命令档位 ${command}）`);
