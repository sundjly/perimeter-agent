/**
 * 方案B：路径守卫的一次性受控 exec helper（设计见 docs/implementation/s2-path-guard-cancellation-plan.md 与
 * docs/implementation/s2-path-guard-exec-helper.md）。
 *
 * 替换 Slice A 的不可取消 canonicalPath RPC + awaitWithContext 早返回包装：
 * - 同一 ExecutionEnv.exec argv 路径（无 shell 拼接、无命令注入面）运行**静态** helper：
 *   `node -e <固定代码> -- <rawPath>`，一次完成 canonical 目标 + 同 namespace 根 + 最近存在祖先回溯。
 * - 真实取消：exec 的 timeout（秒）与工具 AbortSignal 都会杀 helper 进程组；execGuardHelper await exec
 *   最终 response/exit 后才返回。收尾边界（分四层，准确不绝对化）：
 *   · 直接子进程：正常 result/error/aborted/timeout settle 时 daemon 侧 child.wait() 已收割（内核证据）；
 *   · 管道收尾：settle 有两条路径——双管道 ended 或 Exit 后 100ms idle grace（孙进程持管道时走后者，
 *     settle 时管道可能未结束）；
 *   · 组内后代：仅 abort/timeout/kill 场景发出组 SIGKILL 且不验证成员消亡；正常退出路径不发组杀；
 *     setsid 逃逸者不在组内、不可达；
 *   · lost（close/断连/分区）：无任何终止证据——客户端已离线，daemon 收尾无处可去，一律 pending/unknown。
 *   deny 在所有路径都已 fail-closed；“返回前无活动 helper”仅 Local 直接子进程层面成立。
 *   G1 knownlost：pinned env 在客户端已察觉失联后拒绝重连（立即 deny）；transport 已死未察觉的 30s
 *   静默窗口与无响应 CANCEL 仍存在（blocked，不因 pin 关闭）。生命周期兜底（连接关闭/daemon 退出
 *   杀全部组）不是单请求收尾证明。
 * - stdout 是 helper→网关的私有通道：canonical/root 只用于策略复判，绝不转发到客户端事件/审计/日志。
 * - root 在 helper 内取 realpath(env cwd)，与目标同 namespace；禁止把宿主机 opts.workspace 传给容器 helper。
 * - 环境最小化：只传 PATH/HOME，inheritEnv:false，不继承网关 secret/全量 env。
 * - runtime：Local 用 process.execPath；Remote 用镜像内 PATH 上的 node（node:22-alpine 自带）；
 *   能力不具备（无 node/daemon 断连）→ fail-closed，绝不猜宿主机路径等于容器路径。
 *
 * 边界（如实）：Pod 场景 daemon 同样执行 exec 协议，但真实集群的 kill/close 未验证，列为 unknown；
 * 主动 setsid 逃逸出进程组的后代不在 kill 范围（与协议一致的组级语义）。
 */
import { homedir } from "node:os";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { RemoteExecutionEnv } from "@earendil-works/pi-env";
import { remoteEnvHome } from "./execution-env.ts";

/** 守卫拒绝原因/审计允许的错误类别（R3 白名单原样保留；其余一律 unknown） */
export const GUARD_CATEGORY_WHITELIST: readonly string[] = ["not_found", "permission_denied", "not_directory", "is_directory", "invalid", "not_supported", "aborted", "deadline"];

/** helper stdout 上限（UTF-8 字节）：canonical/root 都是路径级输出，超出即协议违背 fail-closed */
export const PATH_GUARD_MAX_STDOUT_BYTES = 4096;

