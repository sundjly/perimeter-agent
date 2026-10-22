# Grok S2 SDK session-pin 第十一审（round-11，R11 第 4 诊断 oracle 修复验证门）：approve（微门）——R-Q10a/b/c 与 runAllCleanups 聚合通道全项落地独立复证：第 4 诊断 oracle 原样 0/1 fail→1/1 绿 exit 0（R-Q9j 闭环，旧红 3 份留存）、coor canary 2/2、三 oracle exit 0、privacy 15/15（原 9+新 6）、ps-observer 24/24（聚合断言原位更新同语义未删）、fault 14/14 未触、typecheck 0；OUTCOME_ALLOWED 实测 38 项含 7 串精确补全、全生产 outcome 串对账零静默 unknown；driver-probed 恢复 pid+安全投影、driver 不可观测从严 failures.push；§15.1 三处声明原位更正+§15.3 后到红补录（时点公平）；5 旧 ledger 字节/权限运行前后逐一致

- **结论**：**approve（微门，仅限本 R11 修复包）**。round-10 三项 required（R-Q10a/b/c）+聚合通道（runAllCleanups Error.message 持久面）全部落地，本审以批准清单内九门独立复证全绿，SDK 状态机/容器生命周期证明/归属 kill 未重开未触。真实通道复验的前置条件（round-10 §6：R-Q10a/c 修复且第 4 诊断 oracle 转绿）已满足，执行仍由协调者另派，本审不跑真 Docker/daemon。
- 日期：2026-10-17；审查者：grok（唯一 reviewer；Pi 唯一 coder，其派单 task_9243346d0b5c / ctx_c55c6ffa2aa1；本审 task_ecd4e4f71467 / ctx_21a17b16020a）。依据：task_9243346d0b5c 完整 spec（implementation-progress.json nextTask 原文）+ round-10 审全文 + 作者 report §15.1/§15.3/§16 + 五个改动文件源码直审 + 冻结脚本/旧 ledger/旧红日志在盘核验。
- 允许写入：本文件、coverage。未改实现/tests/SDK 源/作者 report/handoff/AGENTS/dep 版本锁/vendor/providerDurableCachePrefix/Paseo/staging/stash；未 commit/push/spawn；未跑真 Docker/health/daemon/session-pin/SDK vitest/installer/builder/全仓/公网模型/npm/cargo 生命周期；未读 shell history/ENV secrets/未知 stash；未打印任何真实 token；未清未知资源；未 import 任何真实 test 模块（九门全部为派单批准清单内项目）。

## 1. R-Q10a（throw/failures/聚合持久通道全固定类别化；失败语义保留）逐项复证 ✓

1. **waitOwnerGone unknown throw**：`tests/helpers/ps-observer.ts:116` 现为 `pid ${pid} ps 观察 unknown（固定类别，raw detail 不入报告通道）`——`id.detail`（ps stdout/stderr 60 字符切片＝被观察进程命令行）不再入异常；`:110` ledger 固定类别 `WAIT_OWNER_GONE_OUTCOME_UNKNOWN="unknown"` 照旧。全文件 `detail` 仅剩注释与 PsState 内部字段（:51/:56/:57/:60 仍在 PsState，但无任何 throw/failures 引用）。
2. **observeBirth unknown throw**：`tests/helpers/daemon-resource.ts:63` 现为 `daemon 出生观察 unknown（pid N，固定类别，raw detail 不入报告通道）`——同规则，ledger `birth-observe-unknown` 照旧。
3. **docker-owned-ledger failures 通道**：逐处核验——:79 inspect 失败、:96 主体失败、:101 close、:102 backend.cleanup、:103 backend.cleanup（创建结果 unknown）、:115 inspect-gone live、:116 inspect-gone unknown、:119 全 CID 未知、:133 driver 观察失败、:138 driver 不可观测——全部固定类别文本；`String(e)`/`stderr.slice`/raw stderr 已绝迹（grep 全文件零命中）；聚合 throw :143 只携 `失败/unknown（${failures.length}）: ${failures.join("；")}`＝固定类别+计数，无 raw 原文。
4. **runAllCleanups**（`ps-observer.ts:160-173`）：全部 callback 逐一执行并 await（catch 仅记 `i+1` 索引，连错误对象都不留存）；聚合恒 reject；message 仅 `cleanup 聚合失败（n/m）：失败步骤 #i #j（raw 诊断不入报告通道）`——无 message/cause/stack/env/toJSON 拼接（grep 零命中，仅注释）。失败语义不削弱：privacy 新测（2/3 计数+`#1`/`#3` 索引+无 canary）与 ps-observer 原测（2/4+`#1`/`#4`）双证。
5. **纯 PS assert 等价更新、case 未删**：`tests/ps-observer.test.ts:119-137` runAllCleanups 用例原位更新为同失败语义（executed 全序断言+`2/4`+`#1`+`#4`+raw 原文 `first-fail`/`second-fail` 不入聚合双断言），测试总数保持 24、用例未删。
6. **拒绝仍 fail/unknown**：r17 第 4 诊断 oracle 原样（冻结 SHA `4cd7a77659e41c24` 未改）本审复跑 **1 pass / 0 fail、exit 0**（PGID 89458、109ms）——oracle 断言即「ledger outcome=unknown 且 throw.message 无 canary 且含 /unknown/」，转绿证明 throw 通道保留失败+固定类别；旧红三份原样留存（§5）。

