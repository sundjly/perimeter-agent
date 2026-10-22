# Grok S2 工具路径守卫（Slice A）第六审（3 项集成测试恢复：有限 approve 关门 R5 required；范围外一律不动）

- 结论：**有限 approve（仅限：恢复 3 项「集成（Local 真实 helper）」beforeTool 测试 + 实施文档 §8 记录）**，R5 §5 required 跟进就此关门。产品四文件哈希与 R5 台账逐一相符（未改产品）；原 21 项一项未删（24 = 21 + 3，名单逐字核对）；恢复的 3 项与 R4 原版逐字一致（真实 `beforeTool` + `NodeExecutionEnv` + `createPathGuardResolver` 接线，非 fake resolver），含 symlink 外逃/ELOOP/NUL/`~` 越界 deny 与 `policy.denied` 不含宿主路径断言。**全仓 480 为静态计数，本轮未跑全量、不报全绿**；G1 SDK bootstrap/reconnect 与 G3 lost 死亡确认维持 **blocked**；s2-protected-paths / S2 / 企业维持 partial，本恢复包不构成总体 approve/implemented。
- 日期：2026-10-17；审查者：grok（唯一 reviewer；Pi 唯一 coder，task_39db14361ea6 交付）。
- 对象哈希（本轮实测）：产品 `src/runtime/path-guard.ts` `f6fcbbd87b59a22e`、`src/runtime/execution-env.ts` `0f76749a6e0a1614`、`src/runtime/perimeter-extension.ts` `e25a404d6a8509c8`、`src/runtime/harness-host.ts` `e5a8e600b264fbbe`（四项 = R5 台账原值，零改动）；`tests/path-guard-exec-helper.test.ts` `0b882884382f4148`（R5 为 `cd703ec373aee486`，仅本恢复包）、`tests/protected-paths.test.ts` `93f34f838ab86558`（不变）。实施文档 §8 记录于 `docs/implementation/s2-path-guard-exec-helper.md`。
- 允许写入：本文件、`docs/reviews/handoff-coverage.json`、R5 最小衔接。未改产品/测试/handoff/SDK 依赖/作者报告；未 commit/push/spawn；未跑 Docker 套件/全量、未重启 daemon、未换 context、未触碰用户 workload/未知资源。

## 1. 恢复内容精确核验（重建=原版逐字，非「找到不可读原快照」）

- 测试文件注释明示恢复来源与根因：「本节（makeRealExtension + 3 项集成测试）在 R5 G2 块重写时被锚点切片静默删除（round-5 §5 required 跟进），现从本会话首写版逐字恢复；未降断言、未改产品 src」。与 R4 原版（本审 R4 会话记录）逐段比对：`makeRealExtension`（真实 `perimeterExtension` + `resolveGuardPath: createPathGuardResolver(envFactory)` + 真实 `localEnvironment` + `approvals()` 到达即抛）与三项断言（多级新建 `src/deep/new/dir/file.txt` 放行；`join(ws,"abs.txt")` 放行；`out`→越界、`loop/x`→not_supported fail-closed、`a\u0000b.txt`→NUL、`~/pg-escape-new.txt`→越界、emitted `policy.denied` 全量不含 `homedir()`）逐字一致——**逐字恢复成立**，无断言弱化。
- 名单核对：24 项 = R5 的 21 项名称全部在列（8 helper + 4 协议 + 2 G2 + 1 G1 + 2 kill + 4 Docker 门控）+ 3 项恢复；顺序将集成节置于 G2 之后、G1 之前（位置无实质影响）。
- 全仓顶层 `test(` 静态计数 405（本审独立 grep 旁证，与 Pi §8 一致）；**runner 口径 477 含嵌套/动态注册差异，480 全量实跑本轮未发生，不作任何全绿声明**。

## 2. 本轮运行证据（真实 argv/counts/exit/墙钟，绝对路径）

| 运行 | 启动头（批准 runner） | exit | tests | pass | fail | skipped | 墙钟 | 日志 |
|---|---|---|---|---|---|---|---|---|
| Pi 限定专项 | `bounded-test-runner --timeout 120s node --test --test-name-pattern 集成 tests/path-guard-exec-helper.test.ts`（PGID=54686 独立组） | 0 自然 | 3 | 3 | 0 | 0 | 708ms | `/tmp/perimeter-r6/restored-local.log` |
| 协调者独立复跑 | 同 runner、`--test-concurrency=1 --test-name-pattern 集成（Local 真实 helper）`（PGID=57660） | 0 自然 | 3 | 3 | 0 | 0 | 697ms | `/tmp/perimeter-r6/coordinator-restored-local.log` |
| **本审独立复跑** | `bounded-test-runner --timeout 120s node --test --test-name-pattern 集成（Local 真实 helper） tests/path-guard-exec-helper.test.ts` | 0 自然（GROK_SPEC_EXIT=0） | **3** | **3** | 0 | 0 | **705ms** | `/tmp/perimeter-r6-grok/restored-local.log` |
| 静态 | `npx tsc --noEmit`（runner，PGID=60730） | 0 自然 | 0 错误 | - | - | - | 3.2s | `/tmp/perimeter-r6-grok/static-typecheck.log` |

- 三份限定专项（Pi/协调者/本审）三实现全绿，log 头含 raw argv、PGID、skip=0、`timedOut=false` 自然退出、墙钟；日志尾均已实读。
- 已披露副作用：Docker 门控 4 项的 `dockerReady` skip 条件在**模块加载时**求值（`docker version`/`image inspect` 各 4s 超时上限），name-pattern 运行亦触发；本轮零容器创建。Pi 侧 `npx tsc` 因 pnpm store 链接损坏改用直接 tsc bin（exit 0）；本审侧 `npx tsc` 正常（exit 0）——均为环境差异，与本次改动无关。

## 3. 范围与边界（不变项重申）

- **未跑**：其余 21 项、Docker 套件、全仓全量（Docker daemon 停滞期约束继续；本轮探测 daemon 曾响应 23ms，授权范围不因此扩大）。旧 477×2 为 R5 前作者套件证据；R5 独立 serial 124 无效与 4 skip 历史保留原样；不报 480 全绿。
- **不重开**：R5 已批准的 G2 字节契约 / kill oracle 硬化 / G1 in-repo metadata 三项能力不重审。
- **维持 blocked**：G1 SDK bootstrap/reconnect 预算、G3 lost 死亡确认（本轮未顺手改 SDK、未加 race 包装）；「normal timeout/abort 已证行为保持」与「不杜撰所有 Remote 都不收割」口径同 R5。
- **维持 partial**：s2-protected-paths / S2 / 企业生产；四眼历史限定批准不回退；K8s unknown；bash/硬链接/敏感读/最终 check-use TOCTOU 残余不扩。
- 静默删除问题关门口径：真实 3 用例覆盖恢复 + 本审独立局部 exit 0（本轮即达成）；根因（R5 G2 块锚点切片重写）已由 Pi 写入测试文件恢复说明，原文保留。
