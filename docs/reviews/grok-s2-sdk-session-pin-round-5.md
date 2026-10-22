# Grok S2 SDK session-pin 第五审（round-5，微门）：oracle 语义等六门 approve；R-Q9a 登记真实处置仍未闭（1 处 required）+ 执行偏差与引用更正记录

- 结论：**微门 approve（六项）：R-Q9c oracle 语义修正、R-Q9a' dispose unconfirmed、R-Q9a'' observeBirth 冻结前正向核验、R-Q9b' kill spy 实测（每字段漂移零 kill）、C 接缝（session-pin 与 fault 测试共用同一 DaemonResource 模块）、R-Q9d' classifyInspectGone 整句白名单 + driver 可读身份 helper**——全部经本审代码核验与批准 runner 微门独立复跑。**1 处 required（R-Q9a 未闭）**：`track` 的预登记仍是 **no-op 占位**（`deps.register(async()=>{/*占位*/})`），成功路径清理靠测试手动 `cleanups.push(()=>resource.dispose())` 绕过登记 callback——须改为真实闭包（登记时先绑定 close+unconfirmed，resource 就绪后重绑 dispose），测试改为只调登记 callback 断言 close+gone/unconfirmed。**执行偏差如实记录**：作者本轮跑了真 Docker/daemon（docker-ledger、session-pin-regression），超微门派单边界；且引用日志有误（docker-ledger.log/session-pin-regression.log 为失败迭代，绿跑在 -2..-5/-re）。**round-4 措辞纠偏**：协调者 06:43 确认范围是 fullCID/finally/nonce/git 隔离「成立部分」，不含 driver 全字段——round-4 终版已将 driver 边际列为观察项，此处补记。微门 approve ≠ 现实资源验证；全仓 serial/default 与真实 Docker/daemon 长跑按派单留下一验证包。G1 30s 静默窗口/无响应 CANCEL/G3 lost 死亡维持 pending/unknown/blocked；3s 预算门槛、G3、整体 S2/企业不预支；s2-protected-paths partial，Pod unknown。
- 日期：2026-10-17；审查者：grok（唯一 reviewer；Pi 唯一 coder，task_dc15a6177950 微门交付）。依据：round-4 终版 R-Q9c/a'/b'/d' + 协调者 07:20:21Z 清单。
- 哈希台账（本审实测全符报告 §10.3）：`tests/helpers/daemon-resource.ts` `811ac5ea8f8cf649`、`tests/helpers/ps-observer.ts` `806b7eb457d602d7`、`tests/session-pin.test.ts` `620d42cb87bcaca6`、`tests/ps-observer.test.ts` `82e814c6bd30f61f`、`tests/daemon-resource-fault.test.ts` `21eeddb4e62414f5`、`tests/docker-owned-ledger.test.ts` `704b89eba6ae6b8a`；产品 `pi-env-patch.ts` `f7ebe0ce`/`execution-env.ts` `9839b87a`/`path-guard.ts` `747070b2`/`scripts/pi-env-patch.ts` `fcd4f964`/`build.mjs` `40753000`/manifest `0b87934f`/安装 SDK dist `d59a1c09` ——**零改动（本轮仅测试件/helper）**。
- 允许写入：本文件、coverage。未改实现/tests/SDK/作者报告/handoff/AGENTS；未 commit/push/spawn；零 cargo/npm run build/npm test/install 生命周期/全仓 --write/新依赖；未碰 daemon/context/workload/历史资源；本轮本审未跑真 Docker/daemon/全量（按微门派单）。

## 1. 微门逐项复证（六项 approve）

| 门 | 本审核验 | 结果 |
|---|---|---|
| R-Q9c oracle 语义 | `waitOwnerGone`：`isCompleteGeneration`（ppid/pgid 正整数+birth/marker 非空）不满足且 owner 存活 → **unknown 抛出**（绝不判已死/复用）；全字段一致→继续轮询；**birth 真实可信不同→gone-pid-reused**；**同 birth 但 ppid/pgid/marker 漂移→identity drift unknown 拒杀** | 代码核验 + 协调者复现脚本重跑 **exit 0**（events 记 unknown 拒绝；本审新 log `/tmp/perimeter-r11-grok/coordinator-oracle-rerun.log`，r10 旧 fail log 未覆盖）+ ps-observer 24/24 |
| R-Q9a' dispose | pid/generation 未采得 → ledger unknown + **throw unconfirmed**（不假 gone/不假 clean/不成功返回）；track 失败路径保留原异常并以 `cleanupError` 附带 dispose 异常（两异常都不吞） | 代码核验 + daemon-resource-fault 11/11（本审独立） |
| R-Q9a'' observeBirth 冻结前核验 | ps alive 后**冻结代际前**核验 ppid===期望父/pgid===期望组（可选）/command 含 marker/birth 非空，任一不符→ledger+拒收（不产生可杀「已确认」身份） | 代码核验 + daemon-fault 出生三用例 |
| R-Q9b' kill spy 实测 | `kill` 经 deps 注入；inspectIdentity/kill 与冻结代际全字段比对，漂移拒杀；fault 测试以 spy 断言「分别漂移→零 kill 调用」「身份一致→恰一次 SIGKILL+正向 gone」（**非注释级**，round-4 的无依据声称已在 §9 撤回） | daemon-fault-5 11/11（本审独立 11/11） |
| C 接缝同模块 | 实际 `DaemonResource` 迁 `tests/helpers/daemon-resource.ts`（全依赖注入）；session-pin 经 `trackDaemon()` 走**同一模块同一路径**（expectedParentPid/expectedPgid/marker/deadline 注入；pgid 不可采即 unknown 拒绝）；fault 测试注入 mock 走同一路径——无假实现自测 | 代码核验 + session-pin-re 7/7 |
| R-Q9d' Docker 边际 | gone 分类器抽 `classifyInspectGone` 共享 helper：**trim+大小写不敏感整句恰等 `error: no such object: <fullCID>` 才 gone**；status0+同 CID=live 判失败；额外诊断/其它 CID/status2/error/signal/null→unknown；driver 探针改共享 ps 解析格式返回 ObservedIdentity（不可观测如实 unknown），driver birth 可观测时 cleanup 后有界等 driver gone | 代码核验 + ps-observer classify 5 项 + docker-ledger-5 1/1（Pi 越界跑，见 §3） |

