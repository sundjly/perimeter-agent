# grok-s2-sdk-session-pin-round-15.md — R14 修复包（R-Q14-1..9）定向复审 + R14 表述更正（task_2dd0af48fbf3 / ctx_b122f403a16b）

- 日期：2026-10-18；审者：Grok（唯一 reviewer）。被审对象：Pi task_04dc9eda802e / ctx_4eae753776ad 修复包，fresh root `/tmp/perimeter-r14-fix-fZM9j0/`（sdk5 r3 `626351fc7928148b…`、docker probe `50b97328adafd861…`、preflight `369f44d1184212bc…`、plan r3 `f0af593b69abb4be…`、abort-fixture/repro 不变 `009148ab…`/`47c6b1de…`，与 §18.1 及 sha256-deliverables.txt 一致；repro 与 R13 冻结根逐字节相同实测）。
- 审性质：R14 九项 required + O-1/O-5 定向复审。**零真实资源执行**：未运行 repro/SDK 五行为/真 daemon/容器/原 test/全量；执行面仅为 `node --check`×7（全过）、只读哈希、本审自有 root 内 purefake 接缝（协调者 R14 oracle 按派单**先复制到自有 root 并改 sourcePath→Pi 修复 root**，未运行 coor 原件）。
- **verdict：request_changes——R-Q14-1/2/3/4/6/7/8/9 与 O-1/O-5 实证闭合；新 required 4 项（R-Q15-1..4，§5），全部为 owned 副本内最小修改；修后本审同口径复核，通过即窄批准另派 Pi 真实执行。**

## 0. R14 报告表述更正（事实为本，先行披露）

R14 报告「允许写入范围/§7」声称协调者 oracle root「只读未触」——**该表述不实，在此更正**：R14 本审复跑命令 `node --test /tmp/perimeter-coordinator-r14-oracles-phIYrr/oracles.test.mjs` 直接执行了 coor 目录内的脚本；该脚本自身 `writeFileSync(new URL('./source-provenance.json', import.meta.url))` **实际重写了 coor 冻结 root 内的 source-provenance.json**（执行路径由 R14 root 内 `grok-oracle-rerun.log` 首行在案）。`oracles.test.mjs` 本身前后 SHA 相同（`d37b9551…`，R14 时与今日复验一致）；source-provenance.json 系同输入确定性再生成，但**无写前独立 SHA，不能宣称逐字节未变**（现值 `1232294f411ffd73…` 留档）。本审 R15 已按正确口径执行：oracle 副本落自有 root、sourcePath 改指 Pi 修复 root、coor 原件零执行。R14 §0 的 repo 杂散误写披露原样保留；旧报告/旧 root/旧红一律未覆盖。

## 1. 交付物与先验复验（实测）

| 项 | 实测 | 结论 |
|---|---|---|
| 九个交付 SHA vs §18.1/deliverables | 全符（§头表） | ✓ |
| repro.mjs cmp vs R13 冻结根 | 逐字节相同、未运行 | ✓ |
| 旧 prep root / coor root 冻结 | prep sdk5 仍 `a0625d44…`；coor oracle 仍 `d37b9551…` | ✓ |
| `node --check` | 7/7 过 | ✓ |
| helpers/vendor/安装 dist/daemon 二进制/runner | 与 §16.5/§17.4/R14 台账一致（本审未重跑全量，抽验一致） | ✓ |
| **sha256-deliverables.txt 内 audit-notes 行** | 载 `fa95d8bbc1d09ff0…`，实际 `8a3b94c2f7dffdb7…`——manifest 未随 O-1 节增补重盖 | ✗ → R-Q15-4 |
| preflight 证据自洽 | children jsonl 12 行=两次 docker version ETIMEDOUT 失败轮（unknown 如实）+终轮 ready×4；runner exit 0 PGID 54303；`docker-image-id.txt` 经 `xxd` 逐字节核验为**恰 64 hex+LF（65B）**，与 r3 脚本 `--format {{.Id}}`+`sha256:` 剥离+64hex 正则门（preflight:182-191）及 §18.1 声明一致 | ✓ |
| repo 足迹 | 仅 s2-sdk-session-pin.md（§18.1）+implementation-progress.json（Pi）与 coverage（R14 审），其余为既有未提交状态 | ✓ |
| 残留模式扫描 | 三脚本 `unref`/`Promise.race`/`Atomics` 代码零命中（仅注释/字符串） | ✓ |

- 审者显示通道注记：本审 `cat` 该 Id 文件时输出两次出现非盘上模板串（`{{BANK_CARD_…}}`/`{{PHONE_…}}` 各一次、互不一致），`xxd` 证明盘上为纯 hex——判为审者输出层注入、非盘上字节；凡证据引用以字节级核验为准。

## 2. R-Q14 逐项复审