## 2. R-Q10b（OUTCOME 枚举 7 串精确补全+序列化往返保真；driver unknown 形态）逐项复证 ✓

1. **枚举实测 38 项**：`OUTCOME_ALLOWED`（ps-observer.ts:203-224）逐项清点＝38，7 个新串与 round-10 §5.2 所列逐字一致（generation 未采得…/gone-pid-reused（birth 不同）/identity drift…/inspect-gone: live/driver-gone-pid-reused/gone/zombie）。
2. **全生产 outcome 串对账（本审独立加测）**：对 5 个写入方（ps-observer/daemon-resource/docker-owned/session-pin/daemon-resource-fault）grep 枚举全部 `outcome:` 实参与模板（`driver-${outcome}`→gone/gone-pid-reused、`inspect-gone: ${verdict}`→gone/live/unknown、`start-identity-${id.state}`→alive/gone/zombie/unknown、inspectIdentity `id.state` 直通）——**每一项都在枚举内，无任何已知路径静默坍缩 unknown**。
3. **真实 producer 序列化往返保真**：privacy `R-Q10b` 两测直调实际 `appendLedgerEvent` 落盘读回：7 串逐一原样保真（`record.outcome === outcome`）；枚举外拼接 canary（`gone-pid-reused（birth 不同）--token CANARY`）仍映射固定 unknown 且 `assertNoCanary` 过——canary 任意 outcome 仍 unknown 验收达成。本审 15/15 exit 0 实证。
4. **driver `{unknown:…}` 形态保固定安全类别**：`sanitizeDriverValue`（:242-243）对 `obj.unknown` 为 string 一律返回 `{unknown:"未找到 driver 进程"}`——不返回空对象、不透 raw 未知串（privacy 附注测以 raw `ps 非零 --token CANARY` 直喂实证收敛）；§15.1 R-Q9f 勘误已同步更正原「保持 {unknown:…}」与实际不符处的双向表述。
5. **「约 30 全集」/「throw 非持久」两处不实声明已原位更正**：§15.1-2（枚举缺 7、「全集」废弃，实测 38）与 §15.1-5a（throw＝经异常→test reporter→runner 日志落盘的持久通道）均在原段落实改，本审逐句读核。

## 3. R-Q10c（driver-probed 已知 PID 可审计恢复+driver 不可观测从严）逐项复证 ✓

1. **pid 恢复**：`docker-owned-ledger.test.ts:86` 现为 `driver: driver && "pid" in driver ? { pid: driver.pid, ...projectSafeIdentity(driver.identity, name) } : driver`——持久层恢复 `{pid,ppid,pgid,birth,commandMatchesMarker}` 全安全形状；producer 侧 `sanitizeDriverValue` 保留数字 pid（:247）双保险（privacy raw 门② `driver.pid===1234`+keys 恰 `[birth,pgid,pid,ppid]` 实证，raw identity/command/env 仍被深挑）。
2. **driver 不可观测 else 分支（本派明确指定从严）**：:135-138 ledger unknown 照记 + `failures.push("driver 不可观测（unknown，证据不完备，不假 clean）")`——green 以 driver 已证为界；容器 create/inspect/全 CID inspect-gone 证据链独立成立（:106-118 未动）；SDK 状态机/归属 kill 未触（`session-pin.test.ts aefcd68dcad0c7ce`、`daemon-resource-fault.test.ts fd58cd6c99cf9068` 与 R9 时点值逐字相同＝本轮未改）。round-10 §5.4-b 分类（测试内部证据完备性问题，非 SDK 状态机/非容器证明削弱）维持，二选一修法采从严支，另一支（仅收窄注释）未采。
3. **driverProbe raw `{unknown:"ps 非零 N"}` 形态**：经 producer 收敛固定串（§2.4），无旁路泄漏面。

