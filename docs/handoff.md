# perimeter-agent 交接

已按 `durable-rearchitecture.md` 的 M0→M7 顺序迁到 Pi Durable。API 以精确锁定的 node_modules 1.1.0 为准；差异、取舍与总结见规格 §9。每个里程碑经 subagent review、npm test / typecheck 全绿后独立提交，不 push。

## 五分钟上手

```bash
npm install
npm run demo
npm test
npm run typecheck
npm run attach -- --session <id> --token demo-token
```

Node ≥22.19，git；不再需要全局 pi。零凭据 demo 使用 mock-model，经真实模型网关与 git 代理完成放行 / 拒绝 / 审批。真实模型配置 `PERIMETER_MODEL_GATEWAY_URL`、`PERIMETER_MODEL_PROXY_TOKEN`、`PERIMETER_MODEL`；SDK 与上游凭据只在可信网关，gitProxyToken 必须与模型/浏览器 token 不同。

## 铁律与读代码顺序

1. `src/protocol/types.ts`：纯自有 v2 类型；客户端消费 snapshot + 增量，不再 replay/gap/resume。
2. `config/policy.yaml`：策略唯一事实来源。bash 路径规则不生效，命令黑名单不是安全边界；read 仍豁免 deny_paths/审批，但凭据文件已被 `deny_reads` 默认拒绝（B1；多硬链接常规文件读写保守拒），出站 DLP 生产默认 block（B3）。
3. `src/runtime/harness-host.ts`：SQLite、懒打开/resume、选中 perimeter 扩展的运行时断言。所有 durable 依赖只在 runtime 与 translate。
4. `perimeter-extension.ts` / `approvals.ts`：先策略后执行，异常 block；审批 doc 原子 first-wins、超时拒绝、批准人审计。模型工具意图也先审计，覆盖 beforeTool 之前的参数校验失败。
5. `src/gateway/session.ts` / `server.ts`：Hub、成员授权、在场、有界队列、稳定快照栅栏、生命周期。
6. `web/view-model.js`：网页和 CLI 共用纯 reducer。所有 DOM 文本走 textContent，CSP 同源。

代码只记 hash 的铁律保留 command/summary 片段的既有例外；SIEM 白名单不变。沙箱无模型配置/token；local 工具强制不继承进程环境，生产依靠 Docker/Pod 文件系统隔离。审计唯一写入者仍是网关。egress 是部署承诺，生成物没有 apply；Docker 默认 bridge 仍可出公网，必须配置 internal 网络。

## 会咬人的坑

| 坑 | 处理 |
|---|---|
| NodeExecutionEnv 的 shellEnv 不会替换 process.env | runtime 的 localEnvironment 强制 inheritEnv:false，显式给 PATH/HOME；真实 bash 环境守卫已负面验证 |
| beforeTool 发生在参数校验之后 | Generation.afterResponse 对所有工具意图过策略并记 hash；实际执行前再次判定，非法参数不执行 |
| pi-env Connection 自己追加 serve/token 参数 | command 只给 docker/kubectl exec -i … pi-env，不重复参数 |
| durable 的 safe 工具恢复会直接执行，不重跑 beforeTool | 保持 CodingTools 的 unsafe 默认；执行阶段恢复为 interrupted，可能已有副作用 |
| 审批中途 kill -9 | 旧 pending 标过期并审计；call 阶段恢复重新请求，旧审批 id 无效 |
| 一进程独占 SQLite，没有跨进程锁 | 单实例/独占 stateRoot；水平扩展与 sticky 路由未做 |
| 快照读取期间仍可能来事件 | seq 稳定后同步入 attachment 队列，再接增量，避免旧快照带新游标 |
| 关 WebSocket 不等于中止任务 |任务继续；evals 验收前 abort 并等收尾 |
| 空闲关闭后原连接仍开着会吞消息 | 回收时关闭 attachment，网页自动重新 attach 持久会话 |
| node --test 无测试文件仍可能退出 0 | golden suite 判据保留 test -f 与实际 pass 数检查 |
| NODE_TEST_CONTEXT 污染验收 | exec 白名单与工具 inheritEnv:false |
| execFile timeout 只杀直接子进程 | eval backend 保留 detached + killpg |
| Linux bind mount 属主与 macOS 不同 | 容器 uid/gid 默认网关身份；Linux 仍须部署验证 |
| kubectl cp 需要 tar | 必须列入客户镜像前置条件 |

**清理失败不能中断后续清理。** stop 等待启动收尾，按顺序分别关闭事件流、Harness、执行连接、沙箱；审计失败同样不跳过清理。一个会话失败不能把整个网关带崩。

## 改了 X 要记得改 Y

