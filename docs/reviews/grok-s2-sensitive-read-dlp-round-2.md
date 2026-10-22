# grok-s2-sensitive-read-dlp-round-2.md — Pi R43 修复轮独审（Grok R44；task_25f0ee2483fd / ctx_ae5f3a87ca58）

- 日期：2026-10-19；审者：Grok（唯一 reviewer，原 terminal/incarnation/model）。被审对象：Pi task_3c812ecc2db6（R43，docs/implementation/s2-sensitive-read-dlp-r43.md，evidence=/tmp/pi-r43-hEncj8ku 只读）。
- **判定：request_changes（范围收窄）。** R42 两项主缺陷的 R43 修复**核心转绿**（本审独立零资源因果控制证实）；残留 4 项产品 finding（R-Q43-1…4）与 1 项证据面 finding（R-Q43-5）、1 项观察项（R-Q43-6）。45/54 绿与 tsc 0 为作者口径，本轮未复跑（资源裁决），不作为独立验收。
- 本轮唯一 repo 写入=本文件。reviewer 私有根=/tmp/grok-r44-review（0700，ledger prov-r44.jsonl 0600，manifest 一次性生成自排除，self-digest `e82ea93fd4931ea22cc660bcd20a58e525f5c32a7adb05240ae05fa258e91c63` 只记于本文件与 worker_done）。
- 承接历史裁决（不翻案）：R42 A1–A5 为真红；R42"_~ 是 0x5F–0x7E 区间"为**假**（类内 `_` 与 `~` 之间无 `-`，尾 `-` 为 literal）——A0/A9a 的 403 真实机制是本环境 secret 门面把 `{{SECRET_…}}` 夹具双向替换为类内字母数字实值（R43 doc §1 字节级实证），raw 命中属设计内；R42 该段由本节勘误覆盖。R42 b1 after-reap/b5 恶意 argv 未证（混钟/真实 spawn 混入）；b7 stale-final-log、b9 argv negative 为真；R42 旧 B fake 含真实 spawn 不算纯 fake；R43 对旧实现的插桩重建红（runner-old-red.ts/secrets-old-red.ts）只称 reconstruction。
- **coor 冻结 SHA 独立复验（msg_697fc6f176d1 清单，全部吻合）**：secrets.ts（经门面双向替换比较）✓、server.ts a8877f96…、runner 76cc7c83…、modelgw.test 18afc535…、runner.test c97c645b…、r43 doc cea9512a…、progress ef54726f…；原 root manifest digest 8a81fc58… ✓。本轮 review 期间产品冻结无漂移。

## 1. 方法与资源合规（零资源）

- 全程静态读取 + 同进程纯注入因果控制（`/tmp/grok-r44-review/causal-r44.mjs`）：DLP 走 secrets.ts 纯函数；runner 走 R43 新增 `RunnerDeps` 注入缝（procInfo/signal/spawnImpl/now/sleep/setTimeoutImpl 全 fake，信号只记录不投递，无真实 child/ps/socket）。运行前静态确认：不 import server/http，无真实 spawn/ps/signal；内部真实定时等待 ≤2s，脚本自寿命 <10s，由发起 shell 实际 wait 到 exit 0。控制结果 25/26 pass（唯一 fail 为 reviewer 自身 sanity 断言笔误，主断言通过，已入 ledger 偏差）。被审 runner 未被用作外监督；R38–R42 rejected outer 一律未复用。
- 未跑（资源裁决）：Docker、full/serial、SDK、容器、真实 child、HTTP server、真实 kill/ps；无 PATH 伪 ps、无裸 python3、无固定覆盖日志。作者 54/54、45/45、tsc 0 仅核对其原始日志存在与形态（§5），未独立重跑。

## 2. DLP 审定（R-Q42-1 修复面）

**转绿（独立零资源实证，非复述作者）**：A1/A2/A3/A4 形态经 `scanJsonDecoded` 均产出 findings；own-value 判定为原始位置配对（`next.rawStart === t.valueAt`，secrets.ts:174-177）——数组兄弟 `[{"password":null},"值"]`、数组值、number/bool/null 均不配对，空白分隔 `{"password" : "值"}` 正确配对；重复键（含转义重复键）→ `json_duplicate_key`（:277-281，同对象栈语义，嵌套同名 `type` 不误杀）；原始深度界限在 tokenizer 栈上强制（:228-235）；`decodeStrictUtf8` fatal ✓；server.ts 扫描管线与 R42 逐行一致（raw+decoded 并集、413/403/503 分类、block 默认、redirect:error 未回退——逻辑未改，静态核对）。

