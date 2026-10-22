# grok-s2-scm-scoped-grants-round-7.md — Pi R61 修复轮增量静态独审（Grok R62 新实例；task_e5d5df9bdee2 / ctx_49984f9e08ea）

- 日期：2026-10-20；审者：Grok（用户新实例；term_2769b867-ffd0-4a48-818f-70bf4e6cb8b1；非 R54–R60 原 reviewer 进程，用户授权重启）。被审对象：Pi R61（task_dbc1eb6d2095 / ctx_ee0aee9088af；s2-b2-scoped-grants-r61.md f69dee74；Pi 根 /tmp/pi-r61-aCT6jSv1 coor 已封版：manifest 57 行 56 记录，self=baaa626e 本轮亲核相符）+ 对照 R60 round-6（75b3aec8）全文独立重推。原 R62 实例卡死未交付；其遗留草稿见 §6 勘误。
- **性质：静态 only（零行为）**——仅 native read/rg/shasum/cmp/diff/FS metadata+Orca；零解释器/heredoc/sed/awk/cat 读取/编译测试/网络/Git/Docker；modelgw 两件仅 hash 不读；runner 6f4e2b0f 冻结未动（frozen hash 无该件 drift）。**本轮唯一 repo 写入=本文件**；reviewer 根=/tmp/grok-r62-3e1SPspZ（0700 实测；prov seq1/2 coor 不可改，reviewer 追加 seq3+；最终一次生成 self-excluding manifest，此后根内零写）。typecheck/tests=**unrun/unknown**，全部 unit/driver 未运行。
- **判定：request_changes——R61 四改全部闭合 R60 五 required（§1 逐项）；stop gen++ 四路径无回归（§2）；64 例逐 suite 手工推演 63/64 一致，新发现 git-grants 例 8 静态红（R-Q62-1，非 R61 引入的潜伏红）→ 修前执行准入不达**。B2=partial；S2=partial。

## 0. 封版与基线（全过）

- snapshot 46 件 frozen 重算 **46/46 MATCH**；46/46 cmp 当前工作区字节一致（非 HEAD）。driver 双份（Pi 根 driver-candidate-r61.mjs 与本根 author-driver-r61.mjs）SHA=26271b07 相符，未运行。
- R61 改动面独立证实：对 R60 根 /tmp/grok-r60-G0brhcpx（44 件）逐件 cmp——恰 **4 件 drift**=src/gateway/owned-renew-timer.ts、tests/byte-budget.test.ts、tests/merge-issue.test.ts、docs/implementation-progress.json，**2 件新增**=docs/reviews/grok-s2-scm-scoped-grants-round-6.md（R60 本轮产物）+ r61doc，零删除——与 R61 声称改动面精确一致，无超范围编辑。progress.json：单 hunk `68c68` 行内替换（两文件各 158 行），新巨行含追加的【R61 轮时点】与【R59 coor 静审修正 F1–F6】段，历史段落原样可见（行内逐字节子串证明受工具纪律所限未做，以 diff hunk+hash 记录为准）。

## 1. R60 五 required 逐项闭合判定（行号=当前冻结字节）

| # | 修复证据 | 推演 | 判定 |
|---|---|---|---|
| ① merge-issue 3 参 | tests/merge-issue.test.ts:17/:24/:31/:37/:45 全部 `mergeIssueIntoEntry(e, principal, signed)`；实现 grant-rotation.ts:56-67（:61 不同 owner throw :62 固定类别；:65-66 maxExpAt=signed.cap、currentExpAt=signed.exp） | 例 1-4 正控（旧过期覆盖/权威变短/null 用已验/cap=null 沿契约）字段断言成立；例 5 throw `/固定类别/` 且 entry 三断言不变 | **闭合** |
| ② byte-budget 例 1 | tests/byte-budget.test.ts:12 `seed(1050, 0)`（注释 100+950 对齐）；实现 byte-budget.ts:42-58 add 即时判+粘滞 | decoded 1050>1000 → "over-decoded"+overDecoded 粘滞位 ✓；例 2-5 复推一致 | **闭合** |
| ③ OwnedRenewTimer.stop gen++ | owned-renew-timer.ts:38 `this.#gen += 1`（:36-44 stop） | 例 5：arm 后 gen=2 → stop→3 → 旧句柄捕 2≠3 → `fired===0` ✓ | **闭合** |
| ④ driver EXPECTED=64 | driver :49 `5+13+11+10+4+5+6+5+5`=64；:37 merge-issue 注释更正 | 与 rg '^test(' 实测逐 suite（credential 5+receive-pack 13+git-grants 11+renew-policy 10+grant-rotation 4+merge-issue 5+bounded-reader 6+byte-budget 5+owned-renew-timer 5=64）一致 | **闭合** |
| ⑤ driver log.once("error") | driver :26 `let fail` 先于 log（无 TDZ）+:28 `log.once("error", …fail+=1)` | 写流 ENOSPC/EPIPE 受控计 fail → pipeline reject → catch 固定类别 exit(1)，不再 uncaught 崩进程 | **闭合** |

