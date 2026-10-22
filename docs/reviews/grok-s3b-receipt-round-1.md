# S3b 复审：s3-create-receipt（round-1）

- 日期：2026-10-21。只读复审，未运行任何测试/进程。基线 HEAD 238a7ba（S3a）。
- 对象：/tmp/perimeter-exec-r78-KoZDveWo/s3b-code.diff（10 文件，与工作树一致）+ 预置暂存改动 s3b-preexisting-staged.diff（types.ts 5+/5-、gateway-process fixture）。
- TAP 核验：receipt.s3b2-{1,2,3} 三连跑 8/0；**s3b1 首轮 7 ok/1 not-ok**（S3b-5 fixture token/审计文件名不一致 401 + typecheck 7 错，仅改测试修复）——与 coordinator 披露一致，属中间失败历程。其余套件计数与报告一致（lifecycle 6、attach 2、demo-e2e 2、gitproxy 33、integration 4、wiring 14、git-e2e 10、gateway 25、redteam 4、web-injection 6、protocol-coverage 4、enterprise-s1 31、crash-recovery 1、durable-runtime 5、docker 35/1、protected-paths 17、four-eyes 12、audit 23、protocol 6、session-guard 5、session-pin 7、siem 17、view-model 5）；unit 65/65。

## 结论：approve

幂等/崩溃/安全三面均成立，测试为真进程、真计数 oracle（mock 模型请求计数、磁盘收据形状断言、kill -9 真崩溃），预置暂存改动为类型对齐无行为变化。

## 逐项核验

### (1) 幂等语义 —— 通过
- 同 principal+operationId+requestHash → replayed=true 原收据（同 sessionId，不新建资源，审计标 replay）；同键异内容固定拒；跨身份按 principalId sha256 目录隔离，各建各会话（S3b-2 磁盘级断言）✓。
- 并发单飞：`#createInflight` 键 = sha256(principal)±NUL±operationId，等待者共享同一 Promise 拿同一 sessionId（replayed=true），双分支清理映射、无 unhandled rejection；S3b-3 断言 8 并发恰 1 会话、恰 1 份收据文件、恰 1 条受理审计 ✓。跨进程由 S3a stateRoot 锁覆盖 ✓。
- TTL 过期 → 惰性删除 + 周期清理后同键视为新建（头部注释明示「幂等键不是永久的」）✓；sweep 只删收据不碰活会话（S3b-6 实证）。
- **prompt 同键同内容「拒绝」与 §3.1「返回原结果」的偏差：可接受。** create 的对象是资源（会话），返回原结果成立；prompt 的「原结果」是整段生成流，重放返回旧输出反而给重放者泄露历史生成内容。现在的语义（同键同内容拒「已受理不重复生成」+ 异内容固定拒 + durable scopedId 第二道）满足 §8 验收行的核心安全要求——不重复模型生成，且方向更保守。
- 残留语义 note：账本在 submit 前记账——首提交若因暂时故障失败，同 requestId 重试会被拒（需换新 requestId），拒绝文案「不重复生成」在该场景名不符实（fail-safe 方向，记录）；prompt/steer 共用同一命名空间，客户端须保证 requestId 全局唯一。

### (2) 崩溃语义 —— 通过
- 先收据后副作用成立：#runCreate 中 scope（纯计算）→ save(accepted) → buildSession（首个外部副作用 = 建目录）→ workspace_ready → session.start → harness_ready/created；save 失败即拒绝创建（发生在 try 外，无收据无会话，重试干净）✓。
- recoverNonTerminal：启动时 accepted/workspace_ready → outcome_unknown + 固定审计（不当成功、不自动重做）；损坏收据构造期抛错 fail-closed 拒启 ✓。
- outcome_unknown/failed 重放均原样返回不重做（S3b-5 kill -9 真崩溃后 outcome_unknown、S3b-4 注入 failed 后重放不建工作区）✓。
- 隐式 attach 首次创建写 auto-<uuid> 收据（freshCreation = meta.json 不存在），re-attach 既有会话不写收据 ✓；隐式创建不经 createStageProbe（生产注入口只对显式 create）✓。
- note：#stampReceipt 写盘失败不阻断主线（内存推进、磁盘 stage 落后）→ 重启后被标 outcome_unknown，fail-visible 可接受。

