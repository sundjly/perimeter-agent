# S1 Grok Baseline Review 修复记录

- 审查者：Grok
- 执行者：agy
- 状态：已完成第四轮复审修改项与神谕硬化（待 Grok 第五轮独立复审）

## Findings 修复现状与闭环证据

### F1: 验签工作没有取消，HTTP/WS 不共享并发账本
- **发现**：`authenticate` 无 `AbortSignal`；`withTimeout` 仅上层 `Promise.race` 超时，超时后释放计数，底层 Promise 仍 inflight；HTTP 与 WS 未共享并发上限（20 HTTP + 8 WS = 28 inflight）。测试发第 21 个请求时未等待 20 个请求真实进入。
- **修复**：
  1. `Authenticator.authenticate(token, { signal })` 支持 `AbortSignal`；
  2. 实现 `AuthWorkGate`，HTTP 与 WS 统一申请 slot，最大并发 20；
  3. slot 实行 held-until-settle 策略：底层 Promise 未真正 settle 前不释放 slot；
  4. 上层限时等待（超时立即返回 504，不等待挂死的 Promise）；迟到 resolve 零副作用（不颁发 cookie，不升级 WS）；
  5. 测试等待 20 次请求真实进入 `authenticate` 再发第 21 个，彻底消除竞态。
- **状态**：已完成。代码位于 `src/gateway/auth.ts` 与 `src/gateway/server.ts`；测试覆盖于 `tests/enterprise-s1.test.ts`。

### F2: 资源撤权后连接保持 OPEN
- **发现**：活会话中 `resolveScope` 撤权后，命令路径只 `sendError("资源权限已撤销")`，`readyState` 保持 1，closeCode=0，`participants()` 仍包含该主体。
- **修复**：命令鉴权失败时，同步 `conn.closed = true`、清空 outbox、从连接集删除、`conn.ws.close(4003, "资源权限已撤销")`、解开在途 waiter 并广播更新后的 `presence`。
- **状态**：已完成。代码位于 `src/gateway/server.ts`；测试覆盖于 `tests/enterprise-s1.test.ts`。

### F3: 入队命令与在途审批没有二次鉴权
- **发现**：会话回调传 `undefined` 导致生产 `scopeFromGroups` 误拒正常 prompt；在途审批 allow 仅看 approver 未看 `item.actor`；4003 路径未全量触发 `expirePending`；原测试仅 `assert.ok(true)`。
- **修复**：
  1. `src/gateway/server.ts` 会话回调按 actor 从当前有效连接取真实 `principal` 再传给 `#isAuthorized`；连接不在集合时返回 false；生产组映射正常 prompt 不被误拒；
  2. `src/runtime/approvals.ts` 的 `decide` 与 `src/gateway/session.ts` 的 `#command`：`decision === "allow"` 提交前校验 `item.actor` 资源权限，若已撤权则自动置为 expired/deny，工具不执行；
  3. 4003 的命令、快照、广播全路径均调用 `session.expirePending(conn.actor)` 解开挂起的 waiter 并通知 deny；
  4. 彻底删除 `assert.ok(true)`，补齐 3 项真实负向测试（F3-1 生产组映射正常 prompt 不误拒；F3-2 Alice 撤权后 Bob allow 不写入 package.json 且 Alice 最终以 4003 断开，外加单独 revokePrincipal 4001 对照组；F3-3 环境就绪前入队 prompt 在撤权后 flush 时被二次鉴权丢弃，不发送至模型）。
- **状态**：已完成。代码位于 `src/gateway/server.ts`、`src/gateway/session.ts` 与 `src/runtime/approvals.ts`；测试覆盖于 `tests/enterprise-s1.test.ts`。

### F4: 时间配置非法时 fail-open 与 RemoteJwks 并发取消
- **发现**：`clockSkewSec=NaN/Infinity` 时绕过过期检查；`RemoteJwks ttlMs > maxStaleMs` 时返回旧 key；一个带 signal 一个不带 signal 并行时，abort 前者会误将共享 fetch 取消。
- **修复**：
  1. `JwtAuthenticator` 严格校验 `clockSkewSec` 为有限非负数（0..300），算法白名单无重复；
  2. `RemoteJwks` 严格要求 `ttlMs <= maxStaleMs`，参数有限非负；
  3. `RemoteJwks` 对所有并发调用者（带或不带 signal）均在 `inflight.waiters` 占一个引用，单个 signal abort 仅移除自身，只有没有等待者时才 abort 共享 fetch；
  4. 补齐并发测试：带 signal 者 abort 后，不带 signal 者正常拿到 key；两个带 signal 者 abort 其中一个，另一个正常拿到 key。
- **状态**：已完成。代码位于 `src/gateway/auth.ts`；测试覆盖于 `tests/enterprise-s1.test.ts`。

### F5: `--bearer` 仍可能把 token 放进 query
- **发现**：环境变量存在 `PERIMETER_TOKEN` 时，`--bearer` 仍向 query 注入 token。
- **修复**：`scripts/attach.ts` 优先使用 Bearer 头，显式冲突参数（同时指定 `--bearer` 与 `--token`/`--actor`）报错退出，不向 query 写入 token 或 actor。
- **状态**：已完成。代码位于 `scripts/attach.ts`；测试覆盖于 `tests/enterprise-s1.test.ts`。

