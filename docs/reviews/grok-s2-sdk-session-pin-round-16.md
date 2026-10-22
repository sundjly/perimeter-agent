# grok-s2-sdk-session-pin-round-16.md — R15 修复包（R-Q15-1..4）定向复审 + R15 硬门复核（task_74f2bc3b749f / ctx_1eb18711eeb2）

- 日期：2026-10-18；审者：Grok（唯一 reviewer）。被审对象：Pi task_99c867508c03 / ctx_bf9145401f9b 修复包，fresh root `/tmp/perimeter-r16-fix-puuMp8/`（sdk5 r4 `8349cde456002933…`、docker probe r4 `fb9dce0e47e71833…`、plan r4 `4e12a954673e25ca…`、audit-notes `cb35ba570fbb387e…`、repro 不变 `47c6b1de…`、abort-fixture/preflight 不变 `009148ab…`/`369f44d1…`，与 §18.2 及 sha256-deliverables.txt 一致）。
- 审性质：R15 四项 required（R-Q15-1..4）+ 协调者 R15 两反例修后重跑 + R15 硬门（SDK 90s/case 15s；Docker 真总 30s/CLI 5s；runCase 预挂顺序；snapshot 60s 内部收敛）定向复审；审中另核协调者 R16 三项新反例与隐私口径纠正。**零真实资源执行**：未运行 repro/SDK 五行为/真 daemon/容器/原 test/全量；执行面仅 `node --check`×3、只读哈希、本审自有 0700 root 内 purefake/oracle 接缝（R15/R16 协调者 oracle 均**先复制到自有 root 运行，coor 原件零执行**）。
- **verdict：request_changes——R-Q15-1/2/3/4 四项闭合（§2）且 R15 硬门大部分成立（§3）；但协调者 R16 三反例在本审自有 root 独立复跑 0/3 全红（§4），对应交付码 5 处结构性缺陷（R-Q16-1..5）+ 隐私口径纠正后 1 项 raw 通道未收敛（R-Q16-6，§6）。全部为 owned 副本内最小修改；修后同口径复核，通过才可窄批准执行前准备，真实执行（repro 45s → sdk5 90s → docker 30s，各自独立红）另派，审者不运行。**

## 0. 隐私口径纠正（先行披露；R15 §3.6 援引过宽，在此更正）

协调者 msg_eafaa849ef03 更正其此前"raw 沿用既批口径"的过宽措辞，本审逐段复核 R11/R13/R15 原文后**采纳**：R11 只批准 throw/failures/聚合的固定类别与 ledger 投影；R13 的私有 raw 例外**仅限 accepted v2.1 repro 的 Git/TSC/manifest guard 证据**。R15 §3.6 以此援引 sdk5/probe 的 raw Error.stack 与子进程 raw 输出为"合规"系**援引过宽**，在此更正（R15 报告原文不覆盖，本节在案）。据此本审对 r4 交付码 raw 通道全量审计见 §6：`child-N-out/err.log`、`-raw-context.log`、`body-raw-context.log`、unhandled raw stack 均为**未被 R11/R13 覆盖的 raw 通道**，真实执行前必须收敛（R-Q16-6）；children EVENTS ledger（argv/pid/status 固定字段投影）沿用 R11 已批投影口径，不认定为新增 raw；0700 目录本身不构成许可。

## 1. 交付物与先验复验（实测）

| 项 | 实测 | 结论 |
|---|---|---|
| sha256-deliverables.txt 11 行 | 逐行重算全符（含 audit-notes 现值 `cb35ba57…`；R15 指认的 `fa95d8bb…` 旧错误行版本序在 audit-notes 保留） | ✓ R-Q15-4 |
| repro.mjs | `47c6b1de…` 与 R13 冻结根/r14-fix root 逐字节相同（cmp 相等）、未运行 | ✓ |
| 变更面 | sdk5/probe/plan/audit-notes 四件因修复而变，头注 r4 修订链各自标注旧版 SHA 被取代关系；abort-fixture（TTL 经 argv）不需改 | ✓ |
| `node --check` | sdk5-behaviors.mjs / docker-owned-probe.mjs / purefake-r15.test.mjs 3/3 过 | ✓ |
| 冻结纪律 | r14-fix root 四交付件仍 `626351fc…/50b97328…/f0af593b…/8a3b94c2…`（mtime 02:0x 未触）；R15 coor 反例 root `oracles.test.mjs d8a7d036…`/runner.log/provenance.json 未触（mtime 08:14 早于全部 r4 文件）；R16 coor 反例 root `/tmp/perimeter-r16-coordinator-CRhK6F/` 未触（仅复制）；coor 原件零执行 | ✓ |
| Pi 自证日志口径 | coor-oracle/purefake-own/purefake-deadline 三日志为 **r14 时代逐字节副本**（内嵌命令路径即 r14 root，PGID 52102/52185/51822 与 R15 §4 一致），交付报告明示「本 root 未运行」——如实披露；作者 purefake-r15 17/17（PGID 42214）为本 root 实测，但**作者自证不替代独审**（协调者 msg_26fcbcacf7a4 正确指出，且 17/17 未覆盖 §4 三反例） | ✓（口径） |
| repo 足迹 | 仅 s2-sdk-session-pin.md（§18.2）+implementation-progress.json 与 coverage（历审），其余为既有未提交状态 | ✓ |

