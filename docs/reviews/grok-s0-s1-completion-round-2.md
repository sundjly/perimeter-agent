# Grok S0+S1 完成轮第二审

- 结论：`approve`（仅限本轮修复项：PKCE 浏览器全链路、多受众 azp、持久化吊销与存储卫生、S0 记录校准。不是企业生产批准，S1 之外的口径见台账）
- 日期：2026-10-14
- 审查者：grok（唯一 reviewer）
- 对象：`docs/implementation/s0-s1-completion.md` 第二版与对应代码（`server.ts` `e40bc688f01977c4`、`auth.ts` `b4961360460c55ad`、`enterprise-s1.test.ts` `8b8815f790d8ec93`、`docker-backend.test.ts` `10555da53069031d`）。基线是 `docs/reviews/grok-s0-s1-completion-round-1.md`。
- 允许写入：本文件与 `docs/reviews/handoff-coverage.json`。未改代码、测试、docs 其他文件、README、handoff、依赖；未 commit / push。

## 命令与全量现状

| 命令 | 结果 |
|---|---|
| `npm test` 全量 | 420 秒墙钟未跑完，按 deadline 杀掉（exit 137）。不能给出全量绿数字 |
| 31 个测试文件（除 `docker-backend.test.ts`） | 378 pass，0 fail，exit 0（含 enterprise-s1 的 31 项；不要把 378 再叠加 enterprise 计成 409） |
| `enterprise-s1.test.ts` 单独 | 31 项，全部通过 |
| `docker-backend.test.ts` 单独（另一天复跑） | 全部用例打印完：容器隔离子套件 3 过 2 败（策略扩展只读挂载失败、容器端到端 40s 超时），其余约 20 项通过；**用例结束后进程仍不退出**，等 5 分钟手工 kill（137）。`--test-timeout=45000` 不能解除。新增的 cleanup 5s 竞速只让 after() 返回，没有换来真退出 |
| `npm run typecheck` | exit 0 |
| `git diff --check` | exit 0 |
| docker / kubectl | docker 29.8.2、镜像在，容器测试真实执行；kubectl current-context 仍未设置 |

agy 报的"核心 378 + enterprise 31 + docker 20/2"里，378 与 31 是重叠口径（我的 378 已含 enterprise）。真实全景：**378 过（除 docker 外全部）+ docker 文件 2 败 + 全量进程不退出**。本轮没有把排除后的 378 当全量 400 绿。

## PKCE：真实 Chrome 跨站全链路

测试 IdP 独立起在本机另一端口（http），网关为 production、redirect_uri 走本机 TLS 反代（https），对 Chrome 而言 login→IdP→callback 是跨站重定向链：

- `/auth/oidc/login` 302，`Set-Cookie __Host-perimeter_pkce=…; Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Lax`，授权 URL 带 `code_challenge_method=S256`。
- Chrome 跨站回到 callback 时携带该 cookie，callback 302 到 `/`，同响应签发 `__Host-perimeter_session`（HttpOnly、Secure、SameSite=Strict、Max-Age=3599）并把 pkce cookie 置 `Max-Age=0` 销毁。
- 页面落在 `/?session=…`，hash 为空，`document.cookie` 为空，随后的 WebSocket 升级带会话 cookie 且升级成功。全链路没有任何 bearer/token/actor 出现在 URL。
- 本机 Chrome（Headless 154，`--ignore-certificate-errors` 经 TLS 反代）。第一天失败时用拦截重放与分支标记（x-branch）把 400 精确定位到我脚本的 `allowHttp` 配置缺失，网关的 http token 端点拒绝（branch F）行为正确；修正后全链路直通。

Node 侧负测（独立复现，非套件）：state 篡改 400、无 cookie 400、伪造 `Cookie=state` 400、授权码重放 401、nonce 错配 401、iss 错 401、aud 错 401、**多受众无 azp 或 azp 错值 401、多受众 azp=clientId 302**、token 端点 302 不跟随 401、70KiB 洪泛 400；`authTimeoutMs=1500` 时 token 端点拖 4s → 502 且无会话 cookie；客户端 300ms 断开 → 会话文件条目数不增加（无迟到 cookie）；20 个挂起占满并发闸时 callback 503 且无 cookie，放行后挂起者 204、下一轮 callback 302（20 槽占满与放行另在隔离脚本复核：entered=20、放行后 20×204）。

## 持久化吊销：真实双子进程

父进程生成 RSA，两个独立 node 子进程共享 stateRoot（非 new Gateway）：

