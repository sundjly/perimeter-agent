# Grok S2 四眼审批第二审

- 结论：`request_changes`（限定：源码与套件证据支持修复成立，但独立 runtime 门槛未放行——生产容器场景在我的独立环境 240s 内 session.ready 不至，两项历史 unverified 项未闭环；s2-four-eyes 回落 partial 待独立 runtime 复验）
- 日期：2026-10-15
- 审查者：grok（唯一 reviewer；Pi 交接后首审）
- 对象：`src/runtime/approvals.ts` `8307708ff8222371`、`src/runtime/perimeter-extension.ts` `0d5a245f44677c60`、`src/gateway/session.ts` `1d5b1f17745b630d`、`tests/four-eyes.test.ts` `5c77043eaf81bcd4`。基线是 `docs/reviews/grok-s2-four-eyes-round-1.md`。
- 允许写入：本文件与 `docs/reviews/handoff-coverage.json`。未改实现、测试、docs 其它、SDK，未 commit / push / spawn 新 worker。

## 执行口径纠正（coordinator transcript 核查成立）

round-3 补验节的六轮全量实际全部为**默认并发**：我的 deadline helper 只执行了 `node --test --test-reporter=spec $f`，未传 `--test-concurrency=1`，「串行 3 轮」标注错误。默认并发的六轮 417/417/0 结果保留有效；真串行门槛当时按 unverified 处理。同节对临时看护缺陷（setsid 未生效、PGID 落父组）的披露保留。

## 435 vs 439：历史与当前分开

- 我此前两轮全量实测 435 的**原始日志已在收尾清理中删除**，无法从现存证据解释 435 的构成，也不再复用该数字。
- 本轮新鲜完整复测（外层/内层均为已批准 bounded runner，deadline 启动前确定，唯一 runId 日志 `/tmp/r20-serial.log` 与 `/tmp/r20-bounded.log`）：`npm run test:serial` 与 `npm run test:bounded` 各一次，均 **439 tests / 439 pass / 0 fail / 0 skipped / 0 cancelled，exit 0 自然退出**。Pi 报告的 439 复现成立；我此前的 435 按过期数据处理，且不据此指认任何一方错误（4 项差异最可能对应四眼 8→12 中的 4 项 production 链路测试在我当时环境的注册差异，但已无日志可证）。
- 12 项四眼专项确实包含于 439 之内（serial 日志逐名核对 12 项标题全命中）；套件内 production 真容器链路 4 项（无 git fail-closed、临时 git 正控、同 subject 跨凭证、上下文丢失）全部绿。
- `npm run typecheck` 0；`git diff --check` 0；源码哈希复测与报告一致（approvals `8307708f…`、extension `0d5a245f…`、session `1d5b1f17…`）。

## 独立 runtime 门槛：未放行（unverified）

以仓库真实 policy（package.json 命中 require_approval_paths）与真实 DockerBackend(none) 在独立进程做三场景生产链探针，两轮尝试：

- **git-less 负控**：容器创建并 Up，但 240s 内无 session.ready（空事件），policy.denied/approval.request 均未出现，探针未完成 → **unverified**。
- 临时 git 正控与上下文丢失负控：同样止于 session.ready 未至。
- 对照：套件内同流程（four-eyes production 4 项）在 17–18s 的全量里通过；我的独立环境容器 Up 但握手不完成，差异根因在 15 分钟诊断上限内未能定位（疑似首容器冷启动/握手依赖套件前序用例的预热）。
- 本轮探针 own 容器已按精确 ID 清理；3 个更早（13:56–14:01）的 owned 遗留容器登记保留；probe mock 进程已精确清零。

因此：**runtime gate 未通过，不能以套件绿推定独立生产链已验**；s2-four-eyes 从 implemented 回落 `partial`，待 Pi/下一轮给出 standalone 可复现的 session.ready 契约（或文档化预热要求）后重放三门场景。

## R2 修复本体核验（源码 + 套件证据，维持成立）

`isContextReliable`（production 六字段非空/非全零/aclVersion≥1、`reliable:false` 一票否决）；request 拒建 pending；decide/verifyApproved 对缺绑定（任何模式）与零值占位（production）失效或拒；六字段逐一比对漂移即 invalidated；argsHash 含 tool+完整 args；审计故障注入（真实 Durable SQLite）→ 抛错、waiter false、存储 invalidated、真实 reopen 后 retry 仍拒、合法 allow 仍在、跨 session 不复用；args 变更（同 tool/path 不同 content）verifyApproved 拒；`isProduction` 由服务端 mode 派生。以上由 12 项四眼测试（含 4 项 production 链路）在 439 口径内全绿背书。

## 台账与边界

- `s2-four-eyes`：`implemented` → `partial`（runtime gate unverified；源码与套件证据保留）。
- S2 其余 DLP/repo-token/敏感路径/symlink/本地 egress 仍 missing/partial；真实 CNI/客户批准 external；企业生产不批准；下一编码包暂停，先解 runtime 门槛。

## 下一最小包

