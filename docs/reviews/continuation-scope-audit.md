# continuation-scope-audit.md — 可实现未完功能有限切片审计（S2–S6；只读源码 + handoff §3–8 对照；task_07a995db9f06）

- 日期：2026-10-18；审者：Grok（唯一 reviewer，原终端/模型复用）。性质：**只读审计**——读 docs/handoff.md §3–§8 与目标源码（gitproxy/modelgw/secrets/session/path-guard/audit/attach/serve 关键段/tests 清单），零运行、零产品/测试/SDK/build/progress 写入；Pi 正在新 task 做 repo SDK teardown 最小修复+有界回归，本审计与其零并发写入，**所有切片在 Pi 该修复落地前不得触碰 SDK/vendor/session-pin 测试面**。
- 本文件是本轮唯一 repo 写入；不改 coverage/旧报告/旧 root/实现。旧边界原样保留：54m57s node 终止状态 unknown（新授权/新 PGID 不作退出证明）；§18.4 历史原状不洗；r9 三 required 已闭不再循环。
- 方法：每项按「代码缺失 / 代码已有 / 测试缺失 / 客户外部缺失」四态判定，给路径+最小验收+可复用测试；**反对过度设计**：每片 ≤1 个模块 + 1 个测试文件增量，先扩展既有 tests 再新增。

## 0. 切片总览（顺序即依赖序；每片独立可审）

| 批 | 阶段 | 切片 | 依赖 | 外部阻塞？ |
|---|---|---|---|---|
| B1 | S2 | 敏感读统一+hardlink/TOCTOU 加固（path-guard 扩展+deny_reads） | 无（SDK 修复落地后） | 否（本地可测） |
| B2 | S2 | gitproxy 会话/repo/ref scoped 短期 token+吊销 | 无 | 否 |
| B3 | S2 | DLP block 模式+对照集；modelgw redirect=error | 无 | 否（真实 DPA 除外） |
| B4 | S3 | 显式 create+持久 receipt（operationId/requestHash/stage/outcome） | 无 | 否 |
| B5 | S3 | stateRoot 独占锁+/readyz/SIGTERM 限时 drain | B4（drain 报 receipt 态） | 否 |
| B6 | S3 | 磁盘满/restore 一致性负面测试 | B4/B5 | 否 |
| B7 | S4 | modelgw body 上限+四级 deadline+abort/drain+上游并发闸 | B4（operationId 贯穿） | 否 |
| B8 | S4 | 持久 reserve→settle/release 预算账本+usage_unknown+重启恢复 | B7 | 真实价格=外部 |
| B9 | S5 | snapshot tail 分页+游标（server/session/view/CLI 同改） | B4 | 否 |
| B10 | S5 | CLI create/list/inspect/wait/archive+机器 JSON+稳定退出码 | B4/B9 | 否 |
| B11 | S5 | 冷/热/重启恢复基准组（复用 s0 benchmark-runner，mock 模型） | B8/B9 | 真实成本=外部 |
| B12 | S6 | 部署证据工具：probe 接线/SBOM+扫描脚本/备份恢复演练脚本/审计链头导出 | B1–B11 | 客户签字=外部 |
| — | S7 | **严格保留**：S6 完成+单节点瓶颈实测前不做任何路由/fencing/多 SCM/扩容工作 | S6 | — |

## 1. S2（三片）

### B1 敏感读+hardlink/TOCTOU（`src/runtime/path-guard.ts`、`src/policy/engine.ts`、`config/policy.yaml`）
- 现状：canonical 守卫已存在且 fail-closed（path-guard.ts:52-100 helper、:118-165 execGuardHelper，24 项 exec-helper 测试）；**缺口**=①helper 只有 realpath，无 hardlink（nlink>1）识别；②只读工具整体豁免 deny_paths（config/policy.yaml:10 注释、README:66 自认 bash 不成立）；③check-then-use 窗口（canonical 在 exec 前解析）。
- 最小改法：①helper 增加 `fs.lstatSync` 的 nlink/uid 输出字段（协议白名单同步加），守卫对命中 deny 路径的 hardlink 拒绝；②新增 `deny_reads` 规则键，读类带 path 工具（read 等）走同一 resolver+同 fail-closed；③bash 局限**如实保留**（redteam.test.ts 断言不删），真边界=容器只读挂载保护路径（进 B12 部署面，不在进程内假装）。
- 最小验收：新增用例——deny 路径 hardlink 写拒绝、deny_reads 对 read 工具拒绝、symlink/ELOOP 既有用例保持绿；bash 豁免断言原样（诚实边界）。
- 可复用：`tests/path-guard-exec-helper.test.ts`、`tests/protected-paths.test.ts`、`tests/redteam.test.ts`。

