# Grok S2 SDK session-pin 第十二审（round-12，R12 SDK 源级隔离重建复证门）：request_changes（仅作者 owned repro.mjs + §17 报告文字）——构建事实独立复证成立：新 owned root 双跑 8/8 逐字节 SAME（GIT_NO_LAZY_FETCH=1 注入），先验/9 blob/两源/patch/emit/strip 全部独立吻合；协调者两项发现均证实（fail() 强制 exit、GIT_ENV 缺 lazy-fetch 禁令），本审另证第三项（脚本不自足：全新 root 首跑必红 ENOENT）；R11 生产隐私门不重开（无已证泄漏）

- **结论**：**request_changes（范围仅限作者 owned `/tmp/perimeter-sdk-isorebuild-vtVfSNbd/repro.mjs` 与报告 §17 文字）**。被审对象是「固定 source（cdaf6c227 九文件 blob）+ 固定 patch（940892b9）→ 逐字节复现 vendor/original 与 vendor/dist 全部 8 产物」这一证明的脚本与报告，不是仓库源码。本审以全新独立 owned root 复现后确认：**该构建事实本身成立**（双跑 8/8 SAME，逐字节），但 §17 所声称的两项保证（「无 lazyfetch」、失败可正常结算）未被脚本实施，且脚本按发布态无法从全新目录复现（缺 `out/cfg` 前置，首跑必红）。三项全部只需改 owned 脚本与报告文字并重跑一轮，不触任何仓库文件。
- 日期：2026-10-17；审查者：grok（唯一 reviewer；Pi 唯一 coder，其派单 task_17881d6e40dd / ctx_9182cec18548 已 settle 并 retain 交付目录；本审 task_c63940afcb60 / ctx_e41f4e13da27）。依据：task_17881d6e40dd 完整 spec（orca dispatch-show preamble 原文全文读毕）+ 作者报告 §17 全文 + round-11 审全文 + 交付目录 `repro.mjs`（420 行完整静审）+ vendor manifest/build.mjs/tsconfig.env.template.json/env-session-pin.patch 只读静审 + 本审独立重建实测。
- 允许写入：本文件、coverage。本审实际写入仅此两文件 + 新 owned `/tmp/grok-s2-r12-review-3bA46p/`（0700）。未触当前 SDK 树/installed deps/vendor/product/tests/dep 锁/作者 report 与交付目录/Paseo/AGENTS/handoff；未 commit/push/worktree/git init/clone/fetch/commit/stash/checkout（git 全部只读：rev-parse/ls-files -s/ls-tree/cat-file/hash-object 无 -w/status --porcelain + owned 非仓目录内 git apply）；未跑原 builder（其步骤 6 会写 vendor/dist+manifest，仅 SHA 先验）；source 未改故未跑 npm check；零 vitest/真 daemon/Docker/health/session-pin/import SDK test/installer/全量/公网模型/npm 生命周期/cargo/npx 安装；未清任何历史资源；未用 pgrep/global-zero/direct-child-exit 证明任何后代或 remote 死亡（本审子进程全部 spawnSync 同步收割 + runner 自然 exit，仅以此为限）；状态机未重开。

## 1. 协调者两项发现的独立分类与核验（均证实；另增第三项）

1. **R-Q12a（证实，required）：`fail()` 仍 `process.exit(4)`**（repro.mjs:159-161）。全局既定禁止强制 exit；成功路径 ：418 自己的注释就写明「不用 process.exit：pipe 下 stdout 异步写，exit 会截断尾部日志」，失败路径却恰好用了。三重后果，本审 run1 红（§2）逐一实证：(i) 管道下尾部输出截断风险真实存在；(ii) 失败原因**完全不进 stderr**——run1 的 runner 日志在 `[repro] tsc Version 5.9.3` 后直接 `[bounded-runner] 执行完毕: exitCode=4`，原因只能在 `evidence/abort.txt` 旁路文件里找到，管道消费者在带内得到的是无理由 exit 4；(iii) catch(:419-421) 再调 `fail(4,…)` 跳过任何正常失败结算（不再写 summary/post 快照等后续步骤）。**修法**：与成功路径同款 `process.exitCode = code` 自然返回 + 失败摘要打印 stderr（raw 原文仍按证据要求只落 evidence 文件）。
2. **R-Q12b（证实，required）：GIT_ENV 缺 `GIT_NO_LAZY_FETCH=1`**（repro.mjs:134-146 有 GIT_OPTIONAL_LOCKS/NO_REPLACE_OBJECTS/TERMINAL_PROMPT/GIT_PAGER/PAGER/CONFIG_NOSYSTEM/CONFIG_GLOBAL/LFS_SKIP_SMUDGE/LC_ALL，唯独没有 lazy-fetch 禁令），而 §17.1 据此声称「无网络、无 lazyfetch」。本机 git 2.54.0 支持该变量（git 二进制内含 `GIT_NO_LAZY_FETCH` 串，已验）。就本机事实链：作者两次运行期间 pi-mono **非 partial clone**（`.git/config` 无 promisor/partialclone，本审只读核验），9 对象可本地解析（cat-file/ls-tree 成功且哈希正确），故**不存在已发生的 fetch**，8/8 结果不受影响；但「保证」与「实施」不一致成立——若对象缺失或仓库配置漂移，脚本自身无法证明不联网。**修法**：GIT_ENV 增补 `GIT_NO_LAZY_FETCH: "1"`（或以 export 注入——本审已实测注入后双跑全绿，证明修复不改变结果），并在 §17.1 将该保证与脚本实际 env 对齐。
3. **R-Q12c（本审新发现，required）：脚本不自足，全新 root 首跑必红**。repro.mjs:336 `writeFileSync(join(ROOT,"out/cfg", …))` 前从未 `mkdirSync` 该目录；本审全新 owned root 第 1 轮即 `ENOENT …/out/cfg/base.json` exit 4（保留于 `evidence-run1-fail/`）。作者侧能跑通是因为其 root 的 `out/cfg` 先于该写入已存在（目录 mtime 与其 run1 同秒 1792247552-553），且交付目录内 `repro.mjs` mtime（1792247589）**晚于 run1 写入 37 秒**——发布脚本与实际首跑非同字节时点，`out/cfg` 前置与脚本修订均未在 §17.2「先完整 read 后 run」叙述中披露。**修法**：脚本补 `mkdirSync(cfgDir,{recursive:true})`；§17.2 如实补记 `out/cfg` 前置与脚本修订时点（时点公平，与 R11 §15.3 同规则）。