- policy.yaml → `npm run gen:deploy`（NetworkPolicy 与 ConfigMap 都有漂移守卫）。目前沙箱出口只有 git 代理 + DNS。
- 协议事件 → CLIENT_EVENT_TYPES + 共享 reducer + protocol-coverage 测试；双向穷尽性保留。
- Audit 字段 → 核对 SIEM 白名单，不能展开整个 AuditEntry。
- sandbox.yaml 的五项安全约束 → DockerBackend 与相应测试。
- 运行时依赖 → 明确说明理由、精确锁定 Pi 包、更新白名单与 Node 导入守卫。原 ws/yaml 限制为持久运行时放宽，不是取消依赖纪律。
- 静态 section / tools / block 文本 → 跑 cache 测试；不能塞时间、UUID、审批人或在场人数。
- 守卫测试 → 临时改坏实际路径，确认变红，再恢复；边界变红若是策略加固，更新期望，不回退策略。

## 实证与下一步

已测：本地完整产品链路、git clone/push、多个展示端状态、角色拒绝、先到先得、真实 kill -9 恢复 transcript/owner/审批、稳定前缀与 UUID、缓存字段透传、注入/CSP、环境凭据隔离。历史 SigV4/Vertex 离线验证保持。

### 未完成与已知缺口

| 项 | 现状 | 解锁条件 |
|---|---|---|
| **身份只是演示级** | 所有人共用一个网关 token，actor 由客户端经 `?actor=` 自报（`src/gateway/server.ts`）。持 token 者可冒充任何成员，包括 owner；角色检查、批准人审计因此只防误操作，不防恶意。**不要拿多人共享去过安全评审** | OIDC/SAML，actor 改由服务端从凭证解出 |
| 真实环境未跑过 | 真实模型上游、缓存实际收益与吞吐、新 Docker 镜像（只装 pi-env daemon）、真实 K8s、egress 默认拒绝。全部只有本地 / mock / 静态校验 | 一条真实模型通道 + 一个真实集群 |
| Node ≥22.19 | 从 22.18 提上来，因为 pi 包 `engines` 声明 22.19。22.18 只做过 M0 的导入烟测，不算兼容 | — |
| 运行时依赖放宽 | 从 `ws`、`yaml` 两个加到六个：`@earendil-works/chord`、`pi-ai`、`pi-durable`、`pi-env`，四个都精确锁在 `1.1.0`（不带 `^`）。pi-durable 自称 Experimental，版本之间 API 无兼容保证 | 升级前先读 CHANGELOG 再跑全量测试；durable 引用只许出现在 `src/runtime/` 与 `translate.ts`，改动面就锁在这两处 |
| Pod 工作区是 emptyDir | 删除 Pod 会丢未推送的改动 | 持久工作区方案 |
| local 后端无文件系统隔离 | 只隔离了进程环境变量，不能作为生产安全边界 | 生产用 docker / kubectl |
| 没有基线数字 | 模型目录价格为 0，不当真实计费；golden suite 完成率仍未跑出 | 真实模型凭据 |

历史下一步为目标集群/新镜像验证、真实模型与缓存收益评测、POC 客户任务集。本次未做 OIDC/SAML、跨进程 SQLite、sticky 扩容、四眼审批、Helm、多 SCM、monorepo。**企业目标的执行顺序以文末 S0–S7 为准：可信身份与安全边界必须先于客户多人试用；水平扩展后置。**

## 流程约定

实现 → subagent review → 修复 → 验证 → commit。历史 F13 未 review 与 F19 reviewer 改坏源文件的事实保留在 review-log，不改写历史。与已知绿灯矛盾的 review 先核对工作区，再核对结论，但不能因此忽略守卫缺口。

## 企业化交接规格（对照 Paseo）

### 0. 范围、证据与发布口径

本节是**待实现规格，不是已交付能力**。此次只补交接文档，不改变运行时代码。保留上文已有工作区修改；本仓库调研基点 `b354ffe`，Paseo 基点 `6f62125ee`（`/Users/sundy/projects/paseo`）。复验 `npm test`：368 pass、0 fail、0 skip；`npm run typecheck` 通过。没有重新执行真实模型、真实 Docker/K8s 或生产出口验证，测试绿灯不能替代这些证据。

目标默认：客户 VPC 内单租户 Data Plane，网页 + CLI，共用 Pi Durable 内核；企业 IdP、模型和 SCM 可配置。暂不引入 Paseo 依赖、不复制其整个 monorepo、不增加手机/语音/公网 relay。若要 SaaS 多租户，必须另做隔离架构评审，不能直接复用单租户结论。

**“代码不离开 Data Plane”需要收窄表述**：transcript/工作区/工具执行留在客户侧；模型请求仍包含代码。只有客户批准的私网/自托管模型及其处理边界才能满足对应要求。VPC endpoint 不等于模型服务不处理数据；供应商留存、训练使用、区域和 DPA 均须确认。当前 `command/summary` 例外也可能含代码或秘密，不能称“审计完全没有代码”。

