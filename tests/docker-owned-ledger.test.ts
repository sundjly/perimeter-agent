/**
 * R-Q8：真实 Docker 专用控制的 owned 资源 ledger 证明。
 *
 * 单一受控 probe（复用 DockerBackend fixture 模式，不改生产 backend）：
 * - 精确 owned 名（gatewayId+sessionId+nonce）create→inspect（Id/Name/State 最小字段，不 dump 环境 secret）
 *   → cleanup → inspect-gone；
 * - driver 本地观测：`docker exec -i` transport 客户端进程（精确容器名匹配）的 PID/PGID/birth（可观测则记录）；
 * - 仅本轮 owned ID；Docker CLI 每次有界 deadline；正常/失败 finally 都真实 close；
 * - 全局计数不作为 owned 证明（仅旁证不写 ledger）。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DockerBackend, containerName } from "../src/gateway/execution-backend.ts";
import { appendLedgerEvent, classifyInspectGone, projectSafeIdentity, waitOwnerGone, realPsRunner } from "./helpers/ps-observer.ts";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { RemoteExecutionEnv } from "@earendil-works/pi-env";
import { verifyPiEnvPatchInstalled } from "../src/runtime/pi-env-patch.ts";

const IMAGE = "perimeter-sandbox:test";
const REPO = join(import.meta.dirname, "..");
const LEDGER = process.env.PERIMETER_PIN_LEDGER ?? "/tmp/perimeter-r9/ledger-docker.jsonl";
const RUN_NONCE = `docker-${process.pid}-${Date.now().toString(36)}`;
let ledgerSeq = 0;

function ledger(event: string, fields: Record<string, unknown>): void {
	// R-Q9e：白名单写入（新文件 0600；已存在保留现权限，不妄称改旧权限）
	appendLedgerEvent(LEDGER, { event, nonce: `${RUN_NONCE}-${++ledgerSeq}`, ...fields });
}

function dockerReady(): boolean {
	const v = spawnSync("docker", ["version"], { timeout: 5000, encoding: "utf8", stdio: "ignore" });
	if (v.status !== 0) return false;
	return spawnSync("docker", ["image", "inspect", IMAGE], { timeout: 5000, stdio: "ignore" }).status === 0;
}

/** R-Q9d'：driver 客户端进程身份——复用共享 ps 解析格式（stat/ppid/pgid/lstart/command 单调用）。
 * 返回 pid 与 ObservedIdentity（ppid/pgid/birth 可观测）；找不到/解析失败 → unknown。 */
function driverProbe(name: string): { pid: number; identity: { ppid: number; pgid: number; birth: string; command: string } } | { unknown: string } {
	const r = spawnSync("ps", ["-eo", "pid=,ppid=,pgid=,lstart=,command="], { timeout: 5000, encoding: "utf8" });
	if (r.status !== 0) return { unknown: `ps 非零 ${r.status}` };
	for (const row of r.stdout.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/.exec(row);
		if (m && m[5]!.includes(name) && m[5]!.includes(" pi-env")) {
			return { pid: Number(m[1]), identity: { ppid: Number(m[2]), pgid: Number(m[3]), birth: m[4]!, command: m[5]! } };
		}
	}
	return { unknown: "未找到 driver 进程" };
}

