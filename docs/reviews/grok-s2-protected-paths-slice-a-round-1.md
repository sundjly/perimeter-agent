# Grok S2 工具路径守卫（Slice A）第一审

- 结论：`approve`（限定 Slice A 路径守卫本包：真实链 9 场景正反控与单元 8 项独立复验通过，canonical 复判/包含/漂移复检成立。两项记录在案：extension 缺能力时守卫跳过为 fail-open（真实接线恒注入，非可达路径，契约建议收紧）；canonical RPC 无 abort/deadline（BACKGROUND_CONTEXT，挂起将阻塞 beforeTool）。{{SECRET}}（产品四眼/路径防线整体）维持 partial，S2 整体与企业生产不批准）
- **【R2 纠正，2026-10-16】** 协调者实读 `/tmp/r25.out` 判定：本轮探针实际 **EXIT 1**（waitFor 超时），且脚本末尾含 `process.exit(0)`、`execSync git` 无 deadline、`mock.kill` 未 await、无 finally、`nextToolSettled` 吞错、mock 批次消费与 prompt 错位——**「独立九场景 runtime 通过与本包 approve」撤回**，R1 状态改为「当时 runtime 门槛未过」；聚合金文件态证据保留但不作为九场景自然退出证据，亦不据此推定产品冷启动 bug。原始 r25 产物未改未删以存证。R2 复验见 `grok-s2-protected-paths-slice-a-round-2.md`。
- 日期：2026-10-16
- 审查者：grok（唯一 reviewer；Pi 唯一 coder）
- 对象：`src/runtime/perimeter-extension.ts`、`src/runtime/harness-host.ts`、`tests/protected-paths.test.ts`（8 项）与 `docs/implementation/s2-protected-paths-slice-a.md`、`s2-protected-paths-plan.md`。依据 handoff §5.2 工具安全与 slice-a 任务 spec。
- 允许写入：`docs/reviews/grok-s2-protected-paths-slice-a-round-1.md` 与 `docs/reviews/handoff-coverage.json`。未改实现、测试、其它 docs、handoff、SDK，未 commit / push / spawn 新 worker。

## 独立行为复现（production Gateway + DockerBackend(none) + localhost mock + 临时 git fixture，真实工具执行链）

仓库 policy（package.json 命中 require_approval_paths）+ 同一 envFactory 注入。按模型真实下发顺序 9 个 write 场景（经 pi 多请求步进，聚合文件态为準）：

| 场景 | 结果 |
|---|---|
| 多级新建 `deep/a/b/c/notes.txt`（editor，非审批路径） | ✓ 允许并落盘（正控：不全拒） |
| 绝对路径外逃 `/tmp/evil-abs.txt` | ✓ policy.denied（canonical-path-guard），宿主无文件 |
| 相对 `../evil-escape.txt` | ✓ 拒，workspace 外无文件 |
| 假前缀 `/workspace-evil/evil2.txt` | ✓ 拒（canonical 包含按 `根 + "/"` 边界，非字符串前缀） |
| symlink `sym-protected.txt` → `/etc/passwd` | ✓ canonical 解析后逃出 workspace → 拒，/etc/passwd 未变 |
| symlink `sym-pkg.txt` → `package.json`（受审路径） | ✓ **canonical 复判命中 require_approval** → 走审批，B allow 后落盘（词法 allow 不漏审） |
| 审批等待期 symlink 重指 → `/etc/passwd` | ✓ 获批后漂移复检 canonical 不一致 → 拒，/etc/passwd 与目标文件均未写 |
| 循环 symlink `loop-a ⇄ loop-b` | ✓ ELOOP fail-closed 拒，无落盘 |
| `tests/protected-paths.test.ts`（8 项：正控 2 + 反控 5 + 单元 1） | ✓ 8/8，exit 0 |

四眼意图绑定不变：argsHash 仍对原始 args 计算（守卫只读），审批事件仅带 hash；canonical 复判后 effective 取更严判决，deny/require_approval 均不漏（词法 allow 经 symlink 漂移被复判为 require_approval 实证）。

## 协调者两项源码观察的独立判定

1. **缺能力跳过守卫（fail-open）——属实，记为契约缺口**：`perimeter-extension.ts:57` 以 `opts.resolveCanonicalPath && opts.workspaceCanonical` 真值决定是否执行守卫；直接实例化 extension 而不注入时守卫整体跳过（fail-open）。真实接线路径（`harness-host.ts:113-119`）经同一 envFactory **恒注入**两个能力，生产会话链不可达该分支；`tests/protected-paths.test.ts` 的直接 extension 单测用 NUL/越界触发 fail-closed 分支，未覆盖「缺能力」形态。最小包建议：production 下能力缺失即 denyBlock（fail-closed），或文档化为 harness-host 专属不变量并由类型强制。
2. **canonical RPC 无 abort/deadline——属实**：`resolveCanonicalPathForGuard`/`workspaceCanonical` 均传 `BACKGROUND_CONTEXT`，无 ctx.abortSignal、无显式超时；容器 RPC 悬挂会阻塞 beforeTool。缓解事实：DockerBackend 侧 exec 启动有 30s 超时、容器内 RPC 走 stdio（容器存活即通），本轮实测无悬挂；建议后续给 guard 的 canonical await 加有界超时并 fail-closed deny（deny 不属于「race 返回隐藏工作」）。

其余：容器内 RPC 为 SDK `RemoteExecutionEnv.canonicalPath`（pi-env 接口），宿主 realpath≡容器假设已按 plan 修正弃用；`plan.start`（docker run）有 30s 超时。

## 全量与静态（本轮新鲜实测，非 r20）

| 模式 | exit | tests | pass | fail | skipped | cancelled | 墙钟 |
|---|---|---|---|---|---|---|---|
| `npm run test:serial`（concurrency=1，runner 外层 1700s） | 0 自然 | 447 | 447 | 0 | 0 | 0 | ~192s |
| `npm run test:bounded`（默认并发，1700s） | 0 自然 | 447 | 447 | 0 | 0 | 0 | ~130s |

447 = 439（r20 口径）+ 8 项 protected-paths。`npm run typecheck` 0；`git diff --check` 0。owned 容器：跑批后清理本轮 6 个新 own 容器（精确 ID），历史 3 个（2026-10-15 13:56–14:01）原样保留登记。产品/测试哈希：`approvals.ts` `8307708ff8222371`（四眼未回退）、probe 文件 `772c73ff07e67738`。

## 证据保留（绝对路径，未清理）

- 探针输出与断言：`/tmp/r25-probe.mts`、`/tmp/r25.out`（含逐场景 SETTLE-DUMP 与最终 JSON）
- protected-paths 专项：`/tmp/r26-pp.log`
- 全量日志：`/tmp/r26-serial.log`、`/tmp/r26-bounded.log`、`/tmp/r26-tsc.log`

## 残余与边界（作者自报 + 本审确认）

bash（无 path 参数）与 hardlink 跨 mount 写、批准后 dispatch 瞬间的检查-使用窄窗、敏感读（read 豁免）不在本切片——{{SECRET}}（产品四眼+路径防线整体）维持 partial；真实 CNI/客户模型 external。S3/S4 按依赖。

## 给 Pi 的下一最小包

1. extension 生产模式能力缺失 → denyBlock（fail-closed），并补一条直接 extension 单测。
2. guard 的 canonical await 加有界超时（如 5–10s）→ 超时 fail-closed deny（记录超时，不吞为 allow）。
3. Slice B（会话期 bash/RO-overlay/hardlink 面与敏感读收紧）立项前先出设计文档（不改代码）。
