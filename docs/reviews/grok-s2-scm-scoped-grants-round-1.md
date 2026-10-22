# grok-s2-scm-scoped-grants-round-1.md — Pi R49 B2 源实现静态独审（Grok R50；task_129aa0f9ebb8 / ctx_7d7adcf6a373）

- 日期：2026-10-19；审者：Grok（唯一 independent reviewer，原 terminal gen1/model）。被审对象：Pi task_0627e059e536（R49，docs/implementation/s2-b2-scoped-grants-r49.md）+ runner 收口；对照=SCM 合同（docs/reviews/s2-scm-scoped-grant-contract.md）与 R48 报告。被审 Pi 根（只读）：/tmp/pi-r49-crECyYHb（初 seal，self 92764c5e…，8 files ✓ 与 doc §0 一致）与 /tmp/pi-r49-cont-ehtl3wFL（**延续根未封版**：仅 prov-r49-cont.jsonl 3 行，无 manifest——doc 未记其 self digest，本审核实）。
- **性质：静态 only**——零测试/编译/脚本/HTTP/socket/child/ps/signal/Docker/Git/demo/真实 timer 执行；metadata read/stat/hash/copy 允许且已用于 snapshot。
- **判定：request_changes。** B2 §A/§B/§C 源实现主体**静态坐实**（epoch+aclVersion 全链、own-pair 全 RULES 同尺的 grant crypto、production 三抛、registry 严格拉取、receive-pack identity 路径、生命周期先撤后清、audit claims-only）；但存在 7 项 required（R-Q50-1…7，R-Q50-8 为稳定性 required）+4 项观察（R-Q50-9…12）。**B2=partial**（源实现主体就绪≠全部 §A/B/C 闭合；17 项真实验收未授权全 pending）。
- 本轮唯一 repo 写入=本文件。reviewer 私有根=/tmp/grok-r50-o2iY2JRB（0700 mktemp nonce）：snapshot/ 19 件被审文件**实际字节副本**（含 dirty，非 HEAD；与当前工作区二次比较零漂移）、frozen/snapshot 核验脚本+结果、gates-adjudication.md、两份 pi-r49 ledger 拷贝、一次性 manifest（25 entries；self-digest `3f2f6ed01920f1e385f0f350076b7664eb409681cb4255e3df0dd1a86c034a30` 只记于本文件与 worker_done，manifest 后根零改动）。**偏差（本轮）**：核验 delivery_516e2c30fced（msg_6d3e501b38b3 重投）时先 ack 后完整读取——经 `check --all` 恢复全文核对，内容（C 撤回/poll-age 升级）已先行全部纳入报告，无信息损失；次序教训在档。除此之外零根外写、零 rm、零删除。R48 自报的 /tmp/r47-actual、r47-listed 已删不可恢复偏差保持，本轮未重犯。R48 自报的 /tmp/r47-actual、r47-listed 已删不可恢复偏差保持；本轮无根外写、无 rm。

## 1. 冻结与 snapshot

17 件 coor 冻结 SHA 全符（snapshot 双比较零漂移）：runner 2e3c81d3✓、grants 33a58a23✓、gitproxy-server 5e7e211f✓、gateway-server 0112cdcb✓、session e0e46a2e✓、sandbox-config a67d1101✓、demo d9b4bcdd✓、r47cases 7550fe36✓、git-grants.test cee50a8f✓、git-grants-integration 20c534fa✓、gitproxy.test 0d6de811✓、git-e2e bb103146✓、wiring 3fcd94c6✓、R49doc 05744e16✓、progress dfbfad7f✓、secrets 0725c4ae✓（仅 hash，不宣称 HTTP 验证）、modelserver a8877f96✓。另 snapshot 含 R48 报告/SCM 合同两件参照。R47 轮末 runner/r47cases 原字节不可恢复（Pi 自报 unknown，本审不 HEAD 替代）✓ 口径一致。

## 2. runner 最高优先余门 → R-Q50-1（required）

