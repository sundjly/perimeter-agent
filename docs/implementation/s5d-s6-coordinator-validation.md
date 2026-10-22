# S5d / S6 协调者验收决策（2026-10-22）

工作方式：新 Pi 写实现，协调者独立执行与验收，Grok 只读复审。只本地提交实现/测试；Markdown、进度与生成证据保留未提交，不 push。冻结 runner SHA-256 仍为 `6f4e2b0f034fe03e9f71ac0dd93d630fde68ca10675d726563a566165af56934`。依赖、锁文件、vendor 未改。

## 本地 mock 测量

独立导出根 `/tmp/perimeter-s5d-measure-0fFHKcC3/w/tree`：从 `c66c785` 导出，补入早期 S5d 纯统计转换层；`node_modules` 使用 APFS 克隆，未用 symlink。原 S0 runner/pipeline/fixtures 与测量过程未变。

命令：`node scripts/bounded-test-runner.ts --timeout 600s node scripts/s5-token-benchmark.ts --revision c66c785bc71d7539aaa2e0520fc0d8bb06a1b8e4 --base-output /tmp/perimeter-s5d-measure-0fFHKcC3/evidence/base-report.json --output /tmp/perimeter-s5d-measure-0fFHKcC3/evidence/s5-report.json --deadline-ms 540000`。

结果：固定 30 任务 × cold/warm/recovery × 3 次，共 270/270 通过，129.01 秒；runner 观察 natural_exit、target code 0、close observed、未发清理信号；runner 的 residue 分类为 unknown，不能把该字段转述为进程树已证明清空。原始报告归档 `docs/s5/s5-base-report.json`，最终统计层从同一原始报告重新转换到 `docs/s5/s5-token-benchmark.json`。

| 模式 | 次数 | TTFT p50 / p95 | duration p50 / p95 |
|---|---:|---|---|
| cold | 90 | 45 / 73.1 ms | 236.5 / 282.1 ms |
| warm | 90 | 44 / 69 ms | 237 / 268.65 ms |
| recovery | 90 | 287 / 296 ms | 456 / 464 ms，派生口径，不能与前两行比较 |

recovery 的 duration 沿用 S0：`recoveryTimeToOperableMs + 200`，不可操作时常量 250；其 TTFT/恢复就绪时间才是单调钟观测。Grok round-1 以缺少此披露要求修订，协调者接受，不修改 S0 算法、不把派生值改称任务墙钟。模型为本地 mock、后端仅 LocalBackend；runner RSS 约 254.3 MiB，不含 Gateway/Harness 子进程。warm 不证明真实缓存命中；cacheRead 零与缺字段无法区分；商业成本与优化门槛仍未知。

补充修复决策：非法 `repetitions`/`deadline-ms` 不得消除截止保护或产生空跑批；空/未知 tasks/modes 应拒绝。少样本阈值采用每模式预期 90；转换报告 timestamp 要求存在。最终测量无需重跑，因修改只涉及参数守卫/统计披露。

最终验收：9/9 单测、全仓 typecheck exit 0（显式退出码已保存）、12/12 非法 CLI 参数真实进程入口负控通过且无任何 S0/S5 产物。Grok round-2 `approve`；实现/测试本地提交 `89cacec`（3 文件）。最终源码与报告哈希见 `docs/s5/evidence/metadata.json`，runner/pipeline/fixtures 三文件与测量导出逐字节相同。

## S6 本地供应链包

实现本地提交 `079cd53`，两文件。10/10 测试；全仓 typecheck exit 0；真实锁生成 126 组件，最终 name-only 许可产物通过官方 CycloneDX 1.6 schema。schema 验证器忽略未使用的 iri-reference/idn-email 格式，不声称验证这些格式。Grok round-1 approve 限本地包。

证据归档 `docs/s6/evidence/`，metadata 记命令、退出码、工具版本、锁与产物哈希：全依赖 npm audit exit 1、1 high（dev ajv → fast-uri@3.1.5，未修）；生产依赖 audit exit 0、0 发现。保留全部原始 JSON，不能用生产依赖无发现覆盖开发供应链漏洞。

S6 仍 partial：vendor/镜像未覆盖，真实 CNI/IdP/KMS/WORM/DPA、soak、隔离目录恢复演练、账单对账与客户安全负责人具名批准缺失。未修依赖漏洞继续作为发布阻塞，后续另立修复/复扫任务；本轮不擅改依赖锁。