- **R-Q43-3（required）解码层 key 名册窄于 raw 词边界语义**：`CREDENTIAL_KEY_RE`（secrets.ts:86）为精确名 `^(?:password|passwd|secret|api[_-]?key|token)$`；raw credential-assignment 以 `\b` 词边界可命中 `my-password`、`auth-token`（`-`→`p/t` 为边界）等带前缀变体，raw authorization-header 可命中未转义 `"authorization":"Bearer …"`。转义后 raw 失明、解码层无合成 → **三形态 bypass 实证**：`{"my\u002dpassword":"<值>"}`、`{"auth\u002dtoken":"<值>"}`、`{"authorizatio\u006e":"Bearer AAAAAAAAAAAAAAAAAAAA0"}` 全部 0 findings（causal-r44.mjs `dlp-keyname-coverage-vs-raw-wordbound`，gaps 三项 BYPASS）。secrets.ts:79-81 注释"派生名与 raw 规则口径一致不命中"只对下划线前缀成立，对连字符/点/斜杠前缀不成立——parity 声明与 raw 实语义不符。修复要求：合成名册覆盖 raw 词边界可达的同条目变体（或等价机制），并以同缝负控转绿；authorization→authorization-header 规则的关联亦须纳入。
- **R-Q43-4（required）token 上限为抽取后断言**：`if (tokens.length > MAX_JSON_NODES) throw` 在 extractJsonStringTokens **返回之后**（secrets.ts:160-161）；抽取本身 O(body) 无累计上限。重复键炸弹（9000 键、塌缩文档 nodes=1 过 walk）实测完整抽取 9001 token 后才抛 `json_bounds_exceeded`（causal 控制实录）；8MiB 上限体（server 层）最坏先物化 ~1.4M token 对象再拒。任务原文明确"上限要在累计扫描时真正限制"。修复要求：MAX_JSON_NODES 在 tokenizer 内累计越限即 onFail（深度已是此式，:228-229），测试以塌缩文档极小、原始 token 超限的炸弹断言。
- 其余验收点核定：fatalUTF8/full raw+decoded ✓；固定公开类别/8MiB 413/扫描器坏返回 503/audit 需显式批准/redirect:error 由未改 server 逻辑+作者 54/54 日志佐证（本轮 HTTP 禁跑，独立复核留待下轮有资源授权时）。

## 3. runner 审定（R-Q42-2 修复面）

**转绿（全注入实证）**：ps -g 已删除、residue 恒 unknown；四正证（PGID+birth+PPID+command 归一化，:125-135）组级与 direct 同尺；TERM 前预算耗尽→零观察零信号（:285-291）；KILL 前 fresh 重核验、组模式单发 -pgid 无冗余 direct 枪（:362-372）；grace 每轮先查 exit、ps 失败先让宏任务再查 exit、仍失败=unknown 零补杀（:337-345）；grace sleep=min(50,剩余,grace 剩余)（:346-348）；exit 事件即时注册（:505-516）+ `childExited` 动态 getter（字面 false 已除）；validateProcessGroup 共享总预算（每次 floor(min(cap,剩余))、≤0 停，:160-177；B7 控制以推进假钟实证预算递减）+ 初次 PPID/birth/command 校验 safe=false（:182-198）+ runner/parent 观察失败 safe=false（:203-210）；收尾次序=结算→全部 finalizer IO→新鲜 sticky check→runnerWall 采样→清 timer（:611-697）；finalizeIO snapshot 填已知结算值+`pre_final_io` 标注（:639-668）；finalizer 抛错→停其余 IO→reject（:625-633,:725-728）；冗余"runner 返回"日志已删；生产 ps 固定 /bin/ps+SIGKILL（:83-88）。

