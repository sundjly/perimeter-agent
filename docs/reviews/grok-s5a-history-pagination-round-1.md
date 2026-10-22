# S5a 复审 round-1：s5-history-pagination（HEAD d04d4d9，工作区 diff 11 文件）

**结论：request_changes（1 项必需）**。授权、游标密码学、定向发送、出口裁尾、客户端去重、fixture 与测试真实性均核实通过；唯一必需项是游标对"权威数组重构（压缩）"没有检测，会在压缩边界后静默返回错位内容。中间问题①—⑤的处理如实、恰当。

## R1（必需）：游标未绑定数组结构，压缩后静默错位

`session.ts #mintCursor/#verifyCursor` 的 HMAC 只覆盖 `sessionId+idx`，正确性依据是注释里"权威 messages 数组追加-only"。该前提被 durable 压缩打破：`pi-durable/dist/harness/view.js:132-138` 在压缩条目落 view 时执行 splice（`entries = [summary, ...entries.slice(kept)]`，前缀被移除），且摘要条目 id 大于全部保留条目却排在最前。后果：

- 压缩前签发的游标 `idx ≤ 新 total` 时验签通过、`idx` 指向完全不同的条目 → 分页静默返回错位内容（客户端按 id 去重后表现为缺项/空页，无任何错误）；`idx > 新 total` 时才得到"游标无效"。压缩阈值 32768 tokens（handoff §4.1）在本片针对的长会话里是常态路径，不是边角。
- 附带：增量维护的 `#view`（客户端 reducer 路径，压缩只产生 message_start/end）与 fresh attach 重建的数组（摘要在前、前缀已删）不一致，重叠窗口内的 total/oldestIncluded/idx 全部漂移。

任务书明确要求"游标基于稳定 id/序号而非偏移"，现实现是偏移+一个不成立的不变量。修复很小：签发时把锚点编入 HMAC，例如 `update(`${sessionId}\u0000history\u0000${idx}\u0000${messages[idx-1]?.id ?? ""}`)`，验签时要求 `messages[idx-1]` 存在且 id 相等；追加不移动 `idx-1` 位（不受影响），压缩/重构则得到干净的固定类别"游标无效"。测试建议：`publish()` 注入一次重构后的 `session.snapshot`（模拟压缩），断言旧游标得固定类别拒绝、无错位条目下发。

## 逐项核验（按任务问序）

1. **授权**：与 attach 同门——`opts.isAuthorized` 在命令入口统一检查（server.ts:2433），`roleOf` 放行 viewer；unshare/撤权即 4003 断连（server.ts:2475、2410），`broadcast` 定向发送时再次过 `#isAuthorized`（server.ts:2537），签发与应答之间撤权也拿不到数据。跨会话/不存在会话统一"会话不匹配（固定类别）"，且连接与会话一一绑定，无存在性泄漏。不进审计与 attach 现状一致。✓
2. **游标**：HMAC-SHA-256 截 128bit + 每会话内存随机密钥 + timingSafeEqual，抗伪造充分；regex 限 `v1.\d{1,12}.hex32`，负数/超长/越界（idx>total）固定拒绝，idx=0/idx=total 语义安全但正常签发不可达。重启失效换"导航态不持久化"可接受（注释已述，客户端重 attach 自愈）。密码学层面无问题；结构层面见 R1。
3. **一致性**：snapshotFrame 的 seq fence（读 seq→构建→复核重试）+ #emit 先 reduce 后发送 + Outbox FIFO，快照与增量不重叠不缺漏；溢出重快照为权威替换语义。message.end 原地换 id 前先滤掉同 entryId 旧项（view-model.js:34），reducer 与 attach 的 id 去重链闭合；分页只服务 `< idx` 的已完结条目，"live" 永不入页。压缩除外（R1）。
4. **字节上限**：`maxBytes ≤ maxFrameBytes-256KiB` 的余量覆盖尾页越界（单项 ≤64KiB+64KiB）与 audit(≤100)/approvals/participants/usage 等固定字段，**不覆盖 tools**：tools 数组条目数无界（单项受 vendor 工具默认 50KiB/2000 行截断），2MiB 帧减去 ~1.15MiB 尾页预算后约容 16 条满额工具输出，长工具密集会话 attach 仍会撞 1009。**定级 P2 残余**：非本片回归、handoff §3.2"单工具展示输出 ≤64KiB"本就未接线，但 S5"长会话内存有界"目标对工具密集场景未达成，须记入残余并在下片用同一出口裁 tools（项数+字节）。
5. **错误识别③**：`message.includes("固定类别")` 识别已知拒绝——抛点仅 #historyPage 两处、fallback 本身也是固定类别，重构失配的退化方向良性（specific→generic），可接受；建议后续换哨兵常量/错误码。定向发送正确：应答与错误都走 `#opts.send(..., from)`，测试断言了同会话其他连接零收到。✓
6. **客户端**：reducer 页内+跨页按 id 去重、meta 以应答为准、message.start 同步 total、快照替换语义自洽（FIFO 下无乱序覆盖问题）；web"加载更早"textContent+onclick 属性赋值，无 innerHTML/inline 属性，CSP 约束不变，错误后按钮不复卡。CLI /older 与截断标记打印正确。✓
7. **fixture**：非 `@` 前缀路径行为逐字不变，`@file` 仅测试使用。✓
8. **测试真实性**：真实 Gateway+WS+mock-model 全链路；帧字节断言、页边界链式衔接断言、撤权 4003、限流仅调测试实例（生产默认 20/s 未动、代码内已注明理由）均成立；无既有断言放宽（protocol-coverage 23→24 有理由）。TAP 证据核实：history-pagination 3×7/7 零 not-ok，all2 全绿。例④改"逐页翻到底"后全集一致性断言保留，守护性质未变。✓

## 非阻塞备注

- 溢出重快照/重连会把客户端已翻到的更早历史替换为尾页（可再点"加载更早"恢复），建议在 handoff 或 README 记一句语义。
- 压缩摘要条目以大 order 的 user 消息进入视图，增量端排尾部、fresh 端排头部（既有 reducer 排序行为，非本片引入）。
- `#historyPage` 无内部 await，天然串行，无并发页竞态；`idx==total` 放行无害。

**复审证据**：/tmp/perimeter-exec-s5-aVZ2UJVe/history-pagination.v31{,2,3}.tap（7/7×3，0 not-ok）、all2.txt（66 文件 851/851）、s5a-code.diff 全文 + vendor pi-durable view.js/compaction.js/events.js、truncate.js（工具输出 50KiB 上限）核读。变异声明（去验签→例6 败、不裁尾→例3-7 败）与测试设计相符，未复跑（本审只读）。
