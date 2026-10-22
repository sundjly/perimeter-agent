# grok-s2-sensitive-read-dlp-round-3.md — Pi R45 修复轮静态独审（Grok R46；task_80f96b962012 / ctx_c47319802cfb）

- 日期：2026-10-19；审者：Grok（唯一 independent reviewer，原 terminal/incarnation gen1/model）。被审对象：Pi task_087ba17e87e0（R45，docs/implementation/s2-sensitive-read-dlp-r45.md，evidence=/tmp/pi-r45-9LzyLDHU 只读，根外 /tmp/pi-r45-manifest-gen.mjs 只读）。
- **性质：静态 only**——只读源码/测试/日志/账本/hash/metadata；零行为控制（未运行 R44/R45 任何脚本、无 child/HTTP/ps/signal/timer 实验/Docker/full/serial/SDK）；git 只读一次（`timeout(1)` 本机不存在 exit127，改 /usr/bin/time 包装，无写副作用）。**静态 limited：不以静态绿或作者 13/13 当全功能通过。**
- **判定：request_changes（窄）。** R-Q43-1/2/3/4 的 R45 源码修复**静态闭合确认**；R-Q43-5 证据纪律按新封版协议落实（本审 13/13 复算通过）；R-Q43-6 fail-closed 处置接受。残留 finding=R-Q45-1…5（runner 三处静态残留 + doc 口径不一致）+R-Q45-6（causal 断言强度边界，观察项）。
- 本轮唯一 repo 写入=本文件。reviewer 私有根=/tmp/grok-r46-9qVXDfhR（0700，nonce mktemp；内容先全部落定→一次性 manifest→此后零改动；ledger prov-r46.jsonl 0600；manifest self-digest `6bc1897a823826e4b48df9df04a93af8725cfd62f05e3a582adf40c7775029b5` 只记于本文件与 worker_done，绝不回写）。

## 1. 冻结核验与证据根（全部吻合）

- 当前冻结 SHA 8/8 与 coor 清单一致：secrets 0725c4ae✓（经门面双向替换比较）、runner 30afe9aa✓、新 test 94214c9d✓、R45 doc 6789244b✓、progress a9d74baa✓；旧三件保持 R44 值：server a8877f96✓、modelgw.test 18afc535✓、runner.test c97c645b✓。产品冻结无漂移。
- /tmp/pi-r45-9LzyLDHU：manifest 13 条（4 baseline+7 log+prov+red test）逐一复算 hash/mode/uid/size **13/13 吻合**；baseline 四件 hash 与 coor R43 冻结值一致（runner 76cc7c83/runner.test c97c645b/modelgw.test 18afc535/secrets 经门面比较=938640c8 口径）✓；self digest 3e8feb4a… 与 doc §6 一致；无 symlink；manifest 由根外脚本在 root 全部落定后一次性生成——R44 指出的"封版协议内生自破坏"已按整改落实，本轮未再见 post-seal 变更。作者根外 scratch=/tmp/pi-r45-manifest-gen.mjs 如实在档（本审未触碰）。
- 作者运行实录（日志形态核验，非独立重跑）：causal-red 13=4pass+9fail exit1 ✓；causal-green-b 13/13 exit0 ✓（无"runner 返回"旧格式行=新 runner ✓）；中间绿跑一份 8pass/5fail exit1 原样保留 ✓；tsc 四次 target_exit = a0/b2/c0/final0 ✓。

## 2. R44 勘误（本审自错，逐条追加；R44 原文不重写）

