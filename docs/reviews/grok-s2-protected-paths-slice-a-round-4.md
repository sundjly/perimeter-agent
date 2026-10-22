# Grok S2 工具路径守卫（Slice A）第四审（exec helper 真实取消：机制面全绿；两道契约缺口 + 1 处 oracle flake → request_changes 小包）

- 结论：**request_changes（三处 required 最小修复，修复后按 §6 口径复验即可，无需重开全机制审查）**。独立复证：生产路径已无 `canonicalPath` RPC 与 `awaitWithContext` 早返回；Node/Docker 真实 timeout/abort 均 await 收尾并杀 owned helper 进程组；泄露面/注入面/env 最小化/namespace 归属/failclosed 矩阵/canonical 取严与漂移复检全部成立。同轮三道缺口**实锤、不得降为建议**：①远端 home 解析段不受 3s guard 预算约束（实测首连失败 30.0s 才拒绝）；②stdout 上限按 UTF-16 单元计数，多字节负控 9000 字节被接受，与「4096 字节」契约不符；③新 kill 证明测试「立即查死」oracle 并发 flaky（bounded 首跑 1 fail、复跑通过）。`s2-protected-paths` 因 bash/硬链接/敏感读/最终 check-use TOCTOU 残余**维持 partial**；S2/企业生产未批准；四眼有限批准保持。
- 日期：2026-10-16（含协调者恢复消息追加四门槛核查）
- 审查者：grok（唯一 reviewer；Pi 唯一 coder，term_8158350e… 已 retained 停编）
- 对象与哈希：`src/runtime/path-guard.ts`（新增）`4c1d793f41c03e71`、`src/runtime/perimeter-extension.ts` `cec12fc56d1b6db3`、`src/runtime/harness-host.ts` `e5a8e600b264fbbe`、`tests/path-guard-exec-helper.test.ts`（新增）`2be733b6fa7cd2a2`、`tests/protected-paths.test.ts` `93f34f838ab86558`（SHA-256 前 16 hex，本轮实测）。五项与实施报告 `docs/implementation/s2-path-guard-exec-helper.md` 一致。基线为 R3。
- 允许写入：本文件、`docs/reviews/handoff-coverage.json`、R3 最小历史衔接。未改实现、测试、handoff、SDK/依赖、作者报告；未 commit / push / spawn；未运行 r25 旧探针；未触碰不明进程/容器/daemon/用户 workload/真 secret。

## 1. 机制面独立证明（本审自建探针，非复跑 Pi 测试；全部经批准 runner 外层 deadline）

探针 `/tmp/perimeter-r4/grok-kill-proof.ts`（日志 `/tmp/perimeter-r4/grok-kill-proof.log`，exitCode=0、timedOut=false、自然退出 14.7s）。全部 owned 资源（临时目录、本地 sentinel、本地 env、自有容器 `perimeter-pgx…r4g<pid>`、CLI 侧无关哨兵）finally 精确关闭；子命令均带 timeout；断连用 `await` 真实 settle，无 race 吞尾。

| # | 探针 | 实测 |
|---|---|---|
| 1 | helper 快测（固定 argv） | 多级新建回溯落在 root 内；symlink→/etc/passwd 外逃可见；`~`→HOME 越界可见（3/3） |
| 2 | Local exec timeout（挂起 helper+同组孙进程） | verdict=deadline，elapsed=1004ms（await 真实收尾）；`kill(pid,0)`/`kill(child,0)` 双 ESRCH、`ps -o pid=` 空、**`kill(-pgid,0)` ESRCH 组整体消失**；无关 sentinel 存活 |
| 3 | Local in-flight abort | verdict=aborted，elapsed=47ms（不等满 30s timeout）；同三证组消失，sentinel 存活 |
| 4 | Local 后续正控 | kill 后同一 env 上 resolver 正常解析新路径 |
| 5 | Docker RPC timeout | verdict=deadline，elapsed=2011ms；容器内 `/proc/[0-9]*/stat` 全表：helper/孙消失、无任何进程挂原 PGID |
| 6 | Docker in-flight abort | verdict=aborted，elapsed=101ms；容器内组证据相同；`docker exec -d sleep 300` 无关哨兵存活 |
| 7 | Docker namespace + 后续正控 | `root === "/workspace"` ≠ 宿主临时目录（零硬映射）；kill 后 resolver 正常 + `echo ok-after-kill` 正常 |
| 8 | Docker daemon 断连（docker stop） | exec **2ms 真实 settle**，`ok:false`（unknown）——如实 fail-closed |

