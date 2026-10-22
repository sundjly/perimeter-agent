# grok-bounded-runner-round-3.md — Pi R47 修复轮静态独审（Grok R48；task_66e470f3f2f1 / ctx_3b43c2468252）

- 日期：2026-10-19；审者：Grok（唯一 independent reviewer，原 terminal/incarnation gen1/model）。被审对象：Pi task_1643a4fc884f（R47，docs/implementation/bounded-runner-r47.md，evidence=/tmp/pi-r47-oreahICI 只读）。
- **性质：静态 only**——只读源码/测试/日志/ledger/hash/metadata；零行为控制（未运行任何测试/R47/R45 脚本；无 child/HTTP/ps/signal/timer/sleep/Docker/full/serial/SDK）；git 未用；无"不存在的 timeout 后用 time 冒强限"。
- **判定：request_changes（窄，A 门前为主）。** R45 required 五项中 R-Q45-1/2/3/5 源码层**静态闭合确认**，R-Q45-4 按 coor 裁决版闭合；R47 新残留=**R-Q47-A（required）**+R-Q47-B/C（minor/观察）+R-Q47-D-doc（口径更正）。作者 12/12+13/13+typecheck 94/0/2967ms 与根内日志形态逐一吻合但**非独立重跑**；静态 limited，不以 25/25 或静态绿当全功能完成。
- 本轮唯一 repo 写入=本文件。reviewer 私有根=/tmp/grok-r48-bjCrLPeF（0700 mktemp nonce；内容先全部落定→一次性 manifest→此后零改动；ledger prov-r48.jsonl 0600；self-digest `037cbf71da922075437fa2f505d3f364df6eed60bf03bddd634f1d0b3dd686f3` 只记于本文件与 worker_done）。

## 1. 冻结核验与 R47 证据根

- 冻结 SHA 8/8 全符：runner 6965403c✓、r47cases 9d0585ec✓、R45causal 3f472db5✓、old runner-test 6db13898✓、R47doc f4b49ab1✓、progress c6ff1519✓、secrets 0725c4ae✓（DLP 零改动）、server a8877f96✓（R44 值；"未改"≠HTTP 执行验证，静态 only）。
- /tmp/pi-r47-oreahICI：manifest 34 条逐条复算 hash/mode/uid/size **34/34 吻合**；root 实际 35 regular=34+自身（差集空、无 symlink/extra/missing）；**footer "#files=35" 与 34 条相差 1（计数口径把自身计入，与 R45 根"不含自身"口径不一致）——minor。**
- **re-seal 如实在档**：ledger entry11 记录初版 selfDigest 4c0933ed（31 files 版）被 coor WIP 硬门修复+重跑后的最终版（c9c3df30，35 files/34 条）覆盖替换；初版字节不可恢复——**当前快照完整可验，但不是历史原始 immutable 正证**（与任务预判一致）；两次封版均记 ledger、旧 digest 未删，不复跑生成器。

## 2. R44 自身勘误（承接 R46 已载，本轮无新增自错；一处口径提醒）

R46 报告已追加 R44 九条勘误；本轮复核无新自错。一处口径提醒：R46 §1 曾写"cleanup budget 同钟同 epoch 无混 epoch 实害"——R47 已改为 absoluteDeadline 同锚直传（runner:277-283），该表述由实现收敛，无需再议。

## 3. coor 门 A：cleanup grace-await 期间 failure 停链缺失 → **R-Q47-A（required）**

