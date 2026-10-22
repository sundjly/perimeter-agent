# S2-B2 修复轮（R59）：R58 七 required 实际源修 + 同缝 unit + driver 修正提案（task_1ec35dc7a95a / ctx_581f417fb345）

- 日期：2026-10-19。执行者：Pi（原 terminal/incarnation/model 未换）。**权限收紧遵守**：
  本轮仅 native read/edit/write + Orca messaging——bash 只运行了 preamble 的准确 Orca 命令
  （heartbeat/check/ask/done），**未运行任何其他 shell 命令**（无 ls/rg/find/stat/hash/cp/
  mkdir/printf/env，无 Python/Node/解释器/heredoc/sed/cat），未读 modelgw，未写 ledger/
  manifest/tracker（证据封版全由 coor 执行）。typecheck/tests=**unrun/unknown**；driver
  只写不跑。生产 runner 冻结 6f4e2b0f 未动。
- 根：/tmp/pi-r59-tAQlsLgG（coor 预置 0700；prov seq1/2 coor 独占——**本轮未写 ledger**）。
  baseline38 双侧+二次源 hash 匹配（coor 亲核）；本轮将改 6 件以 baseline-actual-source-
  sha256.txt 为准复核（bounded-reader/gitproxy-server/gateway-server/renew-policy/grants/
  rotation 及对应 tests）。correction 文件：`/tmp/pi-r57-QVhJJYuq/coordinator-r57-correction.txt`
  读取 ENOENT（ask msg_ed27fbee3e19 三次超时未获路径回复）——其内容 = R57 escalation
  msg_49b17529da63 原文（作者自撰，已全文在案），引用以其为准，如实记录该读取缺口。

## 1. R58 七 required 逐项（实际源修，非报告闭合）

- **①（header min 保留 + PACK 只 bodyDeadline）**：header 段 `headerDeadline = min(
  headerBudgetDeadline, bodyBudgetDeadline)` 保留；**转发段 `gate.read(bodyBudgetDeadline)`
  唯一 deadline**（R57 的 min 双锚错误根除）——合法 push（header 8s 后 60s PACK）不再被
  10s 假截止打掉；零窗 `>=` 拒在 gate 与入口双保留。既有 header/same-chunk/bytewise/
  refname/scanner/drop 正反用例原样未退（gitproxy-receive-pack.test 13 例未改）。
- **②（全寿命 owned 绝对 deadline，三缺口全修）**：
  - 缺口 b：**外层 fetch AbortSignal**——#route 建 `AbortController`，prepare 接收
    `onLifetimeFire`（= lifetimeAbort.abort），lifetime timer fire 时真正 abort 外层 fetch
    （非仅收请求体）；单 fetch redirect:error 保持；upstream 已开始副作用 unknown 不 retry。
  - 缺口 a：**EOF 不再提前 disarm**——boundedRead done 分支不再解除；dispose（=disarm）
    由 #route 在**响应完成后**统一调用（成功/错误/取消同至；重验拒绝等早退也调）。
  - 缺口 c：header 段三处早退经 cancelAndDeny 统一 `#deadlineDisarm`；`#deadlineArm` 缺省
    native timer 挂 **unref**（注入自理）——错误请求不累积挂钟。
  - **request-lifetime 纯缝**：`armDeadlineTimer`/`disarmDeadlineTimer`（bounded-reader.ts
    导出，#deadlineArm/#deadlineDisarm 委托同一实现）——假 mono/timer + contained fire
    单测；src/raw cancel 幂等 Promise contain（R57-6 既有）+ 正常 gzip end 不丢尾（既有）
    + req close/abort 后无新 read（gate 粘滞 + cancelSource 幂等）。
- **③（同一纯计数全覆盖）**：新纯模块 `src/gitproxy/byte-budget.ts` **ByteBudget**
  （decoded/raw 双轨即时判定，粘滞 over）。header 循环 identity 原始字节同入预算即时检查
  （不再无 raw 计数）；**seed(cmdBuf+tail) 设值后立即判定——fetch 前超限 413/upstream 0**；
  EOF 不跳过（seed 与 done 无关）；流式后续越限（fetch 已发起）→ 终止流 + 副作用 unknown
  不重试（语义保留）；gzip raw 由泵独立（8MiB header/128MiB 全程，双轨分源说明）。
  **byte-budget unit 5 例**（seed 超限 fetch 前拒/EOF 不跳/identity raw 双轨/gzip decoded
  轨/边界恰等+粘滞）。
