# grok-s2-scm-scoped-grants-round-3.md — Pi R53 修复轮静态独审（Grok R54；task_ac99e004e125 / ctx_b80ef2d823fc）

- 日期：2026-10-19；审者：Grok（independent reviewer）。身份如实：**新 reviewer 授权重试**（coor msg_5d7e022063ca：用户明确授权启动新 Grok 独审并 loop，优先于旧"原Grok唯一"身份约束；本终端 term_b1433b68-9487-4b01-b271-e23de2ed269f、incarnation 8b37dbc2-7d1d-415a-92df-b3108a95ade9、receipt generation 6；旧 terminal/incarnation 保留；实际后端 model/provider 未观测=unknown，不推断）。审面承前：Pi task_e59bb958235c（R53，s2-b2-scoped-grants-r53.md，b852e7e2，source 已落）+ 对照 SCM 合同（2468eefc）、本人 R52 全文（c0b8e22d）、R48 runner 审（必要只读）与当前实际源码/测试字节。
- **性质：静态 only（执行规则 (c) 全程，零行为）**——零 Node/JS/tsx/tsc/TS-API/npx/npm/零 Python（含 uv）/零解释器 heredoc/零旧 baseline/helper 复跑/零编译测试/零 HTTP/socket/listen/fetch/零 child/ps/signal/零 Docker/Git/零真实 timer/sleep/worker；unit 不因看似 pure 而运行。仅 read/hash/stat/cmp/copy/find/FS metadata。**本轮唯一 repo 写入=本文件**；reviewer 根=/tmp/grok-r54-9P49lvoM（0700，coor 预置，追加 ledger seq3+ 与证据件）。typecheck/tests=**unrun/unknown**（不复制任何旧绿）。
- **判定：request_changes。** R53 九项中 R-Q52-1/4/5/6/9 + H53-b/c 静态落地坐实（§1）；**R-Q52-8 修坏为文件级静态红**（r47cases 重复 `let` 声明 SyntaxError + `termSeen` 未声明，§3 新 required）；R-Q52-2/3/7 部分落地但同缝存在 coor 候选 A/B/C/E 实缺陷（逐码坐实，§2）；H53-d 的 header deadline **非 owned**（D 坐实）。**R52 撤回**：§2.5"renew 链主体 pass"按 A 坐实撤回；R53doc 以 R47-9/closeWall 证 Session.stop cleanup 属跨域错证，明确撤（§4）。B2=partial；17 项真实验收/P1/真实 gzip/demo 双进程全 pending。

## 0. 封版复验（全过，零偏差）

- 根 /tmp/grok-r54-9P49lvoM 0700；prov-r54.jsonl 0600 seq1–4 为 coor 预置（seq3 两次 readiness 失败、seq4 用户授权新 reviewer），reviewer 只追加 seq5+，不改前四行。
- snapshot 29 regular/0 symlink；frozen-current-sha256.txt 逐件复验 **28/28 MATCH + secrets 行 hash 显示层脱敏、布尔复验 frozen==snapshot hash 成立**；29/29 `cmp` 与仓库当前工作区字节一致（非 HEAD 口径）；R53doc hash b852e7e2、runner 6f4e2b0f 与声明一致。modelgw/secrets+server 仅 hash/copy 零内容读、零扩审。
- author-driver-candidate-r53.mjs copy digest=0814d2b8… 与声明一致；未运行、未准入。R53 私根 /tmp/pi-r53-MvspFd2K 只读（driver 候选全文已读，§7）；R51/R52/R50/R49/R47 根未触；R51 坏 seal（22 条 21 符）与 R52 31/31 有效均按原样保留口径，不以 R51 坏 seal 否定本轮前瞻 baseline。

## 1. R53 九项 + H53-a–d 逐项落地核对（行号=当前冻结字节）

