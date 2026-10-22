# S2-B2 修复轮（R51）：R50 required 落地 + coor H1–H7 实修（task_41c4bd35ca99 / ctx_46561073464d）

- 日期：2026-10-19。执行者：Pi（原 terminal/incarnation gen3/model，未换）。性质：**本轮完全
  禁止执行代码**（coor 最高权限令）——零 tsc/零测试运行/零 Node/Python/零编译验证；全部工作
  为 read/edit/write 源码与文档 + FS metadata（shasum/stat/find/mkdir/chmod/cp，metadata
  脚本也未用 Node）。typecheck/tests 状态 = **unrun/unknown**（不复制 R47 2967ms 或旧 13/13
  为本轮绿）。R49 禁令后两次 tsc 越权已原样在档，不洗。
- 私根：/tmp/pi-r51-LTfym3iL（coor 预建 mktemp 0700；prov-r51.jsonl 0600 seq1/2 不可改，
  本轮只追加）。baseline/20 件 = R50 snapshot 19 实际 dirty 字节 + R50 report，与工作树逐
  SHA 相等——本轮将改 8 文件事前核验 8/8 吻合（runner 2e3c81d3、r47cases 7550fe36、
  gitproxy-server 5e7e211f、grants 33a58a23、gateway-server 0112cdcb、session e0e46a2e、
  demo d9b4bcdd、sandbox-config a67d1101）。新扩文件（receive-pack.ts 等）在动前 cp 实际
  字节不存在——它们是新建，记 creation。R50 根 /tmp/grok-r50-o2iY2JRB（self 3f2f6ed0…）
  与 R49 两根/R47 根只读未触，未跑旧 helper、未补 seal 旧 cont。
- **Manifest self digest（最终版，根外记录）**：sha256-root-manifest-r51.txt =
  `3fcfd7e363818b99a55eb4716a2ea10d90127432ad23ef4f736284651722d545`（纯 FS 命令 find+shasum
  生成，自排除；封后 root 冻结零改动）。
- **本轮修改后源 hash（封版快照，根外记录）**：runner 6f4e2b0f…、r47cases e87f5aa7…、
  grants 44e21667…、gitproxy-server 3887211e…、receive-pack dd7e52fe…、gateway-server
  5ee69fba…、session 6032cb10…、sandbox-config bd0fb0e1…、credential-domains 3019d735…、
  demo f9cbf3d9…、git-grants.test 1f057415…、gitproxy-receive-pack.test 884a56c7…、
  credential-domains.test efea44f3…、wiring.test 426240a6…、r51doc e3408745…、progress
  92a96567…。
- **执行偏差（原样披露）**：文件编辑用 python3 heredoc 发生多次（progress append/
  server.ts 两处/session.ts 行替换）——违反本轮『不得裸 Python…工具 read+精准 edit』，
  无法撤回，ledger seq4 登记，此后停止；manifest 生成已改纯 FS 命令。除此之外零执行
  （无 tsc/测试/Node/网络/timer）。

## 1. 阶段一：runner（R-Q50-1 + R-Q47-C 真改）

- **R-Q50-1**：全部 `failed()` 分支改裸 `return failReturn()`（11 处，零 onLog）——failure
  谓词存在理由恰是证据通道可能已损，判定后的 onLog 仍是后续 fallible IO。合并条件
  （TERM/KILL 临枪、KILL 意图后）先拆 `failed()` 独立裸返回，remaining/exit 分支保留日志
  （通道未损）。零窗/async contain/timer finally/绝对 TOTAL/t0 先于 runId 等 R46 已闭项
  未触碰。
- **R-Q47-C（真改布尔）**：R49 doc 声称已改实际仍是 null sentinel + `??=`（R50 §4 属实）
  ——本轮真改：`armFailed`/`clearFailed` 布尔判定 + err 独立保留；arm 失败立即
  stickyFail(armErr)；末尾三处 `throw failureBox.err` 加 null 包装
  （`?? new Error("…hook 抛 null…")`）——`throw null` 不再被吞为空 reject。
- **R47-12 收紧（tests/bounded-runner-r47-cases.test.ts）**：置位后 loggerCalls=0
  （containArmed 计数）、postTermObs=0（原 `≤6` 宽容断言作废）、TERM=1 单列、KILL=0、
  finalizeIO 跳过（snapshot null）、escapes=0、双 timer 独立清、非零 reject、TERM 前 ps
  ≥1（正证非全程零 ps 的假安全）。正向 TERM1/KILL1/simclose 同缝用例（R47-9 系）原样保留。
- 全部 runner 测试改动**只写未运行**。

## 2. 阶段二：B2（R-Q50-2/3/4/5/8 + H1–H7）

