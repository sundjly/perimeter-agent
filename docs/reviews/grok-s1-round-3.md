# Grok S1 第三轮复审

- 结论：`request_changes`
- 日期：2026-10-13
- 审查者：grok（唯一 reviewer）
- 对象：agy 针对第二轮 F3 principal、审批 allow、入队撤权、JWKS 混合 waiter 的最小修复。对照 `docs/reviews/grok-s1-round-2.md` 与 `docs/handoff.md` §5.2、§7。
- 允许写入：本文件与 `docs/reviews/handoff-coverage.json`。未改实现、测试，未 commit / push。`docs/implementation-progress.json` 未改。

## 命令

| 命令 | 结果 |
|---|---|
| `npm test` | 395 pass，0 fail，0 skip，exit 0 |
| `npm run typecheck` | exit 0 |
| `git diff --check` | exit 0 |
| 浏览器 | 本轮未重跑。`web/app.js` 的 bearer 读取与第二轮相同 |
| docker / kubectl | 未重跑。第一轮均为 exit 1。不把环境缺失写成通过 |

`tests/**/*.ts` 里没有 `assert.ok(true)`。F3-3 仍然是观察不到失败的负面测试，见下文。

## 行为

| 项 | 结论 | 独立复现 |
|---|---|---|
| 生产组映射下的真实 prompt | 通过 | `resolveScope` 与生产启动相同：`principal ? scopeFromGroups(...)(principal) : undefined`，groups 为 `dev`。`session.ready` 之后发送 `PROMPT-SECRET-a91c`。mock 请求体的 user 内容就是这句，system 内容含 `repo=main-repo` 与 `team=core-team`。没有 `资源权限已撤销`。未映射组 `no-such-group` 关闭码 4003、原因 `无权创建会话`，模型日志 0 字节 |
| Alice 撤权后 Bob allow | 通过 | 对照：不撤权时 Bob allow 出现 `tool.start`，工作区写出 `package.json`。撤权后：先收到 `approval.request`，再把 Alice 的 scope 改为拒绝，Bob 再 allow。没有 `tool.start`，`package.json` 不存在，Alice 关闭码 4003、原因 `资源权限已撤销`。模型在撤权前已被调用，这不构成写文件 |
| 阻塞 environment 的入队 prompt | 通过 | `environment()` 卡住时入队 `QUEUE-SECRET-b7e2`，确认尚未打到模型后撤权，再放开。mock 的 argv[4] 日志保持 0 字节，工作区没有 `queue-leak.txt`。连接关闭码 4003。放开前客户端只有 `attached`，说明 prompt 停在队列里 |
| JWKS 混合 waiter | 通过 | 一个带 AbortSignal、一个不带。等共享 fetch 真正挂起后再 abort。带 signal 的调用抛 `JWKS 请求已取消`，不带的拿到 `kid=key-1`，HTTP 命中数保持 1。两个都带 signal 时 abort 一个，另一个拿到 `kid=key-2`，命中数也是 1 |
| 20 槽并发 | 通过 | 20 个忽略 abort 的 `authenticate` 进入后：第 21 个 HTTP 是 503，随后的 WS 是 503，再一个 HTTP 仍是 503，进入数保持 20。这 20 个为 504，没有 `Set-Cookie`，abort 次数为 20。底层 Promise 未完成时再请求仍是 503。放行后下一请求是 204，`Set-Cookie` 名为 `__Host-perimeter_session` |

仓库里的 F1 测试会等进入数到 20，再断言 503、504 和 abort。它不断言 504 无 cookie、也不断言挂起期间仍是 503。这两点由上面的独立复现补上，行为与第二轮一致。

## 仓库测试仍锁不住的两处

F3-1 不启动模型，只等 100ms，然后断言错误列表里没有 `资源权限已撤销`。没有模型时，正确实现和“根本没把 prompt 送出去”都会让这句不出现。它没有证明用户文本进入模型。

F3-3 把 mock 的 stderr 当成模型请求。`tests/fixtures/mock-model.mjs` 只在 `process.argv[4]` 有路径时把请求体写入该文件，不写 stderr。测试没有传这个参数。因此 `receivedPrompt` 在模型真的收到 `prompt-f3-3-secret` 时也不会变成 true。这和 `assert.ok(true)` 同类：负面断言无法失败。本轮用 argv[4] 日志确认行为是对的，套件本身没有锁住它。

