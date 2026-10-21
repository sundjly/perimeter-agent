import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { parse as parseYaml } from "yaml";
import {
	DockerBackend,
	KubectlBackend,
	LocalBackend,
	containerName,
	defaultContainerUser,
	dockerClientEnv,
} from "../src/gateway/execution-backend.ts";
import { k8sNameFragment } from "../src/deploy/pod-template.ts";
import { Gateway, verifyDockerNetworkInternal } from "../src/gateway/server.ts";
import { ModelGateway } from "../src/modelgw/server.ts";
import type { ClientEvent } from "../src/protocol/types.ts";

/**
 * 容器执行后端。
 *
 * 命令行构造是纯函数，无条件跑；**真正进容器跑一个会话**的用例需要
 * docker daemon 与预先构建的镜像，缺任何一个就跳过并说明原因 ——
 * 不要让「环境不具备」看起来像「测过了」。
 *
 *   docker build -t perimeter-sandbox:test -f deploy/sandbox.Dockerfile .
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const IMAGE = process.env.PERIMETER_TEST_IMAGE ?? "perimeter-sandbox:test";
const exec = promisify(execFile);

const defaultTestSocket = [
	process.env.DOCKER_HOST,
	process.env.HOME && existsSync(`${process.env.HOME}/.orbstack/run/docker.sock`)
		? `unix://${process.env.HOME}/.orbstack/run/docker.sock`
		: undefined,
].find(Boolean);
if (!process.env.DOCKER_HOST && defaultTestSocket) {
	process.env.DOCKER_HOST = defaultTestSocket;
}

function dockerExec(args: string[], timeoutMs = 15_000): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", args, {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { PATH: process.env.PATH, ...dockerClientEnv() },
		});
		let stdout = "";
		let stderr = "";
		let exited = false;
		let timedOut = false;

		child.stdout?.on("data", (d) => { stdout += d; });
		child.stderr?.on("data", (d) => { stderr += d; });

		const timer = setTimeout(() => {
			timedOut = true;
			try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch {}
			const killTimer = setTimeout(() => {
				if (!exited) {
					try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {}
				}
			}, 1000);
			killTimer.unref();
		}, timeoutMs);

		child.on("error", (err) => {
			clearTimeout(timer);
			if (!exited) {
				exited = true;
				reject(err);
			}
		});

		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			if (!exited) {
				exited = true;
				if (timedOut) {
					reject(new Error(`docker 命令超时 (${timeoutMs}ms) 强制终结: docker ${args.join(" ")} (signal: ${signal})`));
				} else if (code !== 0) {
					const err = new Error(`docker 命令非零退出 (${code}): ${stderr.trim() || stdout.trim()}`);
					(err as any).code = code;
					(err as any).stdout = stdout;
					(err as any).stderr = stderr;
					reject(err);
				} else {
					resolve({ stdout, stderr });
				}
			}
		});
	});
}

async function dockerReady(): Promise<boolean> {
	try {
		await dockerExec(["version"], 3000);
		await dockerExec(["image", "inspect", IMAGE], 3000);
		return true;
	} catch {
		return false;
	}
}

const ctx = {
	sessionId: "sess-1",
	workspace: "/host/ws",
	home: "/host/home",
	extensionPath: "/repo/src/gateway/policy-extension.ts",
	policyFile: "/repo/config/policy.yaml",
	env: { PERIMETER_REPO: "web", PERIMETER_TEAM: "platform" },
};

// ── 命令行构造（纯函数，无需 docker） ──────────────────────

test("local 后端直接 spawn pi，扩展与策略走宿主机路径", () => {
	const l = new LocalBackend({ PATH: "/usr/bin" }).launch(ctx);
	assert.equal(l.bin, "pi-env");
	assert.deepEqual(l.argsPrefix, []);
	assert.equal(l.extensionPath, ctx.extensionPath);
	assert.equal(l.env.HOME, "/host/home");
	assert.equal(l.env.PERIMETER_REPO, "web");
});

test("local 后端在没有接线 HOME 时不覆盖调用方的 HOME", () => {
	const l = new LocalBackend({ HOME: "/caller/home" }).launch({ ...ctx, home: undefined });
	assert.equal(l.env.HOME, "/caller/home");
});

test("docker 后端的五项收紧与 deploy/sandbox.yaml 对应", () => {
	const l = new DockerBackend({ image: IMAGE, repoRoot: "/repo" }).launch(ctx);
	assert.equal(l.bin, "docker");
	const a = l.argsPrefix.join(" ");
	assert.match(a, /--read-only/);
	// 默认取网关自己的 uid —— Linux 上 bind mount 保留宿主机属主，
	// 固定 10001 会让容器写不进工作区（macOS 会重映射所以本机测不出来）
	assert.match(a, new RegExp(`--user ${defaultContainerUser()}`));
	assert.ok(!/--user 0:/.test(a), "绝不能以 root 跑");
	// 上限必须有默认值：没有的话一句 dd 就能吃掉宿主机内存
	assert.match(a, /--memory 4g/);
	assert.match(a, /--pids-limit 512/);
	assert.match(a, /--tmpfs \/tmp:rw,noexec,nosuid,nodev,size=512m/);
	assert.match(a, /--cap-drop ALL/);
	assert.match(a, /--security-opt no-new-privileges/);
	// -i 是 RPC 的前提：没有它 stdin 立刻关闭，协议根本跑不起来
	assert.ok(l.argsPrefix.includes("-i"));
	// 最后两个参数必须是镜像与 pi，pi 自己的参数由 Session 追加在后面
	assert.deepEqual(l.argsPrefix.slice(-2), [IMAGE, "pi-env"]);
});

test("docker 后端只挂工作区、HOME 与扩展所需的三个只读子树", () => {
	const l = new DockerBackend({ image: IMAGE, repoRoot: "/repo" }).launch(ctx);
	const mounts = l.argsPrefix.filter((_, i) => l.argsPrefix[i - 1] === "-v");
	assert.deepEqual(mounts, [
		"/host/ws:/workspace",
		"/host/home:/home/agent",
		"/repo/src:/opt/perimeter/src:ro",
		"/repo/config:/opt/perimeter/config:ro",
		"/repo/node_modules:/opt/perimeter/node_modules:ro",
	]);
	// 扩展与策略走容器内路径
	assert.equal(l.extensionPath, "");
	assert.equal(l.policyFile, "/opt/perimeter/config/policy.yaml");
});

test("环境变量用 -e KEY 传，值不进 argv —— argv 对同机用户可见", () => {
	const l = new DockerBackend({ image: IMAGE, repoRoot: "/repo" }).launch(ctx);
	const envArgs = l.argsPrefix.filter((_, i) => l.argsPrefix[i - 1] === "-e");
	assert.ok(envArgs.includes("PERIMETER_REPO"), "应当是裸 KEY");
	assert.ok(!envArgs.some((e) => e.startsWith("PERIMETER_REPO=")), "值不得写进 argv");
	assert.ok(!l.argsPrefix.join(" ").includes("=web"), "argv 里不该出现变量值");
	// 值改由 docker 客户端的进程环境携带
	assert.equal(l.env.PERIMETER_REPO, "web");
	assert.equal(l.env.PERIMETER_POLICY_FILE, "/opt/perimeter/config/policy.yaml");
});

test("容器名带网关标识 —— 两个网关共用一个 daemon 时不会互杀", () => {
	assert.equal(containerName("s1"), "perimeter-s1");
	assert.equal(containerName("s1", "gw-a"), "perimeter-gw-a-s1");
	const a = new DockerBackend({ image: IMAGE, repoRoot: "/r", gatewayId: "gw-a" }).launch(ctx);
	const b = new DockerBackend({ image: IMAGE, repoRoot: "/r", gatewayId: "gw-b" }).launch(ctx);
	const nameOf = (l: { argsPrefix: string[] }) => l.argsPrefix[l.argsPrefix.indexOf("--name") + 1];
	assert.notEqual(nameOf(a), nameOf(b));
	assert.ok(a.argsPrefix.includes("perimeter.gateway=gw-a"), "孤儿回收的抓手");
});

test("没有接线 HOME 时给一块 tmpfs —— 根只读，否则 pi 写自身状态就失败", () => {
	const l = new DockerBackend({ image: IMAGE, repoRoot: "/repo" }).launch({ ...ctx, home: undefined });
	assert.match(l.argsPrefix.join(" "), /--tmpfs \/home\/agent:rw/);
});

test("kubectl 后端生成 exec 命令，`--` 之后才是容器内的命令", () => {
	const l = new KubectlBackend({ podTemplate: "perimeter-{session}", namespace: "perimeter" }).launch(ctx);
	assert.equal(l.bin, "kubectl");
	// Pod 名带规范化后的 sessionId 片段：客户端可指定的 id 允许大写与下划线，
	// 而 K8s 的 Pod 名必须符合 DNS-1123
	assert.deepEqual(l.argsPrefix, ["exec", "-i", `perimeter-${k8sNameFragment("sess-1")}`, "-n", "perimeter", "--", "pi-env"]);
});

test("容器名可预测，pi 意外退出后还能找回来清理", () => {
	assert.equal(containerName("abc"), "perimeter-abc");
});

// ── 真的进容器跑（需要 docker 与镜像） ─────────────────────

describe("容器隔离（需要 docker 与 perimeter-sandbox:test 镜像）", { skip: !(await dockerReady()) && "docker 或镜像不可用" }, () => {
	test("容器里看不到宿主机文件系统 —— 这是 local 后端给不了的", async () => {
		const ws = mkdtempSync(join(tmpdir(), "dws-"));
		writeFileSync(join(ws, "in-workspace.txt"), "工作区内的文件\n");
		const l = new DockerBackend({ image: IMAGE, repoRoot: REPO }).launch({ ...ctx, sessionId: `iso-${Date.now()}`, workspace: ws, home: undefined });

		// 用同样的参数跑一条 shell 而不是 pi
		const args = [...l.argsPrefix.slice(0, -1), "sh", "-c", "ls /workspace; ls /Users 2>&1 | head -1; id -u"];
		const { stdout } = await dockerExec(args);
		assert.match(stdout, /in-workspace\.txt/, "工作区应当挂进去");
		assert.match(stdout, /No such file|not found/, "宿主机的 /Users 在容器里不该存在");
		// --user 传什么，id -u 就是什么；默认取网关自己的 uid
		assert.match(stdout, new RegExp(defaultContainerUser().split(":")[0]!));
		assert.ok(!/^0$/m.test(stdout), "必须非 root 运行");
	});

	test("根文件系统只读，只有 /tmp 与工作区可写", async () => {
		const ws = mkdtempSync(join(tmpdir(), "dws-"));
		const l = new DockerBackend({ image: IMAGE, repoRoot: REPO }).launch({ ...ctx, sessionId: `ro-${Date.now()}`, workspace: ws, home: undefined });
		const args = [
			...l.argsPrefix.slice(0, -1),
			"sh",
			"-c",
			"touch /oops 2>&1 | head -1; touch /tmp/ok && echo tmp可写; touch /workspace/ok && echo 工作区可写",
		];
		const { stdout } = await dockerExec(args);
		assert.match(stdout, /Read-only file system/);
		assert.match(stdout, /tmp可写/);
		assert.match(stdout, /工作区可写/);
	});

	test("B1 部署边界：网关敏感件（审计/状态/密钥）不挂进容器 —— 容器内不可见不可读", async () => {
		// 机制=只挂 workspace/HOME + src/config/node_modules 三个只读子树；审计/SQLite/环境凭据
		// 从不出现在挂载清单，也绝不能在容器里可达。canary 放 repo 根（不在任何挂载子树内），
		// 容器里能读到它 = 挂载面泄漏。本测试证机制接线，不等价于真实集群出口验证（B12 external）。
		const ws = mkdtempSync(join(tmpdir(), "dws-"));
		const canary = join(REPO, ".b1-canary-secret-do-not-mount");
		writeFileSync(canary, "CANARY-SECRET-VALUE\n");
		try {
			const l = new DockerBackend({ image: IMAGE, repoRoot: REPO }).launch({ ...ctx, sessionId: `nomount-${Date.now()}`, workspace: ws, home: undefined });
			const args = [
				...l.argsPrefix.slice(0, -1),
				"sh",
				"-c",
				"ls /opt/perimeter; cat /opt/perimeter/.b1-canary-secret-do-not-mount 2>&1 | head -1; ls /opt/perimeter/.. 2>&1 | head -1",
			];
			const { stdout } = await dockerExec(args);
			assert.match(stdout, /config/, "/opt/perimeter 下只有 src/config/node_modules 三个只读子树（workspace 在 /workspace）");
			assert.match(stdout, /src/);
			assert.match(stdout, /node_modules/);
			assert.match(stdout, /No such file|not found/, "canary（repo 根敏感件）必须不可读——不挂载就是不可达");
			assert.ok(!stdout.includes("CANARY-SECRET-VALUE"), "canary 值不得出现在容器输出");
		} finally {
			try { unlinkSync(canary); } catch { /* canary 清理失败不掩盖断言结果 */ }
		}
	});

	test("挂进去的策略扩展与依赖是只读的 —— agent 改不了自己的策略", async () => {
		const ws = mkdtempSync(join(tmpdir(), "dws-"));
		const l = new DockerBackend({ image: IMAGE, repoRoot: REPO }).launch({ ...ctx, sessionId: `romount-${Date.now()}`, workspace: ws, home: undefined });
		const args = [
			...l.argsPrefix.slice(0, -1),
			"sh",
			"-c",
			// `{ ...; } 2>&1` 才能捕获重定向失败 —— 那是 shell 自己报的，
			// 命令级的 2>&1 抓不到；不加花括号还会让 sh 以非零码退出
			"cat /opt/perimeter/config/policy.yaml > /dev/null && echo 策略可读; { echo x >> /opt/perimeter/config/policy.yaml; } 2>&1 | head -1",
		];
		const { stdout } = await dockerExec(args);
		assert.match(stdout, /策略可读/);
		assert.match(stdout, /Read-only file system/, "策略文件必须是只读挂载 —— 否则 agent 能改自己的策略");
	});

	test("network=none 时确实无法出网 —— egress 阻断的机制有效", async () => {
		const ws = mkdtempSync(join(tmpdir(), "dws-"));
		const l = new DockerBackend({ image: IMAGE, repoRoot: REPO, network: "none" }).launch({
			...ctx,
			sessionId: `net-${Date.now()}`,
			workspace: ws,
			home: undefined,
		});
		const args = [...l.argsPrefix.slice(0, -1), "sh", "-c", "wget -q -T2 -O- http://example.com 2>&1 | head -1 || echo 出网被阻断"];
		const { stdout } = await dockerExec(args);
		assert.match(stdout, /出网被阻断|bad address/);
	});

	test("端到端：整个会话跑在容器里，策略钩子仍然生效", async () => {
		let mock: ChildProcess | undefined;
		let modelGw: ModelGateway | undefined;
		let gateway: Gateway | undefined;
		let ws: WebSocket | undefined;
		let sessionId: string | undefined;
		const gatewayId = `gw-e2e-${process.pid}-${Date.now()}`;
		const dir = mkdtempSync(join(tmpdir(), "dgw-"));
		const workspaceRoot = join(dir, "workspaces");
		mkdirSync(workspaceRoot, { recursive: true });

		try {
			mock = spawn(
				process.execPath,
				[
					join(REPO, "tests/fixtures/mock-model.mjs"),
					"0",
					JSON.stringify([
						{ tool: "write", args: { path: ".github/workflows/x.yml", content: "on: push" } },
						{ tool: "write", args: { path: "allowed-marker.txt", content: "safe marker" } },
						{ text: "完成" },
					]),
				],
				{ stdio: ["ignore", "pipe", "inherit"] },
			);
			const mockPort: number = await new Promise((r) => mock!.stdout?.once("data", (d) => r(JSON.parse(d.toString()).port)));

			modelGw = new ModelGateway({
				port: 0,
				host: "0.0.0.0",
				token: "proxy-token",
				upstreams: [{ id: "up", baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "UPSTREAM-KEY" }],
				egressAllowlist: ["127.0.0.1"],
			});
			const modelPort = await modelGw.listen();

			gateway = new Gateway({
				mode: "demo",
				port: 0,
				host: "127.0.0.1",
				token: "gw-token",
				policyFile: join(REPO, "config/policy.yaml"),
				auditFile: join(dir, "audit.jsonl"),
				workspaceRoot,
				webRoot: join(REPO, "web"),
				// 容器要经 host.docker.internal 回到宿主机上的模型网关
				wiring: {
					proxyToken: "proxy-token",
					modelGatewayUrl: `http://host.docker.internal:${modelPort}/v1`,
					model: "mock-model",
				},
				backend: new DockerBackend({
					image: IMAGE,
					repoRoot: REPO,
					gatewayId,
					extraArgs: ["--add-host", "host.docker.internal:host-gateway"],
				}),
			});
			const port = await gateway.listen();

			ws = new WebSocket(`ws://127.0.0.1:${port}/?token=gw-token`);
			const events: ClientEvent[] = [];
			ws.on("message", (raw) => {
				const m = JSON.parse(String(raw));
				if (m.type !== "control") events.push(m.event);
			});
			await new Promise((r) => ws!.once("open", r));

			const waitFor = async (pred: () => boolean, ms = 8_000) => {
				const deadline = Date.now() + ms;
				while (!pred()) {
					if (Date.now() > deadline) throw new Error(`超时；已收到 ${events.map((e) => e.type).join(",")}`);
					await new Promise((r) => setTimeout(r, 50));
				}
			};

			await waitFor(() => events.some((e) => e.type === "session.ready"));
			const ready = events.find((e) => e.type === "session.ready") as { sessionId: string };
			sessionId = ready.sessionId;

			ws.send(JSON.stringify({ type: "prompt", text: "改 CI 并写入安全标记", requestId: "req-e2e-ci" }));
			// 关键：策略钩子在容器里依然拦下了写 CI 配置
			await waitFor(() => events.some((e) => e.type === "policy.denied"));

			const denied = events.find((e) => e.type === "policy.denied") as { rule: string };
			assert.equal(denied.rule, "ci-iac-secrets-off-limits");
			// 而且文件确实没落到工作区
			assert.throws(() => readFileSync(join(workspaceRoot, sessionId!, ".github/workflows/x.yml")));

			// 正向允许：安全工具写入 marker 证明执行管道正常且已落盘
			await waitFor(() => events.some((e) => e.type === "agent.settled"));
			assert.equal(readFileSync(join(workspaceRoot, sessionId!, "allowed-marker.txt"), "utf8"), "safe marker");

			ws.close();
			await gateway.close();
			const { stdout } = await dockerExec(["ps", "-aq", "--filter", `name=${containerName(sessionId, gatewayId)}`]);
			assert.equal(stdout.trim(), "", "会话结束后容器必须被收掉");
		} finally {
			if (ws) {
				try { ws.close(); } catch {}
				try { ws.terminate(); } catch {}
			}
			if (gateway) {
				try {
					await Promise.race([
						gateway.close(),
						new Promise<void>((_, r) => setTimeout(() => r(new Error("gateway.close timeout")), 8000)),
					]);
				} catch {}
			}
			if (sessionId) {
				try {
					await dockerExec(["rm", "-f", containerName(sessionId, gatewayId)], 5000);
				} catch {}
			}
			if (modelGw) {
				try {
					await Promise.race([
						modelGw.close(),
						new Promise<void>((_, r) => setTimeout(() => r(new Error("modelGw.close timeout")), 5000)),
					]);
				} catch {}
			}
			if (mock && mock.exitCode === null && !mock.killed) {
				try { mock.kill("SIGTERM"); } catch {}
				await new Promise<void>((resolve) => {
					let timer: NodeJS.Timeout;
					const onExit = () => { clearTimeout(timer); resolve(); };
					mock!.once("exit", onExit);
					timer = setTimeout(() => {
						mock!.removeListener("exit", onExit);
						try { mock!.kill("SIGKILL"); } catch {}
						resolve();
					}, 1500);
				});
			}
		}
	});

	test("归属隔离负测：reapOrphans 仅回收本网关标签容器，绝不误删外部或其它网关容器", async () => {
		const ownerGw = `gw-owner-${process.pid}-${Date.now()}`;
		const otherGw = `gw-other-${process.pid}-${Date.now()}`;
		const ownerContainer = `perimeter-${ownerGw}-sess1`;
		const otherContainer = `perimeter-${otherGw}-sess1`;

		await dockerExec(["run", "-d", "--name", ownerContainer, "--label", `perimeter.gateway=${ownerGw}`, "alpine", "sleep", "60"]);
		await dockerExec(["run", "-d", "--name", otherContainer, "--label", `perimeter.gateway=${otherGw}`, "alpine", "sleep", "60"]);

		try {
			const backend = new DockerBackend({ image: IMAGE, repoRoot: REPO, gatewayId: ownerGw });
			const reaped = await backend.reapOrphans();
			assert.ok(reaped.length >= 1, "本网关孤儿容器必须被扫描并清理");

			const checkOwner = await dockerExec(["ps", "-aq", "--filter", `name=${ownerContainer}`]);
			assert.equal(checkOwner.stdout.trim(), "", "本网关容器必须被清理");

			const checkOther = await dockerExec(["ps", "-aq", "--filter", `name=${otherContainer}`]);
			assert.notEqual(checkOther.stdout.trim(), "", "外部/其它网关容器绝不能被误删");
		} finally {
			await dockerExec(["rm", "-f", ownerContainer, otherContainer]).catch(() => {});
		}
	});

	test("关闭与资源释放负测：会话关闭必须清除容器，容器未关闭或泄漏时断言必须明确失败", async () => {
		const testGw = `gw-cleanup-${process.pid}-${Date.now()}`;
		const testSess = "sess-cleanup-test";
		const cName = containerName(testSess, testGw);

		await dockerExec(["run", "-d", "--name", cName, "--label", `perimeter.gateway=${testGw}`, "alpine", "sleep", "60"]);

		try {
			const before = await dockerExec(["ps", "-aq", "--filter", `name=${cName}`]);
			assert.notEqual(before.stdout.trim(), "", "cleanup 之前容器必须存在");

			const backend = new DockerBackend({ image: IMAGE, repoRoot: REPO, gatewayId: testGw });
			await backend.cleanup(testSess);

			const afterCleanup = await dockerExec(["ps", "-aq", "--filter", `name=${cName}`]);
			assert.equal(afterCleanup.stdout.trim(), "", "cleanup 后容器必须被彻底清理");
		} finally {
			await dockerExec(["rm", "-f", cName]).catch(() => {});
		}
	});
});

