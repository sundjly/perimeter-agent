# 企业化规格 S0/S1 实施与审查修复报告 (S1 Implementation Report)

## 1. 目标与背景
本项目依据 `docs/handoff.md` 企业化规格 §0/§3/§5 及 S0/S1 阶段要求，完成从单租户 demo 身份与网络向企业级安全网关的演进。
在保持 4 条铁律（代码不离 Data Plane、凭据不进沙箱、egress 默认拒绝、工具调用留痕）的前提下，构建了零外部运行时依赖的可信凭证鉴权、显式 demo/production 隔离、Host/Origin 精确过滤、入站 Schema 校验、连接级背压隔离与连接实时吊销体系。
本报告包含对第一批 review 意见（R1-R6）的逐项修复与精确事实校准。

---

## 2. 架构设计与关键决策（审查修复与精准口径）

### 2.1 可信身份验证与 JWKS 资源边界 (`src/gateway/auth.ts`)
- **零外部新增依赖**：完全基于 Node.js 内置 `node:crypto` 模块实现 JWT 验签与 JWKS 密钥解析（支持 RS256/RS384/RS512 与 ES256/ES384 算法）。
- **标准时间与声明校验**：严格验证 `iss`、`aud`、`exp`、`nbf`，支持配置 `clockSkewSec`（默认 30s）。
- **严格过期 Fail-Closed 与初次拉取 (R1 修复)**：
  - 采用布尔标志位 `#fetched` 与 `#attempted` 解耦时间戳为 0 的边界；当 `now = 0` 时初次尝试拉取不受 `minRefreshMs` 阻塞，正常执行。
  - 无论 IdP 持续 503 还是网络中断，超过 `maxStaleMs` 后**严格 fail-closed**，绝对不返回过期缓存中的已知 key，立即抛出 `AuthError("JWKS 不可用...")`。
  - 无论缓存是否 fresh，刷新失败与未命中均受 `minRefreshMs` 限频保护，且高并发下保持 single-flight 单飞。
  - 流式读取响应体：累计字节超过 256KiB 时立即调用 `AbortController.abort()` 取消连接并拒绝；严格限制 JWKS key 集合容量 `<= 32`。
- **无歧义 Principal ID**：
  - 采用 `${encodeURIComponent(issuer)}|${encodeURIComponent(sub)}` 编码，杜绝伪造与边界歧义。
  - 统一长度约束 `principal.id.length <= 256`，与协议层 `ID_MAX = 256` 保持一致。

### 2.2 服务端持续资源权限校验 (R2 修复)
- **概念区分（scope 组映射 vs 会话协作角色）**：
  - `resolveScope`：服务端根据 JWT 中的组声明（或自定义逻辑）推导该主体允许访问的资源作用域（`repo/team`）。它决定**资源边界**，不代表会话内的操作角色。
  - 会话协作角色：由每个会话元数据（`meta.json`）中的成员字典（`members`）决定，分为 `owner`、`editor`、`viewer`。
- **全生命周期持续校验（同时校验 repo 与 team）**：
  - 会话创建：仅当主体在服务端映射的 `repo/team` 满足条件时允许创建。
  - 现有会话接入（attach）：无论内存或磁盘会话，必须持续校验主体当前具有该会话所属的完整资源权限（`scope.repo === meta.repo && scope.team === meta.team`）；同 repo 不同 team 或跨组主体立即以关闭码 4003 拒绝接入。
  - 入站每条命令：执行前必须调用 `#isAuthorized` 重新校验；若主体在服务端已被移出该资源权限，命令直接被拒并返回错误 `资源权限已撤销`。
  - 快照与广播出站：在向连接发送快照或广播事件时，若检测到该连接的主体已失去资源权限，立即切断连接（4003）并不向其发送任何出站数据。
  - 授权分享不受损：同会话内具有合法 `repo` 与 `team` 权限的其他受邀成员（如 editor）的操作和收发完全不受影响。

