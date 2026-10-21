import { existsSync } from "node:fs";
import { join } from "node:path";
import { Gateway } from "../../src/gateway/server.ts";
import { AuditLog } from "../../src/audit/log.ts";
const dir = process.env.PERIMETER_TEST_ROOT!;
// S3c 测试注入（默认不启用）：PERIMETER_TEST_AUDIT_BREAK_MARKER 存在时，网关改用外部持有的
// AuditLog 实例，并在标记文件出现后 close 它——模拟「审计不可用」故障（readyz 翻红、执行面
// fail-closed）。不影响默认行为：未设置 env 时仍走 auditFile 自开。
const auditBreakMarker = process.env.PERIMETER_TEST_AUDIT_BREAK_MARKER;
const breakableAudit = auditBreakMarker ? AuditLog.open(join(dir, "gateway.jsonl")) : undefined;
if (breakableAudit && auditBreakMarker) {
	const poll = setInterval(() => {
		try { if (existsSync(auditBreakMarker)) { breakableAudit.close(); clearInterval(poll); } } catch { /* 保留探询 */ }
	}, 50);
	poll.unref();
}
const gateway = new Gateway({ mode: "demo", port: 0, host: "127.0.0.1", token: "test-gateway-token", policyFile: "config/policy.yaml", auditFile: join(dir, "gateway.jsonl"),
	workspaceRoot: join(dir, "workspaces"), stateRoot: join(dir, "state"), webRoot: "web", approvalTimeoutMs: 30_000,
	model: { baseUrl: process.env.PERIMETER_TEST_MODEL_URL!, token: "test-model-token", model: "mock-model" },
	// S3b 测试注入：显式 create 在 workspace_ready 收据落盘后永久挂起 —— 让测试能在窗口内 kill -9，
	// 真实模拟「创建中途崩溃」（隐式创建不经过 probe，连接建立不受影响）。
	...(process.env.PERIMETER_TEST_CREATE_PROBE_PARK ? {
		createStageProbe: (stage: "accepted" | "workspace_ready") => (stage === "workspace_ready" ? new Promise<void>(() => { /* 挂起 */ }) : undefined),
	} : {})
	, ...(breakableAudit ? { auditInstance: breakableAudit } : {}) });
console.log(JSON.stringify({ port: await gateway.listen() }));
process.on("SIGTERM", () => { void gateway.close().finally(() => process.exit()); });
