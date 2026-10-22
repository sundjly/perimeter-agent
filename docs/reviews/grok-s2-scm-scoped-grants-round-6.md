# grok-s2-scm-scoped-grants-round-6.md — Pi R59 修复轮增量静态独审（Grok R60；task_fdbbfa775844 / ctx_9b25d12a5f5a）

- 日期：2026-10-20；审者：Grok（用户授权新 reviewer，同一 term_b1433b68-9487-4b01-b271-e23de2ed269f / incarnation 8b37dbc2 / gen6，未换 agent/model）。被审对象：Pi task_1ec35dc7a95a（R59，s2-b2-scoped-grants-r59.md，bbd23324，done msg_8d5c69ccc8cc 00:06:26Z retained idle 无并写）+ 对照 R58 round-5 与 SCM 合同（2468eefc）。R59 Pi 全程 native-only 为**作者自述**；coor 4 轮静态闸门（prov-r59 seq3-6 全文已读：v1 F1-F6→v2→v3→v4 放行）——**闸门≠review 结论，本报告独立重推**。
- **性质：静态 only（(c) 全程，零行为）**——仅 native read/rg/FS metadata/hash/copy+Orca；零 Node/JS/tsx/tsc/TS-API/npx/npm/Python/解释器/heredoc/awk/sed(含-n)/cat 读取/编译测试/网络/child/ps/signal/Docker/Git/demo/真实 timer/sleep。modelgw 两件仅 hash 不读。**本轮唯一 repo 写入=本文件**；reviewer 根=/tmp/grok-r60-G0brhcpx（0700）。typecheck/tests=unrun/unknown，全部 unit/driver 未运行。
- **判定：request_changes（源 required 已闭，新 15 unit 中 6 例断言-实现失配静态红 + driver 两项缺陷 → 执行准入未达）**。R58 七 required 的**源侧全部闭合**（§2 逐项行号）；但 byte-budget.test 例 1、merge-issue.test 例 1–4、owned-renew-timer.test 例 5 手工推演为**静态红**（§3），driver EXPECTED=63 与实测 64 不符且缺 log error 监听（§4）。B2=partial；S2=partial。

## 0. 封版复验（全过）

根 0700；prov-r60.jsonl 0600 seq1/2 coor 未动，reviewer 追加 seq3+。snapshot 44 regular/0 symlink（=R59 baseline38+6 新：byte-budget.ts/owned-renew-timer.ts/byte-budget.test.ts/merge-issue.test.ts/owned-renew-timer.test.ts/r59doc）；frozen 44/44 MATCH；44/44 cmp 当前工作区字节一致（非 HEAD）。author-driver-r59.mjs SHA=f52a7cbf… 相符未运行。R59 报告 bbd23324 相符；Pi 根 /tmp/pi-r59-tAQlsLgG 60/60 self=149ee266…（coor native 封版，采在案值；final-source 15 件、相对 baseline 实改/新增 13 件——只读未触）。

## 1. R58 七 required 逐项闭合判定（源侧；行号=当前冻结字节）