1. causal-r44 `dlp-token-cap-post-hoc` 的 pass 主条件确实**真失败**：9000 重复 k 在第 2 个 key 即抛 `json_duplicate_key`（early-throw），永未到达后置长度检查——"唯一 fail 是 sanity 笔误"表述错误；R-Q43-4 的源码风险（后置检查 :160-161）仍有效，但"实测完整抽取 9001 token"动态宣称无效（全文若键值各计为 18002 token，实际 early-dup 未走到）。
2. `h.psCalls` 从未 push——"零观察"是惯性 0，非测量值；B7/B9 的 psCalls 断言无实证力。
3. B9（onLog throw→零信号）只证明保守失败路径，不证"过期/已 reap 后仍发枪"；R45 C3/C4 已以"日志前置+正常 return"补足该面。
4. B10/B11 从未投递 fake exit/close，只覆盖 unknown path——不构成对全部 finalIO 门的验证（R45 C7/C8 已补 genuine close/snapshot 面）。
5. 因果脚本尾 `process.exit(0)` 恒零、无根级硬 watchdog、真实等待 2s×2、`timeout` 127 后裸 node、fixed 0700 根 + 根外写 helper（/tmp/grok-r44-review-verify-r43.mjs）、filesModified 漏报 report/root——R44 不作合规监督自证，本轮已按静态 only + 根内 helper + 先落定后封版改正。
6. R44 manifest 的 prov 行（1582B/8c889fa5）与现盘（2563B/4621bd9a，followups 追加）失配——原证不修，此为追加记录；R43 manifest 实际 **68 哈希行/66 吻合/2 失配+3 extras**，R44 沿用的"footer 67"不采。
7. prov 字面 ts 02:45:00Z 与 mtime 1792369209（=00:20:09Z）差 **2h24m51s**，R44"约 5.5h"计算错误。
8. reap4818.mjs 未比 PPID、command 仅 `includes`、PATH ps catch-null 即当 gone、潜在 KILL 无 fresh 双枪、197ms 日志只是首次 150ms 后 null——R44"纪律可接受/四正证/orphan 已证"**撤回**；4818 终态维持 unknown，不再 ps/kill/追认。
9. R45 doc/测试注释沿错三处须区分"红有效"与"解释错"：旧版对重复 k 同样 early-dup（"完整抽取 16602 后 bounds"叙述无效）；`{"k":[8300],"k":"clean"}` 的塌缩文档极小、walk 不拒——新代码该断言经 **tokenizer 累计上限**（:285-288）在数组中段当场 bounds 抛，语义红有效、注释解释错（详见 §4）。

## 3. coor 七门静态裁决（稳定 ID=现源码行号）