## 2. 本审独立复证实测（新 owned root `/tmp/grok-s2-r12-review-3bA46p/`，0700；`mkdtemp` 语义；作者 root/结果零接触零覆盖）

| 轮 | 结果 | raw（runner 原始日志行） |
|---|---|---|
| run1（全新 root 原样发布脚本） | **exit 4 红**（R-Q12c 实证；原因仅见 abort.txt） | `node scripts/bounded-test-runner.ts --timeout 45s node <ROOT>/repro.mjs`；PGID 73651；runner 264ms；`grok-runner-run1-FAIL.log` + `evidence-run1-fail/{events-run1.jsonl, abort-run1.txt, snapshot-pre-run1.json, base-sources-run1.json, patched-sources-run1.json}` |
| run2（审者补 `mkdir -p out/cfg` 后；`GIT_NO_LAZY_FETCH=1` export 注入，经脚本 GIT_ENV `...process.env` 生效） | **8/8 SAME，exit 0** | 同式；PGID 75809；runner 1236ms / 脚本 wall 1199ms；`grok-runner-run2.log` + `evidence-g1/`（快照+events 22 children） |
| run3（同条件第二跑） | **8/8 SAME，exit 0** | 同式；PGID 76356；runner 1238ms / 脚本 wall 1199ms；`grok-runner-run3.log` + `evidence/` |

- 双跑一致性：`acceptance` 与 `blobProvenance` 两 JSON 逐字段相等；`snapshot-pre/post` 去掉 `at` 时间戳后逐字段相等；每轮有界子进程恰 22 个（argv/cwd/timeout/pid/status/wall 全录 events.jsonl，33 行/轮）；全部 child wall ≤473ms（预算每 git ≤5s、每 tsc ≤15s、整轮 45s 预死线，余量 >95%）。
- 逐字节独立验收（本审 `cmp -s`+`shasum -a 256`，不信脚本自报，`grok-acceptance.txt`）：base 4/4 = vendor/original = manifest.original（a11354ee/b3d31de4/7a0c63f6/21afc6ff）；patched strip 后 4/4 = vendor/dist = manifest.patched（d59a1c09/5ba868c9/13394770/6333328d）；installed dist 4/4 = 本审 patched emit。strip 计数 base 4×1 → patched 4×0（正则与 build.mjs 步骤 5 逐字一致，build.mjs 仅静读未执行）；每侧 emit 24 文件 + cfg 2 = out 内 50 文件全部 owned，**零 tsbuildinfo**，map 全在 root 内。
- 新增交叉验证（作者未做）：patched 两源 `git hash-object`（无 -w）= `3ae9f69b187c9d1a4bc8803656ffbf1df0989541` / `776928625430004ca31c67988062d1685fdc0d17`，与 patch 头 index 后像 `3ae9f69b1`/`776928625` 吻合——patch 结果与 patch 头自洽。
- 先验固定全复验：patch `940892b9…`、manifest `0b87934f…`、builder `4075300…`（=任务先验=manifest.patchFileSha256）；template `dd3fd94f…`（记录项）；full commit `cdaf6c227` → `cdaf6c227d4718a72b59ccd02152c9614df44cfc`（本审独立 rev-parse，非当前 HEAD 替代；当前 HEAD `8efd314fa3d3232ce197d8d7a6a5660530b9d83e` 为外部漂移只记录不归因）；本审独立 `ls-tree` 恰 9 条目，blob 与 §17.1 表逐一致（4449172b/427d284a/5a15148f/9bfe18df/52092c1d/0a79bda8/d9df60de/57bec30d/40286989）；base 两源 = manifest.sourceBaseHashes（740c6e34/06bba09b）；patched 两源 = manifest.base.sources（7e1f77dd/373019b5）；TypeScript 5.9.3（perimeter node_modules，tsc --version 与 package.json 双验）。
- 作者 evidence 只读交叉核验：summary.json/summary-run1.json 均 8/8 SAME、wall 1241/1208ms、children 22、events 66 行、PRE head==POST head——与 §17.2/17.3 记录相符；本审红/绿双结果与其数字无矛盾。

