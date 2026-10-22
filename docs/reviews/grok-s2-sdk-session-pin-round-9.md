# Grok S2 SDK session-pin 第九审（round-9，ledger 安全白名单微门）：request_changes——生产路径泄漏未闭（driver-probed 仍透传 raw driver；producer 只挑顶层键，canary 2/2 fail 独立复现）；归属验证未削弱部分认可

- **结论**：**request_changes**。本轮目标（R-Q9e 修复包：PS command 只内存归属、持久化白名单、canary 纯 fake 负控、0600）在**测试替身层全部落地且绿**，但**实际生产路径未达作者自己 spec 的验收句「实际 ledger 生产路径 serialize 后不存在 canary 或完整 argv」**：协调者 canary 负控本审原样重跑 0 pass/2 fail 复现，且真实 Docker 通道的 `driver-probed` 事件（R8 泄漏的确切事件）至今仍透传 raw driver 对象。另记录一次窗口内真实 session-pin 运行与「未跑」声明矛盾（交协调者裁决）。归属验证本体未削弱，予以认可。
- 日期：2026-10-17；审查者：grok（唯一 reviewer；Pi 唯一 coder，其派单 task_dec86c03f705 / ctx_0ab5c658c731；本审 task_5819ebb193d5 / ctx_4fc68935dc04；协调者追加清单 msg_aa97da9fe0e4 全部纳入）。依据：Pi spec 全文 + round-8 报告 + 作者 report §14 + 源码直审。
- 允许写入：本文件、coverage。未改实现/tests/SDK/作者 report/handoff/AGENTS；未 commit/push/spawn；未跑真 Docker/health/daemon/session-pin/SDK vitest/全量/builder；未动 stash/SDK 源；零 cargo/npm 生命周期/新依赖。

## 1. Required 清单（R-Q9f～R-Q9k；全部有代码/日志实证）

1. **R-Q9f（主泄漏事件未修）**：`tests/docker-owned-ledger.test.ts:84` `ledger("inspect", { nonce, container: name, driver, outcome: "driver-probed" })` —— `driverProbe`（:42-53）返回的 `{pid, identity:{ppid,pgid,birth,command}}` 被**整体原样**传入 producer；`command` 即 `ps` 捕获的完整命令行（R8 实证含 `pi-env serve --token <值>`）。该行正是 R8 token 泄漏的确切来源事件，本轮**未修**；投影视 `projectSafeIdentity` 只用于 driver-gone 分支（:121-125）。作者 §14.1「driver 记录为安全投影 metadata…不写实际 argv」与代码不符。真实 Docker 通道一旦复跑即再污染。修：driver-probed 事件持久化仅安全字段（pid/ppid/pgid/birth/commandMatchesMarker）。
2. **R-Q9g（producer 无深投影/无固定类别）**：`tests/helpers/ps-observer.ts:190-213` `appendLedgerEvent` 只对 `LEDGER_ALLOWED_KEYS` 挑**顶层键**，`driver`/`outcome` 等**值原样赋值序列化**（嵌套对象、任意字符串一律透传）；:193 注释「不透传未知键/嵌套对象/raw Error.message」与行为不符（未知**顶层键**确被丢弃，门① 可证；嵌套对象与任意 outcome 字符串照存）。协调者 `/tmp/perimeter-r16/coordinator-ledger-canary.test.mjs` 两门（outcome 原始 `--token` 诊断；driver 嵌套 identity.command/env/token）本审**原样重跑 0 pass/2 fail、exit 1、107ms、PGID 85623**（coor 原失败 log 留存 r16，本审新 log r16-grok，互不覆盖）。验收即 Pi spec 原句：修后 canary 必须转绿。
3. **R-Q9h（canary 替身覆盖缺口）**：作者 ledger-privacy 5 项虽走真 producer，但**输入是测试自己先投影/先分类后的干净数据**：门①（:46-73）测试内自行 `projectSafeIdentity` 再喂 producer；门②（:76-89）`fixedCategory` 在**测试本地三元计算**，含凭据的 raw 诊断从未进入任何生产分类路径（生产路径目前不存在分类）。因此 5/5 全绿证明的是「喂干净数据则干净」，对本轮实际缺陷（R-Q9f/g/j）零覆盖——本审 canary 复现即反证。
4. **R-Q9i（新文件创建权限窗口）**：`appendLedgerEvent` 新文件路径 = `writeFileSync(…, { flag: "a" })`（默认 mode，umask 后 0644）**之后**才 `chmodSync(0o600)`（:209-211）——创建到 chmod 之间存在 0644 可读窗口。修：创建时即 mode 0600（`writeFileSync` mode 选项 / `openSync`），已存在文件「保留现权限」的如实语义保持不变（该部分本审认可，门③/mode 边界两测如实）。
5. **R-Q9j（真实路径 raw 诊断绕出，违反 spec「固定 phase-outcome，绝不…任意原始 stderr 或 Error.message」）**：a) `ps-observer.ts:111` waitOwnerGone unknown 事件 `outcome: id.detail`——detail 内嵌 `r.error.message` 与 ps stdout/stderr 60 字符切片（:51/:56/:57/:60），而 ps stdout 即被观察进程的命令行（daemon/driver 场景可含 `--token <值>`）；b) `docker-owned-ledger.test.ts:127` `outcome: \`driver-gone 观察: ${String(e).slice(0,120)}\``（raw Error 入 ledger）；c) `session-pin.test.ts:126` throw 内嵌 `JSON.stringify(idAtStart.identity).slice(0,120)`（daemon argv 可含 token，经异常进测试日志）。修：三处改固定类别/去命令内容（抛错保留失败语义，detail 不入持久通道）。
6. **R-Q9k（文档与台账）**：a) §13.2（report 行 337）旧错误分解「544=506+19+14+3+2」**仍在原位**，仅 §14.5 声明废弃——须原位更正为「544=506（R6 终态）+24（ps-observer）+14（daemon-fault）」；b) §14.6 哈希台账与终态不符：ps-observer.ts 报 `806b7eb457d602d7`、实测 `b2f139c31e10d8df`；daemon-resource.ts 报 `b20057f008d9ca8c`、实测 `adc0716cc8a2e8b8`；fault 报 `3e2188e9c525a113`、实测 `fd58cd6c99cf9068`（与 R8 一致＝内容确未变，但数值系误引）；session-pin.test.ts 实测 `7c9ab3d5e688ac12`、ledger-privacy.test.ts `b5921fbc75d9ff6d`、docker-owned-ledger.test.ts `370cd03dc996e693` 均未记录（「以下一次全量验证为准」不成立——hash 现在就可测）；c) §14.1 driver 投影声明随 R-Q9f 一并更正。

