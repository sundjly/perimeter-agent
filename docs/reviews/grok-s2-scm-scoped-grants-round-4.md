# grok-s2-scm-scoped-grants-round-4.md — Pi R55 修复轮增量静态独审（Grok R56；task_245b19c311fc / ctx_201b5abb064e）

- 日期：2026-10-19；审者：Grok（用户授权的新 reviewer，复用 R54 同一 terminal/incarnation gen6；非旧 R52 作者，model/provider 未观测不推断）。被审对象：Pi task_5df7c4b13f4e（R55，s2-b2-scoped-grants-r55.md，4a696de0，唯一 done msg_dc39b6515437）+ 对照 R54 round-3（131a1c50，当前字节未漂移）、SCM 合同（2468eefc，未漂移）。
- **性质：静态 only（(c) 全程，零行为）**——零 Node/JS/tsx/tsc/TS-API/npx/npm/零 Python（含 uv）/零解释器编辑/heredoc/awk/sed/零编译测试/零 HTTP/socket/listen/fetch/零 child/ps/signal/零 Docker/Git/demo/零真实 timer/sleep/worker。仅 native read/edit/write + FS metadata/hash/copy + Orca 协调。**本轮唯一 repo 写入=本文件**；reviewer 根=/tmp/grok-r56-hWSs3LXH（0700）。typecheck/tests=**unrun/unknown**。
- **判定：request_changes（源码级文件红未除，授权执行轮不可开）。** R55 方向性闭合良好：轮换事务纯缝（A）、初签 identityExpiry（B 主链）、logout 事务序（C）、泵/转发收束（E）、提前调度（F）、R47-12 声明修复（G）经实际字节 trace 成立；但 **两处文件级语法红使 production/import 面不可加载**（§1.1/§1.2），B 的 restore 丢字段留新 required（§1.4），D/H 的 pending-read owned 截止仍未落（§1.2/§1.3）。author-driver-r55 经本机 API 核验**双重不成立**（§5）。B2=partial；17 项真实/P1/gzip/3HTTP/demo/typecheck 全 pending。

## 0. 封版复验（全过）

根 0700；prov-r56.jsonl 0600 seq1/2 coor 预置未动，reviewer 追加 seq3+。snapshot 35 regular/0 symlink；frozen-current-sha256.txt 35/35 MATCH；35/35 `cmp` 与当前工作区字节一致（非 HEAD）。author-driver-r55.mjs 拷贝 SHA=8eddc818… 与声明一致，未运行。R55 根 /tmp/pi-r55-yFMPSQr7 只读：manifest self=2379f5cb… 亲算相符；该根为**事前 baseline30**，不冒最终源 seal。modelgw 两件仅 hash/copy 零内容读。旧 R51 坏 seal/旧未授权绿/54m57s 等原样保留，不倒证。

## 1. coor 静态候选 (1)–(7) 逐项独立判定（全部实测字节）

### (1) 文件级红 ×2 —— 坐实（本轮最高 required）
- **bounded-reader.ts:29-30 参数属性**：`constructor(private readonly src…, private readonly deps…)` 是 strip-only 不支持的 TS 语法（Node 需 transform 的 parameter property，v24.21 默认 strip-only 直接拒载）；且正文消费 `this.#src`(:55)/`this.#deps`(:40/:53/:57)，而类体内**仅 :26 `#timedOut` 显式声明**——`#src`/`#deps` ECMAScript 私有字段从未声明：tsc 引用红、即便加载后运行 `read()` 即 TypeError。三重独立红，**该模块不可 import**。
- **gitproxy/server.ts:684-685 同块重复 `const gate`**：两行 `new DeadlineReadGate(...)` 同名声明 → SyntaxError（Identifier 'gate' has already been declared）→ **整个 gitproxy/server.ts 不可解析**；第二行还直接传 :678 刚声明未赋值的 `src`（TDZ）。第一行 `{ read: () => src.read() }` 闭包延迟绑定是正确形态，**最小修=删除 :685**。
- 传染面：gitproxy/server.ts 红使 tests/git-grants.test.ts、gitproxy.test、git-e2e、git-grants-integration、demo.ts 的 import 面全部不可加载；bounded-reader.ts 红使 tests/bounded-reader.test.ts 不可加载。**§4 资格表据此判定。**

