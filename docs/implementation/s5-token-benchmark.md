# S5d: Token 基准本地可验证部分实现报告（S5 Token Benchmark）

## 1. 范围与原则

依据 handoff §4.4，为 S5 冷启动 / 热复用 / 重启恢复基准提供**诚实、可复用**的补充报告与本地入口。

核心约束：

- **不另造管道**：完整复用既有 `runBenchmark` 真实测量管道（Gateway → Session → HarnessHost (Durable SQLite) → LocalBackend → ModelGateway → LocalBenchmarkMockServer），不做任何 S0 skeleton 复活或模拟造数；
- **纯转换层**：`src/evals/s5-token-benchmark.ts` 是对 `ActualBenchmarkReport` 的纯函数聚合（无 I/O、无副作用、不修改输入），不改动任何既有 S0 公开类型与断言；
- **固定任务集**：30 个固定 fixture 任务与 SHA-256 `fixtureHash` 原样沿用，报告以 `suiteVersion` + `suiteHash`（对排序后 `id:fixtureHash` 取 SHA-256）绑定；
- **默认每任务 3 次**：CLI 默认 `--repetitions 3`、三种模式全量；
- **不收集 prompt/env/secret**：仅聚合 taskId、mode、时长、TTFT、token 计数、usageSource 等元数据，报告内含显式 privacy 声明。

## 2. 交付物

| 文件 | 说明 |
|---|---|
| `src/evals/s5-token-benchmark.ts` | 纯转换层：`buildS5Report()` / `computeSuiteHash()` / `percentile()`，含全部 S5 报告类型 |
| `scripts/s5-token-benchmark.ts` | 本地入口：跑批模式（复用 runBenchmark）与 `--from-report` 转换模式 |
| `tests/s5-token-benchmark.test.ts` | 统计守卫测试（纯单元，合成报告，不跑真实管道） |
| 本文档 | 设计、字段来源映射、限制与残余 |

未改动：`benchmark-runner.ts` / `benchmark-pipeline.ts` / `benchmark-fixtures.ts` / `gateway-process.ts` / 既有测试与全部 gateway/protocol/web/attach/tools-bounded 文件。

## 3. 字段来源映射（诚实性）

| S5 字段 | 来源 | 无法取得时 |
|---|---|---|
| 按 mode TTFT p50/p95 | 测量条目 `ttftMs` 非空值，线性插值分位数 | 无非空值 → `null`（不报 0） |
| 任务时长统计 | `durationMs`，p50/p95/min/max/avg | 模式无测量 → 各项 `null`（未知，不写成 0） |
| passRate（mode/overall） | `success` 占比 | 模式无测量 → `null` |
| input/output token | `inputTokens` / `outputTokens` 非空求和 + `withUsageCount` + `usageSourceBreakdown` | 全缺失 → `null` |
| cachedTokens / cacheHitRate | 保持 `null` / unknown（见 §4.1） | — |
| 调用数 modelCallCount | 无法从现有链路取得 → `null` | `fieldProvenance` 注明：管道仅有 eventsCount（WS 客户端事件总数），未隔离模型请求数 |
| 重试数 retryCount | 无法取得 → `null` | 注明：ClientEvent 流与落库无逐请求重试事件 |
| 压缩 token compactionTokens | 无法取得 → `null` | 注明：链路无 compaction 计量点，mock 会话为单轮工具调用 |
| 失败任务消耗 | `success=false` 条目单独求和（仅非 null 计入）+ `failedWithUsageCount` | 与成功任务分组互斥，不摊入均值 |
| 真实模型成本 | `external_blocked`（沿用 S4 结论，mock 单价 $0.00） | `valueDollars: null` |
| 20% 成本门槛 / 质量(完成率≤2pp) / 首token p95≤10%门槛 | `not_measured` / `external_blocked`，`baseline` 与 `current` 恒为 `null`，报告**不含任何达成标记字段** | — |
| repo revision | 协调者经 `--revision` 传入 | 未传入 → `null`，不假设 HEAD |
| mock / 后端限制声明 | `mockDeclaration`（local-mock，$0.00）、`backendLimitations`（本基准仅覆盖 LocalBackend 路径、RSS 仅 runner 进程、mock 模型、真实 A/B 子进程 recovery、recovery durationMs 派生口径见 §4.2） | — |

