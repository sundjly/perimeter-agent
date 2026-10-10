# 按 Pi Durable 重构 perimeter-agent

> 规格文档。实现者按 §6 的里程碑顺序推进，每个里程碑独立可测、单独 commit。
> 与本文冲突时以「四条铁律」（README）为准；本文没写到的细节，选最简单且不破坏铁律的做法，并在 §9 记一笔。

## 0. 目标

1. **多端分发，统一**：浏览器、CLI（以及以后的 IDE / Slack）都是同一会话的「展示端」，看到同一份状态。
2. **多人共享**：多人同时接入一个会话，有角色、有在场列表、审批谁批的都留痕。
3. **高性能、token 缓存最大化**：去掉每会话一个 pi 子进程；prompt 前缀稳定、会话亲和、命中率可观测。
4. **UI 一致、简洁**：一个 view model、一个 reducer，所有端同一语义；网页去掉全屏 modal。

## 1. 参考：Pi Durable 架构（earendil-works/pi，npm 1.1.0）

| 包 | 作用 | 本项目怎么用 |
|---|---|---|
| `@earendil-works/pi-durable` | 持久化 Harness：conversation = 不可变 entry 的 transcript；每次变更是原子 commit；内置 `pi.generation` / `pi.tool` 任务带 checkpoint，崩溃后 `resume()` 续跑；`viewState()` / `watch()` / `watchEvents()` 给 UI；hooks（`beforeTool` 可 block，异步，**抛错即 block**）；自定义 doc；inbox（follow-up / steer）；compaction；SQLite/JSONL 存储 | **采用**，作为 agent 运行时，跑在网关进程内 |
| `@earendil-works/pi-ai` | 统一模型 API；provider 支持自定义 `baseUrl` | **采用**，`baseUrl` 指向本项目模型网关 |
| `@earendil-works/chord` | 文档状态 / Context | durable 的依赖，按需 |
| `@earendil-works/pi-env`（`packages/env`） | 远程 ExecutionEnv：沙箱内跑 `pi-env serve` daemon，stdin/stdout 帧协议；`ConnectionOptions.command` 可自定义启动命令 | **采用**，docker/kubectl 后端用 `docker exec -i <ctr> pi-env` / `kubectl exec -i <pod> -- pi-env` 拉起 |
| `pi-server` / `pi-client` / `pi-protocol` | 多展示端 attach 同一 durable Session；`{serverId, sessionId, attachmentId}` 路由栅栏；CBOR 帧；**无认证** | **只借鉴语义，不直接暴露给浏览器**（理由见 §8） |

关键语义（实现时以源码为准，包名/导出名先用 `npm view` 与 `node_modules` 核实）：

- `Harness.open(storage, { models, registry, settings, env }, ctx)`；`harness.root(ctx)`；`root.submit({type:"input", content, requestId, whenBusy}, ctx)` → `Submission.wait()`；`harness.resume()`。
- `pi.provider` doc 里每个 conversation 有持久 UUIDv7，作为 `sessionId` 交给 pi-ai，用于 **provider prompt cache 亲和**，跨重启、压缩、换模型都不变。
- system prompt 由 extension 的 `section()` 渲染为**位置化的 system entry，只重发变化的部分** —— 易变的 section 会打碎缓存。
- `watchEvents(harness, conversationId, ctx)`：`snapshot` + 每次 commit 一批带 delta 的事件；消费者落后 >100 批时收到新 `snapshot`。迟到/重连 = 从当前快照开始，**不重放**。
- 存储：一个进程独占一个 storage，无跨进程锁。

## 2. 现状问题（第一性原理）

