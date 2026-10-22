# Grok 基线审查（S0–S7）

- 审查者：Grok（本 dispatch 唯一 reviewer）
- 日期：2026-10-13
- 工作目录：`/Users/sundy/projects/web-articles/perimeter-agent`
- 基线提交：`b354ffe`（`main`，与 `origin/main` 相同）
- 审查对象：相对 `b354ffe` 的未提交 S1，以及 `docs/handoff.md` S0–S7、`docs/s1-review.md`
- Paseo 只作设计参照，不作为本仓库已交付证据
- **verdict：`request_changes`**

386 项测试与 typecheck 通过，只说明现有套件没有失败。它不证明 handoff 已实现，也不证明认证取消、撤权断连或真实部署安全。

## 结论

服务端已有可测的 JWT 验签、生产模式拒绝 query token、Host/Origin 精确匹配、HttpOnly/Secure/SameSite=Strict cookie、repo+team 接入校验，以及 WS 入站与 Outbox 字节上限。这些是 S1 的局部进展，不是 S1 关闭，更不是 S2–S7。

本轮独立复现了四件可修缺陷：验签超时只释放入口计数、底层 Promise 继续运行，且 HTTP 与 WS 不共享这本账；资源映射撤回后下一条命令返回「资源权限已撤销」，但活会话连接保持 OPEN；`clockSkewSec` 为 `NaN` 或 `Infinity` 时过期 token 被接受；`maxStaleMs < ttlMs` 时 fresh 窗口仍返回旧 key。另外，`PERIMETER_TOKEN` 与 `--bearer` 同时存在时，CLI 仍把 token 放进 query。

S2 强隔离与四眼、S3 收据与独占锁、S4 持久预算、S5 分页与基准、S6 证据包与批准、S7 路由均未按 handoff 交付。真实 IdP、模型凭据、Docker daemon、kubectl context、CNI、WORM、KMS、DPA、客户批准和 24h soak 标为 `external_blocked`。`docs/s1-implementation-report.md` 把后续阶段写成了另一套定义，下一轮必须改回 handoff §7，不能沿用该报告。

## 命令与证据

| 命令 | 结果 |
|---|---|
| `npm test` | `tests 386` / `pass 386` / `fail 0` / `skipped 0` / `duration_ms 14100` / exit 0 |
| `npm run typecheck` | exit 0 |
| `git diff --check` | exit 0 |
| `docker info` | exit 1。客户端 29.4.0，context `orbstack`；`unix:///Users/sundy/.orbstack/run/docker.sock` 不存在 |
| `kubectl config current-context` | exit 1。`current-context is not set` |

独立脚本在 `/tmp` 运行，未改仓库源码。数字来自同一次进程输出。

验签取消（自定义永不 settle 的 `authenticate`，`authTimeoutMs: 80`，`maxConnections: 30`）：

- 并发 25 个 `POST /auth/session`：20 个 `504`、5 个 `503`，`started=20`，响应全部返回后 `stillInflight=20`
- 接着 8 个 WS upgrade：`started=28`，`stillInflight=28`，8 个连接均为 error

JWKS（`ttlMs=10000`，`maxStaleMs=1000`，age=5000，源在首次成功后返回 503）：

- `fetchHits=1`，`returnedKey=true`
- 对照：age 超过 ttl 后拒绝，`fetchHits=2`

过期 token（`exp` 已过去 1 小时）：

- `clockSkewSec=NaN` 与 `Infinity` 均返回 principal
- `clockSkewSec=30` 抛出 `token 已过期`

活会话撤权（mock-model 已发出 `session.ready` 后把 `resolveScope` 改为拒绝）：

- 命令错误文本是 `资源权限已撤销`
- `readyState=1`（OPEN），`closeCode=0`
- 审计里没有 `命令 prompt`，也没有 `prompt（`，说明这条命令没有执行
- 入队窗口没有被本轮隔离：另一次尝试里 `session.ready` 先于 prompt 到达，scope 当时仍为允许，模型看到了 prompt。不能把那次写成「撤权后仍调用模型」

