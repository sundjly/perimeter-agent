# Grok S2 四眼审批第四审（探针改造补验）

- 结论：`approve`（限定探针改造补验：协调者四项硬性要求全部实证成立，R2 的 unverified 门槛关闭，`s2-four-eyes` 维持 implemented。真实模型/CNI/客户批准仍 external，S2 整体与企业生产不批准）
- 日期：2026-10-15
- 审查者：grok（唯一 reviewer；Pi 唯一 coder）
- 对象：`scripts/probes/four-eyes-standalone.ts` `b25db1168d08b714`（探针改造；产品/测试零改动——`approvals.ts` `8307708ff8222371` 与 R2 一致未变）。基线是 `docs/reviews/grok-s2-four-eyes-round-2.md`（含 round-3 纠正节）。
- 允许写入：`docs/reviews/grok-s2-four-eyes-round-4.md`、`docs/reviews/grok-s2-four-eyes-round-2.md`（最小更正）与 `docs/reviews/handoff-coverage.json`。未改实现、测试、其它 docs、handoff、SDK，未 commit / push / spawn 新 worker。

## 协调者四项硬验收的独立实证

1. **默认无 preflight、可独立运行各场景**：两次全新 OS 进程 `--scenario all`（无 `--preflight`）——`probe-start` 记录 `preflightEnabled:false`，无 preflight 阶段，三场景（ng 650/610ms、git 1085/1078ms、ctx 1135/1023ms）全过，exit 0 自然退出。
2. **process.exit 全部移除**：库内仅 `process.exitCode = N` + 自然 return（事件循环排空后进程退出）；两轮 clean run 均 exit 0 自然。退出码契约：0=全过且 own 清理逐 ID 确认；1=场景失败；2=policy 预检失败；3=用法错误；4=own 清理未确认。
3. **受控清理故障注入**：`--inject-cleanup-fault` → 跳过一个 own 容器清理 → 精确 ID `6fbfefdc2405` 记入 `pendingReconcile`，ng 场景 `confirmed:false`，**exit 4 非 0**（scenario allPassed 仅代表 oracle，退出码以清理未确认为准）。该容器随后经 `--rm` 语义自清，manifest 如实留存账目供对账。
4. **未知场景**：`--scenario bogus` → exit 3。
5. **父链与历史容器不受影响**：三轮全程 3 个历史 owned 容器（13:56–14:01 登记）原样未动；我的调用 shell/父进程无恙。
6. **deadline 覆盖**：每条 docker/git 子命令 10s 自身死线（`sh()` 统一 `execFileSync timeout`）；每次探针调用外层以已批准 bounded runner 预挂 180s 死线；三轮全部自然退出，未触发外层强杀。

## 行为复验汇总（两次全新 OS 进程无 preflight）

| 轮 | ng（git-less 拒） | git（真 HEAD + 独立 B allow） | ctx（上下文丢失拒） | exit | labeled 容器（后） |
|---|---|---|---|---|---|
| 清洁 1 | policy.denied + 零 approval 事件 + 不落盘 | B allow → 落盘 | decide 拒 + 不落盘 | 0 | 3 |
| 清洁 2 | 同上 | 同上 | 同上 | 0 | 3 |

- 两次全新进程互不借力（各自新建 gateway/容器/git fixture），无 preflight、无全量预热借用；重复运行仍稳定拒绝/批准，符合「重复运行不能借先前预热」。
- `session.ready` 仅作必要前置，各场景 oracle 以 policy.denied/审批事件/落盘/审计为准。

## 全量与静态口径（本轮）

- 产品/测试零改动（`approvals.ts` `8307708ff8222371` 未变）→ **r20 的 439×2（serial 185s / bounded 130s，439/439/0 skipped 0）作为历史证据保留**，不重跑不冒充本轮。
- 本轮新鲜静态/专项：`tests/four-eyes.test.ts` 直跑 **12/12 pass, skipped 0**；`npm run typecheck` 0；`git diff --check` 0。
- 资源：三轮探针 own 容器逐一清理并核验（fault 轮的 skipped ID 记入 pendingReconcile，容器经 `--rm` 自清）；历史 3 个 owned 容器（13:56–14:01）保留登记；无 `node --test`/mock-model 残留。