顺序聚焦复现 `/tmp/perimeter-r4/reap-race-probe.ts`（日志 `/tmp/perimeter-r4/reap-race.log`）：10/10 轮 abort 收尾后 child 在 t0 即 GONE、组空——组杀机制本身无缺口（与 §3 flake 对照）。

## 2. 本轮新鲜测试矩阵（原始 argv、逐项实测日志，报告前已读各日志尾）

| 运行 | 原始 argv（runner header 记录） | exit | tests | pass | fail | skipped | 墙钟 | 日志 |
|---|---|---|---|---|---|---|---|---|
| 静态 | `npx tsc --noEmit`（timeout 300s） | 0 自然 | 0 错误 | - | - | - | 3.3s | `/tmp/perimeter-r4/static-typecheck.log` |
| 专项 | `node --test --test-reporter=spec tests/path-guard-exec-helper.test.ts`（timeout 600s） | 0 自然 | 21 | 21 | 0 | 0 | 45.5s | `/tmp/perimeter-r4/specialized.log` |
| 全量串行 | `node --test --test-concurrency=1 --test-reporter=spec tests/**/*.test.ts`（timeout 1700s） | 0 自然 | **477** | 477 | 0 | 0 | 239.5s | `/tmp/perimeter-r4/serial-full.log` |
| 全量默认并发① | `node --test --test-reporter=spec tests/**/*.test.ts`（timeout 1700s） | **1 自然** | 477 | 476 | **1** | 0 | 130.4s | `/tmp/perimeter-r4/bounded-full.log` |
| 全量默认并发②（稳定性判定） | 同上 | 0 自然 | 477 | 477 | 0 | 0 | 130.8s | `/tmp/perimeter-r4/bounded-full-2.log` |

- 477 = 既有 456（含 R3 三项白名单泄露负测）+ 新增 21。serial 中 Docker 4 项以真实时长执行（✔，非 skip）；各次日志尾 `[bounded-runner] 执行完毕: exitCode=…, timedOut=false` 均已实读。本轮 477×2 为新鲜实测；R3 的 456×2 属历史。
- 作者报告口径核查：serial/bounded 与 npm 脚本一致经 runner；作者表中专项行写裸 `node --test`（无 runner header/PGID 证据）——本审以自己的 runner 版专项复跑作为合规证据，**后续 run 清单须带 runner header（实际 ARGV/PGID/exit）**。

## 3. required 缺陷一：kill 证明测试「立即查死」oracle 并发 flaky

- 事实：bounded ①在 `tests/path-guard-exec-helper.test.ts:351`（Local in-flight abort）失败：`AssertionError: 孙进程 40783 必须已死 — true !== false`；同轮 serial、专项、bounded ②均绿；本审顺序复现 10/10 全部 t0 即 GONE。
- 根因：断言无界、立即、仅按 PID。SIGKILL 送达组内孙进程后，zombie 须 launchd 异步收割才能 ESRCH；11 worker 高并发下 macOS PID 毫秒级复用亦可假存活。产品组杀证据充分（§1 三证、容器全表、10/10 复现）——失败面在测试 oracle。
- 修复要求：改为**有界轮询至消失**（deadline ≤3s，超时才判失败），timeout 分支同型断言（≈line 321）一并加固；修复前该项不得作 CI 稳定门槛。

## 4. required 缺陷二：远端 home 解析段不受 guard 预算约束（协调者追加门槛 G1，实锤）