CLI（本地 upgrade 桩）：

- `PERIMETER_TOKEN=dev-token node scripts/attach.ts --session s1 --bearer header.jwt` → `URL /?token=dev-token&session=s1`，同时 `Authorization: Bearer header.jwt`
- 未设置 `PERIMETER_TOKEN` 时 → `URL /?session=s1`，只有 Bearer

Cookie：`204`，`Set-Cookie` 含 `__Host-perimeter_session`、`HttpOnly`、`Secure`、`SameSite=Strict`、`Path=/`。

## 已核实的 S1 行为

下列结论有套件或本轮复现支撑，下一轮不要推倒重写：

- 生产模式拒绝共享 token、缺 auth/scope/hosts/origins 时拒绝启动；demo 拒绝绑定非回环地址
- 生产 WS 带 `?token=` 返回 401；错误 Host 421；错误 Origin 403
- `revokePrincipal` 会关闭现存连接（4001）并拒绝再次握手（401）；验签 await 期间吊销会 401
- cookie 路径在恶意 Origin 上拒绝换票和带 cookie 的 WS（403）
- 同 repo 不同 team 的新连接被 4003
- 已知 kid 在同时超过 ttl 与 maxStale、且源 503 时抛 `JWKS 不可用`（套件 R1；本轮对照同样拒绝）
- `limits` 的 NaN、负数拒绝启动；生产 origin 必须是精确 `https://`
- 静态符号链接逃出 `webRoot` 返回 404；`__proto__` share 被拒
- prompt 超过 64KiB、未知字段、`share role=owner` 被 `parseCommand` 拒绝
- 内置 `RemoteJwks` 有 5 秒 `AbortController`、256KiB 与 32 key 上限、`redirect: "error"` 和 single-flight。这只约束这条 JWKS 实现，不约束任意 `Authenticator`

## Findings（按修复优先级）

### F1 高 · 确定缺陷 · 验签工作没有取消，HTTP/WS 不共享并发账本

`Authenticator.authenticate` 没有 `AbortSignal`（`src/gateway/auth.ts:17-18`）。`withTimeout` 只让 `Promise.race` 先返回，并在超时回调里 `req.destroy()` 或 `socket.destroy()`（`src/gateway/server.ts:831-859`、`483-490`、`529-533`）。`#authPending` 在 `finally` 里立刻减 1（`514-516`），所以 504 之后额度已空，底层 Promise 仍是 inflight。

HTTP 上限是 `Math.min(20, maxConnections)`（`464-465`）。WS upgrade 用的是另一本 `#pending` 连接账（`525-526`），不读 `#authPending`，也不走 50 req/s 的 `#authRateLimiter`（只在 `#authRoute`，`463`）。

复现见上表：20 个 HTTP 超时返回后仍有 20 个 inflight；8 个 WS 把 `started` 加到 28。内置 JWKS 自己的 5 秒 abort 不能代表适配器。实现报告第 48 行写的「挂起的 Auth Promise 永久占满额度槽位已被杜绝」只对入口计数成立，对真实工作不成立。

修复：`authenticate` 接受 `AbortSignal`；超时必须 abort。共用一个 in-flight 计数，直到 promise settle（含 abort 后的 reject）才释放。HTTP 与 WS 都占用它。迟到 resolve 继续禁止写 cookie，这点现有测试要保留。

验证：永不 settle 的适配器在超时后 inflight 回到 0，或停在 abort 上而不接受新的第 `cap+1` 个调用；HTTP 与 WS 并发合计不超过 cap；现有「504 后无 Set-Cookie」测试仍绿。

### F2 高 · 确定缺陷 · 资源撤权后连接保持 OPEN

命令路径在鉴权失败时只 `sendError("资源权限已撤销")` 后 `return`（`src/gateway/server.ts:699-701`）。broadcast 路径会 `closed`、清空 outbox 并 `close(4003)`（`763-766`）。两条路径不一致。

