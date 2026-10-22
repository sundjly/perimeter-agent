# Grok S2 工具路径守卫（Slice A）第三审（错误类别白名单 + 取消门槛维持 blocked）

- 结论：`approve`（限定错误类别白名单小补丁：六项行为探针全过、泄露面归零、14+3 项专项与 456×2 新鲜全量复现。**取消门槛维持 blocked**——exec helper 设计待协调者在 A/B 间选型，本轮未实施也未批准；{{SECRET}} 与 S2 整体维持 partial，企业生产不批准）
- 日期：2026-10-16
- 审查者：grok（唯一 reviewer；Pi 唯一 coder）
- 对象：`src/runtime/perimeter-extension.ts` `209f87f75524a742`、`src/runtime/harness-host.ts` `9fff57e8853804d8`（errCategory 白名单补丁）与 `docs/implementation/s2-path-guard-cancellation-plan.md`（取消设计，未实施）。基线是 `docs/reviews/grok-s2-protected-paths-slice-a-round-2.md`。
- 允许写入：`docs/reviews/grok-s2-protected-paths-slice-a-round-3.md`、`docs/reviews/grok-s2-protected-paths-slice-a-round-2.md`（必要历史纠正）、`docs/reviews/grok-s2-protected-paths-slice-a-round-1.md`（标题占位符更正）与 `docs/reviews/handoff-coverage.json`。未改实现、测试、其它 docs、handoff、SDK，未 commit / push / spawn 新 worker。

## 白名单补丁独立探针（六项，全部通过）

| 探针 | 注入 | 实测 |
|---|---|---|
| 泄露负测 | `Error("canonicalize failed: permission_denied <宿主路径>/secret\\n<secret>")` | 类别=**unknown**；block/audit 零泄露（宿主路径/secret/raw-message/换行全不出现）；仍 fail-closed 拒 |
| 白名单直通 | `Error.code = "permission_denied"`（message 内嵌宿主路径） | 类别=permission_denied 直通；message 不泄露 |
| deadline | 永不 resolve resolver，guardTimeoutMs=150ms | 类别=**deadline**（按控制器状态，非 Error 文案） |
| 工具预 abort | 预 aborted toolSignal | 类别=**aborted** |
| 无 code 普通 Error | `Error("boom")` | 类别=unknown，fail-closed 拒（不伪成功） |
| production 缺能力回归 | 缺 canonical 能力 | 仍 fail-closed 拒（无回退） |

机制：`errCategory` 状态优先（工具信号 aborted → 守卫控制器 deadline）→ `Error.code` 白名单直通 → 其余一律 unknown；Error.message 全文不再进入任何输出。`denyBlock` 的 audit summary 仅含工具提供的 path 前 80 字符（客户端已知内容），非宿主路径。

## 全量与静态（本轮新鲜实测，逐项实际读取日志尾）

| 模式 | exit | tests | pass | fail | skipped | cancelled | 墙钟 |
|---|---|---|---|---|---|---|---|
| `npm run test:serial`（concurrency=1，runner 外层 1700s 预挂，PGID 独占组验证） | 0 自然 | 456 | 456 | 0 | 0 | 0 | 190.7s |
| `npm run test:bounded`（默认并发，1700s） | 0 自然 | 456 | 456 | 0 | 0 | 0 | 130.0s |
| `tests/protected-paths.test.ts` 直跑 | 0 自然 | 17 | 17 | 0 | 0 | 0 | 4.6s |

456 = 453 + 3 项白名单泄露负测；17 项专项含本轮 3 项新泄露负测。日志尾已实际读取（`[bounded-runner] 执行完毕: exitCode=0, timedOut=false, 耗时=190589ms / 129818ms`；`启动命令: npm run test:serial (timeout: 1700000ms)`、`进程组安全验证成功: PGID=63025`）。`npm run typecheck` 0；`git diff --check` 0。哈希：extension `209f87f75524a742`、harness-host `9fff57e8853804d8`（R2 后有变，Pi 报告未列本轮哈希——已实测补记）。

## 取消门槛：维持 blocked（设计评审意见，待协调者 A/B 选型）

协议事实三方一致（protocol.md §Cancellation + semantics.md + connection.js 源码）：realpath 属 Other operations「short and finish normally」，CANCEL 不停止它；`#send` onAbort 只写 CANCEL 帧并等待真实 result/error，不立即 reject。exec helper 设计（B 案）利用 exec 取消=杀进程组的协议保证，方向可行。评审更正三条，供下一实现包落实：

1. **stdout 契约自相矛盾须消除**：helper stdout 输出 `{canonical}` 与「不输出任何路径」并存。应写明：helper stdout 是 helper→网关的**私有通道**，canonical 仅用于策略复判，绝不转发到客户端事件/审计/日志——审计只允许类别 token 与工具提供的 path 前缀。
2. **root 的 namespace 归属须写死**：helper 在容器/Pod 内运行，其参数必须是**同 namespace 的根**（Docker = `env.cwd` 即 /workspace），禁止把 `opts.workspace` 宿主路径直接传给容器 helper 做硬映射。
3. **代价与机制口径**：`RemoteExecutionEnv.exec` 是已存在 pi-env 连接上的 RPC——每次 helper 调用 = daemon 内一次 spawn，**不是**每次新建 docker exec/kubectl exec；「~10ms/~100ms」无同条件基准，只能作量级参考不得当机制事实。Pod 场景：客户端超时杀的是 kubectl 客户端进程，Pod 内 helper 是否随进程组终止**未在真实集群验证**（unknown）——机制描述必须保持这个 unknown，不得写成「必然杀远端」或「只杀客户端」。协议只证明 exec 取消设计可行，实施后仍需真实 kill/close 正反控。

A（现状 RPC + awaitWithContext 有界等待 + 边界标注，已实现）与 B（exec helper，真实取消）由协调者选型；选 B 前不实施、不由 reviewer 代实现。

## 台账与边界

- `s2-path-guard`：维持 `partial`（类别泄露面已归零；取消门槛 blocked 待选型；bash/hardlink/TOCTOU 窄窗/敏感读残余不变）。**不因类别补丁升 implemented**。
- S2 四眼 implemented 维持不回退；DLP/repo-token/敏感路径保持 missing/partial；真实 CNI/客户模型 external；S3/S4 按依赖；企业生产不批准。
- 7 个孤儿 mock（ppid=1）归属证据不足，维持 unknown/待对账；Pi 的「按 PID 清理至 0」说法已由 Pi 自行撤回，历史 3 容器未被误删（本轮前后实测恒 3）。
- R2 报告已做事实更正（泄露项标记已修复、453×2 历史化、SDK close 语义补 30s 宽限与 realpath-CANCEL 事实）；R1 标题占位符更正为「S2 工具路径守卫」。
