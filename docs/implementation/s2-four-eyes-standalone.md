# S2 四眼 standalone 生产链探针：诊断与实证报告

- 日期：2026-10-15
- 作者：Pi（worker，task_793b6e557847 / ctx_641973ea7e60）
- 对象：`scripts/probes/four-eyes-standalone.ts`（新增，SHA-256 前 16 位 `8389119b2c3d5ebd`）
- 依据：`docs/reviews/grok-s2-four-eyes-round-2.md`「下一最小包」第 1 条（standalone 生产容器 session.ready 挂起根因定位）
- **产品代码零改动**；本报告只新增探针与文档

---

## 1. 结论（先行）

1. **产品冷启动 / 套件预热依赖：未复现。** 同一独立冷进程、同一真实链路（Gateway + Harness + DockerBackend(none) + localhost mock + 仓库真实 policy + 临时 git fixture），多次全新 OS 进程三场景全部通过，总耗时约 2.9 秒/次；容器握手 preflight 实测 172–228ms。session.ready 在独立进程亚秒级到达。表述边界：这是本机全部冷进程观察中的现象，**不等于对 grok 环境的预热假说已完全证伪**。
2. **grok 探针 240s 挂起的精确根因：不能定论。** grok 的探针实物（`/tmp/fe4-probe.mts`）已被其收尾清理删除，worker transcript 中的源码与 `/tmp/fe4.out` 输出均被截断，无法对配置逐项核对。已核实的残迹与本轮诊断事实见 §2/§3。按证据纪律：既不宣称产品 bug（未复现），也不替 grok 的 fixture 定罪（实物缺失），只交付可复现契约（§4）供第三审重放。
3. **439×2（serial/bounded）属上一轮历史证据**（grok r20 已独立复测），本轮无产品改动，不重跑全量；本轮新鲜证据为：四眼专项 12/12（本轮跑，4.98s，exit 0）、standalone 探针两次冷进程全过、`npm run typecheck` 0、`git diff --check` 0。

## 2. grok 探针取证（仅存证据）

来源：`/tmp/perimeter-grok-r20-transcript.json`（worker 提供）与 `~/.grok/sessions/.../terminal/call_*.log`。

- 探针文件 `/tmp/fe4-probe.mts` 已被删除；transcript 中的 write 内容在 ~1.2KB 处截断（仅恢复出头部：mock spawn、createRequire("ws")、动态 import 产品 TS、`startGateway(marker, gitInit)` 结构、`allowedHosts: [127.0.0.1:${gwPort}]`）。
- 三次运行均为 **NG 场景在 owner 的 session.ready 等待处超时且空事件**（60s → 120s → 240s 逐次延长），探针崩溃导致其收尾清理未执行、容器泄漏；`docker ps` 显示其容器 Up、daemon 健康。
- 关键反证：**fe3（更早一代探针）最后一次运行在 ~60s 收到过 session.ready** —— 说明 grok 环境里握手并非不可能完成。
- grok 自述差异点：fe4 相对 fe3 改用仓库 policy（`config/policy.yaml`）与 marker=package.json；二者均不触及 session.ready 路径。

## 3. 诊断事实（产品代码路径 + 本轮实测）

`session.start` 静默挂起（零事件）的候选点分析：

| 阶段 | 是否有界 | 证据 |
|---|---|---|
| `docker run -d`（DockerBackend `environmentPlan().start`） | 有界：`execFile` timeout 30s | 超时会抛错 → session.start catch → 客户端会收到 `error` 事件 |
| `docker exec -i <容器> pi-env` 连接 + `Connection.info()` 协议握手（`src/runtime/execution-env.ts openEnvironment`） | **无超时** | 若 pi-env 不回话则永久挂起——与「容器 Up + 零事件」症状吻合 |
| WS 升级/鉴权失败 | 有界（升级拒绝或 close 4001/4003） | 客户端会看到 open 失败或 close，不会是「空事件 + 连接存活」 |
| 会话启动失败路径 | `catch` → `error` 事件 | 零事件排除了「启动失败被吞」 |

