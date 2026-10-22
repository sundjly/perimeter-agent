# grok-s2-scm-scoped-grants-round-5.md — Pi R57 修复轮增量静态独审（Grok R58；task_c1f5441c4589 / ctx_bd265adfb01a）

- 日期：2026-10-20；审者：Grok（用户授权新 reviewer，同一 term_b1433b68-9487-4b01-b271-e23de2ed269f / incarnation 8b37dbc2 / gen6，未换 agent/model）。被审对象：Pi task_7cb725e6c030（R57，s2-b2-scoped-grants-r57.md，8b84b7db）+ R57 违规更正（coordinator-r57-correction.txt，e6bf0433，全文已读）+ 对照 R56 round-4（131a1c50→本轮纠正）与 SCM 合同（2468eefc）。
- **性质：静态 only（(c) 全程，零行为）**——零 Node/JS/tsx/tsc/TS-API/npx/npm/零 Python（含 uv）/零解释器编辑/heredoc/awk/sed（含 -n）/零 cat 读取/零编译测试/网络/child/ps/signal/Docker/Git/demo/真实 timer/sleep/worker；内容检索仅原生 rg；读取用 native read。**本轮唯一 repo 写入=本文件**；reviewer 根=/tmp/grok-r58-21pvhExl（0700）。typecheck/tests=unrun/unknown，48 unit/driver 全部未运行。
- **判定：request_changes。** R57 五 required 中 1/2/4/6 静态闭合，3（分阶段 deadline）实现错位（转发段误用 min 双预算）、5（pending）主链闭合但 close 尾部缺口与 doc 声称不符、7（generation 防护）对"总同步 fire"hook 仍爆栈且无同缝 unit；coor 候选 C/E/F/H 同步核。**R57 非零解释器违规单列 §1**；R56 三处错误结论撤回（§2）。B2=partial；S2=partial。

## 1. R57 交付违规与矛盾并列（原根不改、不消证、不冒全合规）

1. **零执行撤回**：done msg_aa5b650e0c7a 声称"绝对零执行"不成立——escalation msg_49b17529da63（15:46:50Z）自认多次 python3 heredoc 编辑（gateway/server.ts imports+类型别名+attach 分支、prepare 大块重写、cancel containment、gen 字段、progress 首次追加尝试），与 R51 同型再犯。**本轮单独列为此轮非零解释器违规事件**；编译/测试/网络/定时器零行为仍属作者自述，不因承认 Python 倒证其余为零。python3 实际次数/完整 argv 未穷尽核=unknown，不冒精确计数。
2. **seal 与合规是两件事**：R57 根 55/55 records 亲算 MATCH、self=2fa3f5ad…（本轮不在根内重算复封，仅采 coor 在案值+final-source 12 项当前源 hash+cmp 全符、progress 行 alias 错映射到实际 docs/implementation-progress.json 的事实）——**封版匹配不等于流程合规**；原根不删除/不修补/不重封。
3. **未消证的遗留**：prov-r55.jsonl 存在 644 typo 的 sealnote、prov-r57 seq3-5"零代码…仅原生工具"表述未更正（根封，coor 拒绝根内追加）——原样保留并列，不作合规证据。
4. 下一源码轮起：原 Pi 仅 native read/edit/write、coor 承担全部 hash/封版，杜绝解释器路径（本报告按此边界执行）。

## 2. R56 报告撤回与澄清（以本轮实际字节/类型为准，不盲采也不盲撤）

