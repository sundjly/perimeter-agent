# S3d 复审：s3-backup-restore（round-1）

- 日期：2026-10-21。只读复审，未运行任何测试/进程。基线 HEAD 952d46b（S3c）。
- 对象：s3d-code.diff（7 文件，与工作树一致；package.json 另含预置暂存的 test:bounded/test:serial 两条脚本——调用已提交冻结 runner，`--timeout` 在命令前，与 runner「flags 先于命令」契约一致 ✓）。
- TAP 核验：backup-restore.s3d5-{1,2,3} 各 7/0（三连跑全绿）；s3d5 共 30 份 TAP 零 not-ok；其余 33 文件全绿计数与报告一致（wiring 14、gateway 25、receipt 8、lifecycle 6、crash-side-effects 7、enterprise-s1 31 等）；unit 65/65。
- 中间失败披露：Dirent 编码、非递归 mkdir、quarantine 首版误隔离空目录（生产回归，收窄且未改 wiring 断言）、manifest rows 从未写入（诊断脚本定位 buildManifest key 口径，修复 + restore 缺 rows 固定拒）、重放等待条件 >=2→>=1 并加无 error 断言——全部为修复与加强，无断言放宽。

## 结论：request_changes（收窄：一条必修）

备份/恢复主体设计合格（VACUUM INTO 选型、stopped 判定、只到空目录、HEAD 比对不 reset、行数守卫、quarantine 语义），但 restore 对 manifest 路径缺少遍历防御，违背本片自己的「绝不覆盖既有状态」核心承诺，须修后复验。

## 必修

- **R1：restore 的 manifest 路径遍历。** `validateLayout` 只查 `state/`、`workspaces/`、`audit/` 前缀与 gateway.lock；`state/../../evil` 能通过前缀检查——校验读 `join(backupDir, f.path)`、写入 `join(stateRoot, path.slice(...))` 都会被 join 规范化逃出目录：读侧把备份目录外任意文件纳入校验，写侧把恢复产物写到目标目录之外（含覆盖既有文件），直接违背「只恢复到空目录、绝不覆盖既有状态」的本片核心承诺与本仓库对「篡改备份=对手」的一贯口径（字节翻转测试即此框架）。修复（很小）：逐条拒绝含 `..` 段、绝对路径、空段的 manifest 路径；恢复源 lstat 必须为常规文件（拒绝符号链接——copyFileSync 会跟随，防把宿主任意文件读进恢复目标）。

## 逐项核验

### (1) 备份一致性 —— 通过（两条 notes）
- VACUUM INTO 选型依据成立：网关已停止（无写者）前提下打开源库即见 WAL 最新提交，产物单文件自洽；源与产物双侧 integrity_check + 关键表行数比对；close 时 checkpoint 折叠源库 -wal/-shm。WAL 反例测试真实（只拷主文件连 schema 都丢、主+WAL 一致）——通道必要性有证明 ✓。
- stopped 判定：复用 state-lock 同一判定原语的只读探测（inspectGatewayLock 不取不改）；活锁/他机/不可解析一律拒；陈旧锁放行并在 manifest 注明；pid 复用按活处理（fail-closed）✓。绕过面：手动删锁后网关仍在写、或 inspect 与拷贝之间网关恰好启动（TOCTOU）——检测不到（note-1：建议拷贝完成后复查锁，发现新锁即作废备份）。
- manifest 完整性：不在自身清单内、无签名——本地事故完整性成立，对抗性篡改只能靠布局防御 + 行数守卫兜（「删 rows 固定拒」测试在案）。备份离机分发场景建议加 HMAC/签名（note-2，定级低-中：能改备份目录者本就有同权限写源）。

