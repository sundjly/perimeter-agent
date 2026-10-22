# s2-scm-scoped-grant-contract.md — S2-B2 gitproxy 会话/repo/ref scoped grant 最小闭合合同（设计与验收；B2 代码/测试全部 pending）

- 日期：2026-10-18；作者：Grok（唯一 reviewer，原终端/模型复用）。性质：**只读设计合同**——证据全部来自实读源码/配置/测试/handoff §5.2+§7/continuation-scope-audit §7（行号见 §1），零运行、零产品/测试/coverage/progress 写入。本轮唯一 repo 写入=本文件。
- 本文件写给下一批 Pi 实现 B2 用，是一份**可执行的最小闭合合同**：接口、路径、最小增量、负控矩阵全部落到现有代码证据上。它**不是**对 SDK/runner/R38/R39 结论的重审：R39 的自然 exit/实际 counts 绿维持有限认可，runner2 timeout 的 same-birth/固定 3sps/迟预挂/无限 wait/最终 IO 前采样等硬界声明本轮不采信、不复用、不重跑；旧 R38/R39 原文保留。
- **B2 代码与测试在本合同签署时尚未实现。本文档不含任何完成勾。** 所有 §7 验收项初始状态均为 pending。
- 与 Pi 当前 B1/B3 dispatch（task_0f8d88a845e6）零交集：B1 面=src/runtime/path-guard.ts+src/policy/engine.ts+config/policy.yaml 的 deny_reads；B3 面=src/modelgw/*。本合同实现面不触碰这两处。

## 0. 结论先行（三态能力，防止过度工程）

| 能力 | 本片可交付？ | 理由（证据见 §2/§3） |
|---|---|---|
| 会话/repo/rw/租户 scoped 短期 grant + 吊销 | **是** | 签发/登记/吊销所需可信服务端件全部已存在（§1.2），只缺接线 |
| 限 ref **写**（writeRefs） | **是** | receive-pack 请求体自带 ref 更新命令，上游写之前可解析校验（§3.B6） |
| 限 ref **读** | **否（本片明确不做）** | v0 want 行只含 SHA、v2 可裸 SHA want，任何"只过滤 advertisement"的实现都可被任意 SHA want 绕过（§3.B5）；配置层必须 fail-closed 拒绝此配置，不得静默降级为全 refs 读 |

## 1. 现状证据（只读实读，行号为 2026-10-18 工作区状态）

### 1.1 B2 缺口（现状即攻击面）
- `src/gitproxy/server.ts:28,183-191`：单一共享会话 token，`#authorized` 接受 `Bearer <token>` 或 Basic 任一字段等于该 token。无租户/principal/session/repo/ref/rw/exp/jti 维度，无吊销。
- `src/gitproxy/server.ts:196-197`：审计 `sessionId`/`actor` 取自请求头 `x-perimeter-session`/`x-perimeter-actor`——**客户端自填**，任何持 token 者可伪造审计身份。
- `src/gitproxy/server.ts:152-158`：透传 `content-type/accept/git-protocol/content-encoding`；`:159-166` 请求体流式直转上游——receive-pack 的 ref 更新命令在**上游写之后**才被任何一方看到，代理层无预校验。
- `src/gitproxy/server.ts:157`：上游 `fetch` 未设 `redirect`（默认 follow）。同文件既有正面资产：`:104-111` repo allowlist、`:124-128` allowPush 默认只读、`:113-121` 端点/方法白名单、`:139-148` service 参数单值白名单透传（重复参数分歧已闭合）、`:214-218` parsePath 仅认三个 smart HTTP 端点、`redactUrl` 审计剥凭据。
- `src/gateway/sandbox-config.ts:55-60`：沙箱 `.gitconfig` 用 insteadOf 把 `https://<scmHost>/` 重写到 `http://x-session:<gitProxyToken>@proxy/<host>/`，credential helper 置空；token 只在 workspace 外的 HOME。
- `scripts/demo.ts:45,120-149`：`GIT_PROXY_TOKEN` 为全部署静态常量；每个会话拿到同一个。
- `src/gateway/server.ts:255-263`：只有"模型 token ≠ gitProxyToken ≠ 网关 token"的相异校验，无生产/开发模式区分。

### 1.2 已存在、可直接复用的可信服务端件（B2 不新造）
- `src/gateway/auth.ts:425-490`：`BrowserSessions`——服务端不透明 sid→principal 登记、过期清扫、`delete`/`revokePrincipal`/`restore`/`dump`（重启恢复）。
- `src/gateway/auth.ts:265-408`：`JwtAuthenticator`——IdP 验签 principal（`issuer|sub`、groups、exp）；`:404-421` `scopeFromGroups`——组映射到 `{repo,team}`，服务端推导，推导失败拒绝创建（`src/gateway/server.ts:512-519` production 无回落）。
- `src/gateway/server.ts:439-444,1058-1120`：`#revoked` 集合 + `revocations.json`（0600，已初始化实例缺文件 fail-closed 拒启动），连接与每条命令都查。
- `src/gateway/session.ts:125-165,205-215`：会话级 `getApprovalContext`（sessionIdentity/tenantIdentity/repoIdentity/gitRevision/policyHash/aclVersion）、`isAuthorized` 每命令复查；`:264-289` stop/cleanup 链——吊销钩子的落点。
- `src/runtime/approvals.ts:20-57`：四眼审批已绑定 callId/argsHash/requester+approver principal/repo/revision/policyHash/aclVersion/expiry。
- `src/audit/log.ts:8-21,31-105`：审计 kind 白名单含 `repo.clone`/`git.push`；字段含 repo/team/verdict；哈希链+白名单写入（调用方塞不进 hash/seq）。
- `src/gateway/server.ts:525` 附近：每会话 wiring 覆盖已有先例（`authorEmail: actor`），grant 注入可走同一覆盖点。
- 测试资产：`tests/gitproxy.test.ts`（HTTP 层 16 例：凭据注入/401 挑战/push 留痕/allowlist/重复 service/方法白名单/大小写变体/被拒不上游）；`tests/git-e2e.test.ts`（真实 git 二进制 + `tests/fixtures/git-http-server.mjs` 真实 smart HTTP 上游：clone/push 正例、只读拒绝且上游 HEAD 不变、allowlist 拒绝、全树无凭据）；`tests/wiring.test.ts`（token 相异与必填校验）；`tests/session-guard.test.ts`。注意 fixture 上游用 `spawn(service, ["--stateless-rpc", dir])` 且**不传 `GIT_PROTOCOL` 环境变量**——它本质是 v0 上游，v2 广告支持需要实现批显式加（§3.B3）。

## 2. 合同 §A：信任与凭证模型

### A1 grant 对象与格式
- Claims（全部由网关签发，客户端只能原样携带）：`{ v:1, tenant, principal, session, repo, caps:{ read:boolean, write:boolean, writeRefs:string[] }, exp, jti }`。
  - `repo` = 代理 allowlist 名（`<host>/<repo>.git` 完整形式，见 `sandbox-config.ts:22-30` 的塌缩教训）。
  - `writeRefs` = ref glob 列表（如 `refs/heads/feature/*`）；`caps.read=true` 恒为 repo 级全 refs 读（§3.B5）。
  - `exp` ≤ 15 分钟；`jti` 服务端唯一（`randomUUID` 即可）。
- 编码：`base64url(payloadJSON) + "." + base64url(HMAC-SHA256(masterKey, payloadB64))`。只依赖 `node:crypto`（与 auth.ts 同口径，不引 JWT 库）；不用 JWT 头/alg 协商（alg 只有一个，避免 auth.ts 里那套 allowlist 攻击面）。
- 密钥：`gitGrantMasterKey`（≥32B），网关与代理各持一份（部署 Secret；demo 由 `scripts/demo.ts` 生成一次传两边）。**构造期相异校验扩展**：masterKey、internalToken（A6）必须与既有三 token（网关/模型/gitProxy）互异，沿用 `server.ts:255-263` 的抛错风格。
- 签发点：网关会话创建（`#acceptConnection` 内 resolveScope 成功后、`new Session` wiring 覆盖点），每会话一枚（read+write 按 `RepoMapping.allowPush===true` 决定 write cap；`allowPush!==true` 时 write 恒 false——签发端就锁死，代理再验一次）。writeRefs 来源=部署配置（如 `RepoMapping.writeRefs`），无配置时 write cap 不得签发。
- 沙箱侧投递：**通道不变**——仍走 `writeSandboxConfig` 的 `.gitconfig` insteadOf URL（`x-session:<grant串>`）；grant 串只落在 workspace 外 HOME（既有全树无凭据断言继续生效）。

### A2 同一 scope 如何在请求路径上形成（授权五元组的唯一来源）
```
请求 → parsePath 得 repo 名（§3.B1 归一化）
     → Basic 解码取 grant 串（沿用 git 只发 Basic 的事实；Bearer 兼容读保留给测试直连）
     → HMAC 验签 + exp ≥ now + jti 未吊销 + session 在活会话登记表（A6）
     → grant.repo === parsePath.repo（字符串全等，不做前后缀/大小写宽松）
     → 端点+方法+service+content-type 推导操作（§3.B2）∈ caps
     → 若 receive-pack：命令区 refname 全部匹配 writeRefs（§3.B6）
     → 全过才注入上游凭据发起 fetch
```
每一 axis 的值都来自：服务端签发的 claims、服务端配置的 RepoMapping、或服务端活会话登记表。**客户端请求头不进入任何授权判定。**

### A3 客户端头（x-perimeter-session/actor/team）地位
- 授权：不读。审计：不读——`#audit` 的 `sessionId/actor/repo/team` 一律取自已验证 grant claims（这同时修复 `server.ts:196-197` 现状）。负控见 §5-N12：伪造头不得出现在审计与任何判定路径。

### A4 bearer 能力凭证的诚实边界（措辞合同）
- 沙箱里的 grant 串是**能力凭证**：任何读到它的人，在 `exp`/吊销之前、在网络可达范围内，都能以其原 scope 使用它。本机制没有独立调用者证明（无 mTLS 客户端证书绑定、无 proof-of-possession），**不存在"无 token/无盗用风险"这回事**。
- 本合同承诺的边界=四条：①scope 最小化（单 repo、rw 位、writeRefs、≤15min）；②jti+活会话登记使**跨 session/跨 repo/吊销后**的使用被拒（§5-N1/N2/N6/N13）；③上游组织凭据永不离开代理（既有铁律 2 测试继续生效）；④吊销在 ≤5s 有界窗口内全面失效（A6/C2）。
- 实现批在本片全部代码注释/README/报告里禁止出现"沙箱完全没有 token""token 不可盗用"类措辞；handoff §5.2 原文（"沙箱中的 gitProxyToken 仍是能力凭证"）是口径基准。

### A5 mTLS/服务身份：按现有代码证据判定，本地机制不设 TLS 前置
- 现证据：代理 `createServer` 纯 HTTP（`src/gitproxy/server.ts:53`）；沙箱→代理的网络边界=`config/policy.yaml:29` egress deny_all_except + `deploy/networkpolicy.yaml:18-22` 只放通 git-proxy；handoff §5.2"服务间身份用 mTLS 或等效客户方案"列在"传输与入口"（部署面）。
- 判定：**本地 B2 机制不得要求客户 TLS/mesh 基础设施**；代理与沙箱间、代理与网关内部端点间的传输保护=集群网络策略（既有），grant 本身自带完整性+时效（HMAC+exp），不依赖信道机密性成立。mTLS/服务网格/生产密钥轮换=客户外部件，记入 §6，不阻塞、不假装。
- 同理禁 mock callback 假生产 wiring：demo 用 `scripts/demo.ts` 真实双进程接线（代理轮询真实网关端点），不用内存 stub 替代轮询路径。

### A6 签发者可信 admin API 与活会话登记（生命周期接线）
- 网关新增**仅内网**端点 `GET /internal/git/registry`：`Authorization: Bearer <internalToken>`（internalToken 见 A1 校验）；production 下拒绝 query 传 token（对齐 `server.ts:1013-1016` 既有口径）；非内网 bind 拒绝（对齐 `#hostOk` 精确 Host 风格）。
- 返回快照：`{ epoch, activeSessions: { <sessionId>: { principal, tenant, repo, aclVersion } }, revokedJtis: [...] }`。持久化复用 `#saveSessions`/`revocations.json` 的 0600 tmp+rename 模式（重启恢复）。
- 代理侧：`GitProxyConfig` 增 `registry: { url, internalToken, pollMs }`，轮询 `pollMs ≤ 5000`；轮询失败时**沿用上一快照至 maxStale（建议 30s），超期 fail-closed 全拒**（与 RemoteJwks 的 ttl/maxStale 同构）。
- 生命周期钩子（都在既有代码上挂）：`Session#dispose`（session.ts:264-289）/`Gateway close()`/`/auth/logout`/`revokePrincipal`/role 或 scope 变更（aclVersion bump）→ 从快照移除该 session、吊销其 jti。会话仍活但 aclVersion 变化 → 旧 grant 的 session 条目失配即拒。
- **失效窗口的诚实措辞**：一律写"≤pollMs（默认 5s）有界窗口，轮询失败最长 maxStale 30s"；禁止"立即/瞬时失效"。

### A7 legacy 共享 token：生产 fail-closed，显式 dev 才可兼容
- `GitProxyConfig` 增 `mode: "production" | "dev"`（或等价显式开关）。production 下：仅静态 token 配置=构造抛错（fail-closed）；`registry` 缺失=构造抛错。
- dev 模式可显式配 `legacySessionToken` 保留既有 fixtures 的跑法，但该字段在 production 构造期即抛错；既有 `gitproxy.test.ts`/`git-e2e.test.ts` 静态 token 用例由实现批迁移为"向测试内嵌的签发器要真 grant"（§7）。

## 3. 合同 §B：smart HTTP 协议授权子集（保守、与真实 git 兼容）

### B1 路径与 URL：无任意上游 URL
- 仅 `parsePath` 三端点（现状保留）。repo 段含 `%`（任何百分号编码）一律 403 拒绝——allowlist 名是部署者写的字面量，解码匹配是新增攻击面，不做；`//`、`..`、大小写变体靠"allowlist 字符串全等"自然拒绝。负控 §5-N8。
- 上游目标恒为 `new URL(RepoMapping.upstream + endpoint)`：客户端零 URL 输入（现状保留）；`service` 参数维持单值白名单透传（`:139-148` 注释里的重复参数分歧已闭合，用例保持绿）。
- `info/refs` 无 `service` 参数 → 400（dumb 协议不在子集内；否则真实上游会吐 dumb 广告把客户端引入 404 死巷——早失败早明确）。

### B2 操作推导：端点、方法、content-type 三方一致
- GET `info/refs`：`service` 必须恰为两个已知常量之一；`isPush = service==="git-receive-pack"`。
- POST pack 端点：路径端点与 `content-type` 必须互证（`application/x-git-upload-pack-request` ↔ `/git-upload-pack`；receive 同理），不一致 400 fail-closed。这是防"info/refs 协商成 A、POST 打成 B"的分歧面（现状 `isPush` 已含 endpoint 判定，本条补 content-type 互证）。
- 方法白名单、405 挑战（现状保留）。

### B3 协议版本 v0/v1/v2
- `git-protocol` 请求头：仅接受单值 `version=1` 或 `version=2` 原样透传；其余值（含重复头、`version=3`、畸形）一律**丢弃该头**（上游回落到对端支持的最低版本，代理授权与版本无关）。
- 读路径（upload-pack/ls-refs/fetch，含 v2 子命令）：**pass-through**。依据：caps.read 是 repo 级全 refs 读，v2 不引入代理层需判定的对象（§3.B5）。
- 写路径：receive-pack 载荷恒为 v0 pkt-line 命令（协议 v2 未定义 push 子命令）——**ref 写校验与协商版本无关**，v2 客户端的 push 走同一 B6 路径。因此本子集对 `protocol.version=2`（git ≥2.26 默认）的 clone/fetch/push 全兼容，无客户端降级配置要求。
- fixture 上游目前是 v0（`tests/fixtures/git-http-server.mjs:60-64` 未传 `GIT_PROTOCOL`）。若实现批要测 v2 广告透传：给 fixture spawn 加 `GIT_PROTOCOL` env 透传 + `/__seen` 记录请求头，属测试增量，允许。

### B4 content-encoding
- upload-pack POST（无解析需求）：`content-encoding` 原样透传（现状）。
- receive-pack POST（需解析命令区）：`identity`/无 → 直接解析；`gzip` → `node:zlib` 流式 inflate 后解析，向上游以 identity 转发（剥 `content-encoding`，分块流式，不整包缓冲）；其余值 → 415 fail-closed。响应方向透传不变。
- 验证锚点：真实 `git push` 在 §7 正例里跑绿（git 客户端对 receive-pack 的默认编码行为以该实测为准，注释里只写实测结论，不写凭记忆的协议考据）。

### B5 ref 级能力三态（本合同的保守边界，禁止越界许诺）
- ①repo 级读（全 refs）：交付（pass-through）。
- ②限 ref 读：**代理层不可安全交付，本片明确不实现**。证据：v0 `want <sha>` 行无 refname；v2 fetch 允许裸 SHA `want`，仅过滤 info/refs advertisement 挡不住已知 SHA 的直取。禁止交付"过滤 advertisement"式实现并宣称 ref 级读控制。配置面 fail-closed：若 grant/部署配置出现 `readRefs` 字段 → 签发器构造期抛错（不得静默当 repo 级读签发）。租户确需 ref 级读控制 → 上游只读权限/branch protection（§6 外部件），代理如实降级为 repo 级读或拒绝该 repo。
- ③限 ref 写：交付，见 B6。

### B6 receive-pack 命令区预验证（上游写之前，全部 fail-closed）
1. 收到 POST `/git-receive-pack` 后，**先缓冲命令区**：逐 pkt-line 读到 flush（`0000`）为止；缓冲上限 64KiB，超限 → 413 拒绝，上游零写入。pkt-line 长度字段畸形/首包即 flush（空命令区）/编码非法 → 403，上游零写入。
2. 逐条解析 `old-sha SP new-sha SP refname`（首条可携 `\0` capabilities；refname 校验：UTF-8、以 `refs/` 开头、不含空格/控制字符）。任一 refname 不匹配 `grant.writeRefs` glob → 403 + 审计 deny，**上游 fetch 不发起**。
3. create（old=40×0）/delete（new=40×0）同受 writeRefs 约束；force push（old≠上游现值）代理不可证——归上游 `denyNonFastForwards` + `git push*` 审批门（§4.C1），注释如实标注"代理不判 force"。
4. 校验全过后，**单次**上游 fetch：body = 已缓冲命令区 + 流式余包（`Readable.toWeb` 现机制接续）；命令区只缓冲一次，不重复读客户端流。
- 明确不做：不在代理重建 pack 全图、不做对象级校验、不解析 want/have 深度协议——那是无限工程（任务书原话），本子集以"命令区自描述"为唯一写面授权依据。

### B7 上游凭据与 redirect
- 上游凭据注入维持现状（`:151-155`，只在代理）。
- 上游 `fetch` 增 `redirect: "error"`（先例 `src/gateway/auth.ts:208`）：上游 3xx → 502 + 审计 deny；负控 §5-N15。跨 host 依赖只来自 RepoMapping 配置本身。
- 上游不可达 502（既有 `:80-84`）保持。

### B8 审计
- identity 四字段取自 grant claims（A3）；`git.push` allow/deny 全留痕（现状扩展 deny 分类：`ref 不在 grant 写域`/`grant 过期`/`session 未登记`/`命令区超限` 等 fixed-category summary，对齐 R11 起的 privacy 口径：无原始头/body 进审计）。
- `jti` 可入审计（非密）；token/grant 串/上游凭据绝不入审计（既有 redactUrl+全量断言保持）。

## 4. 合同 §C：push 双门、吊销即失效、legacy

- **C1 三层门（层层独立，缺一不可）**：①策略 `require_approval: "git push*"`（`config/policy.yaml:113-116`）四眼审批——证明"这次 git push 命令被批准过"；②代理 `RepoMapping.allowPush`（默认否）——部署面写开关；③grant `caps.write + writeRefs`——凭证面写域。**诚实边界**：代理无法核验某次 push 对应哪条 approval 记录（命令级审批发生在 git 进程之前，代理只见 HTTP 流）；两层之间无加密绑定，这是如实边界而非缺陷，注释按此措辞，禁止写成"审批已绑定到每次推送"。
- **C2 吊销即时性（有界）**：C1 之外，live 会话销毁（`Session#dispose`）、登出、`revokePrincipal`、aclVersion/scope 变更 → A6 快照更新；代理 ≤5s 窗口内全拒。registry 拉取持续失败时沿用旧快照至 maxStale（production 5s、dev 30s）后 fail-closed。测试断言用"窗口后必拒"（§5-N6），不用 sleep 比拼竞速。
- **C3 签发者 admin API 与真实接线**：A6 端点由网关真实实现；`scripts/demo.ts` 改为真实双进程：网关带 internal 端点起、代理带 `registry:{url,internalToken}` 起、`GIT_PROXY_TOKEN` 常量替换为会话签发流。禁止用内存回调假装轮询。
- **C4 团队审计取 trusted context、无 token**：审计 identity=grant claims（B8）；网关侧审批链已带 `approverPrincipal`（approvals.ts:47）；SIEM 导出沿用既有脱敏。任何审计路径不读客户端头、不含任何 token 形态字符串。
- **C5 legacy**：A7。production 构造期 fail-closed；dev 显式字段；测试迁移由本实现批完成，不靠生产路径养测试。

## 5. 合同 §D：最小负面矩阵（真实调用闭环；容器非必须）

每行实现为可跑测试；`upstream=0` 指 fixture `/__seen` 或记录型上游计数为 0（既有断言风格）；正例沿用 `git-e2e.test.ts` 真实 git 二进制模式。全部初始 **pending**。

| # | 场景 | 真实调用 | 断言 |
|---|---|---|---|
| N1 | 跨 repo | A 会话 grant 请求 allowlist 内另一 repo 名 | 403；upstream=0；deny 留痕 |
| N2 | 跨/未登记 session | 合法签名但 session 不在活登记表（已销毁/他网关签发） | 403；upstream=0 |
| N3 | ref 越权写 | HTTP 层 receive-pack 命令区含 `refs/heads/outside` + 真实 `git push` 越权分支 | 均 403；upstream=0；真实 git 例加"上游 HEAD/pack 不变"证明（clone 对照 + `git log`） |
| N4 | 只读 grant 推送 | read-only grant 打 receive-pack | 403（端点/content-type 层即拒，先于 body 解析）；upstream=0 |
| N5 | 过期 | exp-1 的 grant（注入时钟或短 TTL 实测） | 403；upstream=0 |
| N6 | 吊销 | 正常使用中销毁会话/吊销 jti，等 ≤5s 窗口 | 403；upstream=0；审计含吊销 deny |
| N7 | 旧 jti（换发后旧 grant 复用） | 重签新 jti 并吊销旧 jti 后用旧 grant | 403；upstream=0 |
| N8 | 编码路径/双斜杠/大小写 | `%61pp.git`、`//app.git`、`APP.GIT`、含 `..` | 403/404；upstream=0 |
| N9 | service 重复/大小写/缺失 | 既有两用例 + 无 service | 既有绿 + 新增 400；upstream=0 |
| N10 | v2 裸 SHA want | 真实 git `protocol.version=2` clone/fetch | **正例通过**（repo 级读 grant 内合法）；同 grant 打 receive-pack → 403（读 grant 无写面） |
| N11 | claims 篡改 | payload 翻一位/换签名 | 403（HMAC 失败）；upstream=0 |
| N12 | 伪造头 | 带 `x-perimeter-session/actor/team` 假值 | 授权不采纳；审计 identity=grant 真值；summary 无假值 |
| N13 | 未登记 session 的合法 grant | registry 快照剔除后使用 | 403；upstream=0（与 N2 区分：N13 是"曾有效后被剔除"时序） |
| N14 | 命令区超限/畸形 | >64KiB 命令区、坏 pkt-line 长度、空命令区 | 413/403；upstream=0 |
| N15 | 上游 redirect | 上游返回 302 | `redirect:"error"` → 502+deny 审计；upstream seen 仅原 host |
| N16 | legacy token | production 构造（仅静态 token / 缺 registry / legacySessionToken 字段） | 构造抛错；dev 显式模式下可用（兼容现状测试迁移期） |
| P1 | 真实 git 正例 | clone/fetch/push（writeRefs 内）全绿 | 上游 HEAD/pack 真实变更；审计 `git.push` allow、identity=grant；全树无 grant 串/上游凭据 |

## 6. 明确外部件（不得当作本地 grant 机制通过）
- 上游 branch protection / denyNonFastForwards / 上游只读权限：GitLab/GitHub 服务端能力，代理层 ref 级读控制的唯一现实来源（B5②）。
- `gitGrantMasterKey`/`internalToken` 的生产轮换与托管（KMS/Secrets Manager）：客户设施；本地机制支持重启换 key、旧 grant 自然过期，轮换演练归 B12。
- 沙箱↔代理、代理↔网关的 mTLS/服务网格：部署面（handoff §5.2"传输与入口"），§A5 判定不阻塞本地实现。
- 真实 IdP、真实集群 CNI 出口负控、DPA/WORM/24h soak：既有 external_blocked 清单原样保留。
- 以上任何一项在本片报告里只能写"外部"，禁止写"已由 grant 覆盖"。

## 7. 实施面与验收清单（下一批 Pi 的最小增量；全部 pending）

改动面（与 B1/B3 零交集；`gateway/server.ts` 与后续 B4/B5 同文件串行，先派者先行）：
1. 新增 `src/gitproxy/grants.ts`：claims 类型、HMAC 签发/验证、writeRefs glob（可复用 `src/policy/glob.ts` 或等价实现，注意 ref 语义下 `*` 不跨 `/`）。
2. `src/gitproxy/server.ts`：`#authorized` → A2 管道；B1–B8 全部落点；`registry` 轮询器（ttl/maxStale fail-closed）；`mode`/legacy（A7）。
3. `src/gateway/server.ts` + `session.ts`：签发点（wiring 覆盖）、`/internal/git/registry`、生命周期钩子挂 `#dispose`/logout/revokePrincipal/aclVersion。
4. `src/gateway/sandbox-config.ts`：无结构变化（token 值换 grant 串）；`tests/wiring.test.ts` 扩 masterKey/internalToken 相异校验。
5. `scripts/demo.ts`：真实双进程接线（C3）。
6. 测试：新增 `tests/git-grants.test.ts`（签发/验证/过期/吊销/registry 轮询 fail-closed 单元面）；`gitproxy.test.ts` 迁移 grant + N1–N16；`git-e2e.test.ts` 迁移 grant + P1/N3 真实 git 例；fixture 上游按需加 `GIT_PROTOCOL` 透传与 seen 记录。

验收判据（勾稽用，实现批逐条置实，禁止预勾）：
- [ ] A1–A7 全条目有对应代码+测试（含 production 构造期三抛错、≤5s 窗口措辞入注释）
- [ ] B1–B8 全条目；`redirect:"error"` 有断言；content-type 互证有负例
- [ ] C1–C5；demo 双进程真实跑通一轮 clone+push
- [ ] §5 矩阵 17 行全绿且各 deny 行 upstream=0
- [ ] 既有 gitproxy/git-e2e/wiring 用例迁移后保持原断言语义（只换凭证来源，不删负控）
- [ ] 全片注释/README 无"无 token/不可盗用/立即失效/ref 级读已实现"类失实措辞
- [ ] B1/B3 面（path-guard/policy-engine/modelgw）diff 为零

完成后仍须 Grok 复审；本合同自身不构成 B2 的任何完成声明。
