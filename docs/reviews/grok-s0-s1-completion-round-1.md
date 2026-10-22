# Grok S0+S1 完成轮第一审

- 结论：`request_changes`
- 日期：2026-10-13
- 审查者：grok（唯一 reviewer）
- 对象：`docs/implementation/s0-s1-completion.md` 宣称的 S0 三份记录与骨架、`/auth/oidc/*` PKCE、stateRoot 持久化吊销。对照 `docs/handoff.md` §3/4/5/7。
- 允许写入：本文件与 `docs/reviews/handoff-coverage.json`。未改代码、测试、handoff、README，未 commit / push。

## 审查对象指纹（SHA-256 前 16 位）

| 文件 | hash |
|---|---|
| `src/gateway/server.ts` | `bf622f28f01977c4` |
| `src/gateway/auth.ts` | `0196a2e386b4b1bc` |
| `src/gateway/session.ts` | `7cb046ba8de8f2b1` |
| `src/runtime/approvals.ts` | `85c11bb740fc0a7a` |
| `src/evals/benchmark-skeleton.ts` | `2dffdc0db8d70fed` |
| `web/app.js` | `c83a6dd30bcb63b9` |
| `tests/enterprise-s1.test.ts` | `8bb79bfc00fbb1d4` |

`docs/s0/dependency-and-scope.md` 里的哈希台账对 `server.ts`（记录为 `f9c1df94…`）与 `tests/enterprise-s1.test.ts`（记录为 `e14fe5e5…`）已经过期，与上表不符。

## 命令

| 命令 | 结果 |
|---|---|
| `npm test` 全量 | 第 1 次在 `docker-backend.test.ts` 容器收尾处挂起超过 20 分钟，按固定 deadline 砍掉，不算通过 |
| `node --test`（31 个文件，排除 `docker-backend.test.ts`）串行两次 | 两次都是 377 pass、0 fail、exit 0 |
| `npm run typecheck` | exit 0 |
| `git diff --check` | exit 0 |
| docker | 本轮可用：29.8.2，镜像 `perimeter-sandbox:test` 存在。容器套件真实跑起来：3 项通过（看不到宿主机文件、根只读、network=none 出网阻断），2 项失败（策略扩展只读挂载断言失败；容器端到端 40s 超时），随后该文件收尾挂死 |
| kubectl | current-context 仍未设置，exit 1 |

全量挂起本身是一条证据：容器路径的测试没有自己的 deadline，docker 可用时整套 CI 就会被它拖死。测试问题归测试，容器行为失败归 `s2-container-hardening` 的证据。

## PKCE：独立复现（真实测试 IdP，签 RS256）

Node 侧全部成立：S256 challenge、302 到 `/`、会话 cookie（`__Host-perimeter_session`，HttpOnly、Secure、SameSite=Strict）并清除临时 cookie、WS 用该 cookie 打开；state 篡改 400、无 cookie 400、伪造 `Cookie=state` 400、授权码重放 401、nonce 错配 401、token 端点 302 不跟随（401）、70KiB 洪泛 400；20 个占满并发闸时 callback 503 且不发会话 cookie，放行后 204、下一轮 callback 302。

真实 Chrome 失败。完整链路 login → IdP → callback 在 callback 处 400（缺少 PKCE cookie），没有会话 cookie，也没有 WS。

根因已用独立探针实锤：Chrome 拒绝存储 `Path` 不是 `/` 的 `__Host-` 前缀 cookie。探针同一浏览器里 `__Host-t1=1; Path=/sub; Secure` 未被存储，`__Host-t2=2; Path=/; Secure` 与普通名字的 cookie 都正常。网关签发的是 `__Host-perimeter_pkce=…; Path=/auth/oidc/callback`，所以真实浏览器整个 PKCE 流程不可用。套件用 node fetch 收发 cookie，不执行前缀规则，因此 398 项绿灯掩盖了它。

另一处确认的缺口：`aud` 为数组（多受众）且无 `azp` 的 id_token 被接受（302 换到会话）。`JwtAuthenticator` 只检查 aud 包含目标值，callback 只查 nonce。单受众部署不受影响，但这与回调端的客户端绑定缺失是同一个洞。