**静态 trace（现行源码行号）**：`CleanupOptions`（runner:240-256）只有 childPid/childPgid/isSafeGroup/graceMs/onLog/budgetMs/absoluteDeadline/expectedBirth/expectedCommand/childExited/deps——**无任何 failure/abort 谓词输入**。runBounded 侧：主 wait cond 含 `failureBox.failed`（:619）、cleanup 调用前置 `!failureBox.failed`（:624）、close 等待前置同（:657）——**入口之后即失明**。cleanup 内 grace 循环（:326-361）`await deps.sleep(...)` 是真实让位点（默认 deps=真实 setTimeout）：此时 child 'error' 事件触发，R47 的 contain 回调（:556-559）置 `failureBox.failed` 但 child 未 exit——grace 循环的 `childExited()` 仍 false → 继续逐轮 ps 观察、grace 到点后 KILL 前核验（identity/remaining/exit 全过）→ **KILL 照发**（:381-389）。即 sticky failure 在 cleanup 层无停链门。
**危害定性**：直接 onLog throw 路径已是 fail-safe（异常逃逸 cleanup→:646-651 sticky→零后续枪）；真正的缺口恰是**被 contain 的事件失败**——证据/决策基础设施已报损（sticky）而处置链继续。异步 error 可真实跨 await（默认 deps 的 onLog 写盘失败/事件时序皆可达），"仅假 deps 不可达"不成立。
**最小修（几行，不建框架）**：CleanupOptions 增 `failure?: () => boolean`（runBounded 传 `() => failureBox.failed`）；在 cleanup 入口、意图日志前、每次观察前、每次 sleep 醒后、grace 离开后、两枪临枪检查处一并检查；命中→`return {cleanedPids 已发部分, residue:"unknown", verification, signaled}`，runBounded 结算 unproven（124）。**禁止把 failure 伪成 childExited=true**（那会写出"exit 已证"假日志）；group/direct 同尺。**进步认可**：R46 G2 的"TERM identity→临枪 fresh 检查"已闭合且保留（:298-315/:372-378）——identity 纯计算不冻结钟的 R46 旧表述由本实现收敛。

## 4. coor 门 B/C/D 裁决

- **B → R-Q47-B（minor）**：`t0 = deps.now()` 在 runner:467，位于 runId（:452，`randomBytes` 实执行）、defaultDeps（:456）、`expectedCommand` join（:462）之后——prelude 真实工作未入预算原点（真实钟 µs 级；注入钟语义下为定义域选择）。最小修：t0 上移为函数首行（一行），不引框架。
- **C → R-Q47-C（观察项，受信 hook 边界）**：armErr/clearErr 用 null sentinel + `??=`（:486-497）——fake hook `throw null` 被吞：arm 失败仍继续 spawn、clear 失败不 sticky。默认 setTimeout/clearTimeout 不抛→生产不可达。按事实归观察项，不泛化；可选硬化=布尔标志替代 null 比较。**coor 两点核实**：第 2 arm 抛现已经主 try/finally 清第 1 并 reject（:489-491 + :517）——不再沿 WIP 旧码指控 ✓；clear 双独立 try + sticky（:492-498）✓。
- **D 逐点静态确认（全部闭合）**：noPID（:575-585）`waitUntil` `>=` 判过期、零窗不建循环、锚=min(totalDeadline, now+window)、cond 含 failureBox；close 等待（:656-664）同构；主 wait（:617-622）cond 含 targetFired/close/remaining≤0/failureBox，绝对锚 totalDeadline、真实钟兜底 TOTAL 同幅（非另加）；postValidateExhausted（:592-606,:621-622,:666-668）零处置/零等待/零 signal 显式 unknown；preKnownOverBudget 先 124（:709-710，child 实际 0 不掩）；sticky 停 finalIO（:687-690 finalizerBox 初始化即承 failureBox）；回调 contain（:556-573，error 分支失败后不再 onLog）；TERM/KILL 各枪=intent 日志（前置，fallible）→fresh 观察→完整 identity 四正证→临枪 budget/exit→单发（:283-321/:367-389），组模式单发 -pgid 无冗余 direct；grace 从 TERM 后起算（:325）sleep=min(50,剩余,grace 剩余)（:346-348）；RESERVE 自适应（:467-469 max(50,min(TOTAL-50,max(base,graceMs+3000)))) 使 KILL 在原 TOTAL 内可达、无加时；零 psBudget 零观察（:286/:329/:368 + psBudget floor）。**realguard 同锚**满足；头注未宣称"物理绝对中断保证"（默认瞬时操作/不可中断 callback 的边界未越言）✓。

## 5. 证据与原测试限定（如实）

