# grok-s2-scm-scoped-grants-round-12.md — R72 C3/B4 补齐与三缺陷修复轮复审（Grok R73；task_71397509eaaf / ctx_1d82164f685e）

- 日期：2026-10-21；审者：Grok（term_2769b867…，R62 起同一 reviewer）。被审对象：R72（demo 双进程 e2e 新增 + B4 gzip 三例 + 运行中暴露的三处生产缺陷修复）。**本轮只读（native read/rg/shasum/stat/diff+Orca），未运行任何东西**；证据根 /tmp/perimeter-exec-r67-J3jFOwfP 只读未写。唯一 repo 写=本文件。
- **判定：approve——三处生产修复正确、最小、无安全回归；demo-e2e 真测 C3、gzip 三例真测 B4；③「运行中 share 撤销 grant」判定为真实产品流程缺陷（安全语义正确、流程缺补救），列为 required 产品后续项，不阻塞本轮**。

## 0. 证据链核验（全过）

run15 八面全绿亲读：demo-e2e 1、gitproxy 30、git-grants-integration 4、wiring 11、git-e2e 10、gateway 25、redteam-e2e 4、web-injection 6（not-ok 全 0）；unit-run15 `fail 0`（74.6ms）；typecheck tc6–tc9 空签名（exit0 采 coor 记录）；mtime——src 两件与 tests/demo-e2e 末次编辑均早于 demo-e2e.run15.tap（末次编辑后 20 秒内即终轮，绿跑后零改动）；失败历程 run7–run12（demo-e2e 连败→gitproxy/git-e2e 间发失败）与三缺陷逐步暴露修复的次序吻合，run13/14 清、run15 终绿。

## 1. 三处生产修复（正确 ✓ 最小 ✓ 无安全回归 ✓）

- **① scmGrantRepo（gateway）**：`repoUrl → host[:port]/path`（去首尾斜杠），http(s) 限定、query/hash 拒、路径空拒，且**必须在 gitGrants.repos 精确登记**否则 null→closeWith 固定类别不签发（fail-closed，不回落策略标签 metadata.repo）。与代理 RepoMapping.name/parsePath 全等口径一致（合同 A2）——修复前签出的是必然被代理拒的坏 grant（端到端从未被测过）。纯函数+10 断言 unit（wiring ok10：正例/端口/尾斜杠/无路径/query/未登记/未配置/ftp）。回归方向：无 repoUrl 或未登记→会话拒发 git grant（fail-closed 向）✓。
- **② session-miss 单飞重拉（gitproxy）**：grant 合法但快照未登记（冷启动窗：attach 即 mint、快照等下一轮 pollMs）时重拉一次；**单飞 + 全局 1s 最小间隔**——放大上限=每代理每秒 ≤1 次内部 GET（对比常态 pollMs 轮询可忽略），限流窗内/拉取失败沿旧快照 deny=**fail-closed 不变**；snapshot/snapshotAtMono 同步更新与 maxStale 口径一致 ✓。
- **③ 构造期清理（gateway）**：renew arm 与其后全部可抛加载/校验同缝进 try；catch 拆 renew timer + `wss?.close()` + `#audit.close()`（:357 已赋值可用）后**原样重抛**（抛错语义与消息不变）；回归锚测试以 `process.getActiveResourcesInfo` 断言构造失败 Timeout 净增=0（wiring ok11，真实事故=armed 450s ref 定时器拖死进程）✓。

## 2. demo-e2e 真测 C3 / gzip 三例真测 B4

- **C3（demo-e2e ok1）**：拓扑全真实——mock 模型/上游 git server 均子进程、代理**真实轮询**网关 internal registry（late-bound 回填，禁 stub 的核心项）、probe grant 以 deny summary 区分快照就绪；clone 经代理（workspace .git+种子内容断言）→ 审批门拦 → approver 批准 → **push 真达上游**（log 匹配+HEAD 前进）→ 审计 identity=grant（sessionId/actor=principal/team 三断言来自真实审计文件）→ workspace+沙箱 HOME 全树六类秘密零泄漏（含网关 token——agent 读到即可自批的注释到位）✓。
- **B4（gitproxy ok28/29/30）**：gzip 合法 push→上游字节与未压缩原始 body **逐字节相等**+content-encoding 剥除；解压后越域 ref→403（同尺）+上游零请求；>64KiB PACK（合法命令区）→200 且字节相等（64KiB 只钳命令区，PACK 走 decoded 预算）✓。

## 3. 「运行中 share 撤销 grant」产品流程缺陷判定（核心项）

**机制（代码钉死）**：运行时给第二人 approver 角色的唯一途径是 `share` 命令（gateway :1872）→ `session.setAclVersion` → `onAclChanged` → **`#revokeGitGrantSession`（jti 级全撤销，≤pollMs 生效）**；而 grant 签发**只发生在 attach**——存活会话不存在任何重签路径。

**结论：缺陷属实。** 四眼流程要求 approver 角色，而运行时 share 必然撤销该会话全部 git grant →「share 加审批人→审批→push」的真实四眼流程**必然在 push 步 403（jti 已吊销）**。Pi 的观察与 e2e 预置回避属实。demo.ts 现状更糟：完全不预置成员、未显式配 stateRoot；banner 宣称「等你点批准或拒绝」，但 approve 需 approver 角色（:1900）、owner 自批被防自批规则拒绝——**单用户路径审批永不可达，承诺的「审批通过后推送真的到达上游」按当前脚本不可达**。

**定性**：acl 变更即撤销是 A6 正确的 fail-closed 安全设计，**不可放宽**；缺的是撤销后的合法补救路径——这是产品/演示流程缺陷，非本轮修复引入（aclVersion 撤销语义自 R51 起即在），Pi 以预置合法回避属测试层面正当处置（文件头如实披露差异）。

**建议（required 产品后续，需 coor/用户决策，不阻塞本轮）**：短期修 demo.ts——Gateway listen 前向 stateRoot 预置 approver 成员 meta.json（注意显式配置 stateRoot 或精确对齐默认 `workspaceRoot+".state"` 拼接——e2e R72-v5 教训），banner 改双人角色口径；中期二选一：(a) onAclChanged 撤销后自动以新 aclVersion 重签并更新 wiring（复用 renew 同缝，agent 无感），或 (b) 发布 WS 事件驱动会话重连重签。两条都保持「撤销先于重签」的 fail-closed 时序。

## 4. 三态与后续

- **source**：R72 三修复接受（§1）；生产改动面=src 两文件（gateway ctor/签发点+纯函数、gitproxy miss 重拉），与 diff 一致。
- **static eligibility**：新增用例全数 READY（run6→run15 面扩至 8 suite 100 例 + 64 unit）。
- **execution**：typecheck0 + 上述全绿（R72，用户授权）在案；17 项验收面其余维持 pending。
- **required 后续**：§3 产品流程项（demo.ts 修复 + 重签机制决策）；optional 维持（PKT_MAX 注释、git-grants 未用 import、close-during-arm、3xx dispose、R58 元勘误）。

## 5. 元信息

本轮零行为达成（native read/rg/shasum/stat/diff+Orca；未运行任何测试/编译/解释器；Git 未触）。typecheck exit0 与进程残留采 coor 在案记录（本轮未复跑；TAP 总行/mtime/失败历程已独立核验）。本报告不含自身 hash。
