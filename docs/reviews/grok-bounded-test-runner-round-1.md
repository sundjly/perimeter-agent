# Grok Bounded Test Runner 第一审

- 结论：`request_changes`（限定一项：spawn ENOENT 时 runner 进程以 unhandled `error` 事件崩溃而非受控报告。进程组隔离、超时强杀、孤儿回收、退出码契约全部实证成立）
- 日期：2026-10-14
- 审查者：grok（唯一 reviewer）
- 对象：`scripts/bounded-test-runner.ts`、`tests/bounded-runner.test.ts`、`package.json` 的 `test:serial`/`test:bounded`。基线是 S2 round-3 补验节对临时看护的禁用令。
- 允许写入：本文件与 `docs/reviews/handoff-coverage.json`。未改实现、测试、docs 其它、SDK，未 commit / push / spawn 新 worker。

## 设计与代码核验

- `detached: true` spawn：子进程成为自身会话/组长，实测 `PGID === PID`。
- `validateProcessGroup` 三重 fail-closed：组长身份、非 runner 组、非父链组；任一不满足即降级为单 PID 管理，绝不向共享组广播负 PID 信号。PGID 读取重试 5 次抗启动竞态。
- `cleanupProcessGroup`：SIGTERM 组 → grace 轮询 → SIGKILL 组 + 逐 PID → 轮询至组空（2s 上限）；每次调用有真实 `wait`/轮询收尾，无 race 返回伪装、无 unref 活工作、库内无 `process.exit`。
- 正常路径：child close 后仍扫描组内孤儿并收割（parent-exits-first 场景）。
- 退出码契约：透传原码；超时固定 124；signal 按 128+n。
- 日志仅含 runId/argv/deadline/墙钟/清理 PID 列表，无 env dump、无密钥。

## 独立探针（我自己的脚本，非仅复跑 agy 测试）

| 探针 | 结果 |
|---|---|
| TERM-忽略子孙树 + 1.2s deadline | exit 124、timedOut、组验证通过、子进程与忽略 TERM 的孙子均消亡、组空 |
| spawn ENOENT | **runner 进程以 unhandled `error` 事件崩溃**（`child.on("error")` 在 pid 检查 throw 之后才注册）。无误杀，但调用进程崩溃而非受控报告 |
| 独立 sentinel + 超时清理 | 目标被清、sentinel 完好存活 |
| PGID 独立性 | detached 子进程 PGID=PID、≠runner 组、≠父组 |
| 快速退出 0 / 42 | 原码透传，无误杀、无误报超时 |

## 自动化守卫与两次全量

`tests/bounded-runner.test.ts` 7 项覆盖：0/42 透传、短 deadline 124、忽略 TERM 孙子 SIGKILL、父先退孤儿收割、独立 sentinel 存活、共享 PGID fail-closed。

新 runner 两次全量（npm scripts，deadline 900s 预设）：

| 模式 | exit | 耗时 | tests | pass | fail | skipped | owned 容器 | 残留进程 |
|---|---|---|---|---|---|---|---|---|
| `test:bounded`（默认并发） | 0 自然 | 18.5s | 424 | 424 | 0 | 0 | 0 | 无 |
| `test:serial`（concurrency=1） | 0 自然 | 64.5s | 424 | 424 | 0 | 0 | 0 | 无 |

424 = 417 + 7 项 runner 专项。`npm run typecheck` 0、`git diff --check` 0。未触碰 docker daemon、用户 workloads/context；未做广泛 node/agent 查杀。

## 残留与范围声明

1. **spawn ENOENT 崩溃**：`runBounded` 在 `child.pid` 缺失时 throw，但 ChildProcess 的 `error` 事件在监听器注册前已触发，调用进程以 unhandled error 崩溃。最小修复：spawn 之后立即 `child.on("error", () => {})` 挂 no-op（或先注册再检查 pid），把失败转为受控返回。验收：不存在命令 → 受控 exit 1 + 错误信息，进程不崩。
2. **范围声明（必须写进 runner 文档）**：组级收割只覆盖受控组内成员；主动 `setsid` 逃逸出组的孙进程不在 `getGroupPids` 视野内，不会被清理。该工具是「同组强隔离 + 组内零残留」，不是通用进程树强隔离；不得冒充后者。
3. 前几轮的临时看护（`pkill -P $$`/未证实 setpgrp）已被本 runner 取代，后续全量验证统一走 `npm run test:serial` / `npm run test:bounded`。

## 台账与边界

- S2 限定源码 + 真串行 3 的 approve 不重开；S2 全阶段与生产仍未批准；S2 其余四眼/DLP/repo-token/symlink 保持 missing/partial，真实 CNI/客户批准 external。
- 后续推进按依赖：S2 四眼/DLP/repo-token 或 S3 stateRoot 独占锁。
- S0/S1/Durable/缓存前缀无回归（424 全过口径）。
