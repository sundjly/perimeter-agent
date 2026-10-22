# Grok S1 第五轮复审

- 结论：`approve`（只针对第四轮末尾的最小包。不是 S1 放行）
- 日期：2026-10-13
- 审查者：grok（唯一 reviewer）
- 对象：`web/app.js` 不再从 `location.search` 读取凭证，hash 清空后交换；F3-3 正向对照改为轮询 argv[4]，mock 脚本可写 `queue-leak.txt`。
- 允许写入：本文件与 `docs/reviews/handoff-coverage.json`。未改实现、测试、handoff，未 commit / push。

## 命令

| 命令 | 结果 |
|---|---|
| `npm test` 第 1 次 | 396 pass，0 fail，exit 0 |
| `npm test` 第 2 次 | 396 pass，0 fail，exit 0 |
| `npm test` 第 3 次 | 396 pass，0 fail，exit 0 |
| `npm run typecheck` | exit 0 |
| `git diff --check` | exit 0 |

三次全量按协调者要求串行执行，没有并发跑，没有重跑掩盖。

## 浏览器（Headless Chrome，经本机 TLS 反代）

| 检查 | 结果 |
|---|---|
| hash `#bearer=` 的第一次文档 GET | 通过。查询键为空 |
| hash 清空后再交换 | 通过。`replaceState` 在 `fetch` 之前；POST 时 hash 为空、search 为空 |
| 换取 cookie | 通过。`POST /auth/session` 无 query，204，`__Host-perimeter_session`，HttpOnly、Secure、SameSite=Strict，`document.cookie` 为空 |
| hash 交换后的 WS | 通过。URL 为 `/?`，后加 session，无 bearer/token/actor |
| 打开 `/?bearer=` | 第一次 GET 带 bearer 是用户的导航。页面此后没有发任何带凭证的 POST（auth 交换次数 0），WS 无凭证，地址栏的 bearer 被抹掉 |
| 打开 `/?token=&actor=` | 同上。页面没有把它们抄进 WS，地址栏被抹掉 |
| `/?token=&actor=` 加 `#bearer=` 组合 | 通过。第一次 GET 只带 token/actor（hash 不发给服务器）。页面用 hash 的 bearer 完成交换（204），search 与 hash 都被清空，WS 无凭证 |
| 4003 | 通过。页面套接字收到关闭码 4003，4 秒内没有新的升级 |
| 4001 | 通过。`revokePrincipal` 后 3.5 秒没有新的升级 |
| 退避 | 通过。连续失败间隔 1372ms，然后 1555ms |
| demo 启动日志 | 通过。`server.ts` 的行是 `http://127.0.0.1:<port>/`，不含 `?token=`，也不含 token 值。`scripts/demo.ts` 的打开行同样没有 query |

四次 raw-search / hash 组合都验证了同一件事：页面自己发出的 POST 和 WS 都不再携带凭证。用户键入的那一次导航 GET 仍会带查询串，页面把它从地址栏抹掉，这符合第四轮包的验收口径。

## F3-3

独立复现（argv[4] 日志，不看 stderr）：

- 负向：`environment()` 卡住后入队，确认进入阻塞再撤权，放开。关闭码 4003。日志 0 字节。工作区没有 `queue-leak.txt`。stderr 不含 prompt。
- 正向对照：同一脚本（会执行 `write queue-leak.txt`），不撤权。argv[4] 含 prompt，工作区真的写出该文件。它证明负向的两个断言（无 prompt、无 marker）都可能失败。

仓库里的 F3-3 也改对了：正向在放开环境前注册监听，轮询 argv[4] 直到含 prompt，不以 `message.end` 退出；随后再轮询工作区里真实的 `queue-leak.txt`，把 oracle 的可失败性锁进测试。负向断言关闭码 4003、无 prompt、无 marker。

## 台账

本轮只把与这个包对应的项收成 `implemented`：

- `s1-bearer-page-query`、`s1-prod-query-token`、`s1-web-cli-client`：`implemented`。依据是本轮 Chrome 的四组 raw-search / hash 行为、cookie 交换、干净 WS 与 demo 启动日志。
- `s1-cookie-session`、`s5-reconnect-backoff`、`s1-inflight-recheck`：状态不变，证据换成第五轮数据。

这不是 S1 放行。剩余分类不动：

- `s1-pkce` 与 `s1-persistent-revocation` 仍是本地 `missing`。测试 IdP 与一次重启即可验收。
- S0 的固定任务集、测量骨架、威胁台账仍是 `missing`。
- `s1-real-idp`、`s2-real-egress`、`s3-backup-restore`、`s4-real-model`、S6 的 soak / 客户批准 / WORM-KMS-DPA 仍是 `external_blocked`，不算已实现。
- 阶段依赖不变：S3 依赖 S1；S4 依赖 S1 与 S3；S7 依赖 S6 与独占锁。

## 给 agy 的下一包

S1 只剩两个本地缺口，加上 S0 骨架：

1. PKCE：用测试 IdP 走通 Authorization Code + PKCE，网关不冒充公司 SSO。验收：测试 IdP 上换到短期 token，`web` 与 CLI 都能用它完成 cookie/WS 流程；文档不声称已接客户 SSO。
2. 持久吊销：吊销表与浏览器会话落盘。验收：写入吊销记录后重启网关，同一主体用旧 cookie 或旧 token 接入被拒。
3. S0 骨架：固定任务集、测量脚本骨架与威胁台账文件（责任人、到期日）。先本地能跑，真实模型成本仍是 external。

不做 S2–S7，不把 external 项写成通过。
