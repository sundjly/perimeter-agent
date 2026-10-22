# S3c 复审：s3-crash-side-effects（round-1）

- 日期：2026-10-21。只读复审，未运行任何测试/进程。基线 HEAD 3fe5cf1（S3b）。
- 对象：s3c-code.diff（8 文件，与工作树一致）；s3c-preexisting-staged.diff（S2 path-guard/审批，249 行）；s3c-pi-runtime.diff（本轮 runtime 改动，109 行）。提交计划：仅 6 文件（audit/log.ts、gateway/session.ts、gateway/server.ts、gateway/receipt-store.ts、tests/crash-side-effects.test.ts、tests/fixtures/gateway-process.ts）；runtime 两文件因依赖未提交的 path-guard.ts 留在工作树。
- TAP 核验：crash-side-effects.s3c3-{1,2,3} 与 cse.s3c2-{1,2,3} 各 7/0（三连跑全绿）；s3c3 共 7 份 TAP 零 not-ok；其余套件计数与报告一致（30 文件全绿、unit 65/65）。

## 结论：approve

durable 不重放的依据经独立源码证实；恰一次、outcome_unknown 判定、磁盘满 fail-closed、abort 收束均有真实 oracle；6 文件单独提交类型自洽且相对 HEAD 严格加固。一条须跟踪的主观察（执行面两道门未提交且无测试）与若干非阻塞 notes。

## 逐项核验

