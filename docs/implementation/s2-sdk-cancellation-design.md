# s2-sdk-cancellation-design.md — G1 session pin + G3 终止证据：env SDK 最小改造设计（仅设计，未实施）

- 日期：2026-10-17；作者：Pi（task_29aa99ef3e07 / ctx_c203f611faab）。性质：设计文档。
- **R1 审（grok-s2-sdk-cancellation-design-round-1.md）：整体 request_changes（R1-R5），G1 session-pin 子方向认可；协调者已选定 G1-only 子切片进入实施。** 本文 §2/§3/§5 已按 R1-R5 全部修正；修正摘要：R1 原子快照替代跨 await；R2 pin 运行时台账核验硬失败；R3 closeAsync（未选型）证据降级为 transportExit；R4 verifyReap 需显式透传+生产未宣告即 fail-closed（本轮未选型）；R5 HEAD 表述 v1.1.0-24（env 相对 tag 仅 CHANGELOG +2，src 一致）、授权命令为定向 tsc、Darwin cargo 产物不得进 Linux 镜像（层2 若未来选型须 Linux 工具链另立包）。
- 依据源码：`/Users/sundy/projects/pi-mono/packages/env` @ HEAD `cdaf6c227`＝`v1.1.0-24`（`git diff v1.1.0..HEAD -- packages/env` 仅 CHANGELOG +2 行，**src 与 v1.1.0 一致**；dirty 仅 untracked docs，未触碰）。本文件不改任何代码。

## 1. 事实 trace（本轮全量重读源码，行号为当前 HEAD）

**客户端 `src/connection.ts`（384 行）**：
- `request()` :103-115：`options.session` 已存在——pin 时 `current.id !== session || !current.live` → **立即 `lost`，不 `#connect`、不重启 daemon**（G1 所需原语已在 public 面上）。
- `session()` :99-101：连接并返回 live session id；与 `info()` 共享 `#connect()` 的 `#ready` memo（:141-152）——**同一就绪会话，无二次连接**。
- session id 由 `++this.#sessions`（:185）单调递增：**旧 pin 永远不会匹配新 daemon**（teardown 清 `#session/#ready` :268-271，新 start id 必更大）。
- `#send` onAbort 仅写 CANCEL（:157），请求以 daemon 真实 result/error 收尾；`#teardown`（:262-275）`stdin.end()+child.kill()` 后立即 reject pending，**不 await transport 子进程退出**（G3 现状）。
- `#start()` :177-260：spawn/hello 全程无 signal；预算 = START_TIMEOUT 60s(:18) 与 SILENCE 30s(:16, `lastSeen=Date.now()` 构造即计)。

**客户端 `src/remote-env.ts`（939 行）**：
- `exec` :834-930：无 `cwd` 选项时不经 `#resolve/info()`；`request("exec", …, { signal, onStart, onEvent })` **不带 `session`** → 掉线后下一 exec 走 `#connect()` 自动重连（G1 缺口唯一入口）。
- `RemoteExecutionEnvOptions` :345-368；`#running` :359（id→session，供 `cleanup()` :932-935 kill）。构造函数 :363-371 无 pin 概念。

**daemon `src/exec.rs`（483 行）/`main.rs`（516 行）/`sys/unix.rs`**：
- waiter 线程 `child.wait()` → `Message::Exit(status)`（exec.rs:221-225）；主循环 `status.is_some() && 两管道 ended` 才 break（:356-358），exit 后 100ms grace（:369）——**正常 result/error/aborted/timeout 收尾时直接子进程已被 wait 收割（有内核状态）**。
- 组内后代：cancel/timeout/kill 时 `kill_group(pid)`＝`kill(-pid, SIGKILL)`（unix.rs:287-296）发出后**不验证成员消亡**；`groups.remove(pid)` 于 settle 时无条件执行（exec.rs:391）。setsid 逃逸者本就不在组内（configure :270 setsid 使 child 为组长）。
- close/lost：stdin 结束或 30s 静默 → `kill_all(groups)` + `std::process::exit(0)`（main.rs:307-312, 463-472, 505-510）——**无 wait、无终止证据**；R4「0ms settle+46ms 消失」即此异步性，非正常机制缺陷。
- cancel 注册先于运行（main.rs:395-397），control 先查标记再 attach sender（exec.rs:60-80）——竞态安全。

## 2. G1 设计（最小）：guard exec pin 到打开时会话

