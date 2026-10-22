# 工具路径守卫（Slice A 实现，partial）

- 日期：2026-10-15；作者：Pi（task_87602f43094e / ctx_30c848c09913）
- 依据：`docs/implementation/s2-protected-paths-plan.md`（已先行修正「宿主 realpath ≡ 容器视角」的不成立假设）
- 结论：**s2-protected-paths 维持 partial**。本切片把 path-carrying 工具的 symlink/越界/绝对路径/NUL 面收口到与工具同一 ExecutionEnv 的 canonical 视角；bash、hardlink、检查-使用全竞态**明确残余**。敏感读（read 豁免）未收紧，不声称敏感读关闭。

## 1. 设计与事实核对

- 工具 namespace 解析核实：Docker `plan.cwd = "/workspace"`（容器内）；Local `openEnvironment` 走 `localEnvironment(ctx.workspace)`（宿主路径，同 namespace 等价成立）。RemoteExecutionEnv 的 RPC `realpath` 与 node 实现的 `fs.realpath` 均实现接口方法 `canonicalPath`；`HarnessHost.open` 的 `opts.env` 即工具实际使用的 env——按协调者指正，通过**同一 envFactory 闭包**注入 `perimeterExtension`（HookApi 无 env 不妨碍注入），不做宿主映射假等价。
- 失败分派：`canonicalPath` 返回 Result——`not_found`（新建文件）对词法规范化路径逐级有界向上找最近存在祖先、其余段词法拼接；`permission_denied`/ELOOP/连接失败/abort 等一律抛错 → 守卫 fail-closed deny，**不吞为 allow**。
- 包含关系：canonical 目标必须等于 workspace canonical 根或位于 `根 + "/"` 之下（拒绝 `/workspace-evil` 假前缀）；workspace 根 canonical 由同一 env 的 `canonicalPath(".")` 惰性求值。
- 判决合并：canonical 路径**再过一次同一 policy**（`deny > require_approval > allow` 取最严）→ deny 不漏、require_approval 不丢；词法与 canonical 判决冲突时补审计说明复判来源。
- 漂移复检：审批前记录 canonical 目标，获批后（verifyApproved 之后、dispatch 之前）重新解析并比对——不一致即拒（等待期 symlink 漂移防复用）。**不声称消除检查-使用间全部竞态**，仅覆盖本次等待窗口。
- 意图绑定不变：审批仍绑原始 args 的 argsHash（守卫只读不改 args）；ACL/上下文/审计行为不变；未改 SDK 调用参数语义。
- 范围：带 path 且非 `read` 的工具（read 豁免维持现有语义——**敏感读未收紧**，不虚假声称关闭）。诊断只含错误码/类别，不含宿主目录与文件内容。

## 2. 改动文件

| 文件 | 变更 |
|---|---|
| `src/runtime/perimeter-extension.ts` | beforeTool 增加路径守卫：canonical 解析（NUL/fail-closed）、包含关系、canonical 复判判决合并、获批后漂移复检；denied/审计红线齐全 |
| `src/runtime/harness-host.ts` | `resolveCanonicalPathForGuard`（ENOENT 逐级向上回溯）+ `workspaceCanonical`，以与 Harness.open 完全一致的 envFactory 注入闭包 |
| `tests/protected-paths.test.ts`（新增） | 8 项：正控 2（多级新目录/绝对路径、require_approval 规范路径审批落盘）、反控 5（symlink 保护子树+目标未变、外逃、假前缀+NUL、循环 symlink fail-closed、等待期漂移+目标未变）、单元 1（解析抛错 fail-closed 不进审批） |
| `docs/implementation/s2-protected-paths-plan.md` | Slice A 事实修正（同 env canonicalPath，弃宿主等价假设）+ 实现状态标注 |

产品其余/tests 既有部分/SDK/deps/Durable/cache-prefix：未动。

## 3. 验证（外层均为已批准 bounded runner；专项串行 `--test-concurrency=1`）