### (2) 转发段 pending read 无 owned 截止 —— 坐实（required）
- :806-821 `boundedRead`：:808 `mono() >= bodyDeadline` 仍是 **await 前比较**；:813 `await src.read()` 不走 gate——源挂起（半开/解压泵停供）时 bodyDeadline 过点无人再查，pull→fetch 永挂。R54-D 的"owned 截止"只在 header 段落地（:774 `gate.read(headerDeadline)`），转发段未接 gate。
- **最早预算未取**：header 段 :760 用 `requestStartMono+headerDeadlineMs`，转发段 :803 用 `+bodyDeadlineMs`；配置 body<header 时 header 段不受更早预算约束——两 deadline 应取 `min` 于 header gate（或 gate 双判）。
- 计数覆盖面实测：compressed 仅 gzip 泵 :700-715（header 8MiB:704-710、全程 128MiB:710-715）；decoded 转发段 forwardedBytes :815-819（512MiB）；**header 段 decompressedBytes :775 无独立上限**（靠 scanner 64KiB+单 chunk tail；tail/header 不计入 512MiB 计数——量级可控，如实记录）；**identity 分支无泵→compressed 计数恒 0**（identity raw==decoded，由 64KiB header+512MiB 转发计数覆盖，口径可接受但 doc 未说明）。
- 收束 trace：gate 超时 reject 后 pending read 由 cancelSource 的 `src.cancel()/rawReader.cancel()` settle（无 unhandled）；泵 pumpDead 三态 + catch 统一 destroy/cancel ✓；正常 EOF `end()` 不 destroy、gunzip error/close listener :687-688 在位 ✓。**逻辑面成立，但整文件因 :685 语法红不可达——"修好后成立"不等于"已闭"。**

### (3) 轮换事务 —— A 静态闭合；unit 与生产 order 同缝但生产函数本身不在 unit 内
- 生产 order 实测（gateway/server.ts）：:707 `previous=new Set(entry.jtis)` 在 :708 **纯** `#signGrantClaims` 前（绝不含 newJti，R54-A 时序缺陷根除 ✓）→ :709 plan → :711 apply → :712-713 cap/exp 落 entry → :714 save（**persist 先于投递** ✓）→ :715 writer → catch :721 `retireUndeliveredNew`（new 进 revoked）→ :722 `rollbackRotation`（entry 恢复 previous、只还原本次新增 revocation——原 revoked 不复活 ✓）→ :723 save try → 审计 → throw。**try 块全同步**（save/writeGitCredentialConfig 均同步）→ R53 的 entryStillCurrent 检查在此同步段恒真，移除无害（非虚构异步竞态点）。
- 初签 :487-507：sign 纯 → entry 建（含 maxExpAt=signed.cap、currentExpAt=signed.exp）→ save try → 失败回滚 jtis.delete+空 entry 删+throw ✓ **save 失败不发布 token**。初签不直接写 HOME（token 经 Session wiring 于 start 落 .gitconfig；start 失败→cleanup→onDisposed 撤销）——不留活的未交付 new ✓。
- **currentExpAt 回滚缺失坐实**（doc §3c 自披，本轮确认为缺陷非仅待审）：:713 设新值，catch 不恢复——失败后旧 token 实际活到旧 exp，调度却按新 exp 排程 → 旧 token 到期后最长 ~maxInterval(7.5min) 的 git 面断档（可用性，非安全）。**最小修**：try 前 `const oldCurrent=entry.currentExpAt`，catch 回滚 `entry.currentExpAt=oldCurrent`（一行）。
- unit（grant-rotation.test 4 例）验证 helper 组合语义与生产 catch 顺序一致（retire 先/rollback 后）；生产函数 #renewGitGrant/#issueGitGrant 本身的 save/writer 顺序只有本静态 trace 覆盖（Gateway 构造级 NOT ready 维持）——**unit 不冒生产事务验收，如实两态**。