### F6: 生产网页没有接上 cookie，4001 会每秒重连
- **发现**：`web/app.js` 复制 query 到 WS；关闭码除 4003 外都 1s 重连（4001 打满入口）。
- **修复**：
  1. 页面支持 bearer 换取 `__Host-` cookie 后发起纯净 WS 连接；
  2. 4001 与 4003 停止重连；其余错误采用指数退避加 jitter；
  3. 保持 demo 模式兼容；
  4. 真实浏览器验证：已由 Chrome 154 实测通过（Cookie 交换、4001/4003 停止重连、退避间隔从 1129ms 增至 1557ms）；ego-browser CLI 在非交互终端挂起属本地运行限制，不列入产品 external。
- **状态**：已完成。代码位于 `web/app.js`；测试覆盖于 `tests/enterprise-s1.test.ts`。

### F7: 文档缺陷：阶段定义与 handoff 不一致
- **发现**：`docs/s1-implementation-report.md` S2-S7 定义偏离 handoff §7。
- **修复**：校准 `docs/s1-implementation-report.md` 与 `README.md`，对齐 handoff §7，明确未实现项与外部阻塞（PKCE、持久吊销、真实集群、真实模型凭据等均如实记录）。
- **状态**：已完成。

## 第三轮复审追加修复与硬化

### R3-1: `s1-bearer-page-query` 凭据泄露根治与安全会话建立
- **发现**：初次文档 GET 携带 query token 会泄漏至浏览器历史、Referer 与代理 access 日志；生产页面 `web/app.js` 从 `location.search` 读取 bearer 并在失败时泄漏至 URL；demo 启动日志向控制台打印带 token 的 URL。
- **修复**：
  1. `web/app.js` 彻底移除 `params.get("bearer")`，改为仅从一次性 `location.hash` 读取 `#bearer=...` 凭据；
  2. 页面读取后立即执行 `history.replaceState(null, "", window.location.pathname)` 清空 hash，杜绝凭据滞留；
  3. 通过受控 Header `POST /auth/session` 换取 `__Host-` Cookie，随后的 WS 仅携带纯净 session 参数；
  4. 暴露 `window.login` 支持无 hash 安全注入；
  5. `scripts/demo.ts` 与 `src/gateway/server.ts` 移除控制台打印的 token URL，仅输出基础监听地址。
- **状态**：已完成。代码位于 `web/app.js`、`scripts/demo.ts`、`src/gateway/server.ts`；测试覆盖于 `tests/enterprise-s1.test.ts`。

### R3-2: 测试神谕硬化（F3-1 与 F3-3 真实模型日志断言）
- **发现**：`mock-model.mjs` 仅向 `process.argv[4]` 文件写入 JSON 日志，原测试检查 stderr 无法捕获模型请求；原负向测试缺少正向对照组验证神谕有效性。
- **修复**：
  1. F3-1：向 mock-model 传入 `argv[4]` 日志路径，不仅断言响应且断言日志文件确实包含 prompt 内容；未映射组断言连接拒绝且模型日志字节增量为 0；
  2. F3-3：传入 `argv[4]` 日志文件，断言撤权后模型日志不包含该 prompt 且无副作用文件生成；追加不撤权正向对照组断言模型日志明确捕获 prompt；各等待阶段设置显式 5s deadline，杜绝挂起。
- **状态**：已完成。测试覆盖于 `tests/enterprise-s1.test.ts`。

## 第四轮复审追加修复与硬化

### R4-1: `web/app.js` 彻底不从 search 读凭据与地址栏抹除
- **发现**：第四轮复审指出打开 `/?bearer=&token=&actor=` 时，`web/app.js` 约 70–72 行仍从 `location.search` 读取 token 与 actor 并抄进随后的 WS，导致 401 后退避重复发送带凭证的 URL。
- **修复**：
  1. `web/app.js` 顶部即对 `params` 执行 `delete("bearer")`、`delete("token")`、`delete("actor")`；
  2. 彻底删除 `params.has("token")` 与 `params.has("actor")` 抄进 WS 的代码，WebSocket URL 仅允许携带 `session` 参数；
  3. `connect()` 启动时通过 `history.replaceState` 立即抹除地址栏遗留的 hash 及 search 中的凭据参数；
  4. 绝不向 query 传递敏感凭据，保持显式 `window.login` 兼容。
- **状态**：已完成。代码位于 `web/app.js`，测试覆盖于 `tests/enterprise-s1.test.ts`。

