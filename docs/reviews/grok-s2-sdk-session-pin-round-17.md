# grok-s2-sdk-session-pin-round-17.md — Pi R16 修复包（R-Q16-1..6 + join/整轮硬门）定向复审（task_4397636a4509 / ctx_ab87f83863bd）

- 日期：2026-10-18；审者：Grok（唯一 reviewer）。被审对象：Pi task_ac6dde798e3e / ctx_ac1f16f44c6d 修复包，root `/tmp/perimeter-r17-fix-BrHDIJ/`（0700/UID501/非 symlink 已独立复验；sdk5 r5 `8bc33ba815ddcff1…`、probe r5 `9faeda10865a2da1…`、preflight r5 `c440d49dff1006bd…`、plan r5 `29f2deec8c78136e…`、audit-notes `e99a96de00bc60fe…`、repro `47c6b1de…` 逐字节 cmp 相等零跑、abort-fixture 不变；manifest 12/12 逐行重算全符，仅行序差异）。spec 依据：Pi 原任务 + 协调者优先纠正 msg_1db150bc1c3f + R16 报告 + §18.3 + 协调者 R17 四跟进（msg_3f2eb7d4d14f / msg_ed7dbfd6b282 / msg_1a6dcaf57fdc / msg_4e765283bf6e）。
- 审性质：零真实资源。执行面=只读哈希/cmp、`node --check` 8 文件（sdk5/probe/preflight/Pi 四 oracle/purefake 全过）、自有 mkdtemp 0700 root `/tmp/grok-s2-r17-review-AzdWjrVh/` 内 vm purefake（全部经既有 bounded runner ≤10s，独立独占 PGID/argv/exit/计数在案）。coor 两反例 root（CRhK6F `4ae9f44d…`、join v5KTdX `f13489fd…`）与 r4/r14 全部旧 root 只读复验未触，**原件零执行**（先复制自有 root 再适配）。
- **verdict：request_changes——R-Q16-1/2/3/4/5/6 主体闭合且 Pi 自证链（红绿对照/挂起披露）如实；但协调者四跟进疑点经本审逐一静态证实，其中两项为生命周期/预算硬门未闭（R-Q17-1 join 无活 close fallback、R-Q17-2 整轮 88s 预算未计 straddle 可越 runner 90s + ps 未按报告所称受 case 截止限），一项为元数据不实与既定次序偏差（R-Q17-3）。修后同口径复核，通过才窄批准执行前准备；真实执行另派 Pi，本审零资源。**

## 0. 过程公平记录（先于结论；不回改旧报告/旧 raw）

1. **R16 时序**：本审 R16 曾先出 approve 草判，经协调者三反例+join 硬门两轮跟进后更正为 request_changes 交付——最终交付正确，时序如实在此补记；R16 报告文本不回改。
2. **R16 证据口径更正**：R16 root 内 `grok-oracle-rerun.log` 等同名 tee 文件在多轮红→绿迭代中被覆盖，**早期失败原始日志已不存在、仅会话 transcript 在案**；`run-record.txt` 记录的 PGID 81485 是审者 shell 的 PGID，**不是** bounded runner 独占组——R16 相应证据按 transcript/非独占口径引用，不冒充原始 log/独占 PGID。
3. **54m57s 挂起事件**（Pi root，详见其 HANG-DISCLOSURE.md）：作者曾无超时直跑 `node --test`（违反 bounded 纪律，过程偏差），挂起经协调者 ESC 中止；**该挂起 node 子进程终止状态=unknown**（工具 ESC≠子孙退出证明、无 pid 记录、scoped 发现需全局扫描——禁止），作者与协调者双方均不得冒充退出证明。协调者 msg_4e765283bf6e 自纠：其 ESC 属**先行干预、依据不足**（可见证据仅 Pending/token 冻结/live worker，无该 node 故障或退出的进程级证明），不能写成"已确证死亡后的合法重试"；作者在 unknown 未解情况下继续叠 fake 亦属过程局限。双方偏差均如实并列，不因自纠放松任何生命周期/预算源码门。
4. 隐私最终口径（msg_1db150bc1c3f 纠正，采纳）：用户既准 R11/R13 及 R15 已接受的私有 owned raw 证据例外**保留**；0700/归属、ledger 0600、固定 repo/ledger/reporter 投影、B3/B4 knownlost 仅内存布尔仍必守；**不新增 DLP、不把已准 private raw 判违规、R16 报告的过窄小节由本节补记不回改**；新脚本自愿选更简固定类别可保留（Pi 本轮即如此做）。preflight r5 仅收敛 child-raw 通道、其 unhandled raw stack 保留——属上述保留例外，交付报告已如实限定（"同名 child-raw 通道收敛"），**不判违规、不作 required**。