### B2 gitproxy scoped token（`src/gitproxy/server.ts`）
- 现状：已有 repo allowlist（:104-111）、push 显式开关（:124-128）、方法/参数白名单、审计脱敏（redactUrl）；**缺口**=单一共享会话 token（:28,:183-191）+组织级静态凭据（:13-16），无租户/session/repo/ref/rw 维度、无 TTL、无吊销。
- 最小改法：会话 token 改为派生短期凭证 `HMAC(master, tenant|session|repo|rw|exp)`，#authorized 校验五元组+exp+吊销集合；ref/分支保护仍归上游（不在代理重造）。
- 最小验收：跨 repo/跨 session/过期/吊销 token 全拒；read token 推送被拒；既有 allowlist/push 用例保持绿；日志无 token。
- 可复用：`tests/gitproxy.test.ts`、`tests/git-e2e.test.ts`。

### B3 DLP block+redirect（`src/modelgw/server.ts`、`src/modelgw/secrets.ts`）
- 现状：scanSecrets 规则集已有且与 SIEM 导出共享（secrets.ts:23-34）；网关仅 audit-only（server.ts:179-189，注释声明等误报率数据）；上游 fetch 无 redirect 控制（:222；对照 auth.ts:208 JWKS 已 `redirect:"error"`）。
- 最小改法：①配置 `dlp.mode: audit|block`（默认 audit 不变性行为），block=上游 fetch 前命中高置信规则→403+审计+固定类别（不改写流）；②误报/漏报对照集 fixtures（含 commit sha/base64 夹具等历史误报源）；③上游 fetch 加 `redirect:"error"`+`signal`（signal 归 B7）。
- 最小验收：block 模式高置信 secret 出站被拒且请求未达上游（fetchImpl 断言）；audit 模式行为逐字节不变；对照集双态跑绿。
- 边界：真实误报率/零留存/DPA/私网端点=客户外部，绝不因 block 模式上线上宣称 DLP 合规完成。
- 可复用：`tests/modelgw.test.ts`、`tests/upstream-auth.test.ts`、`tests/siem.test.ts`。

## 2. S3（三片）

### B4 显式 create+持久 receipt（`src/gateway/server.ts`、`src/gateway/session.ts`、sqlite 存储）
- 现状：创建仍由 WS attach 隐式发生；`HarnessHost.submit()` 已传 actor+requestId（durable 层有幂等钩子），prompt/steer 已强制 requestId（session.ts:201-204）；**缺口**=无 operationId/receipt 类型与持久存储、无同键异内容拒绝、无跨重启回执一致、无 replay 标记。
- 最小改法：新 `CreateReceipt` 表（operationId/principalId/requestId/requestHash/sessionId/stage/outcome/createdAt），阶段按 handoff §3.1 六态；同 (principal,键) 同 hash→返回原 receipt+audit `replay:true`，异 hash→409；先落 receipt 再执行副作用。
- 最小验收：并发重复 create 一资源一结果；异内容拒绝；重启后 receipt 仍拒重放；目录存在≠完成。
- 可复用：`tests/durable-runtime.test.ts`、`tests/crash-recovery.test.ts`、`tests/gateway.test.ts`。