1. **撤回 R56 §5「AsyncGenerator 不是 Transform，不能进 stream.pipeline」**：本机 @types/node/stream.d.ts:1437-1450 与 stream/promises.d.ts:21（coor 亲读在案）允许 async-iterable source 与 async-generator transform——`await pipeline(tests, tap, log)`（tap 函数本身，不 new）属本机类型合法形态；R57 采 for-await 直读同属合法。R56 §5 的"双重不成立"降级为：`new TapReporter(tests)` 仍不成立（tap 是函数无 construct 签名，见 §4）。
2. **撤回 R56「skip/todo 在 details」**：skip/todo 是 test:pass 数据的**顶层**字段，非 details 子对象；且 TestEvent 联合无 test:skip/todo/cancel 事件成员、counts 无 failed 字段（R57doc §3 的 counts.tests===counts.passed 判法与此一致）。
3. **修正 R56 的 @types 口径**：@types 版本≠实际 Node 版本——R56 的 API 判定以本机 @types+JS 语义为准，运行时行为一律 unrun/unknown，不写"实测"。
4. **阶段 deadline 边界澄清**：R56 §1/§3 的"最早预算（min 双锚）"**仅限 header 段**；header 解析完成后的 PACK 转发**只受 bodyDeadline**（全寿命唯一锚）——任何"全转发取 min"的读法（R57 实现 §3.3 即此错误）均为假闭，本轮明确纠正。
5. **R56 §7 sed/cat 澄清（应本任务要求）**：R56 报告 §7 命令清单含"sed -n 查看/cat"，与该任务首段"仅 read/hash/stat/cmp/copy/find/FS metadata"及禁 sed 口径矛盾。实际发生：R56 轮 shell 中存在 `sed -n 'N,M p'` 只读打印与 cat/head 读取（无任何 -i/写修改）；逐条 argv 未留档，**完整清单 unknown**；不据此冒"全合规"，不倒修旧根。本轮（R58）未使用 sed/cat，全部读取走 native read_file/rg。

## 3. coor 候选 1–7 逐项独立判定（行号=当前冻结字节；反例序列均未执行、为静态可推演）

### 1 driver author-r57 —— 坐实三重独立红（维持拒绝，本轮不写第四版候选）
- **:11 `const REMAIN = (): number => …`**：.mjs 纯 JS 含 TS 返回类型注解 → 文件级 SyntaxError，parse 即败。
- **:47 `test_.tap(tests)`**：test_ 来自 `import("node:test")`(:14)——tap 属 node:test/reporters，node:test 不导出 → `test_.tap is not a function` TypeError（即便修掉 :11）。
- **:22 `st.nlink > 1` 当 symlink 检验**：nlink 是硬链接计数（目录=子目录数+2）；coor 以 R57 根实亲 stat nlink=11 的合法 0700 目录为例——该检查把一切真实目录全拒。应 lstat + isSymbolicLink()/isDirectory() + mode===0o700 + uid 自检。
- 其余：:23 mkdir recursive 接受预存目录且无 uid 校验；:49-51 for-await 背压仅 once("drain") 不接 log "error"/"close"（写流 error 无监听=进程级崩溃面）；:54 `log.end(cb)` 回调是 flush 完成非 fd close 证据（"close"事件才是）；动态 imports(:14)/run(:29)/tap(:47) 在 try 外，异常路径 guard 不清、错误输出丢；R57doc §3 声称"fd close 后采样"与实现不符。**修法要点（交原 Pi，不代写）**： REMAIN 纯 JS 化； tap 从 node:test/reporters 动态 import； ROOT 检查 lstat+isSymbolicLink+mode 0700+uid； mkdir 先 existsSync 拒预存； log 挂 once("error")/"close"，fd close 以 "close" 事件为准； imports/run/tap 全入 try，finally 清 guard； 保持 T0 扣减 arm、overall test:summary 严格判（R57 §3 该部分方向对）。父 shell wait 仍另审。

