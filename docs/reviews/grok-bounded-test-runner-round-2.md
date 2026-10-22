# Grok Bounded Test Runner 第二审

- 结论：`approve`（限定 bounded-runner 修复包：spawn-ENOENT 双路受控失败实证成立，既有能力无回退。范围声明不变：同组强隔离，不覆盖主动 setsid 逃逸，非安全 sandbox/通用进程树强隔离。S2 全阶段与生产不批准）
- 日期：2026-10-14
- 审查者：grok（唯一 reviewer）
- 对象：`scripts/bounded-test-runner.ts` `23966148ad84b4a7`、`tests/bounded-runner.test.ts` `002712dac5b0c8d1`。基线是 `docs/reviews/grok-bounded-test-runner-round-1.md`。
- 允许写入：本文件与 `docs/reviews/handoff-coverage.json`。未改实现、测试、docs 其它、SDK，未 commit / push / spawn 新 worker。

## R1 残留的闭合核验（独立探针）

- **库级**：`runBounded` 对不存在命令受控 reject，真实 ENOENT 原因（`spawn … ENOENT`）；reject 后同一调用进程继续下一 turn，独立 sentinel 完好存活。error 监听在 spawn 后**同步立即**注册，早于 pid 检查与任何 await——源码 244-258 行确认，非 noop 吞错：pid 缺失路径等待 error/close 后 reject 真实错误，不 fake 组验证状态、绝不构成负 PID 组杀。
- **CLI 级**：`node scripts/bounded-test-runner.ts --timeout 5s definitely-not-a-binary-xyz-9812` → 受控 exit 1，日志给出真实原因（`命令启动失败: spawn … ENOENT`），无 unhandled 事件崩溃。

## 既有能力回归（我的独立探针，未沿用旧结论）

- detached 子进程 `PGID === PID`、groupVerified 通过。
- 真 700ms deadline：124、TERM-忽略孙子被组级清理、组内残留 0。
- 退出码契约：0 透传、42 透传、SIGKILL 自杀 → exit 137（128+9）且 `actualSignal: "SIGKILL"`。
- 父先退孤儿：exit 0 + 组内残留 0（收割生效）。
- 未触发看护不声称安全：以上均为真实触发路径。

## 新 runner 两次全量（当前实际口径）

| 模式 | argv | exit | tests | pass | fail | skipped |
|---|---|---|---|---|---|---|
| `npm run test:bounded`（默认并发） | `node scripts/bounded-test-runner.ts --timeout 900s node --test --test-reporter=spec "tests/**/*.test.ts"` | 0 自然 | 427 | 427 | 0 | 0 |
| `npm run test:serial`（concurrency=1） | 同上 + `--test-concurrency=1` | 0 自然 | 427 | 427 | 0 | 0 |

- 427 = 424 + 3（本包新增的 spawn-失败受控测试）。两轮均自发退出、skipped 0、owned 容器 0、无 `node --test`/mock-model 残留。
- `npm run typecheck` 0；`git diff --check` 0。文件哈希：runner `23966148ad84b4a7`、测试 `002712dac5b0c8d1`。

## 范围声明（沿用并要求保持）

组级收割仅覆盖受控组内成员；主动 `setsid` 逃逸出组的孙进程不在 `getGroupPids` 视野，不会被清理。该 runner 是「同组强隔离 + 组内零残留」的测试基础设施，不是安全 sandbox，也不是通用进程树强隔离，不得在后续文档中冒充。

## 台账与边界

- bounded-runner 本包 approve；S2 容器基础的限定源码 approve 不重开；S2 其余四眼/DLP/repo-token/symlink 保持 missing/partial，真实 CNI/客户批准 external；S2 全阶段与企业生产不批准。
- 后续按依赖推进 S2 四眼/DLP/repo-token 或 S3 stateRoot 独占锁；全量验证统一走 `npm run test:serial` / `npm run test:bounded`。