| 问题 | 根因 |
|---|---|
| 冷启动慢、内存随会话线性涨 | 每会话 spawn 一个 `pi --mode rpc` |
| 网关重启 = 所有会话状态丢失；挂起审批丢失 | 状态在网关内存（2000 条 backlog）与 pi 子进程里 |
| 断线续接复杂且会丢（`session.gap`） | 「事件流 + 环形缓冲重放」模型，而不是「状态 + 增量」 |
| 策略/审批/审计要绕三道弯：`hook-armed` 握手、`notify` 回传审计、`ctx.ui.select` 子协议 | 钩子跑在沙箱里的 pi 进程，网关隔着 stdout 才能看到 |
| 沙箱可读模型网关 token（`models.json`） | 模型调用发生在沙箱内 |
| 多端/多人只能各自重放事件，前端命令式 append DOM | 没有单一 view model |

## 3. 目标架构

```
 Browser ─┐                       ┌──────────────── Gateway（可信） ───────────────────┐
 CLI ─────┼─ WS · 协议 v2 ───────▶│ Hub：attachment / 角色 / 在场 / 有界发送队列        │
 (IDE…) ──┘  snapshot + 增量事件   │ SessionHost：每会话一个 Harness（SQLite，懒打开）   │
                                  │ PerimeterExtension：beforeTool = 策略+审批+审计     │
                                  │ translate：durable 事件 → ClientEvent（唯一转换点） │
                                  │ AuditLog（唯一写入者）                              │
                                  └───┬─────────────────────────────┬──────────────────┘
                                      │ pi-ai, baseUrl=模型网关       │ ExecutionEnv
                                      ▼                              ▼
                                   ModelGW ──▶ 上游          Sandbox（local 目录 / 容器 / Pod）
                                   （凭据只在这里）           只执行工具的文件与进程操作 ──git──▶ GitProxy
```

信任边界的变化：**agent 循环与策略钩子回到网关进程**，沙箱只剩工具的系统调用。
沙箱里不再有任何模型相关配置与 token；沙箱出网只需要 git 代理。

存储布局：`<stateRoot>/sessions/<sessionId>/{meta.json, session.sqlite}`，工作区仍在 `workspaceRoot`。
网关单实例独占这些 SQLite（durable 无跨进程锁）。水平扩展 = 按 sessionId sticky 路由到网关实例，**不在本次范围**。

## 4. 四个目标的落地

### 4.1 多端统一：协议 v2（仍是自有协议，零 pi 类型）

- 保留现有 `ClientEvent` 词汇（`message.*`、`tool.*`、`approval.*`、`policy.denied`、`audit.entry`、`usage`、`agent.*`、`error`），由 `translate.ts` 从 durable 的 agent events 转出。
- **新增** `session.snapshot { view: SessionView }`：attach 时、以及该 attachment 发送队列溢出时下发。`SessionView` 是自有类型（transcript 摘要、进行中的消息与工具、inbox、待审批、usage、模型、参与者、最近 N 条审计视图）。
- **新增** `session.presence { participants: {actor, role, clients}[] }`。
- **删除** `session.gap`、`resume` 命令、服务端 backlog 与 `#replay`。重连 = 重新 attach = 新快照。
- 命令：`prompt`/`steer` 带客户端生成的 `requestId`（用 durable 的 `requestId` 幂等，断线重发安全）；`abort`；`approve`；新增 `share`/`unshare`（§4.2）。
- 每个 attachment 一个有界发送队列；超过上限丢弃队列、下发一次 `session.snapshot`（与 durable 的 lag 策略一致）。
- `CLIENT_EVENT_TYPES` 双向穷尽性检查、`tests/protocol-coverage.test.ts` 保留并随之更新。
- **共享 view model**：`web/view-model.js`（纯 ESM，无 DOM，JSDoc 类型）导出 `initialState()` 与 `reduce(state, event)`。网页与 CLI 都用它；`tests/protocol-coverage.test.ts` 改为核对 reducer 覆盖所有事件类型。
- **CLI 端**：`scripts/attach.ts`（`npm run attach -- --session <id>`），用同一个 reducer，行式输出，支持 prompt / steer / approve / abort。它是「多端统一」的证明，不做全屏 TUI。