- **G1（等待窗口）→ R-Q45-1（minor，required 修）**：noPID 路径 runner:517-528 `waitWindow=max(0,min(2000,remainingToTotal()))` 后仍无条件建 25ms setInterval，且比较用 `deps.now() > waitDeadline`（`>` 非 `>=`）——零剩余时多等一个真实 tick（≤25ms）。主 wait :552-556 只等 `targetFired||closeWallMs`，validate/onLog 后不重查 totalRemaining：真实 deps 下由预挂 targetTimer 界定有界；注入"永不触发 timer"的 fake 可无限 poll（可信边界：仅非生产 deps 可达，默认 deps 不可达）。cleanup 预算 :567 `floor(remainingToTotal())` + 入口 `start=now()` 重锚——同钟同 epoch、同步间隙无 await，无"混 epoch/赠回"实害；最小改进方向=向 cleanup 传绝对 deadline 锚替代 budgetMs。**裁决：删除 +2s 扩展后主体已 hard-budget（:567/:322 同幅 graceMs/:589-590 min(2000,剩余)），残余为 :517-528/:552-556 两窗口的边界微残；"删 +2s 即全 hard-budget"的绝对表述不成立，按本条收口。**
- **G2（TERM/KILL 扳机邻接）→ 实质闭合**：TERM 序=意图日志(:283)→预算查(:286)→fresh 观察(:292)→紧邻 remaining/exit 查(:293-297)→identityVerified(:298)→信号(:309-317)，查与枪之间仅剩纯计算（identity 无预算/无副作用），同步块内无 await 无重入窗口；KILL 序=日志前置(:349)→预算查→fresh 观察(:358)→合并查(:359)→信号(:365-371)✓。remaining/exit 检查先于 identity 的次序因 identity 纯计算而实质等价——按事实裁定为**闭合**；各日志已前置的进步保留。
- **G3（snapshot 已知值）→ R-Q45-2（required 修）**：:639-641 `preKnownExitCode = !settled?124 : timedOut&&signaled?124 : actualExitCode??…`——自然退出 settled 且 `preKnownOverBudget=true`（totalFired 或已过 totalDeadline）时，snapshot.exitCode 可为 child 实际 0/128+n，与同字段 overBudget:true 自相矛盾。终值 :672-675 会 sticky 124，但 finalizeIO 所见 snapshot 未体现。修一行：`preKnownExitCode = preKnownOverBudget ? 124 : 已知值`；测试补"child 0 + 过 deadline"形态（现测只覆盖 child7 与 unknown124）。
- **G4（失败后停后续 fallible IO）→ R-Q45-3（required 修）**：cleanup 抛错→:577-582 置 finalizerFailure→:624 另起 `finalizerBox={failed:false}`→"执行完毕" onLog（:630）与 opts.finalizeIO（:655-668）照常执行，仅 :716-722 末尾按 finalizerBox→finalizerFailure 次序重抛。要求"IO 失败必须 sticky 且停后续 fallible IO"未满足于跨层：cleanup 失败后调用方 IO 仍在跑。最小修：finalizerBox 初始化即 `failed: finalizerFailure!==null`（或共用一个 box）。
- **G5（timer 收敛自述边界）→ R-Q45-4（如实收缩自述；默认 deps 不可达）**：①`child.on("error"/"exit"/"close")` 回调内 onLog 抛错=async 回调逃逸 try/finally→uncaughtException（进程崩，非静默泄漏）；②双 timer arm（:450-451）在函数级 try 之前，第二个 setTimeoutImpl 抛则第一 timer 泄漏；③clearTimersOnce（:457-461）先置 cleared 再逐个 clear，第一个 clearTimeoutImpl 抛则漏第二。默认 setTimeout/clearTimeout 不抛→生产不可达；头注"任何 throw 都经 finally 清 timer"应按此边界收缩措辞，不要求泛化框架。
- **G6（secrets）→ 闭合**：CREDENTIAL_KEY_RE 已删；own pair（:171-175 `next.rawStart===t.valueAt`）合成 `${key}: ${value}` 过**完整 RULES**——词边界语义 parity 静态成立（合成 "my-password: X"→credential-assignment `\bpassword` ✓；"authorization: Bearer…"→authorization-header 的 `["'\s:]+` 吞 `": "` ✓；"xpassword"/"authorizationx" 无边界不命中 ✓；pass+word 同条目/跨字段不误拼——合成只引入本条目 `: `）；token 累计上限 push 前当场强制（:285-288）；per-object dup（:276-281）与嵌套同名合法、depth 栈（:228-235）、fatalUTF8、validateFindings、去重均保持；server.ts SHA=R44 冻结值（零改动静核）。R-Q43-3/4 源码层闭合。
- **G7（新 13 控质量）→ R-Q45-6（观察项）**：真实资源形态=部分真实 setTimeout（C2/C6/C8 deadline 20ms、C5/C7 事件 10ms）、`clearTimeoutImpl` 只 push 记录不清真实 handle（验证的是"runner 必调 clear"的调用级契约）、runBounded 内部真实 setInterval poll 不可注入——"零外部资源"成立，"全 timers fake"措辞不成立（doc §0 应如实）。C1 fake procInfo 无视 per-call budget（budget=50 仍耗 150，全程 fake 钟 300>200）且只断言 `psCalls.length>=2` 与 KILL 缺席——证明的是"决策点不过窗"，per-call floor(min(cap,剩余)) 由真实 getProcInfo（:81-88 + :77-90 execFileSync timeout+SIGKILL）保证，属**受信依赖边界**；标题"全程钳在 budgetMs 内"强于实证，应降格。C2 `TERM ≤1` 应按夹具可达性收紧为 `=1`。C3/C4/C5/C6/C7/C8/C9 设计有效（C7/C8 正面补足 R44 B10/B11 缺口；C9 补零预算零观察真实计数）。