## 1. 交付与先验复验（实测）

| 项 | 实测 | 结论 |
|---|---|---|
| manifest 12/12 | 逐行重算全符（顺序差异仅 abort-fixture 行位） | ✓ |
| repro | `47c6b1de…` 与 r14-fix 冻结根 cmp 逐字节相等、零跑 | ✓ |
| root 卫生 | Pi root 与本审 root 均 0700/sundy/非 symlink（find 零 symlink） | ✓ |
| `node --check` | sdk5/probe/preflight + coor-r16-oracle/red + join-oracle/red + purefake-r16 = 8/8 过 | ✓ |
| 冻结纪律 | r4 sdk5/probe、coor CRhK6F、join v5KTdX SHA+mtime 复验未触；r14 root 未触；coor 原件零执行 | ✓ |
| repo 足迹 | §18.3 + implementation-progress.json（其余为既有未提交状态；git log 未动） | ✓ |
| 历史边界 | 原 SDK5 未跑/current5fail/544×2/旧红/历史容器与七 mockPod unknown 保留；artifact 8/8≠behavior 5/5；G1 全 3s/G3/S2 企业 partial 不升级 | ✓ |

## 2. R-Q16 逐项复审（主体闭合）

| 项 | 实证（文件:行） + 本审独立证据 | 结论 |
|---|---|---|
| R-Q16-1 绝对总预算 | t0=performance.now()（probe:97）；BODY/STOP 绝对截止；delay=max(1, 18s−elapsed)（:146-155）；ensureOpen 看绝对截止（:371）；过截止创建连接亦拒（openOwnedConnection :195-203）。本审 oracle 反例① @r5 绿（12000+delay=18000<29000；t0 预挂 delay=18000） | **闭合**（注释不实见 R-Q17-3） |
| R-Q16-2 B5 正证紧致+单调窗 | sleep 前移（sdk5:524 `await sleep(120)` 在正证循环 :525-531 之前）；正证后零 await 立即 abort（:533-534）；exec 启动前单调锚 `longExecStartedAt`（:517）；窗核验 performance.now 距锚 <30000（:556-561）；TTL 30000/5000 不变；timeout/补杀/自然结束不充 abort（:540-541/:564-569）。本审 purefake P4：abortAt===lastAliveCheckAt（零 await 实证）+正向仍绿；oracle 反例③ @r5 绿（sentinel 早死→b5_sentinel_not_alive_at_abort、completed=false） | **闭合** |
| join 硬门（部分） | runCase 重构：try/catch 只记 outcome→**先 close 全部 owned connections→abort→真 join allSettled**（sdk5:327-329）→join 后统一单调超预算判定（:331-332）→wall 含 join（:333）。本审 J1（慢 join→wall≥25ms 且 case_deadline）、J2（正控不误拦）、J3（close 抛错→case_close_failed 且 pending 真 joined）；join oracle @r5 1/1 绿 | **主体闭合**（close 抛错后的活 fallback 缺口见 R-Q17-1） |
| R-Q16-3 记录器注入 | openOwnedConnection 第 4 参 onCleanupFailure；close 失败→记录+**重抛原错**（probe:199-203）；无 main 局部 failures 引用。oracle 反例② @r5 绿（reason=FakeCloseFailure≠ReferenceError） | **闭合** |
| R-Q16-4 close 先于 rm | cleanups.unshift（probe:198）使 conn close 在 runAllCleanups 中先于 closeOnce；body finally 首步显式 close（:410）再 await closeOnce（:411）；vendor #teardown 真实语义静审在案（close=kill/reject pending，不等 child exit；await snapshot 结束≠driver 亡，driver 死亡仍由 scoped waitOwnerGone 正证，unknown 不当 gone）。本审 purefake P5（次序 conn-close→ws-rm→closeOnce；原错重抛不跳过其余） | **闭合**（driver-wait 后置偏差见 R-Q17-3） |
| R-Q16-5 ps 预算化 | budgetedPsRunner=min(3s, 剩余)（probe:172-177 / sdk5:150-155）；realPsRunner 导入移除、helpers 零改；等待 deadlineMs 走 subBudget=min(5s,case 剩余,整轮剩余)（sdk5:151-157）。本审 P2/P3 三态实证 | **主体闭合**（两处残余见 R-Q17-2） |
| R-Q16-6 隐私收敛（纠正后口径） | sdk5/probe/preflight 的 child-N-out/err、raw-context/body-raw 全部移除/改固定类别+errorKind（本审 P6 源文本+运行时双证）；children 台账=命令类别+受控字段（无 argv）；accepted repro 窄例外原样；ledger 0600/B3B4 布尔不变；不判旧 raw 违规、无新增禁令 | **闭合**（按 §0-4 口径） |

