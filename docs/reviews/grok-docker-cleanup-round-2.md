# Grok Docker 清理专项第二审

- 结论：`request_changes`（限定一项：F3-1 读取模型日志未做有界等待，六轮全量中出现 1 次 ENOENT flake。两项 round-1 request_changes 均已修复并验证）
- 日期：2026-10-14
- 审查者：grok（唯一 reviewer）
- 对象：`docs/implementation/docker-cleanup-fixes.md` 与 `server.ts` `34672b2f9330f6cc`、`session.ts` `8e57a07a5979ed25`、`execution-backend.ts` `9e086aafe3d27d96`、`enterprise-s1.test.ts` `240e2a8523083e00`、`docker-backend.test.ts` `ca9ce1dc673d9a91`。基线是 `docs/reviews/grok-docker-cleanup-round-1.md`。
- 允许写入：本文件与 `docs/reviews/handoff-coverage.json`。未改实现、测试、docs 其它，未 commit / push。

## 六轮全量实测（每轮外部墙钟，依次执行）

| 轮次 | 调度 | total | pass | fail | exit | 墙钟 |
|---|---|---|---|---|---|---|
| 1 | `--test-concurrency=1` | 406 | 403 | 3 | 1 | 61s |
| 2 | `--test-concurrency=1` | 406 | 404 | 2 | 1 | 62s |
| 3 | `--test-concurrency=1` | 406 | 404 | 2 | 1 | 61s |
| 4 | 默认并发 | 406 | 404 | 2 | 1 | 24s |
| 5 | 默认并发 | 406 | 404 | 2 | 1 | 25s |
| 6 | 默认并发 | 406 | 404 | 2 | 1 | 24s |

- 六轮全部自发退出，无挂死；`label=perimeter.gateway` 的 owned 容器前后均为 0；无残留测试进程。
- 五轮为稳定口径 404+2（两项容器失败保持 S2）。轮 1 多出一次 **F3-1** flake：`enterprise-s1.test.ts:1339` 在 `message.end` 后立即 `readFileSync` 模型日志，模型 HTTP 回程未完成时文件尚不存在 → ENOENT（90ms 即败）。有界重试只加在了 `s1-persistent-revocation`；F3-1 的直读没有同样的有界等待。EADDRINUSE 六轮零复发。
- `npm run typecheck` exit 0；`git diff --check` exit 0。

## round-1 两项 request_changes 的独立验证

1. **产品硬编码已移除**。`src/` 下 grep 不到 `sundy` 与 orbstack 路径；`execution-backend.ts` 的模块顶层 `process.env.DOCKER_HOST` 赋值已删除。显式配置与平台环境被尊重：`DOCKER_CLIENT_KEYS` 继续转发用户已设置的 `DOCKER_HOST`/`DOCKER_CONTEXT` 等；测试文件内的本机 socket 收敛在测试内部，且用 `process.env.HOME` 动态拼接、用户已设 `DOCKER_HOST` 时不覆盖。owned 资源仅按 `perimeter.gateway=<gatewayId>` 标签与精确容器名清理，六轮前后标签计数为 0，未触碰用户既有资源。
2. **EADDRINUSE 已消竞态**。`s1-persistent-revocation` 改为有界重试（最多 5 次、每次重新 `getAvailablePort`，仅 `EADDRINUSE` 重试，其它错误直接抛出，失败 attempt 关闭 gwA/gwB 释放监听与审计锁）；`Gateway.listen()` 对 `#http` 注册 `once("error")` 受控 reject；新增受控冲突负测（blocker 占口 → `assert.rejects(listen(), EADDRINUSE)` → `close()` 释放 → 释放后重绑同端口成功）。六轮全量 `s1-persistent-revocation` 全过、零 EADDRINUSE。撤权/崩溃窗口/删除/结构损坏负测断言未弱化。

## 根因表述与 S0

- agy 已按 round-1 意见校准 `docker-cleanup.md`：承认 node:test 支持顶层 `after()`，真因为 40s 等待跳过用例清理 + dispose 不 abort 宿主执行流 + 无 deadline，与我的独立结论一致。
- S0：`dependency-and-scope.md` 哈希台账含本轮五个文件且与实测一致；`benchmark-baseline.md` 仍声明无真实 runner，`s0-benchmark-baseline` 保持 partial；金额按 mock 价格 $0.00 表述；S2 两项失败与 S3/S4 本地缺失未写成 external；无企业生产表述。

## 给 agy 的下一最小包

只做一件：F3-1 的模型日志读取改为有界等待——在断言 `gotMessageEnd` 之后，轮询 `existsSync(mockLog)`（带上限，如 10s，20–50ms 间隔）直到文件出现再读取与断言；F3-3 若有同类直读一并处理。不得放宽其它断言、不得重试吞掉真实失败。验收：六轮全量（串行 3 + 默认并发 3）全部 404+2、零 flake、全部自行退出。完成后 `s0`/docker 专项即无本地遗留，S2 两项按既有台账推进。
