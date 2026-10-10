import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AuditLog } from "../../src/audit/log.ts";
import { ModelGateway } from "../../src/modelgw/server.ts";
import type { ClientEvent } from "../../src/protocol/types.ts";
import { HarnessHost } from "../../src/runtime/harness-host.ts";

export async function fixture(script: unknown[], run: (host: HarnessHost, dir: string, reopen: () => Promise<HarnessHost>, events: ClientEvent[]) => Promise<void>, timeout = 200) {
	const dir = mkdtempSync(join(tmpdir(), "durable-"));
	const mock = spawn(process.execPath, ["tests/fixtures/mock-model.mjs", "0", JSON.stringify(script), join(dir, "requests.jsonl")]);
	const [chunk] = await once(mock.stdout!, "data");
	const port = JSON.parse(String(chunk)).port;
	const audit = AuditLog.open(join(dir, "audit.jsonl"));
	const mgw = new ModelGateway({ port: 0, host: "127.0.0.1", token: "model-token", egressAllowlist: ["127.0.0.1"],
		upstreams: [{ id: "mock", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "upstream-secret" }], audit });
	const mp = await mgw.listen();
	const events: ClientEvent[] = [];
	const opts = { sessionId: "test", file: join(dir, "state/session.sqlite"), workspace: join(dir, "workspace"), actor: "alice", repo: "default", team: "default",
		policyFile: "config/policy.yaml", audit, model: { baseUrl: `http://127.0.0.1:${mp}/v1`, token: "model-token", model: "mock-model" }, approvalTimeoutMs: timeout, emit: (event: ClientEvent) => events.push(event) };
	let host: HarnessHost | undefined;
	try {
		host = await HarnessHost.open(opts);
		await run(host, dir, async () => { await host!.close(); host = await HarnessHost.open(opts); return host; }, events);
	} finally {
		try { await host?.close(); } finally {
			try { await mgw.close(); } finally {
				try { audit.close(); } finally {
					mock.kill();
					rmSync(dir, { recursive: true, force: true });
				}
			}
		}
	}
}