活会话复现：mock-model 已 `session.ready`，随后 `resolveScope` 返回 `undefined`，再发 prompt。得到错误文本，`readyState` 仍为 1，close code 为 0。`participants()`（`801-804`）仍按 transports 计数，这次没有后续广播，presence 也不会自己更新。

下一次 broadcast 会在发送前关掉该连接，所以本轮没有观察到撤权后的新快照泄漏。缺口是「权限收缩要断开旧连接」没有在发现撤权的那一条命令上发生，连接槽会留到某个无关事件。

套件 `tests/enterprise-s1.test.ts` 的 R2 只断言错误字符串和 Bob 的 `readyState`。`bobCommandReceived` 赋值后没有断言。这个测试在本缺陷存在时仍然能绿。

修复：命令失败与 snapshot 回调走同一套关闭：标记 closed、清 outbox、从 transports 删除、`close(4003)`，并发布不含该主体的 presence。

验证：session.ready 之后翻转 scope，发送一条 prompt，期望 close code 4003；另一名仍授权的成员收到的 presence 不再包含被撤权连接。

### F3 高 · 代码确定 · 入队命令与在途审批没有二次鉴权

`session.ts:97` 在就绪时 `this.#queued.splice(0)` 后直接 `handle`，不再调用 `#isAuthorized`。`handle` / `#command`（`121-144`）会把 prompt 送进 `HarnessHost.submit`，或把 approve 送进 `approvals.decide`。`decide`（`src/runtime/approvals.ts:69-75`）不看主体是否已撤权，只把调用者写成 approver。`revokePrincipal`（`server.ts:584-594`）只关 socket 和删内存会话，不使 pending 审批失效。

本轮没有隔离出「先入队、再撤权、后 flush」的运行窗口：ready 赢得了与 prompt 的竞态，当时 scope 仍允许，模型收到了 prompt。因此这里不声称已经观察到撤权后的模型调用。代码路径本身缺少第二次校验，现有测试也没有覆盖它。

修复：flush 与 `#command` 执行前再次询问网关授权；失败则丢弃队列项。`revokePrincipal` 和资源撤权要把该主体的 pending 审批标成失效，不能再 allow。

验证：人为推迟 `session.ready`（测试里的慢 backend 或未 open 的 host）。授权时入队 prompt，撤权后再就绪，mock-model 日志不得出现该 prompt，审计不得出现 `prompt（`。另测：pending 审批在 `revokePrincipal` 之后 `decide(allow)` 不得执行。

### F4 高 · 确定缺陷 · 时间配置非法时 fail-open

`JwtAuthenticator` 使用 `clockSkewSec ?? 30`（`auth.ts:265`），构造函数不校验。`now - NaN >= exp` 与 `now - Infinity >= exp` 都是 false，过期分支不抛。本轮同一个过期 token 在 `NaN` 和 `Infinity` 下被接受，在 `30` 下被拒绝。

`RemoteJwks` 默认 `ttlMs=600_000`、`maxStaleMs=3_600_000`（`auth.ts:91`），也不校验有限正数，也不要求 `maxStaleMs >= ttlMs`。fresh 判断只看 ttl（`96-99`）。本轮 `ttl=10s`、`maxStale=1s`、age=5s、源已 503：不刷新，仍返回旧 key。

默认数值本身是安全的。缺陷是非法配置会放宽过期与密钥寿命，而 `limits` 已经要求启动失败（`transport.ts:29-34`）。实现报告第 14 行把默认 skew 写成 60s，与代码 30s 不符。

修复：构造时拒绝非有限值、负数 skew、`maxStale < ttl`、非正 ttl。过期判断对非法 skew 必须 fail-closed。更正报告中的 30s。

验证：把本轮三组输入做成单测，期望全部拒绝或拒绝启动。

### F5 中 · 确定缺陷 · `--bearer` 仍可能把 token 放进 query

`scripts/attach.ts:14-19`：`queryToken = rawToken ?? ...`，而 `rawToken` 来自 `--token` 或 `PERIMETER_TOKEN`。只要环境里有 demo token，`--bearer` 仍执行 `searchParams.set("token", queryToken)`。生产网关对 query 中的 `token`/`actor` 直接拒绝（`server.ts:568`），所以这是失败关闭，不是绕过验签。请求行仍带上环境里的 token，代理访问日志会记到它。