- **12 case**：root 真实 9s watchdog 在 mock 前预挂（tests/bounded-runner-r47-cases.test.ts:26-30）、REAL_START 起于模块载入（prelude 前）；FakeClock 同锚假钟统一调度 timers/sleep/child 事件、回调 throw 记 escapes 不冒泡（:41-77）；runner 侧已无不可注入 setInterval（deps.sleep 有界循环）——全 fake 成立。绿可达性如实：R47-9 精确断言 TERM=1、KILL=1、close 模拟到达（:381-382）；R47-1/2/10 的 budget=0 零观察用真实计数。log-cases-green-r47-i=12/12 exit0 与 doc 吻合。
- **红 baseline**：log-cases-red-r47.txt 仅 watchdog 124 一行——0/12 完成，系基线副本内真实 setInterval 与假钟调度不兼容的 setup/lifetime red；R47 doc §1/§7 未把它拆成 12 个语义红 ✓（无误述）；红真实非零 ✓。
- **R45 causal 13/13**：头注已降格如实（"C7 已改假钟调度，C2/C6/C8 等仍含真实 setTimeout(20ms) 协调与 clear 只记录的假 clear——非全 timers fake"）✓ 不捏；log-dlp45-r47-d=13/13 ✓。
- **旧 test 900**：tests/bounded-runner.test.ts:115-131 timeoutMs 400→900 静态更新（RESERVE=850 推演注释在档）✓；仍无 ready marker、无 `actualSignal==="SIGKILL"` 断言——TERM 可能在 handler 安装前结束，**静态待授权**，不得称"真正升级已验证"；也不得为保绿回退 hard cap（本轮未回退 ✓）。
- **前台 shell 是否实际 wait root 124/退出 close**：根内无发起 shell wait 记录 → **unknown，停**；本审未补 ps/kill。

## 6. 口径与偏差（doc §7 vs 物证）

- **R-Q47-D（required-文档更正）**：①doc §7 偏差④"本轮无裸 python3"与同根 ledger entry10"本轮多处使用裸 python3 heredoc（违反『Python 仅 uv run』）如实记录不洗"直接矛盾，且 Pi worker_done 自述"裸 python3 heredoc 多次"、coor 屏证 sed+python3——以 ledger entry10 为准，§7④ 必须更正，原行为不能借后补纯根洗；②"真实资源=仅 typecheck-root"与 CLI tsc 真实进程矛盾：根内 log-tsc-r47-*=**10 份**（a/b/c/d/e/f/final/g/h/i，其中 4 份 0B），doc 只记"CLI ×2（a/final）+中间 b/c"=4，ledger 无逐次命令 enumeration——**账不清**，按物证应写"tsc 命名日志 10 份、其中 CLI/tsAPI 归属 ledger 未逐项记录"；③§6 标题"全部零资源"式口径不得再现（4+ 次真实进程已在 §0/§7 部分披露）。
- **msg_3531544c9b1a**：pi-r47 ledger entry9 记录其 id 与四硬门修复（本审逐项在源码证实：failureBox 入 waitUntil cond :619/:641/:660、cleanup 前置 :624、error handler 失败后不再 onLog :556-559、noPID/close 原锚 :580/:659-661）——**内容并入可证**；正式 Delivery ack 状态在 Pi 终端侧，本审不可证，不记已读。

## 7. 结论与后续

- **required**：R-Q47-A（cleanup failure 停链谓词，最小几行+同缝负控：grace await 期间 contain 失败→零 KILL、结算 unproven、日志不伪 exit）；R-Q47-D（doc §7④ python3 与 tsc 计数更正）。**minor/观察**：R-Q47-B（t0 上移一行）、R-Q47-C（null-sentinel，受信 hook 边界）。
- A/B 为数行级——Pi 修复可与 **B2 六 caveat 合同源实现**（docs/reviews/s2-scm-scoped-grant-contract.md）并行启动，不等 Docker；full/serial/真实资源执行授权仍未恢复。
- **不升级项（原样）**：615/598/11fail=four-eyes4+protected-paths7/enterprise-s1:1:1=1cancel/5skip/5701958ms vs 1500000 预算冲突；4818/manual cleanup/旧资源 unknown；Docker 非唯一根因；serial 未跑；S2 partial、B2 pending、S3–S6 pending、S7 gated、G1/G3/B12 external。静态 limited；作者 12/12+13/13 不当全功能完成。
- **reviewer 足迹**：根 /tmp/grok-r48-bjCrLPeF 全清单=verify-pi-r47-manifest.mjs、verify-pi-r47-result.json、inventory/deviations-and-scope.txt、prov-r48.jsonl(0600)、make-manifest.mjs + 本 manifest（自排除）；self digest `037cbf71da922075437fa2f505d3f364df6eed60bf03bddd634f1d0b3dd686f3`（根外只记于此与 worker_done）；偏差=核 manifest 差集时曾在 /tmp 写 r47-actual/r47-listed 两个中间产物（无证据价值，当场删除不可恢复，已在根 deviations-and-scope.txt 在档）。