## 2. stop gen++ 回归审查（四路径全过）

- **arm 自身**：arm 首行 `this.stop()`（:48）先 bump、:49 `const gen = ++this.#gen` 后取新值——全部分代比较只依赖 gen 单调性，每次 arm 双 bump 无影响。
- **单 inline（例 3）**：同步 onFire（:90）后重建前置信 `#gen===gen`（:96）仍成立（无人再 bump）→ 重建 `gen2=++#gen` 恰一 future slot；生产 native timer 恒异步，该支路仅 fake 面激活。
- **总 inline（例 2）**：`syncFire`/`nestedSync` 为每次 arm 的闭包局部；`#syncFireCount` 跨 arm 连续计数=2 即 failclosed（:85-88），有界深度 2，不爆栈不 spin，粘滞拒续 ✓。
- **close-during-arm（例 4）与迟到句柄（例 5）**：skipped-closed 不补写 slot；close 路径 stop 的 gen bump 使「已出队未执行」的迟到 native 句柄也失效（强化方向）。gateway 接线（server.ts:217 实类/:680 arm/#renewFireOnce :690-698 finally 重排/:701 stop 委托/:683-687 failed-illegal-hook 固定审计）经 `closed()=this.#closed` 收敛，无 gen 外泄 ✓。

## 3. 64 例逐 suite 手工推演（63/64 一致；1 例静态红）

- **READY（8 suite 53 例）逐例推演与生产实现一致**：credential-domains 5（字节级两两互异/hex 形态差/空值跳过/同名自碰/31B 边界——credential-domains.ts:19-55）；gitproxy-receive-pack 13（逐字节切分收敛/全零 OID 非 flush/例 4 计数 649×101=65549>65536 且 error 带 64KiB/例 5 "zzzz" 非 hex 与 "fffe">PKT_MAX/重复 ref 固定类串逐字对齐/7 个非法 refname 全拒/例 9-11 转发字节等价含大 pack 同 chunk flush 先命中/例 12 cancel 收束/例 13 解压后同函数——receive-pack.ts 全文对照）；renew-policy 10（margin/delay 数值逐项复算全对上，含 3min-45s=135000 与 cap 到点 4000/已过期 250——renew-policy.ts + grant-session-mapping.ts）；grant-rotation 4（sign/verify+plan/apply/rollback/retire 全路径——grants.ts + grant-rotation.ts）；merge-issue 5、bounded-reader 6（race 败支 rejection 由内部 handler 吸收无 unhandled；例 6 双 fire 防护/零窗立即触发/哨兵 disarm 不抛）、byte-budget 5、owned-renew-timer 5 全过。
- **git-grants 11 例中例 8 静态红（R-Q62-1，本轮新 required）**：tests/git-grants.test.ts:107 裸调 `signGrant(claims({caps:{read:true, write:true, writeRefs:["not-a-ref!!longpayload…"]}}), MASTER, NOW)`，而 grants.ts:102-107 的 writeRefs glob 校验**无条件**（签发与验证共用 validateClaims；:104 `isValidRefGlob` 非 `refs/` 前缀即 throw「caps.writeRefs 非法（固定类别，不透传原文）」）→ **signGrant 同步抛出**，测试回调带异常退出，node:test 判红（verifyGrant 与其 :111 全串断言永不可达）。该文件自 R53 执行禁令起 unrun；系 H53-b 共尺改造的潜伏红，R59/R60 的「git-grants READY（宿主红已除恢复）」分类未逐例复核此项（R60 §3 只推演 R59 新 15 例）。**修法（二选一，交原 Pi）**：A（保验证面 oracle）——手工组 token：`b64url(JSON.stringify(badClaims)) + "." + HMAC("perimeter-git-grant-v1\x00"+payload)`（绕开 validateClaims 构造），verifyGrant 命中 catch→:111 全串断言与不含原文断言原样（补 `createHmac` import）；B（KISS 降签发面）——`assert.throws(() => signGrant(…), /caps\.writeRefs 非法/)`+对 error.message 保留不含原文断言（verify catch→reason 分支失覆盖，如实记录）。修复不改测试计数，**driver EXPECTED=64 无需再动**。

