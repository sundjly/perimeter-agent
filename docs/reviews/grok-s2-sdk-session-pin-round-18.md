# grok-s2-sdk-session-pin-round-18.md — Pi R17 修复包（R-Q17-1..3 静态修复）定向复审（task_a786461ea91e / ctx_a298f38689c9）

- 日期：2026-10-18；审者：Grok（唯一 reviewer）。被审对象：Pi task_4a83dddf7b7a / ctx_4ab97200ade0 修复包（r6），root `/tmp/perimeter-r18-fix-Ya5UaU/`（本审独立复验 0700/UID501/非 symlink，find 零 symlink；sdk5 r6 `4713132016…`、probe r6 `91e21bacef…`、preflight `c440d49d…` 不变、plan r6 `4d27b9ab…`、audit-notes r6 `3e42b9e2…`、repro `47c6b1de…`、joinfb oracle `dfa15d10…`、purefake `e42c7ebf…`、HANG-DISCLOSURE `f8e870c0…`——12 文件实算 SHA 与交付报告 §1 表及 `sha256-deliverables.txt` 10/10 逐行全符）。spec 依据：R17 报告（R-Q17-1..3）+ 协调者 R17 处置（rm 先行不能只标注偏差/ps 实际双受限/整轮 90 逐路径计入/耗尽不 spawn 不 max1）+ msg_dcf2a1c093b4 getter 事实 + 本轮协调者交付前跟进（msg_b4bdcb46d5d6：driver join→rm 硬门、spawnSync killSignal 与"是否真有整轮主动截止"、§18.4 足迹偏差）+ 用户取消边界。
- 审性质：**零运行静态审**。执行面=只读 hash/cmp、`node --check` 7 文件（7/7 过）、源码逐行静审、两验证件断言与 r6 语义一致性静态核、helpers 只读复核。**未运行**（与作者口径一致，本轮亦不叠 fake）：purefake（含 vm）/oracle/repro/SDK 五行为/preflight/daemon/容器/build/网络——两验证件为**准备未运行**态，不存在任何红绿运行结果。
- **verdict：request_changes——R-Q17-1/2/3 全部静态闭合，本轮零代码 required；唯一 required=R-Q18-1（§18.4 超出任务"仅 §18.3 追加/progress"授权的 repo 足迹偏差，须删除或获明示追认）。行为面与历史 unknown 保持 blocked：静态闭合≠行为验收，真实执行仍待协调者另派且前置 unresolved 取消边界；本审零资源。**

## 0. 过程公平记录（先于结论；不回改旧报告/旧 raw）

1. **本审 R17 初命令失败补记**：R17 开审时 `mkdtemp` 初次命令不存在导致 ROOT 为空、`/manifest-check.txt` 写失败（本审本轮实测文件系统根目录**无** `/manifest-check.txt` 残留），同轮曾有对 `plan.md`（markdown）误跑 `node --check` 的失败；后经纠正以 `/tmp/grok-s2-r17-review-AzdWjrVh` 完成。R17 报告与旧 raw 不回改，此处如实补记。
2. **R17 自有假件轮次记录**：R17 purefake 9 项首跑 4/9、二跑 6/9 红（我方假件/断言笔误）、r4 红对照假件首跑悬挂至 runner 124——各独立 log（run/run-02/run-03/oracle-r4-red 等）在 reviewer root 原样保留未覆盖。
3. **R16 及更早偏差保留**（R17 §0 已录，不再展开）：R16 approve 草判经反例更正的时序、同名 tee 覆盖丢初红与 shell PGID 非独占、coor 隐私缩窄后恢复、ESC 依 Pending 先行干预依据不足、作者与本审在 54m57s unknown 未解时叠 fake 的局限——全部保留原判。
4. **54m57s 挂起 node 终止状态**：本轮（作者与审者）零运行、零扫描、零杀未知，**无任何新增正向退出证据**；Pi 交付报告 §4 同样声明"无新增可报"。unknown 保持；如后续出现现存正向 owner 退出记录，先交协调者确认，不自授权运行。

## 1. 交付与先验复验（实测）