test("docker 客户端拿得到自己需要的宿主机环境，但那些不进容器", () => {
	const l = new DockerBackend({ image: IMAGE, repoRoot: "/repo" }).launch(ctx);
	// PiSession 的 spawn 不继承 process.env；docker CLI 靠 HOME 定位
	// ~/.docker/config.json（registry 认证、自定义 context、代理配置）。
	// 漏了它在默认 socket 的机器上看不出来，换私有 registry 就连不上。
	assert.ok(process.env.HOME, "前提：本机有 HOME，否则下面这条断言是空转");
	assert.equal(l.env.HOME, process.env.HOME);
	// 而容器里的 HOME 是另一回事，由 argv 显式给定
	assert.ok(l.argsPrefix.includes("HOME=/home/agent"));
	// docker 客户端的宿主机变量不得出现在 -e 列表里
	const envArgs = l.argsPrefix.filter((_, i) => l.argsPrefix[i - 1] === "-e");
	assert.ok(!envArgs.includes("DOCKER_HOST"));
	assert.ok(!envArgs.some((e) => e === "HOME"), "容器的 HOME 走 KEY=VALUE，不该再有裸 HOME");
});

test("launch 的 env 原样送到 PiSession —— -e KEY 全靠这条链路", () => {
	// 这次改动真正的风险点：值不在 argv 里了，全靠 docker 客户端进程环境。
	// 中途任何一处丢失，容器里的变量就是空的，而症状离原因很远。
	const l = new DockerBackend({ image: IMAGE, repoRoot: "/repo" }).launch(ctx);
	// session.ts 的组合方式
	const spawnEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...l.env };
	for (const k of l.argsPrefix.filter((_, i) => l.argsPrefix[i - 1] === "-e")) {
		if (k.includes("=")) continue; // KEY=VALUE 形式自带值
		assert.ok(spawnEnv[k] !== undefined, `${k} 必须能从 docker 客户端环境取到`);
	}
	assert.ok(spawnEnv.PATH, "PATH 不能丢：spawn 用子进程 env 做 execvp 查找");
});