### (4) 初签 expiry —— 主链闭合；restore 丢字段 = 新 required
- 签发点 :932 第 6 参直传已验 `identity.expiresAt` ✓；#issueGitGrant :489 → computeGrantExpiry（renew-policy.ts:62-65：cap 过即拒、min(15min,cap)、null 只受 15min 锁）✓。demo Infinity 语义核过（min(+15min,∞)=+15min）。
- attach 现存分支 :893-901：linkBrowserSid（服务端 sid）✓；**同 owner**（principal 字串精确匹配 :897）且 `maxExpAt==null||undefined||identity.expiresAt>maxExpAt` 才升 cap + :899 try save（失败内存已升——doc §3a 如实，内存值不越认证期限，持久化滞后窗口如实列）✓ 不借 collaborator ✓。
- renew fresh 先于 revoke（:690-695，fresh 更大或 captured null 才更新）✓ 合法重认证续命、不硬 15min ✓。
- **restore 丢字段坐实（required）**：save payload :476 `{...e}` 含 maxExpAt/currentExpAt（写入 ✓），但 ctor restore :359-371 解析类型与 :370 restored 构造**只含 sessionId/principal/tenant/repo/aclVersion/jtis 五字段——maxExpAt/currentExpAt 被丢弃**。重启后 captured cap 丢失 → decideRenew cap=null → 离线续签每轮 `now+15min` 且 :712 保持 null → **15min 锁轮转成无限链**，原 captured 上限（含"即将到期的 IdP 凭证"）不再约束——正是 coor(4) 指认形态。最小修：restore 类型+校验+构造补 `maxExpAt?: number|null` 与 `currentExpAt?: number|null`（数值或 null 校验，缺省 null；null 即"重启后不可知"时按 fail-closed 拒续或仅 15min 锁——须与 computeGrantExpiry null 语义显式对齐并在 doc 写明：**重启后 null≠可信无到期 identity 契约**）。
- scope 不扩：sign 参数同源（:517-521 allowPush/writeRefs 重推导）✓；断线用 captured（fresh null → cap=entry.maxExpAt）✓。

### (5) logout 事务 —— 主链闭合；两处 optional
- :1190-1229 实测：:1192 flush 重试入口开头调；:1199 **peek 不删映射**；:1200-1202 内存先撤全部（#revokeGitGrantSessionInMemory :565-570，jtis→revoked、active.delete、无 save）；:1203-1213 browser.delete/saveSessions/每 conn close 各自独立 try 收首 err；:1215-1219 **一次 git save → 成功才 take 删映射**；:1220-1221 失败 pending.add（映射保留，重试入口在）；:1223-1227 firstErr→审计+`send(500)`。不 ban principal、无关 browser 保留 ✓。**≥5s 窗口语义维持（≤pollMs 生效）**。
- tombstones：flush :584-595 不查 entry 存在性、全量 save revoked，无 `has(entry)==false` 假成功 ✓；close 的 #revokeGitGrantAll 全量 save 覆盖 pending ✓。
- **doc 措辞失实（optional-doc）**：R55doc §1 C"save 失败时 cookie 仍被响应清除（500）"——实际 :1226 `return send(500)` **无 set-cookie**（500 分支不清 cookie）。后果非安全（:1203 browser.delete 内存已删，旧 cookie 天然失效），doc 需更正一句。
- **browser saveSessions 失败不进 pending（optional）**：pending 只覆盖 git registry save（:1220）。saveSessions 失败 → 磁盘 browser session 残留，重启恢复窗口（principal 有效期内）——内存已删、下次任一 saveSessions 补盘，低风险如实列；修法=失败分支同挂一个 pending 或文档声明边界。