企业上线不是一个 `enterprise=true` 开关，也不等于获得 SOC 2/ISO 27001 认证；必须完成下述门禁并由客户安全负责人批准。

### 1. Paseo 借鉴清单与不照搬项

下列路径相对 `/Users/sundy/projects/paseo`，用于定位设计依据；不是对其企业安全能力的背书。

| 参考 | 可借鉴契约 | perimeter 落点与差异 |
|---|---|---|
| `docs/architecture.md`、`packages/server/src/server/creation/index.ts` | 服务端持有创建阶段、永久 ID、请求指纹；断开不撤销已接受任务；未知副作用不重放 | `gateway/server.ts` + 创建收据；当前 attach 可创建，不能把“有 session 目录”当“首次 prompt 已接受” |
| `docs/timeline-sync.md` | 实时流只保证及时性，权威历史保证正确性；初始有界 tail、旧历史分页；presence 不参与送达判定 | `session.ts`、协议与 reducer；保留现有 snapshot + 增量，不重新引入旧 replay/gap 协议 |
| `docs/architecture.md`、`websocket-server.liveness.e2e.test.ts`（位于 `packages/server/src/server/`） | 每物理连接的 liveness、发送字节水位和资源所有权；坏连接不拖垮其他端 | 当前仅 100 条应用队列，不限制帧大小或 `bufferedAmount`；补字节背压、心跳和快照限额 |
| `docs/agent-stream-performance.md`、`packages/server/src/server/agent/agent-stream-coalescer.ts` | leading + trailing 合并、终态 flush、只刷新变化的显示项 | SDK 默认 100ms commit 不等于网页已优化；先测再增加单层合并，不叠多层等待 |
| `docs/permissions.md` | principal、credential、grant 分离；语义权限而非 RPC 名称；授权不可通过委派扩大 | 保留 owner/editor/viewer UI，服务端映射显式 grant；补审批专权、资源作用域和吊销 |
| `docs/architecture.md` 的 supervisor/ready 契约 | 配置是期望值，发布的 ready 才是实际可用端点；独占存储，不用过期心跳抢活锁 | 网关启动加 stateRoot 独占锁、readiness、优雅排空和受限重启；不导入其 supervisor |
| `SECURITY.md` | 明示 Host/Origin、relay、文件预览和本机用户信任边界 | 企业不接受“连上就等于可信操作者”；同 UID 的 agent 必须放进独立沙箱 |
| `docs/architecture.md` 的协议 capability 与工具目录 | 协议叶子层、能力协商、工具目录与传输解耦 | 继续自有 v2；新能力必须握手协商，旧端不得无声绕过审批 |

不照搬：Paseo 的 provider 自管凭据/宿主机文件读取模型、公网 relay、终端完整宿主权限、客户端全量本地 transcript 缓存。其 `SECURITY.md` 还列出 relay 凭据兼容例外与会话内 replay 缺口；企业远程访问优先客户 VPN/零信任入口 + TLS，不自制密码学协议。多 provider 以后接入仍必须经过本项目策略、审计和执行边界，不能因 SDK 不支持 hook 而静默降级。

### 2. 各方面能力矩阵

状态：**已有**＝当前实现且有本地测试；**部分**＝有机制但不足生产；**待做**＝本节要求。

| 领域 | 当前状态 | 补齐能力 / 验收重点 | 优先级 |
|---|---|---|---|
| 会话与协作 | 部分：durable、角色、作者、共享、重连 | 可信身份；显式 create/list/archive/delete；收据幂等；吊销现存连接 | P0/P1 |
| 稳定性 | 部分：kill -9 恢复、unsafe interrupted、孤儿回收 | 独占锁、限额、排空、上游超时/取消、恢复诊断、故障注入与 soak | P0 |
| 企业身份 | 待做：共享 token + 自报 actor | OIDC、短期凭证、服务主体、组映射、会话/仓库作用域、离职撤权 | P0 |
| 工具安全 | 部分：策略/审批、隔离环境 | 文件系统真正封锁受保护路径和敏感读；四眼审批；可信工具目录 | P0 |
| 出口与供应商 | 部分：生成 NetworkPolicy/上游 hostname 检查 | 真实 CNI 验证、DNS 控制、禁止未验证重定向、私网模型/SCM、DLP | P0 |
| token 与费用 | 部分：稳定前缀、usage/cache 展示、内存配额 | 真实价格/模型能力、预算预留结算、持久账本、压缩质量评测 | P0/P1 |
| 工作区与 SCM | 部分：clone/push、独占工作区 | PVC/快照恢复、diff/测试/PR 人工评审、fork 不可信 setup、仓库级代理凭证 | P0/P1 |
| 产品操作面 | 部分：网页/CLI reducer、审批/中止 | 连接/同步/任务状态分离；错误分级、长历史分页、diff、费用/恢复状态、键盘与可访问性 | P1 |
| 运维与合规 | 部分：本地审计链/SIEM 导出 | 外部审计锚点、密钥轮换、备份恢复、保留/删除、告警、SBOM/漏洞扫描/发布回滚 | P0/P1 |
| 扩展性 | 待做：单实例 SQLite | 会话归属、资源调度、跨节点 fencing；多 SCM/monorepo/MCP 后置 | P2 |
| 自动化 | 待做 | 任务 DAG、定时任务、通知/webhook；全部继承预算和授权，默认禁自动 push | P2 |