Pi 自证红绿对照独立复核：coor 三反例适配版 @r5 3/3（PGID 35640）/对冻结 r4 0/3（PGID 35719）；join 1/1（PGID 35828）/0/1（PGID 35907）；purefake 19/19（PGID 35255）；run-01 10s 超时日志如实保留（挂起根因+forceSettle 修复披露）。全部为真 bounded-runner 产出（独占 PGID/argv/exit/计数在案）。作者自证不替代独审——以下为本审独立证据。

## 3. 本审独立运行（自有 root；全部 bounded ≤10s、独占 PGID）

| 运行 | 结果 |
|---|---|
| 协调者两反例复制适配版 `grok-r17-coor-oracles.test.mjs` @r5 | **4/4 pass exit 0**（PGID 63308 首跑 / 64487 复跑，87ms）——三反例断言公式原样（`preflight+delay<29000`、`reason≠ReferenceError`、`completed===false`+`b5_sentinel_not_alive_at_abort`），join 断言原样（ok:false/closeCount>0/naturalDone===false）；适配仅 sourcePath+签名注入（elapsedMs/onCleanupFailure/budgetedPsRunner/subBudget），逐条披露于文件头注与 provenance |
| 同文件 @r4 冻结 root 红对照 | **0/4 fail exit 1**（PGID 64421，红绿对照成立）。首跑曾悬挂（我的 FakeController.abort 未结算 longP——与作者挂起同类），bounded runner 10s 兜底 SIGTERM（PGID 63376，exit 124，`oracle-r4-red.log` 原样保留未覆盖）；修复假件后以新日志重跑 |
| 本审 purefake `grok-r17-purefake.test.mjs` | **9/9 pass exit 0**（PGID 70670；前两跑 4/9、6/9 因我方假件/断言笔误失败，日志 run/run-02 均保留未覆盖）：慢 join wall/判定、正控、close_failed、armBodyDeadline 触发+绝对 delay、probe ps 三态、sdk5 bounded 三态+raw 零持久+无 argv、B5 零 await+正向绿、unshift 次序+重抛、R-Q16-6 源文本 |
| join-fallback 反例 `grok-r17-joinfb.test.mjs` | **1/1 pass exit 0**（PGID 77322）：close 抛错后 closedAttempts===1（无二次 close）、naturalDone===true（实际终止=producer 自然结束）、wall≈60ms>15ms、category=case_deadline（类别如实但终止非主动 close）——R-Q17-1 实证 |

## 4. 新 required（R-Q17-1..3；全部 owned 副本内最小修改，不造 supervisor 框架）