**SDK 变更（仅 `src/remote-env.ts` + 其 options 类型，零协议/daemon 变更）**：
1. `RemoteExecutionEnvOptions` 增可选字段 `sessionPin?: number`。
2. 直接在既有 `exec` 的 request options 传 `session`（`...(this.#sessionPin === undefined ? {} : { session })`），**不抽 #execCore、不重复 exec 实现**。普通用户 exec 行为逐字节不变；其它 env 实例/会话不受伤（pin 只作用于构造实例，`#running` 按实例隔离）。
3. **运行时可信（R2）**：旧 SDK 会静默忽略未知 constructor 字段——TS 类型不算数。必须：(a) vendor SHA-256 台账 + 人工调用 apply 脚本校验失败即**硬失败**（非跳过）；(b) 打开阶段对安装的 `dist/connection.js|remote-env.js`（及 d.ts）做台账比对，mismatch/重装原 1.1 → **拒绝创建 pinned env**（生产=守卫能力缺失既有 fail-closed），严禁回退 unpinned；(c) SDK 级可核只读能力：`pinnedSession` getter 返回实际 pin id，构造后核对 `===` 期望值，缺方法/不等 → 拒绝。
4. **准备路径（R1/协调者）**：pinned guard 不得经任何自动 reconnect/info 懒连接——`exec` 的 prep 仅 `options.cwd` 会触发 `#resolve→info()`；守卫 argv 固定且无 cwd override，SDK 在 pinned 下遇 `options.cwd` 显式 fail-closed（不支持参数），其余 prep 纯本地。

**产品接线（后续实施轮，perimeter 仓）**：`info()`→`session()` 两次 await **非原子**（R1：两次调用间 `#ready` 可被 teardown 清空，或 daemon 死亡使 pin 落在已死会话）。改为 **单点原子快照**：`Connection` 新增极小 public `snapshot()`（命名即此），一次 `await #connect()` 同时返回 `info` 与 `sessionId`；只在 env 打开时调用一次（打开预算属既有生命周期，不用于每次 guard）。三种时序后果如实声明：①同会话成功；②捕获后 teardown → 旧 pin 后续立即 lost 的持续 deny（被要求语义）；③捕获前发生 reconnect → pin 到新活会话（仍一致，无跨代混用）。以 `sessionPin` 构造**第二个** RemoteExecutionEnv（同一 Connection、同 cwd）专供守卫；工具 env 不 pin，行为不变。
**语义**：daemon 存活期与现状完全一致；daemon 死亡后守卫 exec 立即 `lost` fail-closed（无重连、无新 daemon），工具 exec 仍按原语义自动重连（普通用户能力不变）；守卫在 env 重建（会话级）前持续 deny——这是被要求的语义。已知边界（非本设计引入，如实声明）：transport 已死但客户端未察觉（无写失败信号）时，请求悬至 SILENCE 30s teardown 才 reject，守卫 3s 预算在该窗口内只能靠事后分类兜底；可选扩展（客户端侧 abort 后宽限 reject）改变「以 daemon 结果收尾」语义，**不进本最小设计**，列为待议。
**失败状态**：pinned exec 的失败 = `RemoteError(unknown, lost)` → 守卫 fail-closed deny（类别 unknown），资源归 perimeter unconfirmed 台账。

## 3. G3 设计：分层终止证据（不撒一律 reaped）

**层 0（已存在，R1 §3 定版口径）**：正常 result/error/aborted/timeout = **直接子进程已被 `wait()` 收割**（两条 break 路径——管道尽**或** Exit 后 100ms idle grace——都要求 `status.is_some()`；settle 时管道可能仍未结束，孙进程可持管道）。**组杀只在 abort/timeout/kill 场景发出；正常退出路径根本不发组杀**（后台后代按 exec 语义可存活），「SIGKILL 已发」不适用于 normal exit。组内后代 = SIGKILL 已发、未验证；setsid 逃逸 = 不在组内、不可达。
**层 1（R3 降级后口径；本轮未选型）**：`Connection` 子进程是 `docker exec`/`ssh` **驱动进程，不是 daemon 本体**——其 exit 只证客户端侧管道关闭；容器/Pod 内 daemon 的 stdin-EOF 感知与 `kill_all→exit` 异步且客户端不可观测。故 `closeAsync` 结果只能是 **`transportExit` 证据**，语义文档化为「驱动进程退出，远端 kill_all 归属 pending/unknown」，禁止升级为「远端已 SIGKILL/已 kill_all」。G3 lost 仍不可证明（任何帧无法向已消失客户端举证）。lost（无 close）**保持不可证明**——客户端离线后 daemon 的收尾帧无处可去，任何协议扩展都无法向已消失的客户端举证；资源归属留 perimeter unconfirmed，等下次同机连接再核（不新造 provider）。
**层 2（R4 修正后口径；本轮未选型）**：`remote-env.ts:923` 错误字段白名单**只有 spillPath**——daemon 回帧的 `groupReaped` 必须在 JS 侧显式透传（含类型与「缺失/未知」语义），否则静默丢失。生产模式 capability 未宣告时必须**在 helper 启动前 fail-closed 拒绝**（或明示该门保持 pending），不得「旧 daemon 照跑未知」偷降门槛；`false`＝「限内未能确认」而非「确认存活」须文档化；旧 daemon 忽略未知请求字段的负控保留。若未来选型，daemon 须 Linux 工具链（容器内 `cargo --locked --target <linux-target>`）另立包——Darwin 产物不得进 Linux 镜像。

## 4. 不涉及范围