复现：`URL /?token=dev-token&session=s1` 与 `Authorization: Bearer header.jwt` 同时出现。没有该环境变量时 URL 只有 `session`。

修复：存在 `--bearer` 时不要写 `token` 或 `actor` query。Bearer 与 query token 同时出现应在客户端直接退出并说明原因。

验证：upgrade 桩断言两种环境变量组合下的 URL 与 Authorization。

### F6 中 · 确定缺口 · 生产网页没有接上 cookie，4001 会每秒重连

`web/app.js:49-55` 把 `location.search` 原样放进 WebSocket query，没有 `POST /auth/session`。`onclose` 只在 code 为 4003 时停止；`revokePrincipal` 使用 4001（`server.ts:592`），网页会每秒重连。handoff 把网页列在 S1 改动面。README 上文写浏览器换 cookie，第 58 行仍写「不做 OIDC/SAML」，两处冲突。

PKCE 重定向没有实现。handoff 允许在客户 issuer 缺失时先交测试接口，不允许把现有 JWT 接口写成公司 SSO。测试接口已经有了，页面没有用它。

修复：最小页面路径是提交 bearer、换 `__Host-` cookie、随后 WS 不带 token/actor。4001 与 4003 停止重连；其余断线用指数退避加 jitter。Authorization Code + PKCE 留在真实 IdP 参数到达之后，本项不要伪造通过。

验证：静态检查页面不再拼接 `token`/`actor`；用测试 JWT 换 cookie 后 WS 能接到 attached；吊销后页面停止重连。

### F7 中 · 文档缺陷 · 阶段定义与 handoff 不一致

`docs/s1-implementation-report.md:84-88` 把 S2 写成多团队模型与四眼，把 S3 写成 SIEM，把 S4–S7 写成多集群与水平扩展。handoff §7 的定义是：

| 阶段 | handoff 交付 |
|---|---|
| S2 | 强隔离和审批：执行后端、保护路径、四眼、repo-scoped token、DLP、真实出口负面测试 |
| S3 | 恢复与生命周期：receipt、存储锁、PVC/备份、健康检查与关闭 |
| S4 | 模型链路和预算：取消、超时、drain、持久预留与对账 |
| S5 | token 与交互：压缩、tail 分页、流合并、基准 |
| S6 | 企业交付演练：P0 清单、soak、客户安全批准 |
| S7 | 规模与生态：必须先有 S6 和单节点测量；禁止多个网关共挂一个 SQLite |

下一轮先改报告和 README，再写代码。不要按该报告的阶段表开工。`docs/handoff.md` 本轮不得改写。

### 设计风险（本轮不单独立项为可观察漏洞）

- 浏览器会话和 WS principal 在登录时拷贝 groups（`auth.ts:315`，`server.ts:580`）。IdP 在 exp 之前把人移出组，现有 cookie 和连接看不到，除非改 scope 映射或调用 `revokePrincipal`。吊销表和 cookie 都在单进程内存，重启即失。Bearer 的 `exp` 没有服务端上限，cookie 才被 8 小时封顶。
- `scopeFromGroups` 按组名排序取第一个命中（`auth.ts:294`）。同一个人命中多条映射时，范围由字母序决定，没有显式优先级。
- 静态文件用 `realpathSync` 前缀检查（`server.ts:605-607`），符号链接逃逸有测试。hardlink 与检查后替换链接的 TOCTOU 仍在；攻击者需要能写 webRoot。
- `RateLimiter` 是固定窗口（`transport.ts:105-109`），窗口边界可打到约两倍限额。
- Docker 启动参数有 read-only、非 root、drop ALL、no-new-privileges、memory/cpu/pids（`execution-backend.ts:337-401`），没有 seccomp。`deploy/sandbox.yaml` 有 seccomp 与 `automountServiceAccountToken: false`。默认网络仍是 bridge。这些属于 S2，且没有本机 daemon 可跑。

