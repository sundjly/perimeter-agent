# S2-B2 修复轮（R57）：R56 required 1–5 + coor 漏缝 5/6/7 + driver 修正提案（task_7cb725e6c030 / ctx_eae4c36b8b29）

- 日期：2026-10-19。执行者：Pi（原 terminal/incarnation/model 未换）。性质：**零执行轮**
  （权限 (c) 不变）——零 Node/JS/tsx/tsc/TS API/Python(含 uv)/解释器编辑（含 sed/cat 读取
  以外的脚本行为）/heredoc/编译测试/网络/child/ps/signal/Docker/Git/demo/真实 timer/sleep/
  worker；仅 native read/edit/write + FS metadata + Orca 协调。typecheck/tests=**unrun/
  unknown**。生产 runner 冻结 6f4e2b0f 未动；R47-12 维持静态接受不扩 runner。
- 私根：/tmp/pi-r57-QVhJJYuq（coor 预置 0700；prov seq1/2 immutable 只追加）。baseline36 =
  R56 current35 + R56 report，baseline-paths/baseline-actual-source-sha256 双侧+二次源 hash
  全符；本轮将改 6 件事前复核 6/6 吻合（bounded-reader af830d31、gitproxy-server 23f9ec1b、
  gateway-server 75fb32e2、renew-policy 6358ef61、bounded-reader-test 6a134dda、
  renew-policy-test 3312ccd0）。R56 根 /tmp/grok-r56-hWSs3LXH（sealed 39/39、self
  8c278694…）只读未触；rejected-driver-r55.mjs 仅参考。

## 1. required 1–5 + 漏缝逐项（静态可验证）

- **1（文件级红 ×bounded-reader）**：ctor 参数属性改**显式私有字段声明**（`#src`/`#deps`
  + ctor 内赋值）——strip-only 可载、私有字段有声明、无 tsc 引用红。措辞精确纠正：
  原缺陷是「#private 未声明本身解析红」，不是「等 read 后 TypeError」；gitproxy 侧已执行
  的 `let src` 值 undefined 非 TDZ，重复 `const gate` 才是解析红——以本轮实际修法为准。
- **2（文件级红 ×gitproxy server）**：删除同块重复 `const gate` 第二行（其直传未赋值
  src），保留闭包延迟绑定 `{ read: () => src.read() }` 形态。
- **3（转发段 owned 截止 + 最早预算）**：`boundedRead` 的 `src.read()` 改经 **gate.read
  (min(headerBudgetDeadline, bodyBudgetDeadline))**——header/body 两预算取 min（最早预算
  约束 header 段），pending read 超时由 gate 唤醒 → fail 类别 + cancelSource；pending read
  非 deadline 失败也走 cancelSource（400 固定类别）。零窗 `>=` 拒在 gate 与入口双保留。
- **4（restore 字段 + null fail-closed）**：ctor restore 类型/校验/构造补 `maxExpAt`/
  `currentExpAt`（数值或 null 合法，缺失按 null，非法形态整批丢弃不半恢复）；**decideRenew
  对 null captured cap fail-closed 不续**（reason "unknown captured cap（fail-closed until
  fresh reauth）"）——重启后 null ≠ 可信无到期 identity 契约，直到同 owner fresh verified
  reauth（#renewGitGrant 开头 fresh 更新先于 decideRenew）；不再把 null 反复当 now+15min
  无限链，也不硬 15min 全 session（fresh 合法重认证即转正）。renew-policy.test 对应用例
  改为 fail-closed 断言。
- **5（browser save pending）**：`#saveSessions` 失败同挂 `#pendingLogoutPersistence`；
  `#flushPendingLogoutPersistence` 扩展为 git revoked tombstones 与 browser snapshot **独立
  尝试**（任一失败保留可重试状态；active 已删/cookie 已丢不影响补盘）；`#reap` 任何 await
  前调用（无论 gitGrants 是否配置都覆盖 browser）；close 的独立 finalizers 仍有最后
  flush/失败报告。logout 每 conn 的 closed/outbox.clear/ws.close **各自独立 try**（clear
  抛不跳 close，其余 conn 继续）；持久失败如实 disk unknown，重试恢复前不报成功。
- **6（cancel contain 统一）**：`cancelSource` 改**幂等 Promise 缓存**（后续调用 await 同一
  promise，不靠 bool 误认清理完成）；`src.cancel()/rawReader.cancel()` 全部 `.catch(() => {})`
  显式 contain（Web 语义 errored 后 cancel 返回 rejected）；pump 全部退出路径同改；registry
  reader.cancel、3xx upRes.body.cancel、res close/error 的 upRes cancel 同 contain——
  `void` 丢弃清零。