/** 远端 helper 的最小 PATH，只用于在镜像里定位 runtime（node:22-alpine 的 node 在 /usr/local/bin） */
export const GUARD_HELPER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * 静态 helper 源码（CJS，node -e）。只做路径规范化，绝不执行任何输入提供的命令。
 * stdout 恰好一行 JSON：{ok:true,canonical,root,stats} 或 {ok:false,error:<类别>}；任何意外都输出 unknown 类别。
 * 语义与 pi 工具/env 对齐：`~`→HOME、`file://`→fileURLToPath、绝对/相对按 env cwd 解析；
 * 仅真实 not_found 向最近存在祖先回溯（共享本次 exec 的总预算），permission/ELOOP/unknown 一律拒绝。
 * stats：目标真实存在时为其 lstat 投影 {nlink,dir}（canonical 已 realpath，lstat 即目标本体）；
 * 目标不存在（回溯到祖先）时为 null——此时无法（也不应）声称知道目标的链接数。
 * nlink>1 的常规文件无法确定另一链接的路径，只能作为「多链接存在」的信号由守卫保守拒（B1）。
 */
export const PATH_GUARD_HELPER_CODE = String.raw`"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { fileURLToPath } = require("node:url");
const CODES = { ENOENT: "not_found", EACCES: "permission_denied", EPERM: "permission_denied", ENOTDIR: "not_directory", EISDIR: "is_directory", EINVAL: "invalid", ELOOP: "not_supported", ABORT_ERR: "aborted" };
const cat = (e) => (e && typeof e.code === "string" && CODES[e.code]) || "unknown";
const out = (verdict) => { process.stdout.write(JSON.stringify(verdict) + "\n"); };
const fail = (error) => out({ ok: false, error });
const home = () => { const h = process.env.HOME; return typeof h === "string" && h !== "" ? h : os.homedir(); };
const resolveRaw = (raw) => {
  let p = raw;
  if (p === "~" || p === "~/") p = home();
  else if (p.startsWith("~/")) p = path.join(home(), p.slice(2));
  else if (p.startsWith("file://")) { try { p = fileURLToPath(p); } catch {} }
  return path.resolve(p);
};
const statOf = (p) => {
  // R41 修复：仅用于「目标真实存在」的 canonical（realpath 已成功）。lstat 任何异常都必须
  // 向上抛出（由主流程固定类别 fail-closed），绝不折叠成 null——null 只属于「目标不存在」
  // 的回溯分支；否则 stat 权限/竞态异常会混同新建文件、硬链接检查被静默跳过。
  const st = fs.lstatSync(p);
  return { nlink: st.nlink, dir: st.isDirectory() };
};
try {
  const raw = process.argv.length >= 2 ? process.argv[1] : undefined;
  if (typeof raw !== "string" || raw === "") fail("invalid");
  else {
    let root;
    try { root = fs.realpathSync(process.cwd()); } catch (e) { fail(cat(e)); }
    if (root !== undefined) {
      const target = resolveRaw(raw);
      let settled = false;
      try {
        const canonical = fs.realpathSync(target);
        // R41 修复：realpath 成功＝目标解析时真实存在；随后的 lstat 异常（EACCES/竞态 ENOENT/ELOOP…）
        // 一律按类别 fail-closed，不得报 ok+stats:null（那只能来自真实不存在目标的回溯分支）。
        let stats;
        try { stats = statOf(canonical); } catch (e) { fail(cat(e)); settled = true; }
        if (!settled) { out({ ok: true, canonical, root, stats }); settled = true; }
      } catch (e) {
        const c = cat(e);
        if (c !== "not_found") { fail(c); settled = true; }
      }
      if (!settled) {
        const sep = path.sep;
        const segs = target.split(sep).filter((s) => s.length > 0);
        for (let cut = segs.length - 1; cut >= 1; cut--) {
          const prefix = sep + segs.slice(0, cut).join(sep);
          try {
            const ancestor = fs.realpathSync(prefix);
            out({ ok: true, canonical: ancestor.replace(/[\\/]+$/, "") + sep + segs.slice(cut).join(sep), root, stats: null });
            settled = true;
            break;
          } catch (e) {
            const c = cat(e);
            if (c !== "not_found") { fail(c); settled = true; break; }
          }
        }
        if (!settled) fail("not_found");
      }
    }
  }
} catch { fail("unknown"); }
`;

export type GuardTargetStats = { nlink: number; dir: boolean };

export type GuardVerdict =
	| { ok: true; canonical: string; root: string; stats: GuardTargetStats | null }
	| { ok: false; error: string };