- **R-Q43-1（required）cleanup 越过硬总绝对预算**：`cleanupBudget = max(remainingToTotal(), graceMs + 2_000)`（runner:570）+ grace 真实钟兜底 `performance.now()+graceMs+2000`（:327）+ KILL 后 2s close 等待（:598-605）——最坏路径 wall ≈ totalDeadline + graceMs + 4s。任务裁决明确：whole-run 唯一绝对预算须含信号/等待/finalIO，"绝不 grace 扩展/额外 2s"；R43 doc §2.9 称"调用方请求的处置扩展"不接受——graceMs 是 runner 自身 API 参数，max() 取大与 +2s margin 均为 runner 内部决定，且 doc 头部（:19-23）自述"绝不耗尽后赠予额外预算"与之自相矛盾。修复要求：cleanup 全程（观察/grace/KILL/close 等）钳制于 totalDeadline 内（graceMs 与剩余取小；KILL 后等待取剩余）；真实钟兜底只防死锁不得成为第二预算。
- **R-Q43-2（required）fallible 日志插在核验/扳机检查与信号之间**：TERM 分支 :313/:318 与 KILL 分支 :369 的 onLog 位于 fresh 核验（:289/:362）与扳机重查（:310-312/:364-366）**之后**、信号（:315/:321/:371/:373）之前。因果实证（B9 控制）：onLog 抛错 → 已验证的处置被放弃、零信号、cleanup 整体失败（资源 unmanaged）；慢日志则耗蚀扳机邻接预算。任务要求"fallible 日志必须在 fresh 观察之前，观察后紧邻 remaining/exit 检查再 signal"。附带：:544/:568 两处裸 onLog（validate 结果/target 到点）抛错会带预挂 timer 直接 reject——无 finally 收敛（头注"任何失败路径 finally 收 timer"未覆盖此两点），timer 泄漏至 TOTAL 才释放。
- **R-Q43-6（观察项）strict command 绑定使包装器目标失去 deadline 处置**：`npx tsc --noEmit` 实际 ps command 为解析后形态，与 spawn argv join 不符 → validate 永不 safe → 组级零信号（作者自证：/tmp/pi-r43-hEncj8ku/log-tsc-r43-final2.txt "子进程 command 与预期不符…零信号"）；direct fallback 同需 command 全符 → 亦零信号。fail-safe 方向正确，但 npx/npm run 类目标超时后将 unproven 孤儿化——runner 核心功能缺口，修复可要求 wrapper 归一化策略或显式 fail-fast 拒绝此类 target，不得静默降级。

## 4. 作者 full 轮原日志审计（log-full-bounded-r43.txt；只读）

- 头部：`--timeout 1500s`、PGID=4818 四元组启动正证（01:10:07）。实际 `duration_ms 5701958`（95min）且 runner 无 exit/close/final wall（尾部 924 行止于 failing tests 明细，无 bounded 收尾行）——**外层 runner 终态 unknown**（外部 SIGKILL 仅为作者叙述）；orphan 以 detached 身份跑完并产出总结，故 615/598/11/1/5/0 是**监督缺席下的孤儿运行**结果，预算安全与结果有效性均不可自此日志主张。doc §3/§4 已如实记录，本审确认其口径。
- **11 fail 逐项归属与 doc 不符（R-Q43-5）**：原日志 failing tests 明细为 4×`tests/four-eyes.test.ts`（:223/:247/:273/:301，22.5–33.6s）+ 7×`tests/protected-paths.test.ts`（:114/:131/:148/:161/:178/:191/:228，"等待超时；已收到（空）"，22.5–30.8s），合计恰 11；`tests/enterprise-s1.test.ts:1:1` 文件级为 **cancelled 1**（"Promise resolution is still pending but the event loop has already resolved"），不计入 11。doc"11 fail 全部在 tests/enterprise-s1.test.ts"为**假**（coor msg_697fc6f176d1 独立复读同结论）；docker info 20s×2 无响应只能解释 four-eyes 4 项的时长形态，protected-paths 7 项（waitFor 空输出超时）根因逐项 unknown，且不据此排除 Docker 影响或把超时当唯一根因——与 coor"逐项核原日志"一致。修复要求：doc §3/§4 按 fail ID 逐项更正（four-eyes 4 + protected-paths 7 + enterprise-s1=cancelled），根因保持 unknown，不补跑。
- skipped 5/cancelled 1/todo 0 与日志一致；PGID 4818 事后 reap（reap4818.mjs）：登记身份四正证 → TERM → 4.5s ps-null → gone，exit/close/OS-wait 无句柄=unknown，无事后 ps 空追认 join——纪律可接受。

