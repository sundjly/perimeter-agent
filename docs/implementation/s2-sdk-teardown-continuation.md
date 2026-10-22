# S2 SDK teardown 结算硬化延续轮（s2-sdk-teardown-continuation；task_1d32155f0dd9 / ctx_0721875c1303）

- 日期：2026-10-18。性质：S2 SDK blocker（vendor `Connection#teardown` post-state 异常分支，此前多轮标记
  「owned 不可修/需另 SDK 授权」）经最新用户授权后的最小实现 + 受控真实测试收敛轮。前置审批链：Grok R20
  静态窄批准（docs/reviews/grok-s2-sdk-session-pin-round-20.md）+ 本轮用户指令（可最小编辑 repo 产品/测试/
  SDK patch/vendor 生成物/builder 必要校验/文档；可执行有界模型/oracle/真实现有 Docker 测试与 typecheck/
  full test；仍禁止修改外部 pi-mono/paseo、装依赖、改锁、commit/push/reset/stash/clean）。

## 0. 结论速览

| 项 | 本轮前 | 本轮后 |
|---|---|---|
| vendor teardown post-state 异常分支 | blocked（end/kill 同步抛 ⇒ pending 永不 reject、重试 close no-op） | **已修**（独立 finalizer；故障注入 5/5 实证） |
| SDK 源管线 | 读 pi-mono 工作树（已 drift 到 8efd314fa，builder 实际不可运行） | **pin cdaf6c227 + git apply 本仓 patch**（patch 是唯一事实来源；外部 drift 不入生成物） |
| repro（cdaf+patch→dist 逐字节） | 47c6b1de（旧 patch） | **exit 0**（新 patch：4/4 base==original + 4/4 patched==dist） |
| SDK5 真实行为 | 未跑（blocked 于 54m57s unknown + 执行授权） | **5/5 behaviors pass**（exit 0，wall 5997ms，cleanup all-settled） |
| Docker owned probe | 未跑 | **生命周期 pass**（run→inspect→driver 正向 join→rm→inspect-gone） |
| 四 oracle（tailgate/wholetimer/joinfb/purefake） | 准备未运行（且静态件含从未暴露的机械缺陷） | **r8 红对照 ①②⑤红 → 适配版绿 36/36** |
| 全套件 | 544×2 历史（部分 fail 口径在案） | **564/564 pass、0 fail、0 skip**（serial bounded 240s）+ typecheck 过 |
| S2 阶段口径 | progress JSON `code_status: completed`（误导） | **改标 partial**（原 evidence 字符串历史原样保留） |

仍 blocked / 未证（如实保留）：54m57s 旧挂起 node 生命周期 unknown（本轮零新证，不全局扫描/不倒证）；
G1 全部 3s 预算（30s 静默窗口）、G3、S2 企业接受（真实集群出口/敏感读封闭/DLP/repo-scoped token 等
handoff §5.2 P0 项）保持 partial；SIGKILL+waitpid 内核时延未静态证明（恒红门+runner 兜底为结构保证）。

## 1. SDK patch 最小修复（vendor/pi-env/patch/env-session-pin.patch）

在既有 sessionPin patch 之上仅新增一个 hunk（`packages/env/src/connection.ts` `#teardown`）：

- 语义：`session.live=false` 后，`clearInterval`/清 `#session`/`#ready`/`stdin.end()`/`child.kill()` 全部
  置于 `try`，`end`/`kill` 各自独立 `try/catch`（一步失败不中断其余清理），**pending reject 全部迁入
  `finally` 独立 finalizer**——任何上游同步抛都不能跳过「reject 全部 pending + 清空 pending map」；
- 不变式：正常路径逐行次序与原实现一致；`close()` 幂等（`live` 守卫 + pending map 恰清一次）；
  `#start()` catch 路径原始错误照常抛出；协议零变化；sessionPin/G1 语义零变化（B1–B5 真实 5/5 为证）；
- patch SHA-256：`aac1576e4b82a5b94559f51d46063ae1ffdc51b22e5a60dc42d15c8b2c1e8f52`（与旧 patch 全 diff
  仅此 hunk + index 缩写一致化；index blob 9bfe18df4→ab0c9a0c0）。

## 2. builder 必要校验更新（vendor/pi-env/build/build.mjs；SHA 02b0bd13…）

外部 pi-mono 工作树已 drift 到 8efd314fa（含 env src 变更），原「工作树=patched 源」管线既不可运行也不可信。
最小必要变更（源管线改为仓库内自足，预校验强度不降）：

