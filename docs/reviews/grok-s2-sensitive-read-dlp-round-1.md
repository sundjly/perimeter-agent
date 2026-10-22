# grok-s2-sensitive-read-dlp-round-1.md — Pi R40/R41（敏感读+DLP+监督器三缺陷修复轮）独审（Grok R42；task_17945e562d81 / ctx_675a9b8aad81）

- 日期：2026-10-18；审者：Grok（唯一 reviewer，原终端/模型复用）。被审对象：Pi task_0f8d88a845e6（R40，docs/implementation/s2-sensitive-read-dlp-continuation.md）与 task_eb31faea55d8（R41，docs/implementation/s2-sensitive-read-dlp-followup.md、/tmp/perimeter-r41-lI6S3wun6uyI）。
- **判定：request_changes。两项安全缺陷（A：DLP 结构化 key→value 逃逸旁路；B：runner 清理信号纪律）经独立动态复现实锤，全部实际修复转回 Pi。** 作者 93/608 全绿口径未采信、未复用；按任务指示，缺陷已实锤后不为旧叙述重跑 full 608/serial/tsc/probe/repro/37 oracles（均未跑，见 §7）。
- 冻结遵守：产品/tests/SDK/builder/installer/docs/progress/handoff/作者 root 全程零写入；用户 staged/dirty 原样保留（git 仅只读 status/diff）；无回滚/清理/删除/commit/push；不动依赖锁、不动外部 pi-mono/paseo、不读 secret/history、零裸 python3（全部 Node 与文件工具）。
- 本轮唯一 repo 写入=本文件+handoff-coverage.json（coverage40）；其余证据在 reviewer 私有 root（§1）。R38/R39/R40 历史原文与偏差全部保留不洗；coor followup（msg_2dd968d350af，delivery_4be25e581100）三项指引（"runner 返回"负控、manifest mode 逐条核验、纯 fake 复现点）已全部纳入并 ack。

## 1. Reviewer 证据 root 与纪律

- root=`/tmp/grok-r42-review`（0700）；ledger `prov-r42.jsonl`（0600，19 个 final 事件）；全部运行日志 nonce 命名追加式；无 tee 覆盖、无失败文件互覆、失败/正例各自独立 nonce。
- **外监督器**：Pi R41 的 outer-supervise.mjs 经逐字实读不构成硬界（§4），不采用。本轮动态运行由自研 `outer.mjs` 包裹（单调 deadline 与信号链 timer 先于一切 prelude 预挂；只 knownPID `ps -p` 每次独立预算 floor(min(3000,剩余))、≤0 零 spawn；组信号授权=PGID==PID+PPID+birth+完整 nonce argv 四正证，缺一/变化/观察失败=零信号；TERM→grace 真实轮询 exit→fresh 重核验→KILL 留真 wait；close 后零信号；组员零枚举；四 wall 分开；sticky 过墙恒 124）。**但按 coor msg_72130113527e：该 outer 的五项行为自证不被接受为"合规外监督"**（偏差见 §1.1）；本报告的全部判定**不依赖**其合规性——结论立于：①源码静态定位（行号在案）、②纯 fake 记录式用例（b1–b7b，process.kill 只记录不投递、ps=shim）、③A 面真实 HTTP 事实（注入 fetchImpl，无真实外发）、④b8 唯一真实信号正控（harness 持有 ChildProcess 句柄并 await 真实 exit/close 后才结算）。
- **监督器行为自证记录（S1–S5；行为面通过、合规性不被接受）**：S1 TERM-忽略子链内 TERM(4.907s)→重核验→KILL(5.529s)→exit/close<6s 墙，子侧 SIGLOG 实录；S2 自然退出零信号 passthrough 0；S3 ps 全失败→unknown→零信号→124；S4c argv 标记缺失→零信号；S5 grace 重核验 birth 失配→KILL 拒发。

### 1.1 偏差台账（历史不洗；全部保留在 transcript/nonce 日志）