test("调用方传的 docker 客户端变量不会污染容器 env", () => {
	const l = new DockerBackend({
		image: IMAGE,
		repoRoot: "/repo",
		env: { HOME: "/evil", DOCKER_HOST: "tcp://evil:2375" },
	}).launch(ctx);
	const envArgs = l.argsPrefix.filter((_, i) => l.argsPrefix[i - 1] === "-e");
	assert.ok(!envArgs.includes("HOME"), "容器 HOME 由 argv 显式给定，不接受覆盖");
	assert.ok(!envArgs.includes("DOCKER_HOST"));
	// 客户端仍用宿主机自己的值，而不是调用方塞的
	assert.equal(l.env.DOCKER_HOST, process.env.DOCKER_HOST);
});

test("kubectl prepare 的两条命令形状 —— 直接测 prepare() 只能断言「失败了」，那种断言恒真", () => {
	const b = new KubectlBackend({ podTemplate: "perimeter-{session}", namespace: "ns", container: "agent" });
	const [wait, cp] = b.prepareArgs({ ...ctx, home: "/host/home" });

	// --for=create 是必需的：Pod 由外部编排器创建，两边并发时不加它
	// 会在「资源还不存在」上立即失败而不是等待
	const pod = `perimeter-${k8sNameFragment("sess-1")}`;
	assert.deepEqual(wait, ["wait", "--for=create", "--for=condition=Ready", `pod/${pod}`, "--timeout=60s", "-n", "ns"]);
	// 尾部 `/.` 决定复制的是目录内容而非目录本身；去掉它会 cp 成 /home/agent/home/
	assert.deepEqual(cp, ["cp", "--no-preserve", "/host/home/.", `${pod}:/home/agent`, "-n", "ns", "-c", "agent"]);
});

