# grok-s2-scm-scoped-grants-round-2.md — Pi R51 修复轮静态独审（Grok R52；task_d5bbb1ce815c / ctx_ca3cb8113a32）

- 日期：2026-10-19；审者：Grok（唯一 independent reviewer）。身份观测（coor msg_65eb4fd0696f 补正后口径）：incarnation f70142ab-7e1c-4b21-abbb-fe41e1c07ebb 与 terminal 002b7a0b 不变、无替代/重启/切 model；R52 worker-start receipt prompt.generation=**3**（按观测记录，不假保持 gen1）；Orca runtime 0932231b→0ae52a35-f010-44a1-924c-ac25c641e3fa；actual model 未观测=**unknown**（不以角色 label/provider unsupported 推断 distinct API provider）。当前 dirty worktree 保持。被审对象：Pi task_41c4bd35ca99（R51，docs/implementation/s2-b2-scoped-grants-r51.md，dbc70bd8）+ runner 收口；对照=SCM 合同（2468eefc）、本人 R50 全文（grok-s2-scm-scoped-grants-round-1.md，7e482e6e）、R48 runner 审（grok-bounded-runner-round-3.md）、R47 文档与实际源码/测试。
- **性质：静态 only（执行规则 (c) 全程）**——零测试/零 Node/tsx/tsc/TS-API/npx/npm/零 Python（含 uv）/零旧脚本 baseline/零 HTTP/socket/listen/fetch/零 child/ps/signal/零 Docker/Git-demo/零真实 timer/零 worker；metadata 仅 read/hash/stat/cmp/find/cp/sed-查看/grep/wc，唯一写入=本报告 + 新根 /tmp/grok-r52-TsjWH0pM（追加 ledger seq3+ 与证据文件）。typecheck/tests 状态=**unrun/unknown**（不复制 2967ms/13/13/12/12 任何旧绿）。
- **判定：request_changes。** R51 源实现主体方向正确：R-Q50-1/R-Q47-C（runner）、R-Q50-2（caps.read 强制）、H1/H4/H5/H6/H7、renew 链真实存在、R-Q50-8 解耦——源码层逐一坐实（§2）；R-Q50-4 gzip 重写方向正确且单流语义成立，但**新 required R-Q52-1：identity/gzip 转发流丢弃同 chunk 的 pack 尾字节（手推坐实，主路径 P1/demo push 必坏）**；另 H3 logout 撤销键空间错位（R-Q52-2）、renew 漏用已捕获 maxExpAt（R-Q52-3，R51 遗留 c 升 required 坐实）、`renewIntervalMs` 接口零声明（R-Q52-4，静态类型红）、revokePrincipal 吊销链中断（R-Q52-5）等 9 项。**B2=partial；17 项真实验收/P1 全 pending。**
- **本轮唯一 repo 写入=本文件**。reviewer 新根=/tmp/grok-r52-TsjWH0pM（coor 预置 0700；prov-r52.jsonl 0600 seq1/2 不可改，本轮只追加 seq3+；全部内容落定后一次性 manifest，selfdigest 只记 worker_done/编排运行日志，root seal 后零改动）。coor 预置 24 件 snapshot 与 frozen-current-sha256.txt 双侧复验 **48/48 OK、与仓库工作区零 drift**（a01 落根）；modelgw/secrets 与 modelgw/server 两件仅 hash/copy、内容零读取、零扩审。R51 根 /tmp/pi-r51-LTfym3iL 静核：prov 0600、manifest self=3fcfd7e3… 与 doc §0 一致（manifest 文件 mode 644 如实在档，非指控面）；R50 根 /tmp/grok-r50-o2iY2JRB 确无自身 0600 ledger（R51 erratum #4 属实，本轮 sight-check 坐实）。R49/R50/R47 等旧根一律只读未触。

## 1. R50 erratum 与承前裁决（不引旧文免审；本轮以当前字节重推）