- 子进程 A：alice、bob 换会话 → `revokePrincipal("https://corp.local|alice")` → 落盘退出。
- 子进程 B（真实重启）：alice 同 JWT 401；alice 旧 cookie 的 WS 401；**bob 旧 cookie 的 WS 打开且 actor 仍是 `https://corp.local|bob`**（身份跨进程保持，round-1 的会话串改写已修复）；`restorePrincipal` 后 alice 204。
- 崩溃窗口构造（吊销已落盘 + 会话文件仍含 alice，新格式 `{sessionId, principal, sessionExpiresAt}`）：重启后 alice 旧 cookie 401 —— 加载器按 `principal.id` 过滤生效。
- 已初始化（`.initialized` 存在）后删除 `revocations.json` → 子进程 exit 3 拒启，报「吊销记录文件缺失…fail-closed」；不再是静默空黑名单。
- 结构损坏两类（revoked 内非字符串；会话条目缺 principal）→ 均 exit 3 拒启。
- 写失败：stateRoot 只读时子进程构造/写盘失败可见退出（进程级 EACCES 路径；本轮子进程以 SIGTERM 超时收场，进程内等价复现在 round-1 已证 EACCES 抛出）。
- 权限：`revocations.json`、`browser-sessions.json`、`.initialized` 均 0600，stateRoot 0700；`chmod` 调用全部限于 stateRoot 及其内部文件，无既有用户目录被改。
- 恢复信任边界：恢复条目经 `BrowserSessions.restore` 严格校验（id/issuer/subject/groups/expiresAt/sessionExpiresAt 逐字段类型），credential 粒度上浏览器是 HttpOnly 会话 cookie、CLI 仍是短期 token，与 handoff §5.2 一致。

## S0

- 依赖：`docs/s0/dependency-and-scope.md` 与 package.json/lock 对齐（`@earendil-works/chord`、`@earendil-works/pi-ai`、`@earendil-works/pi-durable`、`@earendil-works/pi-env` 各 1.1.0，ws `^8.18.0`、yaml `^2.6.1`），SHA-256 台账与本次实测一致。
- 基准：`benchmark-baseline.md` 表头与逐行标注「模拟测量 / Synthetic Simulation」，声明随机区间与空转预期、无真实 runner、金额 $0.00 不代表真实经济效益。骨架仍无真实跑批管道，保持 partial。
- 威胁台账：未授权负责人统一「待指定」，RSK-002 补记 root 物理删除的残余风险与人工介入恢复路径。
- 遗留一处过时表述：`dependency-and-scope.md` 仍写「DockerBackend 因本地守护进程未配置而 external_blocked」，而 docker 29.8.2 已可用且套件真实跑了容器。属记录更新义务，不阻塞本包。

## 台账变动

- `s1-pkce`：`partial` → `implemented`。
- `s1-persistent-revocation`：`partial` → `implemented`。
- `s0-dependency-record`：保持 `partial`（名字/版本/hash 已对齐，DockerBackend 状态行过时）。
- `s0-benchmark-baseline`：保持 `partial`（synthetic 已标注，真实 runner 仍缺）。
- `s0-threat-model`：保持 `implemented`（证据补「待指定」与 RSK-002 残余）。
- `s2-container-hardening`：保持 `partial`（容器 3 过 2 败复现；本轮不修 S2）。
- 真实 IdP、真实集群 egress、备份恢复、真实模型、soak/客户批准/WORM 仍 `external_blocked`；PKCE 无任何被写成公司 SSO 的表述。

企业生产仍不批准。

## 下一阶段可本地实现的任务

1. `docker-backend.test.ts` 收尾真退出：定位 cleanup 后仍存活的句柄（docker 流/子进程），给每个 owned 资源释放加 deadline 并在 after() 末尾显式结束进程；验收是全量 `npm test` 能在墙钟内自行退出并给出 400 项口径的总计（378 + docker 22，其中 2 败）。
2. 容器 2 项失败（策略扩展只读挂载、容器端到端策略钩子）属 S2 范畴：给 agy 保留为 S2 首批任务，先修测试对 owned 容器资源的清理，再修挂载与端到端。
3. `dependency-and-scope.md` 的 DockerBackend 状态行改为与当前环境一致（daemon 可用、容器测试已执行、真实隔离边界仍待真实负载与集群）。
4. 基准从骨架到 runner：把 30 个固定任务接到本地真实执行管道（LocalBackend + mock 模型），产出可复跑 JSON 报告后，才把 `s0-benchmark-baseline` 升 implemented；synthetic 表保留为骨架自检。
5. 威胁台账「待指定」条目交由授权人指派具名负责人后回填；指派前不视为已闭环。