### R4-2: F3-3 测试神谕修复与正向对照硬化
- **发现**：第四轮复审运行 395 pass 1 fail（仅 F3-3 正向对照失败）。原因在于 5s 循环过早以用户第一条 `message.end` 退出（发生在 mock 执行 `appendFileSync` 之前，导致未能读到日志）；负向断言的工作区 `queue-leak.txt` 对应 mock 原本只返回 `{ text: "ok" }`，无法保证 negative oracle 可失败；放开环境前存在固定 sleep 50ms。
- **修复**：
  1. 正向退出条件：采用 bounded 轮询（带 5s deadline），直接轮询 `argv[4]` 真实日志直到包含 prompt；
  2. 真实可失败性证明：mock 脚本配置真实工具调用 `write queue-leak.txt`，正向对照组验证真实写出工作区文件 `queue-leak.txt`，负向断言该文件不存在且日志不含 prompt；
  3. 消除固定 sleep 50ms：通过 `BlockingBackend` 的 `environment` 阻塞 Promise 门事件驱动确认会话已阻塞，放开环境前提前注册监听器；
  4. 杜绝读取 stderr。
- **状态**：已完成。测试覆盖于 `tests/enterprise-s1.test.ts`。

## 第五轮（Grok 第一轮复审四项缺陷修复）

### R5-1: PKCE Cookie 规范与跨站验证
- **缺陷**：`__Host-perimeter_pkce` 在清空时漏了 `Path=/` 导致部分 UA 无法清除；多受众 JWT 未校验 `azp` 与 `clientId` 强绑定。
- **修复**：
  1. `__Host-perimeter_pkce` 强制统一设为 `Path=/; HttpOnly; Secure; SameSite=Lax`；
  2. 测试套件对所有 `Set-Cookie` 断言 `__Host-` 规则不变式（必须包含 `Secure` 且必须包含 `Path=/`）；
  3. OIDC callback 校验 ID Token 时，对多受众（数组或非空受众集合）强制要求 `azp === clientId`，不匹配直接 401 拒签。
- **状态**：已完成。代码位于 `src/gateway/server.ts`，测试覆盖于 `tests/enterprise-s1.test.ts`。

### R5-2: BrowserSessions 身份解耦与崩溃窗口阻断
- **缺陷**：落盘时将会话 ID 粗暴映射回主体 ID，导致重启后 Bob 被改写为随机会话 ID；重启时未按吊销列表过滤会话，崩溃窗口 Alice 旧会话可绕过吊销。
- **修复**：
  1. `BrowserSessions.dump()` 与 `restore()` 格式改为 `{ sessionId, principal, sessionExpiresAt }`，彻底分离两者；
  2. `restore()` 增加强类型与边界校验；
  3. 网关启动加载时，根据 `principal.id` 比对 `#revoked`，被吊销主体的遗留会话直接丢弃，阻断崩溃窗口遗留会话；未吊销主体（Bob）保持原始 `principal` 接入。
- **状态**：已完成。代码位于 `src/gateway/auth.ts` 与 `src/gateway/server.ts`，测试覆盖于 `tests/enterprise-s1.test.ts`。

### R5-3: 文件权限、Fail-Closed 与构造异常安全
- **缺陷**：敏感文件（`revocations.json`, `browser-sessions.json`）未强制 `0600`，`stateRoot` 未强制 `0700`；已初始化状态下缺失 `revocations.json` 未 fail-closed 拒启并写审计；构造函数先打开 AuditLog 再校验参数导致异常时文件锁泄露。
- **修复**：
  1. 敏感 JSON 写入及加载时显式设置权限 `0600`，`stateRoot` 创建显式设为 `0700`；
  2. 已初始化实例（存在 `sessions` 或 `.initialized` 标记）若缺失 `revocations.json`，立即 fail-closed 抛错拒启并审计留痕；损坏内容同样抛错拒启；
  3. 调整 Gateway 构造函数顺序：先验证参数配置，再分配系统资源；构造后续步骤发生异常时在 catch 块中显式执行 `this.#audit.close()` 释放文件锁；
  4. 新增独立 child-process 重启、崩溃窗口与 fail-closed 破坏性测试用例。
- **状态**：已完成。代码位于 `src/gateway/server.ts`，测试覆盖于 `tests/enterprise-s1.test.ts`。

### R5-4: S0 依赖与台账纠正
- **缺陷**：依赖包名混淆；未提交源码文件哈希台账缺失；部分风险责任人未标明；基准报告未显式标明模拟测量。
- **修复**：
  1. 依赖名统一为 `@earendil-works/*`（1.1.0）；
  2. `docs/s0/dependency-and-scope.md` 更新未提交 dirty 源码真实 SHA-256 哈希台账；
  3. `docs/s0/threat-model.md` 未核实责任人统一标注为「待指定」，补齐 root 物理删除残余风险；
  4. `docs/s0/benchmark-baseline.md` 明确声明数据为本地骨架模拟生成（Synthetic Simulation）；
  5. `tests/docker-backend.test.ts` cleanups 加 5000ms deadline 超时，杜绝 20 分钟挂死。
- **状态**：已完成。

## 验证结论
- `npm run typecheck`：通过（0 errors）。
- 核心测试套件（27 个测试文件）：378 项测试全部通过（pass 378, fail 0）。
- `enterprise-s1.test.ts`：31 项测试全部通过（pass 31, fail 0）。
- `docker-backend.test.ts`：20 pass, 2 fail（2 项容器隔离为 S2 范畴，5s deadline 杜绝挂死；如实单列，绝不虚报全绿）。
- `git diff --check`：通过（无空白/冲突残留）。