1. coor 抓到的 R50 七错**全部成立并接纳**：Gateway :288-296 旧互异校验把 internalToken 自置 others 且 `t===internalToken` 恒真（H1 恒推）；identity 路径 rawCmd 剥 flush 而 okEnd 必遇 flush（H2 恒 403）、forward 漏 flush/same-chunk、rawLen cap 误算与 -3 非边界；logout 旧 907-923 无 git 撤销且 stop 在 await starting 后（H3）；初始 aclVersion 自杀刚签 grant（H4）；unsupported mode/readRefs/强度仅 TS 类型（H5）；audit 透传（H6 旧）；"gateway 无 registry load"为误报（H7，ctor 内联 load 真实存在）。本报告全部以当前源码独立重推，R50 对应结论作废。
2. R50 正结论**沿用面收窄**：audit claims-only/未知 repo unverified——本轮在当前字节复核成立（§2.7）；"identity 全闭/三抛坐实"**撤回**（恰为 H1/H2 错判面）；"own-pair 全 RULES 的 grant crypto"系 **DLP 术语混入，撤回**——本轮改为对 credential-domains 模块与 grants.ts 的实际审（§2.2），不借 DLP 结论。
3. R49 遗留两项（arm/clear 布尔、Transform import）**本轮按码判定已真修**：runner :519-539 布尔 armFailed/clearFailed+err 独立；server :2-3 `createGunzip` from node:zlib、`type Transform` from node:stream。R49 doc 不改写，以 R51 doc 为准——属实。
4. R51 执行偏差（doc §偏差 自披）：python3 heredoc 编辑多次 + ledger seq4——**是执行了编辑代码**，"零执行"仅指编译/测试/网络；本审按 ledger 口径记录，不为旧轮开元问题轮。

## 2. 逐组源码审（pass=当前字节坐实；行号=当前冻结字节）

### 2.1 runner（组 1）——pass（一处测试静态红见 R-Q52-8）
- **R-Q50-1 坐实**：cleanupProcessGroup 全部 `failed()` 分支裸 `return failReturn()`（:302/:318/:321/:324/:328/:342/:383/:394/:397/:404/:410/:415 共 12 处，零 onLog）；TERM/KILL 合并条件已先拆独立裸返回、remaining/exit 分支保留日志（:344-349/:405-411/:415-421）；leaving-grace :383 裸返回。failure 置位后 onLog/观察/信号/finalizeIO 全零：finalizerBox 初始化即承 failureBox（:730）、safeFinalizer 双闸（:731-739）、CLI finalizeIO 同缝（:755-777）、终点 throw 非零（:829-839）。
- **R-Q47-C 真修坐实**：armFailed/armErr 布尔+独立 err（:519-529，arm 失败立即 stickyFail、`if (armErr!==null) throw` 经 finally 清已 arm timer :554/:841-843）；clearTimersOnce 双 timer 独立 try、任一失败 sticky（:533-539）；三处 `throw … ?? new Error("…hook 抛 null…")` null 包装（:829/:833/:837）。
- **R-Q47-B 保持**：t0=函数首行（:481-484）；TOTAL/RESERVE 自适应/绝对 deadline/零窗 `>=`/无重锚（cleanup budgetMs=remainingToTotal()+absoluteDeadline 同锚 :676-681；close 等待原锚 :699-706）全部保持。
- **TERM1/KILL1/simclose 正控保持**：R47-9 精确 TERM=1/KILL=1/killed_after_verified/closeWall 已证/runnerWall≤TOTAL（tests/bounded-runner-r47-cases.test.ts:352-399）；R47-7/8 意图日志推钟与日志后改身份/exit 零过期枪；R47-1/10 预算尽零观察零信号（真实计数）。
- **新 fake 全注入坐实**：makeEnv/R47-9 的 deps 七缝全注入（now/sleep/signal/setTimeoutImpl/clearTimeoutImpl/spawnImpl/procInfo，:84-126/:353-388）；被审 runner 无不可注入真实等待。Root9 watchdog（test :20-24）=文件级唯一真实 timer，性质是**受信 root 自寿命护栏（观察面）**，生产攻击面声明不适用；其启动与否决定下一轮运行是否 bounded——按 coor 下轮单一根 9s 协议执行（§5）。
- **required 残留**：仅 R-Q52-8（测试静态红）。源侧 runner 无新 required。