| 项 | 判定 | 证据 |
|---|---|---|
| R-Q52-1 转发丢尾 | **落地** | receive-pack.ts:43-53 `tail()/takeTail()`；:95-130 `createIdentityForward`（prefix→tail→readChunk 逐 pull；cancel 收束注入）；gitproxy/server.ts:693/:707 同缝接线；unit 5 例（§6） |
| R-Q52-2 logout 映射 | **部分** | mapping.ts 纯 helper ✓；签发点 link（server.ts:868-870，服务端 identity.sid）✓；logout take（:1135-1137）✓——但 logout 事务断链（C 坐实）+ attach 现存会话分支无 link/无 cap 更新（B' 坐实） |
| R-Q52-3 renew cap | **部分** | renew-policy.ts decideRenew/renewMargin ✓ 同缝（server.ts:641）；mint cap=freshExpiry??existing.maxExpAt（:494-497）✓——但初签 identity.expiresAt 丢失→maxExpAt 恒 null 链（B 坐实）+ mint 副作用毁轮换事务（A 坐实）+ 调度措辞失实（F 坐实） |
| R-Q52-4 接口/缺省/timer 配对 | **落地** | 接口三字段（:91-99）；缺省 TTL/2（:124/:599）；显式校验 1..900000（:595-598）；配对 clear（:618-623）；wiring :252 正控缺省不再抛（静态核对成立） |
| R-Q52-5 revokePrincipal 链 | **落地** | :1560-1587 firstErr 收集、各步独立 try、固定审计+重抛；gitgrant 撤销=先内存全撤再一次 save（:553-561） |
| R-Q52-6 stop 撤销 try | **落地** | session.ts:286-292 try/审计/继续；:297-302 幂等单飞失败保留重试；stop 首行 `!alive && revokedOk` 才短路（:281）——但 R53doc 引 R47-9/closeWall 作证据属跨域错证（§4） |
| R-Q52-7 gzip 泵 drain 悬挂 | **部分** | race 存在（:646-650）✓、泵 catch destroy+cancel（:651-655）✓——但收束非"统一"：reaction 累积/无 finally/cancelSource 外路径（E 坐实） |
| R-Q52-8 r47cases 计数门 | **修坏（新 required）** | 重复 `let containArmed`（:451+:462 同作用域 SyntaxError，整文件不可加载）+ `termSeen` 未声明（:469 严格模式 ReferenceError）；见 §3 |
| R-Q52-9 期望串对齐 | **落地** | git-grants.test:110 = grants.ts:104 实际固定串 + 不含原文断言 ✓ |
| H53-a rollback 只还原新增 | **方向对、同缝被 A 覆盖** | :664 entryStillCurrent ✓；但 newlyRevoked 含 newJti（A），restore 语义在轮换事务下失真 |
| H53-b 同尺 glob | **落地** | grants.ts:216-232 isValidRefGlob；ctor :319-331 双级探针+校验；validateClaims :101-105 同尺 |
| H53-c registry 收紧 | **落地** | 形状收紧（:236-259 含 null/array/entry/epoch/cardinality 10k/100k）；tick 每 await 后 #closed 再查（:181/:186/:200/:203）；#handle 入口 res error contain（:294）；#revalidateBeforeFetch 全五轴+epoch/acl（:553-568）；重验失败 body.cancel→cancelSource（:494-496） |
| H53-d 边界计数/owned 截止 | **部分** | compressed cap 8MiB 仅 scannerDone 前（:636-641）✓；decompressed 靠 scanner 64KiB ✓；**header deadline 非 owned（D 坐实）**；转发 pack 无限=doc 自认，但 H53-d 原文要求 stream-life 有限，作者以"合法大 push"改范围——**不视作已完成** |

## 2. coor 候选 A–F 逐码判定（全部成立；含手推与最小修）

### A（required，最高）——#mintGrant 非纯 mint，renew 成功路径吊销新 token
- 手推（server.ts）：:647 `minted=#mintGrant(...)`；mint 内 **:515 `entry.jtis.add(claims.jti)`**、**:517 `#saveGitGrantRegistry()`**；返回后 :649 `previous=new Set(entry.jtis)`——**previous 含 newJti**；:652 `newlyRevoked=[...previous].filter(j=>!revoked.has(j))` 含 newJti；:657 `for (const old of newlyRevoked) revoked.add(old)`——**newJti 进 revoked 并 :658 save**；随后投递新 token（:662）。proxy :383 `revokedJtis.includes(jti)` → **≤pollMs 后新 token 403，旧 token 亦撤：该会话 git 面全断**；下轮 renew 再 mint 再自吊销，死循环。rollback 路径 :664-670：`entry.jtis=previous`（含 newJti）+ :667 `revoked.add(newJti)` 后又 :669 `delete(newlyRevoked)`（含 newJti）→ **未投递 token 在登记中保持有效**，违反"new 失败不留可用未投递 token"。
- 我 R52 §2.5"旧 jtis 全进 revoked、persist 先于投递、投递失败回滚"判 renew 链主体 pass——漏了 mint 内 add/save 的副作用与 previous 时序，**撤回该 pass**（§4）。
- 最小修（两选一，须满足全部不变量：成功后 newJti 不在 revoked、旧 jti 全 retired、persist 先于投递、save 失败不投递且原 revoked 不复活、captured cap/generation/current entry 保持、旧 retire ≤pollMs）：
  1. **mint 纯化**：#mintGrant 不改 entry、不 save，仅返回 {token,jti,claims}；#issueGitGrant 初签路径自行 add+save；#renewGitGrant 在 mint **前** `const previous=new Set(entry.jtis)`，成功路径一次性 `entry.jtis={newJti}; revoked+=previous−(已revoked); save` → 投递；catch 回滚 `entry.jtis=previous`、`revoked.delete(仅本次新增)`、save。
  2. 或 mint 前捕旧集 + mint/persist 纳入同一事务 try（mint 内仍 add，但 previous 取旧集且把 mint 的 save 并入同一失败回滚段）。
