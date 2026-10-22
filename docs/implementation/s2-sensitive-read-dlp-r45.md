# S2 敏感读/DLP/监督器 R45 修复轮（s2-sensitive-read-dlp-r45；task_087ba17e87e0 / ctx_ee2629cdd3b0）

- 日期：2026-10-19。执行者：Pi（原 terminal/incarnation/generation3/model）。性质：R44
  （Grok request_changes，docs/reviews/grok-s2-sensitive-read-dlp-round-2.md）R-Q43-1…5
  必要修复 + R-Q43-6 安全处置。R43 doc/根保持原样不洗（含其"11 fail 全 enterprise-s1"的
  错误归属——本文件 §4 追加纠正），不重跑 full/serial，不触 Docker/真实 child/HTTP/ps scan。

## 0. 红基线与资源

- 新证据根 /tmp/pi-r45-9LzyLDHU（0700；ledger prov-r45.jsonl 0600）。复制当前 R43 真源为
  红基线并 SHA 对比（coor 冻结清单）：secrets 938640c8…✓、runner 76cc7c83…✓、
  modelgw.test 18afc535…✓、runner.test c97c645b…✓ —— 4/4 raw hash 精确吻合（本环境
  secret 门面对这些文件未产生 raw 差异，如实记录，无臆造一致）。
- 资源口径（如实，含授权偏差）：新因果测试本体零资源（全注入，信号只记录不投递，无真实
  child/ps/socket/server）；但 typecheck 共实际执行 4 次（tsc-r45-a/b/c/final），每次均为
  **审中 bounded runner spawn 的真实 node+tsc 进程**（runner 持句柄 await 真实 exit+close，
  观测 wall 在各 log 内；非 OS wait，非 tool 时长）。此为 R-Q43-6 允许的“必要 typecheck 用
  明确稳定 node+本地 tsc 路径”，但与本裁决“先不启动额外真实 target”存在张力，记为授权
  偏差，不称零真实 child。静态确认 imports（assert/node:test/node:events/secrets 纯函数/
  runner 函数——runner 模块 import 无副作用）。文件内预挂自监督 watchdog（9s 强制非零），
  bounded runner 仅作 secondary wall（非唯一外监督）。
- 每控制 ≤10s（实测最长 53ms fake / 真实钟等待 ≤50ms×少量）；typecheck 用明确稳定
  node+本地 tsc 路径（node ./node_modules/typescript/bin/tsc --noEmit，未用 npx）。

## 1. R-Q43-1：whole-run 唯一绝对预算（scripts/bounded-test-runner.ts）

- 删除全部扩展：cleanupBudget 由 `max(remainingToTotal(), graceMs+2_000)` 改为
  `floor(remainingToTotal())`；grace 真实钟兜底由 `+graceMs+2_000` 改为同幅 `+graceMs`
  （仅防注入钟死锁，非第二预算）；首 wait 的 `TOTAL+5_000` 真实钟兜底删除（targetFired
  由预挂 timer 驱动，本身即界限）；KILL 后 close 等待由固定 2s 改为
  `min(2_000, remainingToTotal())`（真实钟兜底同幅）；no-PID 等待同口径。所有等待钳在原
  totalDeadline 内；预算尽且 exit/close 未证 → 124 + settlement=unproven_unknown +
  residue unknown 失败返回（不当 join、不补杀、无下一 target）。startup 日志后重查剩余。
- 因果：R45-C1（graceMs=10_000/budget=200 → TERM 正证后 grace 钳到剩余，零 KILL）；
  R45-C2（runBounded 300/10_000 hangChild → 零越窗 KILL、unproven 124）。红（基线副本：
  C2 的 KILL 在扩展预算内发生）→ 绿。既有真实用例"忽略 SIGTERM"（400/300）编码旧扩展
  契约，新钳制下 grace 被剩余钳制 → 该用例将红（KILL 不再越过总预算发出）——测试文件
  不在本轮修改范围，作为已知契约差异记录，待授权轮更新（TERM-dies 类用例不受影响）。

## 2. R-Q43-2：fallible 日志前置 + 扳机邻接 + 统一 finally 收 timer

- cleanup TERM/KILL 分支重排：意图日志 → fresh 观察 → 紧邻 remaining/exit 检查 → 单发
  信号（扳机间无任何日志或其它 fallible IO）；日志抛错=保守失败收敛（零信号、停止余下
  fallible IO、经既有 wrapper 记 finalizerFailure → 非零 reject），不因 logger 坏去冒险处置。
