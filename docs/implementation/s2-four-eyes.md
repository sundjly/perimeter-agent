# S2 四眼审批（Four-Eyes Approval / Two-Person Rule）实现与验证报告

> **状态**：已完成 (Completed)，待评审 (In Review)
> **依据**：`docs/handoff.md §5.2` P0 四眼安全检查单及 `coverage s2-four-eyes`；本版含 Grok S2 四眼第一审（`docs/reviews/grok-s2-four-eyes-round-1.md`，request_changes）的最小加固修复
> **最近更新**：2026-10-15（R1 修复轮）

---

## 0. R1 修复轮（2026-10-15）：不可靠 context fail-closed + 审计先于可用 allow

针对第一审唯一 request_changes（不可靠 context 未 fail-closed）及随附已知边界（审计故障后已 commit 的 allow 仍可被 verifyApproved 命中），本轮最小加固，不重开其它已通过能力：

1. **production 请求 fail-closed**：production 模式下高风险请求若上下文不可靠（`gitRevision` 为全零/非 40 位 hex、`policyHash` 全零/非 64 位 hex、`sessionIdentity`/`tenantIdentity`/`repoIdentity` 空、`aclVersion` 非 ≥1 数字），`request()` 直接拒绝且**不创建可批准 pending**；`beforeTool` 先行发出脱敏 `policy.denied` 说明（不含参数原文），不挂 pending 等超时。模式开关由服务端 `mode === "production"` 派生，客户端不可提供。
2. **旧 doc 缺绑定与零值占位分级**：`decide`/`verifyApproved` 区分「字段整体缺失」（旧数据，任何模式一律不可 allow）与「零值占位」（demo 无 git 兼容，`reliable:false` 显式不可靠标记，仅 production 拒），不构成 production 后门。
3. **完整绑定各自比对**：`sessionIdentity`/`tenantIdentity`/`repoIdentity`/`gitRevision`/`policyHash`/`aclVersion` 逐项比对（禁止只存在性检查）；`decide` 时 `getContext()` 读取失败或返回不可靠 context 即 invalidated；`verifyApproved` 在 production 下当前 context 不可靠即拒（request 后 context 丢失在 decide 与 beforeTool 两层都被拒）。
4. **审计先于可用 allow（铁律）**：`decide` 的 allow 路径先写审计，审计抛错则存储置 `invalidated` + waiter 收 false + 抛错；不用 Promise.race/先返回 success 再补写/伪称跨日志原子事务；未完成状态保守失效。非 allow 决策在成功提交后留痕（输掉竞态的一方不留审计记录）。进程重启/重开由 `HarnessHost.open` 的 `expirePending()` 将未决 pending 保守失效。
5. **意图完整性**：`verifyApproved` 对 tool+完整 args 重算 `argsHash` 并与审批记录比对——同 tool/path 但 content 变化被拒；工具名与完整参数属同一意图，客户端事件仍仅含 hash 无原文泄露。

**新增测试（8 → 12 项）**：
- 生产 fail-closed 负控：production + 真 DockerBackend + localhost mock + 无 git 工作区 → 无 approval.request、脱敏 policy.denied、marker 未写、审计无 allow；
- 生产正控：同设置 + 临时 git 真实 HEAD → 真实 B（另一 subject）allow 后容器执行落盘，审计记录真实 allow 决策；
- 跨凭证自批负控（production + 临时 git）：同 subject 换凭证 approve → 自批违规，pending 保留至超时（与既有能力一致），marker 未写；
- 生产失效：request 后工作区 git 上下文丢失 → decide 拒绝、容器不落盘；
- 真实 Durable 存储闭环单测：同 tool/path 不同 content 的 verifyApproved 拒；审计故障注入后直接 verifyApproved 拒、真实 reopen（关sqlite 重开 + expirePending）后 retry 仍拒；跨 session 独立 sqlite 查不到他_session 审批（`未找到审批记录`）。

**既有能力回归同步**：enterprise-s1 两项撤权语义测试（F3-1 revoke / F3-2c revokePrincipal）原依赖 production + git-less 的零值 revision 请求，按新不变量补宿主侧临时 git fixture（语义不变：撤权后 approve 不落盘、4003/4001 断开）；durable fixture（`tests/fixtures/durable.ts`）补非生产完整绑定 `getContext`（显式 `reliable:false`）；`durable-runtime` 先到先得测试的直连 `request` 补绑定 context。

---

依据《生产上线门禁 P0 检查单》对四眼审批的要求：
> **四眼审批**：执行、审批、分享管理拆权限；高风险操作请求者不能自批，自动化无权自批。审批绑定 callId、完整意图 hash、repo/revision、规则版本和 expiry；参数/策略/成员变化使旧审批失效。先到先得不等于四眼。

本系统严格按照第一性原理与 KISS 原则，在运行时内建端到端不可篡改的四眼安全屏障：

