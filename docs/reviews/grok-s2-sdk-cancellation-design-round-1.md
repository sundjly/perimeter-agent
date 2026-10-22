# Grok S2 SDK/协议取消改造设计 第一审（round-1，仅方案）：G1 session-pin 子方向认可；整体 request_changes（5 处 required）

- 结论：**request_changes（设计文档层面）**。G1 session-pin 子方向方向性认可，并认可协调者最小分段建议（本轮只做 G1-only：`remote-env.ts`+options+d.ts 的 JS 补丁，零 Rust/协议/daemon/镜像变更，兼容现装 1.1.0 daemon）；但按协调者五点，设计文档现状未严谨处一律 **required、不降建议**：①info/session 跨 await 非原子；②pin 运行时可信核验缺失（仅 TS 类型不算数）；③closeAsync 证据越级（transport exit ≠ daemon 已 kill_all）；④`groupReaped` 会经 `remote-env.ts:923` 的 spillPath-only 白名单丢失，且生产 capability 缺失语义未定死；⑤构建/落地命令与平台矩阵不精确（`npm run build` 与 pi-mono AGENTS 禁令矛盾）。**设计批准≠runtime 成功**：G1 的 30s 未察觉窗口、G3 网络分区的「死+严格时限」不可兼得均维持如实声明；s2-protected-paths/S2 维持 partial。
- 日期：2026-10-17；审查者：grok（唯一 reviewer；Pi 唯一 coder，task_29aa99ef3e07 设计交付）。本审为纯设计审，零代码改动、零构建、零协议运行探针（全部事实以源码读证，读文件不需要 runner）。
- 审读输入：`docs/implementation/s2-sdk-cancellation-design.md`（75 行）；`/Users/sundy/projects/pi-mono`（HEAD `cdaf6c227` = `v1.1.0-24`；`git diff v1.1.0..HEAD -- packages/env` 仅 `CHANGELOG.md` +2 行——**src 实质与 v1.1.0 一致**，但 HEAD 非 tag 本身，文档表述应更正）；`pi-mono/AGENTS.md` 全文；安装 SDK `node_modules/@earendil-works/pi-env`（**物理目录非链接**，`package.json` version 1.1.0，与上 meet）。
- 允许写入：本文件、coverage 必要注记（阶段仍 partial）。未改任何源码/tests/作者文档/handoff/AGENTS；未跑 `npm run build`/`npm test`/install 脚本；未生成/替换镜像与安装目录产物；未 commit/push/spawn；未碰 daemon/context/workload/secret。

## 1. 事实 trace 独立核验（本审逐条对照源码，行号为 HEAD）

| 设计声称 | 本审核验 | 结果 |
|---|---|---|
| `request()` `options.session` 已 pin：mismatch/!live 立即 `lost`，不 `#connect` | connection.ts `async request()`：`current.id !== options.session \|\| !current.live → throw lost(...)`；pin 分支无 `#connect` | ✓ |
| `session()` 公开存在、与 `info()` 共享 `#ready` memo | `async session() { return (await this.#connect()).session.id; }`；`#connect` memo `#ready`（失败重置） | ✓ |
| session id 单调 `++#sessions`，旧 pin 永不匹配新 daemon | `new Session(++this.#sessions, ...)` | ✓ |
| `#send` onAbort 仅写 CANCEL，以 daemon 真实帧收尾 | `onAbort = () => this.#write(session, frame(CANCEL, id, {}))` | ✓ |
| `#teardown` `stdin.end()+child.kill()` 后立即 reject pending，不 await 退出 | connection.ts:307-320 逐行一致 | ✓ |
| 预算 = START 60s / SILENCE 30s（构造即计时） | `START_TIMEOUT_MS=60_000`、`SILENCE_LIMIT_MS=30_000`、`Session` 构造 `lastSeen=Date.now()` | ✓（行号 :16/:18 应为 :15/:17，无实质） |
| `exec` 不带 `session` → 掉线后走 `#connect` 重连（G1 唯一缺口入口） | remote-env.ts:872-885：request options 仅 `{signal,onStart,onEvent}`；对照 **Handle 类操作带 pin**（:145 `{...options, session: this.session}`）——不对称属实 | ✓ |
| `#running` id→session 供 `cleanup()` kill；构造无 pin 概念 | `#running.set(requestId, session)`（:887）；`RemoteExecutionEnvOptions` 无 session 字段 | ✓ |
| Rust waiter `child.wait()`→`Message::Exit`；主循环 break 需 `status.is_some() && 两管道 ended`；exit 后 100ms grace | exec.rs:319-320、:379、EXIT_STDIO_GRACE=100ms | ✓**但不完整，见 §2-R3** |
| cancel/timeout `kill_group(pid)`=组 SIGKILL，**不验证成员消亡**；settle 时 `groups.remove` | exec.rs:110-112 `sys::kill_tree(pid)`→unix.rs:291 `libc::kill(-pid, SIGKILL)`，无验证 | ✓ |
| close/lost：`kill_all(groups)+std::process::exit(0)`，无 wait 无终止证据 | main.rs:470-471（stdin 结束路径）等 | ✓ |
| daemon 是 `docker exec`/`ssh` 驱动的子进程，非 daemon 本体 | sandbox.Dockerfile：容器内 `pi-env`；宿主 Connection 子进程为 `docker exec -i …` CLI | ✓（设计 §3 层1 自己的推断违反此点，见 §2-R3） |
| 安装 SDK 1.1.0 物理目录、与 HEAD src 实质一致 | 物理目录（realpath 在 node_modules 内）；v1.1.0..HEAD 仅 CHANGELOG +2 | ✓（表述更正见 §2-R5） |

