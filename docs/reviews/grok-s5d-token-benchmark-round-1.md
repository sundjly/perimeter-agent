# S5d round-1：S5 token 基准补充报告层（HEAD c66c785，4 新文件）

**结论：request_changes（1 项必需；纯披露性修复，不改逻辑、无需重测）**。

前言：本报告由 Orca 派发的评审终端产出，该终端仅向协调者报告任务完成（worker_done），评审结论以本文件为准。本轮评审只读：未运行 shell/test/git/网络，全部结论基于原生文件读取与协调者提供的执行证据。工作区内新增的 S6 相关文件不在本轮范围，未审。

## 范围与证据

范围 4 文件：`src/evals/s5-token-benchmark.ts`、`scripts/s5-token-benchmark.ts`、`tests/s5-token-benchmark.test.ts`、`docs/implementation/s5-token-benchmark.md`。交叉读：`src/evals/benchmark-runner.ts`、`benchmark-pipeline.ts`、`benchmark-fixtures.ts`（30 任务确认、fixtureHash=sha256(id+prompt+sorted files+verify+failsAtStart)）、`docs/handoff.md` §4.4。

| 证据 | 路径 | 要点 |
|---|---|---|
| 真实跑批 | `/tmp/perimeter-s5d-measure-0fFHKcC3/evidence/run.log` | bounded runner，`--revision c66c785bc71d…`，270/270 零失败零 WARN（:279），129.01s/540s，natural 完成（:283-292），S5 摘要（:294-306） |
| S0 基线报告 | `…/evidence/base-report.json` | totalRuns 270 / repetitions 3 / timedOut false（:41-47）；30 条 fixtureHashes（:6-39）；measurement 样本 `cachedTokens:null`、`usageSource:"mock-reported"`、`realCostDollars:null`（:100-121） |
| S5 最终报告 | `…/evidence/s5-report-final.json` | suiteHash `c704f6c3b8e6…`（:7）；recovery durationMs（:172-177）；门槛与 fieldProvenance（:213-255） |
| 最终复转换 | `/tmp/perimeter-s5d-final-convert.log` | 同一 base 报告重转换成功，suiteHash 与跑批内转换一致（:6） |
| 单元测试 | `/tmp/perimeter-s5d-unit-v4.tap` | 8/8 pass（:50-57） |
| 非法 CLI 输入 | `/tmp/perimeter-s5d-invalid.log` | `$.suiteProvenance: 缺失` 带字段路径抛错、exit 1、无 `/tmp/perimeter-s5d-invalid-output.json`（协调者核对无产物） |
| typecheck | `/tmp/perimeter-s5d-s6-typecheck-v4.log` | 空文件：与 `tsc --noEmit` 成功一致但无 exit code 证据，且早于最后修复（见 N6） |

## 逐项核验（按任务清单）

1. **纯转换 + 固定 30 任务 + 默认 3 重复**：`buildS5Report`（s5-token-benchmark.ts:441）零 I/O、零输入改写，test 7 以序列化前后全等断言纯性；模式 A 复用既有 `runBenchmark`（scripts/s5-token-benchmark.ts:98-106），未另造管道；`validateS0Report` 将 fixture ID 集合逐一钉死到当前 `BENCHMARK_FIXTURE_TASKS`（:396-406，改名后数量仍 30 也拒，test 8 负控）；CLI repetitions 默认 3（scripts:100）。
2. **cachedTokens「0 与缺失合并」→ unknown**：归并点属实——`cacheRead: e.usage.cacheRead ?? 0`（benchmark-pipeline.ts:419/539/696），落库 `cachedTokens` 仅 >0 非 null（:477/597/756）；S5 侧恒 `cachedTokens:null` + `cacheReadStatus:"unknown"`（:236-237）并原文说明（:22-24），不虚构 cacheHitRate。final 产物三模式一致。
3. **调用/重试/压缩缺计量 → null**：`modelCallCount/retryCount/compactionTokens` 恒 null（:245-247），fieldProvenance 注记具体且与管道事实相符（eventsCount 仅为 WS 客户端事件总数；无逐请求重试事件；无 compaction 计量点，:308-322）。
4. **门槛绝不报达成**：`buildGates`（:272-302）全部 `not_measured`/`external_blocked`，baseline/current 恒 null；类型无 met 字段，test 5 以「序列化不含 `"met"`」守护；忠实转写 §4.4「拟定目标，当前没有实测达成」。
5. **空模式统计 null**：`percentile` 空集 null（:169）、`durationStats` 空数组全 null（:191-192）、passRate 空为 null（:226）、`sumOrNull` 全缺失时 null；test 6 空模式五连 null 断言，「未知不写成 0」贯彻一致。
6. **失败消耗独立汇总**：`buildFailedConsumption`（:253-270）按 success 互斥分组、仅非 null 计入；test 4 另断言 mode 内 pass/fail 计数一致；final 产物 failedCount=0 时 failed 求和为 null（不写 0）。
7. **Provenance 不可虚构**：repoRevision 仅透传 `--revision`，缺省 null 并注明不假设 HEAD（:451-452，test 7 断言）；suiteVersion/suiteHash 透传+现算（:206-214），两次独立进程转换同值 `c704f6c3b8e6…`（run.log:299 / final-convert:6 / s5-report-final.json:7）；mock 声明 $0.00 + realCost unknown/external_blocked；backendLimitations 四条与管道事实逐条相符（RSS=runner 进程主体与 `memoryMetric.target:"runner_process"` 一致）；privacy 三 false + 字段白名单。唯一例外见 R1。
8. **CLI 验证与拒非法报告不写产物**：模式 B 先 `JSON.parse`+`validateS0Report`（scripts:93-94）再落盘（:109）；invalid 证据为带路径抛错、exit 1、零产物；未知 flag 一律 usage 退出（:44-50）；measurement 级校验覆盖转换实际读取的全部字段（:341-364，`ttftMs=null` 合法缺省不误拒）。缺口见 N1（数值参数）、N3（timestamp）。
9. **fixture binding 真实性**：基线 fixtureHashes 由 runner 运行时从 `BENCHMARK_FIXTURE_TASKS` 现算（benchmark-runner.ts:165-167），base 与 final 产物 30 条逐条一致（逐条比对）；转换侧无 I/O，不重读 fixture 文件，suiteHash 绑定的是「源报告声明的 fixture 状态」——ID 集合强制等于当前 fixtures，内容漂移体现为 suiteHash 差异（陈旧报告可检出）。此边界记入适用边界。
10. **分位数/少样本**：线性插值 PERCENTILE.INC 正确（test 3 的 p50=25/p95=38.5 手工复核；无需预排序）；smallSample 机制在场，阈值取值见 N2。