## 4. 文档原位更正+§15.3 后到红补录（时点公平）核验 ✓

1. **§15.3 R11 补录**：如实记录第 4 诊断 oracle 10:19:36Z 送达、协调者 10:19:40Z 原样复现 fail（exit 1 在盘）、grok round-10 10:21Z 清单复现 0/1 fail——两者均晚于作者 10:13:18Z final 批次（约 10:15 完成帧），作者当时不可知，**本审采信「非隐瞒」**：时间线三源（在盘 raw mtime、round-10 审记录、§15.3 补录）互洽，且 round-10 审自身即 10:21Z 后才批准该复现。
2. **§16 修复节与 progress nextTask**：spec 四项（①②③④）与 §16.1-16.3 逐条对应；§16.4 计数（红→绿/2×2/三 oracle/15/24/14/typecheck 0）与作者 raw 日志在盘一致（`/tmp/perimeter-r19/coor-unknown-diagnostic-RED-before-fix.log` exit 1、`-GREEN-after-fix.log` exit 0 等）。
3. **§16.5 哈希台账 7/7 复算相符（本审 shasum -a 256）**：ps-observer `eaf01cf56f3d073f`、daemon-resource `81d6a84130274d80`、docker-owned `2cbf476a0f053d74`、ledger-privacy `f1aebf65c99e3fb8`、ps-observer.test `91a8954022e475fd`、fault `fd58cd6c99cf9068`（未触）、session-pin.test `aefcd68dcad0c7ce`（未触）；§14.6 历史值注记保留不伪造。
4. **产品零改动 5/5**：`pi-env-patch.ts f7ebe0cedbfb24a8`、`execution-env.ts 9839b87af6c965ea`、`path-guard.ts 747070b26d9b19a4`、`build.mjs 4075300079648e8f`、vendor manifest `0b87934f4c868fde`——与 R8 终态记录逐字相符，「R9/R10/R11 三轮均未触」成立。

## 5. 本审独立实测（/tmp/perimeter-r19-grok/；批准 bounded runner 预 deadline 15s/45s；绝对 argv/PGID/counts/exit/wall 均读 runner 原始日志行）

| 门 | 结果 | raw（启动命令/PGID/耗时/exit） |
|---|---|---|
| coor 第 4 诊断 oracle 原样（r17 冻结，修复后） | **1 pass / 0 fail，exit 0**（round-10 同门 0/1 fail exit 1→转绿，R-Q10a 闭环） | `node --test --test-reporter=spec /tmp/perimeter-r17/coordinator-unknown-diagnostic.test.mjs`；PGID 89458；109ms；11:56:13Z；`coor-unknown-diagnostic.log` |
| coor canary 原样（r16 冻结） | **2 pass / 0 fail，exit 0** | `node --test --test-concurrency=1 --test-reporter=spec /tmp/perimeter-r16/coordinator-ledger-canary.test.mjs`；PGID 89189；111ms |
| coor oracle① unknown-generation 原样（r10） | exit 0（unknown 拒绝语义保持） | `node /tmp/perimeter-r10/coordinator-unknown-generation.mjs`；PGID 89255；62ms |
| coor oracle② registered-cleanup 原样（r11） | exit 0（close 恰 1） | `node /tmp/perimeter-r11/coordinator-registered-cleanup.mjs`；PGID 89319；62ms |
| coor oracle③ finalizer-state 原样（r12） | 2 pass / 0 fail，exit 0 | `node --test --test-reporter=spec /tmp/perimeter-r12/coordinator-finalizer-state.test.mjs`；PGID 89393；108ms |
| ledger-privacy（原 9 保留+新 6） | **15 pass / 0 fail，exit 0** | `node --test --test-reporter=spec tests/ledger-privacy.test.ts`（绝对路径，log 有完整 argv）；PGID 91438；124ms |
| ps-observer（原 24，聚合断言原位更新） | **24 pass / 0 fail，exit 0** | 同式；PGID 91507；416ms |
| daemon-resource-fault（未改） | **14 pass / 0 fail，exit 0** | 同式；PGID 91592；118ms |
| typecheck（现存 node_modules tsc） | 0 错误，exit 0 | `./node_modules/.bin/tsc --noEmit`；45s 预死线；PGID 90079；2852ms；`typecheck.log` |

