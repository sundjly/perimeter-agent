# S5d round-2：S5 token 基准补充报告层修复复核（HEAD 079cd53，S5d 4 文件仍未提交）

**结论：approve（范围限于本地 mock 统计报告层；真实成本、真实配对基线与 20%/质量/p95 优化门槛维持 external，不因本轮改变）。**

前言：本轮为独立二审，由 Orca 派发的评审终端产出，仅向协调者回报 worker_done，评审结论以本文件为准。全程只读：评审过程未运行 shell/test/git/网络（orca orchestration 回报通道除外），唯一写入为本文件；round-1 报告（grok-s5d-token-benchmark-round-1.md）原样保留未动。HEAD=079cd53 与「S5d 4 文件未提交」为协调者声明（本轮禁 git，无法独立验证版本状态），与本轮全部文件/证据内容自洽。

## 范围与复核对象

复核 R1 修复（recovery durationMs 派生口径披露）与 N1（跑批参数守卫）、N2（smallSample 阈值 90）、N3（源 timestamp 非空）、N4（privacy 白名单措辞），并排查新引入问题；评估「无需重测」成立性。四文件逐行重读：`src/evals/s5-token-benchmark.ts`、`scripts/s5-token-benchmark.ts`、`tests/s5-token-benchmark.test.ts`、`docs/implementation/s5-token-benchmark.md`。

| 证据 | 路径 | 本轮核验要点 |
|---|---|---|
| 单元测试 | `/tmp/perimeter-s5d-unit-v5.tap` | 9/9 pass、0 fail（较一审 8/8 新增 test 9，计数行 `# tests 9 / # pass 9 / # fail 0`） |
| typecheck | `/tmp/perimeter-s5d-typecheck-v5.log`（空）+ `/tmp/perimeter-s5d-typecheck-v5.exit`（内容 `0`） | 空日志 + 显式退出码 0，清偿一审 N6 的「无退出码证据」缺口 |
| CLI 负控 | `/tmp/perimeter-s5d-cli-neg-results.json` | 12/12：repetitions 0/NaN/-1/1.5、deadline-ms 0/NaN/-1/Infinity、tasks 空/not-a-task、modes 空/restart，全部 exit 1 且 outputExists/baseExists 全 false |
| 复转换 | `/tmp/perimeter-s5d-repo-convert-v5.log` | 同一原始 270 样本报告重转换成功；三模式 n=90、各统计值与跑批内转换一致；suiteHash `c704f6c3b8e6…` 与一审记录一致 |
| 最终报告 | `docs/s5/s5-token-benchmark.json` | backendLimitations 第 4 条 R1 披露原文在场；sourceReport.timestamp 非空（2026-10-22T12:09:51.930Z）；三模式 smallSample=false（n=90，注记阈值 90）；privacy 白名单措辞在场 |
| 原始跑批 | `/tmp/perimeter-s5d-measure-0fFHKcC3/evidence/run.log` | 270/270 零失败、129.01s/540s、`settlement=natural_exit, target_exit=code=0, timedOut=false`；recovery 行 duration≈rec+200 逐条可核（如 459ms/rec=259ms、458ms/rec=258ms） |
| 协调者验收 | `docs/implementation/s5d-s6-coordinator-validation.md` | 口径表逐行标注 recovery「派生口径，不能与前两行比较」；冻结 runner SHA-256 `6f4e2b0f034fe03e9f71ac0dd93d630fde68ca10675d726563a566165af56934`；记录修复决策与不重测理由 |

## 一、R1（一审唯一必需项）——已关闭