### B5 独占锁+readyz+SIGTERM drain（`src/gateway/server.ts`）
- 现状：`close()` 收尾次序已有且逐会话容错（:345-368），reaper 并发闸已有（:388-392）；**缺口**=无 stateRoot 独占锁、无 readiness 端点、无信号驱动 drain（现有 close 是显式 API）。
- 最小改法：①stateRoot 下 `O_EXCL` 锁文件含 pid+boot 标识+进程存活检测（stale=进程死才可接管，不按心跳抢）；②`/readyz` 反映策略/凭据/stateRoot/审计/后端依赖，失败拒新任务不清存量；③SIGTERM→ready=false→限时 drain（在途审批/会话 abort+收尾）→按既有 close 次序关，超时记录未确定操作。
- 最小验收：第二实例启动失败；kill 锁主进程后接管成功、活进程锁不可抢；SIGTERM 后新 attach 被拒、在途任务限期收尾、审计完整。
- 可复用：`tests/gateway.test.ts`、`tests/audit.test.ts`（审计不可用时 fail-closed 语义顺手对齐 §3.3）。

### B6 磁盘满/restore 一致性（`tests/` 增量为主）
- 现状：crash-recovery 已覆盖断网/kill/unknown 副作用不重放（377/417 历史绿）；**缺口**=磁盘满、receipt-workspace revision 恢复校验、不自动覆盖未提交改动（B4/B5 落地后可测）。
- 最小改法：注入式 fs 故障（ENOSPC）测试+restore 校验脚本（对 receipt.revision vs workspace git HEAD/dirty 态），corrupt 元数据不重新认领 owner。
- 可复用：`tests/crash-recovery.test.ts`。真实备份演练/KMS=外部（B12 只交付脚本与记录模板）。

## 3. S4（两片；依赖 B4 operationId）

### B7 modelgw 链路正确性（`src/modelgw/server.ts`）
- 现状：流式转发+计量已存（:275-321），model 路径穿越已防（:355-360）；**缺口**=readBody 无上限（:330-337）、fetch 无 deadline/signal（:222）、`res.write` 不等 drain（:290）、abort 不取消 reader、无上游并发闸、team 取自请求头（:159）。
- 最小改法：①body 累计字节上限（超限 413 且断连）；②connect/首 token/idle/总时长四级 timer→AbortController→fetch signal+reader.cancel+res destroy；③`res.write` 返回 false 时等 drain，超时断该连接；④每上游在途并发上限+有界等待（429/Retry-After 透传）；⑤收费归属改服务端派生（tenant/team from 已验身份，忽略客户端头）。
- 最小验收：巨 body 拒；上游 hang 时总 deadline 内中止且连接释放（fetchImpl 可控 hang 断言）；慢端不堆积内存；并发不超上限。
- 可复用：`tests/modelgw.test.ts`、`tests/upstream-auth.test.ts`、`tests/cache.test.ts`。

### B8 持久预算账本（`src/modelgw/`+sqlite）
- 现状：`#used` 内存 Map、完成后才计、无 usage 不记（:96,:235-248）；**缺口**=reserve/settle/release、持久化、usage_unknown、重启恢复、防双记。
- 最小改法：`reserve(operationId, estInput+maxOutput)` 先占额（并发占预算）；settle 按实 usage、release 退差额；abort/断流/无 usage→`usage_unknown` 保守保留预留+异步对账；表含价格版本/模型/四类 token/供应商请求 ID；operationId 唯一防双记；重启扫未结账操作。
- 最小验收：并发预留不超卖；重启后额度与未结账保留；无 usage 不写 0；同 operationId 双 settle 拒绝。
- 边界：真实价格/账单/供应商对账=外部；mock 价格 $0.00 结论永不升级为成本声明。
- 可复用：`tests/modelgw.test.ts`（usage/SSE 既有断言扩展）。

## 4. S5（三片）

### B9 history 分页（`src/gateway/session.ts`、`src/protocol/`、`web/view-model.js`、`web/app.js`）
- 现状：snapshot 全量（session.ts:185-188），Outbox 有 2MiB/8MiB 水位（超限杀连接）；**缺口**=初始 tail 200/1MiB+分页游标+重连尾页一致。
- 最小改法：snapshot 带 `cursor`（seq 基）+`tail` 参数；新增 `history.page` 请求（有界页大小）；client/CLI 按 cursor 增量拉取；重连首帧=尾页。
- 最小验收：长会话快照有界；游标翻页稳定无重复无缺口；重连尾页与断开前一致；慢端不再靠大快照恢复。
- 可复用：`tests/view-model.test.ts`、`tests/protocol-coverage.test.ts`、`tests/gateway.test.ts`、`tests/web-injection.test.ts`。