P0＝公司试用前阻断项；P1＝试用到稳定运营；P2＝证据充分后扩展。手机、语音、浏览器自动化、任意 terminal/plugin 均非企业安全 MVP 的必要项，新增执行面必须单独威胁建模。

### 3. 稳定性契约与故障恢复

#### 3.1 创建、消息和副作用

- 新增显式创建命令与持久 receipt：`operationId / principalId / requestId / requestHash / sessionId / stage / outcome`。同身份同键同内容返回原结果；同键不同内容拒绝；不同身份不共用收据。键、收据保留期和清理必须配置。
- 阶段至少区分 accepted、workspace_ready、harness_ready、prompt_accepted、failed、outcome_unknown。先落身份/阶段，再执行外部副作用；目录存在不能证明任务完成。
- 当前 `HarnessHost.submit()` 已把 actor + requestId 交给 durable；不要声称完全没有消息幂等。但仍须验证同键异内容、创建流程和跨重启的回执一致性。重复请求不得重复模型生成或重复计费，重复审计需标为 replay。
- 请求 accepted、任务 started、任务 finished 是不同确认。断网只释放观察者，取消必须是显式 abort；abort 必须取消上游请求、工具进程组、pending 审批并等收尾。
- unsafe 工具未知结果禁止自动重放；显示 callId、意图 hash、执行阶段、工作区 diff，由操作者确认。Git push 先查远端 ref/commit，不能用“再推一次”代替恢复判断。不承诺通用 exactly-once 外部副作用。

#### 3.2 限额、背压、重试

建议起始限额（**尚未接线，按压测调参，不是既有默认**）：入站 WS/HTTP 模型请求 1MiB、prompt 64KiB；每连接应用待发送 2MiB、物理发送硬水位 8MiB；初始 tail 200 项且 ≤1MiB；单工具展示输出 ≤64KiB。超限返回明确错误/分页游标；完整产物在客户侧按授权查看，不把大日志自动塞进模型。

- 所有发送路径（快照、控制帧、错误、增量）统一计字节并检查 `bufferedAmount`。连接超水位只终止该连接；不能不断生成大快照作为慢端“恢复”，也不能仅凭 100 条队列宣称内存有界。
- 入站 runtime schema 验证 type/长度/枚举，显式 HTTP method/content-type；同时限制连接数、每主体速率、活跃会话、待审批、模型并发、历史保留与磁盘用量。`as ClientCommand` 不是校验。
- 应用心跳建议 10s，30s 失活；RPC 超时和连接失活分开；浏览器后台/前台恢复允许即时探测。重连用指数退避 + jitter，成功归零，防全员重连风暴。
- 模型 connect/header、首 token、流 idle、总时长分别设 deadline；初值建议 10s/30s/60s/10min。超时中止 upstream，释放预留和连接。响应转发遵守 `res.write()`/drain；断开或 abort 取消 reader/fetch。
- 重试仅用于明确未接受且可重试的请求，受全局 deadline、次数和预算约束，遵守 Retry-After。429/短暂 5xx 可退避；401/403/参数错误不重试；流已开始或结果未知不自动再次生成。先核对 SDK 自带重试，避免网关×SDK 成倍放大。
- 每上游设置并发闸/有界等待队列、熔断与探测；fallback 不得跨数据区域、客户授权模型或 DLP 边界。恢复队列不得比新任务拥有无限优先权。

#### 3.3 生命周期和存储

