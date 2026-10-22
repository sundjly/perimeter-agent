# Grok S2 SDK session-pin 第二审（round-2，终版）：R1-R8 修复本体大部分证实；落地与证据 request_changes（R-Q1～R-Q8）

- 结论：**request_changes（第二轮修订包）**。R1-R8 修复本体中可证部分全部独立复证（installer 核心安全属性、builder 入库幂等、map 剥离 grep=0、PATH 回标准+helperNode、readLocalProbe 有界轮询、11 项 installer 函数层负控、R8 身份感知函数与用例）；**SDK 语义 diff 未触及，不重开**。但经协调者两条追加清单与本审逐条实证，另有 **8 处 required（R-Q1～R-Q8，不降建议）**：重连恢复用例时序竞态、报告证据表不实引用、runtime 未强制 `kind==="patched"`（原版安装回退了「hash 原版即拒」）、runtime 层负控缺失、`ownedAlive` 未知/Z 语义不当、新 R8 用例无 cleanup 登记存在失败分支泄漏、builder `rmSync` 所有权与 manifest 重写缺预校验、计数分解错误与资源 ledger 格式未达标。498×2 全绿 raw 属实（保留认可），但不抵消上述缺口。G1 30s 静默窗口/无响应 CANCEL/G3 lost 死亡维持 unknown/blocked；3s 预算门槛、G3、整体 S2/企业不预支；s2-protected-paths 维持 partial。
- 日期：2026-10-17；审查者：grok（唯一 reviewer；Pi 唯一 coder，task_86c2ce9e84a6 修复交付）。依据：round-1 八 required + 协调者 2026-10-17T02:24/02:25 两条追加清单（逐条本审独立实证）。
- 允许写入：本文件、coverage。未改实现/tests/SDK/作者报告/handoff/AGENTS；未 commit/push/spawn；零 cargo/npm run build/npm test/install 生命周期/全仓 --write；未碰 daemon/context/workload/历史资源。

## 1. R1-R8 修复本体复证（成立部分）

| 项 | 本审核验 | 结果 |
|---|---|---|
| R1 oracle | `readLocalProbe` ≤10s 轮询至 JSON 可解析且 schema 合法（parent/child 正整数）；非法完整数据轮询至 deadline 带真实错误抛出 | 代码核验 + path-guard 24/24（本审独立） |
| R2 raw log | 本轮运行行带绝对路径日志（argv/PI_ENV_DAEMON/PGID/counts/exit/时长） | `/tmp/perimeter-r8/*.log` 实读（session-pin 行例外见 R-Q2） |
| R3 installer 核心 | `src/runtime/pi-env-patch.ts`：files 恰 4 键+两键 entry+64-hex+SAFE_BASENAME 防 `..`；node_modules→scope→pkg→dist→文件逐级 realpath+非 symlink+regular；**原子 temp+rename 不写穿硬链接**；apply/rollback/verify 对 mixed/unknown 全模式显式拒绝（R1 轮 mixed 自愈已消除）；apply/rollback 各自预验 vendor patched/original；post 全量复核；失败 throw 无 process.exit（CLI 置 exitCode 自然退出） | 代码全读 + 11 项函数层负控独立 11/11 |
| R4 build 入库 | `vendor/pi-env/build/{build.mjs,tsconfig.env.template.json}`：token 化模板零用户绝对路径（仅 `TMPDIR ?? "/tmp"` 通用回退）；base/patched 源 hash→生成 tsconfig→定向 tsc→漂移核对→map 剥离→manifest 重算；`build.log`/`build2.log` 幂等重跑 hash 复现（`d59a1c09`/`5ba868c9`/`13394770`/`6333328d`）——但重写缺预校验与 rm 所有权见 R-Q7 | 代码全读 + 日志实读 |
| R5 map 策略 | 4 文件 `sourceMappingURL` 剥离，vendor 与安装后 **grep=0**（本审实测）；升级走 `vendor/pi-env/previous/`（旧 manifest+旧 patched 快照）→旧 manifest rollback→新 build→新 apply，无 unknown/mixed 接受、未 npm ci | 实测 + previous/ 在证 |
| R6 installer 函数层负控 | `tests/pi-env-patch-install.test.ts` 11 项独立 11/11（happy/幂等、tampered 写前拒、mixed 双拒、unknown 拒、wrong version、manifest 五型负控、dist 目录/文件 symlink、hardlink 不写穿、vendor 双侧预检、partial-copy、生产默认根正控）——**runtime 层负控仍缺，见 R-Q4** | 本审独立复跑 |
| R7 PATH | `execGuardHelper` 仅标准最小 PATH（宿主前插已删）；`helperNode` 第三参仅测试显式传（默认 Remote=镜像 node/Local=process.execPath，注释明示生产不得传） | 代码核验 + 全绿 |
| R8 部分 | `ownedAlive`（ps stat+command marker，防 PID 复用）与第 7 用例（close 同步返回不证远端结束→外部 owned PID 有界观察真实 exit）已落地；**ledger 格式与覆盖未达标，见 R-Q5/R-Q6/R-Q8** | 部分成立 |

