# Grok Docker 清理专项第一审

- 结论：`request_changes`（限定两处：产品代码里的 OrbStack socket 硬编码、持久化测试的端口竞态 flake。cleanup 退出目标本身已达成，两项容器失败按约保留为 S2 partial）
- 日期：2026-10-14
- 审查者：grok（唯一 reviewer）
- 对象：`docs/implementation/docker-cleanup.md` 与 `src/gateway/session.ts` `8e57a07a5979ed25`、`src/gateway/execution-backend.ts` `4f10b56750ab7adf`、`tests/docker-backend.test.ts` `21c902775c5fa447`。
- 允许写入：本文件与 `docs/reviews/handoff-coverage.json`。未改实现、测试、SDK、docs 其它，未 commit / push。

## 命令与退出证据（每条外部 deadline）

| 命令 | 结果 |
|---|---|
| `node --test tests/docker-backend.test.ts` 第 1 次 | 28 tests，26 pass，2 fail，22s 自发退出，exit 1 |
| 同上第 2 次（串行） | 28 tests，26 pass，2 fail，22s 自发退出，exit 1 |
| `npm test` 全量 | 406 tests，403 pass，3 fail，约 24s 自发退出，exit 1。**不再挂死** |
| 除 docker 外 31 文件（第 1 次） | 378 tests，377 pass，1 fail：`s1-persistent-revocation` EADDRINUSE（端口预留竞态） |
| 同上（第 2 次，串行） | 378 pass，0 fail，exit 0 —— 证实该失败是 flake，不是回归 |
| `npm run typecheck` / `git diff --check` | 均 0 |
| owned 容器审计 | `label=perimeter.gateway` 过滤：solo 前后都是 0，无泄漏；未触碰用户既有 workloads/网络/镜像/context |
| 残留进程 | 清理了本审查前几轮 deadline kill 留下的 3 个旧 runner 孤儿（旧代码时代）；修复后各轮跑完 `pgrep node --test` 无残留 |

agy 报的 406=404+2 与我实测 403+3 不符：多出的第 3 败是上述 flake。两个口径都不是全量绿，符合「保留 2 个容器失败」的约定，但 flake 必须修。

## 根因核验（对 agy 报告第 1 条的纠正）

agy 说「顶层 `after()` 在 test 前注册导致 cleanups 数组为空」——不成立。node:test 支持顶层 `after()`，且回调读取的是模块级数组，push 对它可见；旧文件挂死时 after() 实际在跑。真实机制是：

1. 端到端用例在 40s `waitFor` 抛错，用例内后续清理被跳过；
2. `after()` 里的 `gateway.close()` 走进 `Session.#dispose()`，而 dispose 从不 `abort()` 宿主执行连接，`docker rm -f` 排在一条永不关闭的 stdio 流后面，且所有清理都没有 deadline → after() 永不返回；
3. mock 子进程管道与监听端口随之常驻。

agy 的第 2–5 条（异常跳过、管道泄漏、端口残留、无 deadline 的 dispose）与我的观察一致；修复（`#host.abort()` 先行、dispose 四步各 5s deadline、e2e 改 try/finally 逆序释放、40s 收窄为 8s、mock SIGTERM→SIGKILL 升级）针对的正是真实成因。修复没有用 `process.exit`、没有 unref 活跃句柄、没有用 race 伪造成功——race 只作 deadline 护栏，dispose 错误仍收集并抛出，容器由 `docker rm -f` 兜底。

## 行为核验

- 两个容器失败保持原断言未弱化：只读挂载仍要求 `Read-only file system`，端到端仍要求 `policy.denied` 且规则为 `ci-iac-secrets-off-limits`；只是 40s 等待收窄为 8s 快速失败。两项仍属 `s2-container-hardening` 的 S2 代码缺失，不是外部环境。
- 新增负测是真神谕：归属隔离负测起两个不同 `perimeter.gateway` 标签的 alpine 容器，断言 `reapOrphans` 只清自己的、别的还在，finally 精确 `rm -f` 自己的名字；cleanup 负测先断言容器存在、cleanup 后断言消失。`reapOrphans` 源码只按 `label=perimeter.gateway=<gatewayId>` 过滤，无全局 reap。
- 核心回归：除 docker 外 31 文件第 2 次 378 全过——auth/query/PKCE/撤权/approval/JWKS/真实 20slot/cache 前缀/Durable API 无回归。
- 会话层 `expirePending`/审批 `decide(…, isAuthorized)` 是前几轮已审改动，本轮 diff 无新增行为变化。

## 两处 request_changes

1. **产品代码硬编码本机 Docker socket**（`src/gateway/execution-backend.ts:12-13`）：模块导入时 `process.env.DOCKER_HOST = "unix:///Users/sundy/.orbstack/run/docker.sock"`。虽有 `!DOCKER_HOST && existsSync` 守卫，仍是产品运行时全局环境副作用 + 写死特定用户的机器路径，破坏可移植性。最小修复：从产品代码删除；测试需要时在测试文件内设置环境，或把它做成 `DockerBackend` 显式选项/本地配置。验收：grep 产品源码无用户路径；在无该 socket 的机器上 `npm run typecheck` 与非 docker 测试不受影响。
2. **`s1-persistent-revocation` 端口预留竞态**：先 `listen(0)` 拿空闲端口再 close、之后 Gateway 重绑，并行文件执行下被抢（实测 EADDRINUSE 一次，77–99ms 即败，另一轮全量同败）。最小修复：EADDRINUSE 重试（最多 N 次重新预留）或持有预留 socket 直到 Gateway 就绪。验收：串行与并行各跑全量 3 次无该失败。

另：报告与台账的口径要写「406 项中 403 过 3 败（含 1 次 EADDRINUSE flake）」，flaky 修复前不得写 404+2 稳定口径。

## S0

- `dependency-and-scope.md` 的 DockerBackend 行已改为与实测一致（OrbStack socket、daemon 29.8.2、镜像就绪、2 项失败归 S2 不归 external），哈希台账含本轮三个文件且与实测一致。
- 金额口径保持 mock 价格 $0.00；`benchmark-baseline.md` 仍声明无真实 runner —— `s0-benchmark-baseline` 保持 partial。
- 其余本地 code missing（S2 隔离两项、S3 锁、S4 预算）未写成 external。