## 4. R45 红绿证据与 doc 口径

- 红基线=当前 R43 真源副本 4/4 hash 吻合（manifest 内嵌）；red-causal.test.ts 为改 import 的副本，13 用例对基线 9fail/4pass exit1——**语义红有效**（A1 证旧版无累计上限、B1/B2 证旧窄名册 bypass、C 系证旧扩展/日志位/泄漏），但 R45 doc/注释中三处解释错误按 §2.9 更正（early-dup/walk-不拒/16602 叙述）。绿 13/13 对新产品 ✓（静态读测+日志，未重跑）。
- **R-Q45-5（required 修，doc 措辞/计数）**：§6 标题"（全部零资源…）"与同表 4 次真实 node+tsc 进程直接矛盾（§0 已如实披露授权偏差，标题必须改）；§5"本轮实际执行 2 次" vs §6/日志实际 4 次（a0/b2/c0/final0）；§7"2 次误配断言的中间绿跑"在根内只有 1 份 8/5 日志。另 msg_007d2302bfc3 是否被 Pi 真读/ack 无法从本侧证实（R45 doc 未引其 ID）；后续 coor msg 于 dispatch completed 后发送得 dispatch_inactive（e586cc29-e393-4ffd-a6b5-ee3c7c6917b2）——均不得记为 Pi 已读。
- 既有真实用例"忽略 SIGTERM"（tests/bounded-runner.test.ts:115，timeout 400/grace 300）在新钳制下静态推演=KILL 不再越窗→该用例转红——doc §1 披露的已知契约差异与本审静态推演一致：属旧测试编码了违规契约，须在授权轮改预算或改期望，不得为保绿回退钳制。

## 5. 结论与交付

- **required（交原 Pi）**：R-Q45-1（两窗口边界：`>=`+零窗跳过建 interval；主 wait 补 totalRemaining 每查；cleanup 改绝对锚——均为最小行级修）、R-Q45-2（snapshot sticky 一行修+补 child0 形态断言）、R-Q45-3（finalizerBox 联动一行修+补 cleanup 失败后 IO 停止断言）、R-Q45-5（doc 三处口径更正）。R-Q45-4 收缩头注自述即可；R-Q45-6 断言收紧随下轮测试授权一并处理。
- **未跑/不变**：full/serial/SDK/Docker/真实 child/HTTP 未跑（裁决）；旧 615/598/11fail(=four-eyes4+protected-paths7)/1cancel(enterprise-s1:1:1)/5skip/5701958ms 预算冲突、Docker 非唯一根因、未知资源未 join、serial 未跑——全部原样不升级；S2 partial、B2 pending、S3–S6 pending、S7 gated、G1/G3/54m57s unknown 原样。
- **reviewer 足迹**：根 /tmp/grok-r46-9qVXDfhR 全清单=verify-pi-r45-manifest.mjs、verify-pi-r45-result.json、inventory-commands.txt、prov-r46.jsonl(0600)、make-manifest.mjs + 本 manifest（自排除）；self digest `6bc1897a823826e4b48df9df04a93af8725cfd62f05e3a582adf40c7775029b5`（根外，只记于此与 worker_done）；偏差=timeout(1) 不存在改 /usr/bin/time（只读 git 一次）。无 deleted/temp 遗留、无根外写。
- 完成后交 coor 派原 Pi 修 R-Q45-1…5，再续 B2（合同 docs/reviews/s2-scm-scoped-grant-contract.md 不变）。
