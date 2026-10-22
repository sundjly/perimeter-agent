# Grok S2 SDK session-pin（G1-knownlost）实现 第一审：语义核认可；落地件 request_changes（8 处 required）

- 结论：**request_changes（落地件）**。**G1-knownlost 语义核认可且不重开**：SDK 最小 diff（`snapshot()` 原子 +7、`sessionPin`+`pinnedSession`+pinned-cwd fail-closed +19）、vendor 哈希链（源 TS→生成 dist→实际加载 node_modules 逐环独立重算一致）、perimeter pinned guardEnv 接线与 known-lost 语义（真实杀 daemon 立即 lost 零 spawn、旧 pin 跨代持续 deny、工具 unpinned 真实重连、新 snapshot 新 pin 恢复、abort 不伤 sentinel）经三方独立运行证实。但落地件存在 **8 处 required（R1-R8，不降建议）**：oracle 读竞态 flake、作者 SDK 运行缺 raw log、installer 的 process.exit/mixed 态自愈/回滚预校验缺失/路径与链接逃逸面、可复现构建配置未入库、sourceMappingURL 指向旧 map、patch 运行时负控缺失、远程 helper PATH 宿主增补、资源证据口径过度。**G1 已死未察觉 30s 窗口与 G3 transport-lost 死亡维持 unknown/blocked，3s 预算门槛不因本包关闭**；s2-protected-paths/S2/企业维持 partial，Pod unknown，残余不扩。
- 日期：2026-10-17；审查者：grok（唯一 reviewer；Pi 唯一 coder，task_78831d527f2d 实现）。依据：`docs/implementation/s2-sdk-session-pin.md` + 协调者 2026-10-17T01:21 两条追加清单（本审逐条独立实证）。
- 允许写入：本文件、coverage。未改源/tests/SDK 产品/作者报告/handoff/AGENTS；未 commit/push/spawn；零 cargo/npm run build/npm test/install 生命周期；未碰 daemon/context/workload/未知资源。

## 1. 语义核认可（不重开；本审独立证据）

- SDK diff 范围恰好：`connection.ts` +7（`snapshot()` 单次 `#connect` 原子返回 info+sessionId）、`remote-env.ts` +19（`sessionPin` 选项、`pinnedSession` 只读 getter、exec 条件传 session、**pinned+cwd override → spawn_error** 封死懒重连）、CHANGELOG +5、新增 `test/session-pin.test.ts`；无 Rust/协议/daemon/其它包/lockfile 改动。
- 哈希链逐环重算一致：HEAD 基线源 `740c6e34`/`06bba09b`（=manifest.sourceBaseHashes）→ 打补丁源 `7e1f77dd`/`373019b5`（=manifest.sources，且 vendor patch 文件 `940892b9` 与 `git diff -- packages/env/src` 逐字节相等）→ 生成 dist `24a59aac`/`e1650f38`/`8aed5a1d`/`b60ea61c`（=manifest.patched）→ **实际加载 node_modules 四文件逐一相同**；original/ 副本与 manifest.original 一致；drift（未改源 emit vs 安装 dist）全部 SAME。
- 运行时 fail-closed 链（`verifyPiEnvPatchInstalled` symlink+版本+逐文件哈希 → `snapshot` 能力 → `pinnedSession===snapshot.sessionId`）代码成立；未打补丁时 6/6 诚实失败为 Pi 迭代实录（`/tmp/perimeter-r7/session-pin.log` 首跑）。
- 本审独立运行（runner header/raw argv/PGID/自然 exit，日志 `/tmp/perimeter-r7-grok/`）：serial（concurrency=1，1700s 外挂）**486/486/0/0/0 exit 0 自然 239.3s**；bounded ① 默认并发 **485/486（1 fail，见 R1）**；bounded ② 复跑 **486/486 exit 0 自然 130.4s**；session-pin 6/6（890ms）；path-guard 24/24（46.0s，4 Docker 门控真实跑）；SDK 定向 vitest **5/5**（845ms，`PI_ENV_DAEMON`=已装 darwin-arm64 bin，零 cargo——`daemon/target/debug` 实证不存在）；tsc 0 错误；`pi-env-patch.mjs verify` state=patched。Pi 侧 raw（serial 486×2、session-pin-5、path-guard-2、pp 17、resources）本审已读头尾，与报告一致。

## 2. required（R1-R8；逐条经本审独立实证）

