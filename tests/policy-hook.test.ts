import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { PiEvent } from "../src/protocol/translate.ts";
import { PiSession } from "../src/rpc/pi-session.ts";

/**
 * 验证 Phase 1（路线 C）确实能拿到钩子级拦截粒度。
 *
 * 策略文档把这条列为 P1·W5 的第一件事：走不通就必须下调 Phase 1 的审计
 * 验收标准（「100% 工具调用有记录、0 例绕过审批门」）。这组测试就是那个
 * 验证的回归形式 —— 用 mock 模型端点驱动真实的模型工具调用，因为
 * tool_call 钩子只由模型工具调用触发，RPC 的 bash 直接命令不经过它。
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MOCK = join(REPO, "tests/fixtures/mock-model.mjs");
const EXT = join(REPO, "src/gateway/policy-extension.ts");
const POLICY = join(REPO, "config/policy.yaml");

const cleanups: (() => void)[] = [];
after(() => {
	for (const c of cleanups) c();
});

interface Harness {
	session: PiSession;
	events: PiEvent[];
	workspace: string;
	uiRequests: Record<string, unknown>[];
	waitFor: (pred: () => boolean, ms?: number) => Promise<void>;
}

async function startMock(script: unknown[]): Promise<{ port: number; proc: ChildProcess }> {
	const proc = spawn(process.execPath, [MOCK, "0", JSON.stringify(script)], { stdio: ["ignore", "pipe", "inherit"] });
	cleanups.push(() => proc.kill());
	const port: number = await new Promise((r) => proc.stdout?.once("data", (d) => r(JSON.parse(d.toString()).port)));
	return { port, proc };
}

async function start(script: unknown[], approvalTimeoutMs = 60_000): Promise<Harness> {
	const { port } = await startMock(script);
	const home = mkdtempSync(join(tmpdir(), "pihome-"));
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(
		join(home, ".pi", "agent", "models.json"),
		JSON.stringify({
			providers: {
				mock: {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "dummy",
					compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
					models: [{ id: "mock-model" }],
				},
			},
		}),
	);

	const workspace = mkdtempSync(join(tmpdir(), "ws-"));
	const events: PiEvent[] = [];
	const uiRequests: Record<string, unknown>[] = [];
	const session = new PiSession({
		cwd: workspace,
		args: ["--no-session", "--provider", "mock", "--model", "mock-model", "-e", EXT],
		env: {
			...process.env,
			HOME: home,
			PERIMETER_POLICY_FILE: POLICY,
			PERIMETER_APPROVAL_TIMEOUT_MS: String(approvalTimeoutMs),
			PERIMETER_REPO: "web",
			PERIMETER_TEAM: "platform",
		},
		onEvent: (e) => {
			events.push(e);
			if (e.type === "extension_ui_request") uiRequests.push(e as Record<string, unknown>);
		},
		onResponse: () => {},
		onExit: () => {},
	});
	cleanups.push(() => void session.stop());

	const waitFor = async (pred: () => boolean, ms = 15_000) => {
		const deadline = Date.now() + ms;
		while (!pred()) {
			if (Date.now() > deadline) throw new Error("waitFor 超时");
			await new Promise((r) => setTimeout(r, 20));
		}
	};
	return { session, events, workspace, uiRequests, waitFor };
}

function dialogs(h: Harness) {
	return h.uiRequests.filter((r) => r.method === "select");
}

function audits(h: Harness): Record<string, unknown>[] {
	return h.uiRequests
		.filter((r) => r.method === "notify" && String(r.message ?? "").startsWith("@@perimeter-audit@@"))
		.map((r) => JSON.parse(String(r.message).slice("@@perimeter-audit@@".length)));
}

function toolEnd(h: Harness): Record<string, unknown> | undefined {
	return h.events.find((e) => e.type === "tool_execution_end") as Record<string, unknown> | undefined;
}

test("allow：普通命令照常执行，并留下判决记录", async () => {
	const h = await start([{ tool: "bash", args: { command: "echo 命中允许分支" } }, { text: "完成" }]);
	await h.session.request({ type: "prompt", message: "run it" });
	await h.waitFor(() => toolEnd(h) !== undefined);

	const end = toolEnd(h)!;
	assert.equal(end.isError, false);
	assert.match(JSON.stringify(end.result), /命中允许分支/);
	assert.equal(dialogs(h).length, 0, "allow 不应打扰用户");
	assert.equal(audits(h)[0]?.kind, "allow");
});

test("deny：策略拒绝的写入不会落到磁盘上", async () => {
	const h = await start([
		{ tool: "write", args: { path: ".github/workflows/evil.yml", content: "on: push" } },
		{ text: "完成" },
	]);
	await h.session.request({ type: "prompt", message: "write it" });
	await h.waitFor(() => toolEnd(h) !== undefined);

	assert.equal(existsSync(join(h.workspace, ".github/workflows/evil.yml")), false, "被拒绝的写入必须没有实际发生");
	assert.match(JSON.stringify(toolEnd(h)), /策略拒绝/);
	assert.equal(dialogs(h).length, 0, "deny 是终局，不问人");
	const audit = audits(h).find((a) => a.kind === "deny");
	assert.equal(audit?.rule, "ci-iac-secrets-off-limits");
});

test("require_approval：拒绝后工具不执行", async () => {
	const h = await start([{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "完成" }]);
	await h.session.request({ type: "prompt", message: "bump deps" });
	await h.waitFor(() => dialogs(h).length > 0);

	h.session.send({ type: "extension_ui_response", id: dialogs(h)[0]!.id, value: "拒绝" });
	await h.waitFor(() => toolEnd(h) !== undefined);

	assert.equal(existsSync(join(h.workspace, "package.json")), false);
	assert.match(JSON.stringify(toolEnd(h)), /未获批准/);
	const decision = audits(h).find((a) => a.kind === "approval.decision");
	assert.equal(decision?.approved, false);
	assert.equal(decision?.timedOut, false);
});

test("require_approval：批准后工具正常执行", async () => {
	const h = await start([{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "完成" }]);
	await h.session.request({ type: "prompt", message: "bump deps" });
	await h.waitFor(() => dialogs(h).length > 0);

	h.session.send({ type: "extension_ui_response", id: dialogs(h)[0]!.id, value: "批准" });
	await h.waitFor(() => toolEnd(h) !== undefined);

	assert.equal(existsSync(join(h.workspace, "package.json")), true);
	assert.equal(audits(h).find((a) => a.kind === "approval.decision")?.approved, true);
});

test("审批超时按拒绝处理 —— 无人应答不等于同意", async () => {
	const h = await start([{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "完成" }], 1500);
	await h.session.request({ type: "prompt", message: "bump deps" });
	await h.waitFor(() => dialogs(h).length > 0);
	// 刻意不回复
	await h.waitFor(() => toolEnd(h) !== undefined);

	assert.equal(existsSync(join(h.workspace, "package.json")), false);
	const decision = audits(h).find((a) => a.kind === "approval.decision");
	assert.equal(decision?.approved, false);
	assert.equal(decision?.timedOut, true);
});

test("审批对话被取消也按拒绝处理", async () => {
	const h = await start([{ tool: "write", args: { path: "package.json", content: "{}" } }, { text: "完成" }]);
	await h.session.request({ type: "prompt", message: "bump deps" });
	await h.waitFor(() => dialogs(h).length > 0);

	h.session.send({ type: "extension_ui_response", id: dialogs(h)[0]!.id, cancelled: true });
	await h.waitFor(() => toolEnd(h) !== undefined);
	assert.equal(existsSync(join(h.workspace, "package.json")), false);
});
