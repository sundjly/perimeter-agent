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
 * 两个用例：
 * ① approver 由会话元数据**预置**（生产里成员配置同样是带外动作），链路 clone→write→
 *    push 审批→批准→上游。
 * ② R74 主流程：不预置 approver——owner 运行中 share 新增 approver（acl 变更撤旧 grant
 *    并以新 aclVersion 重签，方案 a），approver 再接入批准，push 真达上游。
 *
 * 全链路断言：clone 经代理、push 真达上游、审计 identity 来自 grant、沙箱（workspace +
 * HOME）全树零凭据泄漏。全部清理（Gateway/代理/模型网关 close、kill 子进程、ws close）。
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

/** 按 scripts/demo.ts 拓扑组装双进程环境；approverPreseeded=true 时元数据预置 approver 成员 */
async function startC3Topology(opts: { approverPreseeded?: boolean } = {}): Promise<{
	dir: string;
	workspaceRoot: string;
	upstreamRepo: string;
	headBefore: string;
	gwPort: number;
	gitAuditPath: string;
}> {
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
	// stateRoot 显式指定：默认值是 workspaceRoot+".state" 的字符串拼接（无路径分隔符），
	// 预置路径必须与之完全一致才能被网关读到（R72-v5 教训）。
	// approverPreseeded 时会话元数据预置 approver 成员（成员带外预置，不触发 ACL 变更撤销
	// grant）；share 用例不预置——运行中 share 新增 approver（R74 重签机制）。
	const workspaceRoot = join(dir, "workspaces");
	const stateRoot = join(dir, "state");
	if (opts.approverPreseeded) {
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
	}
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
		// 同 demo.ts：策略作用域由服务端推导（share 例不预置元数据时，team 落 platform）
		resolveScope: () => ({ repo: "demo-app", team: "platform" }),
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
	return { dir, workspaceRoot, upstreamRepo, headBefore, gwPort, gitAuditPath: join(dir, "gitproxy.jsonl") };
}

const SECRETS = [GATEWAY_TOKEN, PROXY_TOKEN, UPSTREAM_GIT_TOKEN, UPSTREAM_AUTH, INTERNAL_TOKEN, MASTER_KEY.toString("hex"), MASTER_KEY.toString("base64")];
const mask = (s: string): string => SECRETS.reduce((acc, t) => (t ? acc.split(t).join("***") : acc), s);