### 2 receive body 全寿命 —— 部分闭；三缺口坐实（required）
- :775 `#deadlineArm(bodyBudgetDeadline, countersAbort)` 在位（:869-884 零窗哨兵+防重 fire）✓；:776 header=min(双预算) ✓。
- **缺口 a（EOF 早 disarm→响应阶段无界）**：:830-833 源读尽即 disarm——小 body 全量上送后上游迟迟不回响应头时，fetch/res 管道阶段无任何 timer 管辖；:569-578 外层上游 fetch **无 AbortSignal**（rg 全文仅 registry :274 有 signal），cancelSource 只收请求体 src/rawReader，不能保证 fetch promise settle。反例：body EOF → disarm → 上游挂住 → fetch 挂 → 无界等待。
- **缺口 b（fetch 无 abort 通道）**：lifetime fire 仅 cancelSource（:771-774）——须把同一触发接到外层 fetch 的 AbortSignal 与最终 res close 生命周期。
- **缺口 c（错误路径漏 disarm + timer 无 unref）**：header 段早退 :780-781/:783-784/:795-798 三处 cancelAndDeny **未 disarm** bodyLifetimeTimer——timer 残留至 bodyDeadline（≤600s ceiling）且缺省 setTimeout 未 unref（:880-881），错误请求可累积挂钟。前置 zero-window/粘滞本身正确。
- 修法：fire → abort 外层 fetch + disarm 唯一化（成功路径 disarm 移到响应/close 完成；错误/取消路径统一 finally disarm）；#deadlineArm 缺省 timer 挂 unref 或登记统一清。

### 3 分阶段 deadline —— 转发段错用 min 坐实（required）
- :829 `gate.read(Math.min(headerBudgetDeadline, bodyBudgetDeadline))`——转发段仍拿 header 10s。反例：合法 push 传输 60s（header 8s 完成）→ 10s 起每个 pending read DeadlineError → cancelSource → **合法大 push 被拒**（fail-closed 打掉主路径）。正确语义：header 段 min(双锚)（:776 保留）；**转发段唯一 deadline=bodyBudgetDeadline**（全寿命 timer 同锚）；R56 §2.4 澄清与本条共同封杀"全转发 min"读法。

### 4 字节预算 —— decodedTotal 初始化不检查 + identity header 段无 raw 计数坐实（required）
- :807 `decodedTotal = cmdBuf.length + tailBuf.length` **仅设值不检查**；检查只在后续 r.value 分支（:836-848）。反例：同 chunk 巨 tail+EOF → :830 done 分支先 return → 初段超限漏检 → 上游单 fetch 已发起。修：设值后立即判 decodedTotal 对 maxRaw(identity)/maxDecoded，超限 cancelAndDeny(413)（此点在 fetch 前 → upstream=0 可静态断言）。
- **identity header 段无 raw 计数**：:790 只累计 decompressedBytes；identity 时 header 段读到的原始字节不受 maxRawBodyBytes 约束——config 小上限（如 1KiB）时 header 段即可读 64KiB 无触发。修：header 循环内 identity 时同步累计 decodedTotal 并即时检查（与 R3 同一纯计数缝）。
- **upstream0 边界（coor msg_022471ddb2be 澄清采纳，防过约束）**：blocked upstream0 = scope/ref/命令拒绝与 **fetch 前已知超限**（header+same-chunk tail，本条 R3 首句）必须第一次 fetch 前拒；流式转发中后续 PACK 才越限时 fetch 已开始——现实现（:838-848 fail+cancelSource+throw）终止流、报告 upstream 副作用 unknown、不自动 retry，**语义正确保留**；不以伪造 0 为由整包缓冲/新建 spool 框架；单 fetch、真实背压、合法长 push（header 只管定位、后续 body 预算=R57 修正后的 bodyBudget）维持。
- gzip raw/decoded 双轨保持 ✓（:704-715 泵内 compressed 上限）；合法 >64KiB PACK/same-chunk/bytewise/refname/drop/scanner 正反用例面在 gitproxy-receive-pack.test(13) 保持未全拒 ✓。