## 4. 已知限制（显式声明于报告内）

### 4.1 cacheRead=0 与缺字段不可区分

现有管道在事件解析处将缺失字段与 0 归并（`benchmark-pipeline.ts`：`latestUsage = { ..., cacheRead: e.usage.cacheRead ?? 0 }`），落库后 `cachedTokens` 仅在 `>0` 时非 `null`。因此 **cacheRead=0（显式报 0）与缺字段在现有测量产物中不可靠区分**，S5 报告保持 `cacheReadStatus: "unknown"` 并原文说明该限制；不虚构缓存命中，不计算 `cacheHitRate`。

### 4.2 其他

- **recovery durationMs 为派生口径，非真实任务墙钟**：沿用 S0 管道定义 = `recoveryTimeToOperableMs + 200`（恢复就绪耗时不可用时为常量 `250`）。三模式 durationMs 以同形态 p50/p95/min/max/avg 并列，但 recovery 携带未观测的 +200ms 偏移，**跨模式时长对比无效**；recovery 的 TTFT 与恢复就绪耗时（recoveryTimeToOperableMs）为重启后真实单调钟观测。该口径已写入 `backendLimitations` 披露；
- TTFT 与 cold/warm 时长分位数来自本地 mock 管道观测值，非与真实基线的回归对比；
- 小样本标记：非空 TTFT 样本 `< SMALL_SAMPLE_MIN_RUNS (90)` 时标记 `smallSample: true`；90 = 固定 30 任务 × 3 次重复（§4.4 每模式期望总量），deadline 截断或子集跑批不足 90 即标记，不与全量跑批横向比较；
- Peak RSS 主体为 runner 进程自身（沿用 S0 口径）。

## 5. 使用方法

```sh
# 跑批 + 生成 S5 报告（默认 30 任务 × 3 模式 × 3 次，约 2~15 分钟）
node scripts/s5-token-benchmark.ts --revision <repo-sha>

# 指定输出路径 / 子集（快速验证用）
node scripts/s5-token-benchmark.ts --revision <sha> --tasks task-01-range-off-by-one --modes cold --repetitions 1 --output docs/s5/s5-sample.json

# 仅转换既有 S0 报告 JSON（不跑批，秒级；非法输入不写任何产物）
node scripts/s5-token-benchmark.ts --from-report docs/s0/actual-local-mock-benchmark.json --revision <sha>
```

转换模式经 `validateS0Report()` 做最小运行时验证后才落盘，防止任意 JSON 被 cast 成报告伪装 local-mock：
顶层必须声明 `source: "local-mock-pipeline"`、含 LocalBackend 的真实框架、`costDeclaration.environment: "local-mock"`；
`fixtureHashes` 必须与当前 `BENCHMARK_FIXTURE_TASKS` 的 30 个 task ID 集合逐一对应且逐个 64 位 SHA-256；
`executionMeta` 与 `summary` 中转换读取的数字字段（totalRuns/repetitions/deadlineMs/actualElapsedMs/timedOut、
totalTasks/totalMeasurements/overallPassRate/avgDurationMs/peakRssBytes/totalInputTokens/totalOutputTokens 及三个模式子对象）
必须为有限非负数/boolean/对象；每条 measurement 校验合法 mode/usageSource、taskId ∈ fixtureHashes、
数值字段有限非负或 null、`realCostDollars === null` 且 mock 单价为 0。
非法输入在验证处抛错（带字段路径），不写任何产物。