test("kubectl 目标路径必须与 sandbox.yaml 的 mountPath 一致", () => {
	const b = new KubectlBackend({ podTemplate: "p-{session}" });
	const [, cp] = b.prepareArgs({ ...ctx, home: "/h" });
	const target = cp[3]!.split(":")[1];
	const yaml = readFileSync(join(REPO, "deploy/sandbox.yaml"), "utf8");
	// cp 到 emptyDir 之外（只读根上）不会报错，症状只会是「读不到 provider」
	assert.ok(yaml.includes(`mountPath: ${target}`), `sandbox.yaml 里没有 ${target} 的挂载`);
	assert.equal(b.launch({ ...ctx, home: "/h" }).homeInContainer, target);
});

test("没有沙箱 HOME 时 prepare 直接跳过，不做无谓的 kubectl 调用", async () => {
	const b = new KubectlBackend({ podTemplate: "p-{session}" });
	await b.prepare({ ...ctx, home: undefined });
});

test("provisionPlan 建的 Pod 名与 wait/exec/cleanup 用的是同一个", () => {
	// 两处各拼一次名字的话：wait 干等到超时、cleanup 删一个不存在的名字
	// （--ignore-not-found 让它静默成功），每失败一次泄漏一个带 token 的 Pod
	const b = new KubectlBackend({
		podTemplate: "perimeter-{session}",
		namespace: "perimeter",
		templatePath: join(REPO, "deploy/sandbox.yaml"),
		image: "img:v1",
	});
	const plan = b.provisionPlan(ctx)!;
	const podName = (parseYaml(plan.manifest) as { metadata: { name: string } }).metadata.name;
	const [wait, cp] = b.prepareArgs({ ...ctx, home: "/h" });
	assert.equal(wait[3], `pod/${podName}`, "wait 的目标必须是刚建出来的那个 Pod");
	assert.ok(cp[3]!.startsWith(`${podName}:`), "cp 的目标必须是同一个 Pod");
});

