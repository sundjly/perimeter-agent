# S5c 实现记录：tools 分页与合计预算校验

改动面：`src/gateway/session.ts`（`#boundedTools`/`#outboundView`/`#mintToolsCursor`/`#verifyToolsCursor`/`#toolsPage`）、`src/gateway/server.ts`（合计校验）、reducer/web/attach 三端接线。复审：[grok-s5c-tools-paging-round-1](../reviews/grok-s5c-tools-paging-round-1.md)（Grok，HEAD 9a603d8，**approve**；本审只读，未复跑测试）。

## 机制

### tools.page 与 t2 域分离

- 被裁旧工具经 `tools.page` + `t2` 游标回看，与 `history.page` 逐行同构（session.ts `#toolsPage` vs `#historyPage`），reducer/web/attach 三端齐备，protocol-coverage 24→25。
- 跨种类双层隔离：形状层 `v2`/`t2` 正则在 parseCommand 互斥（双向测试钉住）+ HMAC 域分隔（签名覆盖 `sessionId\0history|tools\0idx\0anchor`，同钥不同域）——绕过形状校验也过不了域分隔验签。
- 锚 = `tools[idx-1].callId`（权威 `#view`，与签发同源；idx=0/idx=total 均不可签发）。不漏不重：每页至少一项保证前进、链式游标锚逐页核验；逐页翻到最早与权威全集（含 live）全等断言、重构后旧游标零数据拒绝 + 新游标全集全等断言均在。

### 合计名义预算校验

- 网关构造期按**实际生效值**（`cfg ?? DEFAULT_*`，只配一项时另一项按默认参与）校验 `historyTail.maxBytes + toolsTail.maxBytes + 256KiB ≤ maxFrameBytes`；单项合法、合计超限启动即抛。
- 位置在单项校验后、production 校验前，抛错不占锁/审计资源。余量 256KiB 为固定字段（audit ≤100 条且 summary 有界）与「最新一项恒保留」预留空间；该名义校验不证明任意自定义配置、JSON 转义与单项越界下的绝对帧上限。判据用 `>` 允许恰好取满，maxItems 比 maxBytes 收得更紧时按 maxBytes 保守拒绝（静态粗界，报错文案可操作）。

## 验证

- tools-bounded 12/12 × 3（tools-bounded.v21/v22/v23.tap 均 12/12 fail=0，已读盘核实）。
- 其余 67 个测试文件合计 859/859（all2.txt 逐行求和核实）；总计 68 文件 871 测试全绿。
- 变异测试两项有效变异，映射与文件序号吻合：例6=合计校验、例11=前缀重构（复审逐项核验通过）。

## 复审与收尾（本次）

- Grok round-1 approve：S5b 两个非阻塞残余（合计校验、tools 游标回看）均已闭环。
- server.ts 注释错字「兑底」→「兜底」（复审中间问题③，纯注释、零行为/测试影响）。
- session.ts 注释软化（复审补充核对①）：原文「进行中工具永不成为锚 / 只随尾页下发 / 分页范围恒为已完结前缀」过强，改为——常态（尾页容量 ≥ 并发进行中工具数）下上述成立；尾页容量不足（如 maxItems=1 或字节预算 < 单项）时进行中工具可被裁出尾页并成为锚，并行完结（更早 live 工具先完结插入前缀末端）可能使锚后移失配（锚工具自身先完结则恰落回原位、游标仍有效），任何失配由锚点核对检出、固定 stale 要求重新接入。行为本身经复审逐路径核过 fail-closed（无静默错位/重复/缺漏），只改注释不改行为。

## 残余台账（非阻塞）

| 残余 | 说明 | 定性 |
|---|---|---|
| 越规 callId 分页自锁 | 锚为 provider 侧 `toolCallId`（经 translate 透传，repo 不合成、无出口校验）。当前适配器/测试工具 ID 的已核查形态落在 `[A-Za-z0-9_-]{1,64}`，未对所有真实 provider 作实测保证；若未来 provider/代理产出越规 id（点/冒号/>64）且恰好成为被裁锚，签发出的游标被自家正则拒收 → 该边界分页固定拒绝。工具事件/渲染/审计全链路照常；fail-closed、无伪造面（HMAC 覆盖原文）。后续可在 translate 边界做出口规整，本轮不动 | 可用性残余 |
| 病态 JSON 转义膨胀 | 转义膨胀下最新单项可越名义预算（S5b 已记录，与 messages 同界；合计校验管辖近满配区，二者正交） | 名义预算边界 |
| 多工具同时执行 | 退化配置（maxItems=1 / 字节 < 单项）且多工具并发进行中时，进行中工具可成锚；并行完结可能使锚移动 → 失配固定 stale（零数据）、要求重新接入。常态配置不触发，注释已按此软化 | 可用性残余 |
| 前缀重构巧合命中 | 前缀重构恰好移除 1 条时锚点存在巧合命中窗口（S5a 残余，HMAC 折叠首项的可选加固未采纳，tools 同此界） | 既有边界 |
| 真实模型限制 | 本轮验证基于 mock 模型与构造测试；真实模型通道未实证，复审只读未复跑测试 | 验证边界 |