- **7（inline 同步 fire 重入）**：`#scheduleNextRenew` 加 generation 检测——内层同步 fire
  重建 slot 后，外层检测 gen 不符即 **clear 自己的 timer 丢弃**（内层句柄保留，最终恰一个
  可清 timer，不覆盖不 busy loop）；closed/配对 clear 保留。本轮非回归修复（R53/R55 两代
  同在的注入面，按原要求补齐）。
- **coor 漏缝 4 补充（全寿命 + 字节覆盖）**：prepare 建**一次性全寿命 timer**
  （`#deadlineArm`/`#deadlineDisarm`：fire → 固定类别 fail + cancelSource；disarm 独立
  clear 幂等）——**upstream 不 pull/backpressure 无 read 时也在唯一原请求绝对 body deadline
  触发取消/abort**，不留无界 fetch/泵/drain 等待；header 段 deadline =
  min(headerBudget, bodyBudget)（最早预算）；**decoded 总量把 header+同 chunk tail 一并
  计入**（cmdBuf+tail 初始化 decodedTotal，转发段续加）不漏 prefix/tail；identity 分支
  raw==decoded 同受 receiveMaxRawBodyBytes 约束（口径说明入 doc）；正常流读尽即 disarm
  （不误 fire）；取消/错误路径也 disarm。gzip raw 侧由泵 compressedBytes（header 8MiB +
  全程 128MiB）覆盖保持。合法 >64KiB PACK 保留（64KiB 只命令区，未全拒）。

## 2. optional 落地与措辞更正

- R55doc §1 C「save 失败时 cookie 仍被响应清除（500）」**失实更正**：500 分支无 set-cookie
  （browser.delete 内存先行已使旧 cookie 失效，安全非依赖清 cookie）；本 doc 为准。
- identity 分支无泵 → 无 compressed 计数（raw==decoded 由 64KiB header+128MiB raw 覆盖）
  口径说明；header/tail 计入 decodedTotal 说明（§1 漏缝 4）。
- 同步-fire 注入契约 + generation 防护说明（漏缝 7）。
- renew 失败恢复 old currentExpAt（漏缝 3，一行+旧值捕获）。
- 投递**成功后**的 flush/schedule 异常不再误作未投递回滚（R57-4 补充：try 块只含
  apply/save/writer；flush/schedule 独立 try 固定审计）。

## 3. driver-candidate-r57.mjs（新根，只写不跑，≤80 行；R56 §5 两点建议采纳、两点勿照抄）

- tap 接线：`const tapper = test_.tap(tests)`（AsyncGenerator）→ `for await (chunk of
  tapper) log.write(chunk)`（背压 drain 等待）+ `log.end` 等 close——**不用 new TapReporter**
  （tap 是函数非 class）、不用对非流对象 pipeline（按 @types/stream.d.ts 实测允许
  async-iterable 的口径以 for-await 消费，两形态均可，本候选取 for-await 直读）。
- 判负：唯一 overall `test:summary`（file===undefined）恰一个 ∧ success===true ∧
  counts.tests===EXPECTED_TESTS ∧ counts.tests===counts.passed ∧ cancelled/skipped/todo===0
  ∧ test:fail 计数 0；**不用不存在的 test:skip/todo/cancel 事件**；EXPECTED=48 手工
  grep '^test(' 逐 suite 核对（5/13/11/10/4/5）。
- guard 自最早 T0 arm `9_000 − elapsed`（≤0 即 124）先于动态 imports（无静态 imports）；
  runtime `process.versions.node` major≥24 检查；ROOT=`R57_RUN_ROOT` env（coor 未来独立
  fresh 执行根，非本 sealed 根）+ 0700/nonsymlink 检查 + log `wx` 0600；fresh wall 在
  TAP 写完 + fd close 之后；错误输出也在预算内。**实际父 shell wait/执行由 coor 另审，
  未运行=unknown。**

## 4. 三态与状态（不预勾）

- **source 已落**：§1 所列（实际 diff 为准）。**unrun/unknown**：typecheck、全部 unit
  （READY 面：grant-rotation 4 / renew-policy 10 / credential-domains 5 / bounded-reader 5
  / gitproxy-receive-pack 13 / git-grants 11——后两文件红已除后恢复候选，待静审确认），
  driver。**pending**：17 项真实验收/P1/真实 gzip push/3HTTP/demo；**外部**：mTLS/KMS/
  上游保护/IdP/CNI/DPA/WORM/soak 原样。
- **待审关注**：bodyLifetime timer 在流读尽 disarm（正常路径）与 cancel/错误路径 disarm
  的覆盖完整性（forwarder onCancel 内已含）；identity raw 上限与 decoded 上限的双轨口径；
  restore null 语义与 computeGrantExpiry null（15min 锁）的差异已显式注释（restore 后
  decideRenew 先 fail-closed，两层防线）。
- S2 partial；B2 partial；S3–S6 pending、S7 gated；G1/G3/54m57s/4818 unknown 原样；旧
  full 实数不升级。交本 coor 实际静查后同一新 Grok 增量复审，继续功能 loop。
