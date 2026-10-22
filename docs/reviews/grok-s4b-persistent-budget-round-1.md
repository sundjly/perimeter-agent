# S4b 复审第 1 轮：持久预算账本 + 可信归属

- 日期：2026-10-22。只读复审，未运行任何测试/进程。基线 HEAD 6b46a89；按用户授权读取 src/modelgw/** 内容。验收依据 docs/handoff.md §4.3（工作树版 :179）与任务书逐条。

## 结论：approve（3 条 note，不阻塞）

## (1) scoped token：通过

验签顺序严格"先签名后内容"：长度/格式（恰两段、≤4096、JWT 三段式直接 malformed）→ 严格 base64url 字符集预检与长度校验 → timingSafeEqual（长度不等也跑一次等长比较抹平时长差）→ 之后才 JSON.parse → aud 固定 "perimeter-modelgw" → exp 数值有限且秒级过期判定 → 四字段字符集白名单（`[A-Za-z0-9._:@/|+-]{1,200}`，容纳 principal 形态、挡控制字符与超长）。密钥 ≥32 字节 Buffer 构造期强制，mint 侧同步校验字段与 ttl。编码名经 od 字节级核验为字面量 base64url（三处：decode/mint body/mint sig；Node 原生 URL-safe 无 padding，与字符集预检及长度%4 校验自洽），中间问题（fromCharCode 动态拼名得到标准 "base64"（含 +/ 与填充，非 URL-safe），合法 token 全被拒）确认已改为字面量。签名对象是原始 body 串，篡改任一字符必致 bad_signature。静态 token 常量时间比较、只能归属 defaultTeam（缺省 "default"，tenant 固定 "local"）；#route 中 team/sessionId/actor 全部取自 identity，x-perimeter-team/actor/session 头零参与（session_id 亲和头仅原样转发上游作诊断，测试钉死）。

## (2) 账本原子性：通过

reserve 的「已结算+在途预留+本次 ≤ quota」判定与插入在同一 BEGIN IMMEDIATE 事务（WAL 下写锁在事务起点即取，跨进程由 busy timeout 5000 串行化；同进程 node:sqlite 同步执行无交错）；quota 失败先 ROLLBACK 再返回；异常路径 try-ROLLBACK-吞-rethrow。文件模式 WAL + synchronous=FULL（理由注明：账本记钱）。close 幂等（#closed 闸）。幂等三态单向迁移：settle/release/markUnknown 的 UPDATE 限定 `status IN ('reserved','usage_unknown')`，终态重调 changes=0 后按 status 确认返回 true，不覆盖已记账值（单测钉死 10/5 不被 999/999 覆盖）；reserve 以 operation_id PRIMARY KEY 拒重复。cache 字段按 provider 归一化只入账本不叠加占用（OpenAI prompt_tokens 已含 cached，防双算），占用口径=settled 真实 input+output + reserved/usage_unknown 按预留，released 不占。

## (3) 计量矩阵：符合 §4.3；4xx release 不过宽

矩阵：DLP 拦截不预留（reserve 在 DLP 之后）→ 4xx release（状态头先于 body，错误响应无 token 产生）→ 我方中止/断流/5xx/2xx 无 usage → usage_unknown 保守保留预留 → 2xx 有 usage → settle 替换预留。每个分支都有审计且 operationId 贯穿。4xx 一律 release 的定界：OpenAI 兼容上游的非 2xx 在首字节前返回、错误体不携带 usage；"上游已计费的 4xx"（如流中 400）在 HTTP 状态层不存在，真出现此类 provider 由 reconcile 对账兜底——定级合理，代码注释与任务书口径一致。5xx 记 unknown 而非 release 亦符合"结果未知不写成 0"。

## (4) 预留估算：口径如实

estimate = ceil(字节数/4) + max_tokens（请求 max_tokens/max_completion_tokens 取正整，缺省 8192 与目录对齐）。中文/代码更稠密导致低估的风险已在注释明示，敞口由"结算替换预留 + usage_unknown 不释放 + 下一请求判定读到更高 committed"兜底；"当次可能挤过闸门、当次不追补"如实声明，保守系数留作配置演进。定级通过。

## (5) operationId：服务端生成、幂等成立

scoped 用 `jti:服务端序号`（同凭证多请求可归因），静态用 UUID；客户端字符串零参与。见 (2) 幂等三验（重复 settle 不覆盖/终态不复活/未知 id 返回 false）。

## (6) 重启与崩溃恢复：通过

同一 ledgerFile 重开后已结算与在途预留原样在（测试：120 结算 + 一条 usage_unknown 预留跨重启存活、条数=2）；构造期 recoverCrashReservations 把崩溃残留 reserved 全部标 usage_unknown（继续占额度 500，不释放），reconcile 可再 settle（500→40）/release；恢复动作本身留审计。变异声明（recover 改 return 0 → 恢复例失败）与断言静态一致。

## (7) 既有测试改动：守住性质且有增强

modelgw.test 4 例（SSE 计量/团队累计/配额拒绝/头集合亲和）逐条注明改动理由，归属改为 scoped token 后守护性质不变；配额例的语义从"完成后扣"升为"在途预留占额度"（150 配额：54 预留放行→结算 120→次请求 174>150 拒绝），更严格。新增负控有效：伪造 x-perimeter-team/actor 对 scoped 与 static 两条路径都断言归属不可移动（team-a 记 120、team-b 记 0；ops 记 120、default 记 0）。deadline 测试把"中止不计费"精确化为"settledTokens=0 且 usedTokens>0（预留保留）"——语义增强非放宽。

## (8) 既有行为放宽：无

DLP 扫描链/413/redirect:"error"/allowlist（含 GCP token host 预检）/S4a deadline 逻辑全部原位；ledger 调用只加在既有失败路径上。strictBudget=true 缺 ledgerFile 启动即炸（负控在）。typecheck 0；budget 13×3、modelgw 55、deadline 9；全量 65 文件 844/844。

## (9) 残余：如实

S4c 签发接线（mintScopedToken 未接会话创建）、外部对账源（仅 reconcile 接口）、真实价格（priceVersion="0"，币种/账单口径归 S5）、session/daily 维度（仅 team，任务允许）、429 请求不落账本行（仅审计）——各项均已在代码注释或任务书中声明，无夸大。

## Notes（不阻塞）

- note-1：#opSeq 为进程内存，网关重启后同一 scoped token（jti 未过期且复用）的序号从 1 重来，`jti:1` 撞账本主键 → 该请求 502（fail-closed 不重复记账，可用性小坑）；S4c 按会话签发短 exp jti 后窗口可忽略。
- note-2：多网关实例共享同一 ledgerFile 时，后启动实例的 recoverCrashReservations 会把在途实例的 reserved 标 unknown——单写入者假设与 audit/stateRoot 同口径，部署面需保证一文件一网关。
- note-3：4xx 分支先于 abort 审计分支 return，"超时恰逢 4xx 到达"的组合只 release 不留 abort 审计（额度处理正确，审计面缺一条，纯记录性）。

## 范围声明

逐行核对 scoped-token.ts 与 budget-ledger.ts 全文（编码名经 od 字节级核验）、server.ts 全部 hunk（认证/归属/预留位置/计量矩阵/恢复/观测接口）、modelgw-budget.test.ts 13 例断言、modelgw.test 4+1 例改动与理由注释、modelgw-deadline.test 3 处改动；对照 handoff §4.3 五条与任务书 4 大项逐条；核验 v3 TAP 与 all-b.txt 尾部。未重审未改动文件。
