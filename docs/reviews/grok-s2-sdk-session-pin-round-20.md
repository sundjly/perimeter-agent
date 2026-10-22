# grok-s2-sdk-session-pin-round-20.md — Pi r9 修复包定向复审（R-Q19-1/2/3 差异最小复审；task_0762bd8f5c83 / ctx_570da1be6223）

- 日期：2026-10-18；审者：Grok（唯一 reviewer，原终端/同代模型复用）。被审对象：Pi task_0762bd8f5c83 / ctx_570da1be6223 交付 r9，root `/tmp/perimeter-r21-fix-U92OuS/`（协调者已独立复验 0700/UID501/非 symlink、15 相对安全 manifest 全 UID501/0600/非 symlink/哈希 15/15、repro `47c6b1de…` 逐字节相等零跑；本审复核文件位 0600 在案）。前包 r8 `/tmp/perimeter-r20-fix-5y1VL3` 冻结只读。spec 依据：本审 R19（docs/reviews/grok-s2-sdk-session-pin-round-19.md）三项 required R-Q19-1/2/3 + 协调者本轮追加两点（exit-wall 写盘须在最终再核之前；`wholeWallMsAtFinalize` 命名如实=main finally 采样非实际 OS/Node 退出 wall，真实退出 wall 仅外层 runner 将来授权观测——本审 R19 修法原文「finally 实际退出 wall」据此被更准确命名取代，非假命名）。
- 审性质：**零运行静态定向复审**——仅对 R-Q19-1/2/3 差异做最小复审；执行面=只读 hash/cmp/diff（r8→r9 sdk5 全 diff 164 行+6 文件 cmp）、`node --check` 9 distinct mjs（本审独立 9/9 过，零运行）、源码逐行静审、四 oracle 文本锚点核验。**未运行**：purefake（含 vm/newFunction）/四 oracle/repro/preflight/SDK test/资源 main/daemon/container/build/install/network——与作者零运行自述一致；root 内无 provenance JSON（运行时才自写）→ 缺运行产物只能说与零运行自述一致，不单凭无 provenance 断言历史绝无执行。
- **verdict：approve（窄：仅限本静态准备包）——R-Q19-1/2/3 经源码独立复核全部闭合（含协调者两点追加均成立）；r7/r8 全部实质修复与语义保持经最小 cmp 未回退；但**行为面零证据维持**：四验证件准备未运行、真实执行/红绿分离未派、SDK5/current5fail/544×2/G1 全 3s/G3/S2 企业 partial/54m57s node unknown 全部原样保留。本 approve 不授权任何执行、不构成 release、不构成企业接受；红绿分离与真实运行仍待协调者另行授权（先 r8 冻结 root 跑红对照，再本 root 绿，独立日志不覆盖）。**

## 0. 过程公平记录（不回改旧报告/旧 raw）

1. R18 假闭/漏 followup 纠正、协调者 ESC/隐私纠错、r7 计数（9→7 distinct）与 filesModified 重复 flag 覆盖纠正——按 R19 §0 原样保留，本轮无新增。
2. 本轮 check followup：开工、落盘前、worker_done 前各一次，均零消息（count=0），无重定向。
3. R19 修法文字一处自纠（如实记录）：R19 §3 R-Q19-2 修法称 finally 采样为「实际退出 wall」——经协调者指出，真实 Node/runner 退出 wall 只有外层 runner 将来授权执行才能观测，finally 采样只是 main finally 阶段时点；r9 已按更准确语义命名实现（见 §3），本审认可该取代，不强迫假命名、不撤 R19 报告原文（冻结）。

## 1. 交付与先验复验（最小 cmp，不重读全历史大 JSON）