即：**「容器 Up + 零事件」症状与一个能产生该症状的无界 await（pi-env 协议握手）相符**。注意：这是产品内唯一已知的无界 await，但并非 240s 挂起的已证唯一根因。本轮独立冷进程实测该握手 172–228ms 完成（preflight 多次：206/203/172/187/228/169–205ms），两次三场景链路无一次挂起。grok 环境当时的差异证据：其 `docker ps` 显示 5 个 labeled 容器同时 Up（3 个历史遗留 + 2 个 fe4 泄漏），守护进程处于多容器并发状态——这是可信的争用假说，但**无日志可证**，如实记为 unknown。

**产品侧观察（非本轮改动）**：`openEnvironment` 的 `Connection.info()` 无超时是唯一无界 await，若握手停滞则 session.start 静默挂起且客户端无任何事件。是否加有界超时属产品加固决策，留 grok 第三审独立裁断（本轮未复现产品缺陷，按纪律不改产品）。

## 4. standalone 探针契约（新增 `scripts/probes/four-eyes-standalone.ts`）

用法（外层必须用已批准 bounded runner 提供看护死线）：

```sh
node scripts/bounded-test-runner.ts --timeout 180s \
  node --experimental-strip-types scripts/probes/four-eyes-standalone.ts --scenario all
# scenario: all | ng | git | ctx
```

- **独立冷进程**：每次调用是全新 OS 进程，不依赖任何套件前置/缓存状态；每场景各自新建 Gateway + 容器（gatewayId 含唯一 runId，容器名互不冲突）。
- **真实链路**：production 模式 Gateway（服务端派生 mode）+ DockerBackend `perimeter-sandbox:test` + `network: none` + localhost mock-model + 仓库真实 `config/policy.yaml` + 临时 git fixture；自有凭证（mock authenticate，token-1/token-b 为不同 subject 的两个自然人，与套件 production helper 同构）。
- **policy 预检**：探针先用真实 `PolicyEngine` 断言 `write package.json` 命中 `require_approval`（rule `sensitive-paths-need-review`），防止 ActionDescriptor 缺 path 导致的 allow 误判；session.ready 只是必要条件，各场景以真实事件/落盘/审计为 oracle。
- **三场景 oracle**：
  - `ng`：git-less 高风险 → `policy.denied`（reason 含「上下文不可靠」）+ 零 approval 事件 + marker 不写 + 审计无 allow；
  - `git`：临时 git 真实 HEAD + 独立 B 批准 → marker 落盘 + 审计 `approval.decision allow`（actor/approver 逐一断言）；
  - `ctx`：request 后删除 `.git` → decide 拒（error 含「审批意图上下文已失效」）+ marker 不写 + 审计无 allow。
- **脱敏有界插桩**：阶段时间线（mock/gateway/ws-open/session-ready/每步）、帧类型有界记录（上限 300，超出计数）、close code/reason、容器状态与 `docker logs --tail 40`（仅在超时诊断时）；manifest 逐阶段落盘 `$TMPDIR/perimeter-fe-probe/<runId>/manifest.json`，外层死线强杀也留证据。不输出 JWT/cookie/env/模型上游秘密。
- **清理**：本次 own 容器按 gatewayId 精确 `docker rm -f`；mock/网关/WS/临时目录收尾；历史 labeled 容器仅登记不动。

## 5. 本轮实测证据（两次独立冷进程，`--scenario all`）

| runId | preflight 握手 | ng | git | ctx | 总耗时 | exit |
|---|---|---|---|---|---|---|
| `fe-probe-…-14-55-17-852Z-op7yst` | 228ms | pass 518ms | pass 1000ms | pass 1018ms | ~2.9s | 0 |
| `fe-probe-…-14-55-29-566Z-dogii2` | 187ms | pass 518ms | pass 1029ms | pass 1006ms | ~2.9s | 0 |

- NG 实测拒绝原因：`审批上下文不可靠：生产环境高风险操作必须绑定有效 Git 仓库版本与仓库标识`；approval 事件 0；marker 未写。
- GIT 实测审计：`{kind: approval.decision, verdict: allow, actor: corp|alice-probe, approver: corp|bob-probe}`；marker 落盘。
- CTX 实测错误：`Error: 审批意图上下文已失效：当前工作区上下文不可靠（代码版本或仓库标识丢失）`；marker 未写；无 allow 审计。
- manifest 目录：`$TMPDIR/perimeter-fe-probe/`（两份完整 manifest 含逐阶段时间线、容器清理账目）。