1. **base 固定 pin**：`manifest.base.head`（=cdaf6c227）经 `git show <pin>:packages/env/src/*` 只读提取
   （fixture 无 head 时退回 HEAD，fixture 语义不变）；对 pi-mono 仅只读 git show，零写入；
2. **patched 源=base+patch**：owned mkdtemp materialize base 六源 + `git apply --check`/`git apply`
   本仓 patch → patched 源 hash；`patch 应用结果 ≠ manifest.base.sources` 即「源 drift」拒绝（人工
   rebaseline 前置，与原工作树 drift 检查等强）；
3. 预校验链保留：base 基线 hash（pin 后仍须 == manifest.sourceBaseHashes）、patch 文件 hash ==
   manifest.patchFileSha256；漂移核对保留：base(pin) emit vs vendor/original 必须 4/4 SAME；
4. manifest 刷新：`base.sources=56e504b4…/373019b5…`（remote-env 未变）、`patchFileSha256=aac1576e…`、
   `files.patched.connection.js=fa270daaa72295fb8733fc631c204519929f049a0f73da9f93fa875c9066f81a`
   （remote-env.js/d.ts 不变）、purpose 注明 teardown 硬化。

负控矩阵同步（tests/pi-env-build-negative.test.ts）：负控②由「工作树源 drift」改为等强「patch 应用结果 vs
manifest.base.sources 漂移 → 拒绝且 manifest/vendor 零写入」；fixture patch 改为真实可应用 git diff；
正控/负控①③原语义保持。4/4 pass。

## 3. 受控安装迁移（现有受保护流程）

新 manifest 下旧安装态（d59a1c09…）为 unknown → installer fail-closed 拒绝（设计行为）。受控迁移：
安装前 4 hash 留证（/tmp/perim-evidence/install-before-transition.txt）→ 逐文件验证 `vendor/original`
hash 后 rename 原子回滚至 original → `verify=original` → `node scripts/pi-env-patch.ts apply` → `patched`。
旧产物（旧 patch/manifest/dist）全部在 git index 留底（staged blob 可恢复），未删除任何历史。

## 4. vendor-faithful 故障注入回归（tests/pi-env-teardown-fault.test.ts，5/5）

- 口径：加载**真实安装** `node_modules/.../dist/connection.js`（import 前 sha256==manifest.patched）与
  `vendor/pi-env/original/connection.js`（red 对照，hash==manifest.original）；唯一注入缝=module resolve
  hook 将该模块的 `node:child_process` 导入重定向到受控 fake spawn（SDK 字节零改动）；
- 「真 pending」前置：`request()` 为 async，必须 flush 微任务并以 REQUEST 帧写出计数确证 pending 已入队
  （否则同步 close 先于 `#send`，走的是 lost 快速拒绝——不是被测结算路径）；
- 场景：end 抛（close 不抛+pending 真 settled+session 释放+close 幂等）/kill 抛/双抛（kill 仍被尝试）/
  无故障（closed reject 原语义）/original red 对照（close 抛且 pending 永不 settle——修复前缺陷在案）。

## 5. 红绿分离与真实执行（owned root /tmp/perimeter-s2-teardown-lMDwlI，0700）

布局：flat root（preflight/repro/sdk5/probe 共享 ROOT/out）+ `red/`（r8 冻结 sdk5 75267a65 逐字节 +
tailgate-r8 红对照）+ `green/`（适配运行版 sdk5 fc23e9d3… + 四 oracle）+ `run-logs/provenance.jsonl`
（每次运行：nonce/argv/runner_pid/真实 runner exit code/外层实测 wall；bounded runner detached PGID 独占组
校验在日志在案）。复制冻结 r8/r9 件后仅 EXPECT 表与头注适配（diff 仅 EXPECT+注记；sdk5-r9 75267a65/
e06597e2 冻结原件零改动保留于原 root）。

### 5.1 R20 两条 oracle 文字精度澄清（只改头注文字，断言零削弱）

① tailgate ③「main().catch 释放由源文本断言补充」→ 更正为跨文件口径：本文件切片不含 catch，catch 清除
文本断言由 wholetimer-r9 ③ 承担；② tailgate ⑤ writes 序「summary→exit-wall→(red)failure」→ 澄清
writeFailureSummary 已打桩进 failures 数组、其写序不经 sb.writes 可观测，实际断言=exit-wall 在 summary 后+
decision 先置非零 exitCode；「exit-wall 写盘在最终再核之前」真值由 R20 对源码独立证实。