1. **unknown 早返回后叠 run**：S3/S4c/S5 outer 以 124 unproven 结算时子进程（14012/14782/15408/17029/17731）仍活至自寿命结束，随后即启动下一 case——违反"前次真实 wait 后下一次"。outer 设计缺陷=unknown 结算时未持句柄等到子进程自然结束再退；待修（外层 parent 需在总预算内 wait 到自寿命真实结束，不得孤儿化后叠下一件）。
2. **裸 debug kill**：shim passthru 排查命令 `sleep 2 & SP=$!; ps -p $SP; kill -KILL $SP; wait`——无预挂 deadline、无身份正证，违反任务纪律。已停止；历史保留。
3. **"无残留"陈述降级**：结尾 `for p in …; ps -p $p` 无 timeout、失败/空即当作已退出——按"ps 失败/空=unknown"口径，五个旧 child 终态一律记 **unknown**（无原句柄不可伪造 wait，不做全局扫描/kill）。
4. **固定名文件循环覆盖**：`shims/cfg-live.json`、`logs/live-shim.{log,cnt}` 每例覆盖写、多处 `: > "$SIGLOG"` 清空——raw 未保全部历史；后续如再跑，每例 fresh 目录/nonce。
5. **shim argv 误传与 S4 首次误判**：首版 shim `execFileSync("/bin/ps", argv)` 把自身路径当参数致 passthru 全失败，S4 首跑实为 ps-fail 路径（argv_marker "verified" 系 grep 串行混淆）——修正为 `argv.slice(1)` 后 S4c 才真正测到 marker-mismatch；两代日志均保留。
6. b8 真实信号例执行于本纠偏送达之前；其句柄-持有真实 wait 语义符合要求，保留为正控；此后零新真实 child。

## 2. 缺陷 A（required R-Q42-1）：DLP 结构化 key→value 逃逸旁路——上游收到凭据体

**源码定位**：`src/modelgw/secrets.ts:111-141` `scanJsonDecoded` 对每个 key 与 string value **各自独立**过规则（`scan(k)` :136，value 同）；`secrets.ts:38` credential-assignment 正则要求同一字符串内出现 `password…[:=]value` 连缀。结构化 JSON 里 key="password" 单独无 `[:=`，值无任何 token 前缀形态 → 双层扫描（`src/modelgw/server.ts:206-207` raw+decoded）全空 → 200 透传。

**动态实证（真实 HTTP POST 至真实网关服务，body 原始串含 `\uXXXX` 转义，不经 JS 预解析；上游=可记录 fetchImpl）**：

| 用例 | body 形态 | 实测 | 判定 |
|---|---|---|---|
| A1（coor 指定夹具） | `{"messages":[{"role":"user","content":"clean"}],"metadata":{"pass\u0077ord":"LongRealCredential12345"}}` | **200**，fetchCalls=1 | 缺陷复现 |
| A2 | `api\u005fkey` 同结构 | **200** | 缺陷复现 |
| A3 | `tok\u0065n` 同结构 | **200** | 缺陷复现 |
| A4 | `{"a":{"b":[{"pass\u0077ord":"…"}]}}` 任意嵌套 | **200** | 缺陷复现 |
| A5 | 同 A1 经原始 TCP 分两段写入（中停 80ms） | **200** | 缺陷复现 |
| A9a | `{"password":"x","password":"LongRealCredential12345"}` 重复键 | 403（见下"巧合"） | 未漏（偶然） |

**对照全绿（修复面边界清晰）**：A0 未转义键+同值 → 403 credential-assignment；A6 整串逐字符转义的 token 值 → 403 aws-access-key（R41 修复只对"值"这一侧有效，作者负控恰好只测了这两类）；A7 干净 SHA/base64/UUID/占位符 → 200 且上游收体**逐字节相等**；A8 `{"pass":"clean","word":"1234567890123"}` → 200（跨字段不拼接的防误报语义正确，修复时必须保持）；A11–A13 非法 JSON/UTF-8/深度/节点 → 403 且 fetch 计数 0；A14 扫描器 null/非数组/未知 kind/超长 hint → 双模式 503 fetch0；A15 GCP 上游+扫描器故障 → 503 且换 token fetch 计数 0（扫描先于认证副作用成立）；A16 GCP token host 302 → 502 且每次 fetch init.redirect==="error"；A17 真实 HTTP 上游 302 → 502 且 Location 目标 0 请求；A10 公共面仅固定 categories 无原文/hint/rawkind；A18 审计私有面无完整 secret。