| 项 | 实测 | 结论 |
|---|---|---|
| manifest 10/10 | 本审独立 shasum 全量重算，与 `sha256-deliverables.txt` 及报告 §1 表逐行相符（本审 root `manifest-check.txt` 在案） | ✓ |
| root 卫生 | 0700/sundy(501)/非 symlink（find 零）；文件 0600 | ✓ |
| `node --check` | sdk5/probe/preflight/repro/abort-fixture/joinfb-r18-oracle/purefake-r18 = 7/7 过（oracle/purefake 仅语法，未运行） | ✓ |
| repro 冻结 | 与 `/tmp/perimeter-r17-fix-BrHDIJ/repro.mjs` cmp 逐字节相等、SHA `47c6b1de…`==R13 v2.1 先验，**零跑** | ✓ |
| 未变件 cmp | preflight.mjs / abort-fixture.mjs / HANG-DISCLOSURE.md 与 r5 冻结 root 逐字节相等 | ✓ |
| 冻结纪律 | r5 root、coor join root、本审 R17 root 全部只读未触；coor/Grok oracle 蓝本仅复制适配，原件零执行 | ✓ |
| repo 足迹 | `docs/implementation/s2-sdk-session-pin.md` **§18.4 追加（:625 起）+ `docs/implementation-progress.json`**；其余为既有 dirty/staged；git log 未动 | **偏差见 R-Q18-1** |
| 历史边界 | 原 SDK5 未跑/current5fail/544×2/旧红/历史容器与七 mockPod unknown 保留；artifact 8/8≠behavior 5/5；G1 全 3s/G3/S2 企业 partial 不升级 | ✓ |

## 2. R-Q17 逐项复审（全部静态闭合；file:line 为本审实测）

### R-Q17-1 join 活 close fallback —— 闭合

