# S2-B2 修复轮（R55）：R54 required A–H 全落 + driver 修正提案（task_5df7c4b13f4e / ctx_2c03bd80e2d1）

- 日期：2026-10-19。执行者：Pi（原 terminal/incarnation/model 未换）。性质：**零执行轮**
  （权限 (c) 不变）——零 Node/JS/tsx/tsc/TS API/Python(含 uv)/解释器编辑/heredoc/awk/sed/
  编译测试/网络/child/ps/signal/Docker/Git/demo/真实 timer/sleep/worker；仅 native
  read/edit/write + FS metadata（ls/find/stat/shasum/cp/mkdir/chmod/printf-ledger）。
  R51 Python/编译历史保持已登记，本轮未重犯。typecheck/tests=**unrun/unknown**。
- 私根：/tmp/pi-r55-yFMPSQr7（coor 预置 0700；prov seq1/2 immutable 只追加）。baseline30 =
  R54 current29 + R54 report（131a1c50…），coor 双侧 30/30 + 二次 SHA 一致（非 HEAD）。
  本轮将改 9 件事前复核 9/9 吻合（receive-pack 87e3e61d、gitproxy-server 34c7fd61、grants
  6252b8b5、gateway-server 9560f100、session d3ce1a30、renew-policy 67e350b6、mapping
  717a0638、r47cases 978062f4、receive-pack-test 06b5fc86）。rejected-driver-r54.mjs 仅参考
  未运行。生产 runner 冻结 6f4e2b0f 未动。
- **Manifest self digest（最终版，根外记录）**：sha256-root-manifest-r55.txt =
  `2379f5cb676e5c1b5e4368f6b78d5c6e83959375c28577f8ca38f0df6cab0e79`（35 files 不含自身：
  baseline 30+prov+driver 候选+baseline-paths+本清单；纯 FS 命令生成；封后根内零写入——
  无 final-note、selfdigest 不写 ledger）。本轮修改后源 hash 封版快照：receive-pack
  4e48a32e、gitproxy-server 23f9ec1b、bounded-reader af830d31（新）、gateway-server
  75fb32e2、session d3ce1a30（未改）、grant-rotation 562ed353（新）、renew-policy
  6358ef61、mapping 717a0638（未改）、grant-rotation-test fa4d816b（新）、
  bounded-reader-test 6a134dda（新）、renew-policy-test 3312ccd0、r47cases 2723c619、
  wiring/sandbox-config/demo 未改、progress 3ed0f783、本 doc 封版前值 aedc7ca1（§0 追加
  后以最终版为准，不字自引用）。

## 1. R54 required 逐项（实际正路径可用）

- **A（最高，轮换事务）**：新纯模块 `src/gateway/grant-rotation.ts`
  （planRotation/applyRotation/rollbackRotation/retireUndeliveredNew）。`#mintGrant` 删除，
  改纯 **`#signGrantClaims(...capExpiry)`**：只产出 {token,jti,exp,cap}——零登记零 save。
  初签 `#issueGitGrant(...identityExpiry)` 自身事务：sign → entry 登记+save（任一失败回滚
  登记不留半 entry、不发布 token）。续签 `#renewGitGrant`：**previous 在纯 mint 前捕获**
  （绝不含 newJti——R54 手推的自吊销时序缺陷根除）→ sign → plan（newlyRevoked=previous
  中未 revoked 者）→ apply（entry.jtis={new}、revoked+=newly）→ **save 先于投递** →
  writer；save/writer 任一失败：`retireUndeliveredNew`（newJti 进 revoked——不留可用未投
  递 token）+ `rollbackRotation`（entry 恢复 previous、只还原本次新增 revocation，原已
  revoked 不复活）+ save try + 固定审计 + throw。scope tenant/principal/session/repo/caps/
  epoch/ACL 不扩（sign 参数同源）。**rotation 事务 unit**（新
  tests/grant-rotation.test.ts 4 例，fake entry/revoked/persist 直验证
  signGrant+verifyGrant/revoked/active 语义：成功 new 可验未 revoked+旧全拒/回滚还原/
  writer 失败 retire/两轮连发）。
