import { join } from "node:path";
import { Gateway } from "../../src/gateway/server.ts";
const dir = process.env.PERIMETER_TEST_ROOT!;
const gateway = new Gateway({ port: 0, host: "127.0.0.1", token: "test-gateway-token", policyFile: "config/policy.yaml", auditFile: join(dir, "gateway.jsonl"),
	workspaceRoot: join(dir, "workspaces"), stateRoot: join(dir, "state"), webRoot: "web", approvalTimeoutMs: 30_000,
	model: { baseUrl: process.env.PERIMETER_TEST_MODEL_URL!, token: "test-model-token", model: "mock-model" } });
console.log(JSON.stringify({ port: await gateway.listen() }));
process.on("SIGTERM", () => { void gateway.close().finally(() => process.exit()); });
