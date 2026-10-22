# S5b 复审 round-1：s5-tools-bounded（HEAD e2d69a6，工作区 diff 7 文件）

**结论：approve**。S5a P2 残余（tools 未裁剪）已闭环：快照 tools 出口尾部裁剪（默认 200 项 / 512KiB，双上限取更严、最新一项恒保留）、单工具 output/command/path 各 ≤64KiB 确定性截断、增量 tool.progress/tool.end 出口截断、toolsHistory 元信息、web/CLI 截断标记渲染。只裁出口：`#emit` 先把全量事件 reduce 进权威 `#view` 再裁发送（session.ts:597 在 reduce 之后），`#boundedTools` 只读不改，durable 与模型上下文不经过本层，无权威状态影响。

## 逐项核验（按任务问序）

1. **帧预算**：默认合计 ≈1.76MiB（messages 1MiB + tools 512KiB + 最新消息单项越界 ~130KiB + 最新工具单项越界 ~100KiB + audit ≤100 条 ~30KiB + 信封）< 2MiB，真实余量 ~240KiB。字节预算逐项按 `JSON.stringify` 后实算（转义已计入），越界只可能来自"最新一项恒保留"。两处残余如实：① `historyTail.maxBytes` 与 `toolsTail.maxBytes` 各自独立校验 `≤ maxFrameBytes-256KiB`，**之和未在构造期校验**，双超配置会回到必然 1009——注释已声明由配置者保证，可接受但建议下片加一行合计校验（~3 行）；② 病态控制字符内容（JSON 转义 ~6×）下最新单项理论可到 MiB 级，Pi 说明已记录，与 S5a messages 同一既有边界，非本片引入。
2. **出口裁剪**：见上，权威与模型侧零影响。未超限事件原样透传不加字段（帧逐字不变，正控用例断言了无 truncated/originalBytes 键）。
3. **originalBytes 两层口径**：ToolView 级 = output+command+path 未裁之和，事件级 = 本事件 output 单字段；types.ts 注释明确、注入用例断言两层数值（300KiB+3 vs 300KiB），reducer 随事件/快照整替且无标记时删键（不留过期标记、无 undefined 幽灵字段，单元用例钉住）。各自自洽，不误导。
4. **reducer total 同步**：tool.start 新 callId 或 tool.end 补建缺失工具时 `toolsHistory.total+1`（替换同 callId 不计），快照整体替换覆盖；服务端 `#outboundView` 每次从权威数组实算 total/oldestIncluded，客户端漂移只存在于两次快照之间且被增量同步压平。中间问题①（gateway.test 2 例回归）定位为 reducer 真缺陷、以生产修复收敛，全量绿。
5. **不做 tools 分页**：成立——history.page 游标锚定消息 id，tools 含进行中 MAX_SAFE_INTEGER order 项、生命周期不同；本轮按任务允许交付元信息（total/oldestIncluded），types.ts 写明取舍。注意 UI/CLI 暂无任何 toolsHistory 展示面（协议先行），旧工具内容本轮不可回看，已记残余。
6. **渲染**：web 工具卡截断文案拼进 `node("pre", ...)` 的 textContent，CLI `print` 走既有控制字符剥离，无 innerHTML/事件属性，CSP 约束不变。
7. **测试真实性**：真实网关+mock-model tool_calls；48 轮 ×1MiB 真实 bash（`head -c 1048576 /dev/zero | tr '\000' x`）驱动全程无 1009、逐帧 <128KiB 断言、attach 快照帧 <2MiB、元信息链式衔接且 `oldestIncluded > 0` 证明字节预算真实裁切；截断标记走 sessionProbe 注入形（vendor 50KiB 窗口撞不到 64KiB，注入理由成立、与 S5a2 同缝同披露）；限流仅测试实例调高（生产 20/s 未动，S5a 先例）；144 = 48×3（用户+带 tool_call 助手+收尾助手，toolResult 入 tools）推算已修正且与 snapshotView 口径一致。
8. **无放宽**：7 文件与两轮间增量比对无授权/审计/字节上限松动；`#clipField` 重构语义逐字不变；`view.messages ?? []` 容错仅为注入形部分视图兜底，生产行为不变；既有断言零放宽（view-model 深度相等依赖"未截断不加字段"，实现即如此）。

## 证据与中间问题

tools-bounded.c1-3.tap 5/5 ×3 零 not-ok；b1-3.tap（3/2）为变异运行留痕（去 tools 裁剪 → 例 3/5 失败），与声明一致；all6.txt 67 套件全 fail=0。typecheck0 未复跑（本审只读）。中间问题②③④（口径统一、96→144、类型收窄）均如实且收敛正确。

## 残余台账（非阻塞）

- 双 `maxBytes` 合计无构造期校验（注释约定，建议合计校验一行）。
- 病态转义膨胀下最新单项可越名义预算（与 messages 同界，Pi 已记录）。
- toolsHistory 仅协议层，无 UI 回看被裁旧工具的途径；分页待需要另设计。
- 真实链路的截断标记端到端不可达（vendor 50KiB < 64KiB），标记逻辑靠注入形覆盖——vendor 默认变化时该用例即失效，届时真实路径自然接管。