- 代码事实：`createPathGuardResolver` 在 exec 前 `await env.connection.info()`（WeakMap 缓存 pending），**无 signal/无 budget**；guardPath 的 3s 控制器 abort 对该 await 无作用。
- 实测（`/tmp/perimeter-r4/grok-gates-probe.ts`，日志 `/tmp/perimeter-r4/grok-gates.log`）：对 never-respond daemon，resolver 30,014ms 才以 `code=unknown`（"pi-env connection timed out"）拒绝——SDK `SILENCE_LIMIT_MS=30s` 兜底（源码 `connection.js:13,215`），**3s guardTimeoutMs 未约束该段**。连接建立后 `info()` 走缓存（`(await #connect).info`，不再出网）；生产网关在 `openEnvironment` 已首连，故常态为缓存命中；缺口窗口=首连未完成或 teardown 后重连（如 daemon 中途死亡后每次守卫尝试重连≈30s 悬挂再 deny）。
- 性质：fail-closed 与有界性保持（30s 有界、拒绝类别 unknown、无背景任务残留——实测 teardown 后无子进程），但「guard 单阶段总预算（默认 3s）覆盖 helper 启动与全部解析」（实施报告 §2.2）与代码不符。
- 修复要求（任一）：home 解析与守卫 deadline 竞速（`controller.signal` 传入/`Promise.race`，超时即 deny=deadline）；或在 env 打开时预取 home 并把该 await 移出守卫路径；同时更正预算声明。

> 【协调者否决注记 2026-10-17】上条「竞速/`Promise.race`」修复方案**不采纳**：race 提前拒绝只是停止等待，SDK 内部 `#connect`/连接启动仍在后台走完，不构成真取消；仅定时 reject 的 connect 预算 API 同样不够，须真取消 bootstrap 并 await owned 启动子进程/transport close。`Connection.request` 的 `options.session`（session pin）已存在而 `RemoteExecutionEnv.exec` 未透传，是具体边界。G1 的 SDK 侧重连/首连预算与远端生命周期收尾维持 **blocked**（精确行号与最小 API 需求见 `docs/implementation/s2-path-guard-bootstrap-blocker.md`；in-repo metadata 免 info await 部分已由 Pi 于 R5 交付并实测）。原始证据与本条原文保留不改。

## 5. required 缺陷三：stdout 上限按 UTF-16 单元计数，字节契约不成立（门槛 G2，实锤）

- 代码事实：`stdout.length + text.length > PATH_GUARD_MAX_STDOUT_BYTES` 为 UTF-16 code unit 比较（`path-guard.ts` onOutput）。
- 实测（同 §4 探针）：helper 输出 `canonical` 含 `"路径".repeat(1500)`（≈3000 单元、**≈9000 UTF-8 字节 > 4096**）→ verdict `ok:true` 被接受；ASCII 5000 单元仍正确 unknown。实施报告「超量 stdout（4096 字节上限）」与代码不符。
- 性质：缓冲仍有界（≈≤4096 单元 ≈ 上界 ~12KB），canonical 仍必经策略复判，无安全绕过；但契约声称的「字节上限」未执行。
- 修复要求：以 `Buffer.byteLength` 累计判界（一行级修复）；stderr 路径已核——guard 只弃不读、无 spill 选项即无 SDK spill 文件（`options?.spill` 未传），无旁路泄露。

## 6. 协调者追加门槛 G3/G4 核查结论（closed）

- **G3（lost ≠ 容器停，helper 残余语义）**：源码 + 受控证据分清——client `connection.close()` → teardown `stdin.end()+child.kill()`（connection.js:252-255）→ daemon 按 stdin-EOF 协议杀全部进程组；实测：close 后 exec **0ms settle（ok:false）**、容器内 helper **46ms 消失**（`/proc` 轮询）。即本地 Docker 路径「deny 先行、helper 组清理随即完成」已证。残余边界如实：daemon 自身被硬杀（如 OOM/-9）时其组清理无保证，读-only helper 残余由容器/Pod 生命周期兜底（guard 已先 deny）；真实 K8s 集群 kill/close 仍 **unknown**。Pi 报告 §2.1「前端 deny 之前不存在该请求的活动 helper」仅指请求创建前语义，对 mid-flight lost 的表述应按本段补事实。

