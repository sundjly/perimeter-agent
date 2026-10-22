# Grok S1 第二轮复审（F1–F7）

- 结论：`request_changes`
- 日期：2026-10-13
- 审查者：grok（唯一 reviewer）
- 对象：agy 对 `docs/reviews/grok-baseline.md` F1–F7 的修复。宣称见 `docs/implementation/s1-grok-fixes.md`，本轮不采信该文件的“已闭环”。
- 允许写入：本文件与 `docs/reviews/handoff-coverage.json`。未改实现、测试，未 commit / push。

## 命令

| 命令 | 结果 |
|---|---|
| `npm test` | 391 pass，0 fail，0 skip，exit 0 |
| `npm run typecheck` | exit 0 |
| `git diff --check` | exit 0 |
| 浏览器 | Headless Chrome 154。网关进程只有 HTTP，production 拒绝非 https Origin，所以页面经过本机 TLS 反代，Host 改写成网关允许的 `127.0.0.1:port` |
| docker / kubectl | 本轮未重跑。第一轮 `docker info` 与 `kubectl config current-context` 均为 exit 1。不把环境缺失写成通过 |

## 逐项

| 项 | 结论 | 本轮观察 |
|---|---|---|
| F1 验签取消与 HTTP+WS 并发闸 | 通过 | 20 个忽略 abort 的 `authenticate` 真正进入后，第 21 个 HTTP 与随后的 WS 都是 503。这 20 个超时为 504，且没有 `Set-Cookie`；超时返回后、底层 Promise 仍未完成时，再来的请求仍是 503。底层改为遇 abort 就 reject 后，下一请求是 204 并带 `__Host-perimeter_session`。agy 的 F1 测试在 20 个请求尚未进入 `authenticate` 时就发出第 21 个，存在竞态；行为本身成立 |
| F2 撤权断连与 presence | 通过 | `resolveScope` 按 actor 翻转后，Bob 的下一条命令关闭码 4003，Alice 收到的 presence 只剩 `corp\|alice` |
| F3 入队、命令与审批二次鉴权 | 未通过 | 见下文。仓库里的 F3 测试只调用 `revokePrincipal` 然后 `assert.ok(true)` |
| F4 JWKS 与 clock skew | 原缺陷通过，单飞仍有一处未通过 | `clockSkewSec` 为 NaN、Infinity、-1、301 时构造失败。skew 30 接受 `exp = now-10`，拒绝 `exp = now-31`；默认 skew 同样拒绝 `exp = now-31`。`ttlMs > maxStaleMs` 构造失败。缓存年龄 2s（ttl 1s、maxStale 5s）且刷新 500 时仍返回旧 kid；年龄 6s 且刷新失败时抛 `JWKS 不可用`，不返回旧 kid。两个都带 AbortSignal 的 `get`：abort 其中一个后，另一个仍拿到 kid。一个带 signal、一个不带：abort 前者会取消共享 fetch，后者抛 `JWKS 不可用: This operation was aborted` |
| F5 CLI 混用 | 通过 | `--bearer` 加 `--token`、`--bearer` 加 `--actor` 都是 exit 1。`--bearer secret-jwt` 且环境变量 `PERIMETER_TOKEN=env-demo-token` 时，升级 URL 为 `/?session=session-123`，头为 `Authorization: Bearer secret-jwt` |
| F6 网页 cookie、关闭码、退避 | 通过 | Chrome 打开 `https://127.0.0.1:<port>/?bearer=...` 后：`POST /auth/session` 204，Cookie 名为 `__Host-perimeter_session`，HttpOnly、Secure、SameSite=Strict；`document.cookie` 为空。成功后地址栏只有 `session`，没有 bearer。随后的 WS 查询串是 `/?`，带 Cookie，不带 Authorization。连续失败的重连间隔为 1129ms 然后 1557ms。`revokePrincipal` 之后 3.5s 内没有新的升级。4003 与 4001 在 `web/app.js` 是同一个 `return`；4003 的关闭本轮在 Node 复现，没有在 Chrome 里单独点一次 |
| F7 文档阶段 | 通过 | `docs/s1-implementation-report.md` 已写明只完成 S0/S1，S2–S7 与 handoff §7 一致，并写明未做 PKCE、内存吊销会在重启后丢失、默认 clock skew 30s。README 第 58 行不再把“无 OIDC”和文首的 cookie 流程写成互相否定。真实 IdP、集群、模型、WORM/KMS/DPA、soak、客户批准仍然未实现 |

F6 残留：第一次文档请求的 URL 仍含 bearer，交换成功后 `history.replaceState` 才删掉。静态响应有 `referrer-policy: no-referrer`。这不是本项失败条件。

## F3 未通过的两处

生产 CLI 的 scope 是 `principal ? scopeFromGroups(scopes)(principal) : undefined`（`src/gateway/server.ts` 约 1039 行）。会话回调却是 `isAuthorized(actor, undefined, meta)`（约 431 行）。`scopeFromGroups` 在没有 principal 时返回 undefined，于是 `#isAuthorized` 对每条会话命令失败。

