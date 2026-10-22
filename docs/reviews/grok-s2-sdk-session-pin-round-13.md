# Grok S2 SDK session-pin 第十三审（round-13，R-Q12a/b/c 修复验证门）：approve（微门，仅限本修复包）——v2.1 脚本三项 required 全落地独立复证：零 `process.exit` 自然结算 + 固定类别 stderr + failure.json、GIT_ENV 显式 `GIT_NO_LAZY_FETCH="1"`、脚本自足（全新 root 仅脚本即 8/8）；fresh 负控单字符改错 EXPECT.manifestSha256 预期红真实 runner exit 4；正控 8/8 逐字节=vendor/manifest 独立 cmp 复证；全量子进程台账 23=22 git/node+1 ps 误称已修

- **结论**：**approve（微门，仅限 R-Q12a/b/c 修复包：v2.1 owned 复现脚本 + §17 原位更正/公平补记 + progress）**。round-12 三项 required 全部按语义落地，本审以两个全新 mkdtemp 0700 root（各自仅含脚本一个文件起步）独立复证：正控 true-fresh 编译 **8/8 逐字节 SAME（exit 0）**，负控 fixed-hash guard **预期红真实 exit 4**（不冒 0）。R12 红轮证据与条件修正后绿轮全部原样保留；「固定 source+patch → 8 产物逐字节」事实不撤销也不重开；R11 生产隐私门不重开（无已证泄漏，raw 仅私有 evidence）。
- 日期：2026-10-17；审查者：grok（唯一 reviewer；Pi 唯一 coder，其派单 task_012a34506c5f / ctx_6fc88bf7319c 已完成；本审 task_ba3a5cc1ccb3 / ctx_eb1f577cd2c1）。依据：task_012a34506c5f 完整 spec（dispatch-show preamble 全文）+ round-12 审全文 + 修正后 §17（§17.1 R-Q12b 口径、v1 时点公平补记、§17.6 全节）+ v2.1 脚本 504 行完整静审 + 作者正/负 root 原始日志与 evidence 只读核验 + 本审双 fresh root 实测。
- 允许写入：本文件、coverage、本审自有 mktemp root。实际写入仅此。作者 root `/tmp/perimeter-sdk-isorebuild-vtVfSNbd`、本审 R12 root `/tmp/grok-s2-r12-review-3bA46p`、作者新交付 `…r12-m4cMpYUE`/`…r12-neg-xgztXCcT` 全部冻结只读未触。原 SDK/node_modules/vendor/runtime/product/tests/dep 锁/installer/builder/index/refs/config/Paseo/handoff/AGENTS 零写入；无 git init/worktree/clone/fetch/stash/commit/check、无 npm 生命周期/全量/网络模型/cargo/npx、无 SDK vitest/SDK test import/定向 5/真 daemon/Docker/health/session-pin/资源 cleanup；真实 manifest/source/userenv 零更改（负控只改本审自己拷贝内的一个字符）。未用 pgrep/global-zero/direct-child-exit 证明任何后代/remote 死亡。

## 1. 三项 required 逐项独立复证 ✓

1. **R-Q12a（零强制 exit；自然非 0 结算）**：v2.1 全文 `process.exit(` 命中 **0**（仅 ：442/:472/:500 三处 `process.exitCode` 赋值）；唯一失败入口 `fail()`＝同步写 `evidence/failure.json`（固定类别+安全字段：code/category/wallMs/children/expected/actual/路径）→ 抛 `FixedAbortError`（message 仅 `category/code/evidence` 路径）→ 顶层自然捕获 → stderr 仅 `[repro] ABORT category=… code=… evidence=…` → `process.exitCode` 自然结束，主流程中断不继续；raw stack 只落私有 `failure-raw-context.log`/`failure-unhandled.log`，`child-N-{out,err}.log` 收 raw 子进程输出；验收 DIFF 走同款 code=3 `acceptance_diff`（先写 post 快照+failure.json 再返回）；readonlySnapshot 三处 catch 对 FixedAbortError 穿透不吞。**本审负控全链路实测**：runner 原始 exit **4**（43ms，PGID 29136），runner 日志带内仅固定行，零 raw stderr/error/stack 入 runner/reporter/repo；`failure.json` 完整（`expectedInScript=…cd07` vs `actualComputed=…cd06`=真实 manifest，真实文件逐字节未动）。预期红如实记红，无任何冒 0。
2. **R-Q12b（显式 lazyfetch 禁令）**：GIT_ENV :174 `GIT_NO_LAZY_FETCH: "1"`，其余只读守卫（OPTIONAL_LOCKS=0/NO_REPLACE_OBJECTS/TERMINAL_PROMPT/PAGER/CONFIG_NOSYSTEM/CONFIG_GLOBAL/LFS_SKIP_SMUDGE/LC_ALL）全保留；`summary.gitEnv` 字段固化记录；§17.1 已对齐口径（显式禁 lazyfetch＋「对象本地命中」两回事，不以本地命中声称自动禁网）。
3. **R-Q12c（脚本自足）**：main 首步 ：262 自建 `evidence/base/patched/out/out/cfg` 全部目录。**本审正控 root 运行前仅含 `repro.mjs` 一个文件**（脚本拷贝 SHA `47c6b1de…`=作者 v2.1 终态），跑出 8/8；负控 root 同样仅脚本起步、失败链路自足写出 evidence。零手工 mkdir、零上一轮残留依赖。

## 2. 本审独立实测（两个全新 mkdtemp 0700 root；既有 bounded runner；45s 整轮/git 5s/tsc 15s）

