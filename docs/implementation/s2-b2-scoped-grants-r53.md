# S2-B2 修复轮（R53）：R52 九项 required 最小修 + coor 既定漏缝 H53-a–d（task_e59bb958235c / ctx_139474acbf69）

- 日期：2026-10-19。执行者：Pi（原 terminal/incarnation/model 未换）。性质：**零执行轮**
  （绝对权限令）——零 tsc/测试/Node/tsx/Python(含 uv)/Perl/awk/sed 修改/heredoc；仅
  read/edit/write + FS metadata（ls/find/stat/shasum/cp/mkdir/chmod/printf-ledger）。
  typecheck/tests = **unrun/unknown**（旧绿一律不复制）。
- **Manifest self digest（最终版，根外记录）**：sha256-root-manifest-r53.txt =
  `e2e118a678843c37bca26242c5d850f821d59205ddeb47ae73ca83d31af764c5`（28 files 不含自身：
  baseline 25+prov+driver 候选+本清单；纯 FS 命令 find+shasum 生成；封后根内零写入——
  无 final-note、selfdigest 不写 ledger，R51 教训不再犯）。driver-candidate-r53.mjs mode 644
  如实（0700 根内，其他用户不可达；封后不改）。本轮修改后源 hash 封版快照：receive-pack
  87e3e61d、gitproxy-server 34c7fd61、grants 6252b8b5、gateway-server 9560f100、session
  d3ce1a30、mapping 717a0638、renew-policy 67e350b6、receive-pack-test 06b5fc86、
  git-grants-test dd03a9dd、r47cases 978062f4、wiring 426240a6（未改）、renew-policy-test
  c6896825、progress 6defd64d；本 doc 自身 hash 封版前值 09865868（§0 追加后以最终版为
  准，不字自引用）。
- 私根：/tmp/pi-r53-MvspFd2K（coor 预建 0700；prov seq1/2 不可改只追加）。baseline25 =
  R52 sealed snapshot24 + R52 report，coor 双侧 25/25 与当前工作树零 drift；本轮将改 9 件
  事前复核 9/9 吻合（receive-pack dd7e52fe、gitproxy-server 3887211e、gateway-server
  5ee69fba、session 6032cb10、grants 44e21667、r47cases e87f5aa7、git-grants.test
  1f057415、gitproxy-receive-pack.test 884a56c7、wiring 426240a6）。R52 根
  /tmp/grok-r52-TsjWH0pM（self 94206ece…，31/31 条核验）与 R51/50/49/47 根只读未触。
- **R51 seal 勘误（coor 发现，原样记录不修不重封）**：R51 manifest 22 条 21 符、ledger
  期待 96820428 实际 eb68b9f0——原因 seq6 在 seal 之后又写 selfdigest 进 ledger（又一次
  违反 selfdigest 只能根外）。R51 根保留坏 seal 现状，不因此开 metadata 轮。

## 1. R52 required 九项逐项（file:line 依 R52；全部落地）

- **R-Q52-1（最高，转发丢尾）**：`PktHeaderScanner` 新增 `tail()`（done 态暴露 pending 中
  flush 之后的同 chunk pack 尾字节）与 `takeTail()`（一次性取走并置空内部引用）；新导出
  **同缝转发器 `createIdentityForward(header, tail, readChunk, onCancel)`**：pull 序列 =
  header（含 flush）→ tail → 后续 reader 逐块（每 pull 一块真背压），取消 onCancel 收束
  底层，错误一次性流 error。gitproxy server 阶段三改用同缝转发器（gzip 时 src=解压侧
  reader，同一函数同语义）——同 chunk flush 后尾字节不再丢（trace1/trace3 修复）、无重复
  flush、无 -3 滑动、pack 不计入 header cap、不整包缓存。**forwarder 等价 unit 新增 5 例**
  （同 chunk+PACK/逐字节切分×6 变体含 flush 边界/小 header+>64KiB pack（trace3）/取消
  cancel 底层/gzip 解码后同函数——native zlib 集成如实另列 NOT RUN）。
- **R-Q52-2（logout 键空间错位）**：新纯 helper `src/gateway/grant-session-mapping.ts`
  （link/take/peek）；Gateway 签发点用**服务端验证得到的 `identity.sid`**（conn.sid，非
  client 自报头）记录 browserSid→agentSessionIds 关联；logout 按映射 `takeSessionsForBrowserSid`
  撤全部关联 entry/jti 再独立 browser/session/WS cleanup；不 ban principal、不误撤无关
  browser 会话；过期/破损 cookie 不命中映射。纯控制 7 断言（两 UUID 正撤+无关保留+一次性
  取走+伪造 cookie 不命中）。