| # | 证据 | 判定 |
|---|---|---|
| ① 转发段只 bodyDeadline | gitproxy/server.ts:902 `gate.read(bodyBudgetDeadline)`（:776 header 段 min 保留）——合法长 push 不再被 10s 打掉；零窗 `>=` 双保留（bounded-reader.ts:43-46+gitproxy:723-725） | **闭合** |
| ② 全寿命 | 缺口 b：:540 AbortController+:599 `signal: lifetimeAbort.signal`+:826-829 countersAbort fire→onLifetimeFire+cancelSource——真正 abort 外层 fetch；缺口 a：:903-908 done 不再 disarm，dispose 由 #route 各完成路径统一（:559/:567-569/:601-606 fetch catch/:611-617 3xx/:634-644 res close+upstream end/error/:649-651 无 body）；缺口 c：cancelAndDeny **内部统一 disarm**（:699-706，所有 header 早退路径经此）+armDeadlineTimer 缺省 unref（bounded-reader.ts:85）；v3 修正：res close 按 `writableFinished` 区分（:542-548），不监听 req close（避免 body 上传完即误 abort）✓；gzip 泵与 abort 交互：pumpDead 三态+cancelSource 幂等 Promise(:803-813) 保持 | **闭合**；optional：3xx 分支（:611-617）无 preparedDispose——unref timer 残留 ≤bodyDeadline、fire 幂等无害 |
| ③ 字节预算 | 新纯模块 byte-budget.ts（add 即时判+粘滞+seed）；header identity 同入预算（:849-857 fetch 前拒）；seed(cmdBuf+tail) 立即判（:873-879 fetch 前 413/upstream0；EOF 不跳——seed 与 done 无关）；流式晚越限 terminate+unknown 不 retry（:905-912，无 spool 单 fetch 保持）；gzip raw 泵独立（:834 第二参 MAX_SAFE_INTEGER 分源+泵 :704-715） | **源闭合**；unit 例 1 断言错（§3.2） |
| ④ mergeIssueIntoEntry | grant-rotation.ts:50-64：同 owner=**本次已验 signed.cap 权威**（fresh 更短跟着短，不保留旧更长 cap）、currentExpAt=signed.exp、不同 owner **throw 固定类别拒签**（不 add jti/不改 entry）；#issueGitGrant existing 分支真调用（:506-511，merge 先于 jtis.add——other owner throw 时零副作用）；同一 save 提交+失败回滚既有 | **源闭合**；save 失败时 merge 字段残留内存（同 owner 已验值，不越认证期限——observational 与 attach 分支同型）；unit 签名失配（§3.1） |
| ⑤ OwnedRenewTimer | 新纯模块 owned-renew-timer.ts：总 inline=同步段第二 fire 或 syncFireCount≥2 → failclosed 粘滞（有界深度 2，不爆栈不 spin——推演 §3.3）；单 inline=同步 onFire 一次+调用方未重排时本层重排恰一 future slot（:88-102 新 gen 旧句柄失效+closed 复查）；close-during-arm（:67-70）不补写；异步迟到句柄 gen 防护（:50）；**生产接线**：gateway:217 实类+:680 arm+#renewFireOnce(:690-698 finally 重排)+:701 stop 委托+failed 固定审计(:684-686)；TTL/2(:659)/margin/近 cap skip/配对 clear 保持 | **源闭合**；unit 例 5 红（§3.3） |
| ⑥ close 最后重试 | flush 返回 outcome {gitOk,browserOk,remaining}（:605-618）；close 开头最后 flush（:770）+残留>0 → `grantSaveErr ??=`+固定审计（:776-781）→ close 尾 throw **非成功**（disk unknown 不称 durable）✓；revokeAll 成功后 pending 残留不误报（??= 兜底语义正确）；logout 三段独立 try 保持（:1238-1243） | **闭合** |
| ⑦ driver | §4 | **未达准入**（EXPECTED 错+error 监听缺） |

## 2. null cap fail-closed 与「可信无到期 identity」合同裁决（任务④）

**裁决：不冲突，R57-4 沿用正确。** 两者是不同值域：`null` 专指**未知历史**（重启恢复缺失/无可靠来源）→ decideRenew fail-closed skip（renew-policy.ts:26-27，reason "unknown captured cap"）；「可信无到期 identity」的唯一在系统表达是 **Infinity**（demo 契约 :1430 附近 `expiresAt: Infinity`——decideRenew cap=Infinity → mint 恒、computeGrantExpiry min(+15min,∞)=+15min）——null!==Infinity，两条路径互不误伤。production identity=JWT 恒有 exp（finite），无 null 入口；mergeIssueIntoEntry 的 signed.cap=null 分支（可信无到期）显式沿原契约置 maxExpAt=null 并由 15min TTL 锁兜底（merge-issue.test 例 4 断言一致）。SCM 合同 A1「exp ≤15min」与 fail-closed 无张力。建议（optional）：R60+ doc 把「null=unknown fail-closed / Infinity=可信契约」的二值语义写成一句明确注释（代码注释已在，doc 层面 R57-4 沿用句即可）。