- **R1（oracle 读竞态，测试件）**：bounded ① `readLocalProbe`（path-guard-exec-helper.test.ts:356）`waitForFile(existsSync)` 后立即 `JSON.parse` 抛 `Unexpected end of JSON input`（88ms，kill 机制未及执行；88ms 早于任何组杀）。修复：改为有界轮询直到内容可解析为合法 JSON（deadline ≤10s，超时才判失败）。修复前 bounded 默认并发不作稳定门槛（serial 与 bounded ② 已足证产品行为）。
- **R2（作者 SDK 运行缺 raw log）**：实施报告 §4「SDK 定向单测 5 pass/672ms」无持久化日志路径。本审已补独立合规运行 `/tmp/perimeter-r7-grok/sdk-vitest.log`（raw argv 含 `PI_ENV_DAEMON` 绝对路径/PGID/自然 exit）；后续作者报告所有运行行必须带日志绝对路径。
- **R3（installer 安全属性，scripts/pi-env-patch.mjs）**：①`fail()` 用 `process.exit(1)`，违反显式 no-process-exit 约束（改受控错误返回）；②**mixed 态自愈**：头部注释称拒绝「partially applied (mixed original/patched)」，实际 apply/rollback 仅拒 `unknown`，`states.size>1` 的混合态落入 else 分支被**静默覆盖**（本审代码走查证实）——必须显式拒绝；③rollback 复制前未对 vendor/original 做哈希预校验（apply 有、rollback 无）；④路径与链接逃逸面：仅校验包目录 realpath，`dist` 子目录与目标文件可为 symlink，manifest 键可含 `../` 逃逸（`join(dist,f)` 无 schema 校验），`copyFileSync` 会写穿硬链接——需固定 4 键 schema、目标 realpath 边界、regular-file/nlink 检查或 atomic temp+rename；不得以当前 nlink=1 论证脚本总体安全。
- **R4（可复现构建配置未入库）**：manifest `compiler.command` 指向 `<owned>/tsconfig.env.json` 占位，该配置只在 `/tmp/perimeter-r7/`，仓库内无可复现 tsconfig/builder——无法从仓库重建精确 emit。修正：把 owned tsconfig（与构建命令、tsc 版本）落库 `vendor/pi-env/build/`，manifest 引用仓库内相对路径。
- **R5（sourceMappingURL 指向旧 map）**：生成的 JS 尾部保留 `//# sourceMappingURL=connection.js.map`（本审实证），而 maps 故意不替换——默认 Node 不读，但 `--enable-source-maps`/调试器会读到旧 map（错误行号/路径），「runtime never reads」表述不准确。修正：明确策略（剥离该注释，或一并替换匹配 map）。
- **R6（patch 运行时负控缺失）**：tests/session-pin 6 项仅有 patched 正控；旧 SDK/mismatch/篡改/部分 apply/重装原 1.1/坏 manifest **均无实测负控**——报告不得把该语义表述为「已测过」。修正：以 isolated clone（参数化仓库根/临时目录伪造安装态）补负控用例，不得改动真实安装。
- **R7（远程 helper PATH 宿主增补）**：`execGuardHelper` 对**所有** exec（含容器内远程）把 `dirname(process.execPath)` 前插 PATH——host→remote 假设；「容器内不存在无副作用」不可保证（远端 namespace 若该路径可写即可替换 `node`），且向容器 env 泄漏宿主目录串。修正：恢复仅标准最小 PATH；本地 dev 需求改由 fixture 显式同 namespace node 方案或受信可配置项（默认仅标准目录）。
- **R8（资源证据口径）**：报告 §4 owned 证据仅全局 `docker ps -a`=0/ps grep 0——全局计数不等于当前 run 归属清理。本审精确化：可证层=各 fixture 精确名/ID 清理路径存在 + 套件自然退出 + runner 全程**零组收割记录**（本审 serial/bounded×2 日志无任何收割动作行）+ 运行后全局容器 0（观察旁证）；**不可证层**=`close()` 为同步包装、不 await transport exit（SDK 无该 API——正是 G1/G3 边界），`waitGone` 仅 kill-0 不区分 PID 复用/僵尸。normal 与 lost 不得混写；不为补证去 kill 历史资源。后续包的 owned 证据须按「精确 owned ID 生命周期 start→inspect→cleanup→inspect-gone」格式出具。

## 3. 边界重申（不变）

G1-knownlost 仅消除「客户端已察觉失联后」的重连预算；transport 已死未察觉的 30s 静默窗口与无响应 CANCEL 仍在——**3s 预算门槛不因本包关闭（blocked 口径不变）**；G3 lost 远端终止 pending/unknown，closeAsync/verifyReap 未实现，不以 transportExit 当 daemon exit，不凭无 reaped 字段杜撰 normal abort 机制。s2-protected-paths/S2/企业 partial；四眼/白名单/路径取严与 24+3 项专项全部在位（本审 serial 实测）。

## 4. 放行

- 修复包范围 = R1-R8（installer 硬化+负控、tsconfig 入库、map 策略、PATH 回标准、oracle 读竞态、证据口径），SDK 语义 diff 与 vendor 哈希链不再重审（除非修复触及）。
- 修复后验收：R6 负控全套 + R3 installer 负态矩阵 + 定向/局部回归 + 一次 serial+bounded 双绿（带 raw header）+ R8 格式 owned 证据。
- 证据索引：Pi `/tmp/perimeter-r7/`；grok `/tmp/perimeter-r7-grok/`；报告前各日志尾已实读。