- **R-Q17-1（join 活 close fallback；生命周期门）**：`withDeadline` 在 case promise 拒绝时立即 clearTimeout（sdk5:287-292），runCase 的 close+join 在 timer 之外且 **close 仅单次尝试**（:327 抛错仅记 closeFailed）——close 抛错+producer 永不结算 ⇒ runCase 永久悬挂至外层 runner kill（kill 不是终止证明）；close 抛错+producer 自然结算 ⇒ 实际终止是自然结束（本审 joinfb 实证 60ms/15ms）。修法（最小）：case deadline timer 覆盖至 join 完成为止（withDeadline 包裹 close+join 段或 runCase 持活 timer），onDeadline 重试 close 全部连接；结果判定保持 join 后统一、精确 case_deadline，不放宽。
- **R-Q17-2（整轮预算收敛；预算门）**：①SDK 无整轮主动截止——WHOLE_STOP 88s 仅用于预算计算，而最坏轨迹=前置 ≤5s+5×15s=80s 后，cleanup 段单次 wait ≤5s+内部 ps ≤3s 的 **straddle 可越 88s 达 ~96s > runner 90s**，与"自然结算 ≤90"矛盾；trackDaemon 内部 waitOwnerGone deadlineMs 固定 5s（sdk5:231，helpers 不改不可动态）。修法（最小，二选一）：WHOLE_STOP 下调至 ≤82s（80 最坏 + straddle ≤8s=90）并把 straddle 界如实写入 plan/summary；或加整轮主动截止（到点 abort 当前 ctl+close 全连接→红，最小实现）。②交付报告/§18.3 称 sdk5 budgetedPsRunner "case 内再受 caseStopAt 限"——**代码无此限**（sdk5:153 仅 min(3000, wholeRemaining)）：修代码（case 内再 min caseStopAt）或更正报告与台账。③Docker shortBudget/subBudget 的 `Math.max(1,…)`：耗尽后仍 spawn 1ms——清理类命令可保留（快速失败=如实红），但**新建资源路径**已被 ensureOpen 绝对守卫覆盖，须在 plan/summary 明示"1ms spawn 仅限 cleanup 段"。
- **R-Q17-3（元数据如实+次序偏差记录）**：①probe:208 注释"早于 OWN_PGID_PROBE 与一切 preflight"**不实**——arm 在 :210，OWN_PGID_PROBE IIFE 在 :187 先执行（实质无影响：绝对截止触发时刻恒 t0+18s）→修注释。②probe finally 次序=close→**rm（closeOnce）**→inspect-gone→driver waitOwnerGone（:409-428），与协调者既定 close→正向 scoped driver join→rm 有偏差。安全分析：rm 正向归属已验容器、driver 死亡仍正向证明（unknown 不当 gone）、refusal 路径 waitOwnerGone 为真证、无假绿/无无归属杀——**不构成安全缺口**，如实记偏差；由 Pi 最小调整（driver wait 提到 rm 前）或如实标注，本审不强行设禁。
- 过程披露项（§0）非代码 required，随本报告入档。

## 5. 边界声明

原 SDK 5 未跑/未导入；current5fail、544×2、全部旧红、历史容器与七 mockPod unknown 保留；artifact 8/8 ≠ behavior 5/5；G1 全 3 秒/G3/S2 企业 partial 不升级；R11/R13 审定与私有 raw 例外不重开不缩窄；不读 history/ENV secrets/未知 stash；产品/SDK/vendor/helpers/tests/node_modules/依赖锁/全部旧 root 只读；dirty/staged 保留，无 reset/stash/clean/commit/push。本审绿（R-Q16 闭合面）与红（R-Q17 缺陷面）并列；静态/purefake 绿不预支真实行为绿。修后由本审对受影响代码同口径定向复核，通过才窄批准执行前准备（真实执行另派 Pi：repro 45s → sdk5 90s → docker 30s，各自独立红），本审零资源。

## 6. 证据保留

审者 root（0700，不删）：`/tmp/grok-s2-r17-review-AzdWjrVh/{grok-r17-coor-oracles.test.mjs, grok-r17-purefake.test.mjs, grok-r17-joinfb.test.mjs, oracle-r5.log, oracle-r5-02.log, oracle-r4-red.log(悬挂原始), oracle-r4-red-02.log, grok-purefake-run.log, grok-purefake-run-02.log, grok-purefake-run-03.log, grok-joinfb-run.log, grok-r17-oracle-provenance-r5.json, grok-r17-oracle-provenance-r4-red.json, grok-r17-purefake-provenance.json, grok-r17-joinfb-provenance.json, manifest-check.txt, sdk5-r5.diff, probe-r5.diff, preflight-r5.diff}`。Pi r5 root 自 worker_done 起冻结；全部旧 root/coor 原件只读零执行。
