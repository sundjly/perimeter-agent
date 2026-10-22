# S5a 历史 tail 与分页（commit `e2d69a6`）

依据：`docs/handoff.md` §3.2（初始 tail 200 项且 ≤1MiB，超限分页游标）、§7 S5。
复审：`grok-s5a-history-pagination-round-1`（request_changes：压缩后旧游标错位）、`round-2`（approve）。

验证：typecheck 0；history-pagination 8/8 连跑 3 次；全量 67 文件 859/859；无残留。
变异均被抓住：去掉游标验签、出口不裁尾、去掉锚点核对。

## 已实现

- 服务端内部保留全量 view，只在出口裁尾：默认 200 项且 ≤1MiB，取更严，最新一项恒保留；构造可配，`maxBytes ≤ maxFrameBytes - 256KiB`。
- 单项 text/thinking 各 ≤64KiB，按 UTF-8 码点截断，带 `truncated`/`originalBytes`。
- `view.history = { total, oldestIncluded, cursor }`。
- `history.page { sessionId, cursor, limit? }` → 定向事件；与 attach 同等授权，任何成员角色可读；错误固定类别、只回发起连接；不进审计。
- 游标 `v2.<idx>.<anchorId>.<hmac32>`：HMAC-SHA256 覆盖 sessionId + idx + 锚（`messages[idx-1].id`），密钥每 Session 实例内存随机。
  - 验签失败 →“游标无效（固定类别）”；锚失配或越界 →“游标已失效，请重新接入（固定类别）”，不返回数据。
- 客户端：web“加载更早”、attach `/older`；reducer 向前 prepend，按 id 去重（含页内）。

## 取舍

- 游标密钥不持久化：网关重启或会话回收后旧游标失效，客户端重新 attach 取新尾页。
- cursor 必填；history.page 不进审计（高频只读）。
- 分页错误按 message 含“固定类别”识别为已知错误、原样保留；其余统一为“历史分页失败（固定类别）”。
- `GatewayConfig.sessionProbe` 是仅测试配置的缝，生产不配置即无行为。
- 大历史测试的测试实例调高 `limits.maxCommandsPerSecond`（单连接连发 25 条 prompt 会触发既有限流 1008）；生产默认值未改。

## 遗留 / 残余

- **tools 数组未裁剪（P2）**：工具密集的长会话 attach 仍可能撞 maxFrameBytes 1009；handoff §3.2 的“单工具展示输出 ≤64KiB”尚未接线。下一片用同一出口裁剪。
- 压缩恰好只移除一条前缀时，锚位置可能巧合同 id，存在低概率错位窗口（影响 ≤1 条）。
- 溢出重快照会替换客户端已翻到的更早历史，需要重新翻页。
- 客户端 `history.total` 依赖增量同步，错过增量时以最近快照/分页应答为准。
- 本轮全量中出现一次 Docker daemon 卡顿（docker ps/rm 超时），four-eyes 测试泄漏 1 个自有容器，已手动清理；这是既有的 reconcile 残余（daemon 卡住时清理超时不会自动重试）。