### (2) 恢复安全 —— 主体通过，R1 除外
- 只到空目录（stateRoot/workspaceRoot/audit 目标任一非空即拒）、sha256 逐文件校验列全差异、恢复后 integrity_check + 行数比对 manifest（缺 rows 固定拒——防「文件自洽但数据丢了」）、HEAD 比对绝不 reset/checkout、布局防御（未知前缀/多审计文件/含 lock 即拒）✓。
- 权限 0700/0600 ✓（测试断言实际 mode 位）。.homes 排除：git 代理凭据不入备份，恢复后网关会话启动时重签——功能不缺失（会话启动必重写 .gitconfig），manifest notes 明示 ✓。

### (3) quarantine 判定 —— 与 handoff 一致，一条 note
- meta 损坏 → 隔离；有真实状态（session.sqlite/prompt-ledger 等）而 meta 缺失 → 隔离；**空目录（或仅 tmp 半成品）→ 视为未创建走正常新建**。测试实证最危险形态：ghost（session.sqlite 在、meta 缺）被拒且不产生新 owner、meta 不被改写；marker 命中路径持续拒绝；审计留痕 ✓。与「corrupt 不重新认领 owner」一致——corrupt 与有状态 missing 都拦下了，空目录放行符合「部署面预 mkdir」现实。
- note-3：代码注释称崩溃窗口「目录里只可能有 meta 的 .tmp 半成品」，但实际 meta 临时名是 `meta.json.tmp`（server.ts:1250 `metaFile + ".tmp"`），不匹配过滤正则 `/^\..+\.tmp$/`——恰在 meta 写入两步之间崩溃的会话会被误隔离（可用性损失、fail-closed 方向、窗口极窄）。建议把 `meta.json.tmp` 记为非 meaningful 或统一 tmp 命名。

### (4) 例1 transcript 竞态与恢复一致性 —— 解释成立，测试真实
- 竞态解释成立：Session.#start 先 emit session.ready、快照帧异步到达，旧测试在 ready 后立即比对必然偶发为空；修后等 session.snapshot 再 reduce 比对 ✓。
- 一致性证明真实：roleTexts(stateA) 与 stateB deepEqual（transcript）、uncommitted.txt 在 + git status 非空（未提交改动原样保留）、receipt replay 返回原 sessionId 且 replayed=true、加 connB 无 error 断言（重放失败不得被掩盖）；manifest 侧 gitHead 正则、dirty、receiptCount、rows.entries≥1（修复后的行数守卫）逐项断言 ✓。无放宽；中间失败全部收敛为更强断言。

### (5) external_blocked —— 如实
PVC/卷快照、真实集群恢复演练、RPO/RTO 四项在 diff 中无任何 mock 或假装实现（backup/restore 均为本机目录工具）；恢复报告对审批未知态如实标 `pendingApprovalsKnown=false`，不虚构 ✓。

## 残留 notes（不阻塞）
1. 备份 TOCTOU（见 (1)）——建议拷贝后复查锁。
2. manifest 无签名/HMAC——离机分发前建议补（定级低-中）。
3. quarantine tmp 过滤与 meta.json.tmp 命名不匹配（见 (3)，一行修复）。
4. backup 以读写模式打开源库并 checkpoint——网关已停止前提下可接受且有折叠 WAL 收益；如需严格只读可改 readonly 连接执行 VACUUM INTO。
5. S3d-q 例中 fresh 会话 start 因模型不可达失败属预期（与隔离语义无关），测试口径正确。

## 证据
diff：/tmp/perimeter-exec-r78-KoZDveWo/s3d-code.diff；TAP：同目录 backup-restore.s3d5-{1,2,3}.tap、*.s3d5.tap（30 份零 not-ok）。关键源码位：scripts/backup.ts（锁门 :360-368、VACUUM 通道 :246-278、.homes 排除 :394-399）；scripts/restore.ts（validateLayout :515-522——R1 缺口、ensureEmptyTarget :527-533、行数守卫 :598-621、HEAD 比对 :629-645）；src/gateway/server.ts:1072-1115（#quarantineIfBroken）、:1141-1144（接入拒绝）；src/gateway/state-lock.ts:133-151（inspectGatewayLock）；tests/backup-restore.test.ts（7 例）。