## 2. R-Q15 逐项复审（全项闭合）

| 项 | 实证（文件:行 / 本审 oracle·purefake） | 结论 |
|---|---|---|
| R-Q15-1（B5 自然到期混淆窗） | `LONG_TTL_MS=30_000 > CASE_DEADLINE_MS=15_000`（sdk5:457/:88）；sentinel `5_000`（:458）；abort 前 `psIdentity`+`matchesGeneration`（真实 helper）同代 alive 正证（:492-497）；exec 结算必须 `classifyExecError==="aborted"`（:507-508）；正向 gone 后单调窗核验 `Date.now()-longReadyAt >= LONG_TTL_MS → unproven 红`（:513-520）；补杀只在 `fixtureFinalize`（:233-246）不置 abortKillProven。本审 oracle 反例2 红/绿双向成立 | **闭合**（新缺陷见 R-Q16-2） |
| R-Q15-2（closeOnce 正向归属前置+可重试） | 无登记 CID 只按名只读恢复（4 字段全过才杀；gone→no-op 置闩；mismatch/unknown→不 rm+failure+闩不置位）（probe:157-180）；重验同代不符不 rm（:181-194）；显式 `docker rm -f <full64CID>` 恒非名字（:196-197）；rm 后消失精确分类（:199-203）；`backend.cleanup` 按名路径全移除。本审 oracle 反例1/1b + purefake P4-P7 全过 | **闭合** |
| R-Q15-3（driver 时序+owned Connection 生命周期） | driver 发现移到 `snapshot()` 成功后（probe:352-354）；`pgrep -P`+`ps -p` 直接子范围（零全局 `ps -eo`）；pid/ppid/pgid(OWN_PGID)/birth/marker 正向、不唯一→unknown 不当 gone；owned Connection 创建即同步登记 close（openOwnedConnection :172-186）、fired→创建即 close 拒发请求。本审 purefake P8/P9/P14 全过 | **闭合**（新缺陷见 R-Q16-3/4） |
| R-Q15-4（manifest/文本同步） | manifest 11 行全量重算；plan §2 补「（如有）」；audit-notes 版本序保留 | **闭合** |

## 3. R15 硬门复核

| 硬门 | 实测 | 结论 |
|---|---|---|
| SDK 整轮 90s / 单 case 15s / 子命令 5s | plan:21 `--timeout 90s`；sdk5:614 `wholeRunnerMs: 90_000`；:88 `CASE_DEADLINE_MS=15_000`；`SUBCOMMAND_TIMEOUT_MS=5_000` | ✓（waitOwnerGone 内部 ps 预算缺陷见 R-Q16-5） |
| runCase caseFn 参数先执行不能称先挂 deadline | `withDeadline(Promise.resolve().then(() => caseFn(api)),…)`（sdk5:283-285）timer 同步先挂；单调计时+结算后单调复核（:289-290）；子 CLI 预算=min(5s, 距 case 截止剩余)（:130-133）。purefake P11/P12/P13 全过 | ✓ |
| Docker 真总 30s / CLI 5s | plan:22 `--timeout 30s`；probe:408 `wholeRunnerMs: 30_000`；`shortBudget()=min(5_000, 距 t0 29s 停止窗剩余)` 基于**绝对 t0**（:86-88）——此半边成立 | **部分成立**：预挂 deadline 为局部相对 18s 且晚于 preflight（R-Q16-1）；waitOwnerGone 内部 ps 固定 3s 不受剩余预算限（R-Q16-5） |
| snapshot 默认 60s 内部收敛、外 runner kill 不算终止 | vendor `connection.js:15 START_TIMEOUT_MS=60_000` 属实；close 有真实 teardown（:134-138）。**但** armBodyDeadline 在 main 内 version/image inspect 之后才挂（probe:245-251 早于 :325）——preflight 最坏 15s（模块 ps+version+image 各 ≤5s）+18s=33s>29s 停止窗>30s runner，close 无法在窗内触发；ensureOpen 仅看 fired 标志，shortBudget 过截止仍 `Math.max(1,…)` 可继续新建 spawn | **未闭合 → R-Q16-1** |
| 失败路径/finalizer 异常覆盖 | Pi purefake-r15 17/17 + 本审 purefake 15/15（P1-P14+P4b）——但三反例路径（§4）未被任何一方覆盖 | **部分成立 → R-Q16-2/3/4** |