**进步认可**：`CleanupOptions.failure` 谓词已入接口（runner:255）并在全部要求点位接线（:304/:320/:325/:333/:339/:358/:380/:383/:389/:396/:398/:412/:417/:422/:431）；调用点传 `failure: () => failureBox.failed`（:699）；R47-12 断言 0 KILL/TERM 恰 1——**"failure 后不发枪"目标达成**；R46 已闭项（timers-finally/临枪 identity 后 budget/绝对 deadline/负 async contain）未回退，本审确认。**R-Q47-B 已闭合**：t0=:506 先于 runId(:510)/randomBytes/join(:516)（command 形状检查 :448-450 为纯参数校验可前置）。
**残留（coor 读 :300-405 属实，行号=当前 2e3c81d3 字节）**：所有 `if (failed())` 分支在判定后仍调用 onLog 写"shared failure 置位…"（:304-306/:320-323/:325-328/:333-336/:339-341/:398-402/:412-415/:422-425 及合并条件 :358-361/:417-419/:431-434）——failure 谓词的存在理由恰是证据通道可能已损，**判定后的 onLog 仍是后续 fallible IO**（慢则拖穿预算、抛则提前逃逸 cleanup catch）。终点收敛（不 KILL、unproven）不等于 A 门闭合。
**最小修**：全部 failed() 分支改裸 `return failReturn()`（零 onLog）；合并条件 :358/:417/:431 把 failed 拆为独立裸返回分支（remaining/exit 分支保留日志——其通道未损）。**R47-12 收紧**：失败置位后 loggerCalls/psCalls/signals 全 0（TERM=1 单列）、finalizeIO=0、escapes=0、双 timer 独立清、非零 reject——现测 `postTermObs ≤ 6` 的宽容断言作废。realguard 同幅边界保持 ✓；"受信 hook 纯极端"与生产 IO 边界分开表述 ✓。

## 3. B2 逐项源 trace（新 finding R-Q50-1…12；行号=当前冻结字节）

### 3.1 认证缓存年龄（合同 caveat 1）
- ✓ 静态闭合：`#mono=performance.now`（gitproxy-server:105-108）、`#snapshotAtMono=-Infinity` 初值、prod `maxStale=max(1,pollMs)≤5s` 构造期锁（:123-125）、dev 30s 仅低保障；`#snapshotFresh`（:199-202）；零窗直拒。
- **R-Q50-8（required-稳定性）**：snapshot age 锚=pull 完成时点（:141-142）且 prod `maxStale=pollMs`（:123-125）——poll 完成→再等 pollMs→下次 fetch（dt>0），age=pollMs 时**每轮必有 age>maxStale 的授权空窗**（窗长=单次 fetch 时长）；doc §7.b"缩 pollMs 留抖动余量"不成立（缩 poll 同缩 age，不造余量）。修=三者解耦：`maxAuthAge ≤ 5000` 独立配置/常量、age 用**请求起始** mono 锚（:141-142 改 fetch 前）、下次 poll 调度早于 age 到期（或 poll 完成立即排下一拍）。
- `AbortSignal.timeout(pollMs)`（:175）=真实不可注入原生 timer → R-Q50-12（观察）：unit 不得自称全 fake（doc §6 已部分披露，测试注释须同级口径）；body reader 字节界+cancel ✓（:180-189）；production registry url 拒 query ✓（:167-170）；internal bearer 仅 header ✓。不要求新 TLS infra；endpoint 内网 bind/Host 假设归部署面（未声称）✓。

### 3.2 epoch/renew/生命周期（合同 §3.6/A6）
- ✓ 静态闭合：claims.epoch/aclVersion 全链（grants:44-49/:90-93 → gateway 签发 :419-427 → registry 快照 :462-468 → 代理比对 :310-334）；`#gitGrantEpoch=randomUUID()`（gateway:195）重启新→旧 grant 必拒；**dispose 首步 onDisposed**（session.ts:278-280，先于 audit/host.abort）→ #revokeGitGrantSession（gateway:678）；setAclVersion→onAclChanged（session:133→gateway:682）；logout/revokePrincipal→#revokeGitGrantPrincipal（gateway:1335）；close 先撤全（gateway:477）。
- **R-Q50-3（required）renew 链缺失**：`#issueGitGrant` 仅会话创建时调用（gateway:653）；`#revokeJti`（gateway:439）**零调用者**（死代码）；TTL 15min 后活会话 git 操作全 403，无任何刷新路径——sandbox-config 零改（SHA 冻结印证）意味着沙箱 .gitconfig 内 grant 串静态，**"renew=新签发+旧 jti 撤销"仅有定义无触发/投递**。最小方向（下轮二选一并如实措辞）：①会话活动触发重签+registry jti 轮换+沙箱 HOME .gitconfig 原子重写（0600 tmp+rename，与既有 HOME 同域）；②如实把 TTL 定为会话级硬上限并文档化 403 行为。禁止以"已实现 renew"措辞交付。
- **R-Q50-7（required-doc）**：doc §3"TTL 单调锚=签发方 Date.now()…单调锚"措辞错（Date.now 是 wall，跨进程 exp 语义正确但非单调；跳变影响 ≤15min 窗口可接受，措辞须改）；doc §2"重启恢复 active/revoked"**未实现**（gateway 无 git-registry load 路径；安全由 epoch 轮换兜底 fail-closed，但"恢复"表述与代码不符）；cont 根未封版（§"0700+0600 ledger"属实但无 manifest）。