哈希台账：本审实测与报告 §7.2 逐项相符（产品/测试/installer/builder/manifest/vendor 与安装 dist `d59a1c09`/`5ba868c9`/`13394770`/`6333328d`）；`tests/protected-paths.test.ts` `93f34f838ab86558` 不变。

## 2. required（R-Q1～R-Q8；逐条本审实证）

- **R-Q1（重连恢复用例时序竞态，测试件）**：作者 fresh 6/7、fresh2 6/7 失败点均在「同 Connection：unpinned 重连正控→旧 pin deny→新 snapshot 新 pin 恢复」——`waitGone` kill-0+身份判定返回早于客户端 `child.on("exit")→#teardown` 处理，紧随的 unpinned exec 落在未 teardown 会话上收到 lost（fresh2 :129 断言实录）；fresh 中另有新 pin 后首次解析 unknown 失败点。修法：teardown 确定性等待（轮询会话代际/挂接 exit）或重连后首个 exec 有界 lost 重试（≤3 次即时）。stability×3 与本审复跑未触发，低频。
- **R-Q2（报告证据表不实引用，作者文档）**：§7.2「session-pin 7 项 ×1+稳定 3 连跑：7 pass ×4（fresh{,2}+stability{1,2,3}）」不实——fresh=失败迭代（exit 1）、fresh2=6/7；实际全绿=stability×3+本审独立 7/7+serial/bounded 498×2。须更正引用。
- **R-Q3（runtime 未强制 patched 态）**：`verifyPiEnvPatchInstalled()` = 裸 `verifyPatch()`，而 `verifyPatch` 对合法 **original** 态直接返回（仅 mixed/unknown throw）；`openEnvironment` 调用处未检查 `.kind`——「重装原 1.1 hash 原版即拒」回退为依赖 capability 巧合（原版 JS 恰无 snapshot）。修正：runtime 显式要求 `state.kind === "patched"` 否则拒绝；capability 双道保留但不替代。
- **R-Q4（runtime 层负控缺失）**：11 项负控全部针对 installer 函数；`verifyPiEnvPatchInstalled`/`openEnvironment` 对 **original 安装/旧 SDK 无 snapshot/缺 pinnedSession getter** 的真正反控未测。修正：isolated clone 补 runtime 级负控（不改真实安装）。
- **R-Q5（ownedAlive 未知/Z 语义）**：ps timeout/非零/空输出一律视为「已消失」、stat Z 视为消失——**未知不得当 owner 已死、僵尸不得当已收割验证**；应保留 unknown 并使测试失败，另记录 nonce/PGID/birth(PPID/starttime) 等身份字段。
- **R-Q6（新 R8 用例失败分支泄漏）**：该用例创建 Connection 后**未 `cleanups.push`、无 try/finally**——snapshot/ownedAlive/断言任一失败即跳过唯一 `connection.close`，留下活 transport；其余用例 cleanups 亦为同步 close 不等待。修正：全部资源登记 + finally 真实 close（能证层如实标注）。
- **R-Q7（builder rm 所有权与 manifest 预校验）**：`build.mjs:73` 对任意 `--out-dir` `rmSync(recursive,force)` 无所有权判定（默认按 pid 亦可能撞旧目录）；`workTmp` mkdir recursive 非唯一——改 mkdtemp 或拒已存在非空，禁止删除未知资源；builder 以当前工作树源直接重写 manifest.sources/patched，未对既有 manifest 的 expected source/patch hash 预校验——不得把任意工作树「生成后即信任」（baseline 已有记录可预校验；本轮未改 SDK 源，无需改）。
- **R-Q8（计数分解与资源 ledger 格式）**：报告「498 = 486 + 6（session-pin 新增 R8 用例）+ 6（负控）」分解错误——实际 session-pin 6→7（**+1**）、patch-install 新增 **11**：486+1+11=498（总数正确、解释错误）；`resources-after.log` 仅全局 docker 0/marker 0/grep 计数，**无 nonce PID/PGID/birth/containerID 的 start→inspect→cleanup→gone 列表**——不得以「ledger」标题当真，后续按 R1 轮 R8 要求格式出具。