## 4. 协调者 R16 三反例独立复核（自有 root 0/3 全红，复制件零执行原件）

协调者证据 root `/tmp/perimeter-r16-coordinator-CRhK6F/`（oracles.test.mjs/provenance.json/runner.log/exit-code.txt，10s bounded PGID 53408 exit 1）。本审复制为 `grok-coor-r16-red.test.mjs` 于自有 root 复跑：**0/3 pass / 3 fail，exit 1**（vm 抽取交付 armBodyDeadline/openOwnedConnection/caseB5，零资源）。逐项独立证实（文件:行 为交付码实测）：

1. **① 全局停止窗被推穿（R-Q16-1）**：`armBodyDeadline(deadlineBox)` 挂于 main 内 docker `version`（:245）与 `image inspect`（:247）**之后**（:325）——BODY 18s 为局部相对时长；模块级 `OWN_PGID_PROBE` ps + version + image 各 ≤5s（shortBudget 初始=5s），最坏 preflight 15s 后 timer 才起算 → 最早 close=15+18=33s>29s 停止窗>30s runner 兜底；`ensureOpen` 仅看 `deadlineBox.fired`（:326），fired 前可继续新建 spawn（container start/inspect/connection），shortBudget 过截止仍 `Math.max(1,…)` 快速失败但已 spawn。反例1 以 12s preflight+18s=30s≥29s 数学断言红。修法：**自 t0 绝对单调起算总预算预挂**（如 `setTimeout(…, WHOLE_STOP_MS − 清理预留)` 在 main 入口/t0 后立即挂），ensureOpen 与新建资源守卫改看绝对截止。
2. **② owned close 异常被 `failures is not defined` 掩盖（R-Q16-3）**：`openOwnedConnection` 为模块级（:172-186），其 close cleanup catch 引用 `failures`——`failures` 是 **main 函数局部 `const`**（:260），模块级不可见；生产中 close() 抛错时 catch 内 `failures.push` 必 ReferenceError（反例2 实证 `result[0].reason.name==='ReferenceError'`），原错被掩盖、语义虚化。作者 purefake 注入全局 failures 属虚构生产依赖（协调者判断正确）。修法：记录器作参数注入，或该 cleanup 改固定类别返回值由 main 聚合。
3. **③ alive 正证与 abort 间 await 间隙 → sentinel 早死假绿（R-Q16-2）**：caseB5 顺序为 alive 正证（:492-497）→ `await sleep(120)`（:498）→ `controller.abort()`（:500）。sleep 回调合法延迟至 6s（<case 15s）时 sentinel（TTL 5s）已自然完成：正证时刻的 alive 在 abort 时刻已失效，"不伤 sentinel"验证被架空，caseB5 仍成功返回（反例3 实证 completed=true 假绿）。且单调窗用 wall `Date.now`（:511/:518）非单调、锚点 `longReadyAt` 在 ready 后（:484）非 exec/birth 起点。修法：sleep 移至正证前；正证（同步 psIdentity）后**零 await 立即 abort**；单调窗改 `performance.now` 且以 fixture exec 启动点为锚（exec 早于出生，窗口更严，方向安全）。
4. **④ 清理次序违反既定意图（R-Q16-4）**：cleanups 登记序=ws rm→closeOnce（容器 rm）→owned Connection close（body 内创建时）；runAllCleanups 按序执行 → **容器 rm 先于 transport close**；snapshot 失败（driver 未知）路径同序。plan §4 意图「先 close transport 再容器 rm」。vendor close() 有真实 teardown（:134-138）可结算在途——修法：调整 cleanup 顺序（connection close 先于 closeOnce）或 body finally 显式先 `connection.close()` 并 join 后再进清理。
5. **⑤ waitOwnerGone/realPsRunner 每 ps 固定 3s 不受剩余预算限（R-Q16-5）**：`realPsRunner` 硬编码 `timeout: 3000`（ps-observer.ts:23-27）；waitOwnerGone 传入 `deadlineMs=shortBudget()` 只约束整体等待，单次 ps 可在截止后仍运行 ≤3s；probe finally 的 driver waitOwnerGone 最坏把结算推过 29s 停止窗（SDK 侧同构）。修法：observer 注入剩余预算或每次 ps 按 remaining 限时；或 plan/summary 如实把 3s 溢出计入停止窗推导并预留。