### (6) renew 调度 —— F 主链闭合；同步-fire 重入为注入面 optional（两代同在，无回归）
- :634-647：effective 上限 = `min(configured/缺省, TTL/2)`（:644，**R54-F 的 min 语义落地**）；实际延迟 :653 `computeNextRenewDelayMs`（renew-policy.ts:38-53：due=currentExpAt??maxExpAt、margin=renewMargin、近到期排 cap 到点一次 revoke 后 entry 被删、下限 250ms、无 entry→上限）✓ 不 spin 实核（near-expiry 最多再一拍即 revoke-and-skip 删 entry）；签发 :505/续签成功 :718 后刷新 ✓；#closed :652 不 rearm ✓；#renewMaxIntervalMs 字段 :216 已声明 ✓。
- **同步 fire 重入**：:653-663 先 stop 旧 timer（#stopGitGrantRenewTimer 配对 clear，较 R53 新增 stop-first=改进）→ 建 timer → 尾部赋值 slot。若注入 timerImpl **同步** fire：内层 fire→finally #scheduleNextRenew→内层建 timer 占 slot→返回外层→外层赋值**覆盖内层句柄**（内层 timer 泄漏、双 fire）。R53 旧码同样无此防护（fire 后 finally 重入+直接赋值），**"旧 inline-hook 防护消失"不成立——两代同在**；真实 setTimeout 异步不可达，仅 fake-timer 契约面。optional：契约注明异步 fire，或先赋 slot 再返回 timer。
- reaper 仍 Native（:418-422）→ Gateway 构造级 NOT ready 维持 ✓，不为测构造扩框架 ✓。

### (7) R47-12 —— 坐实闭合（仅修声明+三段计数门）
- :452 `let containArmed` 单声明（重复已删）；:453 `termSeen` 声明且真用（:459-460 判定序、:471 赋值）；三段 preTermObs/gracePreContainObs/postContainObs；:486 `gracePreContainObs>=1` 为**真 TERM 后 grace 首轮门**、:487 preTerm>=1、:489 postContain=0、:488 置位后零日志、:484 TERM 恰 1、:485 KILL 0、:490 escapes 0、:491 双 timer 清、:481 rejects、:482 finalizeIO 跳过——**断言全数保持未放宽**；生产 runner 冻结 6f4e2b0f 未动（frozen hash 核过）。文件内无其他重复声明/未声明变量（grep 复核）。仍 standalone 9s 协议另批 ✓。

## 2. R54 required A–H 逐项三态（source / static-eligibility / execution 严格分列）

| 项 | source 证据（当前字节） | 判定 |
|---|---|---|
| A 轮换事务 | grant-rotation.ts 纯缝 + gateway :707-727/:487-507；unit 4 例 | **source 静态闭合**（除 §1.3 currentExpAt 一行）；execution=unrun |
| B 初签 expiry | :932/:489/computeGrantExpiry/:893-901/:690-695 | **主链闭合**；新 required=restore 丢字段（§1.4）；execution=unrun |
| C logout 事务 | :1190-1229/:565-570/:584-595 | **主链闭合**；optional=doc 500-cookie 措辞、browser-save pending；execution=unrun |
| D owned 截止 | bounded-reader.ts + :664-669/:774 + receiveLimits :73-113/:200-214 | **未闭**：两文件级红（§1.1）+ 转发段无 gate + 未取最早预算（§1.2）；execution=unrun |
| E 泵/转发收束 | receive-pack.ts:113-132 runOnCancel；泵 :687-688/:699-753 三路监听/pumpDead/EOF 不 destroy | **source 静态闭合**（宿主文件红内，修复 :685 后成立）；execution=unrun |
| F 提前调度 | renew-policy.ts:38-53 + :634-664 | **主链闭合**；optional=同步-fire 注入面；execution=unrun |
| G r47cases | :452-453/:459-491 | **闭合**（standalone 9s 另批） |
| H 全寿命有限 | raw 128MiB/decoded 512MiB/body 120s + ceilings | **部分闭合**：上限在，但转发段 pending read 无 owned 截止与 D 同根（§1.2）；header decoded/tail 不计数如实列 |

