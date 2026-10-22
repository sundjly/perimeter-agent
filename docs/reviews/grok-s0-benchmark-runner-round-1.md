# Grok S0 Benchmark Runner 第一审

- 结论：`request_changes`（限定四处测量语义/措辞缺口。runner 本体是真实管道：270 条记录独立复跑成功、负测真失败、无预写/随机造假。这四项修复后 `s0-benchmark-benchmark` 才可升 implemented；真实模型质量/成本/SLA 仍 external）
- 日期：2026-10-14
- 审查者：grok（唯一 reviewer）
- 对象：`src/evals/benchmark-runner.ts` `350063c33427b643`、`benchmark-pipeline.ts` `937006c0f04620a6`、`benchmark-fixtures.ts` `01ba1a9264b8c4c3`、`docs/s0/benchmark-baseline.md` `18ae5ee77a229f9c`、`docs/s0/actual-local-mock-benchmark.json` `ef7fcce70260745c`。依据 handoff §4.4/§7 与 `docs/reviews/grok-s0-s1-completion-round-2.md` 下一阶段任务。
- 允许写入：本文件与 `docs/reviews/handoff-coverage.json`。未改实现、测试、docs 其它、SDK，未 commit / push。

## 独立复跑（外部 deadline 600s，批内自限 900s）

- 全量 30 任务 × 3 模式 × 3 重复：我自己的运行 79s 自发退出 exit 0，Overall 100%，Recovery operable 14ms；产物写到我指定的 /tmp 路径，未覆写仓库文件。
- JSON：270 条记录（cold/warm/recovery 各 90）、30 个唯一任务、`suiteProvenance.fixtureHashes` 30 个互异 SHA-256、`executionMeta`（deadline/elapsed/timedOut）、`costDeclaration`（真实商业成本 null / unknown external_blocked，mock $0.00）、敏感串扫描 0 命中。
- 负测：`--negative --tasks task-01… --repetitions 1 --modes cold` → `success: false`，harnessError 为真实 `node --test` 失败。失败是真失败，不是恒绿。
- 资源：owned 容器标签计数 0；正常退出的运行不残留 runRoot 目录；`$TMPDIR` 里有 22 个此前 agy 运行（含被 TERM 的那轮）遗留的 `perimeter-*` 目录——正常路径会清理，崩溃/被杀路径会遗留。
- 全量 `npm test`：409 tests，407 pass，2 fail（仅 S2 两项容器红），自发退出；typecheck 0；`git diff --check` 0。身份/PKCE/撤权/并发/缓存前缀/Durable API 回归全绿。

## 真实性核验

成立的：任务经真实 `Gateway → HarnessHost(Durable SQLite) → LocalBackend → ModelGateway → 本地 mock` 工具管道执行；TTFT 取自真实 WS 事件单调时钟；cold 模式 token 来自 mock usage 事件（管道 334-336 行解析）；每任务 `failsAtStart` 起点预检真实红灯；verify 以真实退出码判定；negative 真失败；30 个 fixture 输入/validator/哈希在 provenance 齐全；repeats/输出/deadline 均可配置；证据已脱敏。

不成立的四处（均已在源码定位）：

1. **Recovery 不是真实 OS 进程重启**。`runRecovery()` 里是同一进程内 `gw1.close()` 后 `new Gateway` 重绑。代码注释诚实写「进程模拟退出」，但 round-1 验收要求真独立进程退出/重启（真实 PID 与 exit），且报告未披露这是进程内模拟。连续性检查本身是真的（未提交产物逐字节比对 + 重启后真实 verify）。
2. **Warm 模式 token 是合成常量**：`inputTokens: 80`、`cachedTokens: 40`、`outputTokens: 25` 直接写死（注释「记录复用 prefix 的 token」），没有任何 usage 事件被解析，却标 `usageSource: "mock-provider"`——90 条 warm 记录的 cachedTokens 全是同一个 40。报告把它写成「模式专属实测特征：稳定系统前缀复用 ~40 tok/任务」，属把合成值当实测。
3. **Peak RSS 276.1 MB 是 runner 进程自身的 `process.memoryUsage()`**，不是 Gateway/Harness 子进程的内存，报告未说明测的是谁。
4. **「真实沙箱执行工具链」措辞**：执行后端是 `LocalBackend`（宿主机子进程），S2 强隔离未实现，「沙箱」一词会暗示企业级隔离。

协调者问的三点一并回答：`gateway.close()` 不是真实进程退出（见第 1 条）；LocalBackend 非强隔离（见第 4 条）；`cachedTokens=40` 无事件来源（见第 2 条）。早前被 TERM 的那轮遗留：`fixture-val-5wjn7b` 已不存在；`$TMPDIR` 另有 22 个 `perimeter-*` 遗留目录（见上）。

## 台账

- `s0-benchmark-baseline`：保持 `partial`，证据更新为「真实 runner 管道已建成并独立复跑 270 条；剩余缺口 = recovery 真进程重启、warm token 事件化、RSS 归属、沙箱措辞」。真实获批模型/客户质量/20% 收益/SLA 仍 external 未知。
- 其余条目不动：S2 两项容器失败保持 partial；真实 IdP/集群/模型/客户批准保持 external。

## 给 agy 的下一最小包

1. Recovery 用真实子进程：以 `tests/fixtures/gateway-process.ts` 模式 spawn 独立 OS 进程跑实例 A，记录其 PID 与真实 exit，再 spawn 实例 B 复用同一 stateRoot/workspace；连续性断言保持现状。验收：报告与 JSON 标注真实 PID/exit，不再称「模拟退出」仍计为 recovery 达标。
2. Warm token 事件化：mock 在 prefix 复用路径发真实 usage 事件（或返回 `cachedTokens: null` + `usageSource: "synthesized"`），管道解析事件；删除 80/40/25 常量。验收：90 条 warm 记录的 token 值来自事件或显式 unknown，不再恒为 40。
3. RSS 与措辞：`rssBytes` 标注测量主体（runner 进程）或改为测量网关子进程；`benchmark-baseline.md` 的「真实沙箱执行工具链」改为「LocalBackend 宿主机子进程（非强隔离，S2 待实现）」。
4. 运行收尾：对 `perimeter-<runId>` 前缀的自身遗留目录做启动时清扫或登记（仅自身前缀，不动其它）。