| 项 | 实测 | 结论 |
|---|---|---|
| r8→r9 改动面 | 本审 diff sdk5 全文：仅 4 个 hunk——头注版本链追加 r9 节（:90-105）、活注释块重写（:171-178）、判定/finally 段重写（:800-866）、main catch 段重写（:875-886）；caseB1..B5 函数体零触碰 | ✓ 与交付自述一致（仅 `sdk5-behaviors.mjs`） |
| 未改文件 cmp | probe/preflight/repro/abort-fixture 与 r8 冻结 root `cmp -s` 全等（probe 保持 PROBE-EQ-R7） | ✓ |
| oracle 适配面 | joinfb-r19：r8→r9 diff 仅 SHA pin 一行（`75267a65…`→`e06597e2…`），安全断言原样——与「SHA 适配；安全断言原样」自述一致；purefake-r19：SHA pin+静态结构门改 r9 判定点形式+新增 finalize 门/exit-wall 在场断言，docker 断言原样（dockerSha 同值）——与「SHA+R21 判定点断言适配」自述一致；wholetimer r8→r9 更名+SHA+②finally 正则含 `wholeRemainingAtFinalizeMs`+⑤改双判定点表达式提取+⑥文本断言改 AtVerdict/AtFinalize 命名 | ✓ |
| `node --check` | 本审独立 9 distinct mjs（sdk5/probe/preflight/repro/abort-fixture/tailgate-r9/wholetimer-r9/joinfb-r19/purefake-r19）= 9/9 过，纯语法零运行；与作者 distinct 9/calls 11 自述无矛盾（calls 计数属作者执行史，本审只复核 distinct 集合与通过） | ✓ |
| 准备态 | 四验证件未运行、root 零 provenance JSON、零红绿结果 | ✓（与自述一致） |
| repo 足迹 | `docs/implementation/s2-sdk-session-pin.md` §18.3 节尾 R21 时点记录（R20 记录之后、§18.4 标题之前，原行序保留）+ `docs/implementation-progress.json` updatedAt 2026-10-18T16:45Z；R19/R20 两条旧时点记录原样在案未洗；§18.4 原文原状未触（按本轮授权原状保留为历史，不追认旧写入）；无 commit/push/reset/stash/clean/history/secrets | ✓ |

## 2. R-Q19-1 闭合（判定重采样+退出再核，源码独立复核）

**两点因果成立**（行号均为 r9 sdk5 实测）：

- **判定点**：初采样 `wholeRemainingAtVerdictMs`（:802）只进 summary budgets 作描述值（:810），不再参与判定；`writeFileSync(summary-sdk5.json)`（:817）之后、判定分支之前重采样 `wholeRemainingAtDecisionMs = Math.floor(wholeRemainingMs())`（:822，fresh，非旧 const），判定 `wholeDeadlineFired || wholeRemainingAtDecisionMs <= 0`（:823）——「采样→写盘→判定」同步段跨截止即被 decision 置红。旧 `wholeStopExceeded` const 全文零残留（仅 :85-86 头注版本链历史描述，非活代码）。
- **退出点**：外层 finally 次序严格为 `clearTimeout(wholeTimer)`（:854）→ `wholeWallMsAtFinalize` 采样（:856）→ **`exit-wall-sdk5.json` 写盘（:857，在最终再核之前——协调者追加点①成立）** → fresh `wholeRemainingAtFinalizeMs = Math.floor(wholeRemainingMs())`（:861，不用任何旧 const）→ 越窗门（:862）只能翻红：仅置 `process.exitCode=4`+写 failure（stage=finalize），全文无任何路径重置 exitCode/清红——红不可翻绿成立；绿路径走完 finally 后 exitCode 保持 0，若此间越窗则被翻红（green 后翻红有门，red 后翻绿无门）。
- **先非零再写盘**：五条红分支全部先设非零 exitCode 再尝试错误记录且写盘包 try/catch——decision :825、caseFailure :833、cleanupAggregate :841、finalize :863、main catch :883（`process.exitCode = code` 先于 writeFailureSummary）——失败写盘/写盘抛错不能意外绿。
- **stdout 非最终 accept**：5/5 行（:847）仅在 decision 绿后打印，其上注释+deadlineSemantics 字符串（:811）明示 stdout 为中间结果、最终以 Node exitCode+failure-evidence 为准；finalize 可在打印后翻红（oracle ②建模此路径）。
- **未 settled 不提早清**：`wholeTimer` 的 clearTimeout 全文恰 2 处——finally :854 与 main catch :875；:447/:473 两处清的是 runCase 内 per-case fallback `timer`（真 join 后 :473 才清），与 wholeTimer 无关。finally 位置在 cases 循环+内层 cleanup finally（:795-798）+summary+三失败分支之后，未结算到不了；main catch 只在 main() reject 后到达（前置 throw 无已登记工作；try 内 throw 先解旋两级 finally）。无 unref、无 race 假 join、无 process.exit。协调者追加点③成立。

## 3. R-Q19-2 闭合（如实命名+退出 wall 口径）