- **代码披露**：`backendLimitations` 新增第 4 条（s5-token-benchmark.ts:484）：「recovery 的 durationMs 沿用 S0 口径 = recoveryTimeToOperableMs+200（不可操作时常量 250），是派生值而非真实任务墙钟时长，跨模式时长对比无效；recovery 的 TTFT 与恢复就绪耗时为重启后真实单调钟观测。」第 3 条同步改为「…recovery 模式为真实独立 OS 子进程 A/B 重启」，两条合起来把观测值与派生值的边界划清。
- **docs 披露**：§4.2 首条（docs/implementation/s5-token-benchmark.md:52）完整披露派生口径并声明跨模式对比无效；一审指出问题的笼统表述「TTFT/时长分位数来自…观测值」已收敛为「TTFT 与 cold/warm 时长」（:53），recovery duration 不再被观测值措辞覆盖。§3 字段映射表注明「recovery durationMs 派生口径见 §4.2」。
- **产物落地**：最终报告 `provenance.backendLimitations` 第 4 条原文在场；协调者验收文档的口径表同口径。
- **管道未动、无需重测成立**：派生表达式原样在 benchmark-pipeline.ts:748，cacheRead 归并点 :417/537/693 原样（一审引 :749/:419/539/696，内容逐字一致、行号 ±1-3，见「残余」的行号偏移说明）；全部修复落在披露/守卫/测试层，不触及测量语义；最终统计层由同一原始 270 样本报告重转换（repo-convert-v5.log 成功，与跑批内转换同值）。跑批日志 recovery 行 duration≈rec+200 与披露口径吻合。
- 一审要求的「披露 + docs 同步 + 同源重转换」三件全部到位，未改算法、未把派生值改称观测。

## 二、N1（跑批参数守卫）——已关闭

- 校验器 `validateS5RunSelection`（s5-token-benchmark.ts:536 起）：repetitions 要求有限正整数（`Number.isInteger` 同时拒绝 NaN/±Infinity/1.5/0/负值，fail 在 :541）；deadline 要求有限正数（fail 在 :544），NaN 不再可能静默解除全局 deadline 保护；tasks/modes 空（含全逗号/空白）与未知值逐一拒绝，未知 task ID 对照 `BENCHMARK_FIXTURE_TASKS` 实集，错误信息带参数名。
- CLI 接线：scripts/s5-token-benchmark.ts:98 在 `runBenchmark`（:104）之前调用校验；抛错经 `main().catch` exit 1，跑批不启动、S0/S5 两份产物均不落盘。
- 测试与执行双层证据：unit test 9（tests/s5-token-benchmark.test.ts:329 起）对全部非法类负控 + 合法子集透传断言，TAP 9/9；CLI 级 12/12 exit 1 且零产物，覆盖「进程入口真的不写产物」一层。
- 范围说明：S0 runner 自身 CLI 的同源直透为一审已记录的既有缺陷、非 S5d 引入，本轮未修也不属 S5d 范围；经 S5 CLI 的路径已闭环。

## 三、N2（smallSample 阈值）——已关闭

`SMALL_SAMPLE_MIN_RUNS = 90`（:24），注释明确「90 = 固定 30 任务 × 3 次重复（§4.4 建议的每模式期望总量）；deadline 截断或子集运行不足 90 即标记」，一审指出的「注释易被读成阈值有 §4.4 依据」的误读面消除。docs §4.2（:54）同口径并声明「不与全量跑批横向比较」；判定点（:239）与 note 随常量联动。test 6（tests:192 起）以恰好 90 样本断言不标记、少量样本断言标记，双向覆盖。最终产物三模式 n=90 均 smallSample=false。

## 四、N3（源 timestamp 校验）——已关闭

`validateS0Report` 增 `$.timestamp` 非空字符串校验（:415，错误信息说明用途），test 8 覆盖空串与删除两向负控。`buildS5Report` 读取 `base.timestamp` 进 `provenance.sourceReport.timestamp` 后，该键不再可能被 `JSON.stringify` 静默丢弃；最终产物该键存在且非空，与 `docs/s5/s5-base-report.json` 顶层 timestamp 一致。

## 五、N4（privacy 白名单措辞）——已关闭

`privacy.note` 改为「允许读取的源元数据白名单」口径（:496；最终报告同文）：转换仅读取白名单内字段、未列入的源字段一律忽略、报告体只发射统计结果。一审问题是「本报告仅聚合上述元数据」与报告体实际发射不符；现按一审给出的第一种处方改为读侧白名单声明，其方向性主张（白名单外不读、体只发射统计结果）经代码核对成立。清单未收敛仍含仅用于校验的字段，在新口径下合法；残余措辞微瑕见「残余」。