### 2.3 实时吊销与在途阻断 (R3 修复)
- **同步标记失效与关闭握手阻断**：
  - `revokePrincipal(principalId)` 与 `/auth/logout` 不仅仅调用 `ws.close()`，同时在连接对象上同步打上 `closed = true` / `revoked = true` 标记，并立即清空 `outbox` 待发队列。
  - 在 `ws.on("message")` 开头、出站 `broadcast` 以及异步 `snapshotFrame` 回调中均检查失效标记；在 TCP 关闭握手期间已经到达缓冲区的任何残留命令直接被丢弃忽略，不执行、不审计；在途快照坚决不向已吊销连接投递。
- **异步验签在途吊销防护**：
  - 在 WebSocket Upgrade 握手的异步 `authenticate` 完成返回后，重新校验 `revoked` 列表与凭证过期时间，杜绝在验签网络等待窗口期内被吊销的凭据逃逸接入。

### 2.4 HTTP `/auth/session` 端点安全与 Limits 参数校验 (R4 修复)
- **Limits 参数强断言**：
  - 网关构造函数对 `limits` 的所有字段进行校验（`validateLimits`）：每个值必须是有限正整数；若配置出现 `NaN`、`Infinity`、负数、0 或浮点数，立即抛错拒绝启动。
- **端点并发、速率与挂死 Promise 隔离 (`withTimeout`)**：
  - `/auth/session` 与 `/auth/logout` 共享有限的并发验签上限（`#authPending < 20`），超出直接返回 503；
  - 采用 `RateLimiter`（50 req/s）防止爆破打上游 IdP；
  - 采用 `withTimeout` 封装验签过程（支持配置 `authTimeoutMs`，默认 5000ms）：超时立即返回 504 并断开请求，`#authPending` 计数在 `finally` 中**立即释放**，杜绝挂起的 Auth Promise 永久占满额度槽位；超时后底层迟到 resolve 的 Promise 绝不会触发会话创建或颁发 Cookie（零副作用）。WS 握手同样受限时保护。
- **拒绝非空 Body**：
  - `/auth/session` 仅通过标头传递 Bearer 凭证，不接受 body。若收到 `content-length !== "0"`、`transfer-encoding: chunked` 或任何输入数据流，立即销毁请求并返回 400 Bad Request。
- **生产 Origin 约束**：
  - 生产模式下，`allowedOrigins` 必须全部为精确的 `https://` 源；任何非 `https://` 的 Origin 在构造与请求时均直接拒绝（403）。

### 2.5 Outbox 统一限额、元数据安全与符号链接逃逸防御 (R5 修复)
- **`closeWith` 统一走 Outbox**：
  - 握手后的错误控制帧发送统一经过 `Outbox`，严格遵守单帧上限与套接字物理缓冲水位，慢端超限直接 terminate。
- **元数据 members 特殊 key 原型防注入**：
  - 在 `share` / `unshare` 命令中，禁止使用 `__proto__`、`constructor`、`prototype` 等特殊 key，防止原型链污染。
- **静态资源符号链接逃逸防御**：
  - `#serveStatic` 采用 `realpathSync` 解析文件的真实物理路径，严格校验是否位于 `realpathSync(webRoot)` 目录之下，彻底防御软链接指向外部文件的目录逃逸攻击。

---

## 3. 精确事实说明与未实现项 (R6 校准)

1. **CSRF 防护范围说明**：
   - 本项目通过以下措施防御 CSRF 与跨站 WebSocket 劫持（CSWSH）：
     1. WebSocket Upgrade 阶段及 `/auth/*` 接口执行精确的同源 Origin 白名单校验；
     2. 换取会话 Cookie 仅限 `POST /auth/session` 且要求必须携带 `Authorization: Bearer <token>` 报头（跨站 HTML 表单或简单跨站请求无法附加该标头）；
     3. 颁发的会话 Cookie 带有 `HttpOnly; Secure; SameSite=Strict; Path=/` 属性。
   - **明确未实现**：本项目**未实现** double-cookie 校验，也**未实现**自定义 Header CSRF token 机制。
