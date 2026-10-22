# Grok S1 第四轮复审

- 结论：`request_changes`
- 日期：2026-10-13
- 审查者：grok（唯一 reviewer）
- 对象：第三轮末尾的两件包。hash 引导、header 换 cookie、F3 模型日志。不是 S1 放行。
- 允许写入：本文件与 `docs/reviews/handoff-coverage.json`。未改实现、测试、SDK、handoff，未 commit / push。

## 命令

| 命令 | 结果 |
|---|---|
| `npm test` | 395 pass，1 fail，0 skip，exit 1 |
| `npm run typecheck` | exit 0 |
| `git diff --check` | exit 0 |
| 浏览器 | Headless Chrome。网关只有 HTTP，production 要求 https Origin，所以页面经过本机 TLS 反代，Host 改写成网关允许的地址 |
| docker / kubectl | 未重跑。第一轮均为 exit 1 |

失败的那一项是 `F3-3` 正向对照。`tests/**/*.ts` 里没有 `assert.ok(true)`。

## 浏览器

| 检查 | 结果 |
|---|---|
| hash 引导的第一次文档 GET | 通过。查询键为空，没有 bearer、token、actor |
| 用户直接打开 `/?bearer=&token=&actor=` 的那一次导航 | 浏览器会把这三个键放进第一次 GET。页面不能取消已经发出的导航 |
| hash 先清空再交换 | 通过。`replaceState` 在 `fetch` 之前，POST 时 hash 为空 |
| header POST，query 与 body 仍拒绝 | 通过。query 400，body 400，只有 Authorization 的 POST 204 |
| cookie | 通过。`__Host-perimeter_session`，HttpOnly、Secure、SameSite=Strict，`document.cookie` 为空 |
| hash 交换后的 WS | 通过。URL 是 `/?`，没有凭证 |
| 页面从 search 接受 token/actor | 不通过。页面把它们抄进随后的 WS，401 之后退避再发一次 |
| 4003 不重连 | 通过。关闭码 4003，之后 4 秒没有新升级 |
| 4001 不重连 | 通过。`revokePrincipal` 后 3.5 秒没有新升级 |
| 退避 | 通过。连续失败间隔 1224ms，然后 1713ms |
| demo 启动日志无 token URL | 通过。`server.ts` 与 `scripts/demo.ts` 的打开地址都没有 `?token=` |

hash 引导（`#bearer=`）的细节：

- 第一次文档 GET 的查询键是空的。代理日志里没有 bearer、token、actor。
- `history.replaceState` 发生在 `fetch` 之前。发起 POST 时 `location.hash` 已经是空的。
- `POST /auth/session` 使用 Authorization 头。带 query 的 POST 是 400，带 body 的 POST 是 400，只有头的 POST 是 204。
- `Set-Cookie` 名为 `__Host-perimeter_session`，带 HttpOnly、Secure、SameSite=Strict。`document.cookie` 为空。
- 随后的 WS 是 `/?`，没有 bearer、token、actor。
- 直接向页面套接字发送 prompt，且 scope 已拒绝：关闭码 4003，之后 4 秒没有新的升级。
- `revokePrincipal` 之后 3.5 秒没有新的升级。
- 握手被 500 拒绝时，重连间隔为 1224ms，然后 1713ms。

search 没有通过。打开 `/?bearer=&token=&actor=` 时，浏览器自己的第一次 GET 会带上这三个键，页面拦不住用户已经发出的导航。页面没有用 search 里的 bearer 去换 cookie。它把 search 里的 token 和 actor 抄进 WS，代理看到 `/?token=&actor=`，网关返回 401。401 不是 4001/4003，退避又把同一条带凭证的 WS URL 发了一次。`web/app.js` 约 70–72 行仍从 `location.search` 读取 token 和 actor。

demo 启动日志没有 token URL。`PERIMETER_MODE=demo` 打出的是 `http://127.0.0.1:<port>/`，输出里没有 token 值。`scripts/demo.ts` 的「打开」行同样没有 query；横幅正文仍打印 token 值。这不是 token URL，本项不因此失败。

## F3

独立复现，不看 stderr：

- F3-1：等 `session.ready` 后发送 prompt。argv[4] 日志含该文本，没有 `资源权限已撤销`。未映射组关闭码 4003、原因 `无权创建会话`，日志长度不增加。stderr 不含该 prompt。
- F3-3 负向：`environment()` 卡住后入队，确认已经进入阻塞再撤权，然后放开。关闭码 4003。argv[4] 为 0 字节。mock 脚本会写 `queue-leak.txt`，工作区没有这个文件。stderr 不含该 prompt。
- F3-3 正向：同样阻塞再放开，但不撤权。argv[4] 含该 prompt。stderr 不含。

仓库里的 F3-3 正向对照失败，原因不是等待上限太短，而是退出条件错了。5 秒循环在第一条 `message.end` 就返回。那条是用户消息，发生在 mock 执行 `appendFileSync` 之前，所以日志文件还不存在。前面放开环境前还有一次固定 50ms。监听又是在 `release` 之后才注册。独立复现改为轮询 argv[4] 直到出现 prompt，同一行为可以通过。不要靠重跑把这次失败当成不存在。负向断言的 `queue-leak.txt` 对应脚本是 `{ text: "ok" }`，这条脚本不会写该文件。

## 台账

这不是 S1 放行。分类不动：

- `s1-pkce` 与 `s1-persistent-revocation` 仍是本地 `missing`。客户 issuer 仍是 `s1-real-idp` 的 `external_blocked`。
- S0 固定任务集和测量骨架仍是 `missing`。真实模型成本才是 external。本轮套件 395 pass、1 fail，不是基准报告。
- S2 的 local backend 与缺 seccomp 仍是 `missing` / `partial`。docker 与 kubectl 不可用才是 `s2-real-egress` 的 external。
- S3 依赖 S1，不依赖 S2 真实集群。S4 依赖 S1 与 S3。S7 依赖 S6 与独占锁。S6 的 soak、客户批准、WORM/KMS/DPA 仍是 external。

`s1-bearer-page-query` 保持 `missing`。hash、cookie、干净 WS、启动 URL 已经成立；search 上的 token/actor 仍会被页面写进后续 WS。

## 给 agy 的下一包

只做这两件。不要做 PKCE、持久吊销，不要改 S2–S7。

1. `web/app.js` 不要从 `location.search` 读取 bearer、token 或 actor，也不要把它们放进 WebSocket。验收：Chrome 打开 `/?bearer=&token=&actor=` 时，页面自己发出的 POST 和 WS 都不再带这三个键。用户键入的那一次文档 GET 仍会带查询串，不能用它判失败，也不能用 hash 流程的干净 WS 把它判通过。hash 流程保持现在的行为：先清空 hash，再 POST；第一次 GET 无凭证查询；cookie 与 4001/4003、退避保持。
2. 保留 F3-3 的正向对照和「日志必须含 prompt、负向不得含 prompt、不得有工作区副作用」这些断言，不要删对照，也不要把断言改成只看 `message.end`。监听在放开环境之前注册。正向用有上限的轮询，直到 argv[4] 实际含该 prompt，再允许断言成功；第一条 `message.end` 不能当退出条件。负向同样轮询到超过正向已经能看见日志的时间，或直到关闭后再确认日志仍不含 prompt。mock 脚本必须会写工作区文件，断言该文件不存在。不要读 stderr，不要用固定 50ms 当作模型已经调用。