### 4.2 多人共享

- `meta.json`：`{ id, owner, repo, team, createdAt, members: { [actor]: "owner" | "editor" | "viewer" } }`。repo/team 仍由服务端 `resolveScope` 决定，客户端不能自选。
- 权限：`viewer` 只读；`editor` 可 prompt / steer / abort / approve；`owner` 另可 `share { actor, role }` / `unshare { actor }`。非成员 attach 拒绝（沿用现有「拿到 id 也接不进来」）。
- 每条命令都带 actor 写审计；审批 `approval.resolved` 带批准人，**先到先得**（在 commit 里检查状态）。
- 用户消息要显示作者：优先用 durable 原生能力；没有的话用自定义 doc（如 `perimeter.authors`，按 entry/submission 映射）。**不要把作者拼进 prompt 文本**（污染模型输入）。
- busy 时：`prompt` 走 inbox follow-up，`steer` 显式插话 —— 多人同时发不会互相覆盖。

### 4.3 高性能与 token 缓存最大化

缓存规则（每条都要有测试守着）：

1. **前缀稳定**：`section()` 只放静态内容（角色说明、策略摘要、repo/team）。禁止时间、会话 id、审批状态、在场人数等易变量进 section。测试：同一会话连续多轮，渲染出的 system 内容逐字相同。
2. **工具集稳定**：不按策略动态增删工具，拒绝一律走 `beforeTool` block；工具顺序固定。测试：策略变化前后 offered tools 列表一致。
3. **被拦/未批的结果文本确定**：block 文本只含规则名与理由，不含时间戳、倒计时、审批人 —— 否则同样的拒绝每次都是新 token。
4. **会话亲和**：pi-ai 透传的 `sessionId` 到模型网关后**不得被剥掉**；模型网关保留 `cache_control` 等缓存相关字段原样转发，并把它作为审计/计量的 session 关联（替代现在的 `x-perimeter-session` 头或与之对齐）。读 `src/modelgw/server.ts` 确认现状并加测试。
5. **压缩**：开启后台压缩（`compaction.backgroundTokens`），避免请求被同步压缩阻塞。
6. **可观测**：`Usage` 增加 `cacheHitRate = cacheRead / (input + cacheRead + cacheWrite)`（分母为 0 时为 null）；UI 顶栏显示；evals 报告带上。

性能：

- Harness 在网关进程内，会话**懒打开**、空闲关闭（关 Harness，SQLite 留盘）；网关重启后首次 attach 时 reopen + `resume()`。
- 进度提交间隔保持 durable 默认 100 ms。
- docker/kubectl：会话启动时用 `exec -i` 拉起一个常驻 `pi-env serve`，所有文件/进程操作走这一条连接，不再每个操作起一个 `docker exec`。沙箱镜像需安装 pi-env（改 `deploy/sandbox.Dockerfile`）。

### 4.4 UI 一致、简洁

- 网页改为 `render(state)`：所有 DOM 由 `view-model.js` 的 state 派生；只用 `textContent`（`tests/web-injection.test.ts` 保留）；CSP 不放宽；零构建零依赖不变。
- 布局：顶栏（连接点 · 模型 · 参与者 · token 与缓存命中率）；主区对话流（用户消息带作者、助手消息、可折叠工具卡、策略拒绝为红色内联条目）；**审批改为对话流内联卡片**（请求的工具与目标、触发人、倒计时、批准/拒绝；viewer 不渲染按钮）——多人场景下全屏 modal 会挡住所有人；右侧审计栏可折叠；底部输入区：空闲时「发送」，忙时「排队」与「插话」+「中止」。
- 设计 token：CSS 变量统一颜色/间距/字号；状态色只有四种（ok / deny / pending / info）。
- 状态文案表放在 `web/labels.js`，网页与 CLI 共用，保证两端措辞一致。

## 5. 铁律复核（迁移后必须仍成立，且测试要跟着改而不是删）