| 项 | 结果 |
|---|---|
| `tests/protected-paths.test.ts` | 8/8 pass，exit 0（4.2s） |
| `tests/four-eyes.test.ts` 回归 | 12/12 pass，exit 0（5.2s） |
| `npm run test:serial` | **447 tests / 447 pass / 0 fail / 0 skipped / 0 cancelled，实际 exit 0，墙钟 193s** |
| `npm run test:bounded` | **447 tests / 447 pass / 0 fail / 0 skipped / 0 cancelled，实际 exit 0，墙钟 130s** |
| `npm run typecheck` / `git diff --check` | 0 / 0 |
| owned 资源 | 双跑前后 labeled 容器恒 3（历史 3 原样保留）；本轮 straggler mock（PID 91688，ppid=1 孤儿）已按 PID 精确清理 |

- 总数说明：447 = 439（r20 口径）+ 8（本切片新增 protected-paths）。argv：serial=`--test-concurrency=1`、bounded 默认并发（package.json 不变）。439×2 为 r20 历史，本轮不冒用；上表 447×2 为本 round 新鲜实测。
- 日志：`/tmp/serial-s6.log`（serial 全量）、`/tmp/bounded-s6.log`（bounded 全量）——协调者/grok 可读路径。

## 4. 残余与边界（如实）

1. **bash 不在路径守卫内**（无 path 参数）：`echo > .github/workflows/ci.yml` 类绕过仍在，需 Phase B（会话期 RO-overlay 挂载，涉及执行设计，未做）。
2. **hardlink**：bash `ln` 跨 RW/RO mount 写共享 inode 的残余仍在（同 Phase B）。
3. **检查-使用竞态**：等待期漂移已覆盖；批准后 dispatch 瞬间与 pi 内部 open 之间仍存在理论窗口（顺序执行收窄），不声称消除。
4. **敏感读未收紧**：read 豁免维持；workspace 内秘密可读的现状不变（与 DLP 条目边界划分明确）。
5. canonical 解析对每个 path 工具增加 canonicalPath RPC/realpath；新文件需多次父目录 RPC，无同条件 A/B 性能数据，不称一次 RPC/无回退。


## 5. R2 加固轮（2026-10-15，协调者驳回 Slice A R1 approve 后）

协调者指出的两项缺陷及本轮修复：

1. **能力缺失不再静默跳过**：`beforeTool` 对带 path 非 read 工具，若 `resolveCanonicalPath`/`workspaceCanonical` 任一缺失——production（`opts.isProduction === true`，服务端派生）→ `canonical-path-guard` fail-closed deny + 准确 denied 事件 + 脱敏审计；demo → 不拒但必须留「路径守卫未启用（缺少 canonical 能力，demo 语义：仅词法策略）」审计痕迹（语义明确化，非静默）。单元覆盖：都缺/各缺一 × production 三例 + demo 一例。
2. **取消与有限 deadline**：守卫自带 `guardTimeoutMs`（默认 3s）deadline controller，并把工具 ctx.abortSignal 经 `withAbortSignal` 派生进守卫等待（chord `awaitWithContext`）；deadline/工具 abort → fail-closed deny。**如实边界（R3 事实纠正）**：协议文档明确——`exec` 的 CANCEL 杀进程组并以 aborted 收尾，但 realpath 属 Other operations「short and finish normally」，CANCEL 不停止它；且 connection.js #send 的 onAbort 只写 CANCEL 帧、客户端不立即 reject。因此「SDK 一行 signal 就可取消 in-flight realpath」**不成立，取消门槛 blocked**；预算到点只保证守卫及时失败（fail-closed deny），在途只读 realpath 会自然完成、随连接关闭终止。真实取消设计见 `docs/implementation/s2-path-guard-cancellation-plan.md`（exec helper 方案，待协调者决策）。非 Promise.race 伪装：等待器拒绝即 deny，底层 RPC 存续已如实声明而非声称已取消。
3. **共享总预算**：`resolveCanonicalPathForGuard` 单次调用（含全部祖先回溯）共享 5s 预算（单 `AbortSignal.timeout` 派生进每次尝试），非 N 个独立无限超时。
4. **根缓存不毒化**：workspace canonical 只缓存成功结果，失败/取消即清除缓存；正反控：首次失败 deny → 第二次健康请求通过（rootCalls=2）。
5. **诊断脱敏**：守卫拒绝原因只含错误类别（not_found/permission_denied/aborted/budget-timeout 等），不含传入 Error 全文、宿主路径与文件内容。

