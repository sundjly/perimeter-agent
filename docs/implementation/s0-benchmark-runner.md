# S0: 真实本地执行基准评测管道实现报告 (Real Local Mock Runner)

## 1. 任务背景与核心原则

依据 `docs/handoff.md` §4.4 / §7 以及 Grok 审查意见，原 `src/evals/benchmark-skeleton.ts` 仅提供了任务清单与模拟随机数据（Synthetic Simulation），缺少真实的 runner 管道。
本专项将固定版本的 30 个基准任务完整接入本地真实执行管道，彻底消除空转与模拟造数：

- **明确本地 Mock 定位**：当前运行于本地环境与 Mock 模型端点，明确非企业生产上线；
- **执行环境校准**：执行后端为 `LocalBackend`（宿主机子进程），明确标注非强隔离（企业级容器强隔离属于 S2 待实现项）；
- **价格与成本真实声明**：模型价格恒定配置为 **$0.00**（Prompt: $0.00, Completion: $0.00, Cache: $0.00）。真实商业成本严格标记为 `null / unknown`，真实商业通道接入与 DPA 对账属于 S4 阶段的 `external_blocked`，绝不虚构真实商业省钱收益或 SLA；
- **真实完整管道**：每次执行均实际经由真实 `Gateway` -> `Session` -> `HarnessHost` (Durable SQLite) -> `LocalBackend` -> `ModelGateway` -> `LocalBenchmarkMockServer`。模型真实发起 tool call（调用 bash 工具修改代码），由 Harness 在宿主子进程中真实执行落盘，最后通过子进程内真实的 `node --test` 验收产物退出码，绝不跳过 harness 预写答案，也绝不使用随机数模拟。

---

## 2. 任务集规格与 Fixture Provenance

- **套件版本**: `S0-v1.1.0-actual-mock`
- **任务定义与覆盖**: 严格遵循 R7 规范的 4 类任务，共计 30 项（bug-fix: 14 项, test-coverage: 7 项, dependency-upgrade: 1 项, refactor: 8 项）；
- **可重现 Fixtures**: 每个任务具备确立的代码文件（package.json、主源码、测试源码）、`failsAtStart` 预检命令（初始必须真实红灯失败）、mock 修复脚本与 negative 脚本；
- **不可篡改 Provenance**: 每个任务依据 prompt、初始代码、验收命令计算确定的 SHA-256 `fixtureHash`，记录于 `src/evals/benchmark-fixtures.ts` 与报告 JSON 中。

---

## 3. 三种模式真实性实现与 Grok R1 修复

依照 handoff §4.4 规范与 Grok 第一审验收意见，runner 支持三种真实测量模式并完成关键语义缺陷修复：

### 3.1 冷启动模式 (Cold Run)
- **环境隔离**: 每次测量创建全新隔离的 `stateRoot` 与 `workspace`；
- **预检校验**: 释放初始 fixture 后，优先执行 `failsAtStart` 命令，断言在 agent 运行前必须真实失败，杜绝起点虚假绿灯；
- **实测指标**:
  - `durationMs`: 单调时钟（`performance.now()`）实测全程耗时；
  - `ttftMs`: 实测从 prompt 发出到接收到首个 assistant 文本/tool chunk 的单调时钟耗时；
  - `memoryMetric`: 明确记录测量主体为 `runner_process`（PID 与 RSS），杜绝冒充子进程内存；
  - `usage`: 动态提取真实 mock 模型通过 SSE 上报的累计 usage，标明 `usageSource: "mock-reported"`（若上游缺失则标明 `unknown / missing-source`，数值为 null）。

### 3.2 热复用模式 (Warm Run)
- **删除硬编码合成常量**: 彻底废除旧版中写死的 `80/40/25` 常量，完全通过真实事件动态解析；
- **实测指标**: 记录复用上下文下的 `durationMs`、`ttftMs`；若 mock 端点未报告缓存命中（`cacheRead`），则 `cachedTokens` 诚实为 `null`，绝不虚假冒充真 provider cache 收益。

