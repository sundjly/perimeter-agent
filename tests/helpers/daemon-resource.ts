/**
 * R-Q9a'/b'/C：实际 DaemonResource（可注入接缝）。
 *
 * - session-pin.test.ts 与 fault 负控测试共用同一路径（不另造假实现自测）。
 * - 依赖全部注入：connection/snapshot、ps observer、kill、ledger、register、期望父 PID/进程组、daemon marker。
 * - R-Q9a：track 同步登记 dispose 先于任何 await/观察；snapshot/观察失败 catch→dispose→保留原异常并附带
 *   cleanup 异常（cleanupError）后重抛；dispose 在「pid/generation 未采得」时必须失败收尾（ledger unknown +
 *   throw unconfirmed），不得假 gone/假 clean。
 * - R-Q9b：observe 冻结代际前做外部正向核验（ppid===期望父进程、pgid===期望进程组、command 含 marker、
 *   birth 非空）；kill/inspectIdentity 与冻结代际全字段比对，任一不符 ledger unknown+拒杀。
 */
import { psIdentity, matchesGeneration, waitOwnerGone, type PsRunner, type GenerationIdentity } from "./ps-observer.ts";

export interface DaemonSnapshot {
	info: { pid: number };
	sessionId: number;
}

export interface DaemonResourceDeps {
	connection: {
		snapshot(): Promise<DaemonSnapshot>;
		close(): void;
	};
	observer: PsRunner;
	kill: (pid: number, signal: NodeJS.Signals) => void;
	ledger: (event: Record<string, unknown>) => void;
	register: (dispose: () => Promise<void>) => void;
	nonce: string;
	/** daemon 二进制路径 marker（command 必须包含） */
	daemonMarker: string;
	/** 期望父进程（测试进程 pid）——出生/复核均必须等于它 */
	expectedParentPid: number;
	/** 期望进程组（测试进程组）；未提供时跳过 pgid 一致性检查（如实降级，不影响其它字段核验） */
	expectedPgid?: number;
	deadlineMs?: number;
}

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

export class DaemonResource {
	readonly nonce: string;
	readonly session: number;
	readonly generation: GenerationIdentity;
	readonly pid: number;
	readonly #deps: DaemonResourceDeps;
	#disposed = false;

	private constructor(deps: DaemonResourceDeps, snapshot: DaemonSnapshot, generation: GenerationIdentity) {
		this.nonce = deps.nonce;
		this.session = snapshot.sessionId;
		this.pid = snapshot.info.pid;
		this.generation = generation;
		this.#deps = deps;
	}

	/** R-Q9b：出生期外部正向核验——不匹配即抛（不冻结代际、不产生可杀的「已确认」身份）。 */
	static observeBirth(deps: DaemonResourceDeps, snapshot: DaemonSnapshot): GenerationIdentity {
		const id = psIdentity(deps.observer, snapshot.info.pid);
		if (id.state === "unknown") {
			// R-Q9j/R-Q10a：detail（含 ps stdout/stderr 切片）不入 ledger，也不入 throw——
			// 异常经 test reporter 落盘＝持久通道；只出固定类别+pid
			deps.ledger({ event: "unknown", nonce: deps.nonce, localpid: snapshot.info.pid, session: snapshot.sessionId, outcome: "birth-observe-unknown" });
			throw new Error(`daemon 出生观察 unknown（pid ${snapshot.info.pid}，固定类别，raw detail 不入报告通道）`);
		}
		if (id.state !== "alive") {
			deps.ledger({ event: "start", nonce: deps.nonce, localpid: snapshot.info.pid, session: snapshot.sessionId, outcome: `start-identity-${id.state}` });
			throw new Error(`daemon 出生身份不可采（${id.state}）`);
		}
		const mismatches: string[] = [];
		if (id.identity.ppid !== deps.expectedParentPid) mismatches.push(`ppid=${id.identity.ppid} != 期望父 ${deps.expectedParentPid}`);
		if (deps.expectedPgid !== undefined && id.identity.pgid !== deps.expectedPgid) mismatches.push(`pgid=${id.identity.pgid} != 期望组 ${deps.expectedPgid}`);
		if (!id.identity.command.includes(deps.daemonMarker)) mismatches.push("command 无 marker（片段不透传）");
		if (id.identity.birth.trim() === "") mismatches.push("birth 为空");
		if (mismatches.length > 0) {
			// R-Q9g：mismatches 已去命令片段；持久通道固定类别，细节保留在 throw（非持久）
			deps.ledger({ event: "start", nonce: deps.nonce, localpid: snapshot.info.pid, session: snapshot.sessionId, outcome: "birth-identity-mismatch" });
			throw new Error(`daemon 出生身份不匹配（拒收，不冻结代际）: ${mismatches.join("; ")}`);
		}
		return { ppid: id.identity.ppid, pgid: id.identity.pgid, birth: id.identity.birth, marker: deps.daemonMarker };
	}