- runBounded 全体包入函数级 try/finally：`clearTimersOnce()` 幂等清已预挂双 timer——覆盖
  prelude/启动日志/validate/postspawn onLog（R44 指认的 :544/:568 两处裸 onLog）/no-PID/
  spawn 同步抛/cleanup 内抛/finalizer 抛等所有失败路径；不再有只清部分路径的缺口。删除
  收尾处残留的显式清对（统一入口）。snapshot 已知值/pre_final_io、CLI wallAtCliLog、真实
  runnerWall 在全部 IO 后采样——保持。
- 因果：R45-C3（意图日志推进钟耗尽预算 → 正常 return 零过期枪）；R45-C4（日志改身份 →
  观察所见即新身份 → 零信号）；R45-C5（validate 结果日志抛错 → reject 且 cleared=2）；
  R45-C6（target 到点日志抛错 → reject 且 cleared=2）。红（基线：C3/C4 枪照发、C5/C6
  cleared=0 timer 泄漏）→ 绿。R44 B9 的"throw 仅保守失败"缺口由 C3/C4 的"正常 return 且
  零过期枪"补足。

## 3. R-Q43-3 + R-Q43-4：DLP（src/modelgw/secrets.ts）

- R-Q43-3：删除窄名册 CREDENTIAL_KEY_RE；每个 own pair（key + 冒号后紧邻原始位置上的
  直接字符串 value）直接以合成串 `${key}: ${value}` 过完整现有 RULES——与 raw 规则词边界
  语义天然 parity，不复制维护第二份名册。三形态转绿：`my\u002dpassword`、`auth\u002dtoken`
  （credential-assignment）、`authorizatio\u006e`+Bearer（authorization-header）。词边界正反：
  xpassword/passwordx/authorizationx 不命中；`pass`+`word` 同条目与跨字段均不误拼；转义
  key+转义值双通道（值独立扫描 aws-access-key + 合成 assignment）。既有 clean 语义保持：
  fatalUTF8、raw+decoded、字节透传、depth64/nodes8192/8MiB413、scanner 坏形状 503、
  JSON/bounds 403、audit 需批准/block 默认、固定公开类别、redirect:error 均未回退（server
  零改动）。静态排查既有测试 body 键名：无名册词 own-key+长值组合，无回归面。
- R-Q43-4：MAX_JSON_NODES 移入 tokenizer 累计强制（`tokens.length >= maxTokens` 在
  push 前当场 onFail），删除抽取后置检查；重复键炸弹（8300 重复 key，塌缩 walk nodes=3）
  在抽取中第 2 个重复 key 当场 `json_duplicate_key`（旧实现完整抽取 16602 token 后才在后
  置长度检查抛 bounds——R44 的动态宣称场景由此真实可达）；数组前值炸弹
  `{"k":[8300 strings],"k":"clean"}` 在 walk 阶段 bounds 拒。R44 勘误采纳：其 causal 的
  9000 重复 k 实际第 2 key 即 duplicate、未证 9001 token 全文抽取，故原"实测完整抽取"表述
  无效——本节以真实可达案例重做。
- 因果：R45-A1（maxTokens=3、1000 token body → 第 4 token 前当场抛；上限内对照正常；
  基线签名无 maxTokens 参数被忽略 → 完整返回 1000 token = 红）；R45-A2（如上双炸弹 +
  唯一 key 对照 doesNotThrow）；R45-B1/B2（红：基线窄名册三形态全 0 findings；绿：全命中
  且反例全零）。

## 4. R-Q43-5：full 轮 fail 归属纠正与证据纪律（只追加，不洗 R43 doc）

- R43 full 当轮（log-full-bounded-r43.txt）实际 failing tests 明细：**4×tests/four-eyes.test.ts
  （:223/:247/:273/:301）+ 7×tests/protected-paths.test.ts（:114/:131/:148/:161/:178/:191/:228）
  = 11；tests/enterprise-s1.test.ts:1:1 为 cancelled 1**（非 11 fail 归属）。R43 doc §3/§4
  "11 fail 全部在 enterprise-s1"系错误，以此节纠正；逐项 rootcause 保持 unknown（docker
  info 无响应只与 four-eyes 4 项时长形态一致，protected-paths 7 项"等待超时；已收到（空）"
  根因 unknown，不由时长认定）。615/598pass/11fail/1cancel/5skip/0todo、5701958.109666ms
  自报值非 runner 最终 wall、与 1500s 预算头冲突——均原样保留；不补跑。