## 6. 资源台账

- **本轮 own 资源**：全部清理（每次运行 own 容器按 gatewayId 精确删除；run 结束后 labeled 容器计数回落到 3 = 历史遗留）。
- **3 个历史 owned 容器（登记保留，未删）**：
  - `501bf4e24934` — `perimeter-Sundys-MacBook-Pro.local-34618-219864fe…` 创建 2026-10-15 13:56:20 +0800
  - `6ebb0361f97f` — `perimeter-Sundys-MacBook-Pro.local-36801-2a0e3362…` 创建 2026-10-15 13:58:28 +0800
  - `36e6756df991` — `perimeter-Sundys-MacBook-Pro.local-39672-f4386719…` 创建 2026-10-15 14:01:53 +0800
  - 归属证据：创建时间窗与 grok R2 报告自述「3 个更早（13:56–14:01）的 owned 遗留容器登记保留」完全吻合（其 R2 前置全量复测时代）；早于本 dispatch（22:00 后）数小时，非本轮产物。容器名内嵌的网关 PID（34618/36801/39672）均已是死进程。
- mock-model 孤儿进程 0；bounded runner 进程组回收正常。

## 7. 边界与未决

- 本轮**无产品改动**：439×2 全量属上轮历史（grok r20 已独立复测 439/439），不作为本轮新跑证据；本轮新鲜项 = 四眼专项 12/12 + 探针两次冷进程 + 静态检查。
- grok 240s 挂起根因：**unknown（实物缺失）**。已证伪「产品必须预热」；已定位唯一无界 await（pi-env 握手）作为唯一能产生该症状的产品内位点；争用假说未证。
- 若第三审在本机重放探针仍遇 session.ready 挂起：manifest 的 `session-ready-timeout` 阶段会自动附带 own 容器状态与 `docker logs` 尾部，可直接定位握手停滞点。
- 未改：grok 报告/coverage/handoff/SDK/provider/deps/Durable API/缓存前缀；未 commit/push；未 spawn worker；工作区保持 dirty。

## 8. 补充取证（协调者跟进指认核实，全部只读）

- **`/tmp/fe4-probe.mts` 与 `/tmp/fe4.out` 均不存在**（本次 `ls` 核实）；探针证据只剩 transcript 截断片段与 `~/.grok/sessions/.../terminal/call_*.log` 三份超时堆栈。§2 的残迹分析即为现存全部。
- **旧清理代码危险性属实**（transcript 佐证）：grok 最后一版探针在末尾追加了 `docker ps -aq --filter label=perimeter.gateway` 枚举后对**全部**结果 `docker rm -f` 再 `process.exit(0)`，且以 raw node 无外层看护运行——违反「精确 owned + 自然退出」纪律。同时 NG 的 waitFor 抛错传播在清理执行前中止脚本，故该危险清理在该轮**未执行**；grok 随后手工 `docker rm -f` 了 3 个自己 fe4 泄漏容器（其 date 解析失败未波及历史容器）——与当前仍存活 3 个历史容器（§6）完全一致：既不能推定历史容器曾被批量误删，也不能采信「已清零」声明。
- **R2 报告内部矛盾（指出，不改 reviewer 文件，由 grok 自行纠正）**：`docs/reviews/grok-s2-four-eyes-round-2.md` 前半（本轮主文）已写「439 复现成立、s2-four-eyes 回落 partial」，但其后附加的旧 R1 修复章节仍残留「435 为当前实际总数（427+8）」「Pi 报告的 439 属口径混算，不复现」「s2-four-eyes：partial → implemented」等过时断言，与前半直接冲突。以本轮主文（439×2 复现、partial 待 runtime gate）为准。

## 9. R3 后加固轮（2026-10-15，协调者驳回第三审豁免）

协调者不接受第三审对硬验收条件的三项豁免：①三场景前无条件 preflight 不能证明无预热冷运行；②`process.exit` 不能称自然退出；③cleanup catch 吞错 + 全局 label 数不能证明本 run 清理。本轮按六条要求最小改 `scripts/probes/four-eyes-standalone.ts`（旧哈希 `8389119b2c3d5ebd` → 新 `b25db1168d08b714`），产品源码/tests/SDK/deps/Durable/prefix 零改动。

