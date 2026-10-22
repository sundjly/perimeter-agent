# grok-s2-sdk-session-pin-round-19.md — Pi r7 修复包复核 + r8 wholeTimer 补修定向复审（task_90aa1680804e / ctx_ea8d6294d834）

- 日期：2026-10-18；审者：Grok（唯一 reviewer，原终端复用）。被审对象：Pi task_b4211d90350c / ctx_c22fea6fc38e 补修包（r8），root `/tmp/perimeter-r20-fix-5y1VL3/`（本审独立复验 0700/UID501/非 symlink；manifest 13/13 独立实算逐行相符；r8 实改仅 `sdk5-behaviors.mjs`=`75267a65…`——probe `5f9e90b9…`/abort-fixture/preflight/repro 与 r7/r6 逐字节 cmp 相等、caseB1..B5 函数体 r6→r8 哈希逐一相同；repro `47c6b1de…` cmp 相等零跑）。前包 r7 `/tmp/perimeter-r19-fix-RU4wdu`、旧 r6 `/tmp/perimeter-r18-fix-Ya5UaU` 及全部旧 root/coor 原件只读零执行。spec 依据：原 task_4a83dddf7b7a 硬门（所有路径 close→正向 scoped 同代 driver join→fullCID rm）+ 协调者 R18 处置（不接受 R18「三代码门闭合/driverunknown 更强门属新门」解读）+ r7 交付后复检（wholeTimer 无清除）+ 本轮协调者 r8 复读疑点（:775-end 单次采样/wholeWallMs 命名）+ 用户取消边界。
- 审性质：**零运行静态审**。执行面=只读 hash/cmp/diff、`node --check` 8 distinct mjs（8/8 过）、源码逐行静审（r8 main 尾部/runCase/vendor teardown 独立复核）、helpers 只读复核。**未运行**：purefake（含 vm）/oracle/repro/preflight/SDK test/资源 main/daemon/container/build/install/network——三验证件（wholetimer-r8/joinfb-r19/purefake-r19）为**准备未运行**态；root 内**无任何 provenance JSON**（运行时才自写）→ 作者"静态预演"为纯文本核，无执行假件偏差可列。
- **verdict：request_changes——r7 五项实质修复（统一持活 fallback/driverJoinProven 正向门/floor+SIGKILL 预算硬化/整轮主动截止/vendor 条件性风险如实）与 r8 timer 生命周期主体经源码独立复核成立；但协调者 r8 复读疑点经本审逐行证实为真实缺口：①判定单次采样在 writeFileSync 之前，同步汇总段跨截止仍可假绿（R-Q19-1，代码 required）；②wholeWallMs 为判定时点采样冒称实际 Node wall（R-Q19-2，命名/观测 required）；③:152-160 滞留已否定的 ε<1s/SIGTERM 旧弱语义注释（R-Q19-3，元数据 required）。R18 分歧按协调者处置纠正记录（§0）。行为面与 readonly SDK 风险保持 blocked。**

## 0. 过程公平记录（先于结论；不回改旧报告/旧 raw）

