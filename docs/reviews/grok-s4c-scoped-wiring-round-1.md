# S4c 复审第 1 轮：会话级 scoped 模型凭证签发接线 + S4b note 修复

- 日期：2026-10-22。只读复审，未运行任何测试/进程。基线 HEAD 808e31f；对象 s4c-code.diff（8 文件）；验收依据任务书与 handoff §4.3 第一条、本席 S4b 轮 3 条 note。

## 结论：approve

## (1) 签发与密钥边界：通过

归属三元组全部取服务端会话归属：Session 创建时 `actor: metadata.owner`（生产=验证后的 owner principal；server.ts:~1316）、team=resolveScope 配置、sessionId=网关生成；mint 闭包只捕获密钥与这三个值，请求头/沙箱输入零参与。启动期先以 isSafeScopedIdentityValue（与 verify 同一把 ID_FIELD 尺）做可签发性校验，坏归属会话启动即 fail-closed（测试钉死：零账本行）。TTL 10min 常量+理由注释，tokenProvider 每次模型调用重签。密钥面：key 只存在于网关进程（构造期 Buffer 归一），模型 Authorization 上行的是 mint 出的 token 而非密钥；models.ts 的 tokenProvider 为函数不可序列化，密钥进不了 HarnessHost 持久化；测试 (b) 对网关审计、modelgw 审计、客户端事件三面断言密钥 hex/base64url 双形态与静态 proxyToken 原文均不出现。note：demo 模式下 owner 标签来自连接身份（共享网关 token 之后的 query actor），是演示认证模型的既有语义（与既有审计 actor 同源），生产走 S1 principal 链——边界如实，无需改动。

## (2) production 缺 modelScopedKey 选"留审计不拒启"：可接受

理由成立：①§4.3"代理不接受任意团队切换"的不变量由 S4b 归属模型无条件保证（头零参与、静态 token 只归 defaultTeam）——缺 scoped key 降级的是计费粒度（全会归一个 default 桶），不是归属完整性；②网关侧无法感知 modelgw 是否 strictBudget，硬拒启会打断合法部署而不新增安全；③态势以固定类别审计落盘（测试验证缺失必留痕、配置后不误报），供部署评审处置。与任务书"二选一说明理由"相符。

## (3) 密钥域互斥与 env 解析：通过

构造期 assertScopedTokenKey（与验签侧同一把尺）+ assertDistinctCredentialDomains 把 model scoped key 纳入五类既有秘值的互异断言（网关 token/model token/gitProxy token/gitGrant masterKey/registry internalToken）；既有 token 互斥断言未动。main 读 PERIMETER_MODEL_SCOPED_KEY：纯 hex（偶长）优先按 hex，否则 base64url，解码后 <32B 即抛——两字母表的歧义形态（偶长纯 hex 的 base64url 串）固定按 hex 解释，口径写在注释。

## (4) note-1 → jti:UUID：闭合

`<jti>:<服务端 UUID>` 跨重启唯一，jti 前缀保留归因；#opSeq 进程内计数删除；PK 守卫与三态单向迁移的幂等语义不受损。测试以固定 jti 复用 token 精确复现旧撞键形态：重启后同 token 请求 200、两行并存、旧记录 input/output 不被覆盖。变异佐证（models.ts 去 tokenProvider → 例1/2 失败）与断言静态一致。

## (5) note-3 补审计：闭合

4xx 分支在 return 前补 `abort.cause !== null → #auditAbort`，额度口径不变（仍 release）。竞态确定性构造：fake 只回 400 头（显式 flushHeaders——中间问题与 S4a 例2 同款教训，测试侧修复如实）+ body 悬挂 → first_token deadline 与 4xx 并存；断言 released + usedTokens 0 + 审计含 segment=first_token 中止条目。变异：去补审计 → 例6 失败。

## (6) demo 接线：通过

MODEL_SCOPED_KEY=randomBytes(32) 两侧同一把（modelgw scopedTokenKey + 网关 modelScopedKey），demo 实际走 scoped 归属；凭据分域 banner 更新（模型 scoped 密钥沙箱与浏览器不可见）。

## (7) 测试真实性：真测

全栈（浏览器 WS → 真实网关 → 真实 ModelGateway → mock 模型），不 mock 被测语义；(a) 双会话分别归属且 operationId 带 jti:uuid 形态互异；(b) 以"账本 team=会话 team 而非 default"反证上行的是 scoped token，同时验证静态 token 直连面未放宽（仍 200 + defaultTeam）；(c) 未配置时 team=legacy-static/sessionId=unknown 钉住旧行为，另有 S4b 基线 844/844 全绿佐证；(d) 三例对 note①②③（note-2 为 budget-ledger.ts 部署约束注释，措辞与机制如实：多实例互标 unknown 的后果与单写入者口径写明）。production 态势测试真起 production 网关（backend 仅构造未 launch，不触 Docker）。

## (8) 既有行为放宽：无

未配置 modelScopedKey 时 wiring 完全走原路径（tokenProvider 可选、缺省 undefined）；models.ts resolve 的静态分支逐字保留；DLP/deadline/allowlist/凭据域断言零改动。typecheck 0；scoped-wiring 7/7×3；全量 66 文件 851/851。

## Notes（不阻塞，记录）

- scoped 模式下 model 对象仍保留静态 `token` 字段（models.ts 不再用它做 auth）——暴露面与 S4b 前持平（本就在配置对象里），后续可顺手删。
- production 态势的处置闭环依赖部署评审读审计（网关无法感知 modelgw strictBudget）——S5/部署文档需把这条审计列入上线检查单。
- (a) 的 tenant 断言依赖 demo 连接身份映射（query actor）；生产路径的 principal→metadata.owner 链路属 S3b 既有已审范围，本轮未重复审。

## 范围声明

逐行核对 server.ts（模型网关与网关两处）/session.ts/models.ts/scoped-token.ts/budget-ledger.ts 全部 hunk、demo.ts、modelgw-scoped-wiring.test.ts 全文 406 行；对照任务书 4 大项与本席 S4b 轮 3 note 逐条；核对 metadata.owner→Session.actor 链路（server.ts 创建处）与凭据域断言位置；核验 all-c.txt 尾部。未重审未改动文件。