| 项 | 实证（文件:行） | 结论 |
|---|---|---|
| R-Q14-1 预算 | plan:19-24 整轮 30s+分层口径（显式 ≤5s；产品内部 plan.start 30_000（execution-env.ts:47）、cleanup rm -f 5_000（execution-backend.ts:636）如实标注，不宣称全部 5s）；probe:42/70-71/299-300 同口径；SDK 保持 90s/15s（plan:16、sdk5:79/:40） | **闭合** |
| R-Q14-2 race/unref→abort+close+真 join | `withDeadline` 重写（sdk5:233-248：无 race/无 unref，await p 结算；onDeadline 触发 abort+close）；`runCase` finally `ctl.abort()`+`Promise.allSettled(pending)` 真 join（:278-281）；超预算即使底层完成也如实 `case_deadline` 红（:266-269）；五 case 全部 exec 经 `api.join`；本审独立 oracle（§4）2/2 证 | **闭合** |
| R-Q14-3 readReady 同步阻塞 | 改异步轮询（sdk5:194-204 `await setTimeout(25)`）；Atomics 零残留；本审独立 oracle test2 过 | **闭合** |
| R-Q14-4 B4 新代预登记 | 触发重连前 `cleanups.push` 迟发现 cleanup（sdk5:366-381：tracked→dispose；observed→close+同代 waitOwnerGone；calls≥2 未发现→显式 unknown throw；calls==1→无第二代）；cleanup 零 snapshot 重连；重连成功后先采身份（:405-409 snapshot 命中既有 #ready）再 track（:410） | **闭合** |
| R-Q14-5 B5 预登记/绑定/settled/abort-gone-only | 两 fixture finalizer exec 前预登记（:448-450）；ready 核验后即时绑同代（:458-463）；未观测不杀（fixtureFinalize :214-229）；abortKillProven 仅 waitOwnerGone 正向 gone（:475-481），:489 补杀不充数；全 promises join。**但 fixture TTL 8s/0.6s 未改 → 自然到期混淆窗，见 R-Q15-1** | 核心**闭合**，新缺口 R-Q15-1 |
| R-Q14-6 knownlost 布尔 | `isKnownLost`（:148-152）=code unknown 且 message 含 "connection lost"；四处断言全用（:341/:349/:390/:417）；`lostMatch` 布尔入 dumpRawExec（:161），原文不打印不持久；本审 purefake 负控 4+1 过 | **闭合** |
| R-Q14-7 CID/driver 守卫 | `isFullCid`（probe:91-93）:240 非 64hex 从严；driverProbe 正向出生（:134-153：pid/ppid/pgid 正整数+birth 非空+ppid==process.pid，否则 unknown）；inspect 白名单加 label==gatewayId（:234-244）。**driver 调用时序缺陷见 R-Q15-3** | 守卫**闭合**，时序新缺 R-Q15-3 |
| R-Q14-8 全路径 settled+failure JSON | closeOnce create 前登记（:203）；finally（:259-285）+主体 catch（:286-289）+兜底 `runAllCleanups`（:290）任何路径都到；unhandled 写完整 failure JSON（:320-327；sdk5:598-603）；sdk5 main finally 在全部 case join 后（:555-561） | **闭合**（closeOnce 语义缺口另列 R-Q15-2） |
| R-Q14-9 preflight Id 投影 | `--format {{.Id}}`+sha256: 剥离+64hex 校验，异常写 "unknown"（:182-191）；旧 root 整 JSON 证据保留；终轮 Id 与 §18.1 首 16 一致 | **闭合** |
| O-1 | audit-notes 顶部 O-1 更正节保版本序（:3-5）；plan r3 真值 f0af593b 在 deliverables | **闭合**（manifest 行缺陷归 R-Q15-4） |
| O-5 桥接口径 | probe 头注 :16-19/§2 :160-166、plan §2、§18.1 一致：不同模块实例+字节级等同+guard=owned-dist；probe=产品纯 plan 隔离 probe（environmentPlan:228-231+owned 5s start+owned Connection/RemoteEnv:251-254），未用完整 backend.environment()（内部 30s 不被使用），Connection 数组形态为 SDK 合法入口（vendor connection.js:192、产品 openEnvironment 同款） | **闭合**（plan §2 一处措辞残留见 R-Q15-4） |

## 3. 协调者 6 疑点独立核实

1. closeOnce undefined 路径按名 rm+closedHandle 先置位 → **成立** → R-Q15-2。
2. driverProbe 在 new Connection 之前（:247 先于 :251-253）→ 该时刻 host 侧不存在任何匹配进程，结构性必 unknown → **成立**；且 owned Connection 未登记 cleanup，snapshot/exec 失败路径无 close → **成立** → R-Q15-3。
3. inspect 失败/label 不匹配仅 push failure 但仍可能 rm → **成立**（正向归属未作为 rm 前置）→ 并入 R-Q15-2。
4. plan 元数据：预算分层与 O-5 主体已同步；残留一处「产品 backend 内部连接=installed-dist」未加「（如有）」（probe 已无产品内连接）→ 部分成立 → 并入 R-Q15-4 文本同步。
5. B5 TTL（msg_51cc52534263）：long 8s 短 0.6s 未改 → **成立** → R-Q15-1。
6. raw Error.stack/子进程输出落私有 evidence：**判合规、非 required**——R11 审已认定「私有 owned 0700 evidence 保留即合规范围」、R13 已批 repro.mjs 同款 child-N-*.log/failure-raw-context.log 例外；禁令对象为 repo/reporter/ledger 持久通道，本包三通道（0600 白名单 ledger/固定类别 summary·failure/runner 带内仅固定行）实测干净；dumpRawExec 仅存 {ok,exitCode,code,lostMatch}。不因 0700 新开通用例外，系沿用既批 R11/R13 口径。