- 下一轮需真实生产同缝 rotation 事务 unit："new 可验且未 revoked/旧全拒 + save 与 writer 失败两侧因果"；decideRenew 决策面 unit 不能替代（不触 jtis/persist/revoked）。

### B（required）——初签可信 expiry 丢失 → 离线续签永续
- 时序坐实：#acceptConnection 新会话分支 **:868 #issueGitGrant 先于 :923 attach**；attach（:1650-1654）才把 conn 加入 `opts.conns`（=#conns）。#principalExpiresAt（:521-531）遍历 #conns——**首次连接该 principal 无旧 conn → freshExpiry=null**（identity.expiresAt 已验却从未传入 mint；attachOpts.expiresAt 只用于 conn 层到点关闭 :1660-1661/:1681）→ cap=null → **初签 exp=now+15min，entry.maxExpAt=null**（:516）。conn 到点关闭后 session 仍 alive → renew：decideRenew cap=null → mint → exp=now+15min 无上限 → **principal IdP 凭证过期仍可无限续**。
- attach 现存会话分支（:830-839）直接 attach return：**无 linkBrowserSid**（他 sid 重连现存 agentSession 后 logout 撤不到）且**不更新 entry.maxExpAt**（同 principal 新可信重认证不更新 cap）。
- 最小修：把**服务端已验 `identity.expiresAt`** 直接送签发/登记（#issueGitGrant/#mintGrant 增加 identityExpiry 参数；`cap=freshExpiry??identityExpiry??existing?.maxExpAt??null`；非 client header，不从尚未登记的 conn 倒查）；attach 现存分支补 link（identity.sid）+ 按新可信 exp 更新 entry.maxExpAt；decideRenew 需感知 fresh（cap<=now 且 freshExpiry 存活 → 走 mint 用 fresh，**不得硬 15min 全 session**，也不得先按旧 captured revoke 错杀合法重认证——修法把 fresh 判定放 revoke 之前）。无完整 C2 正路径不得 source pass。

### C（required）——logout 清理事务断链 + 重试入口丢失
- 坐实：:1135 `takeSessionsForBrowserSid` **先删映射**（mapping.ts:21-24）→ :1136-1137 逐个 `#revokeGitGrantSession`（:544-550 内含 fallible save :549）；**首个 save 抛即逃出**：后续 session 不撤、:1139 `#browser.delete`/:1140 `#saveSessions`/:1141-1147 conn.close/:1150 send(204) 全跳（#onRequest catch→500）；映射已删 → **重登/重试 logout 永不补撤**（活至 TTL/Dispose）。R53doc"再独立 cleanup/全部关联"与实现不符。R53doc 引 R47-9/closeWall 证 Session.stop cleanup 属跨域错证（runner 面证据不能证 Gateway 清理链）；纯 mapping 的 map-only 7 断言不构成此生产事务证据。
- 最小修：peek（不删）→ 全部目标**内存先撤**（jtis→revoked、active.delete）→ **一次** save → 成功后才 take 删映射 + browser.delete + saveSessions + conn.close；save 失败=固定审计+非 204+映射保留（重试入口在）；不 ban principal、无关 browser 会话保留。补"save 失败后重试 logout 完成撤销"因果 unit（fake 注入 save 抛错）。