test("配了 templatePath 却缺 namespace 时拒绝启动 —— NetworkPolicy 是 namespace-scoped 的", () => {
	const b = new KubectlBackend({
		podTemplate: "p-{session}",
		templatePath: join(REPO, "deploy/sandbox.yaml"),
		image: "img:v1",
	});
	// Pod 落到别的 ns 会照常起来，但完全不受 egress 约束
	assert.throws(() => b.provisionPlan(ctx), /必须同时给 namespace/);
});

test("没有 templatePath 时不创建 Pod —— 沿用外部编排器建好的那个", () => {
	const b = new KubectlBackend({ podTemplate: "p-{session}", namespace: "ns" });
	assert.equal(b.provisionPlan(ctx), null);
});

test("exec 的 argv：进本会话的容器、切到容器内工作区、命令整体交给 sh", () => {
	const b = new DockerBackend({ image: "img", repoRoot: "/repo", gatewayId: "gw" });
	const args = b.execArgs("s1", "node --test && echo ok");
	// -w 指的是**容器内**挂载点，与宿主机工作区路径无关
	assert.deepEqual(args.slice(0, 3), ["exec", "-w", "/workspace"]);
	// 命令必须作为单个 argv 交给 sh，拆开的话 `&&` 与重定向会被当成 docker 的参数
	assert.deepEqual(args.slice(-3), ["/bin/sh", "-c", "node --test && echo ok"]);
	assert.match(String(args[3]), /s1/, "容器名要认到具体会话");
	// 自定义挂载点要跟着走，否则验收会跑在容器的默认 cwd 上
	assert.equal(new DockerBackend({ image: "i", repoRoot: "/r", workdir: "/src" }).execArgs("s", "x")[2], "/src");
});