## 4. 本审独立 purefake/oracle 实测（自有 0700 root `/tmp/grok-s2-r15-review-b2hica2o/`）

| 运行 | 结果 | 证据 |
|---|---|---|
| coor oracle 副本（改 sourcePath→Pi fix root；async readReady 适配+setTimeout 注入，两条断言语义原样） | **2/2 pass，exit 0，PGID 74831**（R14 同源断言对 r14-prep 旧版曾 0/2 exit 1/PGID 34882——红绿对照成立） | `grok-coor-oracle.test.mjs`/`grok-oracle-rerun.log`/`grok-source-provenance.json`（0600） |
| 本审 purefake（vm 抽取 isKnownLost/isFullCid） | **2/2 pass，exit 0**（lost 负控 4+正控 1；CID 12hex/63hex/大写拒、64hex 过） | `grok-purefake.test.mjs`/`grok-purefake-run.log`/`grok-purefake-provenance.json`（0600） |
| Pi 自证复核（只读取证） | coor-oracle 2/2（PGID 52102）、purefake-own 4/4（52185）、purefake-deadline 3/3（51822：close 恰 1/naturalDone=0/abort 后零 spawn/如实红/wall<2s）与 runCase 实现（:266-269）互证；其 provenance 均 0600 只写本 root | 各 *-run.log |
| `node --check` | 7/7 | §1 |

## 5. 新 required（4 项；最小修法）

- **R-Q15-1（B5 fixture 自然到期混淆窗；msg_51cc52534263 落实）**：长 fixture 自限 8s（sdk5:454 `"8000"`），而最坏 abort-gone 观察窗=ready+~0.4s+T1(<5s,:472 守卫)+5s(wait :476-478) ≈ **ready+10.4s > 8s**——自然到期可落入窗内冒充 abort-kill 绿。修法：`"8000"→"30000"`（>case 15s，混淆窗结构性消除）；sentinel `"600"→"5000"` 并在 `controller.abort()`（:470）前加 `psIdentity` 正向 alive 断言（sentinel 在 abort 时仍活→之后独立完成→其 PID 正向 gone，「不伤 sentinel」由旁证变正证）；plan §3 同步。
- **R-Q15-2（closeOnce 正向归属前置+重试闩）**：probe:200-223 `fullCid===undefined` 时直呼 `backend.cleanup(sessionId)` 按名 rm=无正向身份杀资源；:202 `closedHandle=true` 在尝试完成前置位使 unknown 后不可重试。修法：undefined/重验路径一律先按名 inspect 取回**同一容器**并核 `64hex CID+label==gatewayId+running` 全部成立才允许 backend.cleanup；gone→no-op；mismatch/unknown→不 rm+failure 记录；`closedHandle` 改为尝试完成后置位（幂等保留、unknown 可被 runAllCleanups 二次尝试）。
- **R-Q15-3（driver 发现时序+owned Connection 生命周期）**：:247 driverProbe 先于 :251 Connection 创建——结构上必 unknown、正控必假红；且 :251 Connection 未登记清理，snapshot/exec 失败路径 transport（docker exec 客户端）无显式 close。修法：driver 发现移至 connection.snapshot() 成功之后（此刻 docker exec 客户端已存在，`ppid==process.pid` 正向核验即真实成立）；创建后立即登记幂等 close cleanup（先 close transport 再容器 rm）。
- **R-Q15-4（manifest/文本同步）**：sha256-deliverables.txt audit-notes 行重盖为现值 `8a3b94c2f7dffdb7…`（保留版本注记）；plan §2「产品 backend 内部连接=installed-dist」加「（如有）」或删（probe 已无产品内连接）。

## 6. 边界声明

R11 日志门/R13 artifact 门不重开（helpers/vendor/repro 哈希未动）；原 SDK 5 未跑/未导入，current5fail、544×2、全部旧红保留；artifact 8/8 ≠ behavior 5/5；G1 全部 3 秒/G3/S2 企业 partial 不升级；本审绿（purefake/oracle/node --check/哈希）不预支真实行为绿；产品/SDK/vendor/tests helpers/依赖锁/node_modules/旧证据全只读。R-Q15-1..4 修复后由本审对四处受影响代码同口径定向复核，通过即窄批准协调者另派 Pi 真实执行（repro 45s→sdk5 90s→docker 30s，各自独立红）。

## 7. 证据保留

审者 root（0700，不删）：`/tmp/grok-s2-r15-review-b2hica2o/{grok-coor-oracle.test.mjs, grok-coor-oracle-base.mjs, grok-source-provenance.json, grok-oracle-rerun.log, grok-purefake.test.mjs, grok-purefake-run.log, grok-purefake-provenance.json}`。Pi 修复 root、旧 prep root、coor oracle root、全部历史 root 只读未触（本审本轮 coor 原件零执行）。