### 2.2 Gateway 构造与凭据域（组 2）——H1 pass；一处正控静态红（R-Q52-4）
- **H1 坐实**：assertDistinctCredentialDomains 逐对字节比较（credential-domains.ts:24-44），空值跳过、同名同值自碰拒、错误只含域名；assertMasterKeyStrength ≥32B（:49-53）；gateway ctor 五域两两（gateway/model 别名 modelToken=cfg.model?.token??wiring.proxyToken/gitProxy/masterKey/internalToken，server.ts:292-302），自身不再自比较，合法互异构造恒推 bug 消除。别名与缺省语义可解释（两处皆缺省→空值跳过）。
- **运行时校验坐实（非 TS-only）**：mode 严格二值（:131-134）；assertMasterKey 实调（:135）；pollMs 1..5000 安全整数（:137-141）；internalToken string≥16（:142-144）；readRefs/writeGlob 在 cfg 与每个 repo 条目 `in` 探针（:148-155）；production 三拒（:157-160）。**不把 TypeScript excess-field 当拒——本轮确认这些是运行时分支。**
- **caps.read 强制坐实（R-Q50-2 闭）**：`if (!claims.caps.read) deny 403`（:408-411）先于 allowPush/write 判定，读操作全走。
- **helper positive ≠ 真实 ctor**：credential-domains.test 为纯 unit（§5 ready）；真实 ctor 正控= wiring.test :252——**静态红**（gitGrants 缺 renewIntervalMs，ctor 必抛，见 R-Q52-4）；构造含 Native interval+FS，非 pure，已如实标注（wiring :239-241），本预审不批其入纯批。
- 观察 O-1：gitGrants.writeRefs 的 glob 形状/refname 尺度无 ctor 校验（首签 mint 时经 grants.validateClaims 才拒，fail-closed 但晚）；gitGrants 级 `readRefs` 字段无 `in` 探针——部署误配被静默忽略（B5②精神应 ctor 抛）。