- **R-Q52-3（maxExpAt 只写没读→离线永续）**：新纯模块 `src/gateway/renew-policy.ts`
  （`decideRenew`/`renewMargin`，#renewGitGrant 开头同缝调用）：session gone/principal
  revoked → skip；captured expiry 已到 → revoke-and-skip（撤旧）；剩余 ≤ margin
  （min(60s, max(5s, 剩余/4))）→ skip（不在边界失败）；其余 mint。`#mintGrant`：cap =
  freshExpiry ?? existing.maxExpAt——**离线/无 conn 绝不丢最后可信 expiry**，exp=
  min(now+15min, cap)，cap 已过即拒签；只有可信同 principal 重新认证（freshExpiry 非空）
  才更新 entry.maxExpAt，不取任何外部头。调度：effective interval ≤ TTL/2（R-Q52-4 缺省
  7.5min），fire 时 cap 检查兼顶短 expiry。链路级 fake wall/timer 控制（writer 失败/late
  复活）需构造 Gateway（Native reaper timer 不可注入）→ 属构造级 NOT ready，如实列待审；
  决策面纯 unit 8 例已就绪。
- **R-Q52-4（接口零声明+缺省语义）**：GatewayConfig.gitGrants 补 `renewIntervalMs?`/
  `timerImpl?`/`clearTimerImpl?` 三字段声明；语义 = **可选 + 安全缺省 TTL/2（7.5min）**
  （旧合法配置不再无故构造抛，也不静默 15min 后死；显式提供时校验正整数 ≤15min）——
  R51 doc"配置才启用"措辞与代码不符的更正落在本 doc。timer 注入配对 `clearTimerImpl`
  （#stopGitGrantRenewTimer 用配对 clear，native clearTimeout 不再漏 fake 队列；缺省
  clearTimeout）。wiring.test :252 正控在缺省方案下不再红（无需补参；构造级 NOT ready
  维持 R52 判定）。
- **R-Q52-5（revokePrincipal 吊销链中断）**：全链 try/收首 err——git grant 撤销、
  revokedSet、saveRevocations、browser.revokePrincipal、saveSessions、每 conn 关闭、
  expirePending 各自独立；原 S1 清理链不被新 finalizer 遮蔽；最终固定类别审计 + 重抛
  （非零可见，不把资源退役装成功）。
- **R-Q52-6（stop 撤销失败逃出→泄漏）**：stop 首撤包 try——失败固定类别审计后**继续**
  startup 收束与 #cleanup（#dispose 内幂等单飞可独立重试）；原 abort/SDK end+kill+
  stream/host/env/backend 5000 等不被持久化/audit 故障跳过；能证 cleanup 真实被调的控制
  =既有 R47-9/closeWall 系（unrun 待预审）。
- **R-Q52-7（gzip 泵 drain 悬挂）**：pump 的 drain 等待与 gunzip close 竞速
  （pumpFinished promise，destroy 后不再永悬）；aborted 标志使泵退出；泵 catch 统一
  destroy+rawReader.cancel（两侧收束）；错误固定类别 contain，不 raw err 成未 caught 顶层。
- **R-Q52-8（测试计数门）**：r47-cases R47-12 改以 `containArmed` 为 post-failure 计数
  起点（postContainObs=0），TERM 后失败派发前的 grace 首轮合法观察计 preContainObs（断言
  ≥1 正证）；TERM1 单列/KILL0/finalIO 跳过/escapes0/双 timer 独立清/非零 reject/TERM 前
  ps ≥1 保持；**不改 runner 停链逻辑**（runner 生产源已 R52 pass 冻结）。
- **R-Q52-9（测试静态红）**：git-grants.test 期望改为实际固定类串
  `caps.writeRefs 非法（固定类别，不透传原文）`+ 保留不含原文断言（正确 expect，不宽泛
  正则、不删敏感断言）。

## 2. coor 既定漏缝 H53-a–d

- **H53-a（静态 TS 红）**：`#gitGrantRevoked.delete(...previous)` 改逐个处理——rollback
  只还原**本次新增**的 revocation（`newlyRevoked` = previous 中原本未 revoked 者，add 前
  捕获），原已 revoked 的不误复活；restore 前检查 entry 仍 active（同步段内 epoch 不变）；
  失败固定诊断（"磁盘状态 unknown"审计既有）。
- **H53-b（gitGrants 级 readRefs/glob 同尺）**：gateway ctor 对 gitGrants 配置探针
  readRefs/writeGlob（含 empty）即抛；writeRefs 全部经 **grants.ts 新导出 `isValidRefGlob`**
  同尺校验（refs/ 前缀/≤256/禁 `**`/`*` 只在段内且与 refGlobMatch 语义一致/禁非法 refname
  字符），validateClaims 的 writeRefs 校验同步改用该尺（不再两把）；gitGrants.repos 条目
  同探针+条目级 writeRefs 校验；writeRefs 空时禁止任何 allowPush repo 配置。强 key/
  internalToken/type/poll 有限整数等保留正路径。