## 5. 本审独立 oracle/purefake 实测（自有 0700 root `/tmp/grok-s2-r16-review-zr/`）

| 运行 | 结果 |
|---|---|
| R15 coor 反例 oracle 副本（适配 r4：sourcePath→r16 root+manifest SHA 锚定；反例1 沙箱注真实 isFullCid/classifyInspectGone+argv 记录 bounded，`removes===0` 原断言原样+零 rm/闩可重试/rm=full64CID 新断言；反例2 TTL 前提 8000→30000、8s 构造前提随失效移除、fail 红升格断言+正向对照防过拦；matchesGeneration 真实 helper 不假造） | **4/4 pass exit 0** |
| 本审 purefake（vm 抽取 closeOnce/caseB5/withDeadline+runCase/bounded/openOwnedConnection/armBodyDeadline/isFullCid/discoverDriver + 真实纯 helper；P1-P14+P4b） | **15/15 pass exit 0** |
| 协调者 R16 三反例副本 `grok-coor-r16-red.test.mjs` | **0/3 pass / 3 fail exit 1**（§4 红绿对照成立） |
| `node --check` | 3/3 过 |

适配逐条披露于审者 root 内脚本头注；本审绿不推翻 §4 红——两者证不同路径（R-Q15 闭合面 vs R-Q16 缺陷面）。

## 6. 新 required（R-Q16-1..6；全部 owned 副本内最小修改）

- **R-Q16-1**：deadline 自 t0 绝对单调起算总预算预挂（覆盖全部 preflight），ensureOpen 与新建资源守卫看绝对截止；过截止后不再 spawn 新资源。
- **R-Q16-2**：alive 正证与 abort 间零 await（sleep 前移）；单调窗改 `performance.now`+exec 启动锚。
- **R-Q16-3**：owned close 失败路径不得引用 main 局部 `failures`（记录器注入或固定类别返回），原错不掩盖。
- **R-Q16-4**：所有路径（含 snapshot 失败/driver 未知）先 close transport 并 join 后再容器 rm。
- **R-Q16-5**：waitOwnerGone/realPsRunner 每次 ps 受剩余预算限时，或如实计入停止窗推导并预留（SDK 侧同理）；plan/summary 同步。
- **R-Q16-6**：按 §0 纠正后口径，真实执行前把 `child-N-out/err.log`、`-raw-context.log`、`body-raw-context.log`、unhandled raw stack 收敛为固定类别+安全投影持久化（accepted repro v2.1 窄 raw 例外不变；children EVENTS argv 投影 ledger 沿用 R11 口径不变）。

## 7. 边界声明

R11/R13 审定范围按 §0 纠正后口径执行，不重开两审本身、不改不撤任何旧报告/旧 root；既有已写 raw 保留历史，本轮未运行资源、无新泄漏宣称。原 SDK 5 未跑/未导入，current5fail、544×2、全部历史红保留；artifact 8/8 ≠ behavior 5/5；G1 全部 3 秒/G3/S2 企业 partial 不升级；R15 §0 更正维持。本审绿（R-Q15 闭合面）与红（R-Q16 缺陷面）并列在案；产品/SDK/vendor/tests helpers/依赖锁/node_modules/旧证据全只读；未 commit/push。修后由本审对六处受影响代码同口径定向复核，通过才窄批准执行前准备，真实执行另派 Pi。

## 8. 证据保留

审者 root（0700，不删）：`/tmp/grok-s2-r16-review-zr/{grok-coor-oracle-r16.test.mjs, grok-purefake-r16.test.mjs, grok-coor-r16-red.test.mjs, grok-oracle-rerun.log, grok-purefake-run.log, grok-coor-red-rerun.log, grok-source-provenance.json, grok-purefake-r16-provenance.json, check.log, run-record.txt, sdk5.diff, probe.diff, grok-s2-r16-audit-root.txt*}`。Pi r4 root、r14-fix root、R15/R16 coor 反例 root、全部历史 root 只读未触；coor 原件零执行。