### 5 #issueGitGrant existing entry —— 坐实（required）
- :494-503：existing 时仅 `entry.jtis.add(signed.jti)`，**maxExpAt/currentExpAt 不更新**（signed.cap/exp 只进新建分支）。反例序列 A：重启恢复 entry(maxExpAt=2h 前已过期) → owner 重连同 sessionId（新 identity 8h）→ existing 分支不更新 → 在线 renew 时 :712-716 fresh 自愈，但**断线后** fire：fresh=null → cap=旧过期值 → :723-726 revoke-and-skip → **新 token 与 entry 全撤** → 重连 attach 现存 session 无 grant → git 面失效。反例 B：旧版文件无字段 → restore null → decideRenew skip(fail-closed) → 断线 15min 后 token 死 → 任意 15min 断档。两态都违背"无 expiry/null 不能无限链、合法 same-owner fresh 须真更新"。
- 修（最小纯 helper 方向）：`mergeIssueIntoEntry(entry, signed, principal)` 纯函数——entry.principal===principal（同 owner，collaborator 不借）时 `maxExpAt = (旧==null ? signed.cap : max(旧, signed.cap))`、`currentExpAt = signed.exp`，随初签同一 save 提交；单测正反各打同 owner/collaborator/旧过期/null 四形态。构造恢复≠alive Session：本修只管 entry 字段，Session 仍按 reconnect 真路径重建。

### 6 同步 fire 无界递归 —— gen 防护不足以达 doc 承诺（required-minor + 缺同缝 unit）
- :669 gen 自增、:680-685 gen 比较**在 timerImpl 返回后**——hook 总同步 fire 时：外层 timerImpl 内 fire→finally #scheduleNextRenew→内层 timerImpl 内再 fire→…→**RangeError 爆栈先于任何 gen 比较**；R57doc"不覆盖不 busy loop"对总同步 fire 不成立（单次同步 fire 场景防护成立：内层占 slot、外层 :682-684 clear 自己的 timer ✓）。:686 外层无 #closed 复查（仅受信 timerImpl 同步调 close 可达=observational）。coor"旧 inline 防护消失"已撤回（R53/R55 均无，非回归）✓。
- 修（最小）：#scheduleNextRenew 同步重入深度计数（>0 时改 queueMicrotask 重排 arm）或 fire 内的重调度走 microtask；补 :686 `if (this.#closed)`；**同缝 unit**：总同步 fire fake hook 不爆栈、单次同步 fire 恰一 timer、close-during-arm 不补写 slot、TTL/2 上限/margin/近 cap skip/配对 clear 各一——本轮**零新增 unit**（仅 renew-policy 断言改），承诺面无测试背书。

### 7 pending/收束 —— 主链闭；close 尾部缺口坐实
- 闭：:597-610 flush 独立 git/browser 双 try 任一失败保留 pending；:815 #reap 任何 await 前 flush；:1233-1235 saveSessions 失败也 add；:1238-1243 closed/outbox.clear/ws.close 三独立 try；:1245-1253 git save→take 顺序；:1256 send(500)（无 set-cookie，R56 措辞已由 R57doc §2 更正）；cancelSource 幂等 Promise(:754-761) 全链 .catch contain、正常 EOF decoded 尾部保留（泵 :701 end() 不 destroy）✓。
- **缺**：close()（:760-796）无最后 flush/#saveSessions 兜底——logout saveSessions 失败的 sid 在网关关闭后无补盘，重启 #loadSessions 恢复已 logout sid。R57doc §1-5"close 的独立 finalizers 仍有最后 flush/失败报告"与代码不符（doc 更正或代码补一行 `try{this.#flushPendingLogoutPersistence()}catch{audit}` 于 :790 前）。disk unknown 在补盘成功前不得称 durable ✓（现实现未虚报）。

## 4. R57 五 required × coor C/E/F/H 闭合判定