1. **R18 审查分歧纠正**：R18（coverage35，冻结）曾判"R-Q17-1/2/3 三代码门静态闭合"并称"driver unknown 更强门属新门"。协调者不接受：原 task_4a83dddf7b7a 即要求**所有路径 close→正向 scoped 同代 join→fullCID rm**，非"join 尝试或 unknown 记录后 rm"；且 r6 runCase 首个 onDeadline（case 段）只 abort+close 一次、不重武装，仅 caseFn 结算进入 join 段才更换回调——caseFn await 忽略 CANCEL producer+首 close 抛错时单 close 悬挂。本审复核 r6 源码证实两点指控均属实：r6 R-Q17-1 修复不完整、R18 对 driver-unknown→rm 的接受偏离原硬门。r7 已按实际源码问题修复（本报告 §2 复核）；R18 漏回应实际 followup 的偏差如实保留，不回改旧报告。
2. **r7 计数与载荷纠错保留**：r7 报告"node --check 9 文件"实为 7 distinct mjs（本轮 r8 报告如实纠错为 distinct 7 / r8 8）；r7 及前轮 worker_done `--files-modified` 重复传 flag 被末值覆盖——本轮起单次 CSV 传全。旧报告冻结不回改。
3. **历史偏差全部保留**：54m57s 挂起 node 终止状态 unknown（本轮双方零新证、零扫描/杀未知；新独占 PGID 不逆证旧进程）；原 SDK5 未跑/current5fail/544×2/全部旧红/CID 与七 mockPod unknown；coor ESC 依据不足自纠；隐私缩窄后恢复；作者与 R17 reviewer 后叠 fake 偏差；R17 审者初命令失败补记。先验/准备态≠behavior 5/5、G1 全 3s、G3、S2 企业通过。
4. **§18.4 处置**：原写入越界事实保留；本轮授权=§18.3 既有节尾追加+progress（实测 :627 时点记录插入 §18.4 标题前、原行序保留、§18.4 原文未触）——保留授权不追认旧写入、不以删史换绿，单列过程处置非代码门。

## 1. 交付与先验复验（实测）

| 项 | 实测 | 结论 |
|---|---|---|
| manifest 13/13 | 本审独立 shasum 全量重算与 `sha256-deliverables.txt` 逐行相符（root `manifest-check.txt` 在案）；两旧报告冻结副本 cmp 相等 | ✓ |
| root 卫生 | 0700/sundy(501)/非 symlink；文件 0600 | ✓ |
| `node --check` | 8 distinct mjs（sdk5/probe/preflight/repro/abort-fixture/joinfb-r19/purefake-r19/wholetimer-r8）= 8/8 过，均语法检查零运行 | ✓ |
| r8 改动面 | 与 r7 冻结 root cmp：仅 `sdk5-behaviors.mjs` 变更；probe 本轮零改动（PROBE-EQ-R7）；caseB1..B5 体 r6→r8 哈希相同（B4 预登记 :553、B5 锚 :640/:656/:665/:679 保持） | ✓ |
| 准备态 | 三验证件**未运行**、root 零 provenance JSON、零红绿结果 | ✓ |
| repo 足迹 | 仅 §18.3 节尾时点记录（:627）+ progress；既有 dirty/staged 保留；无 commit/push/reset/stash/clean/history/secrets | ✓ |

## 2. r7 实质修复独立复核（源码，非报告结论）