## 5. R43 证据根核验（/tmp/pi-r43-hEncj8ku 只读）

- manifest（sha256-root-manifest-r43.txt，68 哈希行，自排除，无 symlink，uid=501）：66/68 复算吻合；**2 条与现盘失配**：`prov-r43.jsonl` 清单列 size=0（SHA e3b0c442…）→ 现 500B（SHA 4bb1f069…，2 行）；`log-manifest-r43-b.txt` 清单列 235B → 现 829B（方向依 coor msg_513038e69fed 复核更正；本审首报写反，已改）。**3 个封版后新增未列**：check-final.json、fix-progress.mjs、log-fix-progress-r43.txt（+manifest 自身）。seal 事件记 files=67 与清单实际 68 行差 1。prov 第 2 行 post-seal note 手写 ts `2026-10-19T02:45:00Z` 与 mtime 1792369209 差 ~5.5h，其"evidence root 文件未再变动"与 prov 自身追加及上列失配矛盾。
- **失配机制（coor 复核采纳）**：`make-manifest.mjs` 先遍历 hash root（含当时为空的 ledger 与在写日志）→ write manifest → 之后才 append ledger/console 写日志——**封版协议内生地变更其所含文件**（ledger 必然 0→N、manifest 运行日志必然后写），加上后续按 coor 实数纠正的追加，共同构成上述失配；原 manifest/原证不修。seal 事件自身 sha256=8a81fc58…（=coor 冻结值，本审复算一致）。
- **R-Q43-5（required，证据面）**：合并三条：①封版协议内生变更使其 manifest 自生成起即失真（须改协议：先落定全部文件（含 ledger 终态）→ 再一次性 hash → manifest 外记自身 digest；或显式声明 manifest 覆盖时点并冻结其后变更）；②doc"11 fail 全部 enterprise-s1"归属错误；③post-seal note 的手写时戳与"root 未再变动"表述不可当真实事件时点。均以追加纠正，不重写历史。
- 红绿证据形态核对：log-dlp-red-r43-a（旧码 11 负控→红）、log-runner-red-*（reconstruction 7 形态）、log-modelgw-full-r43{,-b,-c}（首份为旧 runner 格式含"runner 返回"行——该份绿结果以 -b/-c 新格式为准；-b 为中间缺陷红，缓存亲和抓出的全局键名去重误杀，与 doc §1 WIP 记录一致）、log-tsc-r43-final2 exit 0。runner-full-r43-b 238552ms 在其 240000ms 预算内 ✓。

## 6. 边界与未跑（保持）

S2 partial；B2 pending（docs/reviews/s2-scm-scoped-grant-contract.md 合同不变）；B12/强 OS 隔离 external；G1 全 3s/G3/54m57s unknown 原样；S3–S6 pending、S7 gated。本轮 reviewer 零真实资源（无 Docker/child/HTTP/kill/ps scan）；DLP server 级端到端（403/fetch0）与作者 54/54、45/45、tsc 未独立复跑（资源裁决），列为本审 limited——不以上述绿数替代 §2–§3 源门，亦不因 full 轮 11 fail 否认已转绿的修复面。旧 unknown 一律保持 unknown。

## 7. 结论

R43 把 R42 两项主缺陷修到了"核心机制正确"：A1–A5 形态在解码层闭合、own-value 原始位置语义正确、重复键保守拒成立；runner 的身份四正证、零预算零信号、exit 驱动、收尾次序与 finalizeIO 语义经全注入控制转绿。剩余 required=R-Q43-1（预算越界）、R-Q43-2（fallible 日志次序+两处裸 onLog timer 泄漏）、R-Q43-3（key 名册三形态 bypass）、R-Q43-4（token 上限后置）、R-Q43-5（fail 归属与证据根封版纪律更正），R-Q43-6 观察项随下批处理。Pi 修复后按本轮 causal 控制同缝复审（先红后绿），随后方可进入 B2 实做派工。