- `stateRoot` 单实例独占：第二实例启动失败，锁含进程身份/启动标识；不因心跳过期抢活实例锁。多节点仍是一会话一写者，sticky 本身不能解决 split-brain。
- ready 之前校验策略、凭据域、模型目录、stateRoot 可写、SQLite/审计可用、执行后端及出口配置。liveness 不依赖模型厂商，readiness 才反映能否接受新任务；依赖故障不触发无限重启。
- 收 SIGTERM：先 readiness=false，拒新建与新任务，停止回收并发，限时 drain/abort，逐项关 Harness/执行连接/沙箱，再关 HTTP/审计。超时记录未确定操作；清理失败继续清理其余资源。
- SQLite/transcript 与 workspace 是两份状态，必须一致备份；不能只拷贝运行中的 sqlite 主文件忽略 WAL。Pod 工作区换 PVC/受控快照；恢复校验 workspace revision 与收据，不自动覆盖未提交变更。
- 备份恢复到隔离目录演练，记录恢复点、未推送变更和审批状态。网关损坏时禁止把 metadata 空缺当新 owner；corrupt/quarantined 状态只能由运维处理。
- 审计不可用：停止新高风险操作和批准执行，仍允许 abort/deny/清理。区分已有的“清理时吞审计错误”与企业执行 fail-closed，不能把清理豁免扩大到工具执行。

### 4. token 节省与预算保障

#### 4.1 当前准确边界

`harness-host.ts` 的后台压缩阈值为 32768，工具 sequential；`models.ts` 固定 contextWindow=128000、maxTokens=8192、reasoning=false、价格全 0。亲和头与 cache usage 有测试，不等于真实缓存有效。不能把某模型实际只有 32k 的情况藏在统一 128k 目录里，也不能用 0 价格做成本结论。

`modelgw/server.ts` 目前按请求头选 team/session，`#used` 仅内存、完成后才扣 usage：并发可超卖、重启清零；无 usage 的请求未结算。`readBody()` 无显式上限，fetch 无显式 deadline，`res.write()` 未等 drain；计量解析主要覆盖 SSE 行，不能假定普通 JSON/流异常都能正确结算。这些既影响费用也影响稳定性，先补正确性再宣传省 token。

#### 4.2 优化顺序（不得靠少审计、少审批来省 token）

1. **稳定前缀**：固定 system/tool 顺序、规则版本和拒绝文本；身份、时间、参与者、审批动态值只进结构化运行态。相同租户/模型/策略版本保持稳定路由；不跨租户共享应用缓存或日志。
2. **少搬上下文**：先检索文件/符号，再按行 read；工具输出用确定性上限 + exitCode/截断标记/产物引用；重复读取可按内容 hash/revision 缓存，但编辑后失效。不要自动附整仓库、完整测试日志、所有 diff。
3. **压缩可追溯**：按真实 contextWindow 设置软/硬阈值并预留输出与工具空间；保留目标、约束、决策、文件/commit、测试结果、未确定副作用。摘要不是权限事实来源；授权/审批永远读服务端 doc。完整 transcript 只在客户侧保存。
4. **抑制空转**：预算轮数/工具步数/无进展次数；重复同调用 + 同结果要提示停下或换策略；失败测试只回关键失败片段，保留完整产物。后台压缩本身用 token，必须进入费用统计。
5. **模型与输出策略**：按任务允许的质量档位选模型，短分类用小模型、复杂修改再升级；先批准数据域/价格，再开放自动路由。输出上限与 reasoning 能力从真实目录读取，工具 JSON 截断不得执行。
6. **精简交接给 agent**：本详细文档保留人类权威规格；执行任务只加载铁律 + 对应 S 阶段 + 涉及路径/测试，不每轮注入整篇 handoff，不把另一项目全部文档加入 system。任务摘要必须指回权威路径/版本。

缓存只降低部分输入成本，不降低模型输出、工具耗时或任务轮数。网页流合并只省带宽/渲染/CPU，不省模型 token；两者指标分开。

#### 4.3 持久预算账本（P0）

- 网关身份派生 tenant/team/actor/session；忽略客户端声明的收费归属。模型通道用短期 scoped 服务凭证（aud、exp、租户/会话），代理不接受任意团队切换。
- 原子 reserve → settle/release：按输入估计 + 最大输出预留 token/金额，带 operationId；并发预留也占预算。配置团队/会话/每日额度、模型并发和最大输出。不可绕过审批触发新额度。
- 每请求持久保存价格版本、模型、input/output/cacheRead/cacheWrite、状态和供应商请求 ID；同操作不重复记账。区分 cache 字段是否已包含在 input，按 provider 定义归一化，避免双算。
- abort/断流/无 usage 记 `usage_unknown` 并保守保留预留，异步对账后释放；不写成 0 token，不立即自动重试。重启恢复未结账操作；无法可靠计量的 provider 在严格预算模式下拒绝启用。
- `cash cost = Σ(对应类别 token × 对应类别每百万价格 / 10^6)`；客户币种、价格日期、discount 和账单口径单独记录。供应商 usage 与账单是对账来源，SDK 展示不作唯一收费依据。

#### 4.4 基准和接受条件

在固定仓库 revision、任务集、模型版本/地区、价格版本、审批策略下，分别跑冷缓存、同会话热缓存、重启恢复。每组建议 ≥30 个任务、每任务重复 3 次；不能只挑缓存最好的示例。

