# Grok S2 工具路径守卫（Slice A）第五审（两小修+G1 in-repo 有限 approve；G1/G3 SDK 侧 blocked；本审 Docker 环境受阻如实记录）

- 结论：**有限 approve（范围仅限三项：①G2 stdout 字节契约修复；②kill oracle 硬化；③G1 in-repo metadata 免 info await）**，均经本审独立复证。**G1 SDK 侧重连/首连预算 与 G3 远端死亡确认维持 blocked**（公开 SDK 无真取消/ack API；不采用 Promise.race；metadata 前取不声称覆盖后续 reconnect）。`s2-protected-paths` 真实全门槛未闭合，**总体维持 partial，不升 implemented**；S2/企业未批；四眼历史限定批准不回退；K8s unknown；bash/硬链接/敏感读/最终 check-use TOCTOU 残余不扩。本审新增一项 **required 跟进**：专项文件内 3 项「集成（Local 真实 helper）」beforeTool 测试被静默删除且未在实施报告 §7 声明（e2e 存在等效覆盖，须恢复或获明示豁免）。
- 日期：2026-10-17；审查者：grok（唯一 reviewer；Pi 唯一 coder，task_9e90ba1cc5f4 交付后 retained 停编）。
- 对象与哈希（本轮实测，SHA-256 前 16 hex）：`src/runtime/path-guard.ts` `f6fcbbd87b59a22e`、`src/runtime/execution-env.ts` `0f76749a6e0a1614`、`src/runtime/perimeter-extension.ts` `e25a404d6a8509c8`（仅注释口径纠正）、`src/runtime/harness-host.ts` `e5a8e600b264fbbe`（不变）、`tests/path-guard-exec-helper.test.ts` `cd703ec373aee486`、`tests/protected-paths.test.ts` `93f34f838ab86558`（不变）。实施文档：`docs/implementation/s2-path-guard-exec-helper.md` §7 `3a9b1c4813c5b7ec`、`docs/implementation/s2-path-guard-bootstrap-blocker.md` `60656f7807c266ad`。
- 允许写入：本文件、`docs/reviews/handoff-coverage.json`、R4 两处最小否决注记（已加，原文与原始证据保留不改）。未改产品/测试/作者报告/handoff/SDK 依赖；未 commit/push/spawn；未运行 r25 旧探针；**未触碰停滞的 Docker daemon、未知资源、旧容器、context、用户 workload、真 secret**。

## 1. R4 否决注记落地（最小补注，不改历史）

- R4 §4：`Promise.race` 修复方案已注记**协调者否决**（race 只停等待、连接后台走完，非真取消；仅定时 reject 的预算 API 亦不够，须真取消 bootstrap 并 await owned 启动子/transport close；`request options.session` 已存在而 `RemoteExecutionEnv.exec` 未透传为具体边界）。
- R4 §6 G3 行原记「closed」已注记**否决更正**：0ms settle + helper 46ms 后消失 = 返回时点 helper 仍活动；G3 改为 pending/unknown，且 close 路径证据不推广到所有 normal aborted（protocol.md §Cancellation 只写 kill+aborted、无收割 ack）。

## 2. 两小修 + G1 in-repo 独立复证（全部成立）

### 2.1 G2 字节契约（closed）

- 代码：`execGuardHelper` onOutput 按 `Buffer.byteLength(text,"utf8")` 逐 chunk 累计，超 4096 即 overflow→unknown；SDK StringDecoder 保证跨 chunk 多字节字符重组后才进 onOutput，字节计账精确无边界缝。
- 本审独立负控（`/tmp/perimeter-r5-grok/grok-g2g1-probe.ts`，runner 包装，日志 `/tmp/perimeter-r5-grok/g2g1-probe.log`，exitCode=0 自然退出 641ms；构造偏移/内容独立于 Pi 测试）：恰好 4096 字节（首「路」2+1 字节跨 write 劈开）→ **ok 接受**；4097 → unknown；4094 ASCII+3 字节「路」（限界恰在该字符完成处突破，setTimeout 分批写）→ unknown；9000 字节级多字节（<4096 UTF-16 单元）→ unknown；真实 helper CJK 新建路径正控 + symlink 外逃可见。Pi 测试内同型四项负控（tests:226/245）在本审 runner 专项复跑中亦全过。

### 2.2 kill oracle 硬化（closed）