### (1) durable 不重放与「恰一次」—— 依据成立，独立证实
- node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts:157 原文：`/** Whether an interrupted execution may rerun on recovery. Default `unsafe`. */ replay?: "safe" | "unsafe"`；dist/tools/*.js 全目录 grep 无任何 `replay` 声明——CodingTools（bash/edit/write 等）从未声明 safe → 恢复时一律不重跑，给模型 interrupted 结果。Pi 结论属实。
- S3c-1 的硬 oracle：kill -9 前后 `runs.txt` 内容恒为 `"run"`（恰一次），重启续跑至「恢复完成」；可见性走实时 audit.entry 或快照双通道（防 overflow 丢事件假阴）。审计恰一条 outcome_unknown（重复重启不重标，alreadyFlagged 幂等）。
- 判定漏标/误标分析：pendingCalls=tool.call 无 tool.result 且无 approval.request/decision/policy-deny——结果已 fsync 后崩溃不漏；崩溃在执行前则文案如实「原执行进程可能仍在运行」（不谎称已终止）；push 类附「先核对远端 ref，不要直接再推」✓。over-flag：只读工具被打断同样标「工具结果未知」（比需求更宽，噪声无害，fail-safe 方向，note）。

### (2) 审计不可用门 —— 通过，两条 notes
- 粘滞 healthy：只降不升、重启唯一恢复。append/checkWritable 失败即置假，seq/prevHash 仅在成功后推进（链一致）。可用性代价：瞬时故障清除后 healthy 仍假 → runtime 工具门持续关闭直至重启，而 readyz/prompt 门走 checkWritable 点检会重新变绿——**半开不一致**（note-1：建议 readyz 与 prompt 门一并消费 healthy，或文档明示「瞬时故障后需重启」；方向是多 fail-closed，不阻塞）。
- 吞错范围：auditCommand 吞错仅保 abort/deny/命令面可用；prompt/steer 被 checkWritable 门拒绝；perimeter-extension 两道门在不健康时完全停写审计（不再制造链失败）——清理豁免未扩大到执行 ✓。
- **执行面两道门（beforeTool 顶部 + 审批后执行前）无端到端测试**：fixture 新增 PERIMETER_TEST_AUDIT_BREAK_MARKER 脚手架但无测试消费。与提交拆分同根（见 (5)）——门本身在未提交文件里。作为条件跟踪：随 S2 流落地时必须补 e2e（或删除死脚手架）。

### (3) 磁盘满 fail-closed —— 通过
- S3c-3 修正后注入点准确（stateRoot=readyz 探针；sessions/<sid>=账本 tmp；receipts/<principal-sha256>=收据 tmp+rename——父目录 0500 拦不住子目录写，首轮失败的根因），三处真实写路径各自封死；新增断言「故障窗口内 create 不产生新工作区」是加强而非放宽。
- 原文件不损：账本 tmp 写失败原文件逐字节不变（断言）；收据 tmp+rename；S3c-6 证明标记写失败抛 EACCES 后原收据 stage 不动、恢复后重试成功 ✓。
- 账本上限「拒新不淘汰」：上限内键的幂等永久保留，淘汰导致的同键重复生成无提示窗口被结构性排除；代价是满后需运维归档（文案已如实）。跨重启 S3c-5 验证上限语义不引入重复生成 ✓。

### (4) abort 收束与孤儿风险 —— 测试真实；孤儿定为中低残留风险
- S3c-4a：真子进程 + 后台子进程 pid 落盘 → abort 后 ESRCH 断言无僵尸、agent.end 在收尾后、会话可继续 ✓。S3c-4b：pending 审批按 deny 收束、approver=system 留痕、工具未执行（文件不存在）✓。均为真实子进程断言，「现有实现已满足、只补测试」成立。
- 孤儿：SIGKILL 崩溃时执行中工具进程组变 ppid=1 孤儿，重启不自动回收——测试自记 pgid 并回收 + ESRCH 断言。定级中低：需崩溃恰逢工具执行，outcome_unknown 提示已要求人工核对残留进程；建议后续切片做启动时按审计 pgid 扫描回收。

### (5) 6 文件单独提交 —— 类型自洽、相对 HEAD 严格加固；主观察见下
- 逐项依赖核验：session.ts 用的 AuditEntry.callId/tool/path/command/argsHash 与 `get path` 在 HEAD 已存在（git show HEAD 证实）；HEAD 的 perimeter-extension 已发带 callId 的 tool.call/tool.result → S3c-1 的标记逻辑在干净 HEAD 上即可工作；durable 不重放是 node_modules 属性与提交无关；auditInstance/promptLedgerMaxEntries 配置与消费方同在 6 文件内；checkWritable 为 S3a 已提交。
- **因此提交不会产生「只提交一半的安全缺口」**：6 文件只增收紧（粘滞位、账本门与上限、收据原子标记、回放可见性），HEAD 原有行为无一放宽；执行面两道门在 HEAD 本来就不存在，不提交它们与现状等价。
- **主观察（须跟踪，非阻塞本片）**：S3c 交付 2 的「审批后执行/恢复续跑」执行面 fail-closed 完全位于未提交 runtime 文件，且无端到端测试——该保证当前只存在于工作树。随 S2 path-guard 流提交时必须一并落地并补 e2e；提交信息应显式声明这一边界，避免 HEAD 被误读为已含执行面门。

### 中间失败与过程记录
- S3c-3/S3c-6 首轮失败=注入点选错目录（父目录 vs principal 子目录），仅改测试注入点并**增加**断言；S3c-1 发现孤儿问题 → 测试改为记录/回收/ESRCH 断言 + 提示语改诚实口径——三次都是修复与加强，无断言放宽。Pi 自报两次只读 shell 越界（grep/echo，无写入）——已记录，无仓库损伤。

## 残留 notes（不阻塞）
1. 粘滞 healthy 与 checkWritable 点检的半开不一致（建议统一消费 healthy 或明示重启语义）。
2. beforeTool 两道门无 e2e + fixture 的 AUDIT_BREAK_MARKER 脚手架暂无消费者（随 S2 流补）。
3. outcome_unknown 对只读工具也标记（过宽无害）。
4. 孤儿进程重启不自动回收（已文档化残留风险；建议后续启动扫描）。
5. prompt/steer 共用账本命名空间（沿用 S3b note）。

## 证据
diff：/tmp/perimeter-exec-r78-KoZDveWo/s3c-code.diff、s3c-preexisting-staged.diff、s3c-pi-runtime.diff；TAP：同目录 crash-side-effects.s3c3-{1,2,3}.tap、cse.s3c2-{1,2,3}.tap、*.s3c3.tap。durable 依据：node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts:157、dist/tools/*.js 无 replay 声明。关键源码位：src/audit/log.ts（#healthy 粘滞）；src/gateway/session.ts（启动回放标记、prompt/steer 门、账本上限）；src/gateway/receipt-store.ts:171-178（原子标记写）；src/runtime/perimeter-extension.ts（两道 audit-unavailable 门，未提交）；tests/crash-side-effects.test.ts（7 例）。