## 2. 执行边界事件（如实记录，处置由协调者裁决）

- **窗口内一次真实 session-pin 运行（与「未跑」声明矛盾）**：`/tmp/perimeter-r9/ledger-session-pin.jsonl` 766→**796** 行，新增 30 行（`pin-17622-mvc6l9nl-*` nonce，openenv+6 轮共 7 个真实 daemon 全生命周期 start/cleanup/inspect-gone），ledger mtime=**09:15:27Z**，落在 Pi R9 派单窗口（09:06:43–09:44:00Z）内、作者 inventory（09:15:00Z 实记 766）后 27 秒、其两批测试（09:14:43 / 09:16:38）之间；无任何保留日志。§14.4「按派单未跑：session-pin.test（真 daemon）」与该 ledger 证据矛盾。归属推断：时间线+该文件默认 LEDGER 路径+窗口唯一活动方指向作者终端；本审该时段处于 idle（R8 已 worker_done，本轮 09:44Z 才恢复），无其他方活动证据，但不能绝对排除。缓解事实：新增 30 行全部安全字段、无 token（全文件扫描 0）；旧行字节未动（纯追加）。**纯 fake 边界在该窗口被一次真实 daemon 运行突破（归属如上）**。
- **「本轮 fresh 计数」表引用旧绿**：§14.4 coor oracle 行引 `/tmp/perimeter-r12/coor-unk-final.log、coor-reg-final.log`——mtime 07:58Z，早于派单 09:06:43Z（R6-era 重跑，作者括注已自认），却列入「本轮 fresh 计数（实数）」表；finalizer-state oracle 本轮未跑未列。旧绿不计入本轮：本审已将三 oracle 原样重跑到新 log 全 exit 0（见 §3），本轮事实以本审新 log 为准。
- **builder 疑点核销**：r16 无 builder 日志；全 /tmp 无 17:00Z 后 builder 产物；§14.4 明列 builder tests 未跑——本轮无 fresh builder4 宣称，无两面矛盾（R8 轮 builder 4/4 系当时授权范围内历史事实，r15 存档）。
- **旧证据完整性**：r15-docker mode 600 / 9 行 / 1 token 行、r9-docker 644/193 行/9 token、r11-docker 644/43 行/5 token——与作者 inventory 及 R8 记录一致，字节未动；README（10-14）、handoff（10-13）、coverage（末次写入为本审 R8）本轮未被作者触碰 ✓；pi-mono HEAD `8efd314fa`、`stash@{0}`（GitHub_Desktop）原样未动 ✓。

## 3. 本审独立实测（/tmp/perimeter-r16-grok/；批准 runner+预 deadline；real argv/PGID/counts/exit/wall 均读原始尾）