- 代码（tests:278-355）：helper/孙 argv 内嵌唯一 marker；出生核验（alive+pgid==pid）；`psProc` 三态 gone/zombie(stat Z)/alive(command 含 marker——PID 复用判 gone)；`waitForKilled`/`waitForGroupEmpty` **≤3s 总 deadline、25ms 轮询**，组空要求 zombie 也完成收割；超时抛错带状态详情。无固定 sleep、无吞断言、不 kill 不明 PID；sentinel finally 精确 SIGKILL+exit 等待。
- 实测：两项 kill 证明在本审 runner 专项复跑通过（timeout 1094.8ms / abort 143.1ms），R4 首败模式（settle 后立即断言）已结构性消除；Pi 本轮 477×2（含同文件）全绿无一 flake。

### 2.3 G1 in-repo metadata（closed，仅限「免 info await」）

- 代码：`openEnvironment` 打开时 `connection.info()` 一次取得 → `remoteEnvHome` WeakMap（execution-env.ts diff +8/-1）；`createPathGuardResolver` 同步读取，缺失立即 `code=unknown` 拒绝，**不现场连连**。
- 实测：无 metadata 的 Remote env resolver 拒绝 **0ms**（R4 缺口 30014ms），拒绝前后本进程子进程数 0→0（守卫路径零连接证据）；`connection.close()` 后残留子进程 0。Pi 实测 0.4ms（`/tmp/perimeter-r5` 专项内 G1 测试，本审 runner 复跑同过：0.609ms）。

## 3. blocked 台账核验（SDK 侧，精确边界，不杜撰）

- **G1 残余（blocked）**：daemon 掉线后下一次 exec 经 `Connection.request→#connect→#start`（connection.js:124-126/139/182，均无 signal/ctx；START_TIMEOUT 60s `:15`、静默 30s `:13`）无预算重连；abort 监听挂于 `#send` 之后，连接建立前 CANCEL 写不进。本审核源码确认：Handle 类文件操作带 session pin（remote-env.js:96 `{...options, session: this.session}`），**exec 请求未透传 session**——不对称即最小 API 边界①（pin 已知 live session → 掉线立即 lost fail-closed）或②（connect 预算参数）。仅定时 reject 不够，须真取消 bootstrap 并 await owned 启动子/transport close。
- **G3 残余（blocked）**：protocol.md §Cancellation（:45-50）只写「kills the command's process group and finishes with aborted」——**无收割后回帧的 ack 保证**；Local 侧 exec 在子进程真实退出后才 settle（SDK waitForChildProcess，已证）；Remote 侧 deny 返回 ≠ 死亡确认（R4 close 路径 0ms/46ms 原始证据），normal timeout/abort 的死亡时点同样 pending/unknown。最小需求③：daemon 杀组后确认收割再回帧（如 `aborted{reaped:true}`）。生命周期兜底（close/daemon 退出杀组/容器销毁）不是单请求收尾证明。R4「所有正常 aborted 都缺死亡确认」的推广不成立——本审按协议原文精确区分。

## 4. 套件级证据（raw header/计数/exit/墙钟逐项核验）

**Pi 本轮新鲜全量（2026-10-16T16:01-16:17Z，daemon 健康时段，本审已读日志头尾）：**

| 运行 | 启动头（runner） | exit | tests | pass | fail | skipped | 墙钟 | 日志 |
|---|---|---|---|---|---|---|---|---|
| 全量真串行 | `npm run test:serial` → `bounded-test-runner --timeout 1500s node --test --test-concurrency=1 …` | 0 自然 | 477 | 477 | 0 | 0 | 247074ms | `/tmp/perimeter-r5/serial-full.log` |
| 全量默认并发 | `npm run test:bounded` → 同 runner | 0 自然 | 477 | 477 | 0 | 0 | 130877ms | `/tmp/perimeter-r5/bounded-full.log` |
| e2e | 裸 `node --test tests/protected-paths.test.ts` | 0 | 17 | 17 | 0 | 0 | 5.0s | `/tmp/perimeter-r5/pp-final.log` |
| 专项 | 裸 `node --test tests/path-guard-exec-helper.test.ts`（**无 runner header，按协调者口径不计合规**，由本审 runner 复跑补证） | 0 | 21 | 21 | 0 | 0 | 45.8s | `/tmp/perimeter-r5/specialized-final.log` |

**本审复跑（2026-10-17，Docker daemon 停滞时段）：**