记录完成率、测试通过率、输入/输出/缓存 token、压缩 token、实际金额、重试与调用数、首 token p50/p95、任务时长、峰值 RSS。`cacheHitRate` 保留当前公式，但报告注明 provider 字段语义；缺字段显示未知。

初始优化门槛：每成功任务成本较基线下降 ≥20%，完成率下降不超过 2 个百分点，首 token p95 回退不超过 10%；**这些是拟定目标，当前没有实测达成**。每项同时报告失败任务消耗及样本误差，预算拒绝不伪装成成本优化成功。

### 5. 公司安全级上线门禁

#### 5.1 威胁主体与信任边界

至少覆盖：恶意 repo/README/依赖/模型输出、越权成员、窃取的客户端凭证、被攻陷沙箱、恶意上游/重定向、误配反向代理、磁盘写者、供应链、运维误操作。可信网关可读取 transcript 与模型凭据；沙箱和网页输出不可信。网关管理员仍是高信任主体，要靠 IAM、职责隔离与外部审计约束，不声称能防已完全控制网关的攻击者。

数据分类：代码/transcript/产物/secret 留客户批准区域；控制面默认只收最少元数据。关闭默认外部遥测，异常日志脱敏且不 dump body/header/env；日志、快照、备份、浏览器缓存全部纳入保留/删除策略。

#### 5.2 P0 安全检查单（全部完成才可公司试用）

- [ ] **可信身份**：OIDC Authorization Code + PKCE；JWT 验签算法、issuer/audience/exp/nbf、JWKS 轮换；principal 用 issuer+sub，不以可变 email 为主键。SAML 通过客户 IdP/OIDC broker，避免另造 SAML 实现。
- [ ] **浏览器凭证**：不再接受生产 query token/actor；同源 Secure/HttpOnly/SameSite 会话 cookie（有 cookie 就做 CSRF/Origin 防护），CLI 用短期 token/设备授权。禁止启动打印密钥 URL；删除/屏蔽代理 query 日志。现存长期 token 轮换。
- [ ] **完整资源授权**：list/attach/history/diff/artifact/share/approve/abort/export 每条路径检验主体和资源；scope 不由客户端或代理任意请求头决定。权限收缩/撤销断开旧连接并使在途审批失效；服务身份不能扩大发起人权限。
- [ ] **四眼审批**：执行、审批、分享管理拆权限；高风险操作请求者不能自批，自动化无权自批。审批绑定 callId、完整意图 hash、repo/revision、规则版本和 expiry；参数/策略/成员变化使旧审批失效。先到先得不等于四眼。
- [ ] **文件系统隔离**：企业禁 local backend；non-root/read-only/drop ALL/no-new-privileges/资源限制/seccomp 或受支持的 runtime profile；禁止 hostPath、docker.sock、宿主凭据挂载，禁自动 mount SA token，Pod 独占 workspace。
- [ ] **保护路径/敏感读**：受保护配置、策略/AGENTS、git hook/config 不能被 bash/python/符号链接/hardlink 绕过；需不可写挂载、OS/FS 边界或受限执行设计，不能靠 shell 正则和事后 diff。敏感文件不挂载 + 读策略；TOCTOU/realpath/路径越界红队测试。修复前不得宣称 deny_paths 是强制边界。
- [ ] **可验证出口**：真实集群默认 deny，包括跨 namespace、IPv6、metadata IP、DNS 隧道；DNS 仅受控 resolver 并限制任意外部解析。沙箱只到 git proxy；模型网关到获批上游/token endpoint。禁止或逐跳验证 HTTP redirect；hostname allowlist 不自动防 DNS 重绑定/SSRF，网络层也要封 metadata/未批准目的地。
- [ ] **SCM 最小权能**：凭据代理按租户/session/repo/ref 和 read/write 授权，服务端校验 URL/host，短期 token、吊销、日志脱敏。沙箱中的 gitProxyToken 仍是能力凭证，不能写成“沙箱完全没有 token”。push 仍走审批与远端分支保护，不能只信网关按钮。
- [ ] **出站 DLP/数据域**：在整条上游请求发出前完成检测和决策；高置信 secret 阻断/隔离，低置信人工处理，测试误报与漏报；允许审计模式只对已批准低敏感场景显式启用。模型零留存/禁训练、区域、私网端点与 DPA 有证据。prompt injection 不是靠提示词能保证消除。
- [ ] **传输与入口**：TLS/WSS、精确 Host/Origin allowlist（HTTP 与 upgrade 都检查）、可信 proxy 范围、入口限流、WS schema/字节限制、CSP/textContent。服务间身份用 mTLS 或等效客户方案；禁止默认 dev-token 对外 bind。
- [ ] **审计与密钥**：决策前持久审计，字段脱敏/最小化；链头定期外部锚定/WORM，能检测截尾；失败告警、最小读写权。Secrets Manager/KMS 或客户等效方案轮换模型/git/浏览器凭据，不写仓库和产物。
- [ ] **数据与供应链**：SQLite/工作区/备份加密与客户 KMS，恢复和删除演练；镜像 digest、非 root、SBOM、依赖/镜像漏洞扫描、发布签名、版本锁定。明确保留周期、legal hold、漏洞报告和应急负责人。