## 2. required 修正（5 处，对应协调者五点；不降建议）

- **R1（原子性）**：§2「`connection.info()` 后 `connection.session()`——同 `#ready`，零额外连接」是无条件表述。两次调用间 `#ready` 可被 teardown 清空（connection.ts:311-314），下一次调用会触发**新连接**（新 session id），或 info 后 daemon 死亡使 pin 落在已死会话（立即 lost=按需求语义 deny）。修正：改为 **session-first 单点捕获**（`openEnvironment` 先 `await connection.session()` 取 id，同一次 `#ready` 内再取 info），并写明三种时序后果（同会话成功 / 捕获后 teardown=pin 立即 lost 的持续 deny=被要求语义 / 捕获前 reconnect=pin 到新活会话），删除「无条件零额外连接」表述。
- **R2（pin 运行时可信）**：`sessionPin?: number` 对旧 SDK 是被静默忽略的未知字段——TS 类型不报错≠运行时有 pin。修正：落地包必须含 **runtime 能力/产物核验**：(a) vendor SHA-256 台账 + 安装后脚本校验失败即**硬失败**（非仅跳过复制）；(b) 网关启动时对 `node_modules/.../dist/remote-env.js`（及 d.ts）做台账比对，mismatch 时生产模式按「守卫能力缺失」既有 fail-closed 语义拒绝路径类工具（不静默回退无 pin 行为）。npm ci 重装 1.1.0 原版即失配被检出的场景须在验收矩阵内。
- **R3（closeAsync 证据降级）**：§3 层1「transport 退出 ⇒ daemon 已越过 kill_all→exit ⇒ SIGKILL 已对全部 pid 发出」不成立——Connection 子进程是 `docker exec`/`ssh` 驱动，其 exit 只证客户端侧管道关闭；容器内 daemon 的 stdin-EOF 感知与 `kill_all→exit` 异步且客户端不可观测。修正：`closeAsync` 结果只能是 **`transportExit` 证据**，语义文档化为「驱动进程退出，远端 kill_all 归属 pending/unknown」，禁止升级为「远端已 SIGKILL」；层1 对 G3 的价值据此重写（G3 lost 仍不可证明，任何帧无法向已消失客户端举证——设计此句保留）。
- **R4（verifyReap 通路与生产语义）**：当前 `remote-env.ts:923` 错误字段白名单**只有 `spillPath`**——daemon 回帧的 `groupReaped` 会丢失，设计未写回帧→guard 的真实通路。修正（若层2 选型）：JS 侧显式透传 `groupReaped`（含类型与「缺失/未知」语义）；**生产模式 capability 未宣告时必须在 helper 启动前 fail-closed 拒绝**（或明示该门保持 pending、不得作为已闭门槛），不得「旧 daemon 照跑未知」偷降门槛；旧 daemon 忽略未知请求字段的负控、`false`=「限内未能确认」而非「确认存活」的文档化保留。
- **R5（构建/provenance 精确化 + 分段）**：§5 A 的命令 `npm run build` 与 pi-mono AGENTS「Never run npm run build unless requested」矛盾，且 Darwin cargo 产物不能进 Linux 镜像。修正：按协调者最小分段**本轮只做 G1-only（JS+d.ts）**——无需 cargo/daemon bin/Dockerfile 变更（pin 是客户端特性，现 1.1.0 daemon 即兼容）；待授权命令精确列为 `cd packages/env && ./node_modules/.bin/tsc -p tsconfig.build.json`（或仓库等价定向 tsc）单条，执行前报协调者批准；层2 若未来选型，daemon 须 Linux 工具链（容器内 `cargo --locked --target <linux-target>`，准确 OS/arch/toolchain 表）另立包。HEAD 表述改为「v1.1.0-24（env 相对 tag 仅 CHANGELOG +2，src 一致）」。禁止当前生成/替换用户镜像或安装目录——本轮双方均未构建，符合约束。