### B10 CLI 完整化（`scripts/attach.ts` 或新 `scripts/cli.ts`）
- 现状：仅 attach 交互（77 行，prompt/steer/approve/abort/share）；**缺口**=create/list/inspect/wait/archive、机器 JSON、稳定退出码、wait 四态区分（成功/失败/待审批/连接错误）。
- 最小改法：子命令式薄壳（全部走既有 WS/HTTP 接口+B4 receipt），`--json` 输出、退出码 0/2/3/4 区分四态。
- 最小验收：脚本化 create→wait→inspect 全链 JSON 稳定；断网时 wait 以连接错误退出码退出（不悬挂）。
- 可复用：`tests/view-model.test.ts`（reducer 共享）；新增 CLI 测试文件。

### B11 基准组（`scripts/eval.ts`、`src/evals/`、s0 runner）
- 现状：benchmark-runner 270 条基线已可复跑（round-12 已审 implemented）；**缺口**=冷/热/重启三组×≥30 任务×3 次协议、成本/完成率/TTFT 报告字段。
- 最小改法：runner 加组别参数与报告聚合（复用既有 token 事件化），mock 模型跑全绿。
- 边界：成本门槛（-20%）与真实缓存有效性=真实获批模型后才有意义，报告注明 mock。
- 可复用：`tests/benchmark-runner.test.ts`、`tests/evals.test.ts`。

## 5. S6（一片+外部清单）

### B12 部署与证据工具（`deploy/`、`scripts/probes/`、`scripts/export-siem.ts`、`src/audit/log.ts`）
- 现状：sandbox.yaml/networkpolicy/policy-configmap/sandbox.Dockerfile、scripts/probes、审计哈希链+链头字段（log.ts:80）已有；pod-template/k8s-schema/netpol/wiring 测试已有；**缺口**=probe 与 /readyz（B5）接线、SBOM/漏洞扫描产物、备份恢复演练脚本、链头导出/外部锚定脚本、runbook 模板。
- 最小改法：①pod/deploy 清单加 readiness/liveness probe 指向 B5 端点；②`npm sbom`+审计扫描脚本产出 reports/（本机允许则装工具，否则脚本化调用预留）；③backup/restore 演练脚本+B6 校验复用；④`audit chainHead` 定期导出命令（WORM/外部锚定本身=客户设施）。
- 最小验收：k8s-schema/pod-template/netpol 测试扩新字段绿；演练脚本对临时目录真实跑通一次并留记录模板。
- 可复用：`tests/pod-template.test.ts`、`tests/k8s-schema.test.ts`、`tests/netpol.test.ts`、`tests/wiring.test.ts`、`tests/audit.test.ts`、`tests/siem.test.ts`。

### 客户外部清单（不能假装实现/通过；保持 external_blocked）
真实 IdP 参数与组映射；真实集群 CNI 出口负面探测（跨 ns/IPv6/metadata/DNS 隧道）；模型零留存/禁训练/区域/私网端点/DPA 与真实账单；客户 KMS；WORM/外部审计锚定设施；24h soak；客户安全负责人具名批准与例外签字。以上任何一片的实现+本地测试绿都**只算机制就绪**，不算企业放行。

## 6. 守卫与非目标

- S7 零工作：路由/fencing/调度/多 SCM/monorepo/MCP 全部等 S6 完成+单节点瓶颈实测证据，本审计不列任何 S7 切片。
- Pi 并发约束：B1 触及 path-guard helper 源码字符串，须等 Pi SDK teardown 修复+有界回归落地后再派；B4/B5 改 gateway/server.ts 与 Pi 面无交集，可先行，但同文件串行。
- 全部切片先本地 mock/受控真实（容器仍禁，等协调者授权+54m57s unknown 厘清）；绿测试≠安全边界：B1 的 bash 局限、B3 的 DPA、B8 的真实价格在报告与 README 中保持如实措辞。
- 顺序理由：B1–B3 互相独立且不依赖 S3，先行消化用户点名的 S2 三缺口；B4 是 B5/B7/B8/B9/B10 的公共前置，故 S3 receipt 排最前。

