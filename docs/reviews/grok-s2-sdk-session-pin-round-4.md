# Grok S2 SDK session-pin 第四审（round-4，终版）：R-Q9d 与主体修复证实；R-Q9c oracle 缺陷经独立复现 → request_changes（R-Q9c + R-Q9a/b 负控补齐）

- 结论：**request_changes（收尾：R-Q9c helper oracle 缺陷 + R-Q9a/b 负控补齐）**。成立并维持：R-Q9a 的「任何 await 前同步登记 dispose + 失败 close + runAllCleanups 聚合 + 重连新代新 nonce/完整身份/末 gone」、R-Q9b 的「kill 前登记代际全字段比对 + kill 可注入」、R-Q9d 全部（nonce 资源名/全 64-hex CID/gone=同一完整 CID exit1+`no such object` 精确匹配/exit0=live 判失败/timeout-null-signal=unknown/git 子命令全隔离）、Docker owned ledger 与 525×2 双绿——均独立复证且协调者确认为「已看见成立部分」。**但 R-Q9c 存在 helper oracle 真实缺陷（协调者纯 fake probe 独立复现 + 本审代码复核证实）**：`waitOwnerGone` 对「未采到出生身份（NaN/空 generation）仍 alive」的 owner 因 `matchesGeneration` 必假而记 `gone-pid-reused` 并 **resolve**——活 owner 被假认已消失；且「任一字段不符即 reuse」过宽（同 birth 的父/组/marker 漂移非死亡证据）。19 项负控**无 kill spy、无 track 观察失败注入、无 birth/pgid/ppid 分变量用例**，报告「kill spy 由 fault-control 覆盖」无代码依据。525×2 全绿不能抵消该 oracle 缺口。R-Q9d 维持；G1-knownlost 已批部分不撤（缺陷在测试 observer 层，非 SDK/installer/runtime 产品面），但 **R-Q9c/a-残余/b-负控 修前不得宣称 R-Q9 全闭**；3s 预算门槛/G3/lost/30s/CANCEL/S2 企业维持 pending/unknown/partial/Pod unknown。
- 日期：2026-10-17；审查者：grok（唯一 reviewer；Pi 唯一 coder，task_8a813eeb332a 修复交付）。依据：round-3 R-Q9a～d + 协调者 06:43～06:44 三条追加清单（含独立受控复现）。
- 哈希台账（本审实测全符 §9.3）：`tests/helpers/ps-observer.ts` `6c2ef7205b6bc747`、`tests/ps-observer.test.ts` `7ec12e43a7a723fc`、`tests/session-pin.test.ts` `fb9b10db4dd78cd0`、`tests/pi-env-build-negative.test.ts` `1167075be8c6c316`、`tests/docker-owned-ledger.test.ts` `1a6f6fba0d28a972`；产品 `pi-env-patch.ts` `f7ebe0ce`/`execution-env.ts` `9839b87a`/`path-guard.ts` `747070b2`/`scripts/pi-env-patch.ts` `fcd4f964`/`build.mjs` `40753000`/manifest `0b87934f` 与安装 SDK dist `d59a1c09` ——**R3 终态零改动（本轮仅测试件）**。
- 允许写入：本文件、coverage。未改实现/tests/SDK/作者报告/handoff/AGENTS；未 commit/push/spawn；零 cargo/npm run build/npm test/install 生命周期/全仓 --write；未碰 daemon/context/workload/历史资源；无 secret dump/公网调用。

## 1. 成立部分（本审独立复证；协调者确认不重开）

- **R-Q9a 主体**：`track(connection, register, kill)` 的 `register(()=>dispose())` **同步于任何 await 之前**；snapshot/observe 失败→catch→`await dispose()`→重抛；`after` 用 `runAllCleanups`（逐个执行 await+聚合，首失败不跳过其余）；R-Q1 用例重连新代 `newResource`（新 nonce/inspectIdentity/session 一致/pid≠旧/末 dispose gone 观察）。**残余见 R-Q9a'。**
- **R-Q9b 主体**：`inspectIdentity`/`kill` 与登记代际 ppid/pgid/birth/command-marker 全字段比对，任一不符拒杀；`kill` 经构造注入（可 spy）。**负控缺位见 R-Q9b'。**
- **R-Q9d 全部**：nonce 入容器名；全 64-hex CID 记录；gone=同一完整 CID exit1+stderr 精确含 `no such object: <fullCID>`；exit0+Id 匹配=STILL-EXISTS 判失败；timeout/null/signal/error/其它=unknown 失败；`backend.environment` await 入 try；失败分支逐项 attempt 聚合；git 子命令全隔离（10s 独立 deadline/NOSYSTEM/GLOBAL=/dev/null/hooksPath/gpgsign×2/TERMINAL_PROMPT=0）；`ledger-docker.jsonl` 91 行实读（本轮事件含全 CID 与 nonce 资源名）。协调者确认此部分成立。
- 本审独立运行（runner header/raw argv/PGID/自然 exit，日志 `/tmp/perimeter-r10-grok/`）：serial **525/525/0/0/0 exit 0 自然 239.2s**；bounded **525/525 exit 0 自然 129.3s**；ps-observer **19/19**；patch-install **14/14**；build-negative **4/4**；docker-ledger **1/1**（自有 nonce 事件入 ledger）；session-pin **7/7**；path-guard **24/24**；SDK vitest **5/5**（828ms）；tsc 0 错误。Pi 侧（/tmp/perimeter-r10/）serial 240.1s/bounded 129.3s 双绿、observer×3、run1..5、docker-ledger（含 1 次诚实 fail 迭代）——本审逐日志亲读计数与墙钟，非复制上轮。
- Docker 本轮健康；运行后全局容器 0（仅旁证）。ledger：session-pin 300 行、docker 91 行——仅证本轮 owned 对象，整仓历史资源仍 unknown。