### 3.3 crypto/schema（合同 §A）
- ✓ 静态闭合：masterKey≥32B（grants:123-129）；签发/验证同一 validateClaims 同尺（:78-124）；HMAC 域分隔（:72-75）+timingSafeEqual（:159-162）；payload≤8KiB/token≤16KiC；readRefs 出现即抛（:84-88）；TTL 签发端锁死（:106-111）；exp=ms epoch 明确；writeRefs `refs/` 前缀+write=true 非空/write=false 禁带（:97-103）；Bearer 诚实非 PoP（头注 :5-15）✓；claims 字段 tenant/principal/session/repo/jti 长度界 ✓；客户端 x-perimeter-* 头零进入授权/审计 ✓（#audit :645-656 仅 claims；#route 无该头读取）。
- **R-Q50-2（required）caps.read 未按操作强制**：#route 只有 `isPush && claims.caps.write!==true`（gitproxy:371-375）；upload-pack/info-refs 路径**无 caps.read 检查**——`read:false` 的 grant 可正常 clone/fetch（签发端恒 read:true :419，但验证端必须独立强制，否则签名位纯装饰）。最小修：读操作前 `!claims.caps.read → 403`+同缝负控。
- **R-Q50-5（required）互异校验 hex 形态**：gateway:288-296 把 masterKey 转 **hex 字符串**后与各 token 做 `===`——字节级相同但编码不同的碰撞（如 gitProxyToken 恰为 key 原字节）漏检。最小修：`Buffer.compare(Buffer.from(t), keyBytes)` 逐字节。
- 配置拒：readRefs/不支持 mode/缺 registry/legacy/pollMs>5s 构造期全抛（gitproxy:119-126 + grants:84-88）✓；R-Q50-9（观察）：`isValidRefname`（grants:193-198）缺 `~^:?*[\`/`@{` 规则——receive-pack 解析器行内补齐（server:583）故写面有效，但 helper 与 doc §7#5"已加"声称不符且校验分散，建议收敛进 helper。

### 3.4 receive-pack 命令区 parser（合同 §B6——最关键生产门）
- ✓ identity 路径静态闭合：pkt 长度字段边界定位 flush（:507-523，全零 OID 不误判）；命令区缓冲 ≤64KiB **不含 pack**（:527-531）；web reader 续读（不 for-await break destroy，:536/:630-638）；pull 式背压（:618-628 系）；首条 `\0` caps/非首条禁 NUL（:568-571）；fatal UTF-8（:571）；重复 ref 403（:586-587）；SHA-1 值域（:588）；writeRefs glob 全匹配（:593-597）；空命令区/语法错全拒上游 0；同 chunk flush 余字节保留（scanned 回退 3 字节 :535 + flush 后 reader 续用）。
- **R-Q50-4（required）gzip 路径双重数学错误**：①`scanFlush` 在**压缩字节**上按 pkt 边界推进（:497-523）——gzip 包裹整个 HTTP body，压缩流中不存在可定位的 pkt 边界（coor 判断属实；doc §7#4"在原始字节按 pkt 边界完成"与代码同错）；②命令区经 `inflateBounded(rawCmd)` 独立解压（:546-551）后，余包用**新建 createInflate** 从压缩流中段续吹（:602-620）——单一 deflate 流被两个无状态实例分段解压→**转发上游的 pack 字节为损坏数据**（授权后写，上游必拒）。净效应：gzip receive-pack 恒 fail-closed（伪 413/403/400）或向已授权上游写坏包。修法=coor 处方：整个 body 经**单一 createGunzip 连续流**→解压后按 pkt 边界定位 flush/读命令区→前缀+剩余解压字节 identity 单次上游；无需对已剥 encoding 的上游再 deflate；不待真实 git 才修数学。非 gzip 路径与"整包不缓冲"保持 ✓；chunk 分割/大 pack 不误拒（identity 路径）✓；授权后流失败副作用 unknown 的措辞在 doc §7.c 如实 ✓。

### 3.5 HTTP 字段与 privacy（合同 §B1/B3/B8）
- ✓ 静态闭合：raw url 先查 `..`/`//`（:247-254）后 new URL、`%` 在 parsePath 后拒（:262-266）、allowlist 全等（:269-275）；service getAll 重复 400（:346-349）；info/refs 无/未知 service 400（:350-355）；ctype×method×endpoint 三方一致（:356-366）；git-protocol 单值 version=1|2 透传否则丢（:384-387）；redirect:error+3xx→502+deny（:437-443）；POST 补 content-type（gzip→receive request ctype）与 accept（:397-406，R48 WIP 漏项已补）；#handle 固定公开类别（:229-233，不 String(err) 反射）；audit identity/repo 全部 trusted（claims+allowlist 名），deny summary 固定类别（GrantError.reason 均为固定串）✓；badgrant/未知 repo 不回 raw 路径/token 形态 ✓。
- push 三门：allowPush×caps.write/writeRefs×四眼审批（proxy 不判 force、不虚称 HTTP↔审批绑定，注释 :86-89 如实）✓；上游保护 external 保持 ✓。

## 4. 执行偏差与元证据（本轮不为元问题开专轮）

- 预审前执行（R49 doc §6 自披）：tsc≈8、runner cases×11（末次 13/13）、causal×3（末次 13/13）、typecheck-root×1（2967ms）；coor msg_7693a49ccd42 裁 (c) 全部不批新增执行、delivery_d8309f308de3 ack0 ✓；msg_8151a2d0db4c 六硬门处置见 doc §7（本审逐项核：#1/#2/#5/#6 落实、#3/#4 identity 路径落实而 gzip 路径 R-Q50-4 未闭）。
- **禁令后仍有 tsc×2**（cont ledger entry3①"记越权"）+ done"后续零执行（含编译验证2次越权也记档）"自相矛盾之"零"字措辞——以 ledger 为准。
- **R-Q50-6（required）**：doc §5"（tsc 0 error 全项目）"无当前字节支撑——初根 ledger"最终 exit0"系**末次 2 错修复前**（doc §7.a 自认"修复后未再编译验证=unknown"）；2967ms 数字在 r49 根内无落盘证据（caller stdout 捕获），且与 R47 同值，出处不可证。下轮 doc 更正为"typecheck 状态 unknown（末次编译先于末次修复）"。**另 doc §1 R-Q45-4 完成声明"arm/clear 失败由 null sentinel 改为布尔标志（armFailed/clearFailed）"与源码不符**（现行 runner:539/:542/:545/:550-552 仍为 null sentinel + `??=` + `!== null`；coor msg_6d3e501b38b3 已撤回早前采信）——C 保持观察项（受信 hook `throw null` 边界），doc 完成声明更正为"未改"。
- R49 filesModified 未含 r47cases（7550fe36≠R47 冻结 9d0585ec，确经修改）/两新根等——真实 footprint 以本报告 §1 snapshot 清单为准，不认 13 文件穷尽。
- R45 十三控 native 10/20ms 协调残余已在 R45 causal 头注降格（不捏全 fake）✓；root124/父 shell wait 沿 unknown ✓。

## 5. 结论与后续

- **required（交原 Pi，下一轮最小修）**：R-Q50-1（runner failed() 分支裸返回+R47-12 收紧）、R-Q50-2（caps.read 操作强制）、R-Q50-3（renew 链实现或如实降格 TTL 语义）、R-Q50-4（gzip 单一 createGunzip 重写 receive-pack 路径）、R-Q50-5（互异校验 Buffer.compare）、R-Q50-6/7（doc typecheck/恢复/单调/§1 布尔标志声明更正）、R-Q50-8（maxAuthAge 与 pollMs 解耦+请求起始锚+调度早于到期，稳定性 required）。
- **观察**：R-Q50-9/10/11/12（refname helper 收敛、测试纯度措辞、acl 撤销失败审计、AbortSignal 口径）。
- B2 状态=**partial（源实现主体就绪 + 上列 required）**；17 项真实验收未授权全 pending；外部件（mTLS/KMS/上游保护/IdP/CNI/DPA/WORM/soak）external 原样。S2 partial；B2 partial；S3–S6 pending、S7 gated；G1/G3/54m57s/4818 unknown 原样；615/598/11fail(=four-eyes4+protected-paths7)/enterprise-s1 1cancel/5skip/5701958ms vs 1500000 冲突/serial 未跑/Docker 非唯一根因——全部不升级。
- 执行权以后只能 coor 另审实际脚本；本审零执行 ✓。下轮 Pi 修 R-Q50-1…7 后，凭本根 snapshot 基线做增量复审，再续真实验收授权评审。
