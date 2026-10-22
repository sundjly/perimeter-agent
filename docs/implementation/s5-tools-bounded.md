# S5b 快照 tools 出口有界（commit `e2d69a6` 基础上）

依据：`docs/handoff.md` §3.2（单工具展示输出 ≤64KiB）；S5a 复审 round-1/round-2 的 P2 残余（tools 数组未裁剪，工具密集长会话 attach 仍可撞 maxFrameBytes 1009）。
实现：S5b 任务书（快照 tools 项数+字节双上限、增量工具事件单工具 64KiB 截断、tools 元信息、客户端 truncated 标记、tests/tools-bounded.test.ts）。

## 已实现

- **快照 tools 出口有界**：`Session.#boundedTools` 与 messages 同一思路——从尾部（最新）向前收集，项数（默认 200，可配 `toolsTail.maxItems`）与序列化字节（默认 512KiB，可配 `toolsTail.maxBytes`）双上限取更严；最新一项恒保留。只裁出口：服务端权威 `#view` 与模型上下文不变。
- **单工具展示字段 ≤64KiB**：`#clipTool` 对 output/command/path 各按 `HISTORY_MAX_ITEM_BYTES`（64KiB）UTF-8 码点边界确定性截断，带 `truncated`/`originalBytes`（原始字节=各展示字段未裁前之和，与 MessageView 同口径）。增量事件上的 originalBytes 只指本事件被裁的 output 字段（事件不含 command/path，两个层面各自自洽，types.ts 已注明）。messages 的裁剪重构为同一 `#clipField`，语义逐字不变。
- **增量工具事件截断**：`tool.progress`/`tool.end` 的 output 超 64KiB 时同样确定性截断并带标记；未超限原样透传（不加字段）。progress 是累计快照，不裁则一个多 MiB 的 bash 输出即撞 2MiB 帧上限被 1009 断连。内部 `#view` 先吃全量再裁出口，权威状态不变。
- **tools 元信息**：快照带 `toolsHistory: { total, oldestIncluded }`（权威 tools 总数与尾页首项下标）。reducer 在新工具进入视图时同步 total+1（与 message.start 同步 history.total 同一语义，替换同 callId 不计），否则客户端持有的 total 在下一次快照前是陈旧的。本轮不做 tools 分页：history.page 游标绑定 messages 数组结构（锚点=消息 id），tools 语义不同（含进行中的 MAX_SAFE_INTEGER order 项、与 durable 压缩交互不同）；元信息先行，协议先于 UI/分页。
- **客户端渲染**：网页工具卡与 CLI attach 在截断的工具后追加「（已截断，原始 N 字节）」，textContent 拼接，CSP 约束不变；reducer 增量维护截断标记（事件不带标记时删除键，不留过期标记、不产生幽灵字段）。

## 预算分配

`maxFrameBytes`（默认 2MiB）下的快照帧预算：messages 尾页 ≤1MiB（S5a 不变）+ tools 尾页 ≤512KiB（新增）+ 单项截断余量（messages 单项 text+thinking ≤128KiB、tools 单项三字段合计 ≤192KiB，序列化字节逐项实算，只有「最新一项恒保留」可越预算）+ 固定字段（audit ≤100 条、approvals/participants/usage/history 元信息，≤256KiB 量级）。默认值合计留有 < 2MiB 的余量。构造期校验与 historyTail 同尺（正整数；`maxBytes ≤ maxFrameBytes - 256KiB`）；两处同时调大时的合计预算由配置者保证（配置注释即约定）。

## 取舍

- **不依赖 vendor 输出窗口**：pi-durable 的 bash/read 工具默认把最终结果截到 50KiB/2000 行，流式窗口也受 OutputBuffer 约束；但那是 vendor 默认值而非本层契约。handoff §3.2 的「单工具展示 ≤64KiB」在 perimeter 出口接线，vendor 默认变化不再静默放大帧。
- **command/path 也裁**：二者来自模型参数，现受 maxTokens 约束（≈≤32KiB）撞不到 64KiB，但出口裁剪是确定性防线，成本可忽略。
- **事件 action 不裁**：`tool.start/end` 的 action 同源（模型参数），增量事件的 1009 风险在 output（progress 累计快照），已覆盖。
- **toolsHistory 不进分页**：见上；客户端缺省容忍（与 `history` 同一漂移语义）。
- 测试实例按需调高 `limits.maxCommandsPerSecond`（既有每连接限流 1008 会打断多轮 prompt 驱动），生产默认 20/s 未动。

## 验证

typecheck 0；tools-bounded 连跑全绿（注入形确定性用例 + 真实 bash 多 MiB 会话）；全量套件无回归；既有断言零放宽（view-model 的工具卡深度相等断言依赖「未截断不加字段」，实现即如此）。

变异均被抓住：去掉 tools 项数/字节上限 → 大会话快照帧超 2MiB、连接 1009 断连；去掉增量 output 截断 → 注入用例的大 progress 帧失去标记与上限。

## 遗留 / 残余

- 病态内容（控制字符 flood 导致 JSON 转义膨胀至 ~6×）下，「最新一项恒保留」的单项可能显著超过名义 64KiB——与 messages 同一既有边界（序列化字节实算使预算本身精确，越界只可能是最新单项）。
- tools 无分页：被裁掉的旧工具本轮只能看 `toolsHistory.total/oldestIncluded` 元信息，不可回看内容；需要时按 messages 游标思路另设计 tools 游标（注意进行中工具的 MAX order 语义）。
- 增量 `message.text`/`message.end` 未裁：模型文本输出受 maxTokens（8192）约束 ≈≤32KiB，撞不到 64KiB，不构成 1009 风险。
- 测试对 vendor 50KiB 窗口的依赖仅存在于「真实 bash 大输出」用例的量级预期（输出 ≤64KiB 断言）；确定性断言全部走注入形，不依赖 vendor 默认值。

## 验证与提交（commit `9a603d8`）

- 协调者实跑：typecheck 0；tools-bounded 5/5 连跑 3 次；全量 67 文件 859/859；无残留。
- 变异检验：tools 出口不裁 → 例 3-5 失败；增量事件不截断 → 例 3 失败。
- 中途修复：
  - reducer 未同步 `toolsHistory.total`，导致 gateway.test 2 例回归（生产缺陷）；
  - originalBytes 口径统一为字段之和；
  - 工具轮 messages 数的测试推算错误（96 → 144）。
- 复审：`grok-s5b-tools-bounded-round-1` approve。默认帧预算约 1.76MiB，低于 2MiB。

## 复审残余（非阻塞）

- `historyTail.maxBytes + toolsTail.maxBytes` 的合计未做构造期校验，目前只靠注释约定。两者同时调大时可能撞 maxFrameBytes。建议补一行合计校验。
- 病态转义膨胀下，最新单项可能超过名义预算（与 messages 同一边界）。