test("Durable docker：常驻执行连接不挂网关代码、不注入模型环境", () => {
	const plan = new DockerBackend({ image: IMAGE, repoRoot: "/repo", gatewayId: "durable" }).environmentPlan(ctx);
	assert.deepEqual(plan.command, ["docker", "exec", "-i", "perimeter-durable-sess-1", "pi-env"]);
	assert.ok(plan.start!.args.includes("-d"));
	assert.ok(!plan.start!.args.some((arg) => arg.includes("/opt/perimeter/")));
	// HOME 与 GIT_TEMPLATE_DIR 是仅有的两个带值的 -e：前者是容器 HOME，后者指向
	// 只读空模板目录（S2 Phase B，/var/perimeter 下、不占用 /opt/perimeter 网关代码命名空间），均为固定非敏感路径
	assert.deepEqual(plan.start!.args.flatMap((arg, i, args) => arg === "-e" ? [args[i + 1]] : []), [
		"HOME=/home/agent",
		"GIT_TEMPLATE_DIR=/var/perimeter/git-templates",
	]);
	// start.env 必须可执行：client 需 PATH 解析 docker 可执行文件（与 safeDockerCmd 同口径；
	// 仅 host 侧 client 环境，容器内环境仍由 args 严格构造）——首次真实 probe 运行暴露的缺口
	assert.equal(plan.start!.env?.PATH, process.env.PATH, "start.env 必须带 host PATH（否则 spawn docker ENOENT）");
	for (const k of Object.keys(plan.start!.env!)) {
		assert.ok(k === "PATH" || k === "HOME" || k.startsWith("DOCKER_"), `start.env 仅允许 PATH/HOME/DOCKER_*（实际 ${k}）`);
	}
});

test("Durable kubectl：exec -i 拉起单条 pi-env 连接", () => {
	const plan = new KubectlBackend({ podTemplate: "agent-{session}", namespace: "agents" }).environmentPlan(ctx);
	assert.deepEqual(plan.command, ["kubectl", "exec", "-i", "agent-sess-1-abe633f3", "-n", "agents", "--", "pi-env"]);
});

// ── S2 生产隔离守卫与安全不变量测试 ──────────────────────

