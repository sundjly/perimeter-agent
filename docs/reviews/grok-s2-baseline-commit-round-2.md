# S2 基线提交复审第 2 轮：R-S2B-1 修复核验

- 日期：2026-10-21。只读复审，未运行任何测试/进程。基线 HEAD b90e2ca；上一轮报告 docs/reviews/grok-s2-baseline-commit-round-1.md。
- 本轮变化：仅新增 tests/audit-gate.test.ts（365 行，与 s2b-audit-gate.diff 逐字节一致）。

## 结论：approve（R-S2B-1 闭合）

## 变更面核验

- 46 文件工作树 diff 与第一轮 s2b-code.diff 逐字比对完全一致：生产码、fixture、既有测试零改动；全树仅多出 tests/audit-gate.test.ts（另 scripts/probes/README.md 为第一轮按 md 约定排除的纯文档，无敏感内容）。
- 未新增任何注入开关：只复用既有 PERIMETER_TEST_AUDIT_BREAK_MARKER（env 门控、默认行为不变），符合修复轮约束。

## 门1 e2e：真实 oracle ✓

- 真实网关子进程 + mock 模型 + 127.0.0.1 + 临时目录；标记注入锚定在第一步慢命令（sleep 3）副作用落盘之后，readyz 翻 503 确认 close 生效后才继续断言——时序确定性由服务端证据背书，非睡等。
- 断言四层：哨兵不落盘（硬 oracle）；policy.denied rule=audit-unavailable 且固定类别、不透传 EBADF/EACCES；客户端任何事件无 IO 错误泄漏；审计链中被拒调用零 tool.call（证明门先于一切审计写入）。
- TAP（g-audit-gate.tap）5/5，含「写审计失败: EBADF」真实注入痕迹——失效是真发生，非 mock。

## 门2"仅单测固定"：可接受，理由经源码核实 ✓

Pi 的论断在 approvals.ts:312–330 逐行核实：allow 决策先写审计（步骤 3"铁律"），写失败 → 存储置 invalidated/approver=system → waiter(false) → 发 approval.resolved deny(actor=system) → 抛固定类别错误。因此 e2e 中"审批等待期审计失效"必然在 decide 处 fail-closed 收束，beforeTool 第二道门只在 waiter(true)（以审计写成功为前提）后可达，无确定性 e2e 触发窗；人为制造该窗需改生产码，被修复轮约束禁止。
本轮 e2e 实际固定了更强的系统级不变量（审计失效后绝无可用 allow、批准不执行、allow 零留痕），beforeTool :162 线行为由第 5 例线级单测固定（假审批注入 waiter-true 场景，断言 block+policy.denied"审批后"固定类别）。变异敏感性与门线绑定经静态核验成立：禁 :162 → 单测 result.block 断言必失败；禁 :85 → 门1 e2e 的 policy.denied(audit-unavailable) waitFor 必超时（意外抛错路径不产生该事件）。协调者变异检验结论与此一致。
残差（如实）：协调者声明的 3× 连跑与隔离树变异检验未在证据目录归档 TAP（现存仅单份 g-audit-gate.tap 5/5）——证据卫生 note，非阻塞。

## 正控与卫生 ✓

- 两个正控（bash 哨兵落盘 / 审批后 package.json 落盘 + allow 留痕 actor=alice approver=bob）证明负例非因无关原因失败。
- 清理：finally 终止 WS、SIGTERM 子进程（10s 有界等待）、kill mock、rmSync；等待全部有 deadline 超时报错，无孤儿面、无全局扫描。
- 引用 API 全部实存且形状匹配：AuditLog.replay（log.ts:250）、tool.end{ok,output,action}、policy.denied{rule,reason}、session.ready/agent.end、share+role=approver（与 four-eyes 既有用法一致）、mock-model.mjs argv 约定（<port> <scriptJson>）。

## 计时脆弱性评估：无假绿方向

两例负控的注入顺序均由"副作用文件出现 → 写标记 → readyz 503 确认"锚定；若 close 未及时生效，后果是哨兵落盘/事件缺失 → 测试红（失败方向安全）。裕量：门1 约 ≥1.9s（3s sleep − readyz 观测时延），门2 在 approve 前已确认 503，无竞态。

## 范围声明

本轮实际核对：修复轮任务书、audit-gate.diff 与工作树逐字节比对、46 文件与第一轮 diff 逐字比对、perimeter-extension 两道门与 approvals.decide fail-closed 源码、fixture 注入链、TAP 5/5、五个用例的断言-门线绑定与清理路径、README.md 新增内容。其余基线内容依赖第一轮已核记录，未重审。
