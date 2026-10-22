# Grok S0 Benchmark Runner 第二审

- 结论：`approve`（限定 benchmark-runner 本包四项缺口的修复。真实模型质量/成本/SLA/客户批准仍 external unknown，不构成任何企业生产或真实收益表述）
- 日期：2026-10-14
- 审查者：grok（唯一 reviewer）
- 对象：`src/evals/gateway-process.ts` `ce1a50b0881dcbe1`、`benchmark-pipeline.ts` `62031faf9aae4628`、`benchmark-runner.ts` `f84c846a62e9afa4`、`docs/s0/benchmark-baseline.md` `e7222a320303dec0`、`docs/s0/actual-local-mock-benchmark.json` `e23b8beab2479055`。基线是 `docs/reviews/grok-s0-benchmark-runner-round-1.md`。
- 允许写入：本文件与 `docs/reviews/handoff-coverage.json`。未改实现、测试、docs 其它、SDK，未 commit / push / spawn 额外进程。

## round-1 四项缺口的独立验证

1. **Recovery 真实 OS 进程重启**：`src/evals/gateway-process.ts` 真实 spawn 独立子进程 A/B（打印 `{port, pid}`），stdin `close` 指令触发 `gateway.close()` 自然退出；管道记录 `exitEvidenceA = await procA.close()`（exitCode/signal），A 未退出时显式抛错；spawn B 后断言 `procB.pid !== procA.pid` 否则抛错。我的 270 条独立复跑里 90 条 recovery 全部携带 `recoveryProcessMeta`（如 `instanceAPid:8042, instanceAExitCode:0, instanceBPid:8044`），PID 对唯一且 A 全部 exitCode 0。同一 stateRoot + workspace，未提交产物逐字节连续性与重启后真实 verify 保留。
2. **Warm token 事件化**：`80/40/25` 常量删除；cold/warm 都解析 mock 的 `usage` 事件，`hasRealUsage` 判定后 `inputTokens/outputTokens` 事件化、`cachedTokens` 仅在 `cacheRead > 0` 时取值否则 `null`；`usageSource` 两态 `mock-reported` / `unknown / missing-source`。我的复跑 90 条 warm 全部 `cachedTokens: null`（mock 不上报 cache）、input/output 来自事件——mock-reported 不再冒充真实 provider cache 命中或成本。
3. **RSS 归属**：`memoryMetric: { target: "runner_process", pid, rssBytes, note }` 明确测量主体是 runner 宿主进程自身并带 PID；运行日志同句标注「not Gateway/Harness subprocess」。不再冒充 Gateway 内存。
4. **措辞**：报告与实现均写明执行后端为 `LocalBackend`（宿主机子进程）、非强隔离，企业级容器隔离属 S2；「真实沙箱」表述已不再暗示企业隔离。

## 临时目录与资源

- 清理只针对本次正面识别的 owned runRoot exact path；22 个未确认归属的历史 `perimeter-*` 目录原样保留并登记，不做通配扫盘。我的 270 条复跑前后：owned 容器 0 → 0，`perimeter-*` 目录 22 → 22（自身 runRoot 已清）。
- 正常路径无 `process.exit(0)` 掩盖、无对活跃句柄 unref；`gateway-process.ts` 的 SIGTERM 兜底定时器仅在收到 SIGTERM 且优雅关闭挂起时兜底退出。
- 早前被 TERM 的那轮未计入任何成功口径；本轮全部为我自己的新鲜执行。

## 独立复跑与回归

- 270 条批跑（外部 deadline 900s）：129s 自发退出 exit 0，100% pass，零 flake；JSON 270 条、30 任务、provenance/fixture 哈希/executionMeta/costDeclaration 齐全，敏感串 0 命中；TTFT 与 recoveryTimeToOperable 均为单调时钟实测。
- negative 复测：`success: false`，真实 `node --test` 失败，未退化。
- 全量 `npm test`：411 tests，409 pass，2 fail（仅 S2 两项容器红），自发退出；`npm run typecheck` 0；`git diff --check` 0。身份/PKCE/撤权/并发/JWKS/20slot/缓存前缀/Durable API 无回归。

## 台账

- `s0-benchmark-baseline`：`partial` → `implemented`（本地测量管道四缺口已闭）。真实获批模型、客户质量/成本、20% 收益、SLA、DPA 对账保持 external unknown；mock $0.00 不代表真实账单。
- S2 两项容器失败、S3 锁、S4 预算等仍按既有台账为本地代码任务；真实 IdP/集群 egress/客户批准仍 external。企业生产不批准。

## 后续

S0 本地无遗留。下一批按台账自然顺序：S2 两项容器失败（只读挂载、容器端到端策略钩子）与 S3 stateRoot 独占锁、S4 持久预算；真实通道与客户批准等待外部条件。