| 铁律 | 迁移后 |
|---|---|
| 代码不离开 Data Plane | 不变。审计仍只记 hash；SIEM 白名单不变 |
| 凭据不进沙箱 | **加强**：模型调用在网关进程，沙箱里连模型网关 token 都没有。改写 wiring 测试：遍历沙箱全树，断言无任何模型/网关 token；git 代理 token 仍按现状不在 workspace 内 |
| egress 默认拒绝 | 不变（仍是设计承诺）。生成的 NetworkPolicy 去掉沙箱 → 模型网关这条出口 |
| 每次工具调用过策略且留痕 | `PerimeterExtension.beforeTool`，进程内、抛错即 block（fail-closed）。**nested call（`call.parent`）同样过策略**。用「submit 前断言该会话 `agent()` 选中了 perimeter 扩展」替代 `hook-armed` 握手，作为运行时证据；不满足就拒绝 prompt |
| 审批默认拒绝 | 审批存进自定义 doc（如 `perimeter.approvals`），所有展示端从 doc 看到同一份；超时/无人应答 = 拒绝。网关在审批中途崩溃：重启后该工具任务重跑 `beforeTool`，旧审批标记过期、发新审批 —— 在文档里如实写 |
| 审计唯一写入者 | 网关（钩子现在就在网关进程，直接写） |

已知边界保持如实：bash 的路径规则不生效（README「边界」一节不变）。
RPC `bash` 直接命令旁路这条随 RPC 一起消失，README 相应更新。

## 6. 里程碑（顺序执行；每步 `npm test` + `npm run typecheck` 全绿才 commit，再进下一步）

**M0 依赖与骨架**
- `npm install` 精确版本（不带 `^`）：pi-durable、pi-ai、以及实际需要的 chord / pi-env。
- 更新 `tests/k8s-schema.test.ts` 里运行时依赖白名单（现为 `["ws","yaml"]`），并在 README/handoff 写明为什么放宽这条硬约束。
- 核实 Node 22.18+ 下直接 `node` 运行（类型剥离）能 import 这些包、`node:sqlite` 可用。

**M1 运行时核心** —— `src/runtime/`（durable 的全部引用只许出现在这个目录与 `src/protocol/translate.ts`）
- `harness-host.ts`：按会话打开/关闭 Harness（SQLite 存储）、models 指向模型网关、env 工厂、resume。
- `perimeter-extension.ts`：静态 section + `beforeTool`（策略引擎 → allow / deny / 审批）+ 审计写入。
- `approvals.ts`：审批 doc、等待、决定、超时。
- 零凭据 demo 必须保留：继续用 `tests/fixtures/mock-model.mjs` 经模型网关（推荐，能覆盖整条链路），或改用 pi-ai 的 faux provider —— 选一个并说明。
- 移植 `policy-hook` / `redteam` / `redteam-e2e` 测试到新运行时。

**M2 执行环境**
- `ExecutionBackend` 产出 durable 的 `ExecutionEnv`：local = `NodeExecutionEnv({cwd: workspace})`；docker/kubectl = pi-env 远程 env（`exec -i` 拉起 daemon）。
- 保留 `exec()` 供 evals 验收；保留容器/Pod 的创建、回收、`reapOrphans`；clone 仍在会话启动时经 git 代理。
- 改 `deploy/sandbox.Dockerfile` 装 pi-env；`docker-backend` 测试跟着改。

**M3 协议 v2 + Hub**
- 重写 `translate.ts`（durable 事件 → ClientEvent）与 `session.ts`（Hub：attachment、在场、有界队列、snapshot）。
- 删除 backlog / gap / resume；更新 `gateway.test.ts`、`protocol*.test.ts`。

**M4 多人共享**：`meta.json`、角色、`share`/`unshare`、作者标注、权限检查与审计；新增测试：viewer 不能 prompt/approve、非成员不能 attach、审批先到先得。