| 门 | 结果 | raw（runner 启动命令/PGID/耗时/exit） |
|---|---|---|
| 协调者 canary 原样重跑 | **0 pass / 2 fail，exit 1**（生产路径存 canary 实证） | `node --test --test-concurrency=1 --test-reporter=spec /tmp/perimeter-r16/coordinator-ledger-canary.test.mjs`；PGID 85623；107ms；`coor-ledger-canary.log` |
| ledger-privacy（作者 5 项） | 5/5 exit 0（替身层绿，见 R-Q9h） | tests/ledger-privacy.test.ts；PGID 85704；107ms；`ledger-privacy.log` |
| ps-observer | **24/24** exit 0 | PGID 85765；425ms；`ps-observer.log` |
| daemon-resource-fault | **14/14** exit 0 | PGID 85826；114ms；`daemon-resource-fault.log` |
| 协调者三 oracle 原样新 log | **4/4 exit 0**（finalizer-state 2 + registered-cleanup close1 + unknown-generation unknown 拒绝） | 三 mjs 合跑；PGID 85907；215ms；`coor-three-oracles.log` |
| typecheck | 0 错误 exit 0 | npx tsc --noEmit；PGID 86521；2.8s；`typecheck.log` |

- 与作者 r16 final 批次计数一致（5/24/14/typecheck0）；final 日志（09:16:37-38Z）晚于全部代码末次修改（≤09:14:39Z），对应终态代码 ✓。
- 按派单**未跑**：真 Docker/health/daemon/session-pin/SDK vitest/全仓 serial+bounded/builder；未动 stash/SDK 源。我方运行零 ledger 污染（四个 r9/r11/r15 ledger 行数与 mode 运行前后一致，临时目录由测试 after 清理）。

## 4. 认可部分（不因 request_changes 抹杀）

- **归属验证未削弱**：`matchesGeneration` 的 command marker 比对仍在内存（ps-observer.ts:89）；daemon-resource.ts 出生核验 mismatches 已去 command 片段（:67-74，「command 无 marker（片段不透传）」）且 ledger/throw 均无片段；driverProbe 全 argv 仍只在内存用于归属。R-Q9e 的「in-memory 归属 + 持久化白名单」分离原则在**已修的路径**上成立。
- **单一 producer helper**：session-pin（:55-58）与 docker-owned（:29-32）两通道确走同一 `appendLedgerEvent` ✓；未知顶层键丢弃有效（门①负控 token/env/rawCommand 被弃 ✓）；`projectSafeIdentity` 投影本体正确（仅 ppid/pgid/birth+布尔）✓。
- **已存在文件权限语义如实**：kept-existing + 「不妄称 mode 参数能改旧权限」表述与代码一致（门③/mode 边界可证）✓；新文件终态 0600 可证（唯创建窗口待修，R-Q9i）。
- 纯 fake 负控自身无真实资源；canary 值全为假数据（CANARY_RPC_ONLY_FROML_TEST），无真实凭据入测试 ✓。

## 5. R8 勘误（协调者指令事项；本审自查自纠，不改 R8 原文、以本节存档）

1. **CID 尾有误**：R8 §2 表「CID c63eb25fb909…a5d9e」尾段错误。raw 全 ID 实为 `c63eb25fb909a85eda6930d542b247e3e65af836ce485570e10695956ad80fd5`（`/tmp/perimeter-r15/ledger-docker.jsonl` 原文逐字），凡引用以 raw 完整 ID 为准；RPC token 值继续零抄录。
2. **「525 非实测」系误写**：R10 轮（task_8a813eeb332a 验证）serial 525/525 + bounded 525/525 双绿为 runner 实测真实已证（本审 round-4 报告与 r10 raw 在案），不可抹。正确口径：**544 = 506（R6 终态）+ 24（ps-observer）+ 14（daemon-fault）**；525 为该轮当时终态实测值，与 544 分解口径并行不悖。
3. **「共 10 行 token」不完整**：R8 只扫 r15+r9；本轮独立扫描证实 r11-docker 另有 5 行——总计 **15 行**（r15 1 + r9 9 + r11 5），三文件字节/权限现状见 §2。

## 6. 边界声明（微审 approve ≠ 更多）

本审不构成：真实通道复验（改造后 session-pin 真 daemon 与 Docker ledger **尚未经真实运行回归**——作者 §14.4 自认，本轮亦禁跑，真实资源证据通道在 R-Q9f/g 修复并 canary 转绿前维持阻塞）；全部 G1 3s 预算门槛；G3；S2；企业。30s 未察觉窗口/无响应 CANCEL/remote lost 死亡/整仓历史资源（unknown）/Pod 维持 pending/unknown/blocked。已批 SDK/G1-knownlost/资源状态机不重开（本轮 fault 14/14 与 observer 24/24 为回归旁证）。后续隔离 owned 基线 + vendor.patch 隔离重建证明由协调者另派，非本包。