test("R-Q9d Docker owned ledger：nonce 入资源名；create→inspect(全CID/State)→pinned helper 正控→cleanup→对完整CID精确 gone（失败分支也聚合计 ledger）", { skip: !dockerReady() && "docker 或镜像不可用（诚实 skip，不强跑）" }, async () => {
	verifyPiEnvPatchInstalled();
	const ws = mkdtempSync(join(tmpdir(), "pin-docker-"));
	const nonce = `${RUN_NONCE}-probe`;
	// R-Q9d：nonce 进入资源名（gatewayId/sessionId → 容器名），而非只贴在事件上
	const gatewayId = `pgx${process.pid}ledger`;
	const sessionId = `pg-ledger-${RUN_NONCE.split("-").pop()}`;
	const backend = new DockerBackend({ image: IMAGE, repoRoot: REPO, network: "none", gatewayId });
	const name = containerName(sessionId, gatewayId);
	let fullCid: string | undefined;
	let driver: ReturnType<typeof driverProbe> | undefined;
	let handle: { env: ExecutionEnv; guardEnv?: ExecutionEnv; close(): Promise<void> } | undefined;
	const failures: string[] = [];
	const note = (outcome: string, extra?: Record<string, unknown>) => ledger("inspect", { nonce, container: name, cid: fullCid, outcome, ...extra });
	try {
		ledger("start", { nonce, container: name, outcome: "creating" });
		handle = await backend.environment({ sessionId, workspace: ws, home: undefined, extensionPath: "", policyFile: "", env: {} });
		ledger("start", { nonce, container: name, outcome: "created" });
		// inspect：全 CID + Name/State 最小字段
		const insp = spawnSync("docker", ["inspect", "--format", "{{.Id}} {{.Name}} {{.State.Running}}", name], { timeout: 5000, encoding: "utf8" });
		if (insp.status !== 0) { failures.push("inspect 失败（unknown，raw stderr 不入报告通道）"); }
		else {
			const [cid, cname, running] = insp.stdout.trim().split(/\s+/);
			fullCid = cid; // R-Q9d：全 CID 记录（不截断）
			assert.equal(cname, `/${name}`);
			assert.equal(running, "true");
			ledger("inspect", { nonce, container: name, cid: fullCid, outcome: "running" });
		}
		// driver 本地身份（PID/PPID/PGID/birth 尽可能解析；不可观测如实 unknown）
		// R-Q9f：driver-probed 持久化仅安全投影 metadata（不透传 raw identity/含 --token 的 command）
		driver = driverProbe(name);
		ledger("inspect", { nonce, container: name, driver: driver && "pid" in driver ? { pid: driver.pid, ...projectSafeIdentity(driver.identity, name) } : driver, outcome: "driver-probed" });
		// pinned helper 正控（真实链路）
		if (handle) {
			const snap = await (handle.env as RemoteExecutionEnv).connection.snapshot();
			ledger("inspect", { nonce, container: name, session: snap.sessionId, outcome: "snapshot" });
			const guard = new RemoteExecutionEnv({ connection: (handle.env as RemoteExecutionEnv).connection, id: "ledger-guard", cwd: "/workspace", sessionPin: snap.sessionId });
			const r = await guard.exec(["echo", "ledger-ok"], undefined, { abortSignal: undefined } as never);
			assert.ok(r.ok && r.value.exitCode === 0, "pinned helper 正控必须通过");
		}
	} catch {
		// R-Q10a：failures 经聚合 throw→test reporter 落盘＝持久通道；只固定类别，raw 诊断不透传
		failures.push("主体失败（unknown，raw 诊断不入报告通道）");
	} finally {
		// R-Q9d：无论每步失败都继续 attempt 其它 owned 清理并聚合（不吞）
		if (handle) {
			ledger("cleanup", { nonce, container: name, cid: fullCid, outcome: "closing" });
			try { await handle.close(); } catch { failures.push("close 失败（unknown，raw 诊断不入报告通道）"); }
			try { await backend.cleanup(sessionId); } catch { failures.push("backend.cleanup 失败（unknown，raw 诊断不入报告通道）"); }
		} else {
			// 创建结果未知：只有既有 backend 正向归属可恢复 cleanup（不凭名字/labels 冒拥有者）
			try { await backend.cleanup(sessionId); } catch { failures.push("backend.cleanup 失败（创建结果 unknown，raw 诊断不入报告通道）"); }
		}
		if (fullCid !== undefined) {
			// gone 判定（R-Q9d 收紧）：整句精确已知错误（大小写不敏感）＝ gone；status0/live、额外诊断、status 其它、error/signal/null → unknown
			const gone = spawnSync("docker", ["inspect", "--format", "{{.Id}}", fullCid], { timeout: 5000, encoding: "utf8" });
			const verdict = classifyInspectGone(
				{ error: gone.error, status: gone.status, signal: gone.signal, stdout: gone.stdout ?? "", stderr: gone.stderr ?? "" },
				fullCid,
			);
			ledger(verdict === "unknown" ? "unknown" : "inspect-gone", { nonce, container: name, cid: fullCid, outcome: `inspect-gone: ${verdict}` });
			if (verdict === "live") failures.push(`inspect-gone：exit0 且 Id 匹配＝容器仍在（live，判失败）`);
			if (verdict === "unknown") failures.push("inspect-gone unknown（raw stderr 不入报告通道）");
		} else {
			failures.push("全 CID 未知——inspect-gone 无法精确判定（unknown，保留 ledger）");
		}
		// driver birth 可观测 → 有界等待 driver 真实消失（身份感知）；不可观测 → 如实 unknown，不宣称全字段证毕
		if (driver && "pid" in driver) {
			// R-Q9e：ledger 只写安全投影（ppid/pgid/birth/commandMatchesMarker），不透传含 --token 的命令行
			const safeDriver = projectSafeIdentity(driver.identity, name);
			const driverGen = { ppid: driver.identity.ppid, pgid: driver.identity.pgid, birth: driver.identity.birth, marker: name };
			try {
				const outcome = await waitOwnerGone({ observer: realPsRunner(), pid: driver.pid, generation: driverGen, nonce: `${nonce}-driver`, deadlineMs: 5000, ledger: (e) => ledger(String(e.event ?? "inspect"), { ...e, driver: safeDriver }) });
				ledger("inspect-gone", { nonce: `${nonce}-driver`, localpid: driver.pid, driver: safeDriver, outcome: `driver-${outcome}` });
			} catch {
				// R-Q9j/R-Q10a：原始异常不入持久通道（ledger 与 failures 均固定类别，不假 clean）
				ledger("unknown", { nonce: `${nonce}-driver`, localpid: driver.pid, outcome: "driver-gone-unknown" });
				failures.push("driver 观察失败（unknown，不假 clean，raw 诊断不入报告通道）");
			}
		} else {
			// R-Q10c（从严）：driver 不可观测＝证据不完备，green 必须以已证事实为界——记 ledger 并 failures.push 固定 unknown；
			// 容器全 CID gone 证据链独立成立，不因 driver 未知而假 clean
			ledger("unknown", { nonce: `${nonce}-driver`, outcome: "driver 不可观测" });
			failures.push("driver 不可观测（unknown，证据不完备，不假 clean）");
		}
		rmSync(ws, { recursive: true, force: true });
	}
	// 聚合报告：任何 unknown/失败都使测试失败（不假 clean）；
	// R-Q10a：failures 全为固定类别串，聚合只携类别+计数，不携 raw 诊断
	if (failures.length > 0) throw new Error(`R-Q9d ledger 失败/unknown（${failures.length}）: ${failures.join("；")}`);
});
