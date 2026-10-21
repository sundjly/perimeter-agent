import { join } from "node:path";
import { Gateway } from "../gateway/server.ts";
import { LocalBackend } from "../gateway/execution-backend.ts";

const runRoot = process.env.PERIMETER_RUN_ROOT!;
const sessionId = process.env.PERIMETER_SESSION_ID || "benchmark-session";
const modelUrl = process.env.PERIMETER_MODEL_URL!;
const policyFile = process.env.PERIMETER_POLICY_FILE || "config/policy.yaml";
const webRoot = process.env.PERIMETER_WEB_ROOT || "web";
const token = process.env.PERIMETER_TOKEN || `tok-${sessionId}`;
const stateRoot = process.env.PERIMETER_STATE_ROOT || join(runRoot, "state", sessionId);
const workspaceRoot = process.env.PERIMETER_WORKSPACE_ROOT || join(runRoot, "workspaces");
const auditFile = process.env.PERIMETER_AUDIT_FILE || join(runRoot, `audit-${sessionId}.jsonl`);

const gateway = new Gateway({
	mode: "demo",
	port: 0,
	host: "127.0.0.1",
	token,
	policyFile,
	auditFile,
	workspaceRoot,
	stateRoot,
	webRoot,
	approvalTimeoutMs: 10_000,
	model: {
		baseUrl: modelUrl,
		token: "benchmark-proxy-token",
		model: "mock-model",
	},
	backend: new LocalBackend(),
});

const port = await gateway.listen();
console.log(JSON.stringify({ port, pid: process.pid }));

let closing = false;
async function gracefulClose() {
	if (closing) return;
	closing = true;
	try {
		await gateway.close();
	} catch (err) {
		console.error("Gateway subprocess close error:", err);
	}
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
	const line = chunk.toString().trim();
	if (line === "close") {
		process.stdin.pause();
		await gracefulClose();
	}
});

process.on("SIGTERM", async () => {
	await gracefulClose();
	// 异常/外部强行终止保护
	setTimeout(() => process.exit(0), 1000).unref();
});