跑批模式参数经 `validateS5RunSelection()` 边界校验后才启动 benchmark：`--repetitions` 必须为有限正整数、
`--deadline-ms` 必须为有限正数（0/负/NaN/Infinity 拒绝，防止 deadline 保护被静默解除）；`--tasks`/`--modes`
空或含未知值直接拒绝。非法参数不启动跑批、不写任何产物。

跑批模式同时落盘 S0 基础报告（默认 `docs/s5/s5-base-report.json`）与 S5 报告（默认 `docs/s5/s5-token-benchmark.json`），两者均为机器可核验 JSON。

## 6. 测试守卫（tests/s5-token-benchmark.test.ts）

1. 分位数：空集 `null` 缺省、线性插值正确（p50=25 / p95=38.5 样例）、无需预排序；
2. null 分位数：TTFT 全缺失时 p50/p95 为 null，token 求和同步 null，调用/重试/压缩字段 null；
3. 时长统计与 TTFT 分位数聚合正确；
4. 失败任务消耗单独统计（仅非 null 计入，与成功分组互斥）；
5. 优化门槛恒为 `not_measured` / `external_blocked`，`baseline`/`current` 为 null，序列化结果不含任何 `met` 达成标记；
6. 小样本标记与空模式诚实降级（阈值 90=30 任务×3 次；空模式 duration 各项与 passRate 均 null，不写成 0）；
7. Provenance：`buildS5Report` 纯性（不修改输入）、suiteHash 绑定真实 30 任务 fixture hash、revision 透传/缺省 null、隐私声明（源元数据白名单口径）、backendLimitations 不声称未实现、cacheRead unknown；
8. 转换入口验证负控：合法报告原样返回；source/framework/costDeclaration/非空 timestamp/30 任务 hash 数量与 64 位格式/task ID 集合与当前 fixtures 一致（改名拒）/executionMeta 与 summary 数字字段有限非负、timedOut 布尔/measurements/summary 子对象/逐条 mode/usageSource/taskId/负数与非法数值/realCostDollars/mock 单价非法时一律抛错且带字段路径；`ttftMs=null` 合法缺省不误拒；
9. CLI 跑批参数负控：`--repetitions` 0/负/NaN/非整数/Infinity 与 `--deadline-ms` 0/负/NaN/Infinity 拒绝；`--tasks`/`--modes` 空或未知值拒绝；合法子集正确解析透传（非法参数不进入跑批、不写产物）。

## 7. 残余与边界

- 调用数/重试数/压缩 token 若未来在链路（Session/ModelGateway）暴露事件，可在 `fieldProvenance` 对应项升级为实测；本次不改 gateway/protocol（S5c 已验收提交）；
- `cacheRead=0` 与缺字段的区分需在 `benchmark-pipeline.ts` 事件解析处保留原始字段存在性，属既有管道改动，本次明确不做；
- 真实成本、20% 门槛、质量与 p95 门槛等待真实模型通道（S4 external_blocked 解除）与真实配对基线后方可实测；
- CLI 跑批模式受既有全局 deadline（默认 900s）保护；转换模式无外部依赖。

## 8. 协调者最终验收

实现/测试本地提交 `89cacec`（3 文件）；Grok round-2 `approve`，范围仅本地 mock 统计层（`docs/reviews/grok-s5d-token-benchmark-round-2.md`）。9/9 单测、全仓 typecheck exit 0、12/12 非法 CLI 参数拒绝且无 S0/S5 产物。原始固定 30×3×3 共 270/270、129.01s；测量源 revision `c66c785`，runner/pipeline/fixtures 与最终工作区逐字节一致；最终报告从原始报告重新转换，无重跑或改写原始测量。

原始/最终报告为 `docs/s5/s5-base-report.json` 与 `docs/s5/s5-token-benchmark.json`；`docs/s5/evidence/metadata.json` 记录最终源码哈希、管道哈希及测量/转换来源。详细决策、recovery 派生口径与 runner residue=unknown 等限制见 `docs/implementation/s5d-s6-coordinator-validation.md`。所有真实成本与优化门槛仍未测得达成。