## 2. R-Q9c/a'/b' required（协调者三条清单逐条实证；525 双跑不抵消）

- **R-Q9c（oracle 缺陷，未闭）**：`waitOwnerGone` 对 alive 观测只要 `matchesGeneration` 假即记 `gone-pid-reused` 并 resolve——**协调者受控复现**：fake observer 恒 alive + observe 失败态 generation（NaN/空 birth）→ 应 reject unknown，实际 resolve（`/tmp/perimeter-r10/coordinator-unknown-generation.{mjs,log}`，runner 15s/PGID 98374，exit 1/58ms）；本审代码复核同结论。且「任一字段不符即 reuse」过宽：同 birth 的 ppid/pgid/marker 漂移非死亡证据。修正：**仅在已取得有效完整出生身份后，真实 birth 可信不同才可判 PID 复用；同 birth 漂移或字段无效/未初始化一律 unknown（拒杀、不计 reaped、测试失败）**；修正相应 mock 期望（不得把错误语义写成通过）。
- **R-Q9a'（dispose 假 gone 与 unknown 收尾）**：`observe` 先 set pid/session 再 ps，失败即抛——track catch 的 `dispose` 以未初始化 generation 走 waitOwnerGone → 触发 R-Q9c 缺陷把活 owner 记 gone 并**成功返回**；pid 未知时 dispose 仅记 unknown 即返回也算「收尾成功」。修正：身份未采得/unknown 时 dispose 必须**失败收尾**（ledger unknown+throw 或显式 unconfirmed 结果），不得假 gone/假 clean；补 track 观察失败注入负控。
- **R-Q9b'（kill 负控缺位）**：19 项无 kill spy、无 birth/pgid/ppid 分变量用例、无 track 观察失败注入；报告「kill spy 由 fault-control 覆盖」无代码依据（ps-observer.test.ts 全文仅注释级 kill 字样）。修正：补「身份不符零 kill（注入 spy 断言）」「birth/pgid/ppid 分别漂移→unknown 拒杀」「真实 birth 不同→可判 reuse」等用例。
- **R-Q9d'（观察项，非阻塞）**：Docker driverProbe birth 多为 unknown 且无 driver 末态 gone；inspect-gone stderr 用 `.includes` 而非整句白名单——已按修正语义实现主判定，边际收紧可与 R-Q9c 修复同包。
- 观察项保留：session-pin-1.log 与 run1..5 并存（首轮+5 轮）；SDK 定向 vitest 本轮作者未列行（SDK 零改动），本审 fresh 5/5 补证。

## 3. 放行与边界

- 修复包范围 = R-Q9c oracle 语义修正 + R-Q9a'/b' 负控补齐（纯测试 helper 层；SDK/installer/runtime 产品面零触及）。修后验收：协调者复现脚本改为 expect-reject 通过 + 修正语义的 observer 负控全套 + session-pin 默认并发 ≥5 轮全绿 + serial/bounded 双绿（raw header）。
- 边界不变：G1-knownlost ≠ 3s 预算门槛（30s 静默窗口/无响应 CANCEL 仍 blocked）；G3 lost 死亡 pending/unknown，transportExit ≠ daemon kill_all，closeAsync/verifyReap 未实现；整仓历史未逐项记录资源仍 unknown（不把旧未知资源当已清）；s2-protected-paths/S2/企业 partial；Pod unknown；bash/硬链接/敏感读/TOCTOU 残余不扩。
- 证据索引：Pi `/tmp/perimeter-r10/`；grok `/tmp/perimeter-r10-grok/`；协调者复现 `/tmp/perimeter-r10/coordinator-unknown-generation.{mjs,log}`；历史 `/tmp/perimeter-r7*`～`r9*` 全部保留；报告前各日志尾已实读（Pi 计数/墙钟本轮亲读）。