- `wholeWallMs` 全文零活代码残留；`wholeWallMsAtVerdict`（:802-803）注释明示「判定/汇总构造时点采样……非实际 Node/runner 退出 wall」，summary budgets（:810）、顶层字段（:820）、成功行（:847）全部同名牌。
- `wholeWallMsAtFinalize`（:856）行内注释明示「main finally 阶段采样；非 OS/Node exit 观测——真正 Node/runner exit wall 仅将来授权执行由外层 runner 观测（当前未证）」；exit-wall JSON 只含 at/wall/fired/note（:857），无越界字段；finalize failure 附 `wholeWallMsAtFinalize`。协调者追加点②成立：实际退出 wall 未证，以恒红门+runner 兜底为结构保证，不写任何「已测退出 wall」。

## 4. R-Q19-3 闭合（元数据）

- 活注释块（:171-178）已删除「SIGTERM/ε<1s ⇒ 89<90」旧弱声明，改 R19 语义：floor 注入+floor≤0 拒 spawn+整轮主动单调 timer+判定/退出两阶段恒红再核+owned 受控子进程 killSignal=SIGKILL+外层 runner 90s 兜底组合保证；「内核 SIGKILL+waitpid 终止时延【未静态证明】——不写任何 ε 已证声明」在案；settlement 字符串（:812）同步。
- 旧弱句仅存于头注版本链历史（:71 r6 时代注、:85-86 r8 描述、:103 r9 更正说明）与否定句——历史版本链按本轮授权只保留不洗旧；r6 头注原文未回写。活语义无残留。

## 5. 四 oracle 文本核验（全部准备未运行；只核锚点与断言安全性）

- **tailgate-r9（新增，两点因果主验证件）**：切片锚点实测存在——tailStart `\tconst cases = [caseB1,…]`（sdk5:770）、tailEnd `\n}\n\nmain().catch(`（:869-872），切片含两级 finally+退出再核、不含 main catch；七个 marker 逐一在真实源码在案（:817/:822/:854/:857/:861/:826/:864）。断言安全性：全部在 vm 沙箱假上下文对**真实源码尾部切片**执行（声明的 source/model，非布尔求值/非纯文本搜索）；①初采正+写盘推假钟越窗→decision 红断言恰好捕获 r8 旧 const 缺陷（若判定仍查旧 const 则走绿路径打 pass 行，被「无 log 行」断言打红）；②decision 绿→失败写盘推钟越窗→finalize 翻红+终值 exitCode=4 断言「红不能变绿」；③绿/红两路径 cleared 恰一次；④runCase 永悬→尾部不结算+零 clear，50ms Promise.race 明示为测试架自保护非生产 race；⑤writes 序 summary→exit-wall+decision 红先置 exitCode。SHA pin `e06597e2…` 与交付一致，错配即红停。**本轮未执行**——以上为文本级核验，模型绿≠行为绿。
- **oracle 文本两处精度备注（非缺陷、不构成新门；授权运行前最小修正可选）**：①tailgate 头注③称「main().catch 释放由源文本断言补充」，但该文件无对 catch 块 clearTimeout 的全文断言（切片不含 catch；catch 清除的文本覆盖实际在 wholetimer-r9 ③）——跨文件引用措辞松；②⑤头注称 writes 序「summary→exit-wall→(red)failure」，沙箱把 writeFailureSummary 打桩进 failures 数组、failure 写序经 sb.writes 不可观测，实际断言的是 exit-wall 在 summary 后+decision 先置 exitCode；「exit-wall 写盘在最终再核之前」这一真值本审已直接在源码 :854-862 独立证实，②亦证明 finalize 再核在失败写盘推钟之后仍触发。两点均不影响 R-Q19 闭合与断言安全性，仅记录为运行前文本精度项。
- **wholetimer-r9**：⑤改为对源码实取两个判定点表达式（regex 要求恰 2 处且互异）做 new Function 真值表（表达式级 sanity，已被 tailgate 行为覆盖超越）；②finally 正则要求清除后含 `wholeRemainingAtFinalizeMs`；⑥文本断言全换 AtVerdict/AtFinalize 名。仍属 vm/newFunction 类——本轮禁跑，准备态合规。
- **joinfb-r19 / purefake-r19**：如 §1 所述适配面与自述一致；安全断言（closeAttempts≥2/naturalDone=false/fullCID rm 门/driver 正向门等）原样。
- **定性**：四件均为 source/model 准备态；缺运行产物只能说与零运行自述一致；在场文本/模型不冒充行为实测。红绿分离首跑应对 r8 冻结 root 跑红对照（tailgate ①②在 r8 上应红）再本 root 绿——交付 §4 已如此声明，本审认可该计划。