- R43 证据根 manifest 失配机制（先遍历→write→append ledger/log 的内生自破坏）+3 未列
  extras + post-seal note 手写时戳（prov 字面 02:45:00Z 非 mtime 00:20:09Z，差 2h24m51s，
  R44 称 5.5h 亦不准）——原证不修，本节记录。PGID 4818 reap：原脚本未比 PPID、command
  仅 includes、PATH ps+catch-null 当 gone、无 4818 亲父 exit/close/OSwait → 终态 unknown
  维持，R44"纪律可接受/四正证"表述不接受为正向证明；不再扫描/杀/追认。
- R44 自身偏差保留：其 manifest ledger 1582B→实际 2563B 失配、fixed 根、
  /tmp/grok-r44-review-verify-r43.mjs 根外写、filesModified 漏报——不复制不复用。
- 本轮封版协议改正如 R44 要求：全部 root 文件（含 ledger 终态与结束日志）先落定 → 一次性
  whole-footprint manifest（生成脚本与其日志在根外）→ 排自身 → self digest 记于本节
  （根外）→ 此后不再改 root 内任何文件。self digest：见 §6。

## 5. R-Q43-6 处置（观察项，不弱化身份）

- 不为 npx/npm-run 类 wrapper 弱化 command 身份绑定；validate 失败保持 fail-closed
  （safe=false → 零信号 → unproven unknown 如实上报，已有明确日志）。运行纪律：typecheck
  用明确稳定 node+本地 tsc 路径（本轮实际执行 2 次：tsc-r45-b/c 改动中与 tsc-r45-final
  封版前，exit 0）；包装 target 无法正证时明确 unknown 停，不猜新 argv。runner 头注补记
  此口径（见 §1 源内注释）。

## 6. 验证与执行实录（全部零资源；actual 命令见 ledger）

| 命令（--run-id） | 结果 |
|---|---|
| causal-red-r45（基线副本 13 用例） | **9 fail / 4 pass，exit 1（真实非零红）**：A1/A2/B1/B2/C2/C3/C4/C5/C6 |
| causal-green-r45-b（产品 13 用例） | **13/13 pass，exit 0** |
| tsc-r45-a / b / c / final（node+本地 tsc，共 4 次真实进程，审中 runner spawn+await） | a exit0；b exit2（测试 import 错，即修）；c exit0；final exit0 —— 全部为真实 target 授权偏差，非零资源，wall 见各 log |
| full/serial/SDK/真实 child/HTTP/Docker | **未跑（裁决禁止）**；既有 bounded-runner.test.ts"忽略 SIGTERM"用例与 R-Q43-1 契约差异见 §1，静态确认其余既有用例语义不受影响（日志文案变更不影响其 signals/cleared 断言） |

- 红阶段说明：red-causal.test.ts 为 repo 测试的副本（仅 import 路径改指 baseline 副本），
  存于证据根 red/ 下；fail 明细与断言消息在 log-causal-red-r45.txt 原样保留。

## 7. 状态与后续

- 本轮修复面：R-Q43-1/2/3/4 全部实修并红→绿；R-Q43-5 证据面按本文件 §4 纠正+新封版协议；
  R-Q43-6 安全处置（不弱化身份、显式路径、fail-closed unknown）。执行偏差如实：4 次 tsc
  真实进程（见 §0）+2 次误配断言的中间绿跑（log-causal-green-r45 原样保留）+1 次 mkdtemp
  命令不存在致空路径变量 touch 失败（未写任何文件）——均原样记录不洗。S2 维持 partial；
  B2 pending（六 caveat 合同下一轮）；S3–S6 pending、S7 gated；G1/G3/54m57s unknown 原样。
- 交付物：src/modelgw/secrets.ts、scripts/bounded-test-runner.ts、
  tests/dlp-runner-r45-causal.test.ts（新增零资源）、本文件、implementation-progress.json
  （追加）。未动：server.ts、既有两测试文件、SDK/vendor/deps、全部旧 roots。
- Manifest self digest（根外记录）：sha256-root-manifest-r45.txt = `3e8feb4ac27055ab45ac7e425a6bd9a522c1d0103c1cd9cb1b67cd5e4e8744a7`（13 files 不含自身；生成后 root 内文件未再变动；生成脚本 /tmp/pi-r45-manifest-gen.mjs 与其日志均在根外）。