### 2.3 receive-pack（组 3）——单流语义 pass；转发丢尾 required（R-Q52-1）；pump 悬挂 required-minor（R-Q52-7）
- **scanner/parser 坐实**：跨 chunk 真实 cursor、不回退（receive-pack.ts:42-69）；flush 精确一次且含于 headerLen（:55-58）；cap 只计命令区（:66-70，done 提前 return 不触 cap 检查→same-chunk 大 pack 不误 413）；全零 OID 按 pkt 边界（:50-63 长度字段推进）；parsePktCommands fatal UTF-8/首条 \0 caps 截断/非首条禁 NUL/3 段 grammar/isValidRefname 一把尺/重复 ref/SHA-1 值域/空命令区（:83-122）；错误全固定类别。
- **gzip 单流语义坐实**：整个 body 经单一 createGunzip（server.ts:592-606），header 在解压后字节定位（:613-631 消费 src=解压侧 reader）；前缀+余包 identity 单次上游（:643-661）；无压缩字节 pkt 扫描、无分段 inflate、无 re-deflate（identity 恒 true，:456-464 死分支无害）；compressed 侧 write→drain、decompressed 侧 toWeb pull 真背压；rawReader/src 各单一 reader 无双读；解压输出 header 阶段受 64KiB cap 钳制。
- **content-length 遗留 a 裁决**：上游转发头表**从空构造**（:432-455），仅补 git-protocol/content-encoding(upload)/content-type/accept/authorization——原请求 content-length **根本未转发**，R51 遗留 a 担忧的"长度不符"前提不存在；无需为不存在的转发加剥除逻辑。真实 gzip/HTTP17 仍 unrun。
- **拒绝收束坐实**：全部拒绝路径 cancelAndDeny→src.cancel()→deny（:571-576/:617-639），上游零 fetch；off-glob/解析错/超限/未见 flush 全 403/413 且固定类别。
- **R-Q52-1（required，本轮最高）**：`PktHeaderScanner` done 时整块存 `pending`（:55-58/:69），`header()` 只暴露 `pending.subarray(0,headerLen)`（:36-38），**同 chunk 中 flush 之后的 pack 尾字节无任何 accessor、无任何消费者**；server :628 `Buffer.from(scanner.header())` 后 body pull 只发 prefix+后续 `src.read()`（:643-660）——**尾字节丢失**。手推三条 trace（§3）：trace1 同 chunk header+flush+pack→pack 头部整段丢失；trace2 逐字节跨 chunk 且 flush 恰在 chunk 末→无丢失（缺陷只在同 chunk 尾）；trace3 小 header+同 chunk>64KiB pack→不误 413 但 pack 尾丢。净效应：合法 push 的转发流被截/毁，上游 unpack 失败或空 pack 报错——**fail-closed 方向但 P1/demo/git-e2e 主路径必坏**；gitproxy.test :206-220 的 body 恰以 flush 结尾、又不断言上游字节数，故现有用例全绿测不出。最小修：receive-pack.ts 增 done 态 `tail(): Buffer`（`pending.subarray(headerLen)`），server 首 pull 依序 enqueue prefix、tail，再 src.read()；同缝加一条"forwarded bytes == 原始流"的服务层 unit。
- **R-Q52-7（required-minor）**：gunzip 泵 `await once("drain")`（:598-606）在 gunzip 被 destroy（corrupt gzip→自身 error；或拒绝路径 src.cancel()→toWeb cancel→destroy）后永不触发——泵闭包悬挂、rawReader 不 cancel，每例泄漏一个挂起 promise；泵 catch 亦不 cancel rawReader。最小修：drain 与 close/error 竞速（或 close 即 reject 并 cancel rawReader）；泵退出统一 `void rawReader.cancel()`。安全方向不变（拒绝与转发语义不受影响），纯资源寿命缺陷。
- 观察 O-2：#extractGrant 对非法 Basic base64 抛错→#handle 502（应 401/403 类）；`bearer !== internalToken`（gateway :919）非常数时间比较。

### 2.4 C2 端到端生命周期（组 4）
- **stop 先撤坐实（H3 后半）**：Session.stop 首行置 !alive→`#revokeGitGrantOnce()`（session.ts:281-286）在 `await this.#starting` 前；幂等单飞（:291-297）失败不置位可重试；#dispose 内 try+errors 收集（:302-306）；close()/revokePrincipal 内存先撤全再一次 save（server.ts:518-533/:525-536/:529-534）；close 尾部重抛 grantSaveErr（:664-666）；恢复整批丢弃+epoch 轮换 fail-closed（:311-353，H7 坐实）。
- **H4 坐实**：Session ctor 初始 aclVersion（session.ts:52），setAclVersion 同值直接 return（:137-140），真实 bump 才触发；gateway attach 无条件 setAclVersion 已不存在（:780-790 attach 路径无调用）。
- **R-Q52-2（required）**：logout 以 cookie sid（BrowserSessions UUID 空间）查 `#gitGrantActive.has(sid)`（server.ts:1076-1080），而登记键=**agent sessionId**（:477 `set(sessionId,…)`；:817 签发用 `sessionId=requested??randomUUID()`，与 `#browser.create` 的 cookie id 不同源）——两 UUID 空间几乎恒不相交，**logout 实际不吊销 git grant**（除病态同串），grant 存活至 TTL≤15min，违反合同 C2"logout→≤5s 有界失效"。R51 doc"按服务端 sid 登记定位"与遗留 d"单 sid 粒度正确"评论**不成立，不接受**。最小修：签发时把发起连接的可信 `identity.sid`（conn.sid，来自 cookie 验证路径 :1383-1389）记入 grant entry（或反向索引 browserSid→sessionIds），logout 按 mapping 撤全部相关 entry；不读 client 自报 actor 头。
- **R-Q52-5（required）**：revokePrincipal 中 `#revokeGitGrantPrincipal` 无 try（:1504）——save 失败 throw 中断后续 `#revoked.add/#saveRevocations/browser.revokePrincipal/conn 关闭/expirePending`（:1505-1519），形成"git 已撤、principal 未吊销、连接仍活"混合态；close() 有 grantSaveErr 收敛先例（:630-634/:664-666），最小修=同缝 try/收集（或先 add #revoked 再撤 grant），失败审计不装成功。
- **R-Q52-6（required-minor）**：Session.stop 的 `#revokeGitGrantOnce()` 未包 try（:285）——save 失败 throw 直接逃出 stop，`await starting/#cleanup` 全跳过；#reap 已先 `#sessions.delete`（:692），重试入口消失→**沙箱泄漏**。最小修：stop 内 try/审计后继续（#dispose 已重试并收集）。
- 观察 O-3：onAclChanged 先改 entry.aclVersion 随即整条删除（:844-848 死存赋值）；bump 后无重签，会话 git 面直至会话重建不可用（fail-closed 方向、可用性代价，如实记录）。