### 5.2 红对照（r8 冻结件；预期与实测一致）

tailgate-r8 对 r8 sdk5（75267a65）：**①②⑤ 红、③④ 绿**——① `0 !== 4`（r8 判定查旧 const，写盘跨窗仍
误绿，正是 R-Q19-1 缺陷被行为级捕获）；② r8 无 finalize 再核；⑤ r8 无 exit-wall 写盘。

### 5.3 绿色侧（适配运行版；终态 36/36）

- 运行前修复三处 r9 冻结 oracle 从未运行暴露的机械缺陷（忠实适配、断言语义不削弱，全部在副本头注留痕）：
  1. tailgate `loadTail` 返回立即执行的 IIFE promise 却被 `await tail()` 调用（且 ④ 用 `tail.then` 与之
     互斥）→ 改返回函数；沙箱补 `cleanups`/`CASE_DEADLINE_MS`/`SUBCOMMAND_TIMEOUT_MS`（真实尾部切片的
     模块级引用）；case_failed 断言按真实组合类别 `case_failed:<case>:<category>` 前缀匹配；
  2. wholetimer ②③⑤ 为 r8 时代锚点（文件尾 `\n\}$`、`if (wholeStopExceeded)`、表达式无 return 包裹）→
     按 r9 真实结构适配；
  3. purefake 沙箱缺 `DAEMON_COPY`/`PRIVACY_LEDGER`/`SUBCOMMAND_TIMEOUT_MS`；closeOnce fake inspect 返回
     4 字段而重验格式为 3 字段（`Id Running label`）致门测试从未真正到达 gate；「重验不符」用例靠该 bug
     意外通过 → fake 恒回 3 字段，重验不符用例改为恒返另一 CID（真实到达门）；
- 终态（含 followup 新增 ⑥ 与 forceSettle）：tailgate 6/6、wholetimer 6/6、joinfb 5/5、purefake 20/20，
  全部 exit 0（合计 37/37；纯fake 运行，全部有界 ≤10s 真实退出，v2 provenance 含 residue=unknown 如实记录）。

### 5.4 真实执行链（一次一个、顺序执行；前置满足才跑）

| 阶段 | 预挂预算 | 实测 | 结果 |
|---|---|---|---|
| preflight | 15s | 176–230ms | 9/9 checks pass（安装态==新 manifest.patched；docker ready+镜像在案） |
| repro v2.1（EXPECT 适配版） | 45s | ~1.2s | **exit 0**：cdaf6c227+新 patch → 4/4 base==vendor/original==manifest.original、4/4 patched==vendor/dist==manifest.patched（strip 口径）逐字节可复现 |
| sdk5（EXPECT 适配版） | 90s（case 15s） | 5997ms | **5/5 behaviors pass**（B1 snapshot 原子/B2 pinned 正控+cwd 拒/B3 kill knownlost 零重连/B4 重连新 pin 恢复/B5 abort 局部不伤 sentinel）；exit 0；cleanupAggregate=all-settled；wholeDeadlineFired=false；exit-wall 在案 |
| docker-owned-probe（EXPECT 适配版） | 30s | ~580ms | 生命周期 pass：docker run→inspect→driver 正向 scoped join→rm→inspect-gone；「owned ledger 闭环 pass」 |

错误处置记录（原样失败留存于 evidence/）：repro 首跑 exit4 `manifest_files_mismatch`（我的 EXPECT 适配
漏 files.connection.js.patched——修 EXPECT 复跑过，非源码缺陷）；docker probe 首跑 exit4 `docker:run ENOENT`
——**真实产品缺口**（见 §6）。两次原样失败 JSON 均保留不删。

## 6. probe 首跑暴露并修复的真实产品缺口（src/gateway/execution-backend.ts）

`DockerBackend.environmentPlan().start.env` 原只给 `dockerClientEnv()`（无 PATH）——`spawnSync("docker", …)`
在 PATH 无 docker 的环境下 ENOENT（本机 docker 在 /usr/local/bin）。而 `safeDockerCmd`（:140）与 `launch`
本体一直是 `{ PATH: process.env.PATH, ...dockerClientEnv() }`——plan 声明的启动命令按原样不可执行。
最小修复：plan.start.env 与 safeDockerCmd 同口径（仅 host 侧 client 环境；容器内环境仍由 args 严格构造，
不继承网关进程环境）。tests/docker-backend.test.ts 增断言：start.env.PATH==process.env.PATH 且键仅
PATH/HOME/DOCKER_*（34/34 pass）。

