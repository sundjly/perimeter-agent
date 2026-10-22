# S3a 复审：s3-exclusive-lock-ready（round-1）

- 日期：2026-10-21。只读复审，未运行任何测试/进程。基线 HEAD 6135238（R78）。
- 对象：/tmp/perimeter-exec-r78-KoZDveWo/s3a-code.diff（5 文件，与工作树一致：新 src/gateway/state-lock.ts、gateway/server.ts、audit/log.ts、scripts/demo.ts、新 tests/lifecycle.test.ts）；需求 task-s3a.md、handoff §3.3。
- TAP 核验：s3a1 全套 18 份 + lifecycle.s3a2-{1,2,3} 三连跑。**披露：lifecycle.s3a1 为 5 ok/1 not-ok**——S3a-cd 在「拒绝新 prompt」断言上超时（事件流显示 error 帧到达但形态不符），属修复前中间历程；修复后 s3a2 三连跑均 6/6 全绿（用例名逐条核对）。其余套件 0 fail，计数与报告一致（attach 2、demo-e2e 2、gitproxy 33、wiring 14、gateway 25、git-e2e 10、integration 4、redteam 4、web-injection 6、protocol 4、enterprise-s1 31、crash-recovery 1、durable-runtime 5、protected-paths 17、four-eyes 12、docker-owned-ledger 1、docker-backend 汇总 35）；unit 65/65。

## 结论：approve

锁语义、健康端点、有序关闭均符合 task-s3a.md 与 handoff §3.3，测试为真子进程/真状态断言，未发现安全回归。

## 逐项核验

### (1) 锁正确性 —— 通过
- **接管竞态**：`renameSync`（原子）+ `wx` 独占重建。并发接管同一陈旧锁：输家 rename ENOENT → 固定类别拒；rename 与 wx 之间被第三方抢注的情形等价于「无锁新取」，仍恰一赢家、输家 EEXIST 拒 ✓。
- **pid 复用**：死 pid 被无关进程复用 → isAlive true → 拒绝启动（可用性损失、安全方向正确，交运维）；EPERM 视为存活与 audit 锁同一约定 ✓。**无心跳无过期**——按约不抢活锁 ✓。
- **释放 TOCTOU**：read→compare nonce→unlink 存在理论窗口（外部写者在本实例存活期间替换锁文件），但 stateRoot 0700 且换手以本进程死亡为前提，实际不可达；nonce 校验防误删已接管文件 ✓。
- **权限**：wx mode 0600 + chmod 兜底；stateRoot mkdir 0700 + chmod ✓。
- **构造失败路径**：锁先于 audit.open 取得——第二实例失败零资源（测试以「不同 auditFile 的审计锁文件不存在」实证）；audit.open 失败、saveGitGrantRegistry 失败、主 try（renew timer/wss/loadRevocations/loadSessions）、workspaceRoot mkdir 四条路径均 audit.close + releaseGatewayLock 后抛；reaper 在这些点尚未 armed ✓。listen() 失败的实例锁保持到进程退出——下次启动按陈旧锁自愈（可用性 note，非缺陷）。

### (2) readyz/livez —— 通过，三条 notes
- 位置在 `#hostOk` 之后（Host 校验必过）；无鉴权、不读 Cookie、仅 "ok"/"not ready" 固定文本（测试断言 body 不含 stateRoot 与 "/"）；非 GET/HEAD 405；draining 时 livez 200 / readyz 503 ✓。
- note-1：readyz 写探针用**固定文件名** `.readyz-probe`——并发探测下 A.unlink 与 B.unlink 竞争 ENOENT 可瞬时假 503（rename 可覆盖、无损坏，纯可用性）；建议 tmp 名加随机后缀。
- note-2：每次 readyz = 3 次文件操作 + audit fdatasync，无频率限制；单次成本有界，暴露面受 Host 校验约束；若上线到共享网络建议加最短缓存间隔。
- note-3：rename 失败路径可能残留 `.readyz-probe.tmp`；接管/被中断的接管会在 stateRoot 留 `*.quarantine` 垃圾文件——纯 housekeeping。

