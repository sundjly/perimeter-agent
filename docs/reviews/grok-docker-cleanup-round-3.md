# Grok Docker 清理专项第三审

- 结论：`approve`（限定 docker-cleanup 专项收口：F3-1 有界等待修复验证通过，六轮全量零 flake。不是企业生产批准，S2 两项失败仍按台账保留）
- 日期：2026-10-14
- 审查者：grok（唯一 reviewer）
- 对象：`docs/implementation/docker-cleanup-fixes.md` 更新与 `tests/enterprise-s1.test.ts` `8d5d6b609b948fad`（其余文件哈希与第九轮一致：`server.ts` `34672b2f9330f6cc`、`session.ts` `8e57a07a5979ed25`、`execution-backend.ts` `9e086aafe3d27d96`、`docker-backend.test.ts` `ca9ce1dc673d9a91`）。基线是 `docs/reviews/grok-docker-cleanup-round-2.md`。
- 允许写入：本文件与 `docs/reviews/handoff-coverage.json`。未改实现、测试、docs 其它、SDK，未 commit / push。

## F3-1 修复核验（源码 + oracle 自证）

- `waitForLogContent(filePath, expected, 10s)`：25ms 间隔轮询，条件是文件**存在且内容包含目标 prompt**——不是只等 `message.end`，也不是 exists 即过；超时受控抛错并附最终文件内容。
- 未映射组负测：关闭码限 [4001,4003,1008]，断言模型日志**长度零增长**（不是仅断言无错误字符串）。
- oracle 自证两条都真：负向（`NEVER_WRITTEN_TOKEN`，150ms deadline）必须受控抛超时；正向（60ms 后异步迟到写入）必须被等待成功并读到内容。该 helper 既能失败也能通过。
- F3-3 未弱化：`queue-leak.txt` 写入脚本、正向 marker、负向无 prompt 与无副作用断言保持原样。

## 六轮全量实测（每轮外部墙钟，依次执行）

| 轮次 | 调度 | total | pass | fail | exit | 墙钟 |
|---|---|---|---|---|---|---|
| 1 | `--test-concurrency=1` | 406 | 404 | 2 | 1 | 59s |
| 2 | `--test-concurrency=1` | 406 | 404 | 2 | 1 | 59s |
| 3 | `--test-concurrency=1` | 406 | 404 | 2 | 1 | 62s |
| 4 | 默认并发 | 406 | 404 | 2 | 1 | 24s |
| 5 | 默认并发 | 406 | 404 | 2 | 1 | 25s |
| 6 | 默认并发 | 406 | 404 | 2 | 1 | 24s |

- 六轮全部自发退出，零 flake，零挂起；失败恒为两项容器 S2 用例（策略扩展只读挂载、容器端到端策略钩子），断言未弱化。
- `label=perimeter.gateway` 的 owned 容器六轮前后均为 0；`pgrep node --test` 无残留。
- `npm run typecheck` exit 0；`git diff --check` exit 0。

## 既有结论复核

- 产品源码无用户 socket 硬编码、无导入期环境副作用（本轮四个 src 文件哈希与第九轮一致，未回退）。
- 身份跨进程保持、撤权/崩溃窗口 fail-closed、PKCE、审批二次鉴权、JWKS、真实 20slot、cache 前缀、Durable API：相关文件本轮零改动，且六轮全量含这些测试全部通过，无回归。
- S0：`dependency-and-scope.md` 哈希台账已同步本轮最新值（`8d5d6b60…` 在册，旧值已不在）；`s0-benchmark-baseline` 保持 partial（无真实 runner）；金额按 mock 价格 $0.00；真实 IdP/集群/模型/客户批准仍 external；企业生产未批准。

## 后续

docker-cleanup 专项无本地遗留。剩余工作按既有台账推进：S2 两项容器失败（只读挂载、端到端策略钩子）与 S3 锁、S4 预算为本地代码任务；真实 IdP/集群 egress/真实模型/客户批准为 external；`s0-benchmark-baseline` 的真实 runner 完成后才能升 implemented。