### D（required）——header deadline 是检查不是 owned 截止
- 坐实：gitproxy/server.ts:672 `headerDeadline=this.#mono()+10000`；循环内 **:679 先比较 :682 后 `await src.read()`**——read 永不返回（半开/零窗/解压泵挂起）则 deadline 永不再查，无 timer/abort/race，永不 408/cancel。锚在 #prepareReceivePack（授权后）而非 #handle 请求起点。`counters.decompressedBytes` 只 `+=` 无独立阈值（:685，靠 scanner 64KiB 间接钳）；compressed 仅 scannerDone 前 cap（:636）；**转发阶段 pack 无限且无 owned 生命周期**（H53-d 原文要求 stream-life 有限；"合法大 push"不等于无界时长/无界慢流）。tail 段（同 chunk flush 后）为已缓冲字节，转发器内再整段拷贝一份（receive-pack.ts:106-107），上限≈单 data chunk——如实记录，不属丢尾缺陷。
- 最小修：header 阶段引入**可注入 owned 截止**（绝对 mono 锚=#handle 请求起点；可配置默认/上限，0 窗语义 `>=` 即拒绝不可读）：`Promise.race([src.read(), deadlineTimer])` 或 abort 使 pending read 必然 settle，超时 408+cancelSource；持续 read/pump/backpressure/cancel/error 全路径退出；不整包缓冲、同 chunk PACK 不计入 header cap、配置限额内正常 push 不受影响、上游已开始副作用不自动重试。增"真实受控 pending read 逾期被 cancel"fake unit（有限 chunk 全读完的用例不能证明 deadline 有效）。

### E（required-minor）——gzip 泵收束非统一；forwarder cancel 丢清理
- 泵（:627-655）：每次 drain 胜出的 `Promise.race` 在长寿命 pumpFinished 上**累积挂起 reaction**（大流 N 次 write-false=N 个悬挂 promise 至 close 才释放；:643-647）；pumpFinished 胜出后 `gunzip.once("drain")` listener 残留；`counters.aborted` 仅 cancelSource 置位——pump 因 gunzip 自身 error/close 退出后若无人调 cancelSource，`aborted` 仍 false → 继续 rawReader.read（挂起则与 D 同型永挂）；无统一 finally cancel/release。正常 rawEOF 不丢尾（done→gunzip.end→解压侧 flush 后可读尽）✓ 保持。
- createIdentityForward **:128 `cancel(){ void onCancel(); }`**：清理 Promise 被丢弃（rejection 无人接、完成无人等待）；pull 的 readChunk 失败只 `c.error`（:121-125）**不调 onCancel**——转发阶段 src 失败（如解压错误）时 src/rawReader/gunzip 无人收束，与泵退出检查失联。生产缓解（cancelSource :656-661 内部全 try、Readable.from 会挂 error handler 不崩进程）→ 判 required-minor，不虚构 trusted hook 投产漏洞。其余 `void reader.cancel()/body.cancel()/upRes.body.cancel()`（:234/:495/:525/:545/:547）rejection 丢弃同型，observational。
- 最小修：泵退出统一 finally（cancel rawReader+destroy）；race 改用单次等待/移除 drain listener；forwarder `cancel(){ return Promise.resolve(onCancel()).catch(()=>{}); }` 或等价捕获；readChunk 失败路径也走 onCancel。

### F（required-minor）——renew 调度无"提前 margin"，R53doc 措辞与代码不符
- 坐实：:595-599 校验上限 15min 后 **`interval=configured ?? TTL/2`**，无 `min(configured, TTL/2)`——显式 10/15min 时 effective>7.5min；R53doc"调度：effective interval ≤ TTL/2（缺省 7.5min）"与代码不符。decideRenew 的 near-expiry skip/revoke-and-skip 只在 **fire 时刻**生效：cap 短（如 renew 时捕获余 2min）而 interval 7.5min → 首次 fire 前 grant 已死 5.5min（fail-closed 但可用性断档），无提前调度效果；renewMargin 只影响 fire 时判定，不决定 timer 何时 fire。
- timer 面：专有 timer 单槽配对 clear（:600-615/:618-623）+ `#closed` 守卫（:601）+ fire 同步执行（#renewDue 无 await，单线程无 late generation 竞争）——配对/closed 核过成立；但 **#reaper（:416-420）不可注入**，Gateway 构造级 NOT ready 维持，不因 timerImpl 可选注入而称构造 pure。
- 最小修：调度间隔=min(配置, TTL/2, 活跃 entry 最早 cap−margin−now 的最小正值)，或每 entry 按 `exp−margin` 建立最早到期驱动；明确"可工作提前时点"=fire 时 cap 剩余>margin 才 mint。doc 措辞同步更正。

## 3. 新发现 required——R-Q52-8 修复本身把 r47cases 修成文件级静态红