> 【协调者否决注记 2026-10-17】本行原先按「G3 closed」口径记录，**不采纳**：0ms settle 与 helper 46ms 后才消失这两个事实合起来恰恰证明**返回时点 helper 仍活动**——不能因消亡短暂或容器最终兜底就记为返回前已 clean 或门槛 closed。G3 更正为：Remote deny 返回 ≠ helper 死亡确认，死亡时点记 **pending/unknown**；「deny 前无活动 helper」仅 Local 成立（exec 等子进程真实退出后 settle，已证）。另 R4 证据只覆盖 connection.close 一条路径，不得推广为「所有正常 aborted 都缺死亡确认」——normal exec timeout/abort 的组杀由 daemon 发起、是否收割后回帧属协议未证（protocol.md §Cancellation 只写 kill+aborted，无 ack），统一归入 G3 **blocked**（最小需求：daemon 杀组后确认收割再回帧的 ack 扩展）。原始证据与本条原文保留不改。
- **G4（精确 owned 资源生命周期）**：本审探针按名字/ID 精确跟踪：自有容器过滤计数 0→1→0（`docker ps -a --filter name=<exact>`），本地 sentinel pid 存活→SIGKILL→exit 等待，全部 finally 关闭，终态过滤计数 0（日志 `/tmp/perimeter-r4/grok-gates.log`）。全局计数仅作旁证：本轮起点与终点 `docker ps -a` 均为 0——R3 时代「历史 3 容器」现不在本机（非本审所为，如实记录）；ppid=1 node 孤儿当前未观察到（历史「7 未确权孤儿」归属对账仍 open）；未动任何不明资源。

## 7. 其余 required 门槛核对（closed，证据见 §1/§2 与源码）

| 门槛 | 状态 | 证据 |
|---|---|---|
| 生产无 canonicalPath RPC + awaitWithContext 早返回 | closed | `grep canonicalPath\|awaitWithContext src/ scripts/ web/` 仅注释；guard 单点 `await opts.resolveGuardPath(...)`（extension.ts:54） |
| 固定 argv helper 同 env 一次 root+target | closed | `[node,"-e",静态码,"--",rawPath]`；SDK argv 直跑无 shell；容器 root=/workspace ≠ 宿主 |
| timeoutMs/abort 实杀 owned 组并 await | closed | SDK detached+`kill(-pid,SIGKILL)`+`waitForChildProcess`；§1 #2/#3/#5/#6 |
| 泄露面 | closed | canonical/root 仅入策略复判/包含判定/漂移比对；audit summary 仅 `action.path` 前 80 字符；`audit.entry` 仅元数据字段；helper stderr 只弃不读 |
| 注入面/env 最小化 | closed | argv 数组无 shell；NUL 前置拒；`inheritEnv:false`+仅 `{PATH,HOME}` |
| failclosed 矩阵 + 正控 | closed | 回溯/绝对/`..`/symlink/ELOOP/EACCES/`~`/file://、坏 JSON/缺字段/超量/非 0→deny；多级新建正控 |
| canonical 取严/原 args/四眼/漂移复检/白名单 | closed | rank 取严（extension.ts:92）；原 action+argsHash；`isContextReliable`；获批后新阶段复检；白名单未退化；e2e 17 项绿 |
| 机制口径 | closed | 每次 helper=既有 pi-env 连接上 daemon 内一次 spawn；本报告无时延量级断言；Pod 真实集群 unknown 保持 |
| 477 双跑新鲜 | closed（带 §3 flake 记录） | serial ✓；bounded ①1 fail（oracle flake）→② ✓ |

## 8. 台账

- `s2-path-guard`：**partial 维持**。机制面（真实取消/收尾、namespace、failclosed、泄露面、取严复判）按本审独立证据验收通过；required 三修见 §3/§4/§5；残余不变：bash（无 path 参数）/硬链接/敏感读（read 不扩守卫）/最终 check-use TOCTOU 窄窗。**不升 implemented，不因 477 概述批准**。
- 修复包最小复验口径：三修后跑 ①专项（runner header）+ ②本审三探针重放（kill-proof/reap-race/gates，均在 `/tmp/perimeter-r4/`，可独立复现）+ ③serial、bounded 各一次全绿；G1 修复需新增「info 段受 3s 预算」正测（mock never-respond 连接，预期 ≤3.5s deny=deadline）。
- S2 四眼有限批准维持不回退；DLP/repo-token/敏感路径 missing/partial；真实 CNI/客户模型 external_blocked；S3/S4 按依赖；企业生产不批准。