不改 Durable `ShellExecOptions`/provider/其它 SDK 包/Durable API/cache prefix/依赖版本锁文件/新依赖；不做 Promise.race 假取消；不取消 waiter 牵连共享连接其它请求（层 0-2 都不动 `#send` 的 settled-by-daemon 语义）；不批量杀用户资源；不承诺网络分区下「严格时限+已终止」同时成立；不覆盖 setsid 逃逸进程（文档化 unknown）。

## 5. 可复现落地（选项比较，均待确认后执行，本轮未构建/未替换任何产物）

| 选项 | 做法 | 优点 | 代价/风险 |
|---|---|---|---|
| A（推荐） | pi-mono 内改源 → `tsc -p tsconfig.build.json` 产出 JS + `npm run build:daemon`（cargo --locked）产出 daemon bin → 以 **SHA-256 台账**把两个产物放进 perimeter 仓 `vendor/pi-env/`（JS 覆盖由安装后脚本按台账校验后复制，daemon bin 由 Dockerfile 改为 `COPY vendor/...` 而非 node_modules bin） | Node 与 Docker 用**匹配**的 JS+daemon；不动 lockfile；宿主 node_modules 损坏可重装恢复 | 需要安装后校验脚本（无新依赖，纯 node 脚本）；Dockerfile 一行改动 |
| B | patch-package 式 node_modules 补丁 + 镜像内同步替换 bin | 与现有安装流兼容 | patch 校验弱、升级易丢；daemon bin 仍要进镜像，问题同 A |
| C | 发版 1.1.1 + 升级依赖 | 最干净 | 需 npm publish（外部）、lockfile 变更——本轮禁止 |

- Rollback（A）：删除 vendor 目录 + 还原安装后复制 + Dockerfile 一行还原；node_modules 由 `npm ci --ignore-scripts` 重装即回 1.1.0 原版。
- **授权命令（R5 精确化，G1-only）**：仅定向 `tsc -p packages/env/tsconfig.build.json`（现有 tsc 5.9.3，输出到本轮 owned 临时 outDir，不覆写其它 SDK dist）；**零 Rust/协议/daemon/bin/Dockerfile/镜像变更**（pin 是客户端特性，现 1.1.0 daemon 即兼容），禁止 cargo 或引入 binary 供应链。`npm run build`/`npm test` 仍禁止；SDK root `npm run check` 含全仓 biome --write，禁在用户工作树照跑——只读等价检查（去 --write，完整保存输出）+ owned files 检查。
- Dockerfile 现状引用：`sandbox.Dockerfile` 从 `node_modules/@earendil-works/pi-env/bin/pi-env-linux-<arch>/pi-env` 拷贝——A 选项改为从 vendor 拷贝，杜绝「宿主新 JS+镜像旧 daemon」错配。

## 6. 验证矩阵（实施轮执行；本轮未运行）

| 层 | 用例 | 通过判据 |
|---|---|---|
| SDK 单测（vitest + test/daemon.ts 本地 daemon） | pin 后杀 daemon → 下一 pinned exec 立即 lost；`#sessions` 不增（无新 spawn）；旧 pin 永不匹配新 session；未 pin exec 行为与现版本逐字节一致（回归对比） | 全部成立 |
| SDK 单测 | verifyReap：无请求字段（旧客户端/旧 daemon）→ 错误帧无字段；有字段+新 daemon → 挂组被杀后 `groupReaped:true`、不含组进程的正常退出场景不附字段或 false；hello capabilities 缺失时客户端不发字段 | 缺失=unknown，不假安全 |
| SDK 单测 | closeAsync：正常 close 拿到 transportExit=true 与退出状态；≤5s 超时路径返回 pending（不吞不假） | 成立 |
| perimeter 本地 | 守卫 env(pin) + daemon 死亡：deny 且无新 `pi-env` 连接子进程；工具 env 同连接自动重连成功（普通行为不变正控） | 成立 |
| perimeter Docker 真实 | 既有 kill 矩阵全绿（timeout/abort/组空/健康后续）；新增：pinned 守卫 + docker stop → 即时 fail-closed 且后续守卫持续 deny 直到 env 重建；新 daemon bin 与新 JS 匹配部署 | 成立 |
| capability 负控 | 新客户端 JS + v1.1.0 旧 daemon bin：verifyReap 缺失 → 守卫维持 unknown/pending，功能不回退不假绿 | 成立 |

## 7. 风险与外部未知

- setsid 逃逸进程任何层都不覆盖（协议组级语义固有）。
- 「transport 已死未察觉」窗口（客户端 30s 静默兜底）在层 0-2 下仍存在；可选客户端宽限 reject 改变取消语义，留待门审另议。
- `groupReaped` 轮询的 200ms 上限在极端负载下可能不够 → `false`（unknown 方向），不会假 true；但 false 的语义必须文档化为「未能在限内确认」，非「确认存活」。
- D 状态（不可中断 IO）进程可令 SIGKILL 后短暂残留：层 0 的 wait 只证直接子进程；层 2 轮询超时归 false/unknown。
- K8s/真实集群、gVisor runtimeClass 下 kill/close 时序未实测（沿用既有 unknown 声明）。
- 依赖外部事实：npm 发布渠道（选项 C）与客户镜像构建流程不在本轮可控范围。