## 阻塞项

**R1（必需）：recovery 模式 durationMs 的派生口径未披露，报告语义与「实测」不符**

- 事实：`durationMs: Math.round(recoveryTimeToOperableMs ? recoveryTimeToOperableMs + 200 : 250)`（benchmark-pipeline.ts:749）——recovery 的 durationMs 是 recTime+200ms 固定偏移；不可操作（recTime=null，含失败样本）时为常量 250。
- 本轮证据：recovery duration 全部 ≈ rec+200（run.log `[7/270] 459ms rec=259ms`、`[270/270] 458ms rec=258ms`；s5-report-final.json:172-177 recovery duration p50=456/min=452/max=467，与 rec 252-267 一一对应）。
- 缺口：S5 backendLimitations（s5-token-benchmark.ts:474-479）声明了 A/B 重启真实性，未声明 durationMs 口径；docs §4.2「TTFT/时长分位数来自本地 mock 管道观测值」（docs/implementation/s5-token-benchmark.md:50）对 recovery duration 不成立（+200 是建模常量、250 是常量兜底，均非观测值）。
- 为何阻塞：S5 把三模式 duration 以同形态 p50/p95/min/max/avg 并列呈现，读者必然横向比较（cold p50 236.5 vs recovery p50 456），后者携带未声明的 +200ms；§4.4 明确要求记录「任务时长」，口径不实会向下游 S5 主张传播。与本仓 S0 round-1 阻塞同类（测量语义未如实标注）。
- 修复（披露级，不改逻辑、无需重测）：backendLimitations 增一条，如「recovery 的 durationMs 沿用 S0 口径 = recoveryTimeToOperableMs+200（不可操作时常量 250），非真实任务墙钟时长，跨模式时长对比无效」；docs §4.2 同步修正；可选在 mode 级 durationMs 附同文 note。最终统计层由同一原始报告重转换即可。

## 非阻塞残余

