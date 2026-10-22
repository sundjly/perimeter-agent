# Grok S2 四眼审批第五审（探针终态摘要修复补验）

- 结论：`approve`（限定探针终态摘要唯一缺口的修复：finalexit 先算后三处同值、cleanup 失败三面同 4、usage/policy/crash 不继承旧 0、naturalExit 除名改 plannedExit。四眼产品能力与合规无 preflight 三场景为此前已证，不重开。真实模型/CNI/客户批准 external，S2 整体与企业生产不批准）
- 日期：2026-10-15
- 审查者：grok（唯一 reviewer；Pi 唯一 coder）
- 对象：`scripts/probes/four-eyes-standalone.ts` `772c73ff07e67738`（探针修复；产品/测试零改动——`server.ts` `7176f157ddec9ed5`、`approvals.ts` `8307708ff8222371` 未变）。基线是 `docs/reviews/grok-s2-four-eyes-round-4.md` 及其补充核验节。
- 允许写入：`docs/reviews/grok-s2-four-eyes-round-5.md`、`docs/reviews/grok-s2-four-eyes-round-4.md`（最小更正）与 `docs/reviews/handoff-coverage.json`。未改实现、测试、其它 docs、handoff、SDK，未 commit / push / spawn 新 worker。

## 终态摘要契约核验（R4 唯一缺口的闭合）

源码（518-539 行）与行为双确认：`plannedExitCode` **先**按 `cleanupUnconfirmed ? 4 : scenarioFailed ? 1 : 0` 完整计算，随后同一值写入 `manifest.plannedExit`、打stdout JSON、赋 `process.exitCode`——不再「先输出后折算」。`naturalExit` 字段已除名，改为 `plannedExit`（语义：计划退出值；真实自然退出由外层 bounded runner 的 exit/close 记录佐证，不再自证）。

## 独立行为三连（每轮全新 OS 进程，外层 bounded runner 180s/60s）

| 运行 | 真实 runner exit | stdout/manifest plannedExit | 关键断言 | labeled 容器（后） |
|---|---|---|---|---|
| 清洁 all（无 preflight） | 0 | 0 / 0 | 三场景 pass，own 清理逐 ID 确认 | 3（历史保留） |
| 故障注入 all | **4** | **4 / 4** | 跳过容器 `35f1e9bd7127` 记 pendingReconcile；scenario allPassed 仍 true 但退出码以清理未确认为准 | 3（跳过容器经 `--rm` 自清，账目留存） |
| 未知场景 bogus | 3 | 3 / 3 | 不继承旧 0 | 3 |

- cleanup 失败时 stdout、manifest、真实 runner exit **三处同为 4**——R4 的「摘要说 0、实际 4」失真消除。
- usage/policy/crash 路径分别定 3/2/1，均先置 plannedExit 再输出，无旧值继承。
- 产品/测试哈希未变 → r20 的 439×2 保持历史证据，本轮不重跑全量（仅 probe 改动）。

## R4 最小更正（对 round-4 报告）

R4 正文 approve 与附录 request_changes 并存曾未标注关系。现已最小更正：正文 approve 限定「产品四眼能力 + 三场景 oracle」，附录的 stdout/manifest exitCode 失真为「当时未通过的摘要修复」——本验证其已修复，两段不再矛盾（更正标记见 round-4 文件）。

## 台账与边界

- `s2-four-eyes`：维持 `implemented`（standalone 门槛在终态摘要契约修复后完整关闭）。
- S2 其余 DLP/repo-token/敏感路径/symlink/本地 egress 保持 missing/partial；真实 CNI/客户批准 external；S3/S4 按依赖；企业生产不批准。历史 3 容器原样保留；本轮 own 资源（故障注入的 skipped 容器经 `--rm` 自清）已按 pendingReconcile 对账。