## 3. 新 15 unit 手工推演（同一生产实现 ✓ import 全部指向生产文件；正反充分性可；**断言-实现一致性 6 例静态红**）

### 3.1 merge-issue.test（5 例）——**例 1–4 红根因：调用签名失配**
实现 `mergeIssueIntoEntry(entry, principal, signed)` **3 参**（grant-rotation.ts:58-62，coor F4 已移除 nowMs）；测试全部 `mergeIssueIntoEntry(e, NOW, "p1", {…})` **4 参**——principal 形参接收 NOW(number)、signed 接收 "p1"(string) → `entry.principal !== NOW` 恒真 → 例 1–4（正控）全部误抛「不同 owner」拒签 → 断言字段更新失败；例 5（different owner 期望 throw）碰巧匹配 `/固定类别/` 通过（错误原因正确结果）。**修**：4 处调用去 NOW 实参（3 参）。推演修复后：例 1 旧过期覆盖 ✓/例 2 权威变短 ✓/例 3 null 用已验 ✓/例 4 signed.cap=null 沿契约 ✓/例 5 entry 不变 ✓。

### 3.2 byte-budget.test（5 例）——例 1 红根因：seed 实参与断言不符
例 1 `new ByteBudget(1000, MAX)` 后 `b.seed(100, 0)` 断言 `"over-decoded"`——seed=add(100,0)→decoded=100≤1000→实际返回 **"ok"**（注释写"header(100)+tail(950)=1050"但实参只传 100）。**修**：`b.seed(1050, 0)`（对齐注释意图）。例 2（EOF 最后一块即报 1100>1000）✓、例 3（raw 600>500 独立触发）✓、例 4（gzip raw 恒 0 入参不触发）✓、例 5（恰等合法 1000≤1000/粘滞）✓——推演一致。

### 3.3 owned-renew-timer.test（5 例）——例 5 红根因：stop 不失效旧 gen
例 5 stop 后手动触发旧 handle：handle 只查 `this.#gen !== gen`（:50），**stop() 不 bump gen** → gen 仍相等 → 走 onFire → `fired===1`，断言期望 `fired===0`（"迟到 fire 不执行"）→ **红**。生产影响：native clearTimeout 后不会真触发，属 fake 手动触发边界，但测试断言的契约合理。**修（实现一行）**：stop() 内 `this.#gen++` 使旧句柄失效（与重排防护同构）。例 1（异步恰一）✓、例 2（总 inline：arm#1 同步 fire 计 1→同步 onFire 重入 arm#2→arm#2 同步 fire 计 2→failclosed 有界深度、粘滞拒续）✓、例 3（单 inline 同步 onFire 一次+重排 t2 恰一未清+后续异步 fire 执行）✓、例 4（arm 中 closed 翻转→skipped-closed 不补写+closed 恒拒）✓——推演一致。

### 3.4 bounded-reader.test 第 6 例（armDeadlineTimer 纯缝，R59 +1）
未到点不触发/到点恰一/双 fire 防护/零窗 contained 立即/哨兵 disarm 不抛——推演一致 ✓（unref optional-call 对 fake 对象安全）。

### 3.5 EXPECTED 手工核
实测逐 suite：credential 5+receive-pack 13+git-grants 11+renew-policy 10+grant-rotation 4+merge-issue **5**+bounded-reader 6+byte-budget 5+owned-renew-timer 5=**64**。R59doc §2/F6 的 63 系 merge-issue 4 例误记；renew-policy=10 已在 F6 更正 ✓。

## 4. driver 静态准入（author-driver-r59.mjs，未执行；**未达准入，3 项修正后可再请 coor 审**）