- tests/bounded-runner-r47-cases.test.ts R47-12（:451 与 :462）**同函数作用域两次 `let containArmed`** → SyntaxError（TS/JS 同），**整个测试文件不可加载，12 例全部无法运行**（非单断言红）；另 ：469 `termSeen = true` 变量从未声明（ESM 严格模式）→ 即便修掉重复声明，运行时 onLog("SIGTERM 已发") 处 ReferenceError 且 reject 匹配 /error-cb log boom/ 必败。
- 最小修：删除 ：462 重复声明（保留 ：451 一处）；`termSeen` 补 `let termSeen = false;` 或删除该死存赋值（现断言未消费它）；**不得**改 runner 停链逻辑（生产源 6f4e2b0f 冻结）。修后 r47cases 维持"standalone 9s 协议、不进本批 driver"判定。

## 4. 撤回与承前更正

1. **撤回 R52 §2.5"renew 链主体 pass"**：mint 内 jtis.add+save 副作用（A）使旧集捕获时序失真，成功路径自吊销新 token；R52 当时只核 renew 函数本体未核 mint 副作用。R53 纯 decideRenew 8 绿（实际 7+1，见 §6）不补该正控。
2. **撤回 R53doc 两处证据口径**：a) 以 R47-9/closeWall 证 Session.stop cleanup=跨域错证（那是 runner 停链面）；b) renew-policy.test "决策 8 例+映射 1 例"=实 8 例（决策 7+映射 1）。
3. R52 其余 pass（runner 全项/H1/caps.read/scanner/parser/gzip 单流/registry R-Q50-8/audit 主体）在当前字节复验保持；R-Q52-4 wiring 正控静态红已按缺省方案消除（无需补参）。

## 5. 三态清单

- **source-pass（当前字节坐实）**：R-Q52-1 转发器+接线+unit、R-Q52-4 全项、R-Q52-5、R-Q52-6 代码面、R-Q52-9、H53-b、H53-c、scanner/parser/64KiB/refname 一把尺/isValidRefGlob、audit identity/固定类别/res error contain、registry 形状收紧+age/poll 解耦、C3 demo 双进程真实接线（renewIntervalMs=10min）。
- **required（最小修+同缝因果 unit，交原 Pi）**：A（rotation 事务）、B（identityExpiry 直送+attach 分支 link/cap+decideRenew fresh 判定）、C（logout 事务顺序+重试入口）、D（owned 截止+可配置上限+pending-read fake unit）、E（泵统一 finally+forwarder cancel 接住）、F（提前调度点+doc 措辞）、§3（r47cases 两处声明）、H53-d stream-life 上限（随 D 同批）。
- **pending/维持**：17 项真实验收（N1–N16+P1）、真实 gzip push、demo 双进程跑通、typecheck、B2=partial（源进度非验收）；外部件原样（mTLS/KMS/上游保护/IdP/CNI/DPA/WORM/soak）；O-2（502→4xx 类/internalToken 非常数时间比较 gateway:972）本轮未动，留观维持。

## 6. 下一轮 unit 准入预审（逐文件；本审零执行）

| 文件 | 判定 | 依据/覆盖边界 |
|---|---|---|
| tests/credential-domains.test.ts | **READY** | imports=assert/crypto/test+credential-domains.ts；5 例纯、零资源；randomBytes 为进程内 crypto |
| tests/gitproxy-receive-pack.test.ts | **READY（13 例：5 scanner+3 parser+5 forwarder）**+边界 | 零资源；同缝函数直调。边界：不覆盖 server 泵/deadline/计数（D/E 面）；生产接线与 gzip 集成不在本 unit；native zlib 另列 NOT RUN；取消用例的 onCancel 是注入 fake，不等生产 cancelSource |
| tests/git-grants.test.ts | **READY（11 例，R-Q52-9 修后）**+缺口 | production 构造 throw 不启 poll；dev 构造无 registry 无 timer；after 只 close。缺口：registry 快照 fail-closed 面（epoch/age/revoked）本文件零覆盖（可 registryFetchImpl+nowImpl 纯注入，无需网络）；含 registry 的构造会启真实 poll timer → 归构造级 NOT ready 面 |
| tests/renew-policy.test.ts | **READY（8 例=决策 7+映射 1）**+边界 | 零资源。边界：决策 helper ≠ mint/persist/revoked/投递/回滚事务（A 面）；mapping helper ≠ logout 生产事务（C 面）；near-expiry 仅单边断言 |
| tests/bounded-runner-r47-cases.test.ts | **NOT ready（§3 文件级静态红未修）** | 修后仍走 standalone 9s watchdog+末 fresh wall+真实父 wait 协议，不进本批 driver，不叠第二根 timer |
| tests/wiring.test.ts | **NOT ready** | B2 块构造级（Native reaper+renew timer+audit FS+:255 gw.close 真实清理）；:252 正控静态红已消除 |
| tests/gitproxy.test.ts | **NOT ready** | proxy.listen+真实 fetch+记录上游+AuditLog FS+production ctor 真实 poll timer |
| tests/git-e2e.test.ts | **NOT ready** | 真实 git 二进制+fixture 上游；17/P1 维持 pending |
| tests/git-grants-integration.test.ts | **NOT ready（未授权维持）** | 回环 listen+fetch |

