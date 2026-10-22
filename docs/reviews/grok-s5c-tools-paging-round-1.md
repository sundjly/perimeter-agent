# S5c 复审 round-1：tools 分页与合计校验（HEAD 9a603d8，工作区 diff 10 文件）

**结论：approve**。S5b 两个非阻塞残余均已闭环：① 构造期按生效值校验 `historyTail.maxBytes + toolsTail.maxBytes + 256KiB ≤ maxFrameBytes`（server.ts:345-353，单项合法合计超限启动即抛）；② 被裁旧工具经 `tools.page` + `t2` 游标回看，与 history.page 逐行同构（session.ts #toolsPage vs #historyPage），reducer/web/attach 三端齐备，protocol-coverage 24→25。本审只读（未复跑任何测试），工作区 10 文件与 s5c-code.diff 逐字一致（已比对）。

## 逐项核验（按任务问序）

1. **合计校验**：取生效值（`cfg ?? DEFAULT_*`，只配一项时另一项按默认参与）——只配 historyTail=1792KiB 被正确拒绝（默认 tools 512KiB 参与合计），测试双向覆盖。位置在单项校验后、production 校验前，抛错不占锁/审计资源。余量 256KiB 充分且用在刀刃上：tail 字节预算按 `JSON.stringify` 实算（转义已计入），「最新一项恒保留」的越界只在单项本体超过 maxBytes 时发生——合计校验管辖的近满配区（sum 接近 maxFrame-256KiB）越界项恒被预算吸收，帧 ≈ sum + 固定字段；固定字段实测量级小（audit ≤100 条且 summary 有界：prompt 只记字符数、路径/命令截 80 字符，见 harness-host.ts:162/perimeter-extension.ts:77）。默认 1.75MiB < 2MiB 必过；historyTail=1.5MiB + 默认 tools = 恰好 2MiB 零余量被正确拒绝。无误拒常见配置。边界注记（非阻塞）：判据用 `>` 允许恰好取满，与单项校验同一约定；maxItems 比 maxBytes 收得更紧时按 maxBytes 保守拒绝（静态粗界，报错文案可操作）。
2. **tools 游标**：跨种类双层隔离——形状层 `v2`/`t2` 正则在 parseCommand 互斥（双向测试钉住）+ HMAC 域分隔（`sessionId\0history|tools\0idx\0anchor`，同钥不同域，绕过形状也过不了验签）。锚 = `tools[idx-1].callId`（权威 #view，与签发同源；idx=0/idx=total 均不可签发）。稳定性论证成立且比注释更强：`tool.end` 的 order 取 durable 账本 entry id（translate.ts:150，完结顺序单调递增），后完结者排序恒在已完结前缀之后 → **已完结前缀只增不移，前缀内锚永不漂移**；进行中 MAX order 项恒排尾且尾页恒保留最新项，常态永不成锚。权威数组其余变化只有整替（快照），由锚点核对检出。不漏不重：每页至少一项保证前进、链式游标锚逐页核验，逐页翻到最早与权威 13 项（含 live）全集全等断言、重构后旧游标零数据拒绝 + 新游标全集全等断言均在。
3. **授权与定向**：与 history.page 同一分支同一纪律——每连接限流 → parseCommand → isAuthorized 资源门 → roleOf（viewer 可读，测试覆盖）→ sessionId 核对（模板化文案对 history.page 逐字节不变）→ session.handle 内 isAuthorized 复查 + 未就绪固定拒绝；应答与错误均 `#opts.send(..., _from)` 定向、不广播（测试断言 owner 零错误）、不写命令审计（S5a 同理由）；撤权 4003 即断（测试覆盖）。
4. **reducer/web/attach**：tools.page reducer 与 history.page 同语义（callId 去重含页内、prepend、元信息以应答为准）；initialState 增 `toolsHistory: null`；tool.start/end 的 total 同步保留 cursor（追加不动锚）。web 按钮紧随历史按钮（order -Infinity 稳定排序）、disabled/guard/失败复位齐备；textContent + onclick 属性赋值，无禁用 API（web-injection 6/6，见中间问题①）。attach `/older-tools` 与 `/older` 同构，快照|分页共用 shownTools 去重打印。
5. **既有断言改动**：全部是收紧——deepEqual 改为逐字段 equals + cursor 形状/锚正则钉死（旧断言遇 cursor 字段本就必炸，改动是被迫的）；唯一配置改动（注入形 toolsTail.maxBytes 1MiB→512KiB）是合计校验的必然结果且已在注释披露，该用例字节上限由 maxItems=2 绑定、断言语义不变；protocol-coverage 24→25 属声明的协议新增，注释说明到位。
6. **其他放宽**：无。未触 vendor/依赖/bounded-runner/限流/审计/授权/字节上限；DEFAULT_* 导出与 handle 白名单扩充均为必要增量；错误文案模板化对 history.page 输出不变。