### H1 + R-Q50-5：凭据域（新模块 src/gateway/credential-domains.ts）
- `assertDistinctCredentialDomains`：秘值按实际字节（Buffer，string 按 UTF-8 取字节）两两
  compare——hex/字符串形态差不藏碰撞；空值跳过；同名同值自碰也拒；错误只含域名不含值。
- `assertMasterKeyStrength`：≥32B 强度与互异同门。
- **恒推 bug 真修**：gateway ctor 旧实现 `others` 数组含 internalToken 自身、loop 条件
  `t === internalToken` 恒真 → 任何非空 internalToken 的 gitGrants 配置无法创建网关。改为
  同缝模块逐域两两比较（gateway/model 各别名/gitLegacy/master/internal 五域），自身不再
  自比较。正控 = wiring.test B2 块真实 ctor 合法互异不抛 + `await close()`；负控含每对
  碰撞/Buffer-UTF8 同字节/hex 形态不误报/强度/短 key。

### H2 + R-Q50-4：receive-pack（新模块 src/gitproxy/receive-pack.ts + server 重写）
- `PktHeaderScanner`：跨 chunk 增量 pkt cursor（保存真实 pending 头/载荷长度；**不滑动回退
  3 字节**），flush（len 0）精确定位一次且**包含在 header 内**（R50 指认的 rawCmd=subarray
  剥 flush 缺陷消除）；header 累计 ≤64KiB（pack 字节不计入——R50 指认的 coalesced 大 pack
  误计消除）；全零 OID（create/delete）按 pkt 边界推进不误判；非 hex/超 PKT_MAX 即结构化
  error。
- `parsePktCommands`：fatal UTF-8（无效编码拒，非替换映射）、首条 `\0` caps 截断、非首条
  禁 NUL、grammar、refname 一把尺、重复 ref、SHA-1 值域；失败返回固定类别。
- **gzip 语义重写**：整个 body 经**单一 createGunzip 连续流**（Node 流互操作
  `Readable.toWeb(Readable.from(gunzip))`，write→drain/pull 天然背压）；header 在**解压后**
  字节上定位；前缀（含 flush）+ 剩余解压字节以 identity **单次**上游 fetch；不再在压缩字节
  上找 pkt、不再分段新建 inflate（R50 指认的"pack 损坏数据"双错误消除）；不对已剥
  encoding 的上游 re-deflate；compressed/decompressed/header 各自有界，余包不整包缓存。
- **identity byte-for-byte**：前缀（完整命令区含 flush）+ 同一 reader 续读余包（pull 式
  真背压），same-chunk remainder 与后 reader 各转一次，转发流==原始解压后流。
- **拒绝收束**：全部拒绝路径 `src.cancel()`（内部连动 gunzip.destroy + rawReader.cancel，
  不只 releaseLock）；上游响应管道加 error 收束（upstream error → res.destroy；res close →
  上游 body cancel；不自动重试写）。
- **node:zlib import 错误修正**：R49 声称修了实际仍 `createInflate, type Transform from
  "node:zlib"`——现改 `createGunzip` from node:zlib、`type Transform` from node:stream；
  死代码 hasFlush/inflateBounded/本地 PKT_MAX 删除。