## 3. required 清单（交原 Pi 最小修；全部可静态验证）

1. **bounded-reader.ts**：参数属性改显式字段（`#src; #deps;` 声明 + ctor 内赋值）——strip-only 可载、私有字段有声明。
2. **gitproxy/server.ts:685**：删除重复 `const gate` 行（保留 :684 闭包延迟绑定形态）。
3. **boundedRead 接 gate**：转发段 `src.read()` 经 DeadlineReadGate（deadline=min(headerBody 双锚最早)；pending read 超时 cancel+fail 类别）；header/body 两预算取 `min` 于 header 段。
4. **restore 补 maxExpAt/currentExpAt**（:359-371 类型+校验+构造；null 语义与 computeGrantExpiry 对齐并在 doc 写明"重启后 null≠可信无到期契约"）。
5. **renew catch 补 `entry.currentExpAt` 回滚**（一行，§1.3）。
- optional（不阻塞准入）：doc 500-cookie 措辞更正；browser-save pending 边界声明；同步-fire 注入契约；header/tail 不计入 decoded 计数的 doc 说明；identity 分支无 compressed 计数的口径说明。
- 修后资格变化预估：gitproxy/server.ts 与 bounded-reader.ts 红除 → git-grants.test/bounded-reader.test 升 READY 候选；六文件 §4 表重排。

## 4. 六 target + 测试静态资格（当前字节；imports/top-level/构造面逐一）

| 文件 | 资格 | 依据 |
|---|---|---|
| src/gateway/grant-rotation.ts | **READY（纯模块）** | 零 import 依赖、零资源、纯集合变换 |
| src/gateway/renew-policy.ts | **READY（纯模块）** | 同上（+computeGrantExpiry/computeNextRenewDelayMs） |
| src/gateway/grant-session-mapping.ts | **READY（未改）** | hash 同 R54 |
| src/gateway/server.ts | **静态可解析；构造级 NOT ready**（维持） | 依赖面全 READY；Native reaper+FS+审计 |
| src/gitproxy/bounded-reader.ts | **NOT ready（文件级红 §1.1）** | 参数属性+#src/#deps 未声明 |
| src/gitproxy/server.ts | **NOT ready（文件级红 §1.1）** | :685 重复 const gate |
| tests/credential-domains.test / gitproxy-receive-pack.test（13）/ grant-rotation.test（4）/ renew-policy.test（10）/ bounded-runner-r47-cases.test（12，standalone 9s 另批） | **READY** | import 面全 READY、零资源/零真实 timer（r47cases 例外见协议） |
| tests/bounded-reader.test（5） | **NOT ready（传染：bounded-reader.ts 红）** | 修后升 READY 候选（用例本身真实因果、纯） |
| tests/git-grants.test（11） | **NOT ready（传染：gitproxy/server.ts 红）** | 修后恢复 R54 READY 判定 |
| tests/wiring / gitproxy.test / git-e2e / git-grants-integration | **NOT ready 维持** | 构造级/真实 HTTP/git 二进制/未授权 |

## 5. driver 准入审查（author-driver-r55.mjs：**双重不成立，维持拒绝、禁止运行**）