	/** R-Q9a：track——同步登记 dispose 先于任何 await/观察；snapshot/出生观察失败 catch→dispose→保留原异常
	 * 并附 cleanupError 后重抛（dispose 失败不吞原异常、也不被原异常吞掉）。 */
	static async track(deps: DaemonResourceDeps): Promise<DaemonResource> {
		// R-Q9a finalizer 状态机：
		// - 登记 callback 触发 finalize：未就绪＝真实 close + unconfirmed 失败；就绪＝实例 dispose（正向消失）。
		// - settled 缓存同一结果/失败（sticky：失败恒失败，重复调用不因 close 已发生变成功）。
		// - close 已启动（settled 存在）后，迟到 snapshot 不得发布 ready（R-Q9a-②）。
		let settled: Promise<void> | undefined;
		let resource: DaemonResource | undefined;
		const finalize = async (): Promise<void> => {
			if (settled !== undefined) return settled; // sticky：同一 cleanup 结果/失败
			const run = (async () => {
				if (resource !== undefined) {
					await resource.dispose(); // 就绪态：实例 dispose（幂等，waitOwnerGone 正向消失）
					return;
				}
				deps.connection.close(); // 未就绪：真实 close
				await DaemonResource.disposeUnconfirmed(deps, "resource 未就绪（登记期 close）"); // 失败恒失败
			})();
			settled = run;
			return run;
		};
		deps.register(() => finalize());
		try {
			const snapshot = await deps.connection.snapshot();
			// R-Q9a-②：close 已启动（登记 callback 已触发）→ 拒绝发布 ready（不偷偷重绑/清空错误）
			if (settled !== undefined) {
				deps.ledger({ event: "unknown", nonce: deps.nonce, outcome: "snapshot 迟到：cleanup 已启动（closed/unconfirmed），拒绝发布 ready" });
				throw new Error("pi-env daemon track rejected：cleanup 已启动（closed/unconfirmed），不发布 ready");
			}
			const generation = DaemonResource.observeBirth(deps, snapshot);
			deps.ledger({ event: "start", nonce: deps.nonce, localpid: snapshot.info.pid, pgid: generation.pgid, ppid: generation.ppid, birth: generation.birth, session: snapshot.sessionId, outcome: "alive" });
			resource = new DaemonResource(deps, snapshot, generation);
			return resource;
		} catch (originalError) {
			// track 失败：走同一 finalize（未就绪＝close+unconfirmed 恒失败；就绪＝实例 dispose）；
			// 原异常为主异常保留，finalize 异常以 cleanupError 附带（两异常都可见，不互吞）
			// R-Q9g：原始错误不切片入持久通道（重抛保留完整语义）；ledger 固定类别
			deps.ledger({ event: "cleanup", nonce: deps.nonce, outcome: "track-failed" });
			let cleanupError: unknown;
			try {
				await finalize();
			} catch (disposeError) {
				cleanupError = disposeError;
			}
			(originalError as Error & { cleanupError?: unknown }).cleanupError = cleanupError;
			throw originalError;
		}
	}