## 3. 持久边界评估（协调者问句）：R11 生产隐私门**不重开**

- repro.mjs 的原始持久面：`bounded()` 失败时完整 stdout/stderr 落 `evidence/child-N-{out,err}.log`，Error.message 携 stderr 400 字符切片，catch→`fail()` 把 message+stack（2000 切片）写 `abort.txt` 与 events.jsonl——**全部只存在于 owned 0700 /tmp evidence**，且派单明确要求「保留全部失败原始日志/argv/PGID counts/exit/wall/中间源与产物」，该保留本身即合规。
- 本轮子进程集合仅本地 git（rev-parse/ls-tree/cat-file/apply）/tsc/ps，git config 已净化（NOSYSTEM+GLOBAL=/dev/null），脚本零 env/history/凭据读取；无已证泄漏，本审不虚构任何 token 泄漏。R11 建立的「生产 ledger/报告通道固定类别化」门管辖生产代码与仓库文档，repro.mjs 是仓外 owned 证据工具，**不构成重开条件**。
- 非阻塞建议：下版脚本 throw 固定类别 message、raw 字节只落 child-*.log，与 R11 纪律对齐（R-Q12a 修法已覆盖其主要面）。

## 4. 前后只读快照：外部树零漂移

- PRE（14:45:06Z）== POST（14:48 前后）：pi-mono 工作树两源 `99f27fffffe75e75`/`21b96cd2c7ecb890`、`test/session-pin.test.ts 7d81a8a465ebfb7c`（7288B/0644）、HEAD `8efd314fa…`、index 文件 `23eeb4b9…`、两源 index 条目 `484e7662`/`c77ce201`；perimeter HEAD `b354ffe`、index 文件 `407ad9b8…`、`tests/session-pin.test.ts aefcd68dcad0c7ce`、runner `23966148ad84b4a7`、`pi-env-patch.ts f7ebe0cedbfb24a8`；vendor 18 文件（manifest/builder/template/patch/dist×4/original×4/previous×5）；installed dist×4+typescript package.json——逐项前后一致（`grok-pre.txt` vs `grok-post.txt` diff 为空）。
- 本审执行偏差（如实，与作者代码无关）：①macOS 无 `mkdtemp` 命令，用 `mktemp -d`+`chmod 700` 等价；②基线 git 段首版误用 `env $GE`（zsh 不做分词，守卫未逐项生效）——即用逐变量 export 重做（`grok-git-corrected.txt`），数值与首版全同，两版文件均保留；正式复现管道不受影响（脚本内 JS 对象字面量 env + shell export 直接生效）。

## 5. 边界声明（本 request_changes 与 8/8 复证 ≠ 更多）

- 已证：仅「固定 source（cdaf 9 blob）+ 固定 patch（940892b9）+ TS 5.9.3 同 template → 8 产物逐字节可复现（双跑一致）」，且本审注入 GIT_NO_LAZY_FETCH=1 后结果不变。
- 仍未证、仍 blocked：SDK 定向 5 行为门（原 SDK session-pin.test.ts 真实 daemon 测试**未跑且绝不可跑/导入**——其 import `./daemon.ts` 真实启动/kill/shell sentinel，非 purefake；「5 未跑 + 当时当前源 5 fail」状态原样保留）；真实兼容性；G1 全部 3 秒预算；30s 静默窗口/无响应 CANCEL/G3 lost；S2 企业接受；本构建 4/4 是产物字节复现，与 SDK 行为 5/5 无关。真实行为复验待单独授权。
- 整仓历史资源 unknown 状态不重开、不归属；本轮未授权任何新增源码修，request_changes 落点仅 owned repro.mjs 与 §17 文字。

## 6. 证据保留（本审 root，不删）

`/tmp/grok-s2-r12-review-3bA46p/`：`repro.mjs`（交付目录字节拷贝，双侧 SHA-256 `2fcb28089174b82e…` 相等，`repro-copy-sha.txt`）、`grok-pre.txt`/`grok-post.txt`/`grok-git-corrected.txt`/`grok-acceptance.txt`/`grok-precondition-note.txt`、三份 runner 原始日志（run1 FAIL/run2/run3，含 PGID 与 argv 行）、`evidence-run1-fail/`（红轮全套）、`evidence-g1/`（run2 快照+events）、`evidence/`（run3 全套：summary/acceptance/snapshot/events/base-patched-sources/emitted）、`out/{base,patched}/dist`（24 emit）+`out/cfg`（2 cfg）、`base/`+`patched/`（materialize 源）。作者交付目录 `/tmp/perimeter-sdk-isorebuild-vtVfSNbd/` 只读未触。