- **合格面**：纯 .mjs 无 TS 注解（:14 REMAIN）；guard 自 T0 arm 9s 剩余（:14-16）先于全部动态 imports（:19-21 try 内）；tap 动态 import 自 node:test/reporters（:20）+`pipeline(tests, tap, log)`（:46，tap 函数作 async-generator transform——本机类型合法形态）；lstat+isDirectory+!isSymbolicLink+mode===0700+uid（:25-27）；mkdir recursive:false EEXIST 判负（:29）；log wx 0600（:30）；isolated:none/concurrency:1 九文件（:31-42）；判负=唯一 overall test:summary ∧ success ∧ counts.tests===passed===EXPECTED ∧ cancelled/skipped/todo===0 ∧ fail===0 ∧ wall<9s（:55-59）∧ summaries===1；fresh wall 在 pipeline+log close 后（:48-50）；catch 固定类别+clearTimeout+exit(1)（:60-63）；R47 排除 ✓。
- **缺陷 1（required）**：EXPECTED=63（:55）≠实测 64（merge-issue 5 例；:39 注释"4（新）"错）——现跑必假红（保守向，但判负基线失真）。修=EXPECTED 64+注释更正。
- **缺陷 2（required-minor）**：log 无 `once("error")`——R59doc §2 声称"log once("error")/once("close")"与实现不符；写流 error（ENOSPC/EPIPE）无监听=uncaught 'error' event 进程崩溃（非零但非受控类别）。修=补挂并计 fail。
- optional：:46-47 重复注释行；错误 stderr 输出一行固定类别 ✓ 已合规。

## 5. 三态与执行准入前置项

- **source 静态接受**：§1 ①–⑥ 全部（含 coor v1–v3 闸门发现的 F1/F2/F3/F4/F5 实源修复独立复核成立）；**R58 七 required 源侧全闭**。
- **required（本轮新，交原 Pi）**：①merge-issue.test 4 处调用去 NOW（3 参）；②byte-budget.test 例 1 seed 实参对齐（1050）；③OwnedRenewTimer.stop() 补 gen++（例 5 契约）；④driver EXPECTED=64+merge-issue 注释；⑤driver 补 log once("error")。optional：3xx dispose、driver 冗余注释、doc merge-issue 计数 4→5 更正、R58 报告两处元勘误承接（round-4 hash 引用错用 131a（实为 round-3；round-4=06f6515d）与日期/done 时序差——R59doc §3 已如实记录，旧文不改）。
- **static eligibility（当前字节）**：READY=credential(5)/receive-pack(13)/grant-rotation(4)/renew-policy(10)/bounded-reader(6)/byte-budget 例 2-5/owned-renew-timer 例 1-4/git-grants(11，宿主红已除恢复)/r47cases(12 standalone 另批)；NOT ready=byte-budget 例 1、merge-issue 例 1-4、owned-renew-timer 例 5（§3）、driver（§4）、wiring/gitproxy.test/git-e2e/git-grants-integration（维持）；Gateway/proxy 生产文件静态可解析（全 repo 参数属性零残留 rg 复核 ✓）。
- **execution**：全部 unrun/unknown。
- **执行准入请求前置项（判可进入执行前 coor 仍须审）**：①上述 5 项 required 修后由本 reviewer 增量静审确认；②修正后 driver 实际脚本逐行再审（EXPECTED=64/error 监听/路径注入 R59_RUN_ROOT 的 fresh 独立根预置与 0700/uid）；③真实父 shell wait 与 wall 协议批文；④typecheck 仍应在真实执行轮首步补跑（unrun 口径不变）。本轮**不批准任何执行**。

## 6. 元信息

本轮零行为达成（native read/rg/hash/cmp+Orca；无 sed/cat/python3/heredoc）。邮件：dispatch 时 count=0、交付前再查 exact ack/drain0。根内仅追加 prov-r60 seq3+ 与一次 self-excluding manifest（本文件与 manifest selfdigest 不嵌自身，selfdigest 只记 done）。R59doc §3 元信息段（R58 manifest 重生成一次、round-4 hash 引用错用 131a、日期时序差）承接如实，旧文不改。下一源码轮：原 Pi 修 §5 required → 本 reviewer 增量复审 → coor 执行闸门 → 真实执行轮（typecheck+48+2=64 unit+driver）→ 17 真实验收/P1/gzip/3HTTP/demo 继续 loop。