## 六、N6（验证债）——已清偿

typecheck 空日志 + 显式退出码 `0`，且为最后修复之后的复跑；unit v5 9/9，test 8 含 summary 存在性检查（代码 :431）与 timestamp 负控。一审「TAP 不展示断言级细节」的缺口由负控断言文本在场 + 修复后全绿复跑弥补。本层产物解除一审的「不应被进一步向前引用」限制。

## 七、新引入问题排查——未发现必需问题

- 校验器拒绝路径均抛带参数名 Error，CLI exit 1，无部分产物（12/12 证据）。
- 模式 B（--from-report）不经跑批校验，正确（无跑批发生）；模式 B 静默忽略跑批 flag 为一审 N5 既有项，未恶化。
- `--negative` 与校验共存；缺省 repetitions/deadline（3/900000）合法通过。
- 90 阈值对合法子集跑批（docs §5 快速验证示例）会标记 smallSample——正是设计意图且已写入 docs，非回归。
- test 7 断言 backendLimitations 不含「未实现」；新增两条披露均不含该词，断言兼容。
- tasks 重复 ID 仍可通过校验——较修复前（无校验）严格收窄，非新缺口；timestamp 仅拒空串、不拒纯空白——与 suiteVersion 校验同类既有松紧，琐碎。
- S0/pipeline 未动的佐证为内容级而非版本级（本轮禁 git 无全树 diff）：派生与归并锚点内容逐字在场、协调者文档声明未改 + 冻结 runner SHA、270 样本原始跑批复用且两次转换同值。

## 八、残余（非阻塞，不要求本轮处理）

- N5 琐项维持一审：`durationStats.avg` 整数 vs percentile round2；模式 B 静默忽略跑批 flag；--tasks 子集时 suiteHash 仍绑定全集 30 任务；suiteVersion 仅要求非空未钉 `SUITE_VERSION`。
- N4 措辞微瑕：note 中「仅读取白名单内字段做聚合」字面可读成白名单内字段均被聚合，实际部分字段仅用于校验（如 rssBytes）。约束方向的主张准确，方向无害，未来顺手可改「读取（校验与聚合）」。
- 观察层限制（非代码缺陷，承一审）：本会话工具输出对 s5-token-benchmark.ts 两个导出接口名与 task-16 id 一段子串仍渲染为占位符；成员结构、引用点与执行链（9/9、12/12、两次转换）均不依赖按名引用，判定同一审。保留一审建议：后续以非脱敏通道对这两处命名目验一次。
- 行号偏移备查：一审对 benchmark-pipeline.ts 的引用行号（:749/:419/539/696）与当前实际（:748/:417/537/693）有 ±1-3 偏移且偏移量不一致，内容逐字一致——最可能是当时引用笔误而非文件变更（单处删行会造成一致的行号平移）；本轮禁 git 无法定论，仅记录。

## 九、适用边界（本轮 approve 覆盖范围）

- 仅覆盖：S5d 4 文件构成的本地 mock 统计报告层、本地 CLI 入口与测试守卫，及其证据链（270 样本原始跑批、同源重转换、9/9 单测、12/12 CLI 负控、typecheck 0）。
- 一审适用边界全部延续：仅 LocalBackend（宿主子进程）；模型为本地 mock（$0.00）；cacheRead 保持 unknown；recovery durationMs 为派生口径（本轮已披露，跨模式时长对比无效）；固定 30 任务 × 3 重复 + suiteHash 绑定；全部门槛 not_measured/external_blocked；本轮数字仅支撑「本地 mock 管道可运行、可计量、报告诚实」，不支撑任何成本、质量或性能优化达成主张。
- external 维持：真实模型成本（S4）、真实配对基线、20%/质量/p95 门槛、S2 容器隔离后端路径。

## 十、判定

R1 与 N1-N4 全部按一审处方关闭且代码、测试、docs、产物四层一致，N6 验证债清偿；未发现新引入的必需问题。**approve**，范围以 §九 为限。
