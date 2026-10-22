# Grok S2 工具路径守卫（Slice A）第二审

- 结论：`request_changes`（限定两项最小项：守卫拒绝原因泄露任意 Error 余文至客户端事件；deadline deny 的 reason 类别标注需可核。capability fail-closed、有界 deadline、缓存不毒化、根错误泄露主体面均已闭合实证）
- 日期：2026-10-16
- 审查者：grok（唯一 reviewer；Pi 唯一 coder）
- 对象：`src/runtime/perimeter-extension.ts` `8b255ebf18ab553d`、`src/runtime/harness-host.ts` `5b909381b006a8d0`、`src/runtime/execution-env.ts` `7ebcff21613d9df0`、`tests/protected-paths.test.ts`（14 项）。基线是 `docs/reviews/grok-s2-protected-paths-slice-a-round-1.md`（含 R2 纠正节：R1 的九场景通过与本包 approve 已撤回，当时门槛未过）。
- 允许写入：`docs/reviews/grok-s2-protected-paths-slice-a-round-2.md`、`docs/reviews/grok-s2-protected-paths-slice-a-round-1.md`（最小纠正）与 `docs/reviews/handoff-coverage.json`。未改实现、测试、其它 docs、SDK，未 commit / push / spawn 新 worker。

## R1 最小包三项的闭合核验（直接 extension 探针 + 源码）

1. **能力缺失 production fail-closed**：三态（都缺/缺 resolver/缺 workspaceCanonical）× production → 全部 `denyBlock`「生产模式缺少 canonical 路径解析能力，fail-closed 拒绝路径类工具」；demo → 不拒但审计留「路径守卫未启用（缺少 canonical 能力，demo 语义：仅词法策略）」。**已达 fail-closed**。
2. **有界 deadline + 工具取消传播**：`guardTimeoutMs`（默认 3s）deadline controller；工具 `ctx.abortSignal` 经 `withAbortSignal` 派生进守卫等待；`resolveCanonicalPathForGuard` 全部祖先回溯共享 5s `AbortSignal.timeout` 预算。行为实证：永不 resolve 的 resolver + 200ms 档 → **204ms 有界 denyBlock**，且 **底层 fake resolver 在 deny 时仍 pending**——「提前返回、底层存续」语义行为学证实（非谎称已取消）。
3. **abort-before 不触 resolver**：预 abort 的 toolSignal → deny「工具已取消」，resolver 调用计数 **0**。
4. **根缓存不毒化**：workspace canonical 失败×2 → 成功×1（rootCalls=3，无失败缓存残留），第三次守卫正常通过。
5. **诊断脱敏主体面**：拒绝原因仅含错误类别（NUL/越界/包含失败等），不再携带宿主目录与文件内容——**但见下条新发现**。

既有能力回归：production 真实容器链 git-less fail-closed、symlink 逃逸/保护、假前缀、多级正控（round-1 探针矩阵）在 453×2 全量与专项 14/14 中保持。

## 新发现（request_changes 最小项；【已修复，第三轮 errCategory 白名单补丁，见 round-3】）

1. **拒绝原因泄露任意 Error 余文**：`errCategory` 对「含 canonicalize failed 的 Error」取 `msg.replace(/^.*canonicalize failed: /, "").slice(0, 40)`——我注入的 resolver 抛「…permission_denied /Users/sundy/secret」，客户端 `policy.denied` 的 reason 实测为「路径规范化失败（fail-closed，类别=permission_denied /Users/sundy/secret）」——宿主路径直达客户端事件。最小修复：errCategory 白名单化（仅返回已知错误码/类别 token，其余一律 "unknown"），并补一条含宿主路径 Error 的泄露负测。
2. **deadline deny 的 reason 类别可核性**：预算到点的 block 文本未携带稳定的 `budget-timeout`/`deadline` 类别 token（我实测 `categoryDeadline:false`），建议统一类别串（如 `budget-timeout`）便于断言与审计过滤。非阻断，随 1 一并修。

## 全量与静态（本轮新鲜实测）

| 模式 | exit | tests | pass | fail | skipped | cancelled |
|---|---|---|---|---|---|---|
| `npm run test:serial`（concurrency=1）【历史，当前为 456×2】 | 0 自然 | 453 | 453 | 0 | 0 | 0 |
| `npm run test:bounded`（默认并发）【历史，当前为 456×2】 | 0 自然 | 453 | 453 | 0 | 0 | 0 |

453 = 447 + 6 项新增单元（能力缺失三态/demo/abort-before/缓存毒化）。`npm run typecheck` 0；`git diff --check` 0。哈希：extension `8b255ebf18ab553d`、harness-host `5b909381b006a8d0`、execution-env `7ebcff21613d9df0`（与 Pi 报告一致）。owned 容器 0；447×2 与 r20 439×2 均为历史。

## SDK 语义独立核（源码级，Pi 边界陈述逐条确认）

- `Connection.request(op, json, options)` **支持** `options.signal`：abort 时写 `CANCEL` 帧（id 定向）并 reject 客户端 Promise（connection.js:158-174）。
- `RemoteExecutionEnv.canonicalPath` 调 `request("realpath", …)` **未转发 signal**（remote-env.js:652-657）——在途 realpath 不可经守卫 AbortSignal 取消，Pi 边界陈述准确。
- `connection.close()` teardown 按协议 Liveness 在 stdin 结束/断连后由 daemon 收底（约 30s 宽限）终止全部在途 RPC 与进程组；另按 protocol.md §Cancellation：realpath 属 Other operations「short and finish normally」，CANCEL 不停止它——Pi 的边界陈述经协议原文核对成立。
- 最小可行设计（下一包建议，非本轮要求）：`RemoteExecutionEnv.canonicalPath` 增加可选 signal 参数转发 `request` options（SDK 侧一行）；副作用：被取消的 realpath 在 daemon 侧收到 CANCEL，容器内 realpath 进程按 daemon kill 语义终止——无共享状态污染面。

## 台账与边界

- `s2-path-guard`：维持 `partial`（新增泄露负测与 deadline 类别 token 修复后，连同既有证据可评估升 implemented；bash/hardlink/TOCTOU 窄窗/敏感读仍按Slice A 边界除外）。
- S2 其余四眼（implemented 维持）/DLP/repo-token/敏感路径/symlink/本地 egress 保持各自状态；真实 CNI/客户模型 external；企业生产不批准；Slice B 不在本包扩展。