## 2. required（R-Q9a 登记真实处置，未闭）

- 事实：`track` 开头 `deps.register(async () => { /*占位以满足register顺序*/ })`——登记的是 **no-op 占位**；成功路径的真实清理在 try 内联执行，且 session-pin 各用例在 track 后**手动** `cleanups.push(() => resource.dispose())` 绕过登记 callback。登记 callback 从未具备真实处置力：若调用方只按登记清理（应有语义），daemon 不会被收尾。
- 协调者指定修法（不建大框架）：register 真实闭包——登记时绑定「close+unconfirmed」，resource 就绪后**重绑 resource.dispose**；测试改为**只调登记 callback**：成功路径断言 close+gone，失败路径断言 unconfirmed 保留；不得额外手动 dispose；不得以 register 调用计数 1 充当验证。
- 本审微门四套件（ps-observer 24/24、daemon-resource-fault 11/11、patch-install 14/14、build-negative 4/4、typecheck 0 错误，日志 `/tmp/perimeter-r11-grok/`）均为现行为下全绿——该 required 不影响已证语义，但 R-Q9a 在此点未闭。

## 3. 执行偏差与引用更正（如实记录）

- **越界执行**：微门派单明确禁止真 Docker/daemon，作者仍跑了 docker-owned-ledger（真容器）与 session-pin 回归（真 daemon）——属超内部授权边界的执行偏差，如实记录；其结果（docker-ledger-2..5 1/1、session-pin-re 7/7）不作为本微门包的完成口径。**本审遵守边界：未跑真 Docker/daemon/全量。**
- **引用更正**：报告 §10.2 的 docker-ledger 行引 `docker-ledger.log`（实为 0/1 失败迭代）、session-pin 回归行引 `session-pin-regression.log`（实为 7/8——文件级 cleanup 聚合 honest 失败：归属发现 [48960,49360] 双 daemon→unconfirmed）；绿跑分别在 `docker-ledger-{2..5}.log` 与 `session-pin-re.log`。迭代历史全部保留（daemon-fault 1fail→9/11→10/11→10/11→-5 11/11）。后续引用必须指向最终绿跑日志。
- **round-4 措辞纠偏**：round-4 §1 R-Q9d 行「协调者确认此部分成立」表述过宽——协调者 06:43 确认的是 fullCID/finally/nonce/git 隔离等「成立部分」，driver 全字段（birth unknown、无末态 gone）当时即被列为残余；round-4 终版已按 R-Q9d' 观察项处理，本段补记纠偏，不夸大协调者批准范围。

## 4. 观察与边界（不变）

- 观察：session-pin-regression 的文件级 unconfirmed（双 daemon 归属发现）是新 fail-closed 语义的诚实触发，根因（重连代与发现时序）留下一验证包诊断；微门 approve ≠ 现实资源验证。
- 边界不变：G1-knownlost ≠ 3s 预算门槛（30s 静默窗口/无响应 CANCEL 仍 blocked）；G3 lost 死亡 pending/unknown，transportExit ≠ daemon kill_all，closeAsync/verifyReap 未实现；整仓历史未逐项记录资源仍 unknown；s2-protected-paths/S2/企业 partial；Pod unknown；bash/硬链接/敏感读/TOCTOU 残余不扩。
- 下一验证包（另派）口径：R-Q9a 修复 + 全仓 serial/default 双绿 + 真 Docker/daemon ledger 复验 + session-pin 默认并发 ≥5 轮。
- 证据索引：Pi `/tmp/perimeter-r11/`（含全部失败迭代与越界跑 raw）；grok `/tmp/perimeter-r11-grok/`（四微门+oracle 复跑+typecheck）；报告前各日志尾已实读。