## 7. 勘误与执行口径修订（coor 复核追加；§0–6 原段保留不擦，冲突处以本节为准）

> 过程记录：上一已完成 dispatch 曾尝试追加意见，`worker_done` 后的 send 收到 `dispatch_inactive` 未送达；本节经新 task（task_5d231ba47457 / ctx_04e82575fa84）传递，旧 send 不作已读/已 ack 论。coor 已全文读 §0–6 并确认有限计划可用，以下五项按实际源码/规格口径修订后执行。

1. **B1（hardlink/敏感读边界降级为如实 partial）**：`lstat` 的 `nlink>1` 只能发现多链接存在，**无法确定另一链接的路径**——canonical+stat 与 check-then-use 全程不证明 FS 隔离。helper 对多链接 fail-closed 可以加（廉价加固、防已知形态），但**真正不可绕过的保护路径/敏感读边界=容器只读挂载 + 受限执行 + 不挂载 secret**，并配真实负控（容器内 bash/link 写读均拒）。在部署层措施与真实负控落地前，`s2-protected-paths` **保持 partial**，B1 的进程内改动只作纵深、不宣称边界闭合；README:66 的 bash 局限声明保持原样。
2. **B2（ref scope 必须代理自持，grant 绑定实际请求）**：handoff §5.2 明确要求按 **tenant/session/repo/ref 与 read/write** 授权——「ref 保护归上游」不能替代代理层 ref scope，上游 branch protection 只是额外防线。signed grant 必须携带**可信** tenant/principal/session/repo/ref 模式/rw/expiry/jti，且代理把**每个实际请求**（解析出的目标 repo + 由端点/service/pack 协商判定的操作，含 ref 更新目标）绑定到 grant 后才转发；拒绝绕过编码（repo 名路径穿越/双重斜杠/大小写变换等）与未支持协议形态。**token 内嵌 session 字符串≠跨 session 拒绝**：必须与服务端可信 session 登记态校验绑定，才能声称「跨 session 拒绝」——仅自包含 claims 不构成该证明。
3. **B3（生产默认 block/strict）**：原「默认 audit 不变」只适用于 demo/开发默认。**生产部署默认=block/strict fail-closed**；audit 模式仅对显式获批的低敏场景按部署配置开启。扫描覆盖**整条上游请求发出之前**（fetch 前全量 body），每个上游 fetch 一律 `redirect:"error"`；不沿 demo 默认把 audit 模式带进生产。
4. **§6 容器禁令作废（按本轮授权修订）**：原「容器仍禁，等协调者授权」与本 task 最新许可矛盾——用户已明确**继续实现并测试**，coor 已授权**新独占 owned 有界不冲突测试**（真实容器/受控执行按各切片最小验收需要，独立日志、不与 Pi 回归并发）。旧 **54m57s node 终止状态=unknown 独立保留**：新授权/新 PGID/新有界运行一律**不作为旧进程退出证明**，不做未知进程扫描/清理/倒证。不复活任何「全局 static-only」阶段口径。
5. **切片大小口径（目标非硬约束）**：「≤1 模块+1 测试文件」只宜作为每片聚焦的目标，**不是硬约束**。跨层契约（如 B9 分页须 server/protocol/web/CLI 四面同改、B4 receipt 须 gateway/session/sqlite 贯通）天然多文件——**不得为保小而削弱接线**；以「每片一个完整契约+对应测试面」为准，避免过度设计的原则不变。

本节为对 §0–6 的修订口径，其余计划（顺序、可复用测试、外部 blocked 清单、S7 保留）维持原样。本追加是本轮唯一 repo 写入；零运行、零产品/test/coverage/progress 写入。
