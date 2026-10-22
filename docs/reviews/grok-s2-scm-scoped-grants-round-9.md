# grok-s2-scm-scoped-grants-round-9.md — R65 首次真实执行修复轮增量复审（Grok R66；task_c5c55d39010a / ctx_a1de2648ccec）

- 日期：2026-10-21；审者：Grok（term_2769b867…，R62/R64 同一 reviewer）。被审对象：R65 用户授权首次真实执行的修复面——typecheck 四轮（typecheck.log 语法级→typecheck2.log 语义级 15 行→typecheck3/4 空=成功签名，最终 exit0 采 coor 记录+空日志签名）+ driver 两版迭代 + git-grants 例 26 断言修正。**本轮只读审查（native read/rg/shasum/stat+Orca），未运行任何东西**；证据根 /tmp/perimeter-exec-r65-DjXmkXXI 未写。唯一 repo 写=本文件。
- **判定：approve——R65 修复正确、最小、无行为回归；driver-r65.mjs（SHA 451be8d1708e03cf3c63c8d52343c1ce536672959a0df1cd5348004323886fe1 亲核相符）仍满足准入；执行证据（typecheck exit0 + TAP tests64/pass64/fail0/cancelled0/skipped0/todo0）接受**。

## 0. 证据链核验（全过）

- run1.stderr=「r61 driver setup/pipeline error（fixed category）」=候选 driver（driver.mjs=26271b07 亲核）`fsP.mkdir` TypeError 现场；run2+solo-git-grants.log=例 26 `assert.throws` validator 失败栈（tests/git-grants.test.ts:109）；run3=ref guard 拖住 isolation:none 收尾 →9s exit 124；run4=TAP `1..64`（pass64/fail0/cancelled0/skipped0/todo0，duration 78ms，`ok 26 - grant 验证失败…` 在案）。
- mtime 时序：git-grants.test.ts（最后修复件，=driver-r65.mjs 时刻）早于 tap-r65.log——**绿跑后五处改动文件零再编辑**，工作区即被测状态。
- diff（r65-code.diff，相对 commit fc4fb97，153 行）与 typecheck2.log 错误清单逐项对应（TS2565×2/TS2322×3/TS2551×6/TS2304×2/TS2345/TS2322×2）。

## 1. 代码修复逐项判定（正确 ✓ 最小 ✓ 无回归 ✓）

| # | 修复 | 判定 |
|---|---|---|
| ① #audit 前移（gateway :357，老位 :411 删） | 修 TS2565@:392/:402（gitGrants 恢复块固定审计先于旧赋值位）；`AuditLog.open` 仅依赖 cfg.auditFile，无构造次序 hazard；open 失败=ctor 同类失败仅更早 | ✓ |
| ② clearTimeoutImpl 包装（gateway :683） | 修 TS2322（config `(timer: Timeout)=>void` 对 `(timer: unknown)=>void` 逆变不可赋值）；运行时等价——同 impl 同值，外层仅类型断言 | ✓ |
| ③ limits 5 字段重命名（gitproxy :719/:755/:762/:819/:820/:835） | 修 TS2551×6；接口（:77-81）/默认（:108-112：10s/8MiB/128MiB/512MiB/120s）/硬上限（:101-105：60s/64MiB/1GiB/4GiB/600s）三处与 R55-D 文档注释逐字段一致。**实质效果=修复 `undefined→NaN→比较恒 false` 的 limits 静默旁路**（零窗 408、decoded/raw 上限此前全部失效），恢复为真实执行——正向非回归。gzip 泵 `compressedBytes > maxRawBodyBytes`（:762）为既存（曾死）意图恢复：压缩线缆字节受 raw 128MiB 封顶，保守向，如实记录 | ✓ |
| ④ DeadlineError 导入（gitproxy :15） | 修 TS2304@:860/:917（`e instanceof DeadlineError`） | ✓ |
| ⑤ #handle 闭括号（gitproxy :654） | 修 TS1005 级联（typecheck.log :656-:709）；单行 | ✓ |
| ⑥ settle 包装（bounded-reader.test :50） | 修 TS2345（Uint8Array 未包 DeadlineReadResult 形状）；现有调用恒零参，运行时不变 | ✓ |
| ⑦ chunkReader `canceled: boolean`（receive-pack.test :123） | 修 TS2322（getter 返回 boolean 对声明 `()=>boolean`）；测试用属性访问 `r.canceled`，运行时不变 | ✓ |
| ⑧ claims 补 `aclVersion: 1`（git-grants.test :36） | 修 TS2322（GrantClaims A6 必填）；对齐 validateClaims 与 grant-rotation.test claimsOf 既有形态 | ✓ |
| ⑨ 例 26 改 `e instanceof GrantError && e.reason === 全串`（:112，+GrantError 导入） | grants.ts:51 `super(\`git grant 拒绝: ${reason}\`)`——message 带前缀，固定类别在 `.reason`；改比较 reason 正确，`!e.message.includes("not-a-ref")` 保留（prefix+reason 均无原文） | ✓ |