export interface GuardHelperOptions {
	/** 守卫单阶段总预算（毫秒），覆盖 helper 启动与全部解析；不按层拆分预算 */
	timeoutMs: number;
	/** 已合并工具取消与守卫 deadline 的信号；abort → exec 杀 helper 进程组并以 aborted 收尾 */
	signal?: AbortSignal;
	/** 与 tools/env `~` 语义一致的 HOME（Local=网关 homedir()；Remote=daemon info().home） */
	home: string;
}

/**
 * 在给定 ExecutionEnv 上跑一次受控 helper argv，await 最终 exec response/exit 后才解析结果。
 * 非 0 退出/坏 JSON/缺字段/超量 stdout/超时/abort/RPC lost 全部 fail-closed，绝不缓冲无限输出。
 * argv 完全由调用方构造（生产=静态 helper；测试=受控探针），本函数不拼接任何用户字符串。
 */
export async function execGuardHelper(env: ExecutionEnv, argv: readonly string[], opts: GuardHelperOptions): Promise<GuardVerdict> {
	let stdout = "";
	let stdoutBytes = 0;
	let overflow = false;
	const context: Context = opts.signal ? withAbortSignal(opts.signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
	const result = await env.exec(argv, {
		// exec 的 timeout 单位是秒（SDK resolveTimeoutMs：timeout*1000）
		timeout: Math.max(1, Math.ceil(opts.timeoutMs / 1000)),
		inheritEnv: false,
		// R7：仅标准最小 PATH，绝不向远端（容器/Pod）前置任何宿主目录（如 dirname(process.execPath)）——
		// 宿主→remote 路径假设不可保证且泄漏宿主目录串；本地 dev fixture 用测试专用 helperNode 参数（见下）
		env: { PATH: GUARD_HELPER_PATH, HOME: opts.home },
		onOutput: (text, _ctx, info) => {
			if (info.stream !== "stdout") return; // stderr 只弃不读：任何诊断都不得进入网关
			if (overflow) return;
			const chunkBytes = Buffer.byteLength(text, "utf8");
			if (stdoutBytes + chunkBytes > PATH_GUARD_MAX_STDOUT_BYTES) { overflow = true; return; } // G2: 按 UTF-8 字节计
			stdoutBytes += chunkBytes;
			stdout += text;
		},
	}, context);
	if (!result.ok) {
		// timeout/abort 到这里时进程组已被杀、exec 已等真实收尾；类别只允许固定 token
		const code = result.error.code === "timeout" ? "deadline" : result.error.code === "aborted" ? "aborted" : "unknown";
		return { ok: false, error: code };
	}
	if (result.value.exitCode !== 0 || overflow) return { ok: false, error: "unknown" };
	let parsed: unknown;
	try { parsed = JSON.parse(stdout); } catch { return { ok: false, error: "unknown" }; }
	if (typeof parsed !== "object" || parsed === null) return { ok: false, error: "unknown" };
	const rec = parsed as Record<string, unknown>;
	if (rec.ok === true) {
		// 严格字段协议：多余字段/非绝对路径/非法 stats 都算协议违背（非 Windows 部署面：linux 容器 + darwin 开发）。
		// stats=null（目标不存在，回溯解析）或 {nlink:正整数, dir:bool}（目标真实存在）二者之外一律拒绝。
		const statsOk = rec.stats === null
			|| (typeof rec.stats === "object" && rec.stats !== null
				&& Object.keys(rec.stats as object).length === 2
				&& Number.isSafeInteger((rec.stats as { nlink?: unknown }).nlink)
				&& ((rec.stats as { nlink: number }).nlink) >= 1
				&& typeof (rec.stats as { dir?: unknown }).dir === "boolean");
		if (Object.keys(rec).length === 4 && typeof rec.canonical === "string" && rec.canonical.startsWith("/")
			&& typeof rec.root === "string" && rec.root.startsWith("/") && statsOk) {
			return { ok: true, canonical: rec.canonical, root: rec.root, stats: rec.stats as GuardTargetStats | null };
		}
		return { ok: false, error: "invalid" };
	}
	if (rec.ok === false && Object.keys(rec).length === 2 && typeof rec.error === "string" && GUARD_CATEGORY_WHITELIST.includes(rec.error)) {
		return { ok: false, error: rec.error };
	}
	return { ok: false, error: "unknown" };
}

export interface ResolvedGuardPath {
	/** 目标 canonical（env namespace 视角，可能含新建文件的词法段） */
	canonical: string;
	/** env cwd 的 canonical（同 namespace 根） */
	root: string;
	/** 目标存在时的 lstat 投影；目标不存在（回溯解析）=null。nlink>1 的常规文件由守卫保守拒（B1） */
	stats: GuardTargetStats | null;
}

/**
 * 生产接线：与工具同一 ExecutionEnv 的守卫解析器。
 * HOME/metadata 在 env 打开时一次性取得（openEnvironment 的 connection.info()），经 remoteEnvHome 同步读取——
 * guard 路径零 info() await，守卫预算不再被 SDK 首连/重连预算（START_TIMEOUT 60s/静默 30s，均无 ctx 参数）吞掉。
 * Local 用 process.execPath + 网关 homedir()（与 NodeExecutionEnv 文件工具的 `~` 语义一致）；
 * Remote env 无打开时缓存的 home（非 openEnvironment 构造）→ 立即 fail-closed，不现场连连。
 * 任何失败都以带白名单 code 的 Error 抛出，由守卫 fail-closed。
 * 边界（blocked，SDK 侧）：daemon 掉线后下一次 exec 经 Connection.request→#connect 无 ctx 重连
 * （connection.js request/#connect/#start 均无 signal 参数），受 SDK 自身 30/60s 定时器约束而非守卫预算；
 * 期间取消不中断已开始的连接（abort 监听挂在 #send 之后）。最小 API 需求见 s2-path-guard-bootstrap-blocker.md。
 */
export function createPathGuardResolver(
	envFactory: () => ExecutionEnv,
	guardTimeoutMs = 3000,
	/** 仅测试用（本地 dev daemon fixture）：显式同 namespace 的 node 绝对路径。生产不得传——
	 * 默认 Remote=镜像 PATH 上的 node、Local=process.execPath，绝不把宿主路径当 remote 等价。 */
	options?: { helperNode?: string },
): (rawPath: string, signal?: AbortSignal) => Promise<ResolvedGuardPath> {
	return async (rawPath: string, signal?: AbortSignal): Promise<ResolvedGuardPath> => {
		const env = envFactory();
		const isRemote = env instanceof RemoteExecutionEnv;
		let home: string;
		if (isRemote) {
			// G1：守卫必须运行在 pinned env 上（掉线即 lost，零重连）——unpinned 远端 env 一律拒绝（严禁回退）。
			const pin = (env as RemoteExecutionEnv).pinnedSession;
			if (typeof pin !== "number") {
				throw Object.assign(new Error("path guard requires a pinned remote env (sessionPin missing)"), { code: "unknown" });
			}
			// home 在 env 打开时已由 openEnvironment 经 Connection.snapshot() 一次性取得（remoteEnvHome），
			// guard 路径同步读取——守卫预算不被 SDK 首连/重连预算吞掉；缺失即立即 fail-closed，不现场连连。
			const cached = remoteEnvHome.get(env);
			if (cached === undefined) throw Object.assign(new Error("path guard home unavailable (env opened without daemon metadata)"), { code: "unknown" });
			home = cached;
		} else {
			home = homedir();
		}
		const nodeBin = options?.helperNode ?? (isRemote ? "node" : process.execPath); // 不猜宿主机 node 路径等于容器路径
		const verdict = await execGuardHelper(env, [nodeBin, "-e", PATH_GUARD_HELPER_CODE, "--", rawPath], { timeoutMs: guardTimeoutMs, signal, home });
		if (verdict.ok) return { canonical: verdict.canonical, root: verdict.root, stats: verdict.stats };
		throw Object.assign(new Error("path guard helper failed"), { code: verdict.error });
	};
}