**M5 前端与 CLI**：`web/view-model.js`、`web/labels.js`、`app.js` 重写为 `render(state)`、布局按 §4.4；`scripts/attach.ts` + `npm run attach`；reducer 单测。

**M6 缓存与性能守卫**：§4.3 的 1–6 条各一组测试；evals 报告加命中率。

**M7 清理与文档**：删 `src/rpc/`、`src/gateway/policy-extension.ts`（pi 进程扩展）、`hook-armed`、`tests/fixtures/fake-pi.mjs` 等失效物；`npm run demo` 三段（放行 / 拒绝 / 审批）照常可跑，且 demo 不再要求全局安装 pi；README（含「四条铁律」表、目录、30 秒跑起来）与 `docs/handoff.md` 更新；`docs/review-log.md` 记一笔。

## 7. 验收

- `npm test` 全绿，`npm run typecheck` 干净。
- `npm run demo`：放行 / 拒绝 / 审批三段可用；两个浏览器标签 + 一个 CLI 同时 attach 同一会话，状态一致；viewer 看不到审批按钮且服务端拒绝其审批命令。
- `kill -9` 网关后重启，attach 原会话：transcript 完整；进行中的运行被续上或得到 `interrupted` 结果（durable 语义）。
- 负面验证纪律（见 handoff）：每个守卫测试写完后把被守的东西改坏，确认变红，再改回。

## 8. 明确不做

- 不把 `pi-server` / `pi-protocol`（CBOR）直接给浏览器：实验性、无认证、会把 pi 的格式暴露给前端，违背「前端永不见 pi 格式」这条护城河。借鉴它的 attachment 语义即可。
- 不做 OIDC/SAML、跨进程共享 SQLite、网关水平扩展、四眼审批（同一人不能批自己触发的操作）—— 后两者记入 handoff 的下一步。
- 不保留路线 C（`pi --mode rpc`）作为回退：两套运行时并存的测试与维护成本高于收益。

## 9. 实现记录（实现者填写）

API 与本文假设不符、做了取舍、或推迟的事项，逐条记在这里。