## 生产页面 query 中的 bearer

风险成立。`web/app.js` 从 `location.search` 读取 `bearer`，发给 `POST /auth/session` 的 `Authorization`。只有响应成功才 `delete` 并 `replaceState`。失败或请求未返回时，文档 URL 一直带着凭证。

这是第一次文档 GET，不是后来的 WS。handoff §5.2 要求不再接受生产 query token，禁止启动时打印带密钥的 URL，并删除或屏蔽代理的 query 日志。§7 S1 的完成判据包含“无生产 query token”。反向代理的访问日志会记下这次 GET 的查询串。`referrer-policy` 和第二轮里“交换成功后的 WS 不带 token”都不能抵消这次导航。

生产 `/auth/session` 在 `url.search` 非空或 body 非空时返回 400，所以不能把凭证改成 POST body，除非同时改这条路由。hash 不会发给服务器，可以作为一次性引导；读完立即从地址栏去掉。本轮没有重跑浏览器。第二轮已经看到第一次请求带 `bearer` 查询参数，源码这一段没有变。

demo 启动仍打印 `http://127.0.0.1:<port>/?token=<token>`（`src/gateway/server.ts` 约 1036 行）。生产分支不打印。这是同一条 P0 里的启动日志，不替代页面修复。

## 台账

分类仍按 handoff §7，没有把本地能做的事标成 external：

- PKCE（`s1-pkce`）与持久吊销（`s1-persistent-revocation`）保持 `missing`。测试 IdP 和一次重启就能验收。客户 issuer 仍是 `s1-real-idp` 的 `external_blocked`。
- S0 的固定任务集和测量骨架是 `missing`。真实模型成本才是 external。本轮测试数是 395，不是基线报告。
- S2 的 local backend 默认值、缺 seccomp 是 `missing` / `partial`。docker 与 kubectl 不可用才是 `s2-real-egress` 的 external。
- S3 依赖 S1（`s3-create-receipt` 依赖 `s1-resource-authz`），不依赖“S2 真实集群已经通过”。
- S4 依赖 S1 与 S3：字节 deadline 依赖 `s1-schema-byte-limits`，持久预算再依赖 S3 收据。
- S5 退避保持 `implemented`（第二轮 Chrome 1129ms 然后 1557ms）。分页和本地测量骨架仍是 `missing`。
- S7 依赖 `s6-p0-checklist` 与独占锁。S6 的 soak、客户批准、WORM/KMS/DPA 仍是 external。

本轮只改状态的项：`s1-jwks-fresh-stale`、`s1-resource-authz`、`s1-inflight-recheck` 改为 `implemented`。`s1-prod-query-token` 与 `s1-web-cli-client` 改回 `partial`，因为客户端仍把凭证放进第一次文档 URL。新增 `s1-bearer-page-query`，状态 `missing`。

`docs/implementation-progress.json` 的 395 与这次 `npm test` 一致，但它把 F6 写成已闭环，没有这条页面 URL。那份文件不是本轮台账。

## 给 agy 的下一包

只做这两件。不要做 PKCE、持久吊销，不要改 S2–S7，不要把 docker、kubectl、真实 IdP 写成通过。

1. 新项 `s1-bearer-page-query`。生产页面不得从 `location.search` 读取 `bearer`、`token` 或 `actor`。第一次文档 GET 的请求目标不得含这些字段。可以用 hash 或页内输入，读到后立即从地址栏去掉，再 `POST /auth/session`。验收时看代理或测试服务器收到的第一次 GET，不能只看随后的 WS。交换成功后 cookie 仍是 `__Host-perimeter_session`，WS 仍不带凭证。顺手删掉 demo 启动日志里的 token URL。不要为了塞进 body 去放宽“生产 auth 拒绝 query 和非空 body”，除非这个包同时改路由并证明 body 不会进访问日志。
2. 测试神谕，不改产品行为。F3-1 要启动 mock，把日志路径传给 argv[4]，断言请求体含用户文本，且没有 `资源权限已撤销`；未映射组的日志必须保持为空。F3-3 同样写 argv[4]，撤权后断言日志不含该 prompt、工作区没有副作用文件；另有一条不撤权的对照，断言日志含该 prompt。不得再看 stderr。等待要盖过会话启动，不能只等 200ms。