- **N1 CLI 数值/过滤参数无边界校验（模式 A）**：`Number()` 直透（scripts:100-101）——`--deadline-ms abc` → NaN 使全局 deadline 判断 `> NaN` 恒 false（benchmark-runner.ts:119-123），900s 硬保护被静默解除（单条测量仍有 10s/15s/3s 内部超时，批量被拉长而非失控）；`--repetitions 0/abc` 与 `--tasks ""`（scripts:99 + runner:87-89 过滤出空表）产出全 null「空报告」并照常落盘。发射值本身诚实（null 语义），但非法输入应拒或显著告警；与既有 S0 CLI 同缺陷（runner:278-284 同样直透），非 S5d 引入。建议 `Number.isFinite`+正值校验、空跑批拒绝/告警。
- **N2 smallSample 阈值 5 vs §4.4 建议量**：阈值 5（:20）远低于 §4.4 每模式 90（30×3）——deadline 截断跑批（每模式 40-80 样本）不会被标记 smallSample。原始透明度在场（sampleSize/missingCount/sourceReport.timedOut），建议措辞注明「5 为退化样本下限，完整跑批应达 90」或按期望总量标记。注释引用 §4.4（:19）易被读成该阈值有 §4.4 依据。
- **N3 `validateS0Report` 未校验 `r.timestamp`**（:410-436 无此项），而 buildS5Report 读取其进 `provenance.sourceReport.timestamp`（:457）——缺失时 undefined 被 `JSON.stringify` 静默丢键。建议一行非空字符串检查。
- **N4 privacy.collectedFields 超报**（:484-491）：rssBytes/recoveryTimeToOperableMs/eventsCount/repetition/cachedTokens 均未出现在 S5 报告体（报告不发射这些值）。多报在隐私方向无害，但「本报告仅聚合上述元数据」与事实不符，建议改为「可读取的源元数据白名单」或收敛清单。
- **N5 琐项**：`durationStats.avg` 用 `Math.round`（整数）而 percentile 用 round2，精度不一致（:194 vs :177）；模式 B 静默忽略跑批专用 flag（parseArgs :32-50 照收后不用）；模式 A `--tasks` 子集时 suiteHash 仍绑定全集 30 任务（sourceReport.totalRuns 可见，建议未来加 tasksExecuted）；suiteVersion 仅要求非空未钉 `SUITE_VERSION`（:410，ID+hash 已实质绑定，风险低）。
- **N6 验证债（协调者已排期）**：typecheck log 为空文件（无 exit code 证据）且早于「summary 不存在检查」最后修复；unit TAP 的 8/8 无法证明 test 8 含该修复后的负控断言（TAP 不展示断言级细节）。最终全仓 typecheck + 单测复跑落地前，本层产物不应被进一步向前引用。summary 检查本身在代码在场（:426，对象存在检查在读成员前）。

## 实测适用边界（本轮数字可支撑 / 不可支撑的主张）

- 只覆盖 LocalBackend（宿主子进程）路径；S2 容器隔离后端未覆盖。
- 模型为本地 mock（$0.00；无真实成本、无真实缓存行为）；warm 模式在现有管道中无可测的真实跨请求缓存复用（cacheRead unknown），「热复用」语义仅继承 S0 标签。
- recovery 的 durationMs 为派生口径（R1）；recovery 的 TTFT 与 recTime 为重启后真实单调钟观测。
- 固定 30 任务 × 3 重复、固定 revision（c66c785）+ suiteHash 绑定；结果不可外推到真实模型或真实任务。
- 全部门槛 `not_measured`/`external_blocked`；样本误差未计算（§4.4「样本误差」在门槛可测前无对象）；TTFT p50/p95 为绝对观测值，非基线回归。
- 本轮数字仅支撑「本地 mock 管道可运行、可计量」的主张；不支撑任何成本、质量或性能优化达成主张。

## 评审观察层限制（非代码缺陷）

- **脱敏占位**：本会话工具输出对 s5-token-benchmark.ts:47 与 :100 两个导出接口名、以及 benchmark-fixtures.ts:481 与 base-report.json:37 / s5-report-final.json:37 中 task-16 id 的一段子串，一律渲染为 `{{SECRET_…}}` 占位。判定为评审侧观察层脱敏而非源码内容：同一 HEAD 上该源码被 node 实际解析执行（unit 8/8、两次转换成功、跑批 270/270——含字面花括号的标识符无法通过模块解析），且同占位在多个独立文件一致呈现。影响：两个接口名原文未目验（成员结构、字段类型与引用点已完整核对；scripts 与 tests 均不按名引用，纯命名层面）；task-16 id 子串与对应 fixtureHash 未逐字目验（30 条 hash 在 base/final 两产物间逐条一致，绑定关系成立）。建议后续以非脱敏通道对这两处命名目验一次即可闭环。
- 评审未运行任何命令：SHA-256 不可重算，suiteHash↔fixtureHashes 绑定正确性的依据是算法审查（:206-214）+ test 7 + 两次独立转换同值；bounded-runner「exit 0 natural_exit」为协调者转述（run.log:2 另有「进程组安全校验未通过 → 零信号」记录，属运行器自身保守行为，与测量数值无关）。

## 判定

S5d 的核心诚实性设计全部落实且证据链完整：纯转换、null/unknown 诚实缺省、门槛零达成标记、失败独立汇总、provenance/隐私声明与管道事实相符、非法输入零产物。唯一必需项 R1 为披露级修复（一条 limitation 文案 + docs 同步），修复并落地 N6 的最终复跑后，本层可进入下一轮确认（approve 范围仍限于 S5d 补充报告层；真实成本、真实配对基线、20%/质量/p95 门槛维持 external，不因本轮改变）。