## 7. 全量验证

- `npm run test:serial`（bounded-test-runner --timeout 1500s，--test-concurrency=1）：**564/564 pass、
  0 fail、0 cancelled、0 skipped、0 todo**（240s；runner exit 0）；含 G1 session-pin 真实 daemon 全链路、
  docker-backend 34、新 teardown fault 5、builder 负控 4；
- `npm run typecheck`：过。

## 8. 协调者 followup 闭合（msg_e51707563aa4/35c7f7df3e74/47ca6ff2dfbe/57ae8dcbbb04/af44e81d3e30）

- **tailgate 测试架缺陷（e51707563aa4，与本轮独立发现一致）**：loadTail IIFE 两种调用口径互斥→改返回函数；
  ② case_failed 改按真实组合类别前缀断言；④ 增 forceSettle 显式回收假永悬（单次调用+双 catch，无第二个
  悬 promise；竞窗内断言不变）；新增 ⑥「decision 绿+exitCode 仍 0→exit-wall 写盘本身跨截止→finalize 翻红」
  （与② caseFailure 先红路径不同的真因果，绿 6/6 实证）；红对照只用 ①（0≠4 断言失败）作语义红证据，
  非 TypeError/SHA mismatch/缺 marker 充数；r8 SHA pin 真实适配；旧 root 零改动。
- **范围纪律（35c7f7df3e74）**：未抢写 S3–S6；user 新许可未当企业批准（S2 code_status 已改 partial）；
  旧 unknown 永久保留。
- **builder 边界（47ca6ff2dfbe）**：pin base=manifest.base.head（不默认 HEAD、不由 patch 自带授权），
  pinned 提交全 hash=cdaf6c227d4718a72b59ccd02152c9614df44cfc（九 permitted blob 经 git show 只读提取，
  git apply --check 先行）；负控②=patch 应用结果 vs manifest.base.sources mismatch 拒绝（非删断言）；
  无 checkout/clone/fetch/worktree/init；外部工作树 drift 明示忽略（零读源码）而非伪称 precheck 未变；
  repro 的 GIT≤5s/tsc≤15s/whole45s/lazy-fetch/无交互守卫逐字节保留（仅 EXPECT 表适配）；
  新旧 hash 台账见 §9；原 old root/manifest 冻结未动。
- **teardown 测试入队屏障（57ae8dcbbb04）**：与协调者诊断同根因同解——fake stdin.write 对 REQUEST 帧
  计数+flushRequests 屏障（#send 先 pending.set 再 write），断言真 pending 前置后オ close；未放宽
  closed→lost；red 对照同屏障。**偏差披露（保留原件，不删不改历史）**：调试脚本直写 /tmp
  （perim-debug-teardown.mjs、perim-debug2.mjs、perim-debug3.mjs、perim-debug3/ 目录，mode 0644）
  且直接 node 运行（无 bounded runner）；perim-debug2.mjs 末 process.exit(0) 不构成真 join/自然退出
  证据（仅诊断用，结论已由受控测试重证）；本轮后续调试纪律=fresh owned root+bounded≤10s+真实 exit/
  provenance，不再 process.exit 假结算。
- **裸 python3 违规（af44e81d3e30）**：本轮前段多次裸 python3（patch 生成/适配/root setup/manifest 更新），
  违反项目规则；已立即停用，后续全部 uv run/Node；既有命令/日志原样披露不删不改；worker_done
  filesModified 含全部临时脚本/调试 root/本轮 artifact，单次 CSV 传全不重复旗标。
- **residue 口径（e51707563aa4 尾）**：runner 内 getGroupPids 把 ps 错误折叠为 []——其 cleanedPids/exit0
  不作 zero-residue 证明消费；run_logged.py v2 在 runner 退出后对本轮 owned PGID 做一次 scoped ps 归组
  观察，ps 失败=「residue_unknown:ps_nonzero」（macOS ps -g 不可用即如实 unknown），正向空组才算 gone；
  本轮终态运行全部记录为 residue_unknown（不声叨 zero-residue）；v1 provenance（早期运行）无 residue
  字段=未证，同一口径。

## 9. 新旧 hash 台账（实际来源/完整 ref/负面拒绝证据）

