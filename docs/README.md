# 文档索引

当前状态以 [implementation-progress.json](implementation-progress.json) 为准；需求与验收口径见 [handoff.md](handoff.md)。每个专题只保留当前实现记录和最终一轮评审。被后续轮次取代的中间修复记录、中间评审和旧方案已删除，原文保留在提交 `3eeaa57`（`git show 3eeaa57:<path>`）。保留文档中指向已删文件的链接均为历史引用。

## 规格与背景

| 文档 | 内容 |
|---|---|
| [handoff.md](handoff.md) | 企业化规格、铁律、阶段 S0–S7 与 P0 检查单 |
| [durable-rearchitecture.md](durable-rearchitecture.md) | Pi Durable 重构规格与 §9 实现记录 |
| [review-log.md](review-log.md) | F1–F19 及 Durable 重构阶段的评审记录 |
| [browser-code-agent-strategy.md](browser-code-agent-strategy.md) | 产品策略与路线图（2026-08） |
| [s0/](s0/) | 威胁模型、依赖与范围、S0 基准基线 |

## 阶段实现与最终评审

| 阶段 | 实现记录 | 最终评审 |
|---|---|---|
| S0/S1 | [s0-s1-completion](implementation/s0-s1-completion.md)、[s0-benchmark-runner](implementation/s0-benchmark-runner.md) | [s0-s1-completion r2](reviews/grok-s0-s1-completion-round-2.md)、[s0-benchmark-runner r2](reviews/grok-s0-benchmark-runner-round-2.md)、[s1 r5](reviews/grok-s1-round-5.md)、[协调者 S1 审查](reviews/coordinator-s1-review.md)、[baseline](reviews/grok-baseline.md) |
| 测试执行器 | [bounded-test-runner](implementation/bounded-test-runner.md)、[bounded-runner-r47](implementation/bounded-runner-r47.md)、[docker-cleanup](implementation/docker-cleanup.md)、[docker-cleanup-fixes](implementation/docker-cleanup-fixes.md) | [bounded-test-runner r2](reviews/grok-bounded-test-runner-round-2.md)、[bounded-runner r3](reviews/grok-bounded-runner-round-3.md)、[docker-cleanup r3](reviews/grok-docker-cleanup-round-3.md) |
| S2 基线/容器 | [s2-baseline-commit](implementation/s2-baseline-commit.md)、[s2-container-foundation](implementation/s2-container-foundation.md) | [baseline-commit r2](reviews/grok-s2-baseline-commit-round-2.md)、[container-foundation r3](reviews/grok-s2-container-foundation-round-3.md) |
| S2 四眼审批 | [s2-four-eyes](implementation/s2-four-eyes.md)、[standalone 探针](implementation/s2-four-eyes-standalone.md) | [four-eyes r5](reviews/grok-s2-four-eyes-round-5.md) |
| S2 保护路径 | [slice-a](implementation/s2-protected-paths-slice-a.md)、[exec helper](implementation/s2-path-guard-exec-helper.md)、[SDK 侧阻碍](implementation/s2-path-guard-bootstrap-blocker.md) | [slice-a r6](reviews/grok-s2-protected-paths-slice-a-round-6.md)、[phase-b r2](reviews/grok-s2-protected-paths-phase-b-round-2.md) |
| S2 SDK 连接 | [session-pin](implementation/s2-sdk-session-pin.md)、[teardown](implementation/s2-sdk-teardown-continuation.md) | [session-pin r20](reviews/grok-s2-sdk-session-pin-round-20.md)、[teardown r2](reviews/grok-s2-sdk-teardown-continuation-round-2.md) |
| S2 敏感读/DLP | [r45](implementation/s2-sensitive-read-dlp-r45.md) | [sensitive-read-dlp r3](reviews/grok-s2-sensitive-read-dlp-round-3.md) |
| S2 SCM 授权 | [合同](reviews/s2-scm-scoped-grant-contract.md) | [scoped-grants r15](reviews/grok-s2-scm-scoped-grants-round-15.md)、[范围审计](reviews/continuation-scope-audit.md) |
| S3 恢复 | — | [lifecycle](reviews/grok-s3a-lifecycle-round-1.md)、[receipt](reviews/grok-s3b-receipt-round-1.md)、[crash](reviews/grok-s3c-crash-side-effects-round-1.md)、[backup-restore r2](reviews/grok-s3d-backup-restore-round-2.md) |
| S4 模型预算 | [s4-model-budget](implementation/s4-model-budget.md) | [s4a](reviews/grok-s4a-deadline-drain-round-1.md)、[s4b](reviews/grok-s4b-persistent-budget-round-1.md)、[s4c](reviews/grok-s4c-scoped-wiring-round-1.md) |
| S5 交互/token | [history](implementation/s5-history-pagination.md)、[tools-bounded](implementation/s5-tools-bounded.md)、[tools-paging](implementation/s5-tools-paging.md)、[token-benchmark](implementation/s5-token-benchmark.md) | [s5a r2](reviews/grok-s5a-history-pagination-round-2.md)、[s5b](reviews/grok-s5b-tools-bounded-round-1.md)、[s5c](reviews/grok-s5c-tools-paging-round-1.md)、[s5d r2](reviews/grok-s5d-token-benchmark-round-2.md) |
| S6 本地交付 | [s6-local-delivery](implementation/s6-local-delivery.md)、[s5d-s6 协调者验收](implementation/s5d-s6-coordinator-validation.md) | [s6 r1](reviews/grok-s6-local-delivery-round-1.md) |

## 运维与证据

- [operations/s6-runbook.md](operations/s6-runbook.md)：备份恢复、凭据轮换、发布回滚、SBOM 与漏洞扫描。
- [s5/](s5/)：S5 原始基准报告、最终统计报告与证据（`evidence/metadata.json` 绑定源码哈希）。
- [s6/evidence/](s6/evidence/)：SBOM、npm audit 原始报告、schema 校验与 metadata。
- [reviews/handoff-coverage.json](reviews/handoff-coverage.json)：handoff 条目覆盖表（round-40 历史条目 + 2026-10-22 补充）。
