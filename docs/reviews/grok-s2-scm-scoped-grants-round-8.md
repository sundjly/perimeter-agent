# grok-s2-scm-scoped-grants-round-8.md — Pi R63 修复轮增量静态独审（Grok R64；task_b869db497d22 / ctx_f117ff505e05）

- 日期：2026-10-20；审者：Grok（复用 R62 同一 term_2769b867-ffd0-4a48-818f-70bf4e6cb8b1）。被审对象：Pi R63（只改 tests/git-grants.test.ts 例 8=R-Q62-1 修法 B + 新增 r63doc；Pi 根 /tmp/pi-r63-ZXuHpvX3 coor 封版：manifest self=390afac39bde46f3f35fdad9fabf2706f84746c7e7e29823fdc55a14c0a466c4 本轮亲核相符）+ 对照 R62 round-7（c98e3de3/self 142e9633）全文。
- **性质：静态 only（零行为）**——仅 native read/rg/shasum/cmp/diff/FS metadata+Orca；零解释器/heredoc/sed/awk/cat 读取/编译测试/网络/Git/Docker；modelgw 仅 hash 不读；runner 6f4e2b0f 冻结未动。**本轮唯一 repo 写入=本文件**；reviewer 根=/tmp/grok-r64-ZioxYaT4（0700；coor seq1/2 不可改，reviewer 追加 seq3+；最终一次 self-excluding manifest，此后根内零写）。typecheck/tests=**unrun/unknown**。
- **判定：approve（source_ready）——R-Q62-1 闭合（修法 B 落地且强于处方）；其余 63 例与 driver 26271b07 逐项维持成立；改动面恰 1 drift+2 新增，零超范围**。B2=partial；S2=partial。

## 0. 封版与基线（全过）

- snapshot 48 件 frozen 重算 **48/48 MATCH**；48/48 cmp 当前工作区字节一致。driver（author-driver-r61.mjs）SHA=26271b07 与 R62 相符，未变未运行。
- 对 R62 根 /tmp/grok-r62-3e1SPspZ（46 件）逐件 cmp：恰 **1 件 drift=tests/git-grants.test.ts** + **2 件新增**=docs/reviews/grok-s2-scm-scoped-grants-round-7.md（R62 本轮产物）+ docs/implementation/s2-b2-scoped-grants-r63.md，零删除——与 R63 声称改动面精确一致，生产代码/progress/driver 零改动。
- git-grants.test.ts 内部 diff：**唯一 hunk 107,113c107,112**=例 8 替换，其余 10 例逐字节未动；`rg '^test(' ` 计数仍 11；verifyGrant 等既有 import 引用面无损。

## 1. R-Q62-1 闭合判定（推演过）

修后例 8（:107-112）：`assert.throws(() => signGrant(claims({caps:{read:true,write:true,writeRefs:["not-a-ref!!longpayload..."]}}), MASTER, NOW), (e) => e instanceof Error && e.message === "caps.writeRefs 非法（固定类别，不透传原文）" && !e.message.includes("not-a-ref"))`。

- 推演：validateClaims（grants.ts:102-107）对非法 writeRefs 同步 throw GrantError（全串恰等于断言串；其前置形状校验全部通过，无更早 throw 可能）→ validator 三条件全真 → assert.throws 通过，**静态绿**。
- 语义面：修法 B 落地且**强于 R62 §3 处方**（全串 `===` 相等替代正则，杜绝宽泛匹配掩盖 wrong reason）；「不含原文」断言以 `!includes("not-a-ref")` 保留；注释如实记录共尺不可先签后验的根因。verify-catch→reason 分支的失覆盖由注释显式声明（R62 §3 已预告，如实）。
- 对照 r63doc：范围/计数/零改动声明与实际字节逐一相符。

## 2. 其余 63 例与 driver 维持成立

- 其余 8 suite（53 例）与 git-grants 其余 10 例：字节与 R62 冻结态一致（cmp 证据），R62 §3 推演逐项**原样维持**。
- driver-candidate-r61.mjs：SHA 未变（26271b07），R62 §4 七项静态准入**原样维持**；EXPECTED=64 与修后 64 例计数一致，**无需改动**。

## 3. 三态与执行准入前置项

- **source**：R-Q62-1 闭合；R58–R62 required 链全闭；本轮零生产代码改动。
- **static eligibility**：**READY=9 suites 64 例**（git-grants 11 修后全数转入）；NOT ready 维持=wiring/gitproxy.test/git-e2e/git-grants-integration、r47cases（standalone 9s 另批）；driver=静态合格（26271b07，执行面 unknown）。
- **execution**：全部 unrun/unknown；本轮零执行。
- **执行前 coor 仍须做（本 approve 不含执行授权）**：①driver 终审可直接依 R62 §4 结论（26271b07 未变，无需重审）并明示执行授权；②预置 R61_RUN_ROOT fresh 独立 0700 执行根（repo 代码与证据分离）；③**真实父 shell wait 与 wall/exit 采集协议批文**；④执行轮首步 `npm run typecheck`（unrun 口径收口）再经 driver 跑 64 unit（isolation:none、9s guard）；⑤「review 通过后 coor commit 代码（不含 md）」的用户授权前提已满足——commit 范围以 coor 台账实际未 commit 的代码 drift 为准（Git 面 coor 操作，本轮未查）；⑥64 全绿后 17 真实验收/P1/gzip/3HTTP/demo 按既定闸门推进（仍 pending）。
- optional（维持未动）：PKT_MAX 注释「0xffff - 4」与值 0xFFF4 不符（receive-pack.ts:20）；git-grants.test 未用 import（mkdtempSync/tmpdir/join；tsconfig 无 noUnusedLocals 不拦）；close-during-arm 不 bump gen 观察项；3xx 分支 preparedDispose；R58 元勘误承接。
- **R63 事故承接（如实）**：首次分派因 pi 终端把前言折叠成粘贴占位符而未见任务（coor prov seq3：bad_dispatch ctx_02a7e4df21be，stop unknown），Pi 期间仅跑只读 find/ls 探查（no_writes_observed，native read 在权限内，非违规）；重派后完成。卡死实例根 /tmp/grok-r62-HYsyIeHL 维持未处置（R62 §6 交 coor）。

## 4. 元信息

本轮零行为达成（native read/rg/shasum/cmp/diff+Orca；无解释器/heredoc/sed/awk/cat 读取）。根内 prov-r64.jsonl seq3-5 reviewer 追加；最终一次生成 self-excluding manifest（sha256-root-manifest-r64.txt，不嵌自身），此后根内零写。本报告不含自身 hash。