| 件 | 旧（冻结历史，git index 留底） | 新（本轮） | 来源/ref |
|---|---|---|---|
| patch | 940892b9015167ef267b84e6c577a5307d3d6637d75bd6c21dd8b20052c2d940 | aac1576e4b82a5b94559f51d46063ae1ffdc51b22e5a60dc42d15c8b2c1e8f52 | owned 临时 git 仓（base=git show cdaf6c227d4718a72b59ccd02152c9614df44cfc）+ 手工 #teardown hunk + git diff 重生成；独立验证 git apply --check 过（/tmp/perim-verify-*） |
| manifest.json | 0b87934f4c868fde6ca176fa3c407540506961500e7f6209ef6d04463676cd06 | 941f1d34082fbfcd449071fcd573d198d4f0169cd12ba0144e426a55fa0b245d | 人工 rebaseline（patchFileSha256/base.sources/purpose）→ builder 重写 dist hash/compiler |
| build.mjs | 4075300079648e8f6ead4faba7cddd13141c8a9e55d044f091b987f25530c321 | 02b0bd13fb0610379ee0219182ab88918e270850a2ab317aecec3c1616c7b8d9 | 本轮源管线最小改造 |
| dist/connection.js | d59a1c0923bd801eef0143f65253aaab23ebb3abf175e3215eb6904db70769f1 | fa270daaa72295fb8733fc631c204519929f049a0f73da9f93fa875c9066f81a | builder emit（repro exit0 逐字节复现） |
| patched 源 connection.ts | 7e1f77ddf2d3a8b6506f429cc7f698c10fc85b30fa2c2fbd86406ce3cde7ff31 | 56e504b4b2c92e76b63ac94b6049686858c4e106cd85e2565776cfd1fab895cb | base(740c6e34…)+patch 应用 |
| 负面拒绝证据 | — | builder 负控 4/4（out-dir 已存在/patch 漂移/patch 篡改/正控）；installer unknown fail-closed（迁移前实录） | tests/pi-env-build-negative.test.ts 输出 + §3 迁移记录 |

## 10. 证据与足迹

- 证据 root：`/tmp/perimeter-s2-teardown-lMDwlI`（0700；sha256-root-manifest.txt；run-logs/provenance.jsonl
  每运行 nonce/argv/真实 exit/外层 wall/residue-unknown 如实记录；原样失败 failure.json/failure-docker.json
  留存）；调试偏差件（/tmp/perim-debug-teardown.mjs、perim-debug2.mjs、perim-debug3.mjs、perim-debug3/
  等 0644 直写直跑，process.exit 假结算不可作退出证据）原件保留不删，详见 §8；
- repo 改动：vendor/pi-env/patch/env-session-pin.patch、vendor/pi-env/manifest.json、vendor/pi-env/build/
  build.mjs、vendor/pi-env/dist/connection.js（构建产物，经 builder 而非手改）、src/gateway/execution-backend.ts、
  tests/pi-env-build-negative.test.ts、tests/pi-env-teardown-fault.test.ts（新增）、tests/docker-backend.test.ts、
  docs/implementation/s2-sdk-teardown-continuation.md（本文）、docs/implementation/s2-sdk-session-pin.md §18.3
  节尾时点、docs/implementation-progress.json；无 commit/push/reset/stash/clean/history/secrets；
  dirty/staged/旧 reports/§18.4 原状保留；
- 与外部 owned/unknown 的差别：54m57s 旧 node 为**历史 unknown**（未证，不倒证）；本轮全部新执行为
  **新 owned root + 独立 detached PGID**（每轮 PID/PGID/nonce/argv/exit/外层 wall 在 provenance），二者不混写。

## 11. R-Q38-1/2 收敛轮时点记录（2026-10-18T13:05Z 前后；task_0f8d88a845e6 / ctx_f6ce85f360dc；追加节，历史原文不改不擦）

### 11.1 R-Q38-2 计数/覆盖/SHA 口径对齐（只追加，不回写 §0/§5/§10 历史文本）

- **四 oracle 总数**：§0 表与 §5.3 标题的「36/36」是 followup 新增 tailgate ⑥ 之前的陈旧计数；终态=**37/37
  （tailgate 6/6 + wholetimer 6/6 + joinfb 5/5 + purefake 20/20）**，与 R38/R39 独审计数一致。tailgate 由 5/5→6/6
  （新增 ⑥「decision 绿→exit-wall 写盘跨截止→finalize 翻红」），历史「5/5」字样按原样保留在本文件早期段落，不作改写。
