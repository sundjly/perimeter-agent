# 受控测试执行器设计与实施报告 (Bounded Test Runner Implementation Report)

## 1. 目标与背景

依据 `docs/reviews/grok-s2-container-foundation-round-3.md` 的纠正节及 `docs/reviews/grok-bounded-test-runner-round-1.md` 的审查要求：
1. 彻底淘汰旧有的临时外部看护脚本与危险的 `pkill -P $$`，为项目建立**零第三方依赖、路径清晰、原生基于 Node.js 现代工具链的可复用安全测试执行器**（`scripts/bounded-test-runner.ts`）；
2. 针对 Grok 第一审发现的 `spawn ENOENT` 导致未处理 `error` 事件打崩调用者进程的缺陷，实施最小原子修复与全量边界测试；
3. 严格明确本执行器的安全边界与能力范围，杜绝过度承诺。

---

## 2. 核心架构与第一性原理安全设计

### 2.1 独立进程组与 Leader 身份保障
- 在 POSIX / macOS 下，`child_process.spawn(bin, args, { detached: true })` 底层调用 `setsid()`，使被测试子进程成为新会话首进程并创建新的独立进程组。
- 此时，子进程的 PID 与 PGID 严格相等：`childPgid === childPid`。

### 2.2 同步错误捕获与启动竞态防御 (Anti-Crash)
- **立即挂载 Error 监听**：在 `spawn` 返回后**同步第一行代码立即挂载 `child.on("error")` 监听器**，绝对早于任何 pid 检查、条件分支、throw 或 await 操作；
- **防 Unhandled Event 崩溃**：当系统调用由于二进制不存在（ENOENT）等原因失败时，Node.js 派发的 `error` 事件会被即时受控捕获并记录；
- **真实错误保留与受控转出**：若未能获取合法 `child.pid`（如命令不存在），执行器绝不发送任何 group signal，亦不虚报组验证或资源 0；以保留真实错误信息（包含 `err.code === "ENOENT"`）的受控 rejected Promise 返回；在 CLI 模式下输出清晰原因并以受控 `exit 1` 结束，无任何未捕获异常栈抛出。

### 2.3 严格进程组归属验证 (Fail-Closed)
在向受控进程组发送任何信号之前，执行器必须通过系统接口（`ps -o pgid= -p <pid>`）对捕获的 PGID 进行三项硬性安全校验：
1. **组长校验**：`childPgid === childPid`（子进程自身必须是独立进程组组长）；
2. **非 Runner 组校验**：`childPgid !== runnerPgid`（绝对不可与执行器自身处于同一组）；
3. **非父链组校验**：`parentPgid === null || childPgid !== parentPgid`（绝对不可与执行器的父进程处于同一组）。

> [!CAUTION]
> **Fail-Closed 铁律**：如果校验未通过或未能确认，执行器绝对禁止调用负 PID 广播（`-childPgid`），立即降级为单 PID 精确管理并记录安全告警，杜绝殃及父链或同机无关工作。

### 2.4 双重生命周期收割（TERM → Grace → KILL）
- **预设硬性 Deadline**：在子进程启动前即计算并设立单调定时器，杜绝执行途中修改或缺失超时限制；
- **两阶段信号递进**：
  1. 超时触发后，首先向目标进程组发送 `SIGTERM`，给予宽限期（默认 `graceMs: 1500ms`）；
  2. 宽限期结束后，检查组内残留 PID（`ps -o pid= -g <childPgid>`）。若仍有进程存活（如忽略了 `SIGTERM` 的子孙），立即向组发送 `SIGKILL`，并对残留的每个 PID 逐个发送 `SIGKILL` 兜底；
  3. 轮询等待直到所有进程彻底退出（`kill(pid, 0)` 确认）。
- **孤儿进程清理保证（Parent-Exit Survival）**：
  - 如果被测试命令的父进程先一步正常退出（例如 `process.exit(0)`），但衍生出的孙进程仍尝试在后台存活，执行器在子进程 `close` 后会再次扫描受控组内的残留 PID；
  - 发现残留孤儿时，立即启动清理收割，保证测试运行结束后不会遗留任何活子孙。

### 2.5 退出码与可观测性契约
- **正常完成**：子进程正常退出时，严格透传子进程的原生退出码（如 0 或断言失败时的非零值）；
- **超时退出**：强制退出码 `124`（与 GNU timeout 规范完全对齐），绝不谎报通过；
- **安全日志审计**：记录独一 `runId`、测试命令行 argv、deadline 毫秒、墙钟耗时、清理的 PID 列表；**严禁 dump `process.env` 或任何敏感凭据**。

---

## 3. 能力边界与限制声明 (Scope & Limitations)