## 持久化吊销：独立复现

成立的：撤权落盘、重启后同 JWT 401、同旧 cookie 的 WS 401、Bob 新登录 204、`restorePrincipal` 后 204、损坏的 `revocations.json` 与 `browser-sessions.json` 都让构造函数 fail-closed 抛错、stateRoot 只读时 `revokePrincipal` 以 EACCES 可见失败而不是静默丢失。

不成立的两处，都已在独立进程里复现：

1. 身份改写。`BrowserSessions.dump()` 用 `{...s, id}` 把条目里的 principal id 覆盖成会话 id。重启后 Bob 用旧 cookie 接入：WS 打开成功，但 actor 是随机会话串，不是 `corp|bob`，并且以这个影子身份新建了会话。`#loadSessions` 里 `#revoked.has(item.id)` 拿会话 id 去比 principal 黑名单，过滤无效。
2. 崩溃窗口 fail-open。手工构造「`revocations.json` 已含 alice、`browser-sessions.json` 仍含 alice 会话」的 stateRoot（对应两次同步写之间崩溃），新网关不拒绝启动，旧 cookie 被接受，actor 是会话串但 groups 还是 alice 的。被吊销主体经重启换回一个新身份继续可用。

## S0

- 依赖、模型能力、部署范围：`docs/s0/dependency-and-scope.md` 内容真实（四个 Pi 包 1.1.0 精确锁定、价格 0、LocalBackend、单节点、stateRoot 本地文件）。哈希台账过期是记录缺陷。
- 威胁台账：`docs/s0/threat-model.md` 有 8 类主体、信任边界图、RSK-01…08 的责任人与到期日。这轮把 RSK-001…003 标成已关闭，与前几轮浏览器证据一致。
- 任务集与骨架：30 个固定任务在 `src/evals/benchmark-skeleton.ts`，`runBenchmarkSkeleton()` 可执行并产出报告。但 success 恒为 true、时长是随机数，`docs/s0/benchmark-baseline.md` 把这些合成数字排成「测量汇总」，没有标注是模拟值。成本诚实为 $0.00，没有冒充真实模型收益。

## 台账变动

- `s1-pkce`：`implemented` → `partial`。node 负测全过，真实 Chrome 断在回调；azp 未绑定。
- `s1-persistent-revocation`：`implemented` → `partial`。常规路径成立，恢复身份改写与崩溃窗口 fail-open 两处代码缺口。
- `s0-benchmark-baseline`：`missing` → `partial`。骨架可执行，测量是合成的，真实跑批管道没有。
- `s0-dependency-record`：保持 `partial`，补哈希过期证据。
- `s0-threat-model`：`partial` → `implemented`。台账、责任人、到期日已可核对。
- `s2-container-hardening`：保持 `partial`，证据换成本轮真实容器结果（3 过 2 败）。
- `s1-real-idp`、`s2-real-egress`、`s3-backup-restore`、`s4-real-model`、S6 的 soak / 客户批准 / WORM-KMS-DPA 仍是 `external_blocked`。任何代码缺口都没有被算成 external。

这不是企业生产批准。S1 的两个安全项回到 partial，S6 门禁未动。

## 协调者校准补验

