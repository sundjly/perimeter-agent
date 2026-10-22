# s2-path-guard-cancellation-plan.md — 路径守卫真实取消设计（待协调者决策，未实施）

> **【决策与实施注记 2026-10-16】** 协调者已选 **B 方案** 并授权最小执行切片；已实施完成，实施与证据见 `docs/implementation/s2-path-guard-exec-helper.md`（其中 §3 逐条落实 R3 三点修正）。本文保留为原始设计记录；原文中「~10ms/~100ms 量级」为无基准参考，实施报告已按 R3 纠正不再作为机制事实引用。

- 日期：2026-10-15；作者：Pi（task_5afa5a9b09a8 / ctx_669287a061f1）
- 性质：设计文档。本轮已完成的源码改动仅 errCategory 白名单（见 §4）；本设计**未实施**，待协调者决定后另发编码包。

## 1. 协议与实现事实（本轮完整核对 node_modules/@earendil-works/pi-env/docs/protocol.md、semantics.md、connection.js）

1. `protocol.md §Cancellation`：`exec` 的 cancel **kills the command's process group** 并以 `aborted` 收尾；`{mode:"kill"}` 同样杀进程组；**Other operations are short and finish normally** —— realpath 属 Other operations，**CANCEL 不会停止它**。
2. `connection.js #send`：`options.signal` 的 onAbort **只写 CANCEL 帧**，客户端 Promise **不立即 reject**，等待真实 result/error 帧。
3. 结论：**「SDK 一行 signal 就可取消 in-flight realpath」不成立**（此前 slice-a 报告该说法已撤回）。在途 realpath 取消门槛 = **blocked**，不是「下一包可选建议」。等待器侧的 `awaitWithContext` 有界等待只保证守卫及时失败，底层只读 realpath 会自然跑完、随连接关闭终止——当前实现已如实标注该边界，不声称已取消。

## 2. 不改 SDK 的最小真实取消设计：同 ExecutionEnv.exec 的一次性规范化 helper

利用协议保证的 **exec 取消 = 杀进程组 + `aborted` 收尾**：

1. **一次 exec 解析全部**：对每次路径守卫，用同一 `ExecutionEnv.exec`（argv 形式，无 shell 拼接、无命令注入面）运行一个**静态**小 helper：`node -e <固定代码> -- <workspaceRoot> <rawPath>`。helper 只做路径规范化：root=realpath(workspaceRoot)、target 按 pi 同语义解析（`~`→HOME、`file://`→fileURLToPath、绝对/相对+cwd）、不存在则向最近存在祖先有界回溯（共享该次 exec 的总预算），stdout 只输出 `{canonical}` / `{error:<类别>}`（类别 token 与守卫白名单一致），**不输出任何路径/宿主信息**。
2. **真实取消**：`exec options.timeout` 到点或 ctx abort → 协议杀 helper **进程组** → 客户端收到 `aborted`（await 最终 response/exit，不 race-return）。实现轮必须给可控 non-responding helper 的**真实 kill 证明**：exec 结果为 aborted + `ps` 确认进程组消失，非仅前端 deny。
3. **边界与代价（如实）**：每守卫一次进程 spawn（本地 ~10ms 量级、docker exec ~100ms 量级——机制描述，不做无基准性能断言）；镜像 `FROM node:22.19-alpine` 自带 node（已核 Dockerfile），helper 静态代码走 argv 无需安装路径；Local 走 `process.execPath`。K8s/Pod 侧 exec 为 kubectl exec、客户端超时杀 kubectl 进程——服务端 Pod 内 helper 是否被杀**未在真实集群验证**，列为 unknown。
4. **失败类别**：exit 0 → canonical；非 0/超时/abort → deny（fail-closed），类别映射 exec 结果码（aborted/killed/exitCode≠0→invalid），路径内容不出现在任何诊断。
5. **不继承敏感环境**：helper 只需 PATH/HOME；沿用现有 exec env 消毒（DOCKER_CLIENT_KEYS 剔除已存在），无新增 secret 注入。

## 3. 与现状的取舍

| | 现状（canonicalPath RPC） | 本设计（exec helper） |
|---|---|---|
| 在途取消 | 不可取消（Other operations short finish） | 进程组被杀，`aborted` 收尾（协议保证） |
| namespace | 容器/Pod 视角（正确） | 同一 exec 环境（正确） |
| 新建文件回溯 | 客户端 N 次尝试 | helper 内一次完成，共享总预算 |
| 代价 | 1 次 RPC | 1 次进程 spawn |

## 4. 若 exec 语义仍不够（边界声明）

需「会话专属隔离 + 关闭等待」设计：守护进程级 helper 常驻 + 显式 ack/退出证明，涉及 daemon 生命周期与跨会话资源归属——协议 Liveness 仅保证「stdin 结束/断连 30s 后 daemon 杀全部进程组退出」，单请求粒度的关闭证明无现成 API。该方向需要 SDK/协议扩展，本轮不实现、不擅自造 provider。

## 5. 决策请求

协调者在两案间选择：A) 维持现状（RPC + awaitWithContext 有界等待 + 边界标注，已实现）；B) 实施本设计（exec helper，真实取消）。B 的实现包预计触及 `harness-host.ts`（helper 调用）/`perimeter-extension.ts`（守卫改调 helper）/新增 `tests/`（含 non-responding kill 证明），预计规模与本切片相当。