- refname 一把尺：`isValidRefname`（grants.ts）收敛 Git 参照规则全集（`~^:?*[\`、`@{`、
  `..`、`//`、每分量前导 dot/末 `.lock`、尾 `/`/`.`），receive-pack 与签发方共用（H2 指认
  的 `^[^/]*\^` 漏 refs/heads/a^b 消除，调用方不再行内第二把尺）。

### H3：生命周期
- **logout**（gateway /auth/logout）：新增 git grant 撤销——按服务端 sid 登记定位
  （#gitGrantActive.has(sid) → revokeGitGrantSession），先撤登记/jti 再关 WS；不 ban
  principal（logout ≠ 吊销，再登录可用）。
- **Session.stop**：git 能力撤销放**第一个长 await 之前**（stop 首行，await starting 前）
  ——`#revokeGitGrantOnce` 幂等单飞：成功置位不重复；失败不置位、下次 stop/#dispose 独立
  重试；startup 失败/重复 stop 均覆盖。#dispose 内改调同一幂等方法，失败计入 errors。
- **close()/revokePrincipal/批量 revoke**：先内存撤全部目标（同步不可逆）→ **一次** fallible
  保存（#revokeGitGrantAll/Principal 单次 save）→ 其余 finalizers 独立执行（authGate 等
  各自 try/audit）→ grant 保存失败在 close 尾部 throw（非零收敛，不 swallow 装成功；磁盘
  残留旧登记由 epoch 轮换 fail-closed 兜底）。
- **setAclVersion**：catch{} 改 fail-closed 可见（固定类别 audit append；回调抛错时登记未
  更新，旧 grant 仍被签发侧登记拒）。

### H4：初始 ACL 不再自杀刚签 grant
- Session ctor 新增 `aclVersion` 初始（mint 值经 SessionOptions 传入）；
  `setAclVersion` **同值重设直接返回**（attach 重建不再触发 revoke）；只有真实 bump 才撤销
  旧 grant；gateway attach 处删除无条件 `setAclVersion(metadata.aclVersion)`。

### H5：Runtime validate 真实施行（gitproxy ctor）
- mode 严格二值（缺省/未知 → throw，不落 dev 默认）；`assertMasterKey` 实调；pollMs 必须
  1..5000 正整数（拒 NaN/0/浮点/负值退化忙 poll）；internalToken 必须 string ≥16；部署
  配置与 repo 条目出现 `readRefs`/`writeGlob`（含空数组）明确 throw（ref 级读控制代理层
  不可交付，不得签成 repo 全读）；A7 production 三拒保持。

### H6：privacy + 授权后重验
- unknown repo deny/audit 一律 `unverified`（不透传请求路径形态）；known repo 用 allowlist
  名/verified claims；audit 增 `team` 字段取 claims.tenant（非请求头）；verifyGrant reason
  全固定类别（`writeRefs 非法: ${r.slice(…)}` 原文透传消除）。
- **fetch 前重验** `#revalidateBeforeFetch`：prepare 含 await（读命令区耗时不受限），首笔
  上游 fetch 前重核快照新鲜度/exp/epoch/jti/session 登记/acl——头部验过后慢送命令不能借
  组织凭据写到过期授权；已流向上游的动作副作用如实 unknown（注释在案，不承诺回滚）。

### H7：registry load 存在（R50 误报 erratum）+ 损坏语义
- R50"gateway 无 git-registry load 路径"**错误**：existsSync/read/JSON.parse 恢复
  active/revoked 真实存在（gateway ctor）。本轮校正安全语义：文件损坏/JSON 失败/形状错
  **整批丢弃**（active/revoked 清空，不半恢复部分 entry）+ 固定类别审计诊断 + fail-closed
  从空登记开始；epoch 每次重启新 → 恢复的旧 entry 也必然 epoch 不符被代理拒。

### R-Q50-3：renew 链真实现（非文档降格）
- **签发**：`#mintGrant` 统一 scope 推导（renew 与初签同源，不扩大）；exp =
  min(now+15min, principal 在途连接凭证 expiresAt)——**不越过可信 principal 有效期**；
  principal 已吊销 → 拒签；过期身份不签发。
- **调度**：`gitGrants.renewIntervalMs`（正整数 ≤15min）→ 专有 renew timer（`timerImpl`
  可注入供纯 fake unit；缺省 setTimeout；unref）；配置才启用；demo 配 10min。**后台长
  活动会话也真有触发**（不依赖新连接/idle）。
- **轮换**：`#renewGitGrant`：会话 alive + principal 未吊销才续；新 jti mint → 旧 jtis 全部
  进 revoked → **persist 先于投递** → 投递 = `writeGitCredentialConfig`（新拆分函数，仅写
  HOME/.gitconfig，0600 tmp+rename 原子替换，不 rm .pi、不碰运行中会话状态；wiring 用
  网关侧初始副本 + 新 token，**不回写旧 token**）→ 投递失败：新 jti 撤销 + 登记回滚旧 jtis
  + 重新 persist（回滚保存也失败则审计"磁盘状态 unknown"）+ 不虚报成功。
- **HOME/mount**：HOME 0700 workspace 外（现状已满足）；.gitconfig 0600 tmp+rename；mount
  核验——docker backend 已是 `-v <home>:<home>` **目录 bind**（非单文件 inode 绑定）、本地
  backend 直路径、k8s emptyDir，同目录 rename 对每次新 git 进程可见 → **backend/mount 无需
  小改**（不动比乱改好，如实记录）；在途旧 grant 不可撤回/不自动重试如实。
- 并发：renew 单飞在同一同步段内完成内存变更+save（Node 单线程天然串行）；dispose/acl/
  logout/principal/close 全部走 sessionId/principal 定位的幂等撤销（delete 语义），不复活。

### R-Q50-8：maxAuthAge 与 pollMs 解耦
- `REGISTRY_MAX_AUTH_AGE_MS=5000` production 常量（dev 30s 仅诊断/低保障，不进 allow）；
  age 锚=每轮 pull **起始** mono 时点（网络+读体+解析都消费 age）；发布守卫：完成时
  age>maxAuthAge → **晚到不发布**（旧 snapshot 不续 authority）并 250ms 重试；正常调度
  `maxAge-1000ms`（prod 4s，早于 age 到期留真实裕量）——不再"缩 poll 同缩 age 每轮 dt 空
  窗"。每 fetch 预算 `REGISTRY_FETCH_BUDGET_MS=2000` 经可注入 `signalTimeoutImpl`
  （R-Q50-12：默认才用原生 AbortSignal.timeout，纯 fixture 可注入 fake，不悄藏原生 timer）。
  close 时 abort inflight/closed 后不回写不重 arm（#closed 守卫既有 ✓）。

### 测试（只写未运行）
- 新 `tests/credential-domains.test.ts`：纯 unit（正控/每对碰撞/hex-raw 碰撞/强度/空值/
  自碰/工具函数）。
- 新 `tests/gitproxy-receive-pack.test.ts`：scanner+parser stream-chunk 矩阵（逐字节切分
  收敛/全零 OID/64KiB overflow/语法错/flush 精确一次/same-chunk 后缀/NUL/无效 UTF-8/重复
  ref/a^b 等非法 refname/SHA 值域/空命令区）。
- `tests/git-grants.test.ts` 增 2 test（refname 一把尺/固定 reason）。
- `tests/wiring.test.ts` B2 块更新（新错误正则/hex 碰撞负控/合法正控 await close/纯度口径
  注释——构造含真实 timer+FS，构造级非 pure，如实标注）。
- **保留不动**：gitproxy.test.ts（3 真实 HTTP integration 断言原样）、git-e2e.test.ts
  （真实 17/P1）、git-grants-integration.test.ts（未授权标记 4 例原样）——全部 unrun。

## 3. R50 erratum（新 doc 列出；旧 R50 report 不改）
1. "gateway 无 registry load"（R-Q50-7 依据之一）为误报——load 真实存在（H7）。
2. "audit claims-only/identity 路径全闭/mode 全拒/三抛坐实"按 H1/H2/H5/H6 撤回重修。
3. "own-pair 全 RULES 的 grant crypto"混入 DLP 术语，非 grant 生产证据。
4. R50 根无自身 0600 ledger（manifest 25 件中两份 R49 ledger 拷贝 mode 644）；done
   filesModified 仅 manifest 漏其余与 repo report——不借其 snapshot 声称完整 provenance。
5. R-Q50-12 纯度口径：AbortSignal.timeout 原生 timer 已可注入（signalTimeoutImpl）；
   gitproxy.test 的 production 构造含真实 setTimeout/原生 signal timer——构造级非 pure，
   待预审轮决定运行方式。
6. R49 doc §1 "arm/clear 布尔已改"与本轮前源码不符（R50 §4 属实）——本轮真改；R49 doc
   不改写，以本文件为准。

## 4. 三态与遗留（不预勾）
- **source 已落**：本文件 §1/§2 所列（真实源码 diff 为准）。
- **unrun/unknown**：typecheck/全部新 unit/收紧 R47-12/构造级正控——本轮执行禁令，待
  coor 新轮预审实际脚本；不复制旧绿。
- **pending（真实验收）**：17 项/P1 真实 git/demo 双进程/真实 gzip push 形态——不变。
- **外部**：mTLS/KMS/上游保护/IdP/CNI/DPA/WORM/soak 原样 external。
- **遗留 required 候补（交原 Grok 静审裁决，不自称闭合）**：
  a) gzip 场景上游 content-type/accept 已带但 `content-length` 未剥/未重算（identity 流式
  无长度；若客户端带 content-length 而我们转发解压后字节，长度可能不符——上游按 chunked
  接收的事实语义待真实验证，如实列待审）。
  b) renew 投递仅写 .gitconfig；多容器/多节点同 HOME 场景不在单网关声明内（部署面）。
  c) #principalExpiresAt 无在途连接时返回 null（不虚构上限）——断连重连窗口内 exp 只受
  15min 上限约束，续签仍要求会话 alive；边界如实列待审。
  d) logout 仅撤 sid 对应 grant entry；同一 principal 多会话登出其中一个不波及其它（语义
  正确但与 revokePrincipal 不同，待审确认）。
  e) R47-12 收紧后 runner 各正向用例是否仍绿 = unrun/unknown。
- S2 partial；B2 partial（源实现进度，非 17 项验收过）；S3–S6 pending、S7 gated；G1/G3/
  54m57s/4818 unknown 原样；615/598/11fail/1cancel/5skip/5701958ms 冲突/serial 未跑/Docker
  非唯一根因——全部不升级。