/** 会话连接 + 事件/控制帧收集（超时诊断用）+ 有界 waitFor（不得 sleep 轮询无上限） */
function makeSessionTools(gwPort: number, events: ClientEvent[], frames: string[]) {
	const connect = async (actor: string): Promise<WebSocket> => {
		const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/?token=${GATEWAY_TOKEN}&actor=${actor}&session=${SID}`);
		ws.on("message", (raw) => {
			const m = JSON.parse(String(raw));
			if (m.type === "control") frames.push(`${actor} control: ${JSON.stringify(m)}`);
			else if (m.event) events.push(m.event);
		});
		ws.on("close", (code, reason) => frames.push(`${actor} close: ${code} ${String(reason)}`));
		await new Promise((r) => ws.once("open", r));
		cleanups.push(() => void ws.close());
		return ws;
	};
	const errorDump = (): string => {
		const errs = events.filter((e) => e.type === "error").map((e) => JSON.stringify(e));
		return mask(([...errs, ...frames].join(" | ") || "(无 error/控制帧)").slice(0, 500));
	};
	const waitFor = async (pred: () => boolean, ms = 30_000): Promise<void> => {
		const deadline = Date.now() + ms;
		while (!pred()) {
			if (Date.now() > deadline) throw new Error(`超时；已收到事件：${events.map((e) => e.type).join(",")}；error/帧：${errorDump()}`);
			await new Promise((r) => setTimeout(r, 20));
		}
	};
	return { connect, waitFor, errorDump };
}

/** 沙箱（workspace + HOME）全树六类秘密零泄漏 */
function assertSandboxClean(workspaceRoot: string, sid: string): void {
	const files = [...readAllFiles(join(workspaceRoot, sid)), ...readAllFiles(join(workspaceRoot, ".homes", sid))];
	assert.ok(files.length > 3, "应当扫到成组文件，否则这条断言是空转");
	for (const f of files) {
		assert.ok(!f.text.includes(UPSTREAM_GIT_TOKEN), `上游 git 凭据泄漏到 ${f.path}`);
		assert.ok(!f.text.includes(UPSTREAM_AUTH), `上游 Basic 凭据泄漏到 ${f.path}`);
		assert.ok(!f.text.includes(INTERNAL_TOKEN), `registry internalToken 泄漏到 ${f.path}`);
		assert.ok(!f.text.includes(MASTER_KEY.toString("hex")) && !f.text.includes(MASTER_KEY.toString("base64")), `masterKey 泄漏到 ${f.path}`);
		assert.ok(!f.text.includes(GATEWAY_TOKEN), `网关 token 泄漏到 ${f.path} —— agent 读到就能批准自己的审批`);
		assert.ok(!f.text.includes(PROXY_TOKEN), `模型代理 token 泄漏到 ${f.path}`);
	}
}

test("C3：demo 双进程拓扑真实跑通 —— 会话启动经代理 clone、审批后 push 到达上游、grant 身份留痕、零凭据泄漏（approver 预置）", async () => {
	const { dir, workspaceRoot, upstreamRepo, headBefore, gwPort, gitAuditPath } = await startC3Topology({ approverPreseeded: true });
	const events: ClientEvent[] = [];
	const frames: string[] = [];
	const { connect, waitFor, errorDump } = makeSessionTools(gwPort, events, frames);

	const ownerWs = await connect(OWNER);
	// 会话启动完成 = clone 已经经代理发生（#start 内 clone 先于 session.ready）
	await waitFor(() => events.some((e) => e.type === "session.ready"));
	assert.ok(existsSync(join(workspaceRoot, SID, ".git")), "会话启动必须经凭据代理完成 clone");
	assert.match(readFileSync(join(workspaceRoot, SID, "README.md"), "utf8"), /C3 upstream seed/, "clone 的必须是上游种子内容");

	const approverWs = await connect(APPROVER);
	await waitFor(() => events.some((e) => e.type === "session.snapshot"));

	ownerWs.send(JSON.stringify({ type: "prompt", requestId: randomUUID(), text: "修复登录超时并推送到 main" }));

	// write 放行 → bash git push 被审批门拦下（policy: git push* require_approval）
	await waitFor(() => events.some((e) => e.type === "approval.request"));
	const approval = events.find((e) => e.type === "approval.request") as { approvalId: string };
	approverWs.send(JSON.stringify({ type: "approve", approvalId: approval.approvalId, decision: "allow" }));

	await waitFor(() => events.some((e) => e.type === "agent.end" && !e.willRetry));

	// 审批后上游 main 真的出现该提交
	const log = (await git(["log", "--oneline", "-3", "refs/heads/main"], upstreamRepo)).stdout;
	assert.match(log, /fix: raise login timeout/, "审批后的 push 必须真实到达上游");
	const headAfter = (await git(["rev-parse", "refs/heads/main"], upstreamRepo)).stdout.trim();
	assert.notEqual(headAfter, headBefore, "上游 main HEAD 必须因 push 前进");
	assert.match(readFileSync(join(workspaceRoot, SID, "src", "timeout.ts"), "utf8"), /TIMEOUT_MS/);

	// 审计：git.push allow，identity 来自 grant claims（session/principal/tenant），非客户端自报
	const gitEntries = [];
	for await (const e of AuditLog.replay(gitAuditPath)) gitEntries.push(e);
	const push = gitEntries.find((e) => e.kind === "git.push" && e.verdict === "allow");
	assert.ok(push, "push 必须留痕");
	assert.equal(push!.sessionId, SID, "审计 sessionId 必须来自 grant claims.session");
	assert.equal(push!.actor, OWNER, "审计 actor 必须来自 grant claims.principal");
	assert.equal(push!.team, "platform", "审计 team 必须来自 grant claims.tenant");

	assertSandboxClean(workspaceRoot, SID);
	void errorDump;
});

test("C3：运行中 share 新增 approver 后审批 push 到达上游（R74 重签：share 即撤旧签新）", async () => {
	// 不预置 approver 成员——真实四眼流：owner 运行中 share approver → acl 变更撤旧 grant
	// 并以新 aclVersion 重签（R74 方案 a，agent 无感）→ approver 接入批准 → push 真达上游。
	const { dir, workspaceRoot, upstreamRepo, headBefore, gwPort, gitAuditPath } = await startC3Topology({ approverPreseeded: false });
	const events: ClientEvent[] = [];
	const frames: string[] = [];
	const { connect, waitFor, errorDump } = makeSessionTools(gwPort, events, frames);

	const ownerWs = await connect(OWNER);
	await waitFor(() => events.some((e) => e.type === "session.ready"));
	assert.ok(existsSync(join(workspaceRoot, SID, ".git")), "会话启动必须经凭据代理完成 clone");

	// owner 运行中 share 新增 approver（防自批：share 人 ≠ 被分享人，规则未放宽）
	ownerWs.send(JSON.stringify({ type: "share", actor: APPROVER, role: "approver" }));

	// R74：share 即撤旧 grant 并以新 aclVersion 重签——沙箱 HOME .gitconfig 的 grant 随即更换
	const home = join(workspaceRoot, ".homes", SID);
	const grantFromHome = (): string => {
		const m = readFileSync(join(home, ".gitconfig"), "utf8").match(/x-session:([^@\s]+)@/);
		assert.ok(m, "沙箱 HOME .gitconfig 必须携带 grant");
		return m[1]!;
	};
	const grant0 = grantFromHome();
	const deadline = Date.now() + 5_000;
	while (grantFromHome() === grant0) {
		if (Date.now() > deadline) throw new Error("share 后 grant 未重签（HOME .gitconfig 未更换）");
		await new Promise((r) => setTimeout(r, 50));
	}
	const grant1 = grantFromHome();
	assert.notEqual(grant1, grant0, "重签后的 grant 必须是新串");

	// approver 接入并批准
	const approverWs = await connect(APPROVER);
	await waitFor(() => events.some((e) => e.type === "session.snapshot"));

	ownerWs.send(JSON.stringify({ type: "prompt", requestId: randomUUID(), text: "修复登录超时并推送到 main" }));
	await waitFor(() => events.some((e) => e.type === "approval.request"));
	const approval = events.find((e) => e.type === "approval.request") as { approvalId: string };
	approverWs.send(JSON.stringify({ type: "approve", approvalId: approval.approvalId, decision: "allow" }));

	await waitFor(() => events.some((e) => e.type === "agent.end" && !e.willRetry));

	// push 用的是重签后的 grant（旧 jti 已吊销）——上游真到达
	const log = (await git(["log", "--oneline", "-3", "refs/heads/main"], upstreamRepo)).stdout;
	assert.match(log, /fix: raise login timeout/, "share 后审批的 push 必须真实到达上游");
	const headAfter = (await git(["rev-parse", "refs/heads/main"], upstreamRepo)).stdout.trim();
	assert.notEqual(headAfter, headBefore);

	// 审计：push allow 且 identity 来自重签 grant（session/tenant 真值）
	const gitEntries = [];
	for await (const e of AuditLog.replay(gitAuditPath)) gitEntries.push(e);
	const push = gitEntries.find((e) => e.kind === "git.push" && e.verdict === "allow");
	assert.ok(push, "push 必须留痕");
	assert.equal(push!.sessionId, SID);
	assert.equal(push!.actor, OWNER);
	assert.equal(push!.team, "platform");

	assertSandboxClean(workspaceRoot, SID);
	void errorDump;
});