## 4. driver-candidate-r61.mjs 静态准入（七项全过）

纯 .mjs 无 TS 注解、import 仅 node: 内建（node:test/node:test/reporters/node:stream/promises/node:fs）；guard 自 T0 绝对 9s（:11-14）**先于全部动态 imports**（:15-18），catch 路径亦 clearTimeout+exit(1)（:61-63）；runtime major≥24（:19-20）；R61_RUN_ROOT lstat 精检（isDirectory/!isSymbolicLink/mode&0777===0700/uid，:21-23）+mkdir recursive:false EEXIST 判负（:25）+log wx 0600（:27）；`pipeline(tests, tap, log)`（:45，tap 直用 transform 形态=R60 已核本机合法形态）；唯一 overall summary 严格判负（:50-54：summaries===1 ∧ success ∧ counts.tests===64===passed ∧ cancelled/skipped/todo===0 ∧ fail===0 ∧ wall<9000）；wall 在 pipeline+log close 后采样、guard 于最终证据后清（:46-48，**9s 含最终 IO**）✓。前提提示：当前字节下若执行，git-grants 例 8 必假红（保守向）；修 R-Q62-1 后 driver 本体零改动。

## 5. 三态与执行准入前置项

- **source**：R61 四改=闭合 R60 五 required（§1/§2）；生产其余文件与 R60 冻结字节一致。**required：R-Q62-1（git-grants 例 8，§3）1 项**——交原 Pi 修后由本 reviewer 增量静审。
- **static eligibility**：READY=§3 的 8 suite 53 例；NOT ready=git-grants 例 8（修后重审）、driver（执行面 unknown）、wiring/gitproxy.test/git-e2e/git-grants-integration/r47cases（standalone 9s 另批）维持。
- **execution**：全部 unrun/unknown。
- **执行前 coor 仍须审/做（本轮不批准任何执行）**：①R-Q62-1 修后增量静审通过；②若 Pi 再动 driver 则重审重封（本轮 26271b07 静态准入已过）；③coor 预置 R61_RUN_ROOT fresh 独立 0700 执行根（repo 代码与证据分离）；④**真实父 shell wait 与 wall/exit 采集协议批文**（本轮维持零执行，wait 协议未批）；⑤执行轮首步 `npm run typecheck`（unrun 口径收口）再经 driver 跑 64 unit；⑥「review 通过后 coor commit 代码（不含 md）」的用户授权门——本轮 review 未通过，commit 随 R-Q62-1 后置；⑦17 项真实验收/P1/gzip/3HTTP/demo 维持 pending。
- optional（维持/新增）：PKT_MAX 注释「0xffff - 4」=65531 与值 65524（0xFFF4）不符（receive-pack.ts:20）；git-grants.test 未用 import（mkdtempSync/tmpdir/join，R49 roundtrip 迁移残留；tsconfig 无 noUnusedLocals 不拦）；close-during-arm 分支不 bump gen（fake 手动触发观察项，native 面无影响）；3xx 分支 preparedDispose、R58 元勘误承接维持。

## 6. 元信息与前实例勘误

本轮零行为达成（native read/rg/shasum/cmp/diff+Orca；无解释器/heredoc/sed/awk/cat 读取）。根内 prov-r62.jsonl seq3-8 reviewer 追加；最终一次生成 self-excluding manifest（sha256-root-manifest-r62.txt，不嵌自身），此后根内零写。本报告不含自身 hash。**前实例勘误**：repo 内原 round-7.md（8239B，2026-10-20 14:40:31，卡死实例根 /tmp/grok-r62-HYsyIeHL 所写）曾判「approve-limited（source_ready）」——其 §2 对 git-grants 11 例仅承接旧分类未逐例推演，漏 R-Q62-1；该草稿由本报告覆写替代，以本报告为准；/tmp/grok-r62-HYsyIeHL 仍在盘，处置交 coor。