| 运行 | 启动头 | exit | tests | pass | fail | skipped | 墙钟 | 日志 |
|---|---|---|---|---|---|---|---|---|
| 专项（runner 补证） | `bounded-test-runner --timeout 600s node --test --test-reporter=spec tests/path-guard-exec-helper.test.ts` | 0 自然 | 21 | **17** | 0 | **4（全部「docker 或镜像不可用」环境性 skip）** | 18.1s | `/tmp/perimeter-r5-grok/specialized-runner.log` |
| 独立 G2/G1 探针 | `bounded-test-runner --timeout 240s node …/grok-g2g1-probe.ts` | 0 自然 | - | - | - | - | 0.6s | `/tmp/perimeter-r5-grok/g2g1-probe.log` |
| 静态 | `npx tsc --noEmit`（runner） | 0 自然 | 0 错误 | - | - | - | 3.2s | `/tmp/perimeter-r5-grok/static-typecheck.log` |
| 全量串行尝试 | 同 Pi 命令、1700s 外挂 | **124 超时（无效）** | 123 | 95 | 0 | 0（28 cancelled） | 2580s | `/tmp/perimeter-r5-grok/serial-full.log` |

- **环境受阻如实声明**：本审期间 Docker daemon 停滞（`docker version` >30min 无响应；suite 内 `docker 调用超时` 风暴），故本审独立全量 serial 超时无效、独立 bounded 未跑、专项 4 项 Docker 用例环境性 skip。按约束**未重启/未触碰 daemon**。该受阻为环境事实，不构成对两小修的反证（本审全部本地独立复证 + Pi 健康时段 477×2 raw logs 成立）；4 项 Docker kill/断连同用例在 Pi 477×2 中为真实执行且全绿（✔ 实时长，非 skip）。失败/无效 raw 全部保留：`/tmp/perimeter-r5-grok/serial-full.log`（124）、R4 历史 `/tmp/perimeter-r4/`。
- owned 资源：本审探针全部 finally 精确关闭（本地 ws/env/connection；未创建容器——Docker 不可用）；Pi 套件内为精确 owned 名 create→inspect→cleanup→inspect-gone 闭环，cleanup 后仍在即显式 unconfirmed；`/tmp/perimeter-r5/resources-{before,after}.log` 全 0（观察计数仅旁证，不替代 owned 证明）。未动未知资源。

## 5. required 跟进（不降建议）：3 项集成测试被静默删除

- 事实：`tests/path-guard-exec-helper.test.ts` 由 21→21，但「集成（Local 真实 helper）」3 项 beforeTool 单元级测试（多级新建不误拒 / ws 内绝对路径 / symlink 外逃+循环+NUL+`~` 越界+denied 事件无宿主路径）被 **G2×2+G1×1 替换**，`makeRealExtension` 全仓无残留，实施报告 §7 **未声明该删除**。
- 缓解事实：同覆盖由未改动的 e2e `tests/protected-paths.test.ts`（production Gateway 级 17 项，Pi 本轮 17/17）承接。
- 要求：下一小包**恢复该 3 项**（总数 477→480）或由协调者明示豁免并写入实施报告；「不为收口改断言」同样适用于不加声明地删测试。

## 6. 门槛总表（本轮口径）

| 门槛 | 状态 |
|---|---|
| G2 字节契约（含跨 chunk/多字节临界负控） | **closed**（独立五点负控 + Pi 四项负控） |
| kill oracle 有界轮询 + 原 PID 出生/组/活-vs-zombie/复用区分 | **closed**（代码核验 + runner 复跑两项 kill 证明 + Pi 477×2 无 flake） |
| G1 in-repo metadata 免 info await | **closed**（0ms 拒绝、零连接子进程） |
| G1 SDK 重连/首连预算 | **blocked**（无公开 API；session pin 未透传/connect 预算二选一，见 §3） |
| G3 远端死亡确认（含 normal aborted） | **blocked**（协议无 ack；最小需求③） |
| bounded①首败历史 | 保留不改（R4 raw）；本轮 Pi 477×2 无复现 |
| Slice A 总体（真实取消/收尾全门槛） | **partial 维持**（上两行 blocked 未闭） |
| S2/企业生产 | 未批维持；四眼历史限定批准不回退；K8s unknown；bash/硬链接/敏感读/TOCTOU 不扩 |
| 本审环境 | Docker daemon 停滞（未触碰）；独立全量受阻如实记录 |

## 7. 台账

- s2-path-guard：**partial 维持**。已证能力（Local 真实 kill/组空/sentinel 无伤、字节契约、failclosed 矩阵、泄露面、canonical 取严+漂移复检、四眼）不回退；blocked 两项不冒充闭合；候选 API 需求已精确化，待协调者/SDK 决策，本仓不擅改。
- 证据索引：Pi `/tmp/perimeter-r5/`（serial/bounded/pp/specialized×6/resources）；grok `/tmp/perimeter-r5-grok/`（serial 无效 raw、specialized-runner、g2g1-probe、static-typecheck）；R4 历史 `/tmp/perimeter-r4/`。所有日志绝对路径可读，报告前已实读各尾。