- **冻结脚本原样性**：五脚本 SHA 运行前后一致（`4f61ec489f41eade`/`7f1f7e873ef454ed`/`3633d1bef92655e9`/`a75ecf8f501ca096`/`4cd7a77659e41c24`），与 round-10 审记录逐一相符。
- **本审执行偏差（如实记录，与作者代码无关）**：首轮五门因本审 runner argv 顺序错误（旗标置于命令前，runner 把 .mjs 当可执行直接 spawn→EACCES）exit 1，五份失败 log 留存于本审目录；改正（`node` 置于命令位）后全绿，非作者代码红。
- **旧 ledger 零污染（运行前后逐字节一致）**：r9-docker 600/193 行/`94ee22f4f5e553cc`、r9-session-pin 644/796/`d84767774691e177`、r11-docker 600/43/`2b4ca3b2c3b45f8a`、r15-docker 600/9/`bb5dca09f493b199`、r15-session-pin 644/150/`8734e2ab5f777cf7`——mode/行数/SHA 前后 snapshots 全等（`old-ledger-inventory-before.txt`/`-after.txt`）。已知 3 docker ledger 现 600（coor 10:12Z containment fchmod r9/r11 不改字节、r15 前轮已 600），两 session-pin ledger 历史 644 时点保留；本审未脱敏/未撤销/未重采任何字节，token 行内容未打印（仅 SHA 比对）。
- **旧红留存**：协调者 r17 raw（exit 1）、本审上轮 r18-grok 红 log（exit 1）、作者 r19 RED-before-fix（exit 1）三份原样未覆写；作者 GREEN-after-fix（exit 0）并存。
- 按派单**未跑**：真 Docker/docker-owned-ledger 运行/health/daemon/session-pin/SDK vitest/installer/builder/全仓 serial+bounded/公网模型/npm 生命周期；未读 shell history/ENV secrets/未知 stash；进程零残留（pgrep 复核）。

## 6. 认可部分（不因边界收窄抹杀）

- **第 4 诊断 oracle 红→绿闭环**：round-10 的核心实证（throw 持久通道携 raw）修复后同门转绿，且旧红三份全保留——「敏感日志通道修复」的主张有在盘可复现证据链。
- **结构收敛而非补丁堆叠**：两 throw 与 failures/聚合共用同一「固定类别+pid/索引/计数」规则，`runAllCleanups` 连错误对象都不留存（catch 无绑定），杜绝 cause/stack 旁路；privacy 新 6 测全部直调实际 producer/真实 throw 路径，无替身。
- **文档更正为原位实改+时点公平**：§15.1 三处勘误、§15.3 后到红补录均实改可核，作者对不可知新红未背锅、对已实声明如实废弃。
- **执行纪律**：本轮作者未越界（无真 Docker/daemon/session-pin/SDK/builder 产物；r19 目录即申报清单）；coor containment 如实记为协调者操作不冒领。

## 7. 边界声明（本 approve ≠ 更多）

本审 approve **仅限 R11 微门修复包**（两 throw+failures/聚合固定类别化+枚举 7 串+driver pid/else 从严+文档三处更正+§15.3 补录），不构成：真实通道复验通过（session-pin 真 daemon 与 Docker ledger 改造后仍未真实回归——前置条件已满足，执行由协调者另派）；全部 G1 3s 预算门槛；30s 未察觉窗口/无响应 CANCEL/remote lost 死亡；G3；整仓历史资源 unknown（r9/r11 docker ledger 644 时点行处置仍待协调者/用户决断，未动字节）；SDK 源级隔离重建/隔离 owned 基线+vendor.patch 证明（另派；SDK 5 未跑+当前源 5 fail 状态保留）；s2-protected-paths/S2/企业 partial；Pod unknown。历史 544×2、R15 全绿事实、09:15:27Z 归属记录均保留不变。round-10 的 approve 部分不因本节扩大；OUTCOME 枚举若后续新增生产串，须随实测集合同步更新「全集」表述。