| 控 | root（起步内容） | 结果 | raw |
|---|---|---|---|
| 正控 | `/tmp/grok-s2-r13-pos-KUdnEl`（仅脚本） | **8/8 SAME，runner exit 0**；脚本 wall 1236ms/runner 1274ms；children 台账 **23**＝22 git/node bounded＋1 ps（`role=ownPgid-ps-query`，已入同一账）；tsc Version 5.9.3；out 50 文件（24+24 emit+2 cfg）、**0 tsbuildinfo**、全部 owned；无 failure.json（正控无失败，符合预期） | `node scripts/bounded-test-runner.ts --timeout 45s node <ROOT>/repro.mjs`；PGID 28777；`grok-runner-pos.log` |
| 负控 | `/tmp/grok-s2-r13-neg-YFAart`（仅脚本，`EXPECT.manifestSha256` 尾字符 `6→7` 单字符改错，拷贝 SHA `eb534765…`，与原版 diff 恰 1 行 1 字符） | **预期红：runner exit 4 真实**；脚本 wall 6ms/runner 43ms；children 1（ps）——任何 git/tsc 前拒绝；fixed-hash guard 早期固定类别 `manifest_sha_mismatch` 自然结算 | 同式；PGID 29136；`grok-runner-neg.log`＋`evidence/{failure.json, failure-raw-context.log, events.jsonl}` |

- **逐字节独立验收（cmp -s，不只信 selfreport）**：正控 base 4/4＝vendor/original＝manifest.original（a11354ee/b3d31de4/7a0c63f6/21afc6ff）；patched strip 后 4/4＝vendor/dist＝manifest.patched（d59a1c09/5ba868c9/13394770/6333328d）；installed dist 4/4＝正控 emit。strip base 4×1→patched 4×0。fixedCommit `cdaf6c227d4718a72b59ccd02152c9614df44cfc`（PRE 快照内复核）。
- **作者交付只读交叉核验**：正 root `repro.mjs` SHA=`47c6b1de…`（=repro-v2-sha.txt v2.1 终态；v2 首轮 `e6ff084f…` 两代均在录）；负 root 拷贝 `09f54c6b…` 与 §17.6.3 一致、与原版 diff 恰 1 行 1 字符（首字符 0→1，与本审尾字符 6→7 为不同损坏点，各自独立成立）；作者正控 run1/run2 均 8/8 exit 0（1236/1217ms），负控 run1/run2 均 exit 4（44/48ms，`expectedInScript=1b87934f…`）；作者 summary children=23（v2.1 口径）。
- **PRE==POST**：本审前后只读快照归一化后逐行一致——pi-mono 工作树两源 `99f27fff…`/`21b96cd2…`、`test/session-pin.test.ts 7d81a8a4…`（7288B/0644）、HEAD `8efd314fa…`、index 文件与两源条目；perimeter HEAD `b354ffe`、index 文件、`tests/session-pin.test.ts aefcd68d…`、runner `23966148…`、`pi-env-patch.ts f7ebe0ce…`；vendor 14 文件；installed 5 文件。外部树零漂移。
- **报告公平性核验**：§17.6 如实披露 v2→v2.1 澄清微修（ownPgid ps 纳入台账，仅计数不触构建/验收）且两代 SHA 均在录；v1 时点补记（`out/cfg` 手工前置、run1 后 wall 元数据管道原位修订、**首轮 SHA 未存只能记 unknown、不以 mtime 单独断言逐字节差**、旧 root 与 grok R12 root 全冻、8/8 事实不撤销）与 §17.1 lazyfetch 口径更正均已实改可核。R12 红（grok run1 ENOENT）与条件修正后绿原样保留。

## 3. 边界声明（本 approve ≠ 更多）

- 已证范围：v2.1 脚本按 R-Q12a/b/c 语义自足运行；固定 source（cdaf 9 blob）+固定 patch（940892b9）+TS 5.9.3 同 template → 8 产物逐字节复现（作者双跑+本审正控三重成立）；fixed-hash guard 负控按预期拒绝（作者双跑+本审一跑）。
- 不构成：SDK 定向 5 行为门（未跑、不可跑不可导入；「5 未跑+当时当前源 5 fail」保留）；构建 4+4 ≠ behavior 5/5；真实兼容性；G1 全部 3 秒预算；30s 静默窗口/无响应 CANCEL/G3 lost；S2 企业接受。真实验证待单独授权。
- R11 生产隐私门不重开：负控 `failure-raw-context.log` 等私有 owned 0700 evidence 的保留即审12认定的合规范围；无已证泄漏，不虚构；本轮仅改善 runner/report 固定诊断通道。
- 子进程口径更正生效：「22 有界子进程」旧表述系 22 git/node 记录+1 ps 未计；v2.1 起全量子进程同一台账（本审实测 23），本审报告不再使用全量误称。

## 4. 证据保留（本审 root，不删）

`/tmp/grok-s2-r13-pos-KUdnEl/`：`repro.mjs`（v2.1 字节拷贝）、`grok-copy-sha.txt`、`grok-pre.txt`/`grok-post.txt`（PRE==POST）、`grok-runner-pos.log`（PGID 28777）、`grok-acceptance.txt`、`evidence/` 全套（summary/acceptance/snapshot-pre+post/base-patched-sources/emitted-×/events.jsonl 23 children）；`out/{base,patched}/dist`+`out/cfg`。`/tmp/grok-s2-r13-neg-YFAart/`：损坏单字符拷贝（`eb534765…`）、`grok-copy-sha.txt`、`grok-pre.txt`、`grok-runner-neg.log`（PGID 29136，exit 4）、`evidence/{events.jsonl, failure.json, failure-raw-context.log}`。作者四 root 一律只读未触。