### (3) 安全 —— 通过
- 路径注入：operationId 双层限死 `[A-Za-z0-9_-]{1,64}`（validate.ts 入口 + #path 纵深），principalId 哈希后才进路径，客户端字符串永不参与拼接 ✓。
- 损坏 fail-closed：load 抛 CorruptReceiptError → 拒绝创建，绝不按「不存在」为同键建第二会话 ✓。
- create 不绕既有门：命令在连接级 isAuthorized 门（4003「资源权限已撤销」）之后处理，自带 owner/editor 角色门，scope 由服务端 resolveScope 推导（production 推导不出即拒）；maxSessions 在隐式（:1123）与显式（:1350）两条路径都有；命令级速率限制（帧入口 rate.allow）不受影响 ✓。
- session.created 只发创建方连接（outbox 直发，不广播、不带 seq），内容仅限本人收据字段，无越权泄露 ✓。
- 预置暂存改动：Role 增 approver、approval.request/inbox 增 argsHash——运行时 perimeter-extension 早已产出 argsHash，本轮只补类型对齐，无行为变化；fixture 增显式 mode:"demo" 与 PERIMETER_TEST_CREATE_PROBE_PARK 注入钩子（env 门控，生产不可达）✓。
- notes：prompt 账本无 TTL/上限——条目小但每次 prompt 全量重写账本文件（O(n) 写放大），生命周期与转录一致（注释明示同推导）；长期会话量大时建议加上限/分片。recoverNonTerminal 标记写（receipt-store.ts:174）为直接 writeFileSync 非原子——标记中途崩溃会损坏收据 → 下次启动 fail-closed 拒启（可用性负向、安全正向），建议复用 save() 的 tmp+rename。

### (4) readyz 缓存 —— 通过
draining/close 即时翻红不走缓存；其余结果 ≥1s 复用（限频）。锁丢失/审计不可写最迟 ~1s 才反映——readyz 只驱动流量摘除，不参与任何授权判定，1s 窗口可接受 ✓。探针改唯一名 + 失败清理全部自产物（S3b-8：20 并发全 200、零残留）——S3a 三条 notes 全部闭合 ✓。

### (5) 测试真实性与 protocol-coverage —— 通过
- 8 例全部真实链路：mock 模型请求计数文件是硬 oracle（S3b-7 全程钉在 1/1/1/2；S3b-5 钉在 0——崩溃+重启全程零生成）；S3b-5 用真子进程 kill -9 于 workspace_ready 挂起点、重启后断言「只出现重连实例自己的隐式工作区」——精确区分隐式会话与未重做创建；S3b-3 磁盘收据恰一份 + 受理审计恰一条。
- protocol-coverage 22→23 是 session.created 真实入列的诚实反映，EXEMPT 带理由（定向应答 UI 不消费），handledInRender≥15 下限未动 ✓。既有测试断言零改动 ✓。
- 中间失败（typecheck 7 错、S3b-5 401）均为测试侧修复，未触碰生产断言。

## 证据
diff：/tmp/perimeter-exec-r78-KoZDveWo/s3b-code.diff、s3b-preexisting-staged.diff；TAP：同目录 *.s3b1.tap、receipt.s3b2-{1,2,3}.tap。关键源码位：src/gateway/receipt-store.ts（save 原子写 :148-156、recoverNonTerminal :196-210、sweep :215-243）；src/gateway/server.ts:1120-1185（隐式路径收据化）、1267-1390（create/单飞/readyz 缓存）、1470-1495（#isReady/#computeReady）；src/gateway/session.ts:257-310（prompt 账本）；src/protocol/validate.ts（create 校验）；tests/receipt.test.ts（8 例）。
