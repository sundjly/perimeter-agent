# S3d 复审第 2 轮：s3-backup-restore 修复（round-2）

- 日期：2026-10-21。只读复审，未运行任何测试/进程。基线 HEAD 952d46b（与 round-1 相同）。
- 对象：s3d-code.diff（修复后版）对照 s3d-code-r1.diff，逐 hunk 审增量；工作树实文核验。
- TAP 核验：backup-restore.s3d7-{1,2,3} 各 8/0（三连跑全绿）；s3d6 全量回归 30 份 TAP 零 not-ok；unit 65/65（coordinator 报告，与 TAP 一致）。

## 结论：approve

round-1 必修 R1 闭合彻底（含协调者点名全部变体），随修两条 notes 亦闭合且各配测试；中间失败（首版 R1 例丢 version 被形状校验先拒）以「改测试不放宽断言」方式解决——行为正确。

## R1 闭合核验（逐变体）

- **形状防御 `safeRelPath`**：拒空串/NUL/反斜杠/绝对 `/`/盘符 `/^[A-Za-z]:/`/空段/`.`/`..` 段——Windows 风格（盘符+反斜杠）与遍历段全覆盖；编码变体不成立（全链路无任何 percent/unicode 解码，unicode 名即字面名，join 后仍在根内）。
- **包含性校验 `joinContained`**：join 后 `path.relative` 不为空、不以 `..` 开头、非绝对才放行——防任何规范化逃逸；校验读（:145）、拷贝读（:174）、写目标（mapTarget :116-117）三处全部经它；目录创建走 `dirname(dest)`，包含路径的 dirname 仍包含 ✓。audit 目标是 CLI 提供的运维参数，不受 manifest 控制 ✓。
- **恢复源 lstat**：`lstatSync` + `isFile()`（:148-150）——符号链接**末段**拒（unsafe_source）；校验在 checksum 之前、全部 unsafe 汇总后一次固定拒（诊断完整）。
- **validateLayout** 收集全部非法路径后一次 `unsafe_path` 拒绝 ✓；测试三例分别用遍历路径（`state/../../sentinel-a.txt`，size/sha 真实——若放行必过 checksum）、绝对路径、外部符号链接源（statSync/哈希均跟随链接，证明拦下它的是 lstat 门）断言 unsafe_path/unsafe_path/unsafe_source，且哨兵字节不变、逃逸产物不存在 ✓。
- **变体残留（一条 note，非阻塞）**：lstat 只不跟随**末段**——备份目录内**中间段**符号链接（如 `state/sub → /etc`，路径 `state/sub/x`）理论上仍可把宿主可读文件读进恢复目标；但写侧已完全包含（joinContained），读侧所得不超过恢复进程自身读权限（无特权增益）。如需彻底闭合可加 `realpathSync` 包含校验，定级低。
- **目标根内已有符号链接**：目标非空即拒（readdir 计数含符号链接条目）——已闭合 ✓。

## 随修两条 notes 核验

- **②quarantine tmp 判定对齐**：过滤改为 `!name.endsWith(".tmp")`，注释如实标注 meta tmp 实际名为 `meta.json.tmp`（#buildSession `metaFile + ".tmp"`）与账本 `*.pid.*.tmp` 同理。新测试 tmponly：目录仅含 `meta.json.tmp` 半成品 → 视为未创建、meta.json 正常落盘、无 quarantined 标记 ✓。误判面评估：现布局中无任何以 `.tmp` 结尾的真实状态文件（session.sqlite/-wal/-shm、prompt-ledger.json、meta.json、quarantined.json）；陈旧 tmp 残留与新建会话的 tmp 名（含 pid+uuid）无碰撞——方向 fail-closed，可接受。
- **③backup 只读打开**：`DatabaseSync(src, { readOnly: true })` 优先（VACUUM INTO 只写目标文件，只读源可用，备份全程不写源库）；仅打开失败（崩溃残留 -wal 无 -shm 的 WAL 只读限制）回退读写，注释如实、数据口径不变；校验连接亦只读。无新风险 ✓。

## 测试真实性与过程

- 中间失败：首版 R1 例注入 manifest 丢 `version` 被形状校验先拒——断言码本身正确（unsafe_path），改法是深拷贝真实 manifest 后注入（提高测试构造真实性），断言未放宽 ✓。
- 8 例全绿三连跑；全量 30 文件回归零 not-ok；round-1 全部断言保留（含 rows 守卫、哨兵、WAL 反例、quarantine 四形态）。

## 残留 notes（不阻塞）
1. 恢复源中间段符号链接的读侧残留（如上，建议未来加 realpathSync 包含校验；写侧已闭合）。
2. round-1 遗留保持记录：备份 TOCTOU（拷贝后复查锁）、manifest 无 HMAC（离机分发前建议）。

## 证据
diff：/tmp/perimeter-exec-r78-KoZDveWo/s3d-code.diff（对照 s3d-code-r1.diff）；TAP：同目录 backup-restore.s3d7-{1,2,3}.tap、*.s3d6.tap（30 份）。关键源码位：scripts/restore.ts:69-87（safeRelPath/joinContained）、:91-106（validateLayout）、:140-160（lstat 门）、:115-118（mapTarget）；scripts/backup.ts:61-70（只读优先+回退）；src/gateway/server.ts #quarantineIfBroken（*.tmp 过滤 + 修正注释）；tests/backup-restore.test.ts:255-300（R1 三例）、:355-385（tmponly）。