### 9.1 契约变更

1. **preflight 显式可选且默认关闭**：新增 `--preflight` 旗标；`--scenario ng/git/ctx/all` 默认不再先建任何额外环境（默认运行日志中无 preflight 阶段，仅 manifest 尾部 `preflight: null` 字段）。启用时 manifest 标注 `nonCold: true`——不构成冷启动证据、不算验收 oracle；且 finally 覆盖失败半启动（`cleanupVerification.preflight.confirmed`）。
2. **自然退出契约**：全文 0 处 `process.exit`（grep 可验），统一 `process.exitCode` + return 让事件循环自然排空。所有启动子进程与句柄显式 await 关闭：mock（SIGTERM → 5s 死线 → SIGKILL 升级，`exit` 事件 + exitCode/signal 入 manifest）、每条 WS（close → 5s 死线 → terminate → 等 close 事件）、gateway.close、端口预留 server close。无 unref 活任务、无 Promise.race、无以「外层 timeout 到点」伪装成功——超时一律走失败路径。
3. **精确 owned 台账**：每次 run 的 manifest 按场景登记 gatewayId、own 容器 ID（session.ready 后与清理前两次登记取并集）、mock 子 PID、临时目录、audit 路径；`ownBeforeAfter` 记录 before 环境快照 / own ID 清单 / after 全局计数（**仅环境参考，泄漏判定只看 own ID 逐一核验**）。所有 docker/git/inspect/log 子命令统一 10s 自身死线（`sh()` helper）。
4. **退出码契约**：`0` = 指定场景 oracle 全过 且 own 清理逐一核验 confirmed；`1` = 场景失败；`2` = policy 预检失败；`3` = 未知/缺失 scenario；`4` = own 清理未确认（manifest `pendingReconcile` 记精确 ID）。任一失败路径都不可能报 0。
5. **受控故障注入**：`--inject-cleanup-fault` 故意跳过一个 own 容器的清理 → 实测 exit 4、`pendingReconcile: ["0e8233d5ed7e"]`、oracle 虽过但 cleanupConfirmed=false——证明「清理失败不能 exit 0」。该容器随后由操作者按精确 ID `docker rm -f 0e8233d5ed7e` 对账（非探针瞒报），labeled 计数回落 3（= 历史 3）。
6. **mock 生命周期实证**：每场景 manifest 记 mock 真实 `exit` 事件（本轮全部 `signal: SIGTERM、forced: false`，无升级强杀）、PID 与端口。

### 9.2 本轮运行证据（默认无 preflight，全部全新 OS 进程，外层 bounded runner 180s）

| 运行 | argv（看护外层 `node scripts/bounded-test-runner.ts --timeout 180s` + 内层） | 开始→结束 | 自然 exit | 墙钟 | 结果 |
|---|---|---|---|---|---|
| 故障注入 | `node --experimental-strip-types scripts/probes/four-eyes-standalone.ts --scenario ng --inject-cleanup-fault` | 23:11:49→23:11:50 +0800 | 是（exitCode 4） | ~2.7s | ng oracle 过 + cleanup 故意失败 → 4，pendingReconcile 已对账 |
| all 冷进程 1 | `… --scenario all` | 23:12:03→23:12:07 +0800 | 是（0） | ~5.9s | ng/git/ctx pass，cleanupConfirmed true（3×verified-gone） |
| all 冷进程 2 | `… --scenario all` | 23:12:20→23:12:23 +0800 | 是（0） | ~3.0s | 同上 |
| preflight 诊断 | `… --scenario ng --preflight` | 23:12:46 | 是（0） | ~1.1s | 握手 205ms，manifest `nonCold:true` |
| 用法错误 | `… --scenario bogus` | — | 是（3） | <0.1s | 「未知 scenario」 |

- 四眼专项复验：`node --test tests/four-eyes.test.ts` → 12/12 pass，exit 0（4.9s）。
- 静态：`npm run typecheck` 0；`git diff --check` 0。**无本轮新全量**：439×2 属 r20 历史（无产品改动），不冒称本轮新跑。

### 9.3 证据文件（真实存在路径 + 内容计数，供协调者与 grok 核验；均不删除）