### (3) shutdown 顺序 —— 与 handoff §3.3 逐条一致
readiness 翻红（#draining）→ 拒新升级（503）与新 prompt/steer（command_failed 固定类别）→ 停 reaper → 限时 drain 轮询 session.busy → 超时逐会话写「关闭时未确定操作」（#tryAudit，不中断）→ 复用 close()：flush logout → 撤 grant → 逐项关 Harness/执行/沙箱 → HTTP/WS → audit → **最后释放锁**；清理失败继续其余项（close 既有语义）✓。
- abort/approve 在 drain 放行：无新特权（approve 仍过 approver 角色门），方向是减少未确定操作，安全 ✓。
- 45s 硬上限：未确定操作审计在 close 前同步落盘，exit(1) 不丢；exit(1) 留下锁文件由下次陈旧接管自愈 ✓。重复信号：process.once → 第二次信号走默认终止（Unix 惯例）✓。drain 中 readiness 子集说明：实现核 draining/锁/策略在位/stateRoot 写/audit 可写，恰为 task-s3a.md 第 2 条的范围；§3.3 的凭据域/模型目录/执行后端/出口校验留给后续切片——口径已在任务内对齐，无落差。

### (4) 测试真实性 —— 通过
- S3a-a：第二实例固定类别抛 + 零资源（含不同 auditFile 变体证审计未开）+ close 后第三实例可建 ✓。
- S3a-b：真死 pid（spawn 即退）测接管，断言新 nonce + quarantine 文件在位；他机锁拒且**锁内容未被改动**；损坏锁拒 ✓。并发接管未直接测（OS 原语保证 + 输家分支已覆盖，可接受）。
- S3a-cd：真慢流任务（5×500ms）下 readyz 503/livez 200/新 WS 升级 503（assert.rejects /503/）/prompt 拒（error+command_failed+固定文案），drain 内完成 → 锁释放且**无**未确定操作审计 ✓。
- S3a-d：12s 流 vs 500ms drain 必超时 → 未确定操作审计在案 + **AuditLog.verify 链自洽** + 锁释放 ✓。
- S3a-e：子进程真跑入口（demo 模式、PORT 0），SIGTERM → exit 0、锁删除、`kill(-pid,0)` ESRCH 断言进程组无残留 ✓。
- 计时余量充足（drain 20s vs 任务 2.5s；超时例方向性必然），无竞速比拼。s3a1 的失败被诚实修复并以三连绿收口。

### (5) 既有安全不变量 —— 未受影响
健康端点在 Host 校验之后、WS 拒绝在 Origin 校验之后；审计链仅在尾部追加且 verify 过；checkWritable 只 fdatasync 不写链不产条目；未触碰 modelgw/vendor/依赖（约束遵守）；既有 18 套件零断言改动全绿（各测试本就用独立 mkdtemp stateRoot，锁不互扰）。

## 残留 notes（不阻塞）
1. readyz 探针固定文件名的并发假 503（建议随机 tmp 后缀）。
2. readyz fdatasync 无频率限制（暴露面受限，上线共享网络前建议缓存/限频）。
3. quarantine/probe.tmp 垃圾文件堆积（housekeeping）。
4. listen() 失败路径锁由下次陈旧接管自愈（可用性口径）。
5. readiness 校验范围按切片推进（§3.3 全集留后续）。

## 证据
diff：/tmp/perimeter-exec-r78-KoZDveWo/s3a-code.diff；TAP：同目录 *.s3a1.tap、lifecycle.s3a2-{1,2,3}.tap、unit-run3/r65-driver。关键源码位：src/gateway/state-lock.ts（acquire/release/lockStillHeld）；src/gateway/server.ts:357-373（锁先于审计）、419-456（构造失败四路）、853-893（shutdown）、1218-1234（健康端点）、1727-1728（drain 拒升级）、2124-2128（drain 拒新任务）、2295-2312（入口信号+硬上限）；src/audit/log.ts:214-219（checkWritable）；tests/lifecycle.test.ts（6 例）。