- 依赖名与 lock 不符。package.json 实际锁定的是 `@earendil-works/chord`、`@earendil-works/pi-ai`、`@earendil-works/pi-durable`、`@earendil-works/pi-env`，均 1.1.0。`docs/s0/dependency-and-scope.md` 写的四个包名（`@pi/durable-coding-tools` 等）在 package.json 与 lock 里都不存在。加上哈希过期，依赖记录这两处都要改。
- 真实子进程重启（两个独立 node 进程共享 stateRoot）复跑撤权：重启后 alice 同 JWT 401、旧 cookie 的 WS 401、`restorePrincipal` 语义不变；同时把两处缺陷坐实到跨进程：Bob 旧 cookie 以随机会话串 actor 接入并新建会话；构造崩溃窗口文件后 alice 旧 cookie 以 `sess-alice` 身份被接受。
- 删除 `revocations.json` 后重启：网关静默以空黑名单启动，alice 直接 204 重新授权。写失败路径（目录只读）会以 EACCES 抛错，但删除路径是静默 fail-open，需要明确策略并留痕。
- 存储文件权限：`revocations.json` 与 `browser-sessions.json` 都是 0644。后者存的是等价 bearer 的会话 id 与主体断言，多用户主机上应为 0600（`stateRoot` 目录应以 0700 创建）。
- 结构损坏的宽容度：JSON 解析失败会 fail-closed，但结构合法、内部类型错误的条目（如 revoked 元素不是字符串）被静默跳过后照常启动。宽容本身可接受，但要在台账里写明。
- callback 的取消路径（socket 断开或超时后不得发迟到 cookie）本轮只在源码层核对（aborted/`#closed` 分支返回 504 无 cookie），未单独复现；20 槽占满时 callback 503 无 cookie 已行为复现。
- OIDC hash 静默换登：`web/app.js` 对 `#bearer=` / `#token=` 一律先清地址栏再无条件 `POST /auth/session`，访问带构造 hash 的链接会把本机现有登录换成该主体（需要攻击者持有该主体的有效 token）。风险低于已修掉的 query 方案，暂不设为阻断项；可在台账记一条低危。
- 威胁台账责任人：`sundy (Sec)` 是仓库所有者，可核对；`infra-team`、`arch-team`、`finance/sec` 是角色名。若没有具名授权，这些条目应标「待指定」，不能算已有责任人。
- 金额口径：`$0.00` 是 mock 价格配置，不是已知真实成本；报告与台账都按此表述，未把 0 当真实账单。
- 真实 IdP、K8s/CNI egress、真实模型与客户批准保持 `external_blocked`；docker 29.8.2 可用不改变它们的分类，容器三项通过也不改变 `s2-container-hardening` 的 partial。

## 补充（2026-10-14）

单独以 `node --test --test-timeout=45000 tests/docker-backend.test.ts` 复跑挂死点：全部用例（含两项容器失败：策略扩展只读挂载 185ms 即失败、容器端到端 40s 超时）打印完毕后进程仍不退出，等 5 分钟后手工 kill（exit 137）。`--test-timeout` 无法解除，说明挂在全部用例结束之后的清理钩子或存活句柄（docker stop/rm 或未关闭的流），不是单个用例内挂起。该项属测试收尾问题，随下一包第 2 点一并修（给清理加 deadline），容器行为本身仍按 `s2-container-hardening` 的 partial 证据处理。

## 给 agy 的下一最小包

1. PKCE 临时 cookie 改成浏览器可存储：保留 `__Host-` 前缀就写 `Path=/`，或者去掉前缀改 `Path=/auth/oidc/callback`（HttpOnly、Secure、SameSite=Lax 不变）。验收必须是真实 Chrome 全链路：login → IdP → callback 302 `/` → 会话 cookie → WS 打开。套件加一条不变式：`Set-Cookie` 里凡 `__Host-` 前缀必须 `Path=/`，防止 node 测试再掩盖前缀规则。
2. 持久化会话保留 principal 身份：落盘条目加 `principalId`（或不再覆盖 `id`），加载时校验结构（issuer/subject/groups/expiresAt 数值），principalId 在黑名单中的条目拒绝恢复。验收：重启后 Bob 旧 cookie 的 actor 仍是 `corp|bob`；构造崩溃窗口文件后 alice 旧 cookie 401；损坏 JSON 仍然抛错。同包内补两件存储卫生：两个 JSON 以 0600 写（`stateRoot` 目录 0700），删除 `revocations.json` 后重启必须在启动日志与审计里留痕（当前是静默空黑名单重新授权），并把该残余风险写回台账 RSK-002。
3. 多受众绑定：callback 在 `aud` 是数组且长度大于 1 时要求 `azp === clientId`，否则 401。单受众行为不变。
4. S0 记录收尾：在代码冻结时刷新 `dependency-and-scope.md` 的哈希表；`benchmark-baseline.md` 把表格明确标注「模拟测量，非真实跑批」，或在套件里接一个真实 runner 之后再留表。

不做 S2–S7，不把 docker 挂起写成通过，不把真实环境外部项写成已实现。