### 2.5 renew 真续签（组 5）
- **链路坐实**：`#mintGrant` scope 与初签同源（repo→allowPush 镜像→writeRefs，:453-472，renew 不扩权）；新 jti（:472）；旧 jtis 全进 revoked（:608-610）；persist 先于投递（:611 save→:613 writeGitCredentialConfig）；投递失败回滚旧集+撤新 jti+重 persist、再败审计"磁盘状态 unknown"（:614-623，全程同步段无复活窗口）；writeGitCredentialConfig 仅写 HOME/.gitconfig（0600 tmp+rename，sandbox-config.ts:58-83），不重删 .pi、start 不覆写新 token（start 一次性 memoized）；mount=同目录 rename 对 bind 目录可见（如实，无需 backend 改动）。专有 renew timer 可注入、缺省 setTimeout、unref（:566-572）；demo 10min（demo.ts:181）；死会话/吊销 principal 不续（:598-602）。
- **R-Q52-3（required；遗留 c 坐实升级）**：`#mintGrant` 续签时**重新**调 `#principalExpiresAt(principal)`（:459），无在途连接→返回 null→exp=now+15min——mint 时已存 `entry.maxExpAt`（:479）**全文件零读取**（grep 坐实）。断线重连窗口内活会话可把 authority 无限续下去，principal 凭证早已过期也照样续。最小修：`const cap = principalExpiresAt ?? entry.maxExpAt; exp = cap ? min(now+15m, cap) : (续签路径拒绝或维持 captured cap)`——离线续签只能沿用最后可信有效期；过期即不续。
- **R-Q52-4（required）**：`GatewayConfig.gitGrants` 接口未声明 `renewIntervalMs/timerImpl`（:80-90），而 :555/:571 裸读——**当前字节静态无法通过类型检查**（tsc 状态 unknown 官方口径下，这是源级断言：字段不存在于类型）。语义上代码=gitGrants 配置即**必须**提供 renewIntervalMs（缺省抛 :556-559）——R51 doc"配置才启用"措辞与代码不符：生产**不能**静默只活 15min（fail-closed 达成），但 doc/接口必须对齐。最小修：接口补两字段（timerImpl 可选）+ doc 更正一句；下游 wiring.test :252 正控补 `renewIntervalMs`（同为 R-Q52-4 修后面才可绿）。
- **余量缺口（required-minor，随 R-Q52-3 同修）**：interval 无"早于 exp 到期"的 margin（:559 仅 ≤15min 上限）；interval=15min 时第一 tick 恰在 exp 边界、短 principalExpiry 时 grant 在两 tick 间已死（mint `exp<=now` 抛→每 tick 审计报错、entry 僵存）。最小修：调度间隔=min(interval, TTL/2, maxExpAt 余量) 或 fire 时以 `exp-安全余量` 判定。
- 观察 O-4：gitGrants 配了而 wiring 缺 gitProxyUrl 时 renew 投递为空操作（sandbox-config :61 提前 return）而登记已轮换——错配形态 git 首轮 renew 后即死（fail-closed；建议 ctor 互斥校验，一行）。
- 多节点 HOME/客户 KMS/在途已发上游副作用不可回滚——维持 external/如实边界（R51 口径沿用）；本机单网关触发面除上列项外完整。