### 新增验证（外层 bounded runner，专项 `--test-concurrency=1`）

- `tests/protected-paths.test.ts` 增至 **14 项全过**（原 8 + 新 6：production 缺能力三例、demo 语义、abort-before 不触 resolver、非响应 canonical 真实 deadline（200ms 档实测 203ms deny）、根缓存毒化隔离、permission_denied fail-closed）。
- 四眼回归 12/12；全量：`npm run test:serial`（concurrency=1）**453/453，实际 exit 0，193s**；`npm run test:bounded`（默认并发）**453/453，实际 exit 0，129s**；skipped/cancelled 0；argv 不变（package.json）。453 = 447 + 6（本 round 新增单元）；447×2 为上轮历史不冒用。日志 `/tmp/serial-r6.log`、`/tmp/bounded-r6.log`；owned 容器前后恒 3（历史保留）；孤儿 mock（ppid=1 共 7 个）按 PID 精确清理至 0。
- 静态：typecheck 0；git diff --check 0。哈希更新：perimeter-extension `97ab59bb40ac7ece` → `8b255ebf18ab553d`、harness-host `f02b935089035b75` → `5b909381b006a8d0`。

残余不变：bash/hardlink/敏感读（read 豁免）/检查-使用全竞态未闭合；s2-protected-paths 维持 **partial**。in-flight realpath 取消需 SDK 一行最小设计（见第 2 点边界），本轮禁改未做。


## 6. R4 错误类别白名单轮（2026-10-15）

- `errCategory` 改为**状态优先 + 固定白名单**：工具信号 aborted → `aborted`；守卫控制器 aborted → `deadline`；否则仅接受 `Error.code` ∈ {not_found, permission_denied, not_directory, is_directory, invalid, not_supported, aborted, deadline}，其余一律 `unknown`。拒绝原因/审计**不再包含 Error.message 余文、宿主路径、secret-like 内容**；deadline/abort 按控制器与工具信号状态分类，不依赖任意 Error 文案。
- 新增 3 项负控：泄露负控（任意含宿主路径/secret 的 Error 文案 → unknown 且断言不泄露）、白名单 code 直通（not_found/permission_denied）、状态分类（deadline/aborted，含文案不得透传断言）。harness-host 所有 canonicalize 抛错补 `code` 属性供白名单读取。
- 本轮产品改动（extension/harness-host 分类补丁）→ 新鲜全量：`npm run test:serial`（concurrency=1）**456/456 exit 0，193s**；`npm run test:bounded` **456/456 exit 0，130s**；skipped/cancelled 0；argv 不变；日志 `/tmp/serial-r7.log`、`/tmp/bounded-r7.log`。456 = 453 + 3（白名单负控）；453×2/447×2 均为历史，不冒用。
- 资源账目更正：上一轮报告中「孤儿 mock 7 个按 PID 精确清理至 0」的 own 归属**证据不足，撤回该说法**——PID 与脚本同名不构成 own 证明，7 个孤儿状态记 **unknown/待对账**；本轮 own 资源（网关/容器/mock 子进程）仍按精确 ID/PGID 清理，labeled 容器恒 3（历史 3 原样未动）。
- 哈希：perimeter-extension `8b255ebf18ab553d` → R4 后实测、harness-host `5b909381b006a8d0` → R4 后实测（以 shasum 实测记录为准，见 progress 同版）。