- **H53-c（registry 快照/轮询/pump 收束）**：snapshot 形状收紧——root 非 null 非 array、
  epoch 长度、activeSessions 逐 entry（key 长度/字段类型/aclVersion 正整数）、revokedJtis
  元素类型、cardinality 上限（active ≤10k、revoked ≤100k，合理默认写明）；坏流抛错不覆盖
  旧 authority/不 reset age；tick 每 await 后 #closed 再查（close 后不回写/不 rearm；
  用户明示不能回写，R52 降可选不采）；owned timer/reader 由既有 signalTimeoutImpl+closed
  覆盖；#revalidateBeforeFetch 补 tenant/repo 两轴（全五 scope+epoch/acl 不漏）；
  prepared body 已造但重验失败 → body.cancel() → onCancel → cancelSource 两侧收束（不弃
  锁不泄漏，既有）；#handle 入口一次性 `res.on("error")`（O-7：deny 之前 early res error
  contain）；不 raw err 入 public/audit（既有固定类别保持）。
- **H53-d（流边界计数/owned 截止）**：header 阶段新增 compressed 字节计数
  （`RECEIVE_HEADER_COMPRESSED_CAP_BYTES = 8MiB`——gzip 压缩比 ~1000:1，64KiB 解压对应
  约 70B 压缩，8MiB 给足裕量）超限即 gunzip.destroy+rawReader.cancel（header 阶段上游 0）；
  header 定位 owned 截止 `HEADER_DEADLINE_MS = 10s`，**请求起点 mono 绝对锚**（不每 chunk
  重置）超时 408+cancel；decompressed 侧由 scanner 64KiB cap 钳制（既有）；转发阶段 pack
  无界流式（合法大 push，不谎称整流有限——doc 如实）；fake 控制走真实生产同缝
  （createIdentityForward/decideRenew），native zlib/libuv 集成单列 NOT RUN。

## 3. 单测准入面（依 R52 §5 表增量；全部 unrun）

- READY（纯 unit，新/修后）：credential-domains.test（原 READY）、gitproxy-receive-pack.test
  （+R-Q52-1 转发等价 5 例）、git-grants.test（R-Q52-9 修后升 READY）、**新增
  renew-policy.test**（决策 8 例 + 映射 1 例）。
- NOT READY 维持：r47-cases（先 R-Q52-8 修后仍走 standalone 9s 协议，不进本批 driver）、
  wiring（构造级 Native timer+FS）、3 真实 HTTP integration、git-e2e（17/P1）、
  git-grants-integration（未授权 4 例）。
- **driver 候选**：/tmp/pi-r53-MvspFd2K/driver-candidate-r53.mjs（≤80 行，提案未执行）——
  单进程、根级唯一 Native 9s watchdog 先于测试导入、node:test API 显式
  isolation:none/concurrency:1、根内 log 0600、真实 fail/cancel/summary 计数判负、TAP 写
  完 fresh wall<9s 后清 owned guard/失败非零。不含 r47cases（standalone 9s 协议不叠双
  根 timer）。由 coor 预审真实父 shell wait 后另轮准入。

## 4. 三态与状态（不预勾）

- **source 已落**：§1/§2 所列（实际 diff 为准）。
- **unrun/unknown**：typecheck（R51 遗留 unknown 口径保持，不称全项目 0error）、全部
  unit/收紧控制/驱动。
- **pending**：17 项真实验收/P1/真实 gzip push/demo 双进程；**外部**：mTLS/KMS/上游保护/
  IdP/CNI/DPA/WORM/soak 原样。
- **待原 Grok 静审关注点（如实列，不自称闭合）**：gzip 转发阶段 pack 无限流（合法语义）
  与上游慢消费的组合资源占用；renew 链路级（构造级）fake 控制仍缺；logout 后同 browser
  重登获得新 sid→新 grant（旧映射不复活 ✓）；O-2（非法 Basic base64→502 应 4xx 类）、
  internalToken 非常数时间比较（gateway :919）——本轮未动（非既定漏缝清单内，如实留观）。
- S2 partial；B2 partial；S3–S6 pending、S7 gated；G1/G3/54m57s/4818 unknown 原样；
  旧 full 实数（615/598/11fail/1cancel/5skip/5701958ms 冲突/serial 未跑/Docker 非唯一根因）
  不升级。下一轮继续 B4–B12/S3–S6，不以本报告收尾 loop。