### 2.6 registry 拉取（组 6）——pass＋观察
- **R-Q50-8 坐实**：`REGISTRY_MAX_AUTH_AGE_MS=5000` 独立常量（:78，prod）/dev 30s 不进 allow（:160-162）；age 锚=每轮 pull 起始 mono（:174），晚到 `age>maxAge` 不发布不重锚、250ms 重试（:177-183）；正常调度 maxAge-1000=4s（:170）；wall 仅 grant exp（#now），mono 仅 age（:110-111/#snapshotFresh :240-243）；零窗直拒；closed/loop 守卫（:169/:197-199；close 清 timer+closeAllConnections :262-267）。每 fetch 预算 2000ms 经可注入 `signalTimeoutImpl`、缺省才 AbortSignal.timeout（:118/:125，R-Q50-12 口径达成）；body 流式 1MiB 上限超限即 cancel（:222-231）；production 拒 query（:206-209）；redirect:error（:212）。
- 观察 O-5：快照形状校验漏洞——`typeof parsed.activeSessions!=="object"` 放过 **null**（:226-228），entry 形状（principal/tenant/repo/aclVersion 类型）与 revokedJtis 元素类型不验：null/坏 entry 后续 `snap.activeSessions[claims.session]`/`registered.principal` 抛 TypeError→每请求 502（fail-closed、无权威污染，但拒绝类别错且 DoS 面）。最小修：形状校验收紧（null 拒、entry 逐字段类型、元素 string）。O-6：close 时在途 pull 完成后仍会写 #snapshot（tick 无 #closed 复查 :177-184）——http 已关无消费面，无害，一行守卫可选。

### 2.7 audit/privacy/授权后重验（组 7）——pass＋观察
- 坐实：audit identity 四字段全取已验 claims（:664-676），未知 repo/未验形态→`unverified`（:322-324+claims null 分支），team=claims.tenant；deny summary 全固定类别（含 GrantError.reason 固定串）；#handle 固定公开类别不回 String(err)（:267-275）；响应管道 error 收束（:516-522）；`#revalidateBeforeFetch` 六轴重验（:527-540：freshness/exp/epoch/jti/session/principal+acl），过窗不 fetch、post-auth 失败不重试、副作用 unknown 注释如实（:461-470）。
- 观察 O-7：res 'error' 监听仅在管道段（:520）挂——deny/401/413 路径在挂监听前写已断开连接的 res，Node 版本相关崩溃风险；最小加固=#handle 入口一次性 `res.on("error",()=>{})`。O-8：重验少 tenant/repo 两轴（登记侧不变量支撑，风险低）；read 路径 deny 记 kind git.push（既有约定，沿用不升级）。

## 3. receive-pack 手推 trace（零运行，字节级）

- **trace1（单 chunk：命令+flush+pack 同 chunk）**：chunk=`0066`+`0×40 1×40 refs/heads/main\n`(98B)+`0000`+`PACK…`(200B)。scanner：len=0x0066=102→headerLen=102；lenHex@102=`0000`→headerLen=106、done、pending=整块 306B。parsePktCommands ok（1 命令）。转发=prefix 106B + **src.read() 从下一 wire chunk 起**——chunk[106..306) 的 200B pack 头部**丢失**（R-Q52-1 坐实；现有 unit 仅断言 header 排除后缀，server 层无等价用例）。
- **trace2（逐字节跨 chunk、flush 恰在 chunk 边界末）**：headerLen 经 pending 拼接逐 4B/载荷推进，flush 在 chunk 末→suffix 空；pack 全部在后续 chunk→转发=prefix+全部后续 chunk==原流，**无丢失**。缺陷边界=且仅=flush 后同 chunk 残余。
- **trace3（小 header+同 chunk PACK>64KiB）**：flush 先命中→done 提前 return，cap 检查（:66-70）不执行→**pack 不计入 64KiB、不误 413**（R50 指认项在当前码已正确）；但 chunk 内 flush 后的 >64KiB pack 段同样丢尾（同 R-Q52-1）。
- gzip 侧同构：src=解压侧 reader，解压流中 flush 后同 chunk 残余同丢。三态上游效应：空 pack（"the remote end hung up/unpack 失败"类）或坏 pack 拒收——授权判定本身不受影响（只依赖 header），故无越权，纯主路径功能毁伤。