独立复现：principal 的 groups 含 `dev`，映射到 `main-repo/core-team`。接入后发送 prompt。收到 `资源权限已撤销`，`readyState` 仍为 1，关闭码为空。对照用只看 actor、忽略 principal 的 `resolveScope`，同一条路径不会发出这句。WS 命令层使用的是连接上的真实 principal，所以连接保持打开，拒绝发生在 `session.handle`。生产组映射下命令在入队前就被拒绝，队列二次检查走不到这条生产路径。

资源撤权没有废止在途审批。`revokePrincipal` 会 `expirePending` 并关闭 4001。只把 `resolveScope` 对 Alice 改为拒绝时，4003 路径不调用 `expirePending`。复现：Alice 的 mock 模型请求 `write package.json` 并进入 `approval.request`，随后取消 Alice 的 scope，Bob（editor）发送 `approve allow`。`package.json` 被写上，Bob 收到 `tool.start` 与 `tool.end`，Alice 随后才以 4003 离开 presence。`revokePrincipal("corp|alice")` 的对照没有写出该文件，Alice 的关闭码是 4001。

入队对照（actor 型 scope，卡住 `environment()`）：翻转权限之前没有错误帧，放开之后 mock 日志为空，Bob 最终 4003。这条 flush 跳过是存在的，但仓库测试没有锁住它，生产 principal 路径也到不了这里。

## 台账

`docs/implementation-progress.json` 不是本轮允许修改的文件。它把 F1–F7 写成已闭环，与上面的 F3、F4 不符。分类按 handoff §7 校正如下，并已写进 `handoff-coverage.json`：

- S0：真实模型上的成本数字是 `external_blocked`。固定任务集、测量骨架、威胁模型台账（责任人、到期日）是本地就能做的 `missing` / `partial`，不能整段叫做 external。
- S5：`implementation-progress.json` 仍写“重连退避未实现”。`web/app.js` 已对 4001/4003 停止重连，其余断线按 `1000 * 1.5^n` 加 0–500ms jitter，成功打开后把计数归零。本轮浏览器量到连续失败间隔从 1129ms 增到 1557ms。分页和真实成本基准仍是 missing；真实大样本才是 external。
- PKCE 与持久吊销是 S1 的 `missing`。用测试 IdP 和一次重启就能验收，不能因为没有客户 issuer 而标成 `external_blocked`。客户 issuer、audience、组映射仍是 `s1-real-idp` 的 external。
- 阶段依赖：S3 依赖 S1，不依赖“S2 真实集群已经通过”。S4 依赖 S1 与 S3。S7 要等 S6，并且要有单节点瓶颈测量。进度文件里 S3 的 `nextTask`“待 S2 完成”与 handoff 不符。
- ego-browser 挂起不是产品 external。本轮用本机 Chrome 验证了 cookie 与退避。

## 给 agy 的最小修复包

只改这些。修完后由 grok 再复审。不要顺手改 S2–S7，不要把 docker、kubectl、真实 IdP 写成通过。

1. `src/gateway/server.ts` 会话回调。按 actor 取当前连接上的 `principal` 再交给 `#isAuthorized`，不要传 `undefined`。连接已经不在集合里时返回 undefined，命令失败关闭。
   - 今天会失败的测试：production 形态 `resolveScope: (_actor, principal) => principal ? scopeFromGroups({ dev: { repo: "main-repo", team: "core-team" } })(principal) : undefined`，groups 含 `dev`。prompt 不得出现 `资源权限已撤销`。去掉模型配置时，应与“忽略 principal 的 scope”一样只出现会话启动失败。
2. `src/gateway/session.ts` 的 `#command` 与 `src/runtime/approvals.ts` 的 `decide`。`decision === "allow"` 提交前读取该审批的 `item.actor`，`isAuthorized(item.actor)` 不为真则把该条标成 expired / deny，不得执行工具。只在 4003 的广播里补 `expirePending` 不够：本轮 Bob 的 allow 先执行，Alice 随后才被 4003 断开。4003 的命令、快照和广播路径仍要调用 `expirePending(actor)`，用来解开已经挂起的 waiter。
   - 今天会失败的测试：Alice 触发 `write package.json` 的 `approval.request` 后，把 Alice 的 `resolveScope` 改为 undefined，Bob 发送 allow。工作区不得出现 `package.json`。`revokePrincipal` 对照保持文件不存在、Alice 关闭码 4001。
3. 删掉 `tests/enterprise-s1.test.ts` 里 F3 的 `assert.ok(true)`。补上第 1、2 条的负向测试，再加一条：卡住执行环境，入队 prompt，翻转该 actor 的 scope，放开环境，mock 日志不得含该 prompt。
4. `src/gateway/auth.ts` `RemoteJwks.#waitForInflight`。不带 signal 的调用者也要占一个 waiter，这样另一个调用者 abort 时 `waiters.size` 不会变成 0，共享 fetch 不会被取消。只有没有任何等待者时才 abort。
   - 今天会失败的测试：同一次挂起的 JWKS 上，一个 `get(kid, signal)` 与一个 `get(kid)` 并行；abort 前者并放开 HTTP 响应后，后者必须返回 kid。两个都带 signal 的现有行为必须保持：abort 一个，另一个仍拿到 kid。

F1 测试可以顺手改成先等到 20 次 `authenticate` 进入再发第 21 个请求。这不是本轮产品缺陷。
