# Grok S2 四眼审批第一审

- 结论：`request_changes`（限定一项：不可靠 context 的 fail-closed 缺失。四眼机制本体——角色矩阵、防自批、意图绑定、双重核验、失效路径——经真实管道独立复验全部成立）
- 日期：2026-10-14
- 审查者：grok（唯一 reviewer）
- 对象：`src/runtime/approvals.ts` `5289fadb2233589a`、`src/runtime/perimeter-extension.ts` `eb3e47bade3e970c`、`tests/four-eyes.test.ts` `826ed8aba4a07f04` 及 session/server 的四眼接线。依据 handoff §5.2 四眼条目与 `docs/implementation/s2-four-eyes.md`。
- 允许写入：本文件与 `docs/reviews/handoff-coverage.json`。未改实现、测试、docs 其它、SDK，未 commit / push / spawn 新 worker。

## 独立行为复现（真实 Gateway + Harness + 本地 mock 工具链 + 临时 git fixture，8 场景全过）

| 场景 | 结果 |
|---|---|
| owner 发起高风险（marker-1.txt 命中 require_approval_paths），share 独立 approver B，B allow → 容器/落盘执行 | ✓ marker 落盘；editor 对非审批路径（notes-editor.txt）免审批直写 ✓ |
| owner 自批（approve allow） | ✓ 立即「无权审批」，marker 不落盘；随后真实 B allow 仍可执行（pending 未被破坏） |
| 跨凭证自批（production + 真实 DockerBackend 容器执行）：同 subject 不同 token 的第二凭证被 share 为 approver 后 allow | ✓ 「自批违规」拒绝，marker 不落盘；真 B（不同 subject）allow 后容器内落盘成功 |
| 角色矩阵 | ✓ approver prompt/share 均拒；viewer prompt 拒（服务端网关层「无权执行命令」）；owner 自 share/自改成员拒；viewer/非成员 approve 拒 |
| 过期（approvalTimeoutMs=600ms） | ✓ 自动 deny（expired），marker 不落盘 |
| 策略变更（请求后改 policy 文件） | ✓ decide 时 policyHash 漂移 → invalidated，「审批意图上下文已失效」 |
| 成员变更（请求后 share eve，aclVersion++） | ✓ aclVersion 漂移 → invalidated |
| argsHash 脱敏 | ✓ approval.request 只带 argsHash，原文不出现在客户端事件 |

仓库 `tests/four-eyes.test.ts` 8/8 通过，与我的独立复现一致。

## 绑定与重核的实现核验

- 绑定内容：argsHash = 全量 rawArgs 的 SHA-256（非仅 tool/path）；持久化字段含 callId、sessionIdentity、tenantIdentity、repoIdentity（配置真实 repo/team）、gitRevision（真实 `git rev-parse HEAD`）、policyHash（policy 文件全文哈希）、aclVersion、expiresAt、requester/requesterPrincipal。
- 双重核验：decide 时（角色/自批/HEAD/policy/acl 漂移→invalidated）+ beforeTool 真实 dispatch 前 `verifyApproved`（argsHash、HEAD、policy、acl、过期、自批二次比对，任一不符 block）。
- 撤权联动：decide 时 `isAuthorized(requester)` 复核 → 撤 A 后 B 的 allow 变 expired；share/unshare 即 `expirePending()`。deny/timeout/expired 均不构成 allow 旁路（waiter 收 false，verifyApproved 要求 status==="allow"）。
- 跨会话/重放：ApprovalsDoc 挂在每个会话自己的 Durable 根（session.sqlite），跨会话查不到他_session 的 item；同 callId 重复 dispatch 走 verifyApproved 幂等核验。
- 服务端不信任客户端：actor 由连接身份服务端派生，role 由服务端成员表 `getRole` 派生，argsHash 由服务端对真实 action 计算；web/CLI 仅表现。

## 缺口（request_changes 最小包）

**不可靠 context 未 fail-closed**：`request()` 在 context 缺失时回退 `gitRevision = "0"×40`、`policyHash = "0"×64`、空 repoIdentity；`decide`/`verifyApproved` 的漂移检查在 context 缺失时整段跳过。git-less 工作区（临时 fixture 即是）两次都得到全零 revision，HEAD 绑定与漂移检测形同虚设——正是「不能固定 unknown repo/revision，prod 缺可靠 context 拒高风险」要防的形态。最小修复：production 模式下高风险请求若 `gitRevision` 为全零或 `repoIdentity` 为空 → request 即拒（fail-closed），并在 approval.request 事件标注 context 不可靠；另补一条 args 变更（同 path/tool 不同 content）在 verifyApproved 被拒的负测。

不影响本轮结论的既有事实：git 仓库工作区内 HEAD/策略/ACL/过期失效路径全部真实生效；审计故障时的 in-flight 行为 fail-closed（waiter 收 false），但已 commit 的 allow 条目仍留在存储中可被 verifyApproved 命中——记为已知边界，随上条一并加固。

## 全量与静态（bounded runner，当前实际总数）

| 模式 | exit | tests | pass | fail | skipped |
|---|---|---|---|---|---|
| `npm run test:bounded`（默认并发，900s deadline） | 0 自然 | 435 | 435 | 0 | 0 |
| `npm run test:serial`（concurrency=1，900s deadline） | 0 自然 | 435 | 435 | 0 | 0 |

435 = 427 + 8 项四眼专项。owned 容器 0；`npm run typecheck` 0；`git diff --check` 0。哈希：`approvals.ts` `5289fadb2233589a`、`perimeter-extension.ts` `eb3e47bade3e970c`、`four-eyes.test.ts` `826ed8aba4a07f04`。

## 台账与边界

- `s2-four-eyes`：新增条目 `partial`（机制与测试真实成立，唯不可靠 context fail-closed 缺失 + args 变更负测未补）。不与 DLP/repo-token/敏感路径/egress/S3/S4 或真实 CNI/客户批准混算——那些仍按既有 missing/partial/external。
- 企业生产不批准。修复上条后 s2-four-eyes 可升 implemented。