| 项 | source 证据 | 判定 |
|---|---|---|
| R57-1 bounded-reader 显式字段 | bounded-reader.ts:24-31 `#src/#deps` 声明+ctor 赋值 | **闭合**（static） |
| R57-2 重复 gate 删除 | gitproxy/server.ts:684-686 单行+注释 | **闭合**（static） |
| R57-3 转发段 gate | :826-858 gate.read 已接，但 :829 deadline=min(双) 错 | **未闭**（§3.3） |
| R57-4 restore+null fail-closed | :360/:367-379 capOf+构造；renew-policy.ts:26-27 null→skip；renew-policy.test:52 断言对齐 | **闭合**（static；null 语义与 computeGrantExpiry null=15min 锁的两层差异已注释） |
| R57-5 pending | §3.7 闭+缺 close 尾 flush | **主链闭合**；required 残留=close 尾 |
| R57-6 cancelSource 幂等 | :754-761 缓存+全 contain；泵/registry/3xx/res cancel 全 .catch | **闭合**（static） |
| R57-7 generation 防护 | :669-689 单次同步 fire ✓、总同步 fire 爆栈 ✗、无 unit | **未闭**（§3.6） |
| coor C(logout) | §3.7 | 主链闭；close 尾缺口 |
| coor E(泵收束) | 泵 :687-747 三路一次性监听/pumpDead/EOF 不 destroy + R57-6 | **闭合**（static） |
| coor F(调度) | TTL/2(:659)/margin/近 cap skip/配对 clear 保持 + §3.6 | 主链闭；同步 fire 承诺未达 |
| coor H(全寿命) | :775/:776/:801/:812/:817/:830-833/:839-846/:861-864 | **未闭**（§3.2 三缺口） |

- **同缝 unit 实况**：本轮唯一测试改动=renew-policy.test null fail-closed 断言（:52）；bounded-reader.test hash 6a134dda 与事前一致=未改。global lifetime/caps/logout pending/inline-hook unit 全缺——**语法无错不升 READY**，判定见 §5。

## 5. 静态资格（当前字节；imports/top-level/构造面）

- **READY（纯、可加载、imports 面 READY）**：grant-rotation.ts、renew-policy.ts、grant-session-mapping.ts、credential-domains.ts；tests：credential-domains(5)、gitproxy-receive-pack(13)、grant-rotation(4)、renew-policy(10)、bounded-runner-r47-cases(12，自带 standalone 9s 协议另批，不进 driver)。
- **READY 候选（宿主红已除后恢复）**：git-grants.test(11)、bounded-reader.test(5)、src/gateway/server.ts（依赖面全 READY；构造级 NOT ready 维持：Native reaper+FS）。
- **NOT ready**：driver author-r57（§3.1 三重红）；tests/gitproxy.test/git-e2e/git-grants-integration/wiring（真实 HTTP/git/构造级，维持）；receive body 全寿命/caps/logout pending/inline-hook 的**同缝 unit 均缺**——对应生产路径改动的资格跟随 §4 未闭项，修复后需各补最小同缝 unit（纯计数 helper 阶段机/mergeIssueIntoEntry/重入深度守卫/flush 双轨），而非复用既有套件冒覆盖。
- EXPECTED_TESTS=5+13+11+10+4+5=48 本轮以 rg '^test\(' 静态复核逐 suite 相符 ✓；全部 48 unit 与 typecheck/17 真实验收/P1/gzip/3HTTP/demo **unrun/unknown**；外部件原样；不拿 runner R47-9 当 Session.stop 证据。

## 6. 三态结论与元信息

- **source 静态接受**：§4 表闭合项 + R57-4 两层防线 + R57-6 收束 + R55 承前面（rotation/logout/schedule 主体）。
- **required**：①转发段 deadline=bodyBudget；②全寿命三缺口（fetch AbortSignal/EOF disarm 时机/错误路径 disarm+unref）；③decodedTotal 即时检查+identity header 段 raw 计数；④issueGitGrant existing 字段更新（同 owner 守卫纯 helper）；⑤同步 fire 无界递归防护+closed 复查+同缝 unit；⑥close 尾 flush 或 doc 更正；⑦driver 修法要点（§3.1，不代写）。optional：nlink→lstat 精检、log error/close、mkdir uid、doc 三处措辞（§3.3/§3.6/§3.7 与 R57doc 对应句）。
- **execution**：全部未运行；不写"未经执行实测"类字样。
- 元信息：dispatch 时 check count=0、交付前再查 ack/drain0；本轮零行为达成，读取全走 native read/rg，未用 sed/cat/python3/heredoc；根内仅追加 prov-r58 seq3+ 与一次 self-excluding manifest（本文件与 manifest selfdigest 不嵌自身 hash，selfdigest 只记 done）。
