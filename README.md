# perimeter-agent

> 一个可完全私有部署的 code agent 运行时，代码与凭据永不出客户网络边界，浏览器只是零安装的操作面。

本仓库是 [`browser-code-agent-strategy.md`](../browser-code-agent-strategy.md) 里工程部分的实现。浏览器 → 网关 → pi → **模型网关** → 上游是一条真实跑通的链路：网关为每个会话生成隔离的 pi HOME，`models.json` 指向模型网关、apiKey 是会话 token，上游凭据只存在于模型网关进程里。git 代理的接线（`insteadOf` 重写）已实现但**未接到 demo 上**，见「边界与已知缺口」。商业动作（客户访谈、融资、付费 POC）不在本仓库范围内。

底层 agent 用 [pi](https://github.com/badlogic/pi-mono)（MIT）的 RPC 模式，走策略文档 §5 的**路线 C**。

## 30 秒跑起来

前置：Node ≥ 22.18，以及**全局安装的 pi**（本仓库只用它的 RPC 模式，故意不作为 npm 依赖锁死版本）：

```bash
npm i -g @earendil-works/pi-coding-agent   # 实测版本 0.84.2
npm install && npm run demo
```

`pi` 必须在 PATH 上。demo 会先预检 —— 早期版本不预检时的失败形态是最难排查的那种：地址照常打印，客户点开链接才收到 `spawn pi ENOENT`。

打开终端里给出的地址，发一句「修复登录超时的 bug」，会看到三段：

1. 改源码 → 放行，右侧审计流实时出现 `policy.verdict allow`
2. 改 `.github/workflows/` → **被策略拒绝**，界面上出现红色条目，文件从未落盘
3. `git push` → **审批门拦下**，等人点批准或拒绝，超时按拒绝

演示用 mock 模型端点，**不需要任何 API key、不需要外网**。这既是钩子测试的前提，也是策略文档要求的「演示环境挂掉时的保险」。接真实模型：`PERIMETER_DEMO_REAL=1 npm run demo`，并按 pi 的常规方式配好 provider。

```bash
npm test          # 172 个测试
npm run typecheck
npm run gen:netpol  # 从 config/policy.yaml 重新生成沙箱 NetworkPolicy
```

## 四条铁律与它们各自落在哪

| 铁律 | 落地位置 | 现状 |
|---|---|---|
| 代码永不离开 Data Plane | 审计只记 hash 不记源码（`src/audit/log.ts`） | ⚠️ 有一处有意例外：`command` 存原文（heredoc 写文件、带凭据的 curl 同样会落库），导出 SIEM 前须视为敏感字段 |
| 凭据永不进沙箱 | git 凭据代理（`src/gitproxy/`）、模型网关（`src/modelgw/`）、pi 子进程 env 白名单 | ✅ |
| egress 双出口 + 默认拒绝 | `config/policy.yaml` 的 `egress.deny_all_except` → 生成 `deploy/networkpolicy.yaml` | ❌ **设计承诺，不是运行中的事实**。清单只做了生成与静态校验，没有任何代码去 apply 它 |
| 每次工具调用过策略且留痕 | pi 扩展注入 `tool_call` 钩子（`src/gateway/policy-extension.ts`） | ✅ 钩子级粒度，见下。但**路径规则对 bash 不生效**，见「边界」 |

## 一个被验证的关键判断

策略文档 §7.2 把这条列为 P1·W5 的**第一件事**：路线 C 只能在网关层拦事件流，粒度是「中」，而 Phase 1 的验收标准要求「100% 工具调用有记录、0 例绕过审批门」。走不通就必须下调验收标准（R10）。

**结论：走得通。** pi 的扩展机制可以注册 `tool_call` 钩子，它在工具执行前触发且能 block；审批走 pi 现成的扩展 UI 子协议（`ctx.ui.select` → stdout → 网关 → 浏览器），不需要额外开端口。因此不必等 Phase 2 迁路线 A，现在就有钩子级粒度。

沿途实测到三件与文档不符、值得记下的事：

- **RPC 的 `bash` 直接命令不经过 `tool_call` 钩子**（它不是模型的工具调用）。网关因此不把它暴露给前端 —— 暴露了就等于开了一条绕过策略引擎的路。
- **pi 对未知事件名不报错、不发 `extension_error`**，钩子注册失败是静默的，工具照常执行。所以扩展会在会话开始时发一条 `hook-armed` 握手，网关在收到之前拒绝下发任何 prompt。这是「0 例绕过」唯一的运行时证据。
- **真实 pi 只发 `agent_end`**，文档里的 `agent_settled` 在这条路径上不出现。

## 目录

```
src/protocol/     自有事件协议 —— 前端永不见 pi 的格式（Phase 2 迁移的护城河）
src/rpc/          JSONL 成帧 + pi 子进程生命周期
src/policy/       策略引擎：deny / require_approval / allow
src/audit/        append-only 审计日志（哈希链）
src/gateway/      会话网关、审批门、策略扩展
src/modelgw/      模型网关：出口 allowlist、凭据隔离、计量配额
src/gitproxy/     git 凭据代理
src/deploy/       从策略文件生成 NetworkPolicy
web/              零构建操作面
config/policy.yaml  策略与 egress allowlist 的唯一事实来源
deploy/           K8s 清单
```

技术栈刻意保持最小：TypeScript 直接由 Node 运行（类型剥离，无构建步骤），运行时依赖只有 `ws` 与 `yaml`，测试用 `node:test`。

## 边界与已知缺口

这一节是给自己和客户安全团队看的，**销售材料里不要越过它**。

**Phase 1 的运行形态没有沙箱 —— 这是最重要的一条：**

网关直接在宿主机上、以自己的 OS 用户 spawn 一个 pi 子进程，只设了 `cwd`，**没有 FS 挂载限制、没有网络限制**。`deploy/sandbox.yaml`（gVisor + 只读根 + 无 SA token + 每会话独占 Pod）与 `deploy/networkpolicy.yaml` 只做了生成与静态校验，**没有在真实集群上跑过，也没有任何代码去创建它们**。

因此「每会话独占沙箱」与「egress 默认 deny」这两条边界目前是**设计承诺，不是运行中的事实**：演示环境里 agent 的 bash 能访问网关宿主机的文件系统与公网。四条铁律里今天在代码中真正成立的只有「凭据不进沙箱」与「工具调用过策略且留痕」。

**接线：模型网关已接，git 代理未接到 demo：**

网关会为每个会话生成沙箱侧配置（`src/gateway/sandbox-config.ts`）：`models.json` 的 baseUrl 指向模型网关、apiKey 写会话 token；git 的 `insteadOf` 规则把上游 SCM 重写到 git 代理并关掉本地 credential helper。

- **模型网关**：已在 demo 与端到端测试里跑通。测试遍历沙箱能看到的全部文件，断言其中既无上游凭据、也无网关 token，只有代理 token；请求确实经过模型网关（有计量记录）。**三个 token 刻意取不同的值** —— 代理 token 若等于网关 token，agent 读到 models.json 就能连回网关批准自己挂起的审批，网关构造时会拒绝这种配置。
- **git 代理**：配置生成有测试覆盖，但 demo 没有起 git 代理，也没有真实上游仓库可指 —— 这条链路**未端到端验证**。

**其余未在真实环境验证：**

- git 代理的真实 `git clone` / `git push` 端到端**未自动化验证**（本机系统级 git 配置会干扰无人值守运行）。Week 3 验收里的这一条需要在演示环境用真实 GitLab 手动跑一次

**明确没做：**

- **Bedrock / Vertex 的原生协议**。模型网关说 OpenAI 兼容协议（Azure OpenAI、自托管 vLLM 原生就是），Bedrock 与 Vertex 需要各自 SDK 签名 —— 不要写成「已支持 Bedrock/Vertex」
- **身份**。Phase 1 只有共享 token，作用是把演示环境关起来。OIDC/SAML + RBAC 是 Phase 2。且浏览器的 WebSocket 无法自定义 header，token 走 URL query，**会进反向代理与服务器访问日志**
- 沙箱编排、Helm chart、多 SCM、SIEM 导出、monorepo 支持

**能力边界（不是缺口，是设计上的取舍）：**

- **路径 deny 规则只对带 `path` 参数的工具（write/edit 等）生效。** bash 按命令模式匹配，`echo x > .github/workflows/ci.yml` 在本引擎眼里没有路径。也就是说 `config/policy.yaml` 里那份 deny_paths 清单（CI、IaC、`.pi/**`、`AGENTS.md`、`.git/config`）**对 bash 写文件不成立**，只能靠命令黑名单兜 —— 而黑名单如下一条所述不是安全边界。要让路径规则真正统一，需要 Phase 2 在 FS 层（RemoteExecutionEnv）收口。`tests/redteam.test.ts` 里有一条测试专门断言这个局限。
- **只读工具豁免路径规则**，因此 `read .env` / `read ~/.aws/credentials` 是放行的，内容会进模型上下文。这是为避免审批疲劳的有意取舍（每次读 `package.json` 都要人批，几轮后操作员就会无脑点同意），缓解手段是模型网关的凭据检测，它现已在链路上，但只告警不阻断。
- **命令黑名单是启发式，不是安全边界。** shell 的求值方式（变量展开、base64、别名、间接调用）注定它可被绕过。设计上的真边界是 egress 默认 deny + 凭据不进沙箱 + 每会话独占沙箱，而其中两条目前尚未运行（见上）。`tests/redteam.test.ts` 里有一条测试**刻意断言黑名单拦不住**。
- **egress allowlist 即便部署了，也只杀掉「直连任意外部主机」这一类外泄。** 生成的策略必须放通 DNS（否则内部主机名都解析不了），DNS 隧道仍然可行；经模型网关的请求体本身也是一条合法外泄通道（凭据检测是 audit-only，不阻断不改写）。
- **哈希链防的是意外损坏与粗糙篡改，不防有文件写权限的攻击者** —— 那种攻击者能从头重算整条链，也能截断尾部。要升级为防恶意篡改需要外部锚点（链头是纯元数据，可以出 Data Plane），`AuditLog.verify(path, expectedHead)` 已留入口，上报由部署侧接。安全白皮书里必须同口径表述，不要写成「防篡改」。
- **PII/secret 检测只做 audit-only**（检测 + 告警，不改写流）。对代码流做正则/熵改写误伤率高，会直接破坏生成质量；阻断模式要等有真实误报数据再上。

## Phase 2 迁移成本

整个 roadmap 里最重要的一条工程纪律：**前端永远不直接消费 pi 的事件格式**。

**零改动的部分**（已核实无任何 pi 引用）：`src/protocol/types.ts`、`web/`、`src/policy/`、`src/audit/`、`src/modelgw/`、`src/gitproxy/`。前端与协议定义是这条纪律的主要受益者。

**需要重写的部分**：

| 位置 | 涉及的 pi 知识 |
|---|---|
| `src/protocol/translate.ts` | 全部事件与命令的格式转换，这是设计上的唯一转换点 |
| `src/rpc/` | JSONL 成帧与子进程生命周期，路线 A 下整个消失 |
| `src/gateway/policy-extension.ts` | pi 的扩展 API 与扩展 UI 子协议，改为直接注册 `beforeToolCall` |
| `src/gateway/session.ts` | **仍直接消费三个 pi 事件类型名**：`extension_ui_request`（审批通道）、`tool_execution_start` / `tool_execution_end`（兜底审计）。这三处是纪律上的例外，Phase 2 要一并处理 |

session.ts 那三处是有意识的取舍而非疏漏：审批通道与兜底审计都需要在 translate 之外做副作用（写审计、发审批），硬塞进纯转换函数会让 translate.ts 变成一个有状态的上帝对象。但它们确实构成迁移成本，不该在文档里被说成零。