本机 `node_modules/@types/node/test.d.ts`（v24.21 实测字节）：`function tap(source: TestEventGenerator): AsyncGenerator<string, void>`（:2240）——**tap 是函数，返回 AsyncGenerator；不存在 `class TapReporter`**（grep 零命中）。`TestEvent` 联合（:2208-2221）**无 test:skip/test:todo/test:cancel 成员**；TestsStream 具名事件亦无此三者。据此 author driver：① :13 `import { tap as TapReporter }` + :43 `new TapReporter(tests)`——对无 construct 签名的函数 new：tsc 红，运行时 generator 函数 `[[Construct]]` 为 undefined → TypeError **"tap is not a constructor"**；② 即便可构造，AsyncGenerator **不是 Transform，不能进 `stream/promises` 的 pipeline(:44)**（pipeline 需 stream）；③ :41-43 `tests.on("test:skip"/"test:todo"/"test:cancel")` 监听**不存在的事件**→ 三计数恒 0：skip/todo 的用例实际以 `test:pass`+`details.skip/todo` 形态出现 → **skip 隐形计入 pass=假绿通道**；④ guard :24 arm 固定 9000ms，未扣 :17 T0 至 arm 的 imports/statSync/mkdir/createWriteStream 已耗时间；⑤ 无 overall `test:summary`（:405 具名事件存在而未用）——counts/success 未消费；`total<EXPECTED` 非严格等于（多算不红）；⑥ :49 clearTimeout 在 :50 fresh wall 之前（:52 `wall>=9000` 有兜底，弱缺陷）。正面增量如实：单一 run 6 suites、isolation:none/concurrency:1、pipeline 意图、wx+0600+statSync 0700 检查、EXPECTED=5+13+11+10+4+5=48 与实际 test 数逐 suite 相符、r47cases 排除 ✓。
**下一 Pi 最小正确修法（本轮不写第三版候选）**：a) TAP 接线=`const tapper = tap(tests)`（AsyncGenerator）后 **`for await (const chunk of tapper) log.write(chunk)`**（完成 log.end；错误含在 try/catch），或包一层 Transform 再 pipeline——二者皆为本机类型契约下的合法形态；b) 判负改用 `tests.on("test:summary", s => overall = s)`：`overall.success===true && overall.counts.tests===EXPECTED_TESTS（严格等于）&& counts.cancelled===0 && counts.skipped===0 && counts.todo===0`，skip/todo 判定来自 summary.counts（事件缺省即红），pass 事件仅在需要逐例时可查 `data.details.skip/todo`；c) guard arm 时长=`9_000-(performance.now()-T0)`（≤0 直接 124）；clearTimeout 放在 log close+fresh wall 采样之后；d) 保留 wx/0600/statSync/EXPECTED 逐 suite 枚举。实际父 shell wait 与最终真实 wall 仍由 coor 另审后未来一轮明确批准；**未运行绝不记绿**。

## 6. 三态与状态（不预勾）

- **source 已落（静态接受）**：§2 表 A/E/F/G 主链 + B/C 主链 + receiveLimits 校验面 + 请求起点锚（:347-354/:540）+ 零窗拒（:664-669）。
- **required 未闭**：§3 1–5（两文件级红、转发段 gate+最早预算、restore 字段、currentExpAt 回滚）。
- **static eligibility**：§4 表逐文件；**execution**：全部 unrun/unknown（typecheck/48 unit/17 验收/P1/gzip/3HTTP/demo/driver 全 pending）；外部件原样。
- helper unit 数量增加**不升级**真实事务验收；R54 ledger 手填时间与 done 先后未证——不回写旧根，以 Orca receipts 为准。
- S2 partial；B2 partial；下一轮原 Pi 修 §3 后由本 reviewer 增量复审，不以本报告收尾 loop。

## 7. 元信息

本轮零执行达成；命令=read/shasum/stat/cmp/find/wc/grep/cat/sed -n 查看/printf-ledger/orca。邮件：dispatch 时 check count=0（无 followup），交付前再查并 ack/drain0。根内新增仅 seq3+ ledger、本报告不入根（repo）、无 driver 候选文件；全部落定后一次 self-excluding manifest，此后根内零写；manifest selfdigest 只记 worker_done，本文件不含自身 hash。
