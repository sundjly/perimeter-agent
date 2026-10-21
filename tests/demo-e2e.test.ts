import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { AuditLog } from "../src/audit/log.ts";
import { Gateway } from "../src/gateway/server.ts";
import { GitCredentialProxy } from "../src/gitproxy/server.ts";
import { signGrant } from "../src/gitproxy/grants.ts";
import { ModelGateway } from "../src/modelgw/server.ts";
import type { ClientEvent } from "../src/protocol/types.ts";

/**
 * C3 验收（合同 §4 C3 / §7「demo 双进程真实跑通一轮 clone+push」）：
 * 在测试内按 scripts/demo.ts 的拓扑真实组装——
 *
 *   mock 模型(子进程) → ModelGateway → Gateway(gitGrants 开、wiring 指向代理)
 *   git-http-server.mjs(本地上游，子进程) → GitCredentialProxy(registry 真实轮询
 *   Gateway 的 /internal/git/registry，listen 后回填 url，同 demo)
 *
 * 全链路：会话启动经代理 clone → 模型 write 源码文件（放行）→ bash git push 被
 * 审批门拦下 → approver 批准 → 推送真的到达上游 → 审计 identity 来自 grant →
 * 沙箱（workspace + HOME）全树零凭据泄漏。
 *
 * 与 scripts/demo.ts 的唯一差异：session 元数据**预置** approver 角色（生产里成员
 * 配置同样是带外动作）。这是刻意的，不是绕过：B2 设计是「acl 变更即撤销旧 grant」，
 * 而审批命令只认 approver 角色——若在运行中 share 一个 approver，grant 恰在 push
 * 之前被撤销，C3 流程自相矛盾。成员带外预置不触发 ACL 变更，链路其余接线与 demo
 * 完全一致（真实轮询、真实子进程、真实 git 二进制）。
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MOCK = join(REPO, "tests/fixtures/mock-model.mjs");
const GIT_SERVER = join(REPO, "tests/fixtures/git-http-server.mjs");
const UPSTREAM_GIT_TOKEN = "UPSTREAM-GIT-TOKEN-never-leaves-proxy";
const UPSTREAM_AUTH = `Basic ${Buffer.from(`x-access-token:${UPSTREAM_GIT_TOKEN}`).toString("base64")}`;
const GATEWAY_TOKEN = "GATEWAY-TOKEN-c3-e2e";
const PROXY_TOKEN = "PROXY-TOKEN-c3-e2e";
const MASTER_KEY = randomBytes(32);
const INTERNAL_TOKEN = randomBytes(24).toString("base64url");
const SID = "c3demo1";
const OWNER = "demo@local";
const APPROVER = "approver@local";

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups) await c();
});

const exec = promisify(execFile);

/** git 子进程一律异步 execFile（同步阻塞会让 node:test 超时失效，见 git-e2e 的坑） */
async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	return exec("git", args, {
		cwd,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: cwd,
			GIT_AUTHOR_NAME: "seed",
			GIT_AUTHOR_EMAIL: "seed@s",
			GIT_COMMITTER_NAME: "seed",
			GIT_COMMITTER_EMAIL: "seed@s",
			GIT_TERMINAL_PROMPT: "0",
		},
	});
}