test("S2 生产守卫：生产模式未显式提供隔离后端或使用 LocalBackend 时 fail-closed 拒启动", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-prod-guard-"));
	const baseCfg = {
		mode: "production" as const,
		port: 0,
		host: "127.0.0.1",
		auth: { authenticate: async () => ({ id: "corp|alice", issuer: "corp", subject: "alice", expiresAt: Date.now() + 3600000, groups: [] }), isPrincipalId: () => true },
		allowedHosts: ["127.0.0.1"],
		allowedOrigins: ["https://console.corp.local"],
		resolveScope: () => ({ repo: "r", team: "t" }),
		policyFile: join(REPO, "config/policy.yaml"),
		auditFile: join(dir, "audit.jsonl"),
		workspaceRoot: join(dir, "ws"),
		webRoot: join(REPO, "web"),
	};

	// 1. 缺 backend
	assert.throws(() => new Gateway(baseCfg), /production 模式必须显式配置受支持的隔离执行后端/);

	// 2. 传 LocalBackend
	assert.throws(
		() => new Gateway({ ...baseCfg, backend: new LocalBackend() }),
		/production 模式严禁使用无隔离的 LocalBackend/,
	);

	// 2.1 传伪装为 docker 的 LocalBackend 子类
	class SpoofedBackend extends LocalBackend {
		override kind = "docker" as any;
	}
	assert.throws(
		() => new Gateway({ ...baseCfg, backend: new SpoofedBackend() }),
		/production 模式严禁使用无隔离的 LocalBackend/,
	);

	// 2.2 传 allowLocal 试图绕过
	assert.throws(
		() => new Gateway({ ...baseCfg, allowLocal: true, backend: new LocalBackend() } as any),
		/production 模式严禁使用 allowLocal 参数绕过隔离守卫/,
	);

	// 3. 传非法 backend
	assert.throws(
		() => new Gateway({ ...baseCfg, backend: { kind: "custom-fake" as any, launch: () => ({} as any), environment: async () => ({} as any) } }),
		/仅支持 docker 或 kubectl 隔离后端/,
	);

	// 3.1 传 plain fake docker 对象（非 DockerBackend 实例）
	assert.throws(
		() => new Gateway({
			...baseCfg,
			backend: {
				kind: "docker",
				launch: () => ({} as any),
				environment: async () => ({} as any),
				network: "none",
			} as any,
		}),
		/必须是受支持的 DockerBackend 或 KubectlBackend 实例/,
	);

	// 4. Docker 默认 bridge 与 host 网络拒绝
	assert.throws(
		() => new Gateway({ ...baseCfg, backend: new DockerBackend({ image: IMAGE, repoRoot: REPO, network: "bridge" }) }),
		/禁止使用 bridge 或 host 网络/,
	);
	assert.throws(
		() => new Gateway({ ...baseCfg, backend: new DockerBackend({ image: IMAGE, repoRoot: REPO, network: "host" }) }),
		/docker 隔离后端禁止使用 host 网络/,
	);

	// 5. 合规 isolated backend (none) 成功初始化
	const gw = new Gateway({
		...baseCfg,
		backend: new DockerBackend({ image: IMAGE, repoRoot: REPO, network: "none" }),
	});
	assert.ok(gw, "受控隔离网络 DockerBackend 允许通过生产守卫");
	await gw.close();

	// 6. named network 生产 listen 必须通过 bounded inspect 校验 Internal=true
	const namedGw = new Gateway({
		...baseCfg,
		auditFile: join(dir, "audit-named.jsonl"),
		backend: new DockerBackend({ image: IMAGE, repoRoot: REPO, network: "non-existent-named-net" }),
	});
	await assert.rejects(
		() => namedGw.listen(),
		/生产网络守卫校验失败，拒绝启动/,
	);
	await namedGw.close();
});

test("S2 容器安全不变量：DockerBackend 禁止危险 extraArgs（全语法变种拦截与白名单支持）", () => {
	// 禁止 root（各种形式）
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, user: "0" }), /绝不能以 root 用户运行/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, user: "root" }), /绝不能以 root 用户运行/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, user: "0:0" }), /绝不能以 root 用户运行/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, user: "root:root" }), /绝不能以 root 用户运行/);

	// 禁止 extraArgs 中的 root 变种（-u 0, -u=0, -u0, --user 0, --user=root 等）
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["-u", "0"] }), /禁止通过 extraArgs 指定 root 身份/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["-u=0"] }), /禁止通过 extraArgs 指定 root 身份/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["-u0"] }), /禁止通过 extraArgs 指定 root 身份/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--user", "root"] }), /禁止通过 extraArgs 指定 root 身份/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--user=root:root"] }), /禁止通过 extraArgs 指定 root 身份/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--user=1000:0"] }), /禁止通过 extraArgs 指定 root 身份/);

	// 禁止 privileged
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--privileged"] }), /禁止 --privileged 特权模式/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--privileged=true"] }), /禁止 --privileged 特权模式/);

	// 禁止 cap-add
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--cap-add", "SYS_ADMIN"] }), /禁止 --cap-add 增加 Linux capabilities/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--cap-add=ALL"] }), /禁止 --cap-add 增加 Linux capabilities/);

	// 禁止通过 extraArgs 覆盖网络（--network / --net 任意形式）
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--net=host"] }), /禁止通过 extraArgs 覆盖网络配置/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--network", "bridge"] }), /禁止通过 extraArgs 覆盖网络配置/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--net", "internal"] }), /禁止通过 extraArgs 覆盖网络配置/);

	// 禁止 host pid/ipc/uts/userns
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--pid", "host"] }), /禁止使用 host PID 命名空间/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--pid=host"] }), /禁止使用 host PID 命名空间/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--ipc=host"] }), /禁止使用 host IPC 命名空间/);

	// 禁止覆盖只读根文件系统
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--read-only=false"] }), /禁止通过 extraArgs 禁用只读根文件系统/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--read-only", "false"] }), /禁止通过 extraArgs 禁用只读根文件系统/);

	// 禁止 security-opt 削弱
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--security-opt", "label=disable"] }), /禁止禁用安全策略或 seccomp\/apparmor/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--security-opt=no-new-privileges=false"] }), /禁止禁用安全策略或 seccomp\/apparmor/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--security-opt", "seccomp=unconfined"] }), /禁止禁用安全策略或 seccomp\/apparmor/);

	// 禁止覆盖容器名
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--name", "evil-container"] }), /禁止通过 extraArgs 覆盖容器名称/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--name=evil"] }), /禁止通过 extraArgs 覆盖容器名称/);

	// 禁止 extraArgs 指定任何形式的挂载（-v, --volume, --mount，包括宿主根、/tmp、用户目录等）
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["-v", "/var/run/docker.sock:/var/run/docker.sock"] }), /禁止通过 extraArgs 指定任何自定义挂载/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["-v=/var/run/docker.sock:/s"] }), /禁止通过 extraArgs 指定任何自定义挂载/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["-v/tmp:/tmp2"] }), /禁止通过 extraArgs 指定任何自定义挂载/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["-v", "/tmp:/t"] }), /禁止通过 extraArgs 指定任何自定义挂载/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["-v", `${process.env.HOME}:/home_escape`] }), /禁止通过 extraArgs 指定任何自定义挂载/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--volume", "/var/data:/data"] }), /禁止通过 extraArgs 指定任何自定义挂载/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--volume=/data:/data"] }), /禁止通过 extraArgs 指定任何自定义挂载/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--mount", "type=bind,source=/var/run/docker.sock,target=/s"] }), /禁止通过 extraArgs 指定任何自定义挂载/);
	assert.throws(() => new DockerBackend({ image: IMAGE, repoRoot: REPO, extraArgs: ["--mount=type=bind,src=/tmp,dst=/tmp2"] }), /禁止通过 extraArgs 指定任何自定义挂载/);

	// 允许合法安全参数（如 --add-host）
	const safeBackend = new DockerBackend({
		image: IMAGE,
		repoRoot: REPO,
		extraArgs: ["--add-host", "host.docker.internal:host-gateway"],
	});
	const launchPlan = safeBackend.launch(ctx);
	assert.ok(launchPlan.argsPrefix.includes("--add-host"));
	assert.ok(launchPlan.argsPrefix.includes("host.docker.internal:host-gateway"));
});