### 3.3 真实重启恢复模式 (Recovery Run)
- **真独立 OS 子进程 A/B 退出与重启**:
  1. 通过 `src/evals/gateway-process.ts` 真实 `spawn` 独立操作系统子进程 A（记录 `PID_A`）；
  2. 实例 A 执行初始 prompt 并将会话状态与 transcript 写入 `stateRoot`（SQLite `session.sqlite`）；
  3. 在工作区中写入未提交标记产物 `uncommitted-artifact.txt`；
  4. 通过标准 IPC/stdin 发送 `close` 指令，子进程 A 执行 `gateway.close()` 释放 handle 自然退出，等待 OS exit 事件确认终止（记录 `exitCode: 0`）；
  5. 记录单调时钟开始重启恢复，在**同一个 stateRoot 和同一个 workspace** 下 `spawn` 独立操作系统子进程 B（断言 `PID_B !== PID_A`）；
  6. 重新连接相同 `sessionId`，测量从启动到 `session.ready` 的真实恢复就绪耗时（`recoveryTimeToOperableMs`）；
  7. **逐字节连续性断言**: 验证原会话历史连续恢复，逐字节比对工作区未提交产物完全一致；
  8. 发送第二轮 prompt 完成修复并验收，优雅关闭子进程 B。

### 3.4 资源所有权清理原则
- 仅清理本次运行正面识别的 owned runRoot exact path，不执行通配符扫盘；
- 对历史上未确认归属的 22 个 `perimeter-*` 目录予以保留并登记为未确认遗留，绝不误删用户数据。

---

## 4. 270 次全量跑批实测数据汇总

执行命令：
```sh
node src/evals/benchmark-runner.ts --repetitions 3 --output docs/s0/actual-local-mock-benchmark.json
```
实测统计数据如下（30 任务 × 3 模式 × 3 次重复 = 270 次测量）：

| 测量模式 (Mode) | 测量次数 | 实测通过率 (Pass Rate) | 平均耗时 (Avg Duration) | 平均 TTFT | 模式专属指标 | 计费金额 (Mock Configured) | 真实商业成本 (Real Commercial Cost) |
|---|---|---|---|---|---|---|---|
| **冷启动 (Cold)** | 90 | **100.0%** (90/90) | **233 ms** | 36 ms | 起点 failsAtStart 100% 真实红灯 | **$0.00** | null (未知 / external_blocked) |
| **热复用 (Warm)** | 90 | **100.0%** (90/90) | **232 ms** | 35 ms | 真实事件动态提取（mock 未报告缓存时显式为 null） | **$0.00** | null (未知 / external_blocked) |
| **重启恢复 (Recovery)** | 90 | **100.0%** (90/90) | **464 ms** | 299 ms | **真实独立 OS 子进程 A/B 重启**（PID_A != PID_B，A 确认退出）<br>**平均恢复就绪耗时: 264 ms**<br>未提交产物连续性: 100% | **$0.00** | null (未知 / external_blocked) |
| **全量汇总 (Total)** | **270** | **100.0%** (270/270) | **309 ms** | 123 ms | **外部总耗时: 134.28s** (上限 900s) | **$0.00** | null (未知 / external_blocked) |

- **峰值内存 (Peak RSS)**: 252.1 MB（测量主体: runner 运行进程，PID: 88126）
- **全局 Deadline 约束**: 固定 15 分钟（900s），实际耗时 134.28s（安全裕度 >85%）
- **机器可核验 JSON**: 写入 [`docs/s0/actual-local-mock-benchmark.json`](file:///Users/sundy/projects/web-articles/perimeter-agent/docs/s0/actual-local-mock-benchmark.json)，包含每条测量的详细单调时钟数据与 provenance。

---

## 5. 自动化测试套件守卫

新增与扩充测试 [`tests/benchmark-runner.test.ts`](file:///Users/sundy/projects/web-articles/perimeter-agent/tests/benchmark-runner.test.ts)：
1. **Provenance 与规格校验**: 30 个任务完整性断言与 64 位 SHA-256 fixtureHash 校验；
2. **Negative 失败真实性验证**: 验证 negative 模式下 mock 执行错误代码时，验证器真实判定 `success = false`，证明并非恒绿；
3. **三种模式真实性与 PID/连续性断言**: 校验真实独立 OS 子进程 A/B 的 PID 互异性、A 实例真实 exitCode 0、未提交产物逐字节连续性；
4. **动态 Usage 事件解析与缺失来源 unknown/null 降级自证**: 验证自定义 usage 累加值、缺失 usage 时的显式 unknown/null 降级，杜绝硬编码；
5. **期限保护与子进程环境隔离**: 验证 deadline 超时机制与 `cleanTestEnv()` 隔离，确保顶层 runner 独立稳定。