2. **HTTP Origin 校验范围说明**：
   - 精确 Origin 白名单校验仅施加于：
     - WebSocket Upgrade 握手；
     - `/auth/session` 与 `/auth/logout` POST 端点。
   - 公开静态文件服务（`GET /index.html` 等）仅检查 Host 白名单与真实路径边界，**未对静态 GET 请求校验 Origin**。不能概括为“所有 HTTP 请求都经过 Origin 校验”。
3. **浏览器登录交互说明**：
   - 本项目**未实现**浏览器完整的 OIDC Authorization Code 授权码重定向 + PKCE 交互流。
   - 生产环境中假定 Bearer Token 已由企业前置登录页、反向代理或身份提供商完成交换后，由前端以 Bearer 标头提交给网关换取 Cookie。
4. **单机内存状态与重启丢失风险**：
   - 凭据吊销列表（`revokedPrincipals`）与浏览器会话映射（`BrowserSessions`）目前保存在网关进程的**单机内存中**。
   - **已知保留风险**：网关重启后已吊销名单和活跃 Cookie 会话将丢失，需要运维重新下发或由用户重新通过 Bearer 换取会话。分布式持久化与跨实例同步留待后续阶段实现。
5. **规格演进对齐 (`docs/handoff.md` §7)**：
   - 本阶段完成且仅完成了 S0（基线收敛，局限于 local/mock）与 S1（入口与可信身份，未覆盖真实企业 IdP 与 PKCE）。
   - **后续阶段交付与改动面严格以 handoff §7 为准**：
     - S2：强隔离和审批（执行后端、保护路径、四眼、repo-scoped token、DLP、真实出口负面测试）；
     - S3：恢复与生命周期（receipt、存储锁、PVC/备份、健康检查与关闭）；
     - S4：模型链路和预算（取消、超时、drain、持久预留与对账）；
     - S5：token 与交互（压缩、tail 分页、流合并、基准）；
     - S6：企业交付演练（P0 清单、soak、客户安全批准）；
     - S7：规模与生态（会话路由/fencing、调度、多 SCM/monorepo、provider/MCP/自动化）。

---

## 4. 文件改动清单

| 操作 | 路径 | 核心内容 |
|---|---|---|
| 修改 | `src/gateway/auth.ts` | 引入 `#fetched` 与 `#attempted` 标志，修复 `now=0` 及过期已知 kid fail-closed 逻辑 |
| 修改 | `src/gateway/transport.ts` | 导出 `validateLimits`，严格校验有限正整数 |
| 修改 | `src/gateway/server.ts` | 生产模式持续资源权限校验（`#isAuthorized`）、在途验签吊销与同步标记失效、`/auth/session` 速率/并发/非空 body 限制、生产 Origin 强制 https、`closeWith` 走 Outbox、静态服务 `realpathSync` 防逃逸、members 特殊 key 防注入 |
| 修改 | `tests/enterprise-s1.test.ts` | 补充 R1-R5 的 5 个专项负面/边界测试（包含 fail-closed、权限撤销、在途吊销、非法 limits、符号链接逃逸） |
| 修改 | `README.md` | 校准 CSRF 与登录范围说明 |
| 更新 | `docs/s1-implementation-report.md` | 本实施与审查修复报告 |

*注：`docs/handoff.md` 原有未提交修改完好保留，未作任何改动。*

---

## 5. 验证命令与结果

在本地执行了全量验证：

```bash
npm test
npm run typecheck
git diff --check
```

- **测试结果**：**386 pass, 0 fail**（基线 368 + 第一批 11 + 专项修复 7 个测试，共 18 个新增测试全部通过）。
- **类型检查**：`tsc --noEmit` **0 错误**（严格遵守 Node 22 TypeScript 语法与类型约束）。
- **代码冲突与空白检查**：`git diff --check` **清洁通过**。
- **运行时依赖守卫**：未修改 `package.json`，未引入任何外部第三方包。
- **测试证据口径**：当前测试由本地标准的测试 IdP 服务器与 RFC 7517/7519 规范的 JWKS 端点进行密码学与故障注入驱动，尚未连接真实企业云端 IdP 或真实 K8s 集群。