## 4. 新 required 清单（交原 Pi 最小修；全部附最小因果修法）

- **R-Q52-1**（receive-pack 转发丢同 chunk pack 尾）：§2.3 修法+§3 trace；同缝补 server 级 forwarding-equivalence unit。
- **R-Q52-2**（logout 键空间错位→git grant 实际不吊销）：§2.4；修后必须配"cookie sid→agent sessionId 映射撤销"unit。
- **R-Q52-3**（renew 漏用 maxExpAt→离线永续）：§2.5；配"无在途 conn 时 exp 沿用 captured、到期不续"unit。
- **R-Q52-4**（接口零声明+doc 措辞+wiring 正控红）：§2.5；接口两字段+doc 一句+wiring :252 补参。
- **R-Q52-5**（revokePrincipal 吊销链中断）：§2.4；try/收集或先 #revoked 后 grant。
- **R-Q52-6**（Session.stop 撤销失败跳清理→泄漏）：§2.4；try/审计后续跑。
- **R-Q52-7**（gzip 泵 drain 悬挂泄漏）：§2.3；drain/close 竞速+退出 cancel rawReader。
- **R-Q52-8**（测试静态红）R47-12 postTermObs 断言=0 与源调度序矛盾（TERM 后、失败派发前 grace 首轮观察合法发生 1 次，test :449-456 计数起点=termSeen 而非 containArmed；runner :366-380 顺序）：改按 containArmed 后计数（post-contain=0 可达且语义正确），或把失败事件改为首轮观察前同步注入；**不得**为此改 runner 停链逻辑。
- **R-Q52-9**（测试静态红）git-grants.test.ts:110 期望 `caps.writeRefs 非法` ≠ grants.ts:104 实际 `caps.writeRefs 非法（固定类别，不透传原文）`：对齐期望串（或断言 startsWith 固定前缀+不含原文）。
- 观察 O-1..O-8（§2.2/2.3/2.4/2.5/2.6/2.7）不强制本轮，随缝顺修；O-5 建议与 R-Q52-1 同批（同类输入校验面）。

## 5. 下一轮执行准入预审（逐文件 ready/not-ready；本审零执行、不"静态通过先试一次"）

| 文件 | 判定 | 依据（顶层行为实测自 imports+构造路径） |
|---|---|---|
| tests/credential-domains.test.ts | **READY（纯 unit）** | imports=assert/crypto/test+credential-domains.ts（零依赖外部模块）；零 FS/timer/net/child/长 await；randomBytes 为进程内 crypto |
| tests/gitproxy-receive-pack.test.ts | **READY（纯 unit）**＋覆盖缺口 | imports=assert/test+receive-pack.ts→grants.ts→node:crypto；零资源；**但 suite 不含 server 转发等价（R-Q52-1 缺口），绿≠主路径对**——须随修新增最小同缝 unit，勿以现 suite 绿宣称 H2 闭 |
| tests/bounded-runner-r47-cases.test.ts | **READY（仅限 coor 单一根 9s watchdog+末 fresh wall+真实 parent wait 协议）** | 全 deps 注入零真实等待；文件级唯一真实 timer=根 watchdog（:20-24）+process.exit(124)+after() real-elapsed 断言；**先修 R-Q52-8 否则红**；旧 runner.test(900ms 实例)不在本批 |
| tests/git-grants.test.ts | **NOT ready（先修 R-Q52-9）** | 除 :110 静态红外全 pure（production 抛错构造不启 timer；dev 无 registry 不 poll；close 幂等）——修后升 READY |
| tests/wiring.test.ts | **NOT ready** | B2 块构造级含 Native reaper/renew timer+FS（:239-241 自标），且 :252 静态红（R-Q52-4）；其余=spawn/listen/WS/poll 真实进程面 |
| tests/gitproxy.test.ts | **NOT ready（真实 HTTP integration 面）** | proxy.listen+真实 fetch+记录上游 listen+AuditLog FS+**production ctor 真实 4s polling timer**；旧 3 integration 断言原样（哈希=R49 值未变） |
| tests/git-e2e.test.ts | **NOT ready** | 真实 git 二进制+fixture spawn 上游；17/P1 维持 pending |
| tests/git-grants-integration.test.ts | **NOT ready（未授权标记维持）** | listen+fetch 回环×4；构造含真实 polling timer |