- **B（初签可信 expiry）**：`#issueGitGrant` 增 identityExpiry 参数，**签发点直接接已验
  `identity.expiresAt`**（不从尚未 attach 登记 #conns 倒查——初签 cap 恒有值，不再越
  IdP expiry/离线永续）；entry 增 `currentExpAt`（当前生效 grant 的 exp，供调度计算）。
  attach 现存 agent session 分支：补 `linkBrowserSid`（服务端验证 sid，logout 关联闭合）+
  同 principal owner 可信重认证更新 entry.maxExpAt（principal 字串精确匹配，不借不同
  collaborator 的较长 expiry；save fallible try）。`#renewGitGrant`：fresh 判定放 revoke
  **之前**（同 principal 真正 fresh cap 先更新 captured，合法再认证继续而非硬 15min
  session 寿命）。exp 计算抽同缝纯函数 **`computeGrantExpiry(now, cap)`**（renew-policy.ts
  导出，#signGrantClaims 调用）：min(15min, cap)、cap 已过即拒、null 历史不解释为无限
  （只受 15min 锁，不自造 IdP expiry；受信任无到期 identity 按认证原契约）。unit：
  renew-policy.test 新增初签 cap 4 断言组（2min 钻限/断线超 cap 拒/fresh reauth 允许/null
  仅 15min 锁）+ computeNextRenewDelayMs 5 断言。
- **C（logout 事务）**：重写 `/auth/logout`——`peekSessionsForBrowserSid`（**不删映射**）→
  全部目标**内存先撤**（新 `#revokeGitGrantSessionInMemory`：jtis→revoked、active.delete，
  不 save）→ browser.delete/saveSessions/每 conn close 各自独立 try（收首 err 不跳后续）→
  一次 git save → **成功才 take 删映射**；失败：映射保留 + `#pendingLogoutPersistence.add`
  （重试入口在）+ 固定审计 + **非 204（500）**。重试入口 `#flushPendingLogoutPersistence`：
  logout 开头 + renew 成功 save 后调用——revoked tombstones 已在内存，任意一次成功 save
  落盘全部，成功后 take 清映射/pending，**不还原 revoked**；二次 logout 真的补持久化
  （即使 active 已删也重 save tombstones，无 has(entry)==false 假成功）。不 ban principal、
  无关 browser 保留、合法重登可用。cookies/重试如实：logout 成功响应清 cookie；save 失败
  时 cookie 仍被响应清除（500）但映射+pending 保留服务端，重试不依赖客户端重发 sid。
  Session.stop 的 R53 try-continue 代码保留（runner R47-9 跨域错证撤回见 §3）。
- **D+H（owned 截止 + 全生命周期有限）**：新纯模块 `src/gitproxy/bounded-reader.ts`
  **DeadlineReadGate**——每块读取挂一次性 owned timer（绝对 mono 锚=**请求起点**（#handle
  设定经 route 传参，非授权后锚）；timer fire 即接管 pending read（粘滞 expired）+ finally
  必 clear（无跨 chunk 累积 reaction，expired 每 read 新实例）；**零窗 `>=` 拒不启动
  read**；可注入 deadlineTimerImpl/deadlineClearTimerImpl（纯 unit 假钟/fake timer，缺省
  native）。有限硬上限（GitProxyConfig.receiveLimits 可配、ctor 校验正整数+封顶）：
  header 截止 10s（ceiling 60s）、header 压缩侧 8MiB（ceiling 64MiB，独立保留）、**全 body
  raw ≤128MiB / decoded ≤512MiB / 全 body 寿命 ≤120s**（ceiling 1GiB/4GiB/600s——
  "合法大 push"不再等于无限：大 push 必须在配额与寿命内完成，超限取消；上游已开始副作用
  unknown 不自动重试）。header 循环用 gate.read(headerDeadline)；转发阶段 boundedRead：
  decoded 计数 + body 寿命检查（超限 fail 类别+cancelSource+throw）；转发 decoded 链
  identity/gzip 同缝单次 fetch 保真。**因果 unit**：新 tests/bounded-reader.test.ts 5 例
  （真实挂起 read 被 deadline 唤醒（假钟推进 timer fire）/零窗拒+粘滞/多 read 不 reset 原
  deadline/真 ReadableStream async cancel 完成-拒绝-error cleanup（非同步 ++fake）/读失败
  非 deadline 不误置 expired）。native zlib/HTTP 仍 NOT RUN 不提升验收。
- **E（泵/转发收束统一）**：gzip 泵——drain 等待改三路一次性监听（drain/close/error，
  settle 全部 off，**不对长寿命 pumpFinished 累积 reaction**）；pumpDead（close/error）后
  不再 rawReader.read 且统一 `void rawReader.cancel()`；**正常 EOF `end()` 不 destroy**
  （已解码尾部读尽，由解压侧 reader 自然 done 收束；异常/cancel 才 destroy）——丢尾与
  悬挂同修。`createIdentityForward`：`cancel()` 返回 `runOnCancel()` promise（完成接住、
  拒绝 contain 不 unhandled）；pull 的 readChunk 失败也 `await runOnCancel()` 清底层再
  c.error。生产 cancelSource 内部全 try（observational 边界保持，不虚构投产 exploit）。
  stream helper 的 async cancel 完成/拒绝/error cleanup unit 见 bounded-reader.test 末例。