安全证据包至少包含：数据流与信任边界图、部署清单/实际出口探测、IdP/RBAC/四眼负面用例、DLP 对照集、审计锚定和恢复报告、SBOM/扫描报告、模型处理协议、风险例外及到期日。任何例外由客户安全负责人具名批准，不把文档勾选当成实现完成。

### 6. 产品和扩展能力的具体约束

- 会话目录由服务端授权过滤；搜索/分页不泄漏未授权名称。archive 只隐藏不删除，delete 需确认、停止运行、撤销凭据并按保留策略处理备份；不随列表移除清空 transcript。
- 操作面分别显示 connecting/reconciling/current 和任务 idle/running/approval/interrupted/error；WS 连通不表示快照新鲜。未确认 prompt 保留 requestId/草稿，显式重试用原键；不生成新键偷偷再发。
- diff/文件/终端输出一律当不可信文本；下载检查资源和路径，不提供 host 任意文件预览。HTML 默认 source；若将来提供可执行预览，隔离 origin、sandbox 并评审自导航外泄。
- PR 工作流为 clone → 隔离修改 → 测试 → diff 审阅 → approve push → PR；不默认运行 fork 的 setup/hook。网络依赖安装走受控镜像源/预构建，不为 npm install 放开公网。
- CLI 补 create/list/inspect/wait/archive 与机器 JSON 输出、稳定退出码；`wait` 区分任务成功、失败、审批和连接错误。网页与 CLI 共享 SDK/reducer，但授权只在服务端。
- MCP/skills/plugins 是新的执行/供应链面：仅管理员允许目录和版本，tenant 授权、工具 schema、策略审计、资源/网络限额，不允许仓库自行注册高权限工具。新增工具不能因不存在规则默认放行。
- 多模型/SCM/monorepo 应建立能力目录（context、cache、resume、usage、工具安全/认证），不支持能力显式拒绝。多 agent/DAG 的每节点有主体、工作区、预算和审批，子任务不可放大父权限；完成交接给结构化摘要与产物引用，不互传整份 transcript。

### 7. 实施阶段与交付给下一位 agent 的任务

每阶段单独实现/review/测试；没有真实环境证据不得标记“生产通过”。P0 验证可并行准备，但安全放行顺序不可跳过。

| 阶段 | 交付与主要改动面 | 依赖 / 完成判据 |
|---|---|---|
| **S0 基线与契约** | 记录依赖、模型能力、部署范围；建威胁模型、验收任务/基准与风险台账 | 保存当前测试报告；明确当前仅 local/mock；不引入新 SDK/provider |
| **S1 入口和可信身份** | `gateway/server.ts`、协议、网页/CLI；IdP 适配、principal/credential、schema、Host/Origin、限流/字节边界 | S0；伪造 actor/team、跨会话、过期/吊销和恶意 origin 均拒绝；无生产 query token |
| **S2 强隔离和审批** | `execution-backend.ts`、`execution-env.ts`、deploy、policy/approvals、gitproxy/modelgw | S1；真实容器/Pod 出口负面测试、保护路径/敏感读、四眼、repo-scoped token、DLP；修复前禁止企业放行 |
| **S3 恢复与生命周期** | Gateway/Session/Harness、创建 receipt、存储锁、PVC/备份、服务健康/关闭 | S1；并发重复创建、重启、磁盘满、断网/kill、unknown 副作用不重放；restore 保留未提交改动 |
| **S4 模型链路和预算** | `modelgw/server.ts`、models、usage/审计；取消/超时/drain、持久预留对账 | S1/S3；并发不超卖、重启不清零、无 usage 不免单、取消后无僵尸上游；真实获批通道通过 |
| **S5 token 与交互优化** | cache/evals、压缩/上下文、tail 分页、流合并、共享 reducer/CLI | S3/S4；冷/热/恢复基准与质量门槛；长会话/慢端内存有界；不改权限事实来源 |
| **S6 企业交付演练** | 部署包、运维 runbook、监控告警、恢复/轮换/回滚、安全证据包 | S1–S5；P0 清单完成、真实环境 soak、客户安全具名批准，才开放公司试用 |
| **S7 规模与生态** | 会话路由/fencing、调度、多 SCM/monorepo、provider/MCP/自动化 | S6 且单节点瓶颈有测量证据；不把多个网关直接挂同一 SQLite；新增面再过安全评审 |