- **timer 预挂先于 caseFn 首调用**：`rearmDeadline()` 在 `:373`，caseFn 经 `await Promise.resolve().then(...)`（`:375`）延迟至预挂后微任务（R15 补门保持）。
- **timer 覆盖至全部 pending 真 join**：case 段结算后 `onDeadline` 重指为"重试 close 全部连接+未 joined 即重武装"（`:386-391`），close/join 段共用同一 15s 绝对截止（`caseStopAt=:367`；重武装 delay=max(1, caseStopAt−now)`）：到点先重试 close（`:388`），producer 由 vendor close 真实 teardown 结算；`joined=true` 后才 `clearTimeout`（`:394-396`）。`withDeadline` 已删除（切片实测无）。
- **初 close 抛错→deadline 到点重试**：`closeAllConnections` 逐连接 try（`:359-364`），单连接抛错仅记 `closeFailed` 不中断其余；到点重试使 closeAttempts≥2，producer 结算后 `allSettled` 返回——R17 joinfb 场景（60ms 自然结束冒充终止）被双向封死：`closeFailed→case_close_failed`（`:403`）、`timedOut` 仅由到点触发或 join 后单调复核置位（`:399`）、wall 含 join（`:400`）。
- **精确判定**：结果判定在 join 后统一（`:401-404`），精确 `case_deadline` 不放宽；deadline 未触发的自然结算≠主动终止。
- **非收敛路径如实**：producer 对 close 永不结算 ⇒ `allSettled` 悬挂至外层 runner kill=如实红；代码注释/交付报告/plan §1/summary 四处口径一致，均声明"kill 不是终止证明、不结算任何 pass"。
- 验证件静态核：`joinfb-r18-oracle.test.mjs` 四断言（①协调者安全断言原样 ok:false/close>0/naturalDone=false；②closeAttempts≥2/naturalDone=false/真实 join/wall<55ms/精确 case_deadline；③慢 join wall≥25ms 非 race；④自然 8ms 结算→case_failed 而非 case_deadline）与 r6 `runCase` 实际语义逐一相符；vm 切片锚点与 SHA 自校验在案。**准备未运行，无红绿结果。**

### R-Q17-2 整轮预算收敛（执行时 remaining 注入）—— 闭合

- **预算公式**：`subBudget=min(cap, 整轮剩余[, case 剩余如 finite])`（sdk5 `:180-183`）；`bounded`（`:202`）、`budgetedPsRunner`（`:226`）、`readReady`（`:302`）剩余≤0 一律拒绝（`budget_exhausted_refused` 固定类别台账+unknown 形态结果，两脚本各 7 处）；两文件 **零 `Math.max(1,…)` 续命**（仅 `:371`/probe`:229` 两处 setTimeout timer 粒度，非 spawn）。
- **case ps 实受双限**：`budgetedPsRunner=min(3000, case 剩余[finite 时], 整轮剩余)`（`:222-232`）——R16 报告/代码不符处以修代码关闭（r5 报告不回改，由交付报告 §5 记录）。
- **cleanup 不误用旧锚**：`caseStopAt` 在 join 完成后复位 ∞（`:397`）；cleanup 段各 finalizer 的 `deadlineMs: subBudget()`（fixtureFinalize `:336`、B4 迟发现 `:497`、B5 `:616/:631`）在执行时点求值。
- **getter 动态限时**：`trackDaemon` 注入 `get deadlineMs(){return subBudget(5000)}`（`:285`）；本审只读复核 helper：`daemon-resource.ts:53` `this.#deps=deps` 按引用存储，dispose/kill 在调用时读 `this.#deps.deadlineMs`（无 spread、无构造期快照）——msg_dcf2a1c093b4 事实成立，多 cleanup 逐项=min(cap, 剩余-at-调用)，起点耗尽即拒，不能聚合越窗。
- **整轮总界**：sdk5 **无整轮主动 abort timer**（88s 仅预算窗）——收敛路径的结构性保证=每操作 min(cap, remaining-at-call)+case 持活 15s timer+耗尽拒绝；非收敛 join 悬挂至 runner kill=如实红（披露一致）。逐路径台账在 plan §1（前置 ≤5s+5×15s=80s；cleanup 逐项≤剩余-at-调用⇒≤88s+ε≤89s<90s）；probe 同构 ≤29s+ε<30s（BODY 18s 主动 abort+close）。**协调者"是否真有整轮主动截止"正面回答：sdk5 靠注入+case 活 timer+耗尽拒绝，probe 有 18s 主动截止；交付未冒称 sdk5 内部 90s 已保证**——报告/plan/summary 三处均将 runner kill 明示为兜底且非终止/清理证明。
- **killSignal 实核**：两文件 grep 零 `killSignal` ⇒ spawnSync 超时按 Node 默认 **SIGTERM**；ε=单操作 SIGTERM 时延+25ms 轮询粒度，静态成立；spawnSync 无 SIGKILL 升级，SIGTERM 免疫子进程会挂至 runner 兜底——被观察对象仅 ps/docker/pgrep（现实服从），静态可接受且兜底已披露。
- **耗尽零新资源**：probe `ensureOpen` 绝对守卫+`bounded` 拒绝（`:186-198`）；sdk5 资源路径先经 `ownPgid()`（bounded ps）——耗尽时先拒绝、不触 daemon spawn；`readReady` 耗尽即 `b5_ready_timeout` 零轮询。

### R-Q17-3 probe 元数据+生命周期次序 —— 闭合

- **①预挂次序如实**：`deadlineTimer=armBodyDeadline(deadlineBox)` 在 `:236`，`OWN_PGID_PROBE` IIFE 在 `:239`——预挂**实际先于** OWN_PGID_PROBE 与全部 preflight；触发时刻恒 t0+18s（delay=距 t0+18s 剩余，`:229`）；probe 注释（`:229-231`）、plan §1、交付报告 §2 三处与代码一致。
- **②finally 次序**：close transport（`:453`）→ driver 正向 scoped 同代 join（观察得 pid 时 `waitOwnerGone`，`:463`；观察预算≤0 显式拒绝等待记 unknown `:459-462`；观察失败/不可观测记 unknown failure `:466-472`）→ 容器 rm（`closeOnce`，`:473`）→ inspect-gone 精确分类（`:474-481`）。**任何路径 rm 都不先于 join 尝试/unknown 记录**；snapshot 失败路径 finally 无条件执行、同构收敛。
- **unknown 从严**：`waitOwnerGone` 对 unknown 立即抛（helper `ps-observer.ts:112-116` 本审只读复核）；unknown 不当 gone、不杀未知；`closeOnce` rm 目标=归属重验（full 64hex CID+`/name`+Running+nonce label 全过，`:349-383`），rm -f 显式 fullCID；闩仅 rm 成功/正向 gone 置位、失败可重试（`:385-397`）。driver-unknown+rm 成功的终态=probe 红（failures→exit 4），无假 clean。
- **协调者"成功顺序不够"疑点正面回答**：因果混淆仅存在于"rm 先于 join 尝试"——r6 全路径已消除；driver 不可观测（无 pid 可 join）时记 unknown failure 后仍归属 rm，是既定 R16 语义（owned 容器必须回收+归属重验+失败如实红）。若协调者欲更强门（driver unknown 时禁 rm）属新门且以放弃 owned 容器回收为代价，交协调者/用户裁量，本审不单方设禁。