- **F（真正提前调度）**：renew-policy.ts 新增 **`computeNextRenewDelayMs(entries, now,
  maxInterval, minInterval=250)`**：取当前活 entry 最早可工作时点（currentExpAt/maxExpAt
  − margin；近到期项排 cap 到点驱动一次 revoke-and-skip 后即删——不 250ms spin；无 entry
  → maxInterval 轮询）。`#startGitGrantRenewTimer`：effective 上限 = min(configured/
  缺省, TTL/2)；实际 fire 延迟 = `#scheduleNextRenew()` 按活 entry 计算（**新 grant 签发/
  续签成功后刷新最早 due**；#closed 下不 rearm；配对 clear/inline 返回竞态保留）。短 TTL
  在有效期内不人为提早断档（due−margin 才 fire），2min IdP expiry 场景首拍即近 due。
  unit：computeNextRenewDelayMs 5 断言（上限轮询/提前于轮询/近到期排 cap/已过期立即）。
  Gateway reaper 仍 Native → 构造级 NOT ready 维持，不为测构造扩框架。
- **G（§3 r47cases 静态红）**：删 :462 重复 `let containArmed`（保留一处）；`termSeen` 补
  声明并**真使用**；计数门拆三段——preTermObs（TERM 前）/ gracePreContainObs（termSeen
  后、containArmed 前：**真 TERM 后 grace 首轮门**，断言 ≥1）/ postContainObs（containArmed
  后：0）。原 TERM 恰 1/KILL 0/finalIO 跳过/escapes 0/双 timer 独立清/非零 reject 断言全
  保持未放宽；生产 runner 6f4e2b0f 冻结未动。仍 standalone 9s 另批，无试运行。
- **R53 doc 两处撤回（本 doc 承接，旧 doc 不改）**：a) R53doc 以 R47-9/closeWall 证
  Session.stop cleanup 属跨域错证——撤回（runner 停链面证据不能证 Gateway 清理链；本轮
  C/D/E 的生产同缝 unit 才是对应面）；b) renew-policy.test 计数"决策 8 例+映射 1"实为
  决策 7+映射 1。

## 2. driver-candidate-r55.mjs（新根 /tmp/pi-r55-yFMPSQr7，只写不跑，≤80 行）

- 修正 R54 proposal/coor §7 全部指认：单一 `run({files: 6 READY suites, isolation:"none",
  concurrency:1})`；内建 `node:test/reporters` tap reporter 经 **`stream/promises` 的
  pipeline**（tests→tap→log byte 级连接，error 传播/end 收束，rejection 外层 catch 不
  unhandled）；事件计数监听（pass/fail/cancel/skip/todo/error）在 pipeline 启动前注册；
  guard 自最早 T0（性能时钟起点）arm 9s **保持 ref**、覆盖 deps/setup/测试/完整 TAP/最终
  IO，`clearTimeout` 在 pipeline（含 log close）之后；log `flags:"wx"` 0600 不覆盖 +
  父根 0700 `statSync` 检查；判负 = guardFired ∨ wall≥9s ∨ fail/cancel/skip/todo≠0 ∨
  total < EXPECTED_TESTS（逐 suite 枚举 5+13+11+10+4+5=48，零加载防假绿）；fresh wall 在
  pipeline 完成后采样。r47cases 排除（standalone 9s 不叠双根 timer）。**未运行=unknown，
  实际父 shell wait 由 coor 另审批准。**

## 3. 三态与待审（不预勾）

- **source 已落**：§1 所列（实际 diff 为准）。**unrun/unknown**：typecheck、全部 unit
  （旧 READY + 新 grant-rotation 4/bounded-reader 5/renew-policy +7）、driver。**pending**：
  17 项真实验收/P1/真实 gzip push/demo 双进程；**外部**：mTLS/KMS/上游保护/IdP/CNI/DPA/
  WORM/soak 原样。
- **待原 Grok 静审关注点**：a) attach 分支 cap 更新的 save 失败路径内存已升——离线 renew
  用内存值不越认证期限（设计如实，持久化滞后窗口待审）；b) logout 500 响应对 HTTP 客户
  端重试语义（cookie 已清+服务端重试入口，客户端无需重发）；c) rotation 事务的 save 失败
  回滚后 entry.currentExpAt 未回滚（保留新值——仅影响调度估计，不影响判定面，如实列）；
  d) O-2（非法 Basic→502/internalToken 非常数时间比较）维持留观未动。
- S2 partial；B2 partial；S3–S6 pending、S7 gated；G1/G3/54m57s/4818 unknown 原样；旧
  full 实数不升级。下一轮继续 B4–B12/S3–S6，不以本报告收尾 loop。
