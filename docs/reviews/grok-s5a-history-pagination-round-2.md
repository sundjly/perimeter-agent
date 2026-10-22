# S5a 复审 round-2：s5-history-pagination 修复验证（HEAD d04d4d9 工作区，11 文件）

**结论：approve**。R1（游标绑定权威数组结构）已闭合：游标升 `v2.<idx>.<anchorId>.<hmac32>`，HMAC 覆盖 `sessionId+idx+anchor`（timing-safe），`#historyPage` 在验签后核对 `messages[idx-1].id === anchor` 且 `idx ≤ total`，失配 → "游标已失效，请重新接入（固定类别）"定向发回、零数据下发。"追加-only"错误前提表述已全部删改（session.ts 注释、types.ts SessionHistoryMeta、测试文件头）。测试、运行证据与变异声明核实一致。

## 锚点边界核查（按问序）

1. **压缩后 idx-1 巧合同 id**：splice 后 `new = [summary(新大 id), old[kept..]]`，位置 `idx-1` 对应 `old[kept+idx-2]`，与锚（`old[idx-1]`）重合仅当 `kept == 1`（恰好只压缩掉第 1 条前缀）。该窗口内旧游标仍通过核对，页内容变为摘要+后移一条（真实历史、无伪造无泄漏，最多静默缺 1 条）；`kept ≥ 2` 或 `idx ≤ kept` 一律失配拒绝。**记为低概率低影响残余，不阻塞**——如后续想彻底封死，可在锚上再拼 `messages[0].id`（数组首位锚，kept==1 时必变）。
2. **live 消息**：两个签发点（`#outboundView` 尾页非空 ⇒ `oldestIncluded ≤ total-1`；`#historyPage` 页非空 ⇒ `start ≤ idx-1 ≤ total-2`）的锚位都 ≤ total-2，"live"（恒在末位）不可成为锚；`idx==total` 的游标无从签发。mint 处 `?? ""` 为防御性冗余，idx=0 游标因 anchor 空串无法过 `parseCommand` 形状，双保险成立。
3. **message.end 原地换 id**：换 id 只发生在流式末位项，锚位（≤total-2）从不被改名；共享 reducer 的 order 排序对已完结条目稳定（entry id 单调），既有锚位不漂移。✓

## sessionProbe 缝

`GatewayConfig.sessionProbe?: (session: Session) => void`，仅在建会话处 `this.#cfg.sessionProbe?.(session)` 一次（server.ts:1388 附近）。生产不配置即 no-op，零行为零授权面变化；配置本身是进程级信任（与 createStageProbe 同先例同权限），publish 是网关自己调用的公开路径，无缝外授权旁路。可接受。

## 模拟忠实度

例 8 的注入形状逐点对照 vendor `view.js:132-138`：splice 掉前缀（10→去前 4）+ 前置大 id（900001 > 全部）user 角色摘要，与真实压缩产物同构；投递走 `publish(session.snapshot)`，与 durable 溢出重快照到达 `#emit` 的路径一致。不可确定性触发真实压缩（32768 token 后台决策）的理由成立，注入法为最小仅测试可达。断言紧：旧游标（签名真实、锚漂移）得"游标已失效"且零 history.page 事件；重构后 fresh attach 的 total/尾页/翻页全集与重构数组逐 id 全等、无旧前缀复活。

## 其他改动与放宽核查

两轮 diff 精确比对：改动仅落在 server.ts（probe 缝）、session.ts（游标 v2）、types.ts/validate.ts（注释+CURSOR_SAFE v2）、history-pagination.test.ts（v2 用例+例 8），attach/web/labels/mock-model/protocol-coverage 零变化，无新增文件，vendor/依赖/bounded-runner 未动。parseCommand 形状升级同时硬拒旧 v1 格式（断言只增不放宽）；篡改/伪造/跨会话用例随 v2 同步加强；protocol-coverage 钉值保持 24。

## 证据

/tmp/perimeter-exec-s5-aVZ2UJVe/history-pagination.v41{,2,3}.tap：8/8 ×3、零 not-ok；all4.txt：protocol-coverage 4/4、view-model 5/5 等全绿（66 文件 851/851）。变异声明（去锚点核对 → 例 8 失败）与例 8 断言设计相符，未复跑（本审只读）。工作区与 s5a-code.diff 一致（git status 复核）。

## 残余台账（非阻塞）

- P2（沿用 round-1）：tools 数组未裁剪，工具密集长会话 attach 仍可撞 1009；handoff §3.2 单工具展示 ≤64KiB 未接线，后续片用同一出口裁剪。
- kept==1 锚位巧合窗口（见上，影响 ≤1 条 + 摘要项）。
- v1→v2 格式升级使升级瞬间在途旧游标得固定"游标无效"，客户端下次快照自愈（本仓库未发布，无实际迁移面）。