- M0：四个 Pi 包精确锁定 1.1.0；发布包仅含 dist，后续以 dist 的源码与类型为准。包 engines 声明 Node ≥22.19.0；实际用 Node 22.18.0 直接导入四包及 node:sqlite 成功，当前环境 Node 24.21.0 同样成功。尚不把导入成功当作完整运行时兼容性证明。
- M0 基线已有一条失败：本地 pi-mono 新增 powershell，旧 RPC fixture 过期；更新清单期望，未修改策略豁免。依赖守卫负面验证：额外包名与 ^1.1.0 均使断言失败。
- M1：新增 SQLite HarnessHost、网关模型目录、进程内 perimeter 扩展与审批 doc；零凭据仍用 mock-model 经模型网关，已有真实工具放行/拒绝/超时、持久 transcript/幂等和移除守卫负面测试。旧网关在 M3 切换前暂保留，旧 RPC 测试在 M7 清理。
- API 差异：Context 取消字段为 abortSignal；HookApi 只有读与 memo，审批通过 root.commit 写 doc。ToolCall 无 parent 字段，不按 parent 豁免任何调用；实际 CodingTools 仅 read/write/edit/bash，不提供 nested-call 入口。内置 unsafe 工具在执行意图落盘后恢复得到 interrupted，执行阶段不重跑 beforeTool；审批等待在意图之前，重启旧 pending 标 expired 后重新请求。保持 unsafe 默认，不升级重放安全性。
- M2：ExecutionBackend 增加 environment()，local 用隔离的 shellEnv 创建 NodeExecutionEnv；Docker 创建保留安全限制的常驻容器，工具经 docker exec -i pi-env 单连接；K8s 保留 Pod 创建/cp/回收，经 kubectl exec -i pi-env。保留 exec() 给 evals。沙箱镜像改为仅安装静态 pi-env daemon，不含 agent、模型配置或网关代码。Connection 自行附加 serve/token 参数，command 不手动重复。旧 launch 过渡 API 到 M7 删除。
- M3：产品 Session 已切换 Harness，去掉 backlog/gap/resume；translate 唯一转换 durable 格式。attach 给当前快照，发送队列上限 100，溢出丢队列并补快照。当前实现每个 durable 事件批次结束额外补一份规范快照，保证已有增量与重新 attach 收敛，后续可优化带宽；未改变 durable 100ms 默认提交节奏。旧 RPC 单元测试暂留到 M7，不是产品回退路径。旧 piEnv.HOME 模型目录仅作为可信配置的过渡读取入口，绝不传入工具环境。沙箱 HOME 清除旧 .pi 配置。
- M3 审查修复：owner 暂以独立 owner.json 持久保存，避免首次重启 attach 越权；远程后端缺 environment 时拒绝回退宿主；clone 与 .git 检查均在真实执行环境内；启动关闭竞态等待收尾，每步清理独立兜底。凭据负面验证向沙箱 HOME 临时写入模型 token，wiring 测试确认变红，随后恢复。
- M4：meta.json 保存 owner、服务端 repo/team、members；stateRoot/sessions/id 统一存放元数据与 SQLite，workspace 仍独立。每条命令服务端重查角色，owner 才能共享，撤销共享关闭已有连接；snapshot 个性化角色并带在场列表。成员查找用 own-property，防 constructor 等原型属性越权。作者 doc 以无歧义的 [actor,requestId] 编码映射，不污染模型输入；工具触发人取当前 run 最近一条 input 的持久作者。审批 first-wins 沿用 M1 原子 doc 检查。负面验证临时去掉 viewer 检查，多人权限测试确实变红，恢复后复测。
- M5：网页与行式 CLI 共用纯 reducer/labels；网页由 state 渲染，审批内联、viewer 无按钮、工具卡按 transcript 顺序展示、审计可折叠。CLI attach 打印已有 transcript/待审批 ID，去重快照输出，支持 prompt/steer/approve/abort 与 ws/wss。注入守卫负面验证：临时把 textContent 改为 HTML 注入接口，测试确实变红并恢复。协议覆盖测试改检查 reducer 的所有 case，message.end 不再豁免。
- M6：Usage 增加 cacheHitRate，网页/CLI/evals 显示；模型目录显式开启 OpenAI 会话亲和头，模型网关白名单保留这些头并以 UUID 关联计量，cache_control 等请求体原样透传。后台压缩保留 32768 tokens，进度间隔沿用默认。六条缓存守卫已做负面验证：易变 section、实际 Harness 第二轮移除工具、扩展动态 tools、拒绝文本掺 callId、关闭后台压缩、错误命中率分母、剥离亲和头均对应变红；恢复后全量复测。
- M7：删除 RPC 成帧/进程、沙箱 pi 扩展、hook-armed 与失效 fixtures；policy-hook 与红队改走 durable。demo 无全局 pi、模型与 git 代理 token 分域；显式 model 配置也检查凭据碰撞，旧 HOME 的 .pi 无条件清除。沙箱镜像只留 pi-env，沙箱 NetworkPolicy 仅 git + DNS，生成物已同步。内置工具实际只有 read/write/edit/bash，因此只读名单改为 read，边界期望更新而不回退策略。
- 新发现的 API 差异：NodeExecutionEnv.shellEnv 默认仍合并 process.env，已通过 localEnvironment 强制 inheritEnv:false；真实 bash 环境负面验证变红并恢复。工具参数校验先于 beforeTool，Generation.afterResponse 先为所有工具意图求策略并记 hash，实际执行前再次检查；非法参数不执行也有审计。watchEvents 的自定义 doc 不保证产生 built-in 增量，所以审批直接从已提交 doc 发自有事件，端侧 reducer 同时处理快照和增量，不能假设每次审批更新都伴随新 snapshot。
- M7 收尾修复：metadata 原子保存，作者关联直接只读查询已独占的 storage，避免只读查询产生无意义 commit；RuntimeStream 封装 durable 事件，Hub 不再识别 pi 格式。快照 seq 稳定后同步入队，消除 Promise 回调间隙。角色 presence 个性化到本 attachment，降级 viewer 立即更新 UI；空闲回收关闭旧连接供重连；启动失败与清理均 fail-closed/幂等。CLI 打印历史、实时待审批 ID 与工具结果，屏蔽终端控制字符，支持共享命令。审批人/触发人进入审计视图，SIEM 字段白名单未扩大。
- 验收：实际 npm run demo 完成放行/拒绝/批准后真实推送；ego-browser 两标签 + 行式 CLI 同会话消息/工具/在场一致。实际 viewer 页面挂起审批时按钮数为 0、输入禁用，直接 approve 返回 command_failed；kill -9 子进程测试证明 transcript/owner 保留，旧审批过期后新发、旧 id 不能放行。Node 22.19 运行时/缓存目标测试 9/9；22.18 仅完成 M0 导入烟测，支持版本按包声明提升到 22.19。eval 的 pass 数守卫显式 spec reporter，避免 Node 22/24 默认报告格式差异。
- M7 负面验证：恢复环境继承、移除非法参数意图审计、去掉角色降级更新、取消模型/git token 碰撞校验，四条相应测试都变红；恢复后跑全量。CLI 实时审批新增真实子进程验收，旧 RPC 专属测试删除，不保留第二套运行时。