## 明确未实现或外部阻塞

不得标成通过：

- 真实企业 IdP、TLS 反向代理、生产模型凭据与区域/DPA
- Docker daemon 与 kubectl context（本机命令已失败）
- 真实集群 CNI、默认拒绝、metadata/IPv6/DNS 隧道
- WORM/外部审计锚点、KMS、备份加密、客户具名批准
- 24h soak、§4.4 成本与完成率数字
- Authorization Code + PKCE、持久吊销、四眼、创建收据、stateRoot 独占锁、持久预算账本、历史分页

`src/modelgw/server.ts:330-333` 的 `readBody` 仍无字节上限，fetch 无 deadline。这是 S4，不是本轮要改的 S1，但覆盖表里标为 missing。

## 给 agy 的下一最小任务包

只做剩余 S1。不要开始 S2，不要改 `docs/handoff.md`，不要 commit 或 push，不要用测试全绿代替下面的负面用例。阶段名称以 handoff §7 为准，以本文 Findings 的文件和行号为修复点。

1. **F1**：可取消的 `authenticate`，HTTP 与 WS 共用 in-flight 上限，超时 abort。保留「504 不发 cookie」。
2. **F2**：资源撤权关闭连接并更新 presence。补一条活会话测试；现有 R2 文本断言不够。
3. **F3**：队列 flush 与审批执行前再次鉴权；`revokePrincipal` 使在途审批失效。测试必须推迟 ready，证明撤权后的 prompt 不会进入模型。
4. **F4**：JWKS 与 clock skew 非法配置启动失败或验签 fail-closed。报告里的默认 skew 改为 30s。
5. **F5**：`--bearer` 时 CLI 不写 query token/actor。
6. **F6**：网页用测试 bearer 换 cookie，WS 不携带 token/actor；4001 与 4003 停止重连；其他断线指数退避加 jitter。不要实现一套假的公司 SSO 重定向。
7. **F7**：改正 `docs/s1-implementation-report.md` 的 S2–S7 定义和 README 第 58 行与上文的冲突。未做的 PKCE、持久吊销、真实部署继续写未实现。

做完后运行 `npm test` 与 `npm run typecheck`。新测试要能在缺陷还在时变红。

### 之后的顺序（本任务不要做）

- **S2 强隔离和审批**：生产禁用 local backend；Docker 参数与 `sandbox.yaml` 的 seccomp 对齐；请求者不能自批；保护路径要有执行边界而不能只断言策略函数；git 代理按 repo/ref 发放短期凭证；DLP 在出站前可阻断。容器、CNI、metadata、IPv6 负面测试在 daemon 和集群可用前保持 `external_blocked`。
- **S3 恢复与生命周期**：创建 receipt（同身份同键同内容复用，异内容拒绝）、stateRoot 独占锁、readiness 与 SIGTERM drain、磁盘满和两实例测试。PVC、备份恢复演练 external。
- **S4 模型链路和预算**：`readBody` 上限、upstream deadline、`res.write` drain、原子 reserve/settle、无 usage 记 `usage_unknown` 而不是 0。真实获批通道 external。
- **S5 token 与交互**：有界 tail 与分页、压缩计入费用、冷/热/恢复基准。没有真实模型就只能交测量骨架并写明未达到 §4.4，不能报成本下降。
- **S6 企业交付**：runbook 和证据包目录可以本地起草。soak、客户批准、WORM、KMS、DPA、SBOM、漏洞扫描没有证据就保持 external，禁止勾选 P0。
- **S7 规模与生态**：S6 完成且有单节点瓶颈测量之前不要做会话路由。多个网关禁止共用一个 SQLite。MCP、多 SCM、自动化 DAG 都是新的执行面，单独威胁建模后再做。

## 审查边界

本轮没有修改 `src/`、`tests/`、`config/`、`deploy/`、`web/`、`scripts/`、`README.md`、`docs/handoff.md`。没有 commit、push，没有启动编码 worker。Paseo 未被当作本仓库实现证据。覆盖矩阵在 `docs/reviews/handoff-coverage.json`。