- 缺口指认（非用 helper 绿补齐生产接线）：cache/renew/真实 gzip push 形态/真实 HTTP17 无任何 ready 面覆盖——renew 的纯 fake unit（R-Q52-3/4 修后）与 receive-pack 转发 unit（R-Q52-1 修后）是下批**最小有因果力**新增点；不再发框架式抽象。coor 另审预挂脚本后，先批顺序建议：credential-domains → receive-pack(+新转发 unit) → git-grants(修后) → r47cases(watchdog 协议)。

## 6. 执行偏差与元证据

- 本轮零执行达成；全部命令=read/hash/stat/cmp/find/sed-查看/grep/wc/cat/printf-ledger 追加/orca 编排；无 Node/Python/编译/网络/信号/定时器/旧 helper 复跑；无 rm/delete；R51/R50/R49/R47 根只读未触；modelgw 两件零内容读。
- 元信息补正（msg_65eb4fd0696f，交付前读全后 exact ack delivery_b41728c57983、drain 0）：generation=3/runtime 换 id 为观测事实，已按 §头记录；源审与 (c) 静态零执行范围不变，不为 meta 单开一轮。根内 a03 记录的是本文件**补正前** digest（邮件到达时根已 seal）；最终 digest 只记 worker_done，本文件不含自身 hash。
- a02 清单生成于 a01 之后故含 a01/a02 自身两行（如实，非快照遗漏）；其余路径清单以 a04-delivery-paths.csv 为准（manifest 前落定）。root seal 后零改动；manifest selfdigest 只记 worker_done。本报告不含自身 hash（其 sha256 记 worker_done 与根内 a03）。
- R51 根 manifest mode 644（其 doc 未声明 manifest mode，如实记录不作指控）；R50 根无自身 ledger（erratum #4 sight-check 坐实）。旧证据（2967ms/13/13/12/12/615/598/11fail/1cancel/5skip/5701958ms/serial 未跑/Docker 非唯一根因/G1/G3/54m57s/4818 unknown）一律不升级、不复制为本轮绿。

## 7. 结论与状态

- **source-pass**：§2.1 runner 全项、§2.2 H1/caps.read/运行时校验、§2.3 scanner/parser/gzip 单流/拒绝收束/content-length 裁决、§2.4 stop 先撤/H4/bulk 语义/整批丢弃、§2.5 renew 链主体、§2.6 R-Q50-8 全项、§2.7 audit/重验主体。
- **required**：R-Q52-1…7（源）+R-Q52-8/9（测试红）；**B2=partial**（源实现进度，非 17 项验收）；17 项/P1/真实 gzip push/demo 双进程全 pending；S2 partial；S3–S6 pending、S7 gated；mTLS/KMS/上游保护/IdP/CNI/DPA/WORM/soak/B12 external 不 mock 不升级。
- 执行权只能由 coor 另审实际脚本授予；本审零执行 ✓。下一原 Pi 批以 §4 最小修为唯一范围（R-Q52-1/2/3/4 为因果主链，5/6/7 为寿命/一致性链，8/9 为测试对齐），修后凭本根 snapshot 做增量复审。