## 2. driver-r65.mjs 准入复核（四 delta，清单仍全过）

- delta：①`import("node:fs/promises")` 供 mkdir（修候选 fsP=node:stream/promises 误绑）；②catch stderr=固定前缀+`err?.name`（仅类名，无 message/堆栈，隐私收敛 ✓）；③env R65_RUN_ROOT、目录/日志 r65-driver/tap-r65.log；④`guard.unref()`（:15）。
- R62 §4 准入清单逐项复核仍成立：guard 自 T0 绝对 9s 先于全部动态 imports；lstat 精检（0700/uid/非 symlink）；mkdir recursive:false EEXIST 判负；log wx 0600+once("error")；EXPECTED=64 严格 summary 判负；fresh wall 在 pipeline+log close 后、guard 于最终证据后清。
- **unref 后 9s 有效性**：有活句柄的挂起（真实挂起形态）→ 循环存活 → guard 9s 照常触发 exit 124 ✓；空循环未决 await 形态 → Node 自然退出码 13（非零）→ fail-closed 红 ✓；成功路径 clear 后立即 exit，unref 无关 ✓。run3(124)/run4(0.12s green) 双向实证。

## 3. 审者勘误（如实；三者均由 R65 真实执行首次暴露）

- R62 §4 漏检候选 driver `fsP` 实绑 node:stream/promises 却调 `mkdir`（必 TypeError）——静态准入清单未核解构绑定。
- R62 §3 漏检 git-grants.test `claims()` 缺 `aclVersion`（validateClaims A6 必填）——例 1/2/3/5 sign 期必抛，非当时所判「10 绿+例 8 红」。
- R64 未察觉 GrantError.message 带「git grant 拒绝: 」前缀、固定类别在 `.reason`——例 26 全串相等断言必红，仍判闭合。
- 结论如实记录：静态推演对「跨文件类型契约/运行时字段前缀」类缺陷有盲区，真实执行是必要闸门——R65 执行面证据价值实证。

## 4. 三态与后续

- **source**：R65 修复接受（§1）；R58–R65 required 链闭合。
- **static eligibility**：9 suites 64 例 READY + driver-r65 准入（§2）。
- **execution**：typecheck exit0 + 64/64（R65，用户授权）已在案；**17 项真实验收/P1/真实 gzip push/3HTTP/demo 维持 pending**，按既定闸门另批。
- 后续 coor：①commit R65 修复代码（用户既有授权，Git 面 coor 操作）；②推进 17 项验收批。optional 维持：PKT_MAX 注释、git-grants 未用 import、close-during-arm 观察项、3xx dispose、R58 元勘误。

## 5. 元信息

本轮零行为达成（native read/rg/shasum/stat+Orca；未运行任何测试/编译/解释器；Git 未触）。证据根 /tmp/perimeter-exec-r65-DjXmkXXI 只读未写；exit code 与 wall 0.12s 采 coor 在案记录（本轮未复跑验证，工件一致性已核）。本报告不含自身 hash。