## 6. 语义保持（最小 cmp 证实未回退）

caseB1..B5 体 r9 零触碰（diff hunk 界外）；probe/preflight/repro/abort-fixture 与 r8 逐字节相等→r7 全部门（driverJoinProven 共享 rm 入口正向门/unknown 拒 rm 残留/fullCID+nonce+name+label+代际/floor+SIGKILL/耗尽零 spawn/B4 先 cleanup 再 reconnect/B5 TTL30000/5000+exec 前锚+alive→零 await abort+pending 真 join/knownlost 内存布尔/ledger fault 不跳 finalizer/getter remaining）原样；sdk5 侧统一持活 fallback（:445-459）与循环停开门（`wholeDeadlineFired || wholeRemainingMs() <= 0` 实测 1 处）未动。隐私：无新 raw 通道，exit-wall/failure 只携固定类别+数值字段；R11/R13/R15 例外/0700/ledger0600/fixed public 不重开。

## 7. blocked / 未运行 / 不可证 / 证据缺失定性（如实）

- **行为面全未证**：repro 45s→sdk5 90s→docker 30s 真实执行未派；四验证件未运行。blocked 于 54m57s node 生命周期 unknown（双方零新证；不全局扫描/pgrep/未知 kill；新独占 PGID 不逆证旧退出）+ 协调者执行授权。
- **不可证（静态）**：SIGKILL+waitpid 内核时延、90/30 真实运行总界、vendor 条件分支实际触发概率——恒红门/兜底/如实 red 覆盖，不以表达式在场冒闭合；真实退出 wall 当前未测（仅 finally 阶段采样在案）。
- **需另授权**：vendor post-state teardown 异常分支（先清 session 后 end/kill 再 reject）owned 不可修——仍 blocked，不撤旧 normalG1；SDK/vendor/产品/依赖/锁/builder/旧 reports/root/raw 本审全程只读零写入。
- **exit-wall 写失败定性（按协调者口径，不新造无限架构门）**：写盘异常被 catch 吞（:858 注释自认「exit-wall 缺失由审侧如实记」）——缺失 exit-wall JSON 属**诊断证据缺失**，如实记录于此；红绿行为判定由 exitCode+failure JSON 承担、独立于该写盘成功（先置 exitCode 结构保证），故不违反 R-Q19-1 required；未来授权运行时的**必备接受证据**若含 exit-wall 则缺失即按证据不全处理，本轮无任何运行故无接受证据可言。
- 历史边界原样：原 SDK5 未跑/current5fail/544×2/全部旧红/CID 与七 mockPod unknown/G1 全 3s/G3/S2 企业 partial；§18.4 旧越界按当前授权原状保留为历史（不追认/不作合规证据/不以删史换绿/不再要求删）。

## 8. 结论

R-Q19-1/2/3 全部真修、源码独立闭合，含协调者两点追加（exit-wall 先于最终再核；AtFinalize 命名如实）与五红分支先非零、未 settled 不清 timer、旧 const 零残留。**静态准备窄批准成立**：本包作为「可进入授权执行」的准备态成立。未预支项维持：任何 model/VM/newFunction/oracle/repro/preflight/SDK test/daemon/container 均未运行且未经许可不运行；红绿分离（先 r8 红对照后 r9 绿）、真实执行、企业接受、release 全部待协调者/用户另行授权；历史 unknown 全部保留。若授权运行：先 r8 冻结 root 红对照（tailgate ①②预期红）→ 本 root 绿 → 独立日志不覆盖 → 再议真实 repro/sdk5/docker 派单。

## 9. 证据保留

审者 root（0700/UID501，不删）：`/tmp/grok-s2-r20-review-xFgJpy/{sdk5-r8-to-r9.diff, node-check.txt(9/9)}`（0600）；cmp 结论内联于本报告 §1。r9 root 自 worker_done 起冻结；r8 及全部旧 root、coor 原件只读零执行。本审写入仅 docs/reviews/grok-s2-sdk-session-pin-round-20.md 与 docs/reviews/handoff-coverage.json（round37）。