- **sdk5 适配件 SHA**：§5「green/（适配运行版 sdk5 fc23e9d3…）」中 fc23e9d3 为陈旧值；author root 实盘与
  R38/R39 复验均为 **cb1e2cc5**（green/ 与顶层同字节）。两个 SHA 如实并存：fc23e9d3=早期适配副本（已被取代），
  cb1e2cc5=实际运行/被审副本。历史行不回改，以本节为准。
- **manifest 覆盖口径**：lMDwlI author root 的 sha256-root-manifest.txt **20/20 属实但仅为脚本/provenance 子集清单**，
  非 root 全产物覆盖——本轮实测该 root `find -type f` 共 **161 文件**（不是 13；13 是另一 r21-fix root 的 manifest
  口径，不适用于 lMDwlI；也不是全覆盖）。R38 的 402 文件 manifest 亦有自引用行（哈希先于末次追加的必然自指，
  唯一 FAILED）。本轮新 r40 root 的 manifest 自设计起排除自身行（非自引用），见 §11.2。
- **probe 坏 wallMs 标注**：§5.4 表「~580ms」为内 runner 外测值；同轮 summary.wallMs=1792319333270.6362ms
  （lMDwlI）/1792324707135.03ms（R39 root）为混时钟垃圾值（Date.now 纪元 ms − performance.now 单调原点），
  当轮未标注，属报告缺陷——现补标注。内 runner（bounded runner wall 576ms）与外层（run_logged outer wall 629ms）
  两口径区分如实保留。历史正文/表格原样不擦，以本节为准。
- **installer 受控迁移/调试外写/裸 python/forcedexit 等历史偏差**：全部按 §3/§8 原状保留（不抹不洗）；
  本轮新增偏差（裸 python3 heredoc 文本编辑 4 次、plain node --test 诊断重跑 5 次无外 deadline、r40 root 内
  tee 覆盖首 run 日志、两次 setup 失误真实失败 run）在 docs/implementation/s2-sensitive-read-dlp-continuation.md
  偏差节如实登记，原日志/失败件不删不改。

### 11.2 R-Q38-1 收敛（probe 时钟一行修 + 新独立真实 probe 实跑）

- **修复件**：`/tmp/perimeter-r40-PRkN05B3Td1q/docker-owned-probe-r40.mjs`
  （sha256 `4782c07dd372745b2bedd143f19712fa7ca023e6a870c3d78d13b63ec2a7c5b3`）＝冻结 5ec9a6a7 逐字节副本
  仅改 summary 行 `wallMs: Date.now() - t0` → `wallMs: Math.round(elapsedMs()*1000)/1000`（同单调时钟）+头注；
  未修原件同 root 保留（`docker-owned-probe-r40-original.mjs`，sha==5ec9a6a7，与 R39 green3 逐字节一致）。
  预期 hash 表（EXPECT）零改动——reproSha/dist hash 全部沿用，不弱化。
- **新独立 root**：`/tmp/perimeter-r40-PRkN05B3Td1q`（fresh mkdtemp 0700；复制自冻结 R39 green3 只读源；
  旧 root/lMDwlI/R38/R39 全部零改动）。
- **真实执行（全部经硬化版 bounded runner，一次一个独占 owned run；真实 exit 由 runner wait 观测）**：
  repro.mjs → **exit 0，验收 8/8 SAME**（repro 内部 wall 1256ms，runner wall 1305ms，45s 预算）；
  docker-owned-probe-r40.mjs → **exit 0 自然退出，pass**（30s 预算内：runner wall 578ms、nodeExitWall 570.9ms、
  **summary.wallMs=482.961ms 真实单调值**、children=10、fullCid=true、driverJoinProven=true、cleanup all-settled、
  groupResidue=empty(对照正证)）。前序 4 次 setup 失误真实失败 run（exit 4 自然退出）原样披露于 root
  RUN-RECORD-r40.md/SETUP-deviation.json，不删不改。
- **边界**：本修复只改 summary 证据字段时钟，pass 判定链（ledger 事件）未动；R39 功能结论维持；
  硬 timeout 证明口径不变（本轮 runner 虽硬化，同代核验/有界收尾为新增结构保证，内核终止时延仍未静态证明）。
- **root 证据清单**：`sha256-root-manifest-r40.txt`（95 文件最终版，含 DELIVERY-REPORT-r40.md；**非自引用**——manifest 不含自身哈希行；
  排除 node_modules 只读 symlink）；manifest 自身 sha256
  `14c950a8aa88158ef45c9e6a160532d71cd2af6248722fa20651f6d9eab670d3`（记录于本文与交付报告，不入清单自身）。