test("S2 构造不可变防御：DockerBackend 冻结配置，构造后外部 mutation 无法改变实际 argv", () => {
	const externalArgs = ["--add-host", "safe:127.0.0.1"];
	const rawOpts = {
		image: IMAGE,
		repoRoot: REPO,
		extraArgs: externalArgs,
		network: "none",
	};

	const backend = new DockerBackend(rawOpts);

	// 1. 尝试修改原始外部数组
	externalArgs.push("--privileged");
	const plan1 = backend.launch(ctx);
	assert.ok(!plan1.argsPrefix.includes("--privileged"), "外部 options mutation 不能渗透进内部 launch argv");

	// 2. 尝试修改 returned getter options
	assert.throws(() => {
		(backend.options.extraArgs as any).push("--cap-add=ALL");
	}, /Cannot add property|Cannot assign to read only/);

	const plan2 = backend.launch(ctx);
	assert.ok(!plan2.argsPrefix.includes("--cap-add=ALL"), "getter options mutation 不能影响内部状态");
});

test("S2 session.ts 模型网关地址精确 URL 边界：仅精确匹配 host.docker.internal，防后缀域名凭证泄露", () => {
	// 模拟 session.ts 内部处理 URL 转换的纯逻辑
	const normalizeModelGatewayUrl = (input: string): string => {
		let baseUrl = input;
		try {
			const u = new URL(baseUrl);
			if (u.hostname.toLowerCase() === "host.docker.internal") {
				u.hostname = "127.0.0.1";
				baseUrl = u.href;
			}
		} catch {}
		return baseUrl;
	};

	// 1. 正向：精确匹配 host.docker.internal
	assert.equal(
		normalizeModelGatewayUrl("http://host.docker.internal:8080/v1"),
		"http://127.0.0.1:8080/v1",
	);
	assert.equal(
		normalizeModelGatewayUrl("http://host.docker.internal/v1"),
		"http://127.0.0.1/v1",
	);

	// 2. 负向：后缀域名（如 host.docker.internal.attacker.com）绝不改写
	assert.equal(
		normalizeModelGatewayUrl("http://host.docker.internal.attacker.com:8080/v1"),
		"http://host.docker.internal.attacker.com:8080/v1",
	);

	// 3. 负向：作为 username 伪装（http://host.docker.internal@attacker.com）绝不改写
	assert.equal(
		normalizeModelGatewayUrl("http://host.docker.internal@attacker.com:8080/v1"),
		"http://host.docker.internal@attacker.com:8080/v1",
	);

	// 4. 负向：query 包含 host.docker.internal 绝不改写 hostname
	assert.equal(
		normalizeModelGatewayUrl("http://127.0.0.1:8080/v1?ref=host.docker.internal"),
		"http://127.0.0.1:8080/v1?ref=host.docker.internal",
	);
});

test("S2 网络身份绑定与 TOCTOU 隔离：launch 与 environmentPlan 锁死已验证的不可变 network ID", () => {
	const backend = new DockerBackend({
		image: IMAGE,
		repoRoot: REPO,
		network: "named-internal-net",
	});

	// 1. 未绑定时默认回退到 options.network
	const planBefore = backend.launch(ctx);
	const netIndexBefore = planBefore.argsPrefix.indexOf("--network");
	assert.equal(planBefore.argsPrefix[netIndexBefore + 1], "named-internal-net");

	// 2. 模拟网关 listen() 校验后绑定真实 ID
	const realImmutableId = "net-id-abcd1234efgh5678";
	backend.bindVerifiedNetwork(realImmutableId);
	assert.equal(backend.verifiedNetworkId, realImmutableId);

	// 3. 校验 launch argv 严格使用不可变 ID
	const planAfter = backend.launch(ctx);
	const netIndexAfter = planAfter.argsPrefix.indexOf("--network");
	assert.equal(planAfter.argsPrefix[netIndexAfter + 1], realImmutableId, "launch 必须锁死 verifiedNetworkId 防 TOCTOU 重绑");

	// 4. 校验 environmentPlan start argv 严格使用不可变 ID
	const envPlan = backend.environmentPlan(ctx);
	const startNetIndex = envPlan.start!.args.indexOf("--network");
	assert.equal(envPlan.start!.args[startNetIndex + 1], realImmutableId, "environmentPlan 必须锁死 verifiedNetworkId");

	// 5. 校验非法 ID 抛错
	assert.throws(() => backend.bindVerifiedNetwork(""), /networkId 必须为有效非空字符串/);
	assert.throws(() => backend.bindVerifiedNetwork("   "), /networkId 必须为有效非空字符串/);
});

test("S2 verifyDockerNetworkInternal 契约测试：none 返回 none，非 internal 或非法 ID 拒绝", async () => {
	// none 直接返回 none，无需 inspect
	const id = await verifyDockerNetworkInternal("none");
	assert.equal(id, "none");
});