- default `node --test`（隔离=process）会建 workers：**不批**；本批只用 driver 的 isolation:none 单进程。native zlib 的 import 与执行不同，integration 面单列 NOT RUN。
- 下批最小有因果力新增（非通用框架）：A 的 rotation 事务 unit（fake writer/save 抛错双负控）、B 的初签 cap/attach-link unit（Gateway 构造级面未闭前先出纯函数缝）、C 的 logout 顺序 unit、D 的 pending-read 逾期 cancel unit。helper 绿不升 B2 验收；unit READY 与业务 required 未闭**两态分别报**，互不冒充。

## 7. driver 预审（只读；author 候选 6 缺陷全坐实）与修正 proposal

- /tmp/pi-r53-MvspFd2K/driver-candidate-r53.mjs（56 行，未运行）：①createWriteStream 异步 open 后 :22 `chmodSync` 立即执行→ENOENT 竞态，且 guard :25 尚未 arm（mkdir :18/log :21 已耗时未计入）；②guard 晚于最早 t0，启动开销不在 9s 预算内；③`:26 unref` 削弱唯一失败护栏；④`run()` 返回 TestsStream（对象事件流）直 pipe 字节 log，**无 TAP reporter**；⑤四文件四次 `run()` 并发启动，`await suite.once("test:complete")` 是 per-test 事件（首测完成即切下一文件）、`pipe` 默认 end 使共享 log 在首 suite 结束即关闭，交错写+write-after-end；⑥无 summary/零测试防假绿（加载错→0 事件→绿），`:37` wall 采样与 `:38` clearGuard 均在 `:39` log.end 之前。判定：**NOT READY，不得以现状执行**。
- 修正 proposal（本轮只写不跑）：**/tmp/grok-r54-9P49lvoM/driver-candidate-r54-grok.mjs（47 行）**——单一 `run({files:4 READY,isolation:"none",concurrency:1})`；`node:test/reporters` 内建 tap（本机 v24.21 类型契约核对：RunOptions 无 reporter 字段、TestsStream 事件流、TestSummary.counts{tests,passed,cancelled,skipped,todo,topLevel}+success）；完成协议=`once(tests,"end")`→`once(tap,"end")`→`once(log,"close")`；判负=summary.success false∨tests<37（5+13+11+8，零加载防假绿）∨skip/cancel/todo≠0∨fail/cancel 事件计数≠0∨wall≥9s；log `flags:"wx",mode:0600` 不覆盖、无 chmodSync；guard 自 T0 arm 不 unref、覆盖测试+证据 IO 全程后 clear；fresh wall 在 log close 后采样。**实际父 shell wait 与最终真实 wall 由 coor 另审后未来一轮明确批准；未运行绝不记绿**。

## 8. 元信息与收束

- 执行偏差：零。全部命令=read/shasum/stat/cmp/find/wc/grep/cat/head/ls/orca 编排/printf 追加 ledger；无 Node/Python/编译/网络/信号/定时器/sleep/worker/Docker/Git；modelgw 两件零内容读；旧根全只读未触。
- 邮件：coor msg_5d7e022063ca 读全后 exact ack delivery_c38dc000d7b4，drain 0（复核 count=0）。
- 根内本轮新增：driver-candidate-r54-grok.mjs、sha256-root-manifest-r54.txt（一次生成、self-excluding、不含自身 hash）；根 seal 后零写入。本文件与 manifest selfdigest 的 sha256 只记 worker_done，不嵌自身。
- 结论：request_changes（A/B/C/D/E/F/§3 共 8 项 required，全部附最小修与因果 unit 面）；source-pass/required/pending 见 §5；B2=partial、S2=partial；下一轮先 Pi 修 required，再按 §6 表+§7 修正 proposal 走授权执行轮。