| 文件（绝对路径，`$TMPDIR` = `/var/folders/z6/vyl58kzs68j2dsrm_np0ktkr0000gn/T/`） | 行数 | 字节 |
|---|---|---|
| `$TMPDIR/perimeter-fe-probe/logs/fault-inject-231149.log` | 41 | 2643 |
| `$TMPDIR/perimeter-fe-probe/logs/all-run1-231203.log` | 89 | 5984 |
| `$TMPDIR/perimeter-fe-probe/logs/all-run2-231220.log` | 89 | 5984 |
| `$TMPDIR/perimeter-fe-probe/logs/preflight-diag-*.log` | — | — |
| `$TMPDIR/perimeter-fe-probe/fe-probe-…-bw7z5i/manifest.json`（等每 runId 一份） | — | — |
| `/tmp/usage-test.out`（用法错误样本） | 3 | — |

说明：此前第三审引用的 `/tmp/r21-ng.log` 协调者无法读取；本轮起所有运行日志统一落 `$TMPDIR/perimeter-fe-probe/logs/` 并在报告给出行/字节计数，核验前不清理。

### 9.4 措辞校正（相对上一版报告）

- 240s 挂起根因：维持 **unknown**；pi-env 握手是产品内已知的无界 await、与症状相符，但**不是已证唯一根因**。
- 预热：本机冷进程未观察到预热依赖，**不构成对预热假说的完全证伪**（grok 环境不同）。

## 10. R4 终态顺序修正轮（2026-10-15，grok 第四审唯一 request_changes）

grok 第四审确认真实无 preflight 三场景与 fault 真实 exit 4 成立，唯一 request_changes：探针 stdout 先打印 `exitCode: 0` 再折算 4，且 `naturalExit: true` 属预写自报。本轮最小修正（探针哈希 `b25db1168d08b714` → `772c73ff07e67738`，产品/tests/SDK 零改动）：

1. **终态先算后出**：`main()` 收尾先按既定优先规则（cleanup 未确认 → 4；场景失败/缺场景 → 1；否则 0）计算 `plannedExitCode`，再以**同一值**写 manifest `plannedExit`、打 stdout 终态、赋 `process.exitCode` —— 消除「先打印 0 再折算」窗口。policy(2)/用法(3)/crash(1) 各提前退出点同样先写 `manifest.plannedExit` 再设 `process.exitCode`，缺字段不假成功。
2. **`naturalExit` → `plannedExit`**：不再自报「真实自然退出」；字段语义为「计划退出值」，真实自然退出由外部 bounded runner 的 exit/close 记录佐证（本轮三跑外层实际 exit 0/4/3 与 plannedExit 一致）。未新增 process exit 事件钩子或强制退出。
3. **新鲜验证（外层 bounded runner 180s）**：

| 运行 | 实际 exit | stdout plannedExit | manifest plannedExit | 证据（绝对路径 `$TMPDIR`=`/var/folders/z6/vyl58kzs68j2dsrm_np0ktkr0000gn/T/`） |
|---|---|---|---|---|
| `--scenario all`（默认无 preflight） | 0 | 0 | 0 | `$TMPDIR/perimeter-fe-probe/logs/round5-all-233540.log`（89 行 / 5987B；三场景 pass + own ID verified-gone） |
| `--scenario ng --inject-cleanup-fault` | 4 | 4 | 4 | `$TMPDIR/perimeter-fe-probe/logs/round5-fault-233550.log`（41 行 / 2645B；cleanupConfirmed false，pendingReconcile `195a8540490b`，已按精确 ID `docker rm -f` 对账，labeled 回落 3=历史） |
| `--scenario bogus` | 3 | —（phase 行与 manifest 记 3） | 3 | `$TMPDIR/perimeter-fe-probe/logs/round5-usage-233558.log`（3 行） |

- 静态：`npm run typecheck` 0；`git diff --check` 0。产品零改动：439×2 沿用 r20 历史，不重跑、不冒称本轮全量；本轮无新增产品测试。
- 探针哈希：`b25db1168d08b714`（R3 版）→ `772c73ff07e67738`（本轮终态顺序修正版）。历史 3 容器原样保留；未碰 daemon/用户 workload。