## 3. G3 四件事分清（本审源码定版口径，设计文档据此改写）

1. **直接子进程死亡**：waiter `child.wait()` 返回才有 `Message::Exit`；两条 break 路径（:379 管道尽/:381-384 idle grace）都要求 `status.is_some()` → **正常 result/error/aborted/timeout settle 时直接子已被内核收割**（层0 可证，无需协议改）。
2. **管道收尾**：break 有两条件——`ended[0]&&ended[1]` **或** Exit 后 100ms idle grace 到点（「descendant may hold the pipes open」exec.rs:382）。设计 §1 漏写 idle 分支：settle 时管道可能仍未结束（孙进程持管道），层0 表述不得隐含「管道已尽」。
3. **组内后代**：cancel/timeout/kill 时 `kill(-pid,SIGKILL)` 已发不验证；**正常退出路径根本不发组杀**（后台后代按 exec 语义可存活）——层0 的「SIGKILL 已发」仅限 abort/timeout/kill 场景，normal exit 不适用；setsid 逃逸者不在组内。D 状态可令 SIGKILL 后短暂残留（设计已列）。
4. **transport lost**：客户端侧 teardown 立即 reject（connection.ts:307-320）；daemon 侧 kill_all→exit 无 wait 无证据；网络分区下「已终止」与「严格时限」不可同时证明 → lost/分区场景**一律 pending/unknown**，资源归 perimeter unconfirmed 台账；失联会话（pinned）**禁止新守卫操作**（立即 lost deny），不影响其它 session/工具 env（pin 仅作用于构造实例；`#running` 按实例隔离），无批量杀资源。G3 维持 blocked/待选型，不因层0 措辞改写而宣称闭合。

## 4. 可证验收矩阵 vs 外部 unknown（实施轮执行；本审未运行）

可证（SDK 本地单测 + perimeter 本地 + capability 负控）：pin 后杀 daemon → pinned exec 立即 lost、`#sessions` 不增、旧 pin 不匹配新会话、未 pin exec 逐字节回归一致；vendor 台账 mismatch → 安装/启动硬失败；守卫 env(pin)+daemon 死亡 → deny 且无新 `pi-env` 连接子进程、工具 env 同连接自动重连正控；（若层2 选型）capability 三态负控（旧 daemon 无字段=unknown 不假安全）。
外部 unknown（不可证，维持声明）：K8s/真实集群、gVisor runtimeClass、网络分区时序、D 状态残留时长、setsid 逃逸。

## 5. verdict 与放行

- **G1-only 子设计**：方向认可；按 §2-R1/R2/R5 修订后的设计可由协调者选型进入实施（实施=独立编码包，验收按 §4 矩阵；本审不预支 runtime 成功）。
- **整体设计文档**：**request_changes**（R1-R5 逐条修订后复审，可只重发 diff 节）。
- **层1 closeAsync / 层2 verifyReap**：按 R3/R4 重构后再议；在 G3 保持诚实 pending/unknown 的前提下，二者非本轮必需——**不为原「缺 ack」论断引入 Rust/协议/镜像供应链包**。
- coverage：`s2-path-guard` 维持 **partial**（设计轮不改阶段），证据字段追加本轮设计审结论。