```
+-------------------------------------------------------------------------------------------------------+
|                                              网关与运行时边界                                           |
|                                                                                                       |
|  [Owner / Editor]                                    [Approver]                                       |
|         |                                                |                                            |
|   1. 发起 Prompt                                         |                                            |
|         v                                                |                                            |
|  [HarnessHost / Agent]                                   |                                            |
|         | (触发高风险工具)                                 |                                            |
|         v                                                |                                            |
|  [Perimeter Extension]                                   |                                            |
|         | 2. request(callId, argsHash, context, ...)     |                                            |
|         v                                                |                                            |
|  [Approvals Doc / Pending]                               |                                            |
|         | 3. approval.request(带 argsHash，不泄露参数原文) |                                            |
|         +----------------------------------------------->+                                            |
|                                                          | 4. decide("allow")                         |
|                                                          v                                            |
|                                             [Approvals.decide 校验]                                   |
|                                             - 角色必须为 approver                                      |
|                                             - requester !== approver (防自批)                         |
|                                             - requesterPrincipal !== approverPrincipal (跨凭证防自批)  |
|                                             - approver !== "system" (禁自动服务代批)                   |
|                                             - context.gitRevision / policyHash / aclVersion 一致性校验  |
|                                                          |                                            |
|         +------------------------------------------------+                                            |
|         v                                                                                             |
|  [Approvals.verifyApproved 双重核验]                                                                  |
|  - 再次核对 argsHash、HEAD revision、policyHash、aclVersion                                            |
|  - 失败则立即阻断 (block) 并记录审计                                                                   |
|         v                                                                                             |
|  [安全隔离容器 / 实际执行]                                                                             |
+-------------------------------------------------------------------------------------------------------+
```

---

## 2. 关键能力实现详述

### 2.1 角色能力拆分矩阵（RBAC）
在协议与网关中扩展四类正交角色：
- **`owner`**：会话创建者，拥有完全会话控制权与成员管理（`share`/`unshare`），可提交 `prompt`/`steer`/`abort`。**严禁审批自己的任务，严禁修改本人角色为 `approver` 规避自批**。
- **`editor`**：协作开发者，可提交 `prompt`/`steer`/`abort`。**无权审批**。
- **`approver`**：独立审批人，仅可接收审批事件并提交 `approve` 决定（`allow` 或 `deny`）。**无权发起 `prompt`/`steer`/`abort`，无权管理 `share`**。
- **`viewer`**：只读参与者，仅可同步快照与事件。

### 2.2 防自批铁律（Anti-Self-Approval）
1. **直接自批阻断**：操作发起人（`requester`）提交 `approve allow` 决策时，服务端立即抛错拦截。
2. **跨凭证/多主体同一人自批阻断**：基于 IdP 认证规范提取真实自然人主体标识（`${issuer}|${subject}`）。同一自然人即使使用不同凭证、切换不同客户端账号（例如开发凭证与管理员凭证），只要底层 `principal` 主体一致，均判定为自批违规并严加阻断。
3. **自动化服务代批阻断**：服务身份（`system`）仅允许在超时或失效时执行 `deny`/`expire`，严禁代批 `allow`。

### 2.3 意图与上下文双重核验（Double-Check Binding）
- **意图 Hash 绑定**：持久化规范化 `argsHash`（SHA-256），原始参数仅留存在受控服务端，前端与审计日志仅下发 hash，防止未授权查看敏感输入或中间人篡改。
- **上下文版本绑定**：审批记录与租户上下文强绑定：`sessionIdentity`、`tenantIdentity`、`repoIdentity`、`gitRevision`（当前工作区 HEAD）、`policyHash`（策略规则 SHA-256）、`aclVersion`（成员变更单调版本号）。
- **双重核验时机**：
  1. **第一重（Decide 决策时）**：核对决策人角色、防自批、当前上下文版本。
  2. **第二重（BeforeTool 执行前）**：工具真正下发沙箱前，再次执行 `verifyApproved()` 核验工作区 HEAD 与 ACL 版本。若期间发生代码提交、分支切换或成员增删，审批立即失效并终止工具执行。

---

## 3. 代码变更清单