**下一位 agent 的最小任务包**：先做 S0/S1，不先写 Helm 或横向扩展。输入＝本文 §0/§3/§5/对应阶段 + `server.ts`/协议/web/CLI 与相关测试；输出＝身份/入口契约、改动、负面测试、README 更新、未解决风险。遇到 IdP 参数缺失先提供可测试接口和测试 IdP，不以 mock auth 冒充公司 SSO；上线前由用户提供 issuer/audience、组映射、客户模型/SCM 与集群策略。

### 8. 验收矩阵与建议运营指标

下列新增测试名称仅是建议，**当前不存在这些守卫不能算已覆盖**。优先扩展现有 tests，必要时再新增。

| 场景 | 现有入口 / 建议补测 | 通过判据 |
|---|---|---|
| 身份伪造/跨资源/吊销 | gateway/session-guard；新增 identity/authz 测试 | 无未授权快照/工具/审批；旧连接立即失权；team 不可篡改 |
| WS 巨帧/慢端/半开连接 | gateway/protocol/view-model；新增 transport-load | 帧/队列/发送 buffer 有上限，单坏连接不影响其他成员，重连快照与尾页一致 |
| 并发重复 create/prompt | durable-runtime/crash-recovery；新增 receipt | 一资源、一接受结果；异内容冲突；断开不取消；未知副作用可见且不重放 |
| 崩溃/磁盘满/损坏/两实例 | crash-recovery/audit；新增 storage-fault | 无双写；拒新高风险操作；仍可清理；corrupt 不重新认领 owner |
| 上游异常/取消/预算 | modelgw/cache/upstream-auth；新增 budget/stream-fault | JSON/SSE/分片/无 usage/断流均对账；重启持久；429 队列有界；超时后连接释放 |
| Bash 路径绕过/秘密读取 | redteam/runtime-env/docker-backend；真实 sandbox 测试 | shell/python/link 无法改保护路径或读未授权 secret；不能只让策略函数断言通过 |
| 出口/凭据/SCM | netpol/wiring/gitproxy；真实 CNI/proxy 测试 | DNS/metadata/IPv6/redirect/任意 repo 被拒；日志无 secret；吊销能力凭证生效 |
| 恢复与发布 | pod-template/k8s-schema；新增部署/restore 演练 | 工作区/transcript/receipt 一致恢复；迁移前备份，旧二进制不直接读不兼容新 schema |
| token 优化/长会话 | cache/evals；真实任务与 soak | 按 §4.4 对照报告；预算覆盖压缩；长历史分页，无整会话无界快照 |

建议初始 SLO（未实测，不是 SLA）：24h soak 无未处理 rejection/资源持续增长；在约定并发和模型通道下服务可用性月度 99.9%，首 token p95 <3s、恢复到可操作 p95 <10s。冷 clone 大仓库单列；模型供应商故障不藏进平均值。RPO ≤5min / RTO ≤30min 需真实备份恢复证明后再承诺。

指标：活跃/恢复中/中断会话、模型队列/并发/TTFT/idle 超时、WS 队列字节/慢端关闭、RSS/事件循环延迟/磁盘/SQLite、pending 审批时长、审计失败/锚定延迟、孤儿资源、预算预留/unknown usage/对账差异、任务完成率与每成功任务成本。label 只用有界 tenant/model/status；sessionId、principal、prompt、token 不作监控 label。

### 9. 运维交接与回滚纪律

- **审计/磁盘故障**：停止新任务与高风险批准，允许 abort/deny；留存证据，不删审计来腾盘；恢复写入后核对链头/账本再放流量。
- **上游故障**：熔断该通道、展示可恢复错误、核对未知计费；不自动切到未批准公网模型，不靠不断重启网关处理 429。
- **网关崩溃**：先验证独占锁/ready、receipt/审批/预算状态，再开放 attach；unsafe interrupted 需查 diff/远端 ref。回收只能按稳定 deployment/session label，不能按模糊名称删除别的租户资源。
- **疑似凭据泄露**：隔离入口/沙箱，吊销服务与客户端 credential，轮换 Git/模型 key，定位日志/备份/产物暴露范围；恢复前再次跑出口/身份负面测试。不要把泄露 secret 再发给模型排查。
- **发布回滚**：记录镜像 digest、依赖锁、policy/schema/价格版本；先备份并 canary。schema 不向后兼容时恢复整套一致备份或前向修复，不只换旧镜像。回滚不得放宽授权/出口/审批。
- **每次交接更新**：已完成阶段/commit、实际测试环境/命令/结果、证据路径、遗留风险及责任人、下一最小任务。生产批准、风险例外、真实成本数字没有证据就写“未知”，不沿用历史绿灯推定。