## 3. 本轮运行证据（新旧并列；旧 raw 未抹）

| 运行 | Pi（/tmp/perimeter-r8/） | 本审独立（/tmp/perimeter-r8-grok/） |
|---|---|---|
| 全量 serial（concurrency=1） | 498/498 exit 0 自然 244.9s | **498/498/0/0/0 exit 0 自然 240.1s** |
| 全量 bounded（默认并发） | 498/498 exit 0 自然 130.9s | **498/498/0/0/0 exit 0 自然 130.4s** |
| installer 负控矩阵 | 11/11（228ms） | **11/11** exit 0 |
| session-pin（7 项） | fresh 6/7（竞态）、stability×3 7/7 | **7/7** exit 0 |
| path-guard 24 / pp 17 / four-eyes 12 | 全绿 | **24/24**（pp/four-eyes 含于 serial） |
| SDK 定向 vitest（已装 bin，零 cargo） | 5/5（670ms） | **5/5**（912ms） |
| 静态 / builder / health | tsc 0；builder 幂等 hash 复现；docker ps 0 | tsc 0 错误 exit 0 |

- 协调者已独立实读 498×2 raw tails（244914ms/130881ms、skip/cancel 0、actual exit 0）——属实保留；不抵消 R-Q 缺口。历史 raw（R7 轮 bounded① 485/486、② 486）保留未抹。

## 4. 放行与边界

- 修复包范围 = R-Q1～R-Q8；R1-R8 已证部分与 SDK 语义 diff 不重开（除非修复触及）。
- 修复后验收：R-Q4 runtime 负控 + R-Q6 泄漏修复 + R-Q1 修后 session-pin 连续 ≥5 轮全绿（含默认并发）+ R-Q8 格式 owned ledger + serial/bounded 双绿（raw header）+ R-Q2 文档更正。
- 边界不变：G1-knownlost ≠ 3s 预算门槛（30s 静默窗口/无响应 CANCEL 仍 blocked）；G3 lost 死亡 pending/unknown，transportExit ≠ daemon kill_all，closeAsync/verifyReap 未实现；s2-protected-paths/S2/企业 partial；Pod unknown；bash/硬链接/敏感读/TOCTOU 残余不扩。
- 证据索引：Pi `/tmp/perimeter-r8/`；grok `/tmp/perimeter-r8-grok/`；历史 `/tmp/perimeter-r7*`；报告前各日志尾已实读。