## 中间问题

- ① app.js 注释含被禁 API 名：已按「改注释」收敛（守护测试明确不过滤注释、注释提禁词本身就该停下看的策略写在测试里），web-injection 全量绿。
- ② 测试锚点期望差一位：现期望与 idx-1 公式逐一手工复核相符（3 工具/tail2 → t2.1.t0；12+live/maxItems4 → t2.9.c8；260 → t2.60.c59），实现（锚=覆盖范围最新完结工具）与 history 公式同一，改测试方向正确。
- ③ server.ts:334 错字「兑底」（应为「兜底」）：确认在场。**判定：不阻塞**——纯注释、零行为/测试影响、语义可读。建议协调方让 Pi 直接改这一处一个字，typecheck 即可，无需回炉重审。

## 协调方补充边界核对

**① maxItems=1 / 字节预算 < 单项时进行中工具成锚**：成立，注释「永不成为锚」在该退化配置下不真。推导：tail 容量仅 1 时最新被裁项 = 倒数第二项，多个 MAX order 工具并存时它就是进行中工具，快照照常签发 `t2.<total-1>.<该live工具>`。行为逐路径核过，全部安全：order=账本完结序 → 锚工具自身先完结时恰好落位在自己原位（前缀末端推进进它的槽位）→ 游标仍有效、翻页返回其终态内容；同块更早的 live 工具先完结时插入前缀末端 → 锚后移一位 → 锚失配固定 stale（零数据）；被中断工具（tool.end 无 entry 得 MAX order，translate.ts:150）留在尾部，其后若补真实结果移动 → 同走 stale。**任何路径都无静默错位、无重复、无缺漏**——页∪尾=按当前权威下标的连续区间，锚钉住边界。结论：行为 fail-closed 可接受；注释措辞需改为「常态（tail 容量 ≥ 并发进行中工具数）永不成锚，退化配置下可成锚且失配必走固定失效」。属注释修正，与错字一并处理。

**② provider callId 字符集/长度 vs verify 正则**：真实风险低但存在不对称。锚来源不对称——history 锚是 `String(账本 entry id)`（纯数字，恒兼容）；tools 锚是 provider 侧 `toolCallId`（harness 经 translate 透传，repo 不合成、无出口校验）。主流 provider 实测形态均落在 `[A-Za-z0-9_-]{1,64}`：OpenAI `call_`+24 base62（~29 字符）、Anthropic `toolu_`+base62/下划线（~30 字符）、Gemini 系 SDK 合成 id（UUID 连字符/f-N）亦兼容；点/冒号形态现网无先例。若未来 provider/代理产出越规 id：工具事件、渲染、审计全链路无字符集约束照常工作，仅当它恰好成为被裁锚时，签发出的游标被自家正则拒收 → 「游标无效」固定拒绝，**该边界处分页自锁（可用性问题，fail-closed，无伪造面——HMAC 覆盖原文，客户端改不动）**。建议记台账：后续在 translate 边界对 callId 做出口规整（不合规则固定类别报错或改用账本 id 作锚），本轮不动。

## 证据

tools-bounded.v21/22/3.tap 均 12/12 fail=0（已读盘核实）；all2.txt 67 套件合计 859/859 fail=0（逐行求和核实）；变异映射与文件序号吻合（例6=合计校验、例11=前缀重构）。本审未复跑测试。

## 残余台账（非阻塞，均为既有边界）

- 病态转义膨胀下最新单项可越名义预算（S5b 已记录，与 messages 同界；合计校验管辖的是近满配区，二者正交）。
- 前缀重构恰好移除 1 条时锚点存在巧合命中窗口（S5a 残余，HMAC 折叠首项的可选加固未采纳，tools 同此界）。
- 退化配置（maxItems=1 / 字节 < 单项）下进行中工具可成锚：失配必走固定 stale（见补充核对①），注释措辞需软化。
- provider callId 越规（点/冒号/>64）时该边界分页自锁（fail-closed；建议后续在 translate 边界规整，见补充核对②）。
- 合计校验为名义静态界：恰好取满允许、maxItems 更紧时保守拒绝（报错可操作）。