- **④（#issueGitGrant existing entry）**：新纯函数 **`mergeIssueIntoEntry`**
  （grant-rotation.ts 导出）：同 owner（principal 精确匹配）时 cap 合并 = **旧已过期/null
  不拉低；两者皆可信取较大者**（真实 captured 语义，不盲保留已过期/过长旧 cap）；
  `currentExpAt` 恒=本次新 token exp（准确对应）；不同 owner（collaborator）不借 expiry
  （maxExpAt 不动）。#issueGitGrant existing 分支真调用 + 同一 save 提交（失败回滚既有）。
  **merge-issue unit 4 例**（旧过期/旧较长/旧较短或 null/不同 owner）；rotation 四 case
  原样保留。
- **⑤（同步 fire 无界递归）**：新纯模块 `src/gateway/owned-renew-timer.ts`
  **OwnedRenewTimer**（Gateway `#scheduleNextRenew` 实际生产调用，非平行克隆）：**同步重
  入深度 >0 即判非法 hook（fail-closed：粘滞 hookIllegal + 清当前 handle 不再 arm）**——
  总 inline hook 不爆栈/不 microtask spin（R58 建议 queueMicrotask 不照抄的原因即此）；
  单次 inline 仍恰一有效 future slot（内层占 slot、外层 gen 检测 clear 自身）；close-during-arm
  不补写 slot；closed 复查在 arm 内；配对 clear 委托。TTL/2/margin/近 cap skip/签发续签后
  刷新全部保留（computeNextRenewDelayMs 未动）。**owned-renew-timer unit 5 例**（总 inline
  fail-closed 有界深度+粘滞/单次 inline 恰一/close-during-arm/stop 配对+迟到句柄不执行/
  正常异步 fire）。hook 非法时 Gateway 固定类别审计（停调度不 spin）。
- **⑥（close 最后重试）**：`#flushPendingLogoutPersistence` 改**明确 outcome**（{gitOk,
  browserOk, remaining}，不吞错误装失败报告）；close() 开头最后重试（browser+git 独立）+
  重试后仍残留 → 固定审计 + 计入 close **非成功**（disk unknown 如实，不称 durable）；
  其余 conn/session/server/audit finalizer 继续不依赖 cookie、不 principal ban、不借已删
  active 忽略补盘。logout 每 conn closed/outbox/close 各自独立 try（R57-5 保持）。
- **⑦（driver）**：见 §2。

## 2. driver-candidate-r59.mjs（新根，≤80 行，只写不跑；R58 §3.1 修法全采纳）

- 纯 .mjs **无任何 TS 语法**（R57 :11 REMAIN 注解红根除）；`tap` 动态 import 自
  **node:test/reporters**（R57 从 node:test 取的 TypeError 根除）；`await pipeline(tests,
  tap(tests), log)`（R58 §2.1 撤回后本机类型合法形态：async-iterable source + async-
  generator transform，真实背压/错误销毁）；log `once("error")/once("close")`——FD close
  以 close 事件为准（end 回调非证据）。
- guard：最早 `T0 = performance.now()` 后立即 `setTimeout(..., REMAIN())`（≤0 即 124），
  **先于全部动态 imports/setup**；无静态 imports；runtime `process.versions.node` major≥24
  判定（不调 node -v、不以 @types 冒版本）；ROOT=`R59_RUN_ROOT`（coor 未来独立 fresh 执行
  根，非本 sealed 交付根）+ `lstatSync`（isDirectory + !isSymbolicLink + mode===0o700 +
  uid===process.getuid()）+ `mkdir {recursive:false}`（EEXIST 判负，无 existsSync TOCTOU）+
  log `flags:"wx"` 0600；全部 setup 在 try 内，错误输出一行固定类别且有界；guard clear 在
  pipeline 完成 + log close + fresh wall 之后；EXPECTED=**手工 grep '^test(' 逐 suite 枚举**
  （5+13+11+12+4+4+6+5+5=65，R59 新增 byte-budget5/merge-issue4/owned-renew-timer5 与
  renew-policy 12、bounded-reader 6 手工核对，勿据运行 plan 生成）；判负 = 唯一 overall
  test:summary(file===undefined) 恰 1 ∧ success ∧ counts.tests===passed===EXPECTED ∧
  cancelled/skipped/todo===0 ∧ fail 计数 0 ∧ wall<9s。R47 排除另批。