| 项 | 源码实证 | 结论 |
|---|---|---|
| 统一持活 fallback（修 r6 缺陷） | 同一 `onDeadline`（timedOut+ctl.abort 幂等+重试 close 全部连接+`!joined` 即重武装）于 caseFn 首调用前预挂（sdk5:440）持续到真 join 才清（:454-455）；已到点重试统一 `REARM_TICK_MS=25ms`（:428-432，非 1ms busy）——case 段到点也重试，r6"首 onDeadline 不重武装"缺陷消除 | **闭合** |
| driverJoinProven 正向门（原 task 硬门恢复） | 仅 `waitOwnerGone` 正向返回（gone/gone-pid-reused）置位（probe:496）；closeOnce 同一入口 rm 前置门（:413-417）：无证→拒 rm+`residual-container-not-removed`+ledger `rm-refused-driver-join-unproven`+闩不置位可重试（finally/兜底 runAllCleanups 全部 rm 路径同门）；knownCID 残留如实四通道（failure/ledger/inspect-gone live 判失败/summary residualNote :530）；不按名 rm/不扫全局/不杀未知/不调 backend.cleanup | **闭合**（R18 接受的"unknown 后仍 rm"语义已被替换） |
| 预算秒界硬化 | 逐调用 `Math.floor`（sdk5:237/probe:134,202,225）；floor≤0 拒绝 spawn（绝无 timeout:0=不限时/1ms 续命）；显式 timeoutMs 同被绝对剩余钳制（sdk5:255 subBudget(cap)）；owned 受控子进程 `killSignal:"SIGKILL"`（sdk5:262,283；probe:211,231——非杀未知 driver） | **闭合** |
| 整轮主动截止（SDK） | 模块级先于一切前置预挂 88s timer（:179-182，模块顶层先于 main() 调用）；触发=wholeDeadlineFired+abort 当前 case+close 其连接（activeCase 注册 :422/清除 :455）；循环耗尽/已触发停开新 case（:764-768）；越窗恒红门 :802-809 | **闭合**（判定采样缺口见 R-Q19-1） |
| vendor 条件性风险（readonly） | 本审只读复核 `vendor/pi-env/original/connection.js`：`close()` 先置 `#closed=true`（:128-129）再 `if (#session) teardown`；`#teardown` 先 `live=false`+清 `#session/#ready`（:236-241），再 `stdin.end()/child.kill()`（:242-243），**最后** pending reject（:244-247）——end/kill 同步抛⇒pending 永不 reject、重试 close 因 `#session=undefined` no-op、exit/error 回调因 `live=false` 早退⇒producer 永久悬挂。条件性静态风险成立；owned 不可修、需另 SDK 授权（最小方向=reject 前置/end-kill 包 try/finally/close 幂等续完），**本轮我或 Pi 均不改 SDK/vendor**；不撤旧 normalG1、不以状态变化前首 close 抛错假件冒充 post-state fault 覆盖 | **如实 blocked** |

## 3. r8 wholeTimer 补修复核 + 协调者疑点独核

**已成立部分**：①清除恰 2 处——外层 finally `clearTimeout(wholeTimer)`（:829）位于 cases 循环+内层 finally（runAllCleanups :780）+summary 写盘（:801）+三失败分支（:802-820）之后，成功/正常失败路径都释放；`main().catch` 首句清除（:832）——三条到达 catch 的路径（前置 throw/try 内 throw 经两级 finally 解旋/正常返回不进 catch）均在真 settled 或工作已终止后清（前置段无已登记 case/pending/资源；try 内 throw 先经内层 cleanup finally）；无 unref、runCase 区无清除。②最终判定含单调剩余（:788）。③循环门/恒红门在案。

**协调者 r8 复读疑点——本审逐行证实为真实缺口：**

- **R-Q19-1（判定单次采样，代码 required）**：`wholeRemainingAtVerdictMs`/`wholeWallMs`/`wholeStopExceeded` 在 :786-788 **一次采样**，随后 summary 构造（:790-800）+`writeFileSync(summary)`（:801）+success 行（:823）为同步段——期间 timer callback 无法插入，但 **88s 截止可在同步段内流逝**：采样时 remaining>0（如 5ms），写盘/汇总耗时越窗后，:802 的 `if (wholeStopExceeded)` 仍查旧 const=false⇒打印 5/5 pass→finally 清 timer（callback 永不再置位）→exit 0，实际退出 wall>88s 且无任何再核。写盘时延原则上无界（慢盘），窗口真实。**公式正确≠采样点正确**：这是"采样→写→判定"两点因果，单点真值求值覆盖不了。修法（最小）：①全部证据写盘后、判定分支前重采样 `wholeRemainingAtDecisionMs=floor(wholeRemainingMs())`，判定用 `wholeDeadlineFired || wholeRemainingAtDecisionMs <= 0`；②外层 finally 在 `clearTimeout` 后再采样一次，越窗且已走 pass 路径⇒补写 `whole_stop_exceeded` failure JSON+`process.exitCode=4`（红不可翻绿；exit code+failure JSON 为准，早前 stdout 过时无害）。
- **R-Q19-2（wholeWallMs 命名，观测 required）**：:787 注释与 r8 头注/§18.3 称"实际 Node 单调 wall"，实为**判定/汇总构造时点采样**——不含 summary 写盘与退出段，非实际退出 wall。修法（最小）：改名 `wholeWallMsAtVerdict` 并如实注释；实际退出 wall 在 finally `clearTimeout` 后采样（`wholeExitWallMs`）同步落 evidence（如 `exit-wall.json` 或 failure 附字段），红路 JSON 恒含。
- **R-Q19-3（滞留旧弱语义注释，元数据 required）**：:152-160 活注释仍写"越窗上界=单操作 **SIGTERM** 终止时延+轮询粒度（25ms）≈**ε<1s** ⇒ 总界 ≤88s+ε≤89s < runner 90s"——与 r7 处置（SIGKILL、"不写 ε<1s 已证"、恒红兜底）直接矛盾（:55 r6 版本注内同句为历史版本链保留不算）。修法（最小）：该块改写为 R19 语义（结构性保证=注入+整轮主动 timer+恒红门+floor 拒绝+runner 兜底，无 ε 已证声明、SIGKILL）。
- **wholetimer oracle 定性**：source/model 切片级——①-④文本序断言、⑤对源码实取判定表达式做 `new Function` 真值求值、⑥文本在场断言；**未执行实际尾部两点因果**（采样点 vs 判定点分离正是其模型盲区，故⑤无法发现 R-Q19-1）。修后须补断言：判定表达式取自重采样行、finally 内退出再核在案；红绿分离先对 r7 冻结 root 跑红（①清除数=1 红）再本 root 绿。本轮未运行、作者"静态预演"为文本核（无执行产物），不升级偏差。