> [!IMPORTANT]
> **本执行器的精确能力边界**：
> 1. **同组强隔离 + 组内零残留**：本工具的设计目标是针对测试执行过程中的超时保护与普通子进程树回收，确保遵循常规 POSIX 进程行为的测试子进程及其子代能够被精准终结；
> 2. **主动 setsid 逃逸不覆盖**：如果被测试代码或孙进程主动调用 `setsid()` 创建了全新的独立会话与进程组，由于其脱离了当前受控 PGID，将不在 `getGroupPids` 视野与本工具清理范围内；
> 3. **非通用安全沙箱声明**：本工具绝非通用的进程树强隔离沙箱，亦不提供文件系统、网络或特权隔离；项目真实的安全边界由 Docker（`DockerBackend`）或 Kubernetes Pod（`KubectlBackend`）强隔离后端提供，绝不虚称进程组看护具备防范恶意逃逸攻击的能力；
> 4. **精确受控清理**：清理范围严格限制在本次正面识别且校验通过的 owned 进程与 PGID，绝不扩散到未知 PID、父组、宿主机其他 agent 或用户工作负载。

---

## 4. 自动化测试验证矩阵 (`tests/bounded-runner.test.ts`)

为防止“未触发看护即声称安全”，编写了完整的 10 项正负向自动化测试套件：

| 测试项 | 场景描述 | 预期与实测结果 |
|---|---|---|
| **正向正常 0** | 执行 `process.exit(0)` | exitCode=0, timedOut=false, 进程组验证通过, 进程干净退出 |
| **正向非零** | 执行 `process.exit(42)` | exitCode=42, timedOut=false, 严格保留原退出码 |
| **负向短 deadline** | 设 timeoutMs=300ms 运行 hang 命令 | exitCode=124, timedOut=true, 真实触发超时并清理完毕 |
| **负向忽略 SIGTERM** | 子进程捕获并忽略 SIGTERM 挂起 | exitCode=124, 经短 grace 后被 SIGKILL 强制杀灭，无残留 |
| **负向 Parent 先退** | 父进程 spawn 孙进程后 exit 0 | exitCode=0, 孤儿孙进程被执行器自动识别并收割，组内 PID 归 0 |
| **负向独立 Sentinel** | 外部启动不相关的独立 sentinel 进程 | 执行器超时清理后，外部 sentinel 进程与父进程完好存活 |
| **安全校验 Fail-Closed** | 模拟与 runner 共享 PGID 的非独立子进程 | `validateProcessGroup` 判定 safe=false，拒绝负 PID 广播 |
| **CLI ENOENT 受控退出** | 独立子进程以 CLI 模式运行不存在命令 | 受控以 exitCode=1 退出，输出明确原因，无 Unhandled 'error' 崩溃栈 |
| **库模式 ENOENT 捕获** | 库调用模式下捕获 ENOENT 错误 | Promise 受控 reject 为真实 ENOENT，后续事件循环正常运转，sentinel 存活 |
| **并发快失败竞态** | 并发 5 路不存在命令启动 | 5 路全部受控 reject 为 ENOENT，无一泄漏，无未捕获异常 |

---

## 5. 全量回归测试与执行记录

使用该 bounded-test-runner 对全量测试套件进行了严格验证（全量总用例数包含 10 项 runner 专项测试，达到 **427** 项）：

| 运行模式 | 执行命令 | exitCode | 耗时 | tests | pass | fail | skipped | 资源残留 |
|---|---|---|---|---|---|---|---|---|
| **真串行全量** | `npm run test:serial`<br>(`--test-concurrency=1`, deadline 900s) | 0 (自然退出) | 62.2s | 427 | 427 | 0 | 0 | 0 owned 容器, 0 孤儿进程 |
| **默认并发全量** | `npm run test:bounded`<br>(默认并发, deadline 900s) | 0 (自然退出) | 17.7s | 427 | 427 | 0 | 0 | 0 owned 容器, 0 孤儿进程 |

### 5.1 核心观察与结论
1. **精确退出与自然终结**：两次全量运行均以 exitCode=0 正常自然退出，未触发超时硬杀，耗时远低于 900s 硬性上限；
2. **零泄漏保证**：
   - Docker 容器：`docker ps -aq --filter "label=perimeter.gateway"` 查询结果为空（0 容器）；
   - Node 进程：`pgrep -f "node --test"` 查询结果为空（0 孤儿进程）；
3. **消除临时脚本风险**：后续所有测试均可通过 `npm run test:serial` 或 `npm run test:bounded` 统一执行，彻底淘汰旧的临时脚本与 `pkill -P $$`，为后续 S2 四眼与企业化功能落地提供稳固的测试基础设施保障。