## 3. 三态与状态（不预勾）

- **coor 静审修正（R59_source_ready v1 → fix-required → 本轮 F1–F6 全落）**：
  - F1：ByteBudget 实例声明在编辑中丢失（无声明即用）→ 唯一实例 arm 前构造（limits 同源）。
  - F2：OwnedRenewTimer 首版 handle 在 inSync 段直接 return，单 inline 的 onFire 丢失且
    slot 留死句柄 → 重写：handle 只置 syncFire/nestedSync 标记；arm 返回后单 inline =
    同步执行一次 onFire + 保证最终恰一有效 future slot（调用方未重排时本层重排，新 gen
    旧句柄失效）；同步段内第二个 fire（总 inline）→ failclosed（clear+slot 空+粘滞）；
    异步 fire 保留迟到句柄防护且正常执行；unit 补「单 inline 后再次异步 fire 仍能重排」。
  - F3：fetch 包 try/catch（abort/网络错误 disarm+deny 固定类别不漏 dispose）；res close
    → lifetimeAbort.abort + dispose；upstream end/error → dispose；revalidate 处
    body.cancel().catch contain。
  - F4：mergeIssueIntoEntry 语义修正——本次已验 signed.cap 为**权威**（fresh 更短跟着
    变短，不保留旧更长 cap 越过当前身份有效期）；不同 owner → 抛固定类别拒签（不 add jti/
    不改 entry）；merge-issue unit 重写（shorter fresh 变短/other owner throws 且不变/
    可信无到期 null 沿原契约）。nowMs 参数移除。
  - F5：byte-budget ctor 参数属性改显式 #字段；receive-pack PktHeaderScanner 同型顺手改。
  - F6：driver pipeline 改 `await pipeline(tests, tap(tests), log)`（本机类型合法形态，
    勿 new）；EXPECTED 更正 renew-policy=10 实数、合计 63（手工逐 suite）。

- **source 已落**：§1 所列（实际 diff 为准）。**unrun/unknown**：typecheck、全部 unit
  （READY 面待 coor 依 R58 §4 表 + 本轮新增复核：grant-rotation 4+merge 4 / renew-policy
  10+2 / credential-domains 5 / bounded-reader 5+1 / byte-budget 5 / owned-renew-timer 5 /
  gitproxy-receive-pack 13 / git-grants 11（红已除候选）/ r47cases 12 standalone 另批）。
  **pending**：17 项真实验收/P1/真实 gzip push/3HTTP/demo/typecheck；**外部**：mTLS/KMS/
  上游保护/IdP/CNI/DPA/WORM/soak 原样。
- **R58 元信息承接**：R58 ledger seq5 初版 manifest 因 late followup 重生成一次（违反唯一
  seal 后零写）——旧根不改原样保留；R58 报告日期 10-20 与 done 10-19 时间差、R56 引用
  131a 前缀错用——均如实记录，不为此单开 meta 轮；真实 R56 report=06f6515d。
- **待审关注**：a) ByteBudget 的 raw 双轨（identity 入本类/gzip 归泵）分源口径；b)
  mergeIssueIntoEntry 的 max(旧可信,新) 在两 cap 皆未来时取大——与“本次认证最可信”的
  语义张力（取大偏可用性，如实待审）；c) OwnedRenewTimer 非法 hook 停调度后的恢复路径
  （需重启/重新配置——fail-closed 设计如实）；d) dispose 在 #route 尾部（早期 return 的
  deny 路径由 cancelAndDeny 统一 disarm 覆盖，两段合取完整性待审）。
- S2 partial；B2 partial；S3–S6 pending、S7 gated；G1/G3/54m57s/4818 unknown 原样；旧
  full 实数不升级。source_ready 后 coor 封版，同一新 Grok 独审，继续 loop 不以本 doc 收尾。