## 旧 240s 挂起根因

仍 **unknown**（fe4 实物已删，Pi 报告 §2 的残迹分析即现存全部）；不声称「唯一无界 await 已证伪所有冷启动问题」。`openEnvironment` 握手加有界超时仍为合理的加固建议（非已证缺陷）。

## 台账与边界

- `s2-four-eyes`：维持 `implemented`（R2 的 unverified 门槛以本轮合规探针关闭；standalone 证据链补全）。
- S2 其余 DLP/repo-token/敏感路径/symlink/本地 egress 保持 missing/partial；真实 CNI/客户批准 external；S3/S4 按依赖；企业生产不批准。下一批按依赖推进 S2 剩余项或 S3。

## 补充核验（coordinator 跟进，2026-10-15）

**【状态更正，2026-10-15 第五轮】** 本节第 2 条的摘要字段失真（stdout/manifest `exitCode:0` 与真实 exit 4 不一致、`naturalExit` 预写）当时**未通过**、以 request_changes 记为 Pi 最小修正项；Pi 已修复并经 `grok-s2-four-eyes-round-5.md` 第五审复验（finalexit 先算、三处同值、naturalExit 除名改 plannedExit）。本节其余结论不变。

协调者实读 Pi 原始日志（`$TMPDIR/perimeter-fe-probe/logs/all-run1-231203.log`、`fault-inject-231149.log` 等，均已保留未清理）并指出摘要字段失真；我的独立复核结论一致，两条事实分开：

1. **真实 runner exit 4 已成立**：fault-inject 运行外层真实 exit 4（timedOut=false，1123ms），`cleanupConfirmed:false`、`pendingReconcile` 含精确 ID `0e8233d5ed7e`；我自己的 bounded 包裹复测同样实测 FAULT-EXIT:4。清理未确认的失败不会被记成通过。
2. **摘要字段失真是真实可观测性缺陷**：同一故障运行的 stdout JSON 打出 `exitCode: 0`——源码在末尾先 `saveManifest()`/打印、之后才把 cleanup 失败折算进 `process.exitCode = 4`，字段快照早于最终折算；`naturalExit: true` 亦在真实事件循环退出前预写，单凭该字段不能证明自然退出。这是失败可观测性缺口：失败运行会打出自相矛盾的摘要。最小修正（探针内，Pi 下一包）：先定终态 exitCode 再 saveManifest/print；`naturalExit` 改为真实退出后置位或更名（如 `plannedExit`）。修复前，exit 判据以 bounded runner 的真实 exitCode 为准，不以 stdout/manifest 摘要字段为准。
3. 本轮产品/测试零改动，439×2 历史证据不重开；Pi 原始日志全部保留。

## 协调者日志交叉核验（Pi 原始日志逐项比对，2026-10-15）

协调者实读 Pi 原始日志（`$TMPDIR/perimeter-fe-probe/logs/`），与我方独立证据逐项一致：

- `all-run1-231203.log`：默认 **preflight:null（未启用）**、三场景 oracle 成立、外层 **exit 0 / timedOut=false / 3066ms** —— 无 preflight 的真实全场景运行成立。
- `fault-inject-231149.log`：外层**真实 exit 4 / timedOut=false / 1123ms**、`cleanupConfirmed:false`、`pendingReconcile` 含精确 ID `0e8233d5ed7e` —— 清理失败≠exit 0 成立。
- **摘要字段失真确认**：同一故障运行 stdout JSON 打出 `exitCode: 0`——探针源码在末尾先 `saveManifest()`/打印、之后才把 cleanup 失败折算进 `process.exitCode`；`naturalExit: true` 亦为预写字段。此为失败可观测性缺陷，须最小修正（先定终态再落盘/打印；`naturalExit` 退出后置位或更名）。修正前，exit 判据以 bounded runner 真实 exitCode 为准。
- 我的 bounded 包裹复测独立测得 FAULT-EXIT:4，与 Pi 日志一致。