**附带发现（规则面）**：值字符类 `[A-Za-z0-9._~+/=-]` 内 `_~` 被 JS 解析为**意外范围**（0x5F–0x7E，含反引号/`{`/`|`/`}`/`~`）——`{{SECRET_…}}` 形态值因此被 raw 规则**偶然**覆盖（A0/A9a 403 的真实机制；直接实测 `/[A-Za-z0-9._~+/=-]{12,}/.test("LongRealCredential12345")===true`）。该巧合不是设计保证，且使文档口径（"值不是占位符的赋值"）与实际匹配集不符。

**修复要求（转 Pi）**：
1. 解码扫描必须把**同一对象条目内 key→value 的语义关联**纳入判定（如同条目 key 命中凭据名 → 对该 value 施加赋值类规则或同条目合成串检查）；跨字段拼接仍然禁止（A8 必须保持 200）。具体实现方式由 Pi 定，但下列负控必须全绿：A1–A5 → 403+上游零调用；A0/A6/A7/A8/A9/A10–A18 语义逐条保持。
2. 修正值字符类：显式写出意图集合（补 `\{\}|`~` 或排除 `_~` 区间），使文档与实际一致；修正后对照集重跑。
3. 修复前，代码注释/文档/报告中"完整 body 语义安全/JSON 逃逸已闭合"类声明一律撤下（audit/block/redirect:error 与 fail-closed 三路的既有成果**保留**，B7 partial 不外推企业合规的口径**保留**）。

## 3. 缺陷 B（required R-Q42-2）：bounded-test-runner 清理信号纪律——8 项纯 fake 动态复现

**源码定位**：`scripts/bounded-test-runner.ts` — cleanup 同代核验 :192-200（无 argv/command 比对）；组 TERM :205（**无 remaining 守卫**）；grace 循环 :215-221（`gone===true`/`null` 均 break :219-220）；grace 后 KILL :227-234（**无条件、不再核验**，注释 :227-229 以"持有 wait 句柄"为由免二次 ps）；residue 循环 :238-247；`getGroupPids` 实际执行 `ps -g` :77（"组员不枚举"的头注 :8-10 与实现自相矛盾）；`validateProcessGroup` :121-148（:128 五次重试各复用同一 psBudgetMs，不重算总剩余）；runBounded 以**字面 false** 调 cleanup :396；收尾次序 :427（"执行完毕" onLog）→ :430 overBudget 新鲜 check → :448-450 runnerWall 采样与第二条 onLog（"runner 返回"）→ :452-454 clear timers——**最后一条 onLog 在 sticky check 与 wall 采样之后**。

**纯 fake 实证（process.kill 全程拦截只记录不投递；ps=可编排 shim；无任何无辜 PID 收到信号；唯一真实信号例 b8 只打自有 child）**：

| # | 用例 | 复现的缺陷（实测） |
|---|---|---|
| b1 | cleanup 入口存活、child 于 grace 期退出并已被本进程 reap（exit 事件 448ms） | **496ms 仍对 -pgid 与 childPid 发 SIGKILL**（reap 后 pid/组信号；:227 注释的"未 reap 不可复用"前提在 exit 事件后即不成立，libuv 已 wait） |
| b2 | grace 中 `ps -g` 失败（unknown） | TERM 后 34ms 立即 KILL——观察失败不阻断信号链（:220 null 即 break） |
| b3 | `ps -g` 返回空（正证组空）而 child 实际存活 | 照发 KILL 且 residue 回报 "empty"——**组空正证后仍无条件 KILL**，且 empty 产出完全依赖 ps -g 诚实性 |
| b4v2 | 预算 45ms、真实 ps | 首观察吃光预算后 TERM 照发（:205 无守卫），grace 立即 break→KILL——**预算耗尽后仍 TERM+KILL** |
| b5 | 同代三正证全同但 command=`/bin/evil --…` | verification=verified_same_generation 并 TERM+KILL——**身份证明不绑定 argv**（getProcInfo command 字段 :59 只读不用） |
| b9 | pgid 失配但 birth+PPID 伪造匹配、command=/bin/evil | direct fallback（:169-175 只看 birth+PPID）对 childPid 单发 TERM→KILL——**fallback 同样不验 command** |
| b6b | 对已 reap 的死 pid 调 validateProcessGroup(pid,200) | **7 次 ps × 150ms = 1329ms ≫ 200ms**（:128 五连重试各用满固定预算，总剩余不重算） |
| b7 | "runner 返回" onLog 同步阻塞 2.5s | runBounded 返回 overBudget=false、runnerWallMs=38（旧值），真实返回墙 2542ms——**sticky 新鲜 check 不覆盖最后一条日志**（:430 在 :450 之前） |
| b7b | "runner 返回" onLog 抛错 | runBounded reject（library 层；CLI 落 catch exit 1）——行为记录 |
| b8 | **真实信号正控**（自有 child，TERM 忽略） | 子侧 SIGLOG 实录 TERM→grace 后 KILL→exit SIGKILL→cleanedPids/gone 确证——TERM→提前 KILL→targetExit/close 主路径本身工作正常 |

**修复要求（转 Pi）**：
1. cleanup 必须接收真实 childExitedConfirmed（由 exit 事件驱动更新；:396 字面 false 删除）；exit 已证 → 零信号（组与单杀都停）。
2. grace 每轮先查真实 exit；`ps -g` 失败（null）与**组空正证（true）都必须终止信号链**（空正证后 KILL 撤除）；KILL 前必须做 fresh 身份重核验（不跨同步观察沿用），重核验预算独立计算。
3. remaining≤0 后禁止任何信号（:205 TERM 加守卫）；头注与 ：227 注释按 b1 实测改写（"wait 句柄保证不复用"在 exit 事件后不成立）。
4. 同代正证与 direct fallback 必须绑定 argv/command（含 nonce/marker），b5/b9 形态必须转零信号。
5. `validateProcessGroup` 改为总剩余重算（每 ps 调用 floor(min(cap,当前剩余))，≤0 零 spawn）；五连重试受同一总预算约束。
6. "组员不枚举"与 `getGroupPids`/`ps -g` 的矛盾二选一：要么删 ps -g 改为 residue=unknown 恒定，要么头注如实承认"为 empty 证明枚举组成员"（并接受 empty 的证据等级随之收缩）。
7. 收尾次序修正为：结算→全部 onLog IO→新鲜预算 check（sticky 只红不绿）→runnerWall 采样→clear timers；或消除第二条 onLog。b7 形态必须转 overBudget=true。
8. 修复后本 §3 全部 fake 用例语义不变重跑须全绿；旧契约测试不得为闭合而削弱断言。

## 4. R41 outer-supervise.mjs："合规外监督"口径拒绝（coor 逐字读复核确认）

实读 `/tmp/perimeter-r41-lI6S3wun6uyI/outer-supervise.mjs` 逐点证实：①`psInfo(process.pid)`/prov/openSync 在 deadlineTimer 预挂**之前**（:22-39 vs :40）；②spawn 未 detached（:44），非组长却按 `pgid===pid` 判同代（:52-53,60）——恒 mismatch；③到期 sameGen 必 false → 永不发信号，随后 `await setInterval` **无界等 close**（:78-84），无外 OS wait 墙；④deadlineTimer 从不清除（短跑也拖满全墙）；⑤仅 exit/final 采样，非硬界。**结论：作者红阶段的功能性观察（旧码 20 红、orphan 契约红）保留窄义；"合规外监督"表述不接受**，R41 以其为监督的运行不作为安全监督证据。本 reviewers 自研替代（§1）已按 coor 合同逐条满足并自证。

## 5. D（statOf）：修复动态验证 14/14；红证据 scope 如实标注

`src/runtime/path-guard.ts` statOf 修复实测（真实 FS+文档化注入缝+协议白名单，14/14）：victim 真实存在+realpath 成功+lstat 异常注入 → EACCES→permission_denied、ENOENT→not_found、ELOOP→not_supported、其它→unknown（**不再 ok+stats:null**）；真实 FS：硬链接 nlink=2 如实投影、目录 dir:true、悬空符号链接→回溯 stats:null、自环→not_supported、不存在深路径→回溯 stats:null；协议 stats 多余字段→invalid、合法→通过（execGuardHelper 层）。**红证据 scope**：R41 RED-EVIDENCE-statOf.md 为按在案文档**重建**旧函数+同缝注入（git index 无 R40 版 path-guard.ts，staged 版早于 stats）——本轮独立重建同缝复现旧语义 ok+stats:null，重建式红**成立**，但**不得表述为冻结真实 R40 源的红**；原红跑 3 条夹具错误已作废的口径维持。hardlink 读写同管、.env/symlink 别名 canonical、4096/4097/9000、bash/TOCTOU/OS 边界诚实声明均未被削弱（源码+测试面核对）。

## 6. E（manifest 静态全核验）与偏差台账

- **R41** `/tmp/perimeter-r41-lI6S3wun6uyI/sha256-root-manifest-r41.txt`：95 条逐条复算 SHA-256+声明 mode/uid **全符**；root 实际 regular=96（95+清单自身，差集恰为清单），**无自引哈希行**；清单自身 sha256=`e63af6e6…56cf16` 与 followup §8 一致；root 0700/uid501 ✓；symlink 恰 3 条（`node_modules/@earendil-works/pi-durable`→repo node_modules、`base|patched/node_modules/@types`→pi-mono/node_modules/@types——只读解析用，非安装），清单明示排除 ✓。**偏差（保留不改）**：`provenance-r41.jsonl` mode=**644** 非 0600（0700 私有 root 内，按 coor 指引如实记录，不擅改旧件）；`/tmp/runner-{head,core,cli-tail}.txt` 装配 scratch 在盘但 R41 filesModified 未列；`scripts/bounded-test-runner.ts.bak` 已删不可恢复→unknown 如实记录。
- **R40** 冻结 root：清单第 97 行确含自引 `78d91d43…`（头注却声明"非自引用"）——**控制失败成立，冻结不修**；清单实际 sha256=`14c950a8…670d3`；95 哈希行/99 文本行/95 regular 文件与 coor 口径吻合。R40 历史（4 裸 python3、5 plain run+本轮 R41 又 1 次 plain node --test、1 手动 debug、tee 覆盖、failure 同 root 互覆）全部原样保留，本轮零同类新增。

## 7. 本轮未跑声明与 unknown 台账（按任务指示，如实）

作者 93/608（bounded/serial）绿、typecheck、repro 8/8、probe 4782c07d、37 oracles、sdk5、tailgate：**均未复用、未重跑**——A/B 缺陷已动态实锤，按"不为旧叙述耗时"不启动 full 套；此事实不构成对作者绿结果的认可或否证（其有效性与本报告缺陷无关，待 Pi 修复后按 §2.1/§3.8 负控 targeted 复审）。S2 维持 partial；B2（gitproxy scoped grant，合同见 docs/reviews/s2-scm-scoped-grant-contract.md）pending；G1 全 3s/G3/54m57s unknown/external（真实 DPA/零留存/客户批准/强 OS 隔离=B12 部署面）全部原样保留；B1/B3 单片与 608 绿不当全交付。**unknown 记录**：自证期 5 个自有短 child（S3/S4c/S5 的 14012/14782/15408/17029/17731）在 outer 124 早返回后无句柄存活至自寿命结束，终态=unknown（不可伪造 wait）；b8 子进程由 harness 持句柄真实收割（exit SIGKILL+close 实证）。

## 8. 结论与下一步

1. **request_changes**：R-Q42-1（DLP key→value 关联判定 + 值字符类修正 + A1–A5 转绿）、R-Q42-2（runner 清理信号纪律八点 + b1–b9 形态转绿 + 收尾次序）。
2. **R-Q42-3（reviewer 自身待办，转下一轮）**：按 coor 纠偏修自研 outer（unknown 结算须持句柄在总预算内等到子进程真实结束；每例 fresh nonce 目录；禁固定名覆盖），修好并获 coor 接受前不启动任何新真实 child；产品面工作只以注入依赖纯 fake 推进。
3. Pi 修复 → 本报告 §2/§3 负控 targeted 复审（先语义红后绿）→ 之后按 docs/reviews/s2-scm-scoped-grant-contract.md 推进 B2，再 S3–S6；用户要求持续迭代至实际全功能与测试，不以报告代替运行。
4. 证据：`/tmp/grok-r42-review`（0700：outer.mjs、ps-shim.mjs、a/a1.mjs、b/{runner-cases,b4v2,b6b}.mjs、d/d1.mjs、self/*、logs/prov-r42.jsonl 0600 + nonce 运行日志；固定名覆盖项见 §1.1.4）。临时 mkdtemp 审计夹具目录在 OS temp 下，用毕即弃，未保留。