/** 等子进程报告端口；必须带兜底，否则启动失败时静默挂死（同 demo） */
function waitPort(proc: ChildProcess, what: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${what} 启动超时`)), 10_000);
		proc.stdout?.once("data", (d) => {
			clearTimeout(timer);
			try {
				resolve(JSON.parse(d.toString()).port);
			} catch (e) {
				reject(new Error(`${what} 未报告端口：${String(e)}`));
			}
		});
	});
}

/** 递归收集目录下所有文件内容（二进制跳过）——沿用 git-e2e/wiring 的全树扫描方式 */
function readAllFiles(dir: string, out: { path: string; text: string }[] = []): { path: string; text: string }[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) readAllFiles(p, out);
		else {
			try {
				out.push({ path: p, text: readFileSync(p, "utf8") });
			} catch {
				// 二进制或不可读文件跳过 —— 凭据是文本，不会藏在这里
			}
		}
	}
	return out;
}

test("C3：demo 双进程拓扑真实跑通 —— 会话启动经代理 clone、审批后 push 到达上游、grant 身份留痕、零凭据泄漏", async () => {
	// ① mock 模型（子进程）：一次 write 源码文件 + 一次 bash git add/commit/push + 结尾文本
	const script = [
		{ tool: "write", args: { path: "src/timeout.ts", content: "export const TIMEOUT_MS = 30_000;\n" } },
		{ tool: "bash", args: { command: "git add -A && git commit -qm 'fix: raise login timeout to 30s' && git push origin main" } },
		{ text: "源码已修改，并在审批通过后推送到 main。" },
	];
	const mock = spawn(process.execPath, [MOCK, "0", JSON.stringify(script)], { stdio: ["ignore", "pipe", "inherit"] });
	cleanups.push(() => void mock.kill());
	const mockPort = await waitPort(mock, "mock 模型");

	// ② 模型网关 —— 唯一持有上游模型凭据的进程
	const dir = mkdtempSync(join(tmpdir(), "c3-"));
	const mgwAudit = AuditLog.open(join(dir, "modelgw.jsonl"));
	cleanups.push(() => mgwAudit.close());
	const modelGw = new ModelGateway({
		port: 0,
		host: "127.0.0.1",
		token: PROXY_TOKEN,
		upstreams: [{ id: "upstream", baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "UPSTREAM-MODEL-KEY-only-in-mgw" }],
		egressAllowlist: ["127.0.0.1"],
		audit: mgwAudit,
	});
	cleanups.push(() => modelGw.close());
	const modelPort = await modelGw.listen();

	// ③ 本地上游：带一次提交的裸仓库 + smart HTTP 服务（子进程）
	const scmRoot = mkdtempSync(join(tmpdir(), "c3-scm-"));
	const upstreamRepo = join(scmRoot, "app.git");
	const seed = mkdtempSync(join(tmpdir(), "c3-seed-"));
	await git(["init", "-q", "-b", "main"], seed);
	writeFileSync(join(seed, "README.md"), "C3 upstream seed\n");
	await git(["add", "."], seed);
	await git(["commit", "-qm", "初始提交"], seed);
	await git(["init", "-q", "--bare", upstreamRepo], scmRoot);
	await git(["remote", "add", "origin", upstreamRepo], seed);
	await git(["push", "-q", "origin", "main"], seed);
	const headBefore = (await git(["rev-parse", "refs/heads/main"], upstreamRepo)).stdout.trim();

	const scm = spawn(process.execPath, [GIT_SERVER, scmRoot, UPSTREAM_AUTH], { stdio: ["ignore", "pipe", "inherit"] });
	cleanups.push(() => void scm.kill());
	const scmPort = await waitPort(scm, "git 上游服务");

	// ④ git 凭据代理 —— registry 真实轮询网关 internal 端点（禁止内存 stub 替代轮询路径）
	const gitAudit = AuditLog.open(join(dir, "gitproxy.jsonl"));
	cleanups.push(() => gitAudit.close());
	const gitProxy = new GitCredentialProxy({
		port: 0,
		host: "127.0.0.1",
		mode: "dev", // demo 双进程：显式 dev 模式（同 demo.ts）
		masterKey: MASTER_KEY,
		registry: { url: "", internalToken: INTERNAL_TOKEN, pollMs: 200 },
		audit: gitAudit,
		repos: [
			{
				name: "git.internal/app.git",
				upstream: `http://127.0.0.1:${scmPort}/app.git`,
				username: "x-access-token",
				token: UPSTREAM_GIT_TOKEN,
				allowPush: true,
			},
		],
	});
	cleanups.push(() => gitProxy.close());
	const gitProxyPort = await gitProxy.listen();

	// ⑤ Gateway（gitGrants 开；wiring 指向代理）。
	// 会话元数据预置 approver（成员带外预置，不触发 ACL 变更撤销 grant，见文件头说明）。
	// stateRoot 显式指定：默认值是 workspaceRoot+".state" 的字符串拼接（无路径分隔符），
	// 预置路径必须与之完全一致才能被网关读到（R72-v5 教训：路径不一致则成员预置被静默忽略）。
	const workspaceRoot = join(dir, "workspaces");
	const stateRoot = join(dir, "state");
	const metaDir = join(stateRoot, "sessions", SID);
	mkdirSync(metaDir, { recursive: true });
	// 网关把 stateRoot/sessions 的存在视为「已初始化实例」：revocations.json 缺失即
	// fail-closed 拒启动（正确的生产保护，勿改生产）。预置空吊销表，格式与
	// #loadRevocations 的解析一致（revoked 数组）。
	writeFileSync(join(stateRoot, "revocations.json"), JSON.stringify({ revoked: [], updatedAt: new Date().toISOString() }), { mode: 0o600 });
	writeFileSync(join(metaDir, "meta.json"), JSON.stringify({
		id: SID, owner: OWNER, repo: "git.internal/app.git", team: "platform", createdAt: new Date().toISOString(),
		members: { [OWNER]: "owner", [APPROVER]: "approver" }, aclVersion: 1,
	}));
	const gateway = new Gateway({
		mode: "demo",
		port: 0,
		host: "127.0.0.1",
		token: GATEWAY_TOKEN,
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit.jsonl"),
		workspaceRoot,
		stateRoot,
		webRoot: join(REPO, "web"),
		gitGrants: {
			masterKey: MASTER_KEY,
			internalToken: INTERNAL_TOKEN,
			writeRefs: ["refs/heads/*"],
			repos: [{ name: "git.internal/app.git", allowPush: true }],
		},
		wiring: {
			gitProxyToken: "", // B2：最终值由网关在会话接入时用 gitGrants 签发的 per-session grant 覆盖
			proxyToken: PROXY_TOKEN,
			modelGatewayUrl: `http://127.0.0.1:${modelPort}/v1`,
			model: "mock-model",
			gitProxyUrl: `http://127.0.0.1:${gitProxyPort}`,
			scmHosts: ["git.internal"],
		},
		repoUrl: "https://git.internal/app.git",
		approvalTimeoutMs: 120_000,
	});
	cleanups.push(() => gateway.close());
	const gwPort = await gateway.listen();
	// C3：网关端口就绪后回填代理 registry url（同 demo.ts 的 late-bound 接线）
	gitProxy.setRegistryUrl(`http://127.0.0.1:${gwPort}/internal/git/registry`);

	// 等代理真实拉到 registry 快照再接会话（否则 clone 会撞上「快照缺失」fail-closed）。
	// 探针 grant：签名合法但 session 未登记——deny summary 落到「epoch 不一致/未登记」
	// 即证明快照已在位（「快照缺失」则说明还没拉到）。
	const probeGrant = signGrant({
		v: 1, tenant: "probe", principal: "probe", session: "probe-s", repo: "git.internal/app.git",
		caps: { read: true, write: false, writeRefs: [] }, exp: Date.now() + 60_000, jti: "probe-jti",
		epoch: "epoch-probe", aclVersion: 1,
	} as never, MASTER_KEY, Date.now());
	{
		const deadline = Date.now() + 10_000;
		for (;;) {
			await fetch(`http://127.0.0.1:${gitProxyPort}/git.internal/app.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${probeGrant}` } });
			let ready = false;
			for await (const e of AuditLog.replay(join(dir, "gitproxy.jsonl"))) {
				if (e.verdict === "deny" && /epoch 与 registry 快照不一致|session 未在活会话登记/.test(e.summary)) ready = true;
			}
			if (ready) break;
			if (Date.now() > deadline) throw new Error("git 代理未及时拉取 registry 快照");
			await new Promise((r) => setTimeout(r, 100));
		}
	}

	// ⑥ 双 WS 连接：owner 发任务，approver 审批。非 event 帧（control 错误/close）全部
	// 收集进 frames —— 否则 attach 被拒/命令被拒时无任何可见证据（R72-v4 教训）
	const events: ClientEvent[] = [];
	const frames: string[] = [];
	const owner = new WebSocket(`ws://127.0.0.1:${gwPort}/?token=${GATEWAY_TOKEN}&actor=${OWNER}&session=${SID}`);
	owner.on("message", (raw) => {
		const m = JSON.parse(String(raw));
		if (m.type === "control") frames.push(`owner control: ${JSON.stringify(m)}`);
		else if (m.event) events.push(m.event);
	});
	owner.on("close", (code, reason) => frames.push(`owner close: ${code} ${String(reason)}`));
	await new Promise((r) => owner.once("open", r));
	cleanups.push(() => void owner.close());

	// 超时诊断：error 事件 + 全部 control/close 帧（已知秘密值替换为 ***，截断到 500 字符）
	const SECRETS = [GATEWAY_TOKEN, PROXY_TOKEN, UPSTREAM_GIT_TOKEN, UPSTREAM_AUTH, INTERNAL_TOKEN, MASTER_KEY.toString("hex"), MASTER_KEY.toString("base64")];
	const mask = (s: string): string => SECRETS.reduce((acc, t) => (t ? acc.split(t).join("***") : acc), s);
	const errorDump = (): string => {
		const errs = events.filter((e) => e.type === "error").map((e) => JSON.stringify(e));
		return mask(([...errs, ...frames].join(" | ") || "(无 error/控制帧)").slice(0, 500));
	};
	const waitFor = async (pred: () => boolean, ms = 30_000): Promise<void> => {
		const deadline = Date.now() + ms;
		while (!pred()) {
			if (Date.now() > deadline) throw new Error(`超时；已收到事件：${events.map((e) => e.type).join(",")}；error 内容：${errorDump()}`);
			await new Promise((r) => setTimeout(r, 20));
		}
	};

	// 会话启动完成 = clone 已经经代理发生（#start 内 clone 先于 session.ready）
	await waitFor(() => events.some((e) => e.type === "session.ready"));
	assert.ok(existsSync(join(workspaceRoot, SID, ".git")), "会话启动必须经凭据代理完成 clone");
	assert.match(readFileSync(join(workspaceRoot, SID, "README.md"), "utf8"), /C3 upstream seed/, "clone 的必须是上游种子内容");

	const approver = new WebSocket(`ws://127.0.0.1:${gwPort}/?token=${GATEWAY_TOKEN}&actor=${APPROVER}&session=${SID}`);
	approver.on("message", (raw) => {
		const m = JSON.parse(String(raw));
		if (m.type === "control") frames.push(`approver control: ${JSON.stringify(m)}`);
		else if (m.event) events.push(m.event);
	});
	approver.on("close", (code, reason) => frames.push(`approver close: ${code} ${String(reason)}`));
	await new Promise((r) => approver.once("open", r));
	cleanups.push(() => void approver.close());
	await waitFor(() => events.some((e) => e.type === "session.snapshot"));

	owner.send(JSON.stringify({ type: "prompt", requestId: randomUUID(), text: "修复登录超时并推送到 main" }));

	// write 放行 → bash git push 被审批门拦下（policy: git push* require_approval）
	await waitFor(() => events.some((e) => e.type === "approval.request"));
	const approval = events.find((e) => e.type === "approval.request") as { approvalId: string };
	approver.send(JSON.stringify({ type: "approve", approvalId: approval.approvalId, decision: "allow" }));

	await waitFor(() => events.some((e) => e.type === "agent.end" && !e.willRetry));

	// 审批后上游 main 真的出现该提交
	const log = (await git(["log", "--oneline", "-3", "refs/heads/main"], upstreamRepo)).stdout;
	assert.match(log, /fix: raise login timeout/, "审批后的 push 必须真实到达上游");
	const headAfter = (await git(["rev-parse", "refs/heads/main"], upstreamRepo)).stdout.trim();
	assert.notEqual(headAfter, headBefore, "上游 main HEAD 必须因 push 前进");
	// 源码文件也真实写进了沙箱工作区
	assert.match(readFileSync(join(workspaceRoot, SID, "src", "timeout.ts"), "utf8"), /TIMEOUT_MS/);

	// 审计：git.push allow，identity 来自 grant claims（session/principal/tenant），非客户端自报
	const gitEntries = [];
	for await (const e of AuditLog.replay(join(dir, "gitproxy.jsonl"))) gitEntries.push(e);
	const push = gitEntries.find((e) => e.kind === "git.push" && e.verdict === "allow");
	assert.ok(push, "push 必须留痕");
	assert.equal(push!.sessionId, SID, "审计 sessionId 必须来自 grant claims.session");
	assert.equal(push!.actor, OWNER, "审计 actor 必须来自 grant claims.principal");
	assert.equal(push!.team, "platform", "审计 team 必须来自 grant claims.tenant");

	// 沙箱侧（workspace + 沙箱 HOME）全树零凭据泄漏
	const files = [...readAllFiles(join(workspaceRoot, SID)), ...readAllFiles(join(workspaceRoot, ".homes", SID))];
	assert.ok(files.length > 3, "应当扫到成组文件，否则这条断言是空转");
	for (const f of files) {
		assert.ok(!f.text.includes(UPSTREAM_GIT_TOKEN), `上游 git 凭据泄漏到 ${f.path}`);
		assert.ok(!f.text.includes(UPSTREAM_AUTH), `上游 Basic 凭据泄漏到 ${f.path}`);
		assert.ok(!f.text.includes(INTERNAL_TOKEN), `registry internalToken 泄漏到 ${f.path}`);
		assert.ok(!f.text.includes(MASTER_KEY.toString("hex")) && !f.text.includes(MASTER_KEY.toString("base64")), `masterKey 泄漏到 ${f.path}`);
		assert.ok(!f.text.includes(GATEWAY_TOKEN), `网关 token 泄漏到 ${f.path} —— agent 读到就能批准自己的审批`);
		assert.ok(!f.text.includes(PROXY_TOKEN), `模型代理 token 泄漏到 ${f.path}`);
	}
});