| 文件路径 | 变更说明 |
|---|---|
| `src/protocol/types.ts` | 扩充 `Role` 联合类型新增 `"approver"`；`share` 命令与审批事件支持 `approver` 与 `argsHash` |
| `src/protocol/validate.ts` | 校验函数更新 `share` 命令参数，严格约束 role 取值范围 |
| `src/runtime/approvals.ts` | 审批记录持久化绑定意图 hash 与完整上下文；`decide` 落实角色核查、防自批、跨凭证主体校验；实现 `verifyApproved` 执行前二次核验；R1 轮：production 请求 fail-closed、缺失绑定/零值占位分级校验、审计先于可用 allow（故障保守失效）、argsHash 全量意图比对、非 allow 提交后留痕 |
| `src/runtime/perimeter-extension.ts` | `beforeTool` 注入上下文与主体；工具执行前紧密调用 `verifyApproved` 双重核验；R1 轮：production 上下文不可靠时先行脱敏拒绝（不创建 pending） |
| `src/runtime/harness-host.ts` | 派生真实 `actorPrincipal` 与 `getContext`，会话快照补全 `argsHash` 与 `requester` |
| `src/gateway/session.ts` | 维护 `aclVersion`；派生真实 `ApprovalContext`（含 HEAD revision 获取）；拦截非授权命令 |
| `src/gateway/server.ts` | 元数据持久化 `aclVersion`；成员变更时自增版本并失效在途审批；严格区分执行命令与审批命令；派生 `${issuer}\|${subject}` 保证跨凭据防自批有效 |
| `web/app.js` & `scripts/attach.ts` | 前端界面与 CLI 仅允许 approver 看到并点击审批按钮，仅允许 owner/editor 发送任务命令 |
| `tests/four-eyes.test.ts` | 四眼审批专项集成测试（R1 轮后 12 项），覆盖正反向、production 真 DockerBackend 正负控与真实 Durable 存储审计闭环 |
| `tests/enterprise-s1.test.ts` / `tests/durable-runtime.test.ts` / `tests/fixtures/durable.ts` | R1 轮回归适配：撤权语义测试补临时 git fixture；durable fixture 补非生产完整绑定 context；先到先得测试补绑定 request |

---

## 4. 验证结果

### 4.1 四眼专项测试 (`tests/four-eyes.test.ts`，12 项)
```
✔ 四眼审批正向流：owner 提交 prompt，通过 share 授权独立 approver，由 approver 批准后高风险工具正常执行
✔ 防自批铁律：requester 严禁自批（owner 发送 approve 立即被拒，工具不执行）
✔ 生产 fail-closed：production + DockerBackend + 无 git 工作区，高风险请求直接拒绝且不创建可批准 pending
✔ 生产正控：同设置临时 git 真实 HEAD，真实 B（另一 subject）批准后容器执行落盘
✔ 防自批铁律：同一主体换不同凭证（同 subject）自批被拒绝（production + 临时 git）
✔ 生产失效：request 后工作区 git 上下文丢失，decide 拒绝且容器不落盘
✔ 角色能力矩阵：owner 只能 share 别人，严禁将本人角色更改为 approver 规避自批
✔ 角色能力矩阵：approver 角色禁止发起 prompt、steer 或 share，只读 + 审批
✔ 意图与上下文绑定：客户端事件与审计不泄露敏感参数原文，仅包含规范化 argsHash
✔ 意图与上下文绑定：成员变更（ACL 变动）使在途审批立即失效
✔ 意图与上下文绑定：工作区 HEAD 发生变更使审批二次核验失败并阻断执行
✔ 意图绑定与审计故障闭环（真实 Durable 存储）：args 变更拒、审计失败不留可用 allow、真实 reopen 后 retry 仍拒、跨 session 不复用
ℹ tests 12  pass 12  fail 0  cancelled 0
```
（原「同一主体 principal 换不同凭证」测试由 git-less production 升级为临时 git fixture 版本，断言不变。）

### 4.2 全量集成与静态检查（R1 修复轮实测，2026-10-15）
- **`npm run test:serial`**：439 tests / 439 pass / 0 fail / 0 skipped / 0 cancelled，exit 0（自然退出），真实墙钟 **185s**（上限 1500s）。
- **`npm run test:bounded`**：439 tests / 439 pass / 0 fail / 0 skipped / 0 cancelled，exit 0（自然退出），真实墙钟 **130s**（上限 1500s）。
- **argv 变更披露**：两脚本看护死线 `--timeout 900s` → `--timeout 1500s`（`package.json`）。原因：四眼专项 8→12 项含 4 项真 DockerBackend production 链路、enterprise-s1 两项撤权测试补真实 git fixture，套件合法增长；实测墙钟（130–185s）远低于新上限，扩容仅防资源争用噪声误杀，非掩盖慢测试。其余 argv 不变。
- **owned 容器**：serial/bounded 各一次前后均为 0；孤儿 mock-model / runner 进程 0。
- **`npm run typecheck`**：0 错误；**`git diff --check`**：0 异常。
- **文件 SHA-256（前 16 位）**：`approvals.ts` `8307708ff8222371`、`perimeter-extension.ts` `0d5a245f44677c60`、`session.ts` `1d5b1f17745b630d`、`four-eyes.test.ts` `5c77043eaf81bcd4`、`enterprise-s1.test.ts` `6affd84ba9739d79`、`durable-runtime.test.ts` `3915aeddef1180f6`、`tests/fixtures/durable.ts` `c26a967ad4b88cba`。
- **边界披露**：fixture/测试的临时 git 提交均在系统临时目录的自有 fixture 内；主仓库未 commit/push，未改 SDK/provider/deps/Durable/缓存前缀，未 spawn worker，无 Docker context/daemon 侵入与真实凭证外发。