## 4. 新 required（全部 Pi 侧最小可修）

- **R-Q19-1**：判定重采样（写盘后判定前）+ finally 退出前再核（越窗补红），如上。
- **R-Q19-2**：`wholeWallMs`→`wholeWallMsAtVerdict` 如实命名+finally 实际退出 wall 采样落证。
- **R-Q19-3**：:152-160 旧 ε/SIGTERM 注释块改写为 R19 语义。
- 语义保持复核未动：B4 先 cleanup 后 reconnect（:553）、B5 TTL30000/5000+exec 前单调锚（:640）+alive 正证后零 await abort（:656-665）+pending 真 join、knownlost 内存布尔（:301）、fullCID/nonce/name/label/代际重验、闩成功/正 gone 才置位失败可重试、ledger/callback 错不跳过 finalizer、deps getter 执行时 remaining、隐私 msg_1db150bc1c3f 口径——全部保持。

## 5. blocked / 未运行 / 不可证（如实，不求伪绿）

- **行为面全未证**：三验证件未运行（无红绿结果）；repro 45s→sdk5 90s→docker 30s 真实执行未派——blocked 于 54m57s node 生命周期 unknown（无新增正向退出记录）+ 协调者执行授权。先验/准备态≠behavior 5/5、G1 全 3s、G3、S2 企业。
- **不可证（静态）**：SIGKILL+waitpid 内核终止时延；90/30 真实运行总界；vendor 条件分支的实际触发概率——分别以恒红门/兜底/如实 red 覆盖，不以表达式在场冒闭合。
- **需另授权**：vendor `#teardown` 最小变更方向（§2 末行）——SDK/vendor 只读，本轮双方不动。
- 历史边界保留见 §0-3；R11/R13/R15 私有 owned raw 例外/0700/ledger0600/固定 public/knownlost 内存布尔不重开 DLP。本审执行面=read/hash/cmp/diff/`node --check`/源码静审，零 fake/零 vm/零资源/零网络；产品/helpers/依赖/锁/builder/旧 roots/reports/raw 只读零写入；无 commit/push/reset/stash/clean/history/secrets/未知 stash。

## 6. 证据保留

审者 root（0700/UID501，不删）：`/tmp/grok-s2-r19-review-XdURWFKl/{delivery-sha.txt, node-check.txt, manifest-check.txt}`（0600）。r8 root 自 worker_done 起冻结；r7/r6 及全部旧 root、coor 原件只读零执行。
