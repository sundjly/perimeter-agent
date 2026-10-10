import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
} from "../src/gateway/execution-backend.ts";
import { k8sNameFragment } from "../src/deploy/pod-template.ts";
import { Gateway } from "../src/gateway/server.ts";
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

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const c of cleanups) await c();
});

async function dockerReady(): Promise<boolean> {
	try {
		await exec("docker", ["image", "inspect", IMAGE]);
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
	assert.equal(l.bin, "pi");
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
	assert.deepEqual(l.argsPrefix.slice(-2), [IMAGE, "pi"]);
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
	assert.equal(l.extensionPath, "/opt/perimeter/src/gateway/policy-extension.ts");
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
	assert.deepEqual(l.argsPrefix, ["exec", "-i", `perimeter-${k8sNameFragment("sess-1")}`, "-n", "perimeter", "--", "pi"]);
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
		const { stdout } = await exec("docker", args);
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
		const { stdout } = await exec("docker", args);
		assert.match(stdout, /Read-only file system/);
		assert.match(stdout, /tmp可写/);
		assert.match(stdout, /工作区可写/);
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
		const { stdout } = await exec("docker", args);
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
		const { stdout } = await exec("docker", args);
		assert.match(stdout, /出网被阻断|bad address/);
	});

	test("端到端：整个会话跑在容器里，策略钩子仍然生效", async () => {
		// mock 模型 → 模型网关 → 容器里的 pi
		const mock: ChildProcess = spawn(
			process.execPath,
			[
				join(REPO, "tests/fixtures/mock-model.mjs"),
				"0",
				JSON.stringify([{ tool: "write", args: { path: ".github/workflows/x.yml", content: "on: push" } }, { text: "完成" }]),
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		cleanups.push(() => void mock.kill());
		const mockPort: number = await new Promise((r) => mock.stdout?.once("data", (d) => r(JSON.parse(d.toString()).port)));

		const dir = mkdtempSync(join(tmpdir(), "dgw-"));
		const modelGw = new ModelGateway({
			port: 0,
			host: "0.0.0.0",
			token: "proxy-token",
			upstreams: [{ id: "up", baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "UPSTREAM-KEY" }],
			egressAllowlist: ["127.0.0.1"],
		});
		cleanups.push(() => modelGw.close());
		const modelPort = await modelGw.listen();

		const workspaceRoot = join(dir, "workspaces");
		mkdirSync(workspaceRoot, { recursive: true });
		const gateway = new Gateway({
			port: 0,
			host: "127.0.0.1",
			token: "gw-token",
			policyFile: join(REPO, "config/policy.yaml"),
			auditFile: join(dir, "audit.jsonl"),
			workspaceRoot,
			webRoot: join(REPO, "web"),
			piArgs: ["--no-session"],
			// 容器要经 host.docker.internal 回到宿主机上的模型网关
			wiring: {
				proxyToken: "proxy-token",
				modelGatewayUrl: `http://host.docker.internal:${modelPort}/v1`,
				model: "mock-model",
			},
			backend: new DockerBackend({
				image: IMAGE,
				repoRoot: REPO,
				extraArgs: ["--add-host", "host.docker.internal:host-gateway"],
			}),
		});
		cleanups.push(() => gateway.close());
		const port = await gateway.listen();

		const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=gw-token`);
		const events: ClientEvent[] = [];
		ws.on("message", (raw) => {
			const m = JSON.parse(String(raw));
			if (m.type !== "control") events.push(m.event);
		});
		await new Promise((r) => ws.once("open", r));
		cleanups.push(() => void ws.close());

		const waitFor = async (pred: () => boolean, ms = 40_000) => {
			const deadline = Date.now() + ms;
			while (!pred()) {
				if (Date.now() > deadline) throw new Error(`超时；已收到 ${events.map((e) => e.type).join(",")}`);
				await new Promise((r) => setTimeout(r, 50));
			}
		};

		await waitFor(() => events.some((e) => e.type === "session.ready"));
		ws.send(JSON.stringify({ type: "prompt", text: "改 CI" }));
		// 关键：策略钩子在容器里依然拦下了写 CI 配置
		await waitFor(() => events.some((e) => e.type === "policy.denied"));

		const denied = events.find((e) => e.type === "policy.denied") as { rule: string };
		assert.equal(denied.rule, "ci-iac-secrets-off-limits");
		// 而且文件确实没落到工作区
		const sessionId = (events.find((e) => e.type === "session.ready") as { sessionId: string }).sessionId;
		assert.throws(() => readFileSync(join(workspaceRoot, sessionId, ".github/workflows/x.yml")));

		// 会话关闭必须真的收掉容器。杀宿主机上的 docker 客户端不会让容器内的
		// 进程收到信号 —— 容器继续跑、stdio 管道不关，等它的一方就永远等下去。
		// 实测过这个泄漏：测试进程挂死，`docker ps` 里一堆 Up 了几分钟的容器。
		ws.close();
		await gateway.close();
		const { stdout } = await exec("docker", ["ps", "-aq", "--filter", `name=${containerName(sessionId)}`]);
		assert.equal(stdout.trim(), "", "会话结束后容器必须被收掉");
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
	assert.deepEqual(plan.start!.args.flatMap((arg, i, args) => arg === "-e" ? [args[i + 1]] : []), ["HOME=/home/agent"]);
});

test("Durable kubectl：exec -i 拉起单条 pi-env 连接", () => {
	const plan = new KubectlBackend({ podTemplate: "agent-{session}", namespace: "agents" }).environmentPlan(ctx);
	assert.deepEqual(plan.command, ["kubectl", "exec", "-i", "agent-sess-1-abe633f3", "-n", "agents", "--", "pi-env"]);
});