	/** pid/generation 未采得时的收尾：只有 close（正向已完成）+ 如实 unconfirmed 抛错，绝不假 gone。 */
	static async disposeUnconfirmed(deps: DaemonResourceDeps, reason: string): Promise<never> {
		deps.ledger({ event: "unknown", nonce: deps.nonce, outcome: "unconfirmed-close" });
		throw new Error(`pi-env daemon 收尾 unconfirmed（${reason}）——不宣称 clean`);
	}

	/** R-Q9b：kill 前全字段身份复核（ppid/pgid/birth/marker 与冻结代际比对），任一漂移拒杀（unknown）。 */
	inspectIdentity(): void {
		const id = psIdentity(this.#deps.observer, this.pid);
		// R-Q9g：固定类别；ppid/pgid/birth 已在事件字段（安全标量），不拼进 outcome
		const outcome = id.state === "alive" ? "alive" : id.state;
		this.#deps.ledger({ event: "inspect", nonce: this.nonce, localpid: this.pid, pgid: this.generation.pgid, ppid: this.generation.ppid, birth: this.generation.birth, session: this.session, outcome });
		if (id.state !== "alive") throw new Error(`daemon ${this.pid} 身份失效（${id.state}）——拒杀`);
		if (!matchesGeneration(id.identity, this.generation)) {
			const drift: string[] = [];
			if (id.identity.ppid !== this.generation.ppid) drift.push(`ppid ${id.identity.ppid}→${this.generation.ppid}`);
			if (id.identity.pgid !== this.generation.pgid) drift.push(`pgid ${id.identity.pgid}→${this.generation.pgid}`);
			if (id.identity.birth !== this.generation.birth) drift.push(`birth 漂移`);
			if (!id.identity.command.includes(this.generation.marker)) drift.push(`marker 漂移`);
			throw new Error(`daemon ${this.pid} 身份与登记代际不符——拒杀（${drift.join("; ")}）`);
		}
	}

	/** kill：先全字段复核（不符即拒杀、注入 spy 零调用），再 kill + 等正向消失。 */
	async kill(): Promise<void> {
		this.inspectIdentity();
		this.#deps.ledger({ event: "cleanup", nonce: this.nonce, localpid: this.pid, pgid: this.generation.pgid, ppid: this.generation.ppid, birth: this.generation.birth, session: this.session, outcome: "sigkill" });
		this.#deps.kill(this.pid, "SIGKILL");
		await waitOwnerGone({
			observer: this.#deps.observer,
			pid: this.pid,
			generation: this.generation,
			nonce: this.nonce,
			deadlineMs: this.#deps.deadlineMs ?? 5000,
			ledger: (e) => this.#deps.ledger(e),
		});
	}

	/** R-Q9a'：dispose——pid/generation 未采得/unknown 时必须失败收尾（ledger unknown + throw unconfirmed），
	 * 不得假 gone/假 clean；已确认态：close + waitOwnerGone 正向消失。幂等。 */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		if (!Number.isInteger(this.pid) || this.pid <= 0) {
			this.#deps.ledger({ event: "unknown", nonce: this.nonce, outcome: "dispose unconfirmed：pid/generation 未采得（观察未完成），如实失败不伪 clean" });
			throw new Error("pi-env daemon dispose unconfirmed：观察未完成，不宣称 clean");
		}
		this.#deps.ledger({ event: "cleanup", nonce: this.nonce, localpid: this.pid, pgid: this.generation.pgid, ppid: this.generation.ppid, birth: this.generation.birth, session: this.session, outcome: "connection-close" });
		this.#deps.connection.close();
		try {
			await waitOwnerGone({
				observer: this.#deps.observer,
				pid: this.pid,
				generation: this.generation,
				nonce: this.nonce,
				deadlineMs: this.#deps.deadlineMs ?? 5000,
				ledger: (e) => this.#deps.ledger(e),
			});
		} catch (e) {
			// R-Q9j：原始异常不切片入持久通道（重抛保留语义）；ledger 固定类别
			this.#deps.ledger({ event: "unknown", nonce: this.nonce, localpid: this.pid, outcome: "dispose-observe-unknown" });
			throw e;
		}
	}
}
