# S4 模型链路和预算：实现记录（S4a–S4c）

依据：`docs/handoff.md` §3.2（模型 deadline/重试）、§4.1、§4.3（持久预算账本 P0）。

| 提交 | 切片 | 复审 |
|---|---|---|
| `6b46a89` | S4a 分段 deadline、背压、断流取消上游 | `grok-s4a-deadline-drain-round-1`：approve |
| `808e31f` | S4b 持久预算账本 + scoped token 归属 | `grok-s4b-persistent-budget-round-1`：approve |
| `d04d4d9` | S4c 网关按会话签发 scoped 模型凭证 + S4b note 修复 | `grok-s4c-scoped-wiring-round-1`：approve |

验证（协调者实跑）：typecheck 0；modelgw-deadline 9/9、modelgw-budget 13/13、modelgw-scoped-wiring 7/7（各连跑 3 次）；全量 66 文件 851/851；无残留进程/容器。
变异检验均被抓住：去掉 reserve 配额判定、`recoverCrashReservations` 改 `return 0`、models.ts 去掉 `tokenProvider`、去掉 note-3 补审计。

## 已实现

- **deadline**（构造可配，非正值启动即炸）：body 读取 30s（408）、connect/header 10s、首 token 30s、流 idle 60s、总时长 10min（504 或截断已开始的流）。超时中止上游 fetch 与 reader；GCP 换 token 经 `AbortSignal.any` 受同一 signal 约束。
- **背压**：`res.write` 返回 false 时等 drain，等待受 idle/total 约束；客户端断开立即 abort 上游。
- 收到上游头后立即 `flushHeaders`，首 token 超时时客户端看到“200 + 截断”而非裸断连。
- **账本**（`src/modelgw/budget-ledger.ts`，node:sqlite，WAL + synchronous=FULL）：`BEGIN IMMEDIATE` 内判定 + 插入，并发不超卖；settle / release / usage_unknown / reconcile；启动时把崩溃残留的 reserved 标为 usage_unknown（不释放）；`strictBudget=true` 缺 `ledgerFile` 启动即炸。
- **计量矩阵**：DLP 拦截不预留；上游 4xx → release；5xx、2xx 无 usage、我方中止 → usage_unknown（保留预留，不写 0，不自动重试）；2xx 有 usage → settle。cache 字段只入账不叠加（OpenAI `prompt_tokens` 已含 cached）。
- **归属**：只取自 HMAC 签名 scoped token（aud/tenant/team/sessionId/exp/jti）；静态 token 只归 `defaultTeam`；`x-perimeter-team/actor/session` 头不参与。
- **签发**：配置 `modelScopedKey` 后，网关每次模型调用按服务端会话（owner principal / scope team / sessionId）mint 10min TTL 凭证；密钥不进沙箱、客户端事件、审计。归属不可签发时会话启动 fail-closed。`PERIMETER_MODEL_SCOPED_KEY` 先按 hex、再按 base64 解析，需 ≥32 字节。demo 两侧接同一随机密钥。
- operationId 由服务端生成：scoped 为 `jti:UUID`，静态为 UUID（修复重启后撞主键 502）。

## 设计取舍

- **production 缺 `modelScopedKey` 不拒启，只写固定类别审计。** 理由：网关侧无法感知 modelgw 是否开启 strictBudget；静态 token 仍是合法认证面，但只能归 defaultTeam，不能切换团队。代价是计费粒度降为单一团队。**部署评审需决定是否改为拒启。**
- **一个账本文件只允许一个网关进程写入**（部署约束，已写入 budget-ledger.ts 注释）。多副本需要共享账本服务或按副本分片。
- **预留估算** = `ceil(body 字节 / 4) + max_tokens`（缺省 8192）。中文和代码会低估；结算超出预留时当次不追补，由后续请求的配额判定挡住，因此单次请求可能超出剩余额度一次。
- 上游 4xx 一律视为未计费并 release；5xx 保守记 usage_unknown。
- 中止路径不结算部分已见的 usage，统一 usage_unknown，等对账。
- 超时审计沿用 `kind=error`，段别与 usage_unknown 写在脱敏 summary 中（AuditInput 白名单不允许新字段）。
- 客户端慢发 body 回 408（区别于上游侧 504）。

## 遗留 / 残余

- 外部对账源未接入（`reconcile()` 接口已就位），usage_unknown 目前只能人工/后续对账释放。
- 价格全为 0（`price_version="0"`），不能据此做成本结论；cash cost 公式、币种、折扣未实现。
- 只有 team 维度配额；session / 每日额度、模型并发上限未做。
- 重试策略（Retry-After、退避、与 SDK 重试去重）未实现；当前网关不重试。
- 计时器精度依赖事件循环，极端负载下 deadline 可能略迟。
- 背压测试以“上游停写 + 恢复后字节完整”间接证明缓冲有界，未直接观测 `res.writableLength`。
- S4c 记录性 note：模型对象上仍残留静态 token 字段（scoped 模式下不使用）；demo 的 owner 标签仅为演示身份。
- `s4-real-model`：**external_blocked**——需客户批准的模型通道、区域、零留存/DPA 证据与账单对账。

## 关于 S2 的 DLP / redirect

`s2-dlp` 与 `s2-redirect-check` 在 B3/R41/R43 轮已实现并有测试（block 默认、扫描在任何上游副作用前、`redirect:"error"` 含换 token），modelgw.test 54/54 通过。`docs/reviews/handoff-coverage.json` 中这两条的 evidence 描述已过时，待同步。
