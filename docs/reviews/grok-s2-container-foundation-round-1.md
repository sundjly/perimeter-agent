# Grok S2 容器基础第一审

- 结论：`request_changes`（限定两项：生产网络守卫与 extraArgs 的六条绕过面、串行容器跑批的 daemon 停摆鲁棒性。两项历史红灯的修复本身为真，挂载面与正反 oracle 保持完整）
- 日期：2026-10-14
- 审查者：grok（唯一 reviewer）
- 对象：`docs/implementation/s2-container-foundation.md` 与 `src/gateway/server.ts`、`src/gateway/session.ts`、`src/gateway/execution-backend.ts`、`tests/docker-backend.test.ts` 的本轮改动。
- 允许写入：本文件与 `docs/reviews/handoff-coverage.json`。未改实现、测试、docs 其它、handoff、SDK，未 commit / push / spawn 额外进程。

## 命令与退出证据

| 命令 | 结果 |
|---|---|
| `node --test tests/docker-backend.test.ts` | 30 tests，30 pass，0 fail，15s 自发退出 exit 0。**两项历史红灯真绿**：策略扩展只读挂载断言通过；容器端到端出现 `policy.denied`（rule `ci-iac-secrets-off-limits`）、CI 文件未落盘、且新增 `allowed-marker.txt`="safe marker" 正向落盘对照 |
| 全量串行 `--test-concurrency=1` 第 1 次 | 413 tests，413 pass，0 fail，618s 自发退出 exit 0（企业 S1 全部在内，无回归） |
| 全量串行第 2 次 | **未完成**：≥18 分钟停在 `docker rm -f perimeter-…`，期间 `docker ps` 全局挂起 134s+，按 deadline 砍掉（chain kill）。串行第 3 次与默认并发 3 轮因此未执行，不计绿 |
| `docker ps -aq --filter label=perimeter.gateway` | 跑批前后均为 0，无 owned 泄漏 |
| `npm run typecheck` / `git diff --check` | 修复轮内一次通过（0/0）；daemon 停摆后未重跑 |

诊断到 15 分钟上限即停，未无界重跑。串行链是我自己发起、未预挂每轮外部 deadline——这是我的执行瑕疵，如实记录；SERIAL2 的停摆证据（log 尾部 `docker rm -f` 错误对象 + 全局 `docker ps` 挂起）独立成立。

## 生产守卫与容器不变量：成立的部分

- 缺 backend、`LocalBackend` 实例、**伪装 kind 的 LocalBackend 子类**（instanceof 兜住）、`allowLocal`、非法 kind、默认 bridge——全部 fail-closed，测试齐备且我复核了源码分支。
- 挂载面最小：workspace + HOME（条件）+ `src`/`config`/`node_modules` 三个 `:ro` 子树，无 docker.sock、无宿主根、无审计或他人 workspace。
- non-root、`--read-only`、`--cap-drop ALL`、`--security-opt no-new-privileges`、tmpfs `noexec,nosuid,nodev`、memory/cpus/pids-limit 默认值齐备。
- 归属：`containerName(sessionId, gatewayId)` + `label=perimeter.gateway=<gatewayId>` 精确 reap；归属隔离负测真实。
- 端到端 requestId 契约修复可接受：validator 未放宽，正反 oracle（safe marker 落盘 + 敏感路径拒绝且未落盘）都在。
- SigV4（`tests/modelgw.test.ts`、`tests/upstream-auth.test.ts`）与 XSS（`tests/web-injection.test.ts` 11 项）确在 413 口径内，未虚报。

## 六条绕过面（独立 argv 装配探针实证，未触碰 daemon 外资源）

1. **生产可配 `network: "host"`**：守卫只拒 `bridge`；`new DockerBackend({ network: "host" })` 的 `network` getter 返回 `"host"`，通过生产守卫——host 网络容器可进生产。
2. **网络名不验证**：`internal` 等任意名字按字符串放行，无 `docker network inspect Internal=true` 核验、无启动探针；同名非 internal 网络会静默带出网能力。实际「默认拒出口」能力缺失时 prod 未 fail-closed。
3. **extraArgs 后置覆写**：hardening 旗标拼在 `extraArgs` 之前，docker last-wins——`--read-only=false`、`--security-opt no-new-privileges=false`、`--network bridge` 三者均通过校验且在 argv 中位于硬ening之后，实测 `--read-only=false` 落在 `--read-only` 后面。
4. **`--mount` 完全未校验**：`--mount type=bind,src=/var/run/docker.sock,dst=…` 原样进 argv（`-v/--volume` 形式有查，`--mount` 没有）。
5. **构造后 mutation 绕过**：`get options()` 返回活引用，构造后改 `options.extraArgs = ["--privileged"]` 再 launch，`--privileged` 进入 argv。
6. **session.ts 域名边界**：`baseUrl.includes("://host.docker.internal")` 的字符串替换会把 `http://host.docker.internal.evil.com` 改写成 `http://127.0.0.1.evil.com` 并把模型代理 token 发往该域——必须改为解析 URL 后精确比较 `hostname === "host.docker.internal"`。

上述 1–3 属生产守卫的可达绕过（wiring/opts 为操作方配置，但守卫的意义正是约束配置）；4–6 为边界与生命周期缺陷。

## S2 其余范围（按事实，不因本包升格）

四眼/DLP/repo-token、bash-python-symlink 保护、本地 egress allowlist 的容器化落实仍 missing/partial；真实 CNI egress、客户批准 external。两项容器失败已真绿，但 S2 整体不因此批准。S3/S4 按台账不受 cluster 阻塞。

## 给 agy 的下一最小包

1. 生产网络守卫升级：`network: "host"` 与 extraArgs 内 `--network/--net bridge|host` 一律拒绝；接受 `internal` 前必须 `docker network inspect` 核验 `Internal=true`（或启动时对 owned 容器做一次受控出口探针），否则 fail-closed；`none` 始终可接受。
2. extraArgs 硬化补洞：校验并拒绝 `--mount`、`-u 0/-u=0`、`--read-only=false`、`no-new-privileges=false`、`--network bridge`；装配顺序把 hardening 放在 extraArgs **之后**或对冲突旗标去重；`DockerBackend` 构造时冻结 `extraArgs`（拷贝），`get options()` 返回冻结副本。
3. session.ts 模型地址映射改为 `new URL()` 后精确 `hostname === "host.docker.internal"` 判断，只改 hostname，不改其它部分；补一条后缀域名（`host.docker.internal.evil.com`）不得改写、凭证不得外发的负测。
4. 串行容器跑批鲁棒性：为每轮全量补外部 deadline；调查并处理 back-to-back 容器 e2e 下 daemon 停摆（`docker rm -f`/`docker ps` 挂起），至少做到单调用超时后快速失败并留下可诊断输出。验收：串行 3 + 默认 3 全部自发退出且 404+2 口径稳定，才可重审。