1. 定位 standalone 生产容器 session.ready 挂起根因（或在 runner 文档化容器预热契约与就绪超时常量），使四眼 production 4 项在独立进程环境可稳定复现。
2. 修复后由 reviewer 重放：git-less 拒（policy.denied + 无 pending + 无 marker）、临时 git 正控（B allow → package.json 落盘）、上下文丢失负控（decide/verify 双拒），加 439×2 全量。


## R1 缺口（不可靠 context 未 fail-closed）的闭合核验

源码 + 测试双路确认，fail-closed 链条在生产模式全链生效：

- `isContextReliable(ctx, isProduction)`：production 要求 session/tenant/repo 非空、gitRevision 为 40 位非全零 hex、policyHash 为 64 位非全零、aclVersion≥1；`reliable === false` 一票否决；demo（非生产）返回 true 保持兼容。
- `request()`：`isProd && !isContextReliable` → **直接 return false，不创建可批准 pending**（不 emit approval.request）。
- `decide()`：snapshot 缺任一绑定字段（任何模式）→ invalidated「旧数据不可批准高风险」；production 零值占位 → invalidated；getContext 缺失/不可靠 → invalidated「当前工作区上下文不可靠」；session/tenant/repo/HEAD/policy/acl 六字段逐一与审批时快照比对，任一漂移 → invalidated。
- `verifyApproved()`：缺绑定（任何模式）拒；production 零值占位拒；production 且当前 context 不可靠拒；六字段逐一比对；argsHash（含 tool 与完整 args）比对拒内容篡改；过期与自批二次比对。
- `isProduction` 由服务端 mode 派生（`mode === "production"`），非客户端可控；`reliable` 标志由服务端 getContext 依据真实 git 读取结果设置。

## 审计故障闭环（真实 Durable SQLite，Pi 新增测试独立复核）

`tests/four-eyes.test.ts` 第 447 行起的专项：真实 `Harness.open` + SQLite 存储 + 故障注入私有审计回调——成功对照（B allow 恰好一次可执行 allow）→ 审计故障注入：decide 抛「审计…fail-closed」、waiter 收 false、存储条目 invalidated、`verifyApproved` 拒 → **真实关闭并 reopen 同一 sqlite**：invalidate 持久、retry 不产生可用 allow、合法 allow 仍在 → 跨 session（独立 sqlite）不复用他_session 审批。decision 意图记录与执行成功区分清楚：verifyApproved 只认持久化 allow，审计先写/commit 失败不会留下可用 allow（allow 路径审计成功先于 commit，失败即保守 invalidated）。

## 既有能力回归

跨凭证自批（同 subject 不同 token）、自批、system 代批禁令、角色矩阵（approver 禁 prompt/share、viewer 只读、owner 自 share/自改拒）、撤权联动（decide 复核 isAuthorized）、成员/策略/HEAD 变更失效、expiry——源码路径保留且 435 全量含 12 项四眼测试全绿。SDK/Durable API/缓存稳定前缀无接口变化（本轮 diff 未触及导出面）。web/CLI 仅为表现层，权限在服务端强制（approve 路由 role==="approver" 双重门）。

## 独立全量复测（bounded runner，内部 deadline 1500s 启动前确定）

| 模式 | exit | tests | pass | fail | skipped | 墙钟 |
|---|---|---|---|---|---|---|
| `npm run test:bounded`（默认并发） | 0 自然 | 435 | 435 | 0 | 0 | ~18s |
| `npm run test:serial`（concurrency=1） | 0 自然 | 435 | 435 | 0 | 0 | ~64s |

- **【已撤回，2026-10-15 第三轮纠正】** 本节 435 总数与「Pi 439 属口径混算，不复现」的断言**撤回**：当日原始日志已在收尾清理中删除、无法重构；第三轮新鲜复测 serial 与 bounded 均 **439/439/0**（runId `r20-serial`/`r20-bounded`，日志 `/tmp/r20-serial.log`、`/tmp/r20-bounded.log`），Pi 的 439 复现成立。435 的构成无法从现存证据解释，按过期数据处理。下表 435 历史数字保留仅为审计痕迹，不代表当前事实。
- owned 容器 0；无残留 `node --test`/mock 进程；`npm run typecheck` 0；`git diff --check` 0。
- 哈希：approvals `8307708ff8222371`、perimeter-extension `0d5a245f44677c60`、session `1d5b1f17745b630d`、four-eyes 测试 `5c77043eaf81bcd4`。

## 台账与边界

- **【已撤回，2026-10-15 第三轮纠正】** `s2-four-eyes`：`partial` → `implemented` 的升格**撤回**（当时 runtime gate 未放行）。第三轮 standalone 门槛通过后已按实证重新升为 `implemented`，见 `grok-s2-four-eyes-round-3.md`。
- 真实模型质量/成本/SLA、真实 CNI/客户批准仍 external unknown；S2 其余 DLP/repo-token/敏感路径/symlink/本地 egress 仍 missing/partial；S3/S4 按依赖不受阻；企业生产不批准。
- 遗留（非本包）：demo 模式 git-less 工作区的审批绑定按设计为 `reliable:false` 宽松兼容（仅 demo）；若未来 demo 与 prod 共享工作区形态，需重新评估。
