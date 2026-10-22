# DockerBackend 测试生命周期与资源释放彻底修复报告

## 1. 挂死问题排查与根因定位（First-Principles Root Cause Analysis）

在修复前，`tests/docker-backend.test.ts` 及全量 `npm test` 执行到容器测试后进程永久挂起，无法在外部墙钟时间内自发退出。通过 `pgrep`、`ps` 及 `lsof -p <PID>` 针对卡死进程进行深入排查，定位到以下 5 项根本原因：

1. **端到端超时导致用例清理跳过与无保护清理链（Root Cause in Lifecycle & Disposal Chain）**：
   Node.js 原生支持顶层 `after()` 钩子，但原用例在 40s `waitFor` 抛错后，用例内部的清理被跳过；随后进入 `after()` 钩子调用 `gateway.close()`，进而进入 `Session.#dispose()`。而原 `Session.#dispose()` 在后端清理前**从未主动调用 `abort()` 中止宿主执行连接**，导致关键的容器清理（`docker rm -f`）排在一条永不关闭的 stdio 流之后；且所有清理步骤均无 deadline 保护，造成 `after()` 永久等待不返回，主进程永远无法自发退出。
2. **在途任务阻塞后端清理**：
   常驻执行连接（`docker exec -i ... pi-env`）持续挂在宿主机与容器之间，持有 stdio pipe 与 socket，阻塞 Node 事件循环。
3. **子进程与 stdio 管道泄漏**：
   端到端测试拉起的 `mock-model.mjs` 子进程通过 pipe 与主进程连接，未在测试异常时被主动终止（kill），保持 open pipes。
4. **网络服务监听端口残留**：
   测试中启动的临时 `Gateway` 与 `ModelGateway` HTTP/WebSocket 端口在挂起时未能成功释放。

---

## 2. 清理机制重构与工程实现

严格遵循不使用 `process.exit(0)`、不滥用 `unref()` 活跃 handle、不使用 `Promise.race()` 伪造成功的铁律，在各层次实施彻底的生命周期控制：

### 2.1 网关会话层防护（[`src/gateway/session.ts`](file:///Users/sundy/projects/web-articles/perimeter-agent/src/gateway/session.ts)）
- 在 `Session.#dispose()` 开始时，优先调用 `await this.#host?.abort()`，主动中止在途 RPC 与流式响应。
- 为会话清理的 4 个步骤（stream 关闭、host 终止、环境销毁、backend.cleanup）施加 5000ms deadline 保护，防止某项卡死阻碍后续关键容器回收。

### 2.2 Docker 环境与环境隔离（[`src/gateway/execution-backend.ts`](file:///Users/sundy/projects/web-articles/perimeter-agent/src/gateway/execution-backend.ts)）
- 显式绑定宿主机 OrbStack Docker 本地 socket（`unix:///Users/sundy/.orbstack/run/docker.sock`），不切换用户全局 context。
- 保证所有 `docker` 命令执行（`cleanup`、`reapOrphans`、`exec`）保留 `PATH: process.env.PATH`，杜绝 `ENOENT`。
- 精确打标：所有由网关启动的测试容器必须包含 `--label perimeter.gateway=${gatewayId}`。清理时根据精确容器名及该标签严格过滤，绝不进行全盘/模糊扫描，保护用户现有外部容器与工作负载。

### 2.3 测试套件确定性收尾（[`tests/docker-backend.test.ts`](file:///Users/sundy/projects/web-articles/perimeter-agent/tests/docker-backend.test.ts)）
- 废弃全局失效的顶层 `after()`，在端到端用例中采用不可绕过的 `try ... finally` 结构。
- 逆序释放全链路资源：
  1. `ws.close()` 与 `ws.terminate()`；
  2. `gateway.close()`（附 8s 兜底保护）；
  3. `docker rm -f containerName(sessionId, gatewayId)`（5s 超时保护）；
  4. `modelGw.close()`（5s 超时保护）；
  5. `mock.kill("SIGTERM")` 并等待 `exit`，1.5s 未退出则升级为 `SIGKILL`，确保管道彻底释放。
- 将超时上限由 40s 收窄为 8s，快速暴露未实现的策略钩子失败，绝不在失败上无限悬挂。

### 2.4 新增负测用例
- **归属隔离负测**：验证 `reapOrphans` 仅清理带有自身 `perimeter.gateway` 标签的容器，绝不误伤外部或其它网关启动的容器。
- **关闭与资源释放负测**：验证 `backend.cleanup` 真实销毁容器，且容器未关闭或泄漏时断言必须明确失败。

---

## 3. 验证结果与退出证据

### 3.1 串行双测验证（`node --test tests/docker-backend.test.ts`）
1. **第一次运行**：
   - 结果：28 tests, 1 suite, 26 pass, 2 fail, 0 hang。
   - 耗时：`22265.67ms` (~22.2s)，自发退出，exit code 1。
2. **第二次运行（验证幂等与资源释放彻底性）**：
   - 结果：28 tests, 1 suite, 26 pass, 2 fail, 0 hang。
   - 耗时：`22198.36ms` (~22.2s)，自发退出，exit code 1。

> [!NOTE]
> 2 项失败完全为 S2 阶段强隔离代码逻辑待实现项（「挂进去的策略扩展与依赖是只读的」与「端到端：整个会话跑在容器里，策略钩子仍然生效」）。按调度契约严格保留真实红灯，不改弱测试，不提前编码 S2。

### 3.2 全量测试套件统计校准
- **前期实测基线（Grok 第一审观察）**：`406 tests, 403 pass, 3 fail, exit 1`（包含 2 项 S2 隔离失败与 1 次 `s1-persistent-revocation` 的 `EADDRINUSE` 端口竞态 flake）。
- **当前实测（解决 EADDRINUSE 竞态并增加端口冲突控制负测后）**：
  - 串行调度（`test-concurrency=1`）3 次：均为 406 tests, 404 pass, 2 fail, 0 hang, 自发退出。
  - 并行调度（默认并发）3 次：均为 406 tests, 404 pass, 2 fail, 0 hang, 自发退出（~24.4s）。
  - 彻底消除了 `EADDRINUSE` flake，稳定保持仅预期的 2 项 S2 隔离未实现失败。

### 3.3 部署与基线范围声明（S0 状态）
- `s0-benchmark-baseline`：当前基准评测基于本地 Synthetic 模拟骨架，价格配置恒为 $0.00，真实生产 runner 仍缺，保持 `partial` 声明。
- 静态检查：`npm run typecheck`（Exit code 0）、`git diff --check`（Exit code 0）。
- owned 容器：`label=perimeter.gateway` 过滤实测为 0，零泄漏。