## 3. 闭环保持项核查（未回退）

fullCID/nonce/name/label/代际逐项重验（probe `closeOnce :349-397`）；闩失败可重试；`runAllCleanups` 全 finalizer 执行+聚合不吞（helper 本审复核：每项 try/await、计数保真）；ledger/callback 错不跳过其余 finalizer（`closeOnce` ledger 写失败 try `:352`、B4/B5 closure 经聚合）；B4 新代 cleanup 先于重连触发预登记（`:489-501`）且禁止 snapshot 主动重连造新 daemon；B5 TTL 30000/5000+exec 启动前单调锚 `longExecStartedAt :580`+正证后零 await abort（`:596-605`）+全部 exec promise 经 `api.join` 真 settled；knownlost 内存布尔（`:247`）；隐私 msg_1db150bc1c3f 最终口径不变（child-N-out/err 与 raw stack 通道零持久化实测；R11/R13/R15 已准私有 owned raw 例外保留、无新增 DLP/raw 禁令）。

## 4. 新 required（R-Q18-1；非代码缺陷）

- **R-Q18-1（repo 足迹超授权）**：`docs/implementation/s2-sdk-session-pin.md` 追加 **§18.4**（`:625` 起，署名 task_4a83dddf7b7a），超出本任务"仅 §18.3 追加/progress 足迹"的授权。Pi 已在交付报告 §6 如实披露且内容与交付一致（不构成虚假），但**未获授权即写 repo 即为足迹越权**，与 R15 metadata 项同尺入 required。修法（最小，二选一）：下轮**删除 §18.4** 恢复 §18.3 为末节（其内容已由交付报告/plan/audit-notes 完整承载，无信息丢失）；或协调者/用户**明示追认 §18.4**。处置前 §18.4 不作为已授权证据引用；本审不回改交付 root、旧报告与 repo。
- §0 过程披露项非代码 required，随本报告入档。

## 5. 边界声明（blocked 面如实）

行为面全部未测：两验证件未运行（**无任何红绿运行结果**）、repro 45s/sdk5 90s/docker 30s 真实执行未派——全部 blocked 于 54m57s 挂起 node 终止状态 unknown（无 pid/PGID 退出记录、不全局扫描/不杀未知/不叠 fake）+ 协调者执行授权，静态闭合不预支行为绿。历史 unknown 保留：原 SDK 5 未跑/未导入、current5fail、544×2、全部旧红、历史容器与七 mockPod unknown；G1 全 3s/G3/S2 企业 partial 不升级；artifact 8/8≠behavior 5/5。R11/R13/R15 审定与隐私最终口径不重开不缩窄。本审执行面=只读 read/hash/cmp/`node --check`/静态 oracle 一致性核，零 purefake/零 vm/零资源/零网络；产品/runtime/SDK/vendor/helpers/tests/node_modules/依赖锁/builder/全部旧 root 只读零写入；dirty/staged 保留，无 commit/push/reset/stash/clean，不读 history/secrets/未知 stash。R-Q18-1 处置后本审对受影响面同口径复核，通过才窄批准执行前准备；真实执行另派 Pi 且各自独立红（先 r5 冻结 root 红对照、独立日志不覆盖、红绿不混写）。

## 6. 证据保留

审者 root（0700/UID501，不删）：`/tmp/grok-s2-r18-review-i5DgtjXO/{delivery-sha.txt, node-check.txt, r5-cmp.txt, manifest-check.txt}`（0600）。Pi r6 root 自 worker_done 起冻结；r5 root、coor join root、R17 审 root 及全部旧 root/coor 原件只读零执行。