实现总结：已完成 M0–M7 的网关内持久 Harness、执行环境、v2 Hub、多人成员与作者、共享 reducer/CLI、缓存守卫及清理文档；按顺序各自验证并提交，不 push。未做 OIDC/SAML、跨进程 SQLite/水平扩展/sticky 路由、四眼审批、Helm、多 SCM/monorepo，也未验证真实模型上游、生产缓存收益、新 Docker 镜像/真实 K8s/egress 部署。风险：共享 token + 自报 actor 仍是演示身份，可冒用成员，不能作为生产可信角色边界；local 没有文件系统隔离；Pod emptyDir 删除会丢未推送改动，生产需持久工作区；unsafe 工具 interrupted 可能已有副作用；每批额外快照有带宽成本，模型目录价格为 0；SQLite 必须单实例独占。bash 路径规则与 DNS/合法模型通道的既有边界保持如实表述。

- f39c25c Review 修复：取消普通 durable 批次后的全量快照，仅 attach、启动及队列溢出恢复使用快照（包括 durable watch 自身溢出）；首次 attach 等启动完成，避免双初始快照。message.start 从当批 submission 与 AuthorsDoc 携带 actor；view 的作者关联改为 Map，watch 复用原始初始快照。补齐消息最终 ID/顺序/思考、初始内容与块替换、工具结果/拒绝、inbox 增量及审批字段归一；消息按 entry ID 合并，工具按 callId 更新。Hub 用共享 reducer 保存已发布状态并同步生成快照，避免持久 commit 领先尚未发送的 delta；独立测试仍对比增量状态与真实持久快照。流式多段文本与工具运行的单个 attachment 恰好收到一条 attach 快照，中途 attach、挂起审批与最终重连状态一致。负面验证：恢复逐批快照得到 12 条而非 1 条；取消 ID 合并、工具 upsert、块处理及恢复 Hub 读取 durable view 均使对应守卫变红，已恢复。指定文件新增的超 180 字符长行按原风格拆开，未格式化其他代码；只读 subagent review 无剩余阻塞，npm test 368/368、typecheck 全绿。本次未做生产吞吐压测或 reducer 的 transcript 复制优化；快照带宽问题已修复，长会话仍有 reducer 复制成本，既有安全策略与部署限制不变。
