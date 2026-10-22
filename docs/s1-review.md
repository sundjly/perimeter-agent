# S1 独立审查记录

## 第一轮结论：不通过

编码：Orca agy / Antigravity；审查：协调者。

- Run：`run_8982a7ded6b5`
- 首批任务：`task_b063f9caf5a0` / `ctx_9674820ccab8`，worker 报告 succeeded。
- 修复任务：`task_d8b249b0b73b` / `ctx_04aa060c42eb`，复用同一 agy，未启动第二个编辑者。
- 工作目录：`/Users/sundy/projects/web-articles/perimeter-agent`。
- 未提交、未 push；`docs/handoff.md` 已有修改必须保留。

## 独立验证

首批完成时协调者重新运行：

- `npm test`：379 pass / 0 fail / 0 skip。
- `npm run typecheck`：通过。
- `git diff --check`：通过。

测试通过不等于安全通过。真实 IdP、TLS 反向代理、生产模型、Docker/K8s 出口均未在本轮验证。

## 已反馈并要求修复

| 编号 | 风险及证据 | 接受条件 |
|---|---|---|
| R1 | `RemoteJwks.get()` 先返回已缓存 key，再检查最大过期时间。协调者用本地 HTTP JWKS 成功获取后，将测试时钟推进至 maxStaleMs 之外并使源返回 503，仍得到 `EXPIRED cached key accepted: true` | 超出最大过期时间拒绝已知 kid；允许期限内 stale；覆盖成功缓存后故障、刷新恢复及限频，不仅测试空缓存 |
| R2 | `resolveScope` 只在新建 session 时执行；现有成员可在资源映射撤回后继续 attach/命令/读快照 | 现有资源与每条命令、观察结果都校验服务端授权，撤权有负面测试 |
| R3 | 吊销/登出仅 close socket，没有连接同步失效标识；命令处理没有对应吊销判定 | 同步失效命令和出站数据；覆盖验签在途吊销、迟到快照和关闭期间命令 |
| R4 | `/auth/session` 未设置验签并发、请求 body 和频率边界；配置可含非有限/负数限额，生产 origin 未强制 HTTPS | 有界验签与 body、deadline/限频、失败释放额度；非法配置启动失败 |
| R5 | `closeWith()` 旁路配置化 Outbox；静态文件 lexical 路径校验不覆盖符号链接；特殊成员 key 的一致性缺测试 | 所有应用帧统一限制；静态资源不逃 webRoot；特殊主体不能破坏 metadata |
| R6 | 实施报告声称双重 Cookie/Header CSRF token、角色派生等实际未交付能力，后续阶段也与 handoff 不一致 | 报告准确列出已实现与缺口，包括浏览器 Authorization Code + PKCE、内存吊销和真实部署验证 |

更早一轮还发现测试 fixture 缺少 spawn/MOCK 与 scope callback 签名错误，已反馈并由编码者修复；上述 379 项结果来自修复之后。

## 审查纪律

协调者不替编码者修改实现代码；修复交回同一个 agy。修复完成后重新读实际差异、运行测试和 R1 复现，再更新本记录。只有明确验证的条目可以改为通过，未处理条目不得以“测试全绿”或“后续企业化”消除。

## 第二轮结论：本地增量已验证，企业上线不批准

修复任务已由 worker 报告 succeeded 并结束。协调者在其结束后重新执行：

- `npm test`：386 pass / 0 fail / 0 skip（原基线 368，新增 18）。
- `npm run typecheck`：通过。
- `git diff --check`：通过。
- R1 同一独立复现：`initial key: true`，过期且源返回 503 后得到 `expired key correctly rejected: JWKS 不可用: status 503`。

已核实主要修复：R1 已知 key 过期拒绝、时钟 0 与限频；R2 repo + team 双维度持续资源校验；R3 同步失效与在途吊销检查；R4 HTTPS/limits/body/限频与调用方超时隔离；R5 统一 Outbox、特殊成员 key 和静态符号链接检查。对应负面测试已加入，但不能据此声称所有竞态和真实部署风险都已证明消除。

### 保留事项（不得写成已完成）

1. **底层认证取消/全局并发尚未闭环**：`withTimeout` 隔离迟到结果，但不会取消底层 `Authenticator.authenticate()` Promise；超时释放入口 pending 后，定制 authenticator 的实际未完成工作仍可能累积。HTTP 与 WS 也没有共用实际验签工作账本。内置 RemoteJwks 有有限 fetch 超时/single-flight，并不代表任意适配器具备同样保障。生产接入新适配器前须补可取消接口、实际并发闸和故障测试。
2. **R6 文档校准仍不完整**：实施报告默认 clock skew 写 60s，代码默认 30s；报告的 S2/S3/S4–S7 定义仍与 handoff 不一致。以后阶段以 `docs/handoff.md` 的 S0–S7 表格为准，不以 worker 报告替换规格。
3. **企业门禁未完成**：完整浏览器 Authorization Code + PKCE、持久吊销、真实 IdP/反向代理验证、强文件系统/出口边界、DLP、四眼审批、持久预算/恢复与真实模型成本均未在本轮交付。production 模式名称不证明部署已经安全，默认 local backend 尤其不能作为生产隔离。
4. **长期会话仍待 S5**：快照超出单帧限制会被拒；历史分页/前端重连退避还未补齐，不承诺任意长会话可恢复。

本轮没有 commit/push；worker 停在 idle。已执行 Orca release 决策，运行时因该 terminal 为 external/user-owned 返回 retained（无进程停止动作）；reclaimable 清单为空，没有遗留协调者待清理资源。
