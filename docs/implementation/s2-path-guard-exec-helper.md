# s2-path-guard-exec-helper.md — 方案B实施报告：受控 exec helper 路径守卫（真实取消）

- 日期：2026-10-16；作者：Pi（task_f11a090e8118 / ctx_c3d5342b1705）；R5 更新：task_9e90ba1cc5f4 / ctx_8755499c6785（见 §7）；R6 恢复记录：task_39db14361ea6 / ctx_0a54b0639562（见 §8）
- 性质：实施报告。协调者已选 **B 方案** 并授权本仓最小执行设计切片（依据 R3 有限 approve 的白名单补丁与独立 3/3 exit0 复核，日志 `/tmp/perimeter-coordinator-path-category-r3.log`，保留 456×2 历史证据，不重开脱敏已证能力）。
- 哈希台账（B 案初版，历史）：`path-guard.ts` `4c1d793f41c03e71`、`perimeter-extension.ts` `cec12fc56d1b6db3`、`harness-host.ts` `e5a8e600b264fbbe`、`path-guard-exec-helper.test.ts` `2be733b6fa7cd2a2`、`protected-paths.test.ts` `93f34f838ab86558`。
- 哈希台账（R5 更新后）：`path-guard.ts` `f6fcbbd87b59a22e`、`execution-env.ts` `0f76749a6e0a1614`、`perimeter-extension.ts` `e25a404d6a8509c8`、`path-guard-exec-helper.test.ts` `cd703ec373aee486`（SHA-256 前 16 hex）。

## 1. 范围（严格遵守授权）

- 只改 runtime 现有 `src/`（`path-guard.ts` 新增、`perimeter-extension.ts`、`harness-host.ts`）+ 测试 + 本报告/进度文档。
- **不改** SDK、provider、依赖、Durable API、cache prefix、Docker 镜像；无新依赖。
- 替换目标：Slice A 的不可取消 `canonicalPath` RPC 及其 `awaitWithContext` 早返回包装（**移除，非改名**：`resolveCanonicalPathForGuard`、`workspaceCanonical` 闭包、extension 内两处 `awaitWithContext` 与 `workspaceRoot` 缓存全部删除，生产路径不再调用 `env.canonicalPath`）。

## 2. 实现

### 2.1 同 env 一次受控 exec helper（`src/runtime/path-guard.ts`）

- 一次 guard = 一次 `ExecutionEnv.exec`（argv 形式，无 shell 拼接、无命令注入面）运行**静态** helper：`node -e <固定代码> -- <rawPath>`。helper 只做路径规范化，绝不执行任何输入提供的命令/用户 helper。
- 一次 exec 同时完成：`root = realpath(env cwd)`（同 namespace 根）+ `target` 按实际 tools/env 语义解析（`~`→HOME、`file://`→fileURLToPath、绝对/相对+cwd）+ 仅真实 `not_found` 向最近存在祖先回溯（共享本次 exec 总预算，无每层独立预算）。普通合法相对/绝对、多级新建文件不误拒。
- stdout 是 **helper→网关私有通道**：恰好一行 JSON `{ok:true,canonical,root}` 或 `{ok:false,error:<类别>}`。canonical/root 只用于策略复判，绝不转发到客户端事件/审计/日志；审计仍只允许类别 token 与工具提供的 path 前缀（R3 白名单原样保留，定义移至 path-guard.ts、内容不变）。
- 真实取消：exec 的 `timeout`（秒）与合并后的工具 AbortSignal 都会杀 helper **进程组**；`execGuardHelper` **await 最终 exec response/exit** 才返回——本地等子进程退出+stdio 收尾，远端等 daemon result/error 帧。前端 deny 之前不存在该请求的活动 helper/RPC，无 `awaitWithContext` 早返回、无 race-return。
- fail-closed 矩阵：非 0 退出/坏 JSON/缺字段/多字段/非绝对路径/超量 stdout（4096 字节上限，不缓冲无限内容）/`timeout`→deadline/`aborted`/spawn 失败/RPC lost（daemon 断连）→ 一律 deny，类别只允许固定 token；helper 内 `permission/ELOOP/unknown` 拒绝不回溯，不逃逸、不假前缀、不把词法错误解析成 allow（词法 `..` 先解析成真实绝对路径再判包含）。
- 环境最小化：`inheritEnv:false` + 仅 `{PATH: 固定最小值, HOME}`，不继承网关 secret/全量 env。
- runtime 选择：Local 用 `process.execPath`；Remote 用镜像内 PATH 上的 `node`（`node:22.19-alpine` 自带，已核 Dockerfile）；能力不具备 → spawn 失败 fail-closed，绝不猜宿主机 node 路径等于容器/Pod 路径。
- HOME 语义对齐 tools：Local = 网关 `os.homedir()`（与 `NodeExecutionEnv` 文件工具一致）；Remote = daemon `connection.info().home`（与 `RemoteExecutionEnv` 的 `~` 解析一致），按 env 实例 WeakMap 缓存，info 失败可重试。

### 2.2 接线（`harness-host.ts` / `perimeter-extension.ts`）

- `createPathGuardResolver(envFactory, guardTimeoutMs)`：与工具同一 env 实例（`opts.env`），单一能力注入 `resolveGuardPath`（替代原 `resolveCanonicalPath`+`workspaceCanonical` 两个选项）。
- extension `guardPath`：单次 resolver 调用返回 `{canonical, root}`，包含关系判定 `canonical===root || startsWith(root+"/")`；原 `workspaceRoot` 缓存删除——根每次随 helper 同 exec 新鲜计算，**缓存毒化路径不复存在**（每次都是新的受控阶段）。
- guard 单阶段总预算（默认 3s）覆盖 helper 启动与全部解析；**审批人工等待不计入**：获批后漂移复检是新一次受控 helper 阶段（原 args、ACL/context 四眼绑定、deny>require_approval 取严逻辑一字未动）。
- capability 缺失语义不变：production fail-closed 拒绝，demo 留「守卫未启用」审计后按词法策略继续。

## 3. R3 三点修正落实

1. **stdout 契约**：§2.1 已写死——私有结构化返回，canonical/root 可含命名空间路径但不转发客户端/审计/日志。
2. **root namespace 归属**：helper 在容器/Pod 内取 `realpath(env cwd)`，Docker = `/workspace`；测试证明 `root === "/workspace"` 且 `!==` 宿主临时目录，`opts.workspace` 宿主路径零硬映射。
3. **机制口径**：`RemoteExecutionEnv.exec` 是已存在 pi-env 连接上的 RPC——每次 helper 调用 = **daemon 内一次 spawn**，不是每次新建 docker exec/kubectl exec；本报告不写任何未测 ~10/~100ms 时延数字。Pod 的 daemon 同样执行 exec 协议，但真实集群 kill/close 未验证，**保持 unknown**——不写「必然杀远端」也不写「只杀 kubectl 客户端」。

## 4. 测试证据（新鲜运行，命令与日志绝对路径）

| 运行 | 命令 | 结果 | 墙钟 | 日志 |
|---|---|---|---|---|
| 静态 | `npx tsc --noEmit` | exit 0，0 错误 | - | `/tmp/perimeter-s2-exec-helper/static-typecheck.log` |
| 专项（迭代期 3 次，最终 21/21） | `node --test tests/path-guard-exec-helper.test.ts` | 21 pass / 0 fail / 0 cancelled，exit 0 | ~13s | `/tmp/perimeter-s2-exec-helper/specialized-3.log` |
| protected-paths 全文件 | `node --test tests/protected-paths.test.ts` | 17 pass / 0 fail，exit 0 | - | `/tmp/perimeter-s2-exec-helper/pp-1.log` |
| 全量真串行 | `npm run test:serial`（`--test-concurrency=1`） | **477 tests, 477 pass, 0 fail, 0 skipped, 0 cancelled**，exit 0 | 239.8s | `/tmp/perimeter-s2-exec-helper/serial-full.log` |
| 全量默认有界 | `npm run test:bounded` | **477 tests, 477 pass, 0 fail**，exit 0（bounded runner 未超时） | 130.5s | `/tmp/perimeter-s2-exec-helper/bounded-full.log` |

- 477 = 既有 456 + 新增 21。迭代期首跑 5 处失败均为**测试期望值**未算 macOS symlink realpath（`/var`→`/private/var`、`/etc`→`/private/etc`）与一处 `..` 深度笔误，helper 行为本身正确；全部日志保留（`specialized-first.log`/`specialized-2.log`）。
- owned 资源快照（只观察、未杀任何进程/容器）：`resources-before.log` / `resources-after.log`——两次全量前后 owned 探针进程 0、`label=perimeter.gateway` 容器 0、全局 `docker ps -a` 亦 0。**无手工杀孤儿后声称自然 clean**：所有 fixture 经 `finally` 精确 own ID 真实 close（容器名 `perimeter-pgx<pid><tag>-pg-<tag>`、sentinel 精确 pid SIGKILL+exit 等待、env connection close、backend.cleanup）。

### 4.1 kill/close 正反控证据明细（全部真实进程，非 fakePromise/自报完成）

- **Local timeout**：受控不响应 helper（写 PID 文件后 `setInterval` 挂起）+ 同组孙进程；exec timeout 1s → verdict `deadline`，elapsed≥900ms（await 真实收尾，非早返回）；`kill(pid,0)`/`kill(child,0)` 双双 ESRCH、`ps -o pid= -p <pid>` 空、**`kill(-pgid,0)` ESRCH 证进程组整体消失**；先起的不相关 sentinel（独立组）无伤。
- **Local in-flight abort**：30s exec timeout 下 abort 信号 → `aborted`，elapsed<15s（prompt 杀组，不等满），同样 PID/PGID/组消失 + sentinel 无伤。
- **Docker 真实 RPC timeout**：容器内 `node -e` 挂起探针（PID 文件在容器 /tmp），`/proc/<pid>/stat` 实读 PGID；2s RPC timeout → `deadline`，随后容器内 `/proc/[0-9]*/stat` 全表扫描：helper/孙 pid 消失、**无任何进程挂在原 PGID**；同 daemon 健康后续请求正控（守卫解析成功 + `echo` exec 正常）。
- **Docker in-flight abort**：同上，abort → `aborted`，容器内组证据相同。
- **Docker daemon 断连**：挂起探针 + `docker stop` 容器 → exec 请求真实 settle（30s 有界等待防悬挂）且 `ok:false`——断连如实 fail-closed，不虚报 clean。
- **namespace 归属**：Docker 下 `root === "/workspace"` 且不等于宿主路径；`out→/etc/passwd` symlink 的 canonical 逃逸可见。
- 既有 protected-paths e2e（production Gateway + DockerBackend(none) + 仓库真实 policy + localhost mock，沿实际 callId/明确批次）17 项全绿：普通相对/绝对/多级新建写、保护 symlink/外逃/假前缀/NUL/ELOOP 拒且目标未变、canonical 升格审批独立 B allow、等待期漂移拒、能力缺失 fail-closed、白名单无泄露。

## 5. 边界声明（如实）

- **Pod/真实集群 unknown**：协议保证 exec 取消=daemon 杀进程组（`protocol.md §Cancellation`，本地容器已验证）；真实 K8s 集群的 kill/close 行为未验证，保持 unknown。
- **setsid 逃逸**：主动 `setsid()` 脱离进程组的后代不在组杀范围（与协议组级语义一致，与 bounded-runner 声明同口径）。
- **会话粒度关闭证明**：SDK/协议无单请求粒度关闭 ack API；本切片不声称该能力，未叠任何同义 early-return wrapper。
- **s2-protected-paths 仍 partial**：bash（无 path 参数）/硬链接/最终 check-use 窄窗竞态/敏感读（read 不扩守卫）不在本切片，残余不变。
- 非 Windows 部署面：linux 容器/Pod + darwin 开发（与现网关一致）；helper 严格协议校验（绝对路径等）在该面成立。

## 6. 残余与下一步

- 待 grok 第四审验收本切片；验收口径建议沿用「专项 + 477×2 双跑 + kill 证据复核」。
- 生产模式（production Gateway）路径类工具全部经受控 helper 守卫；`env.canonicalPath` 在生产路径已无调用方（SDK 本体未动，仅不再使用）。

## 7. R5（grok 第四审后修复）：字节契约、oracle 硬化、G1 in-repo 闭合、G3 边界纠正

- 日期：2026-10-16；dispatch：ctx_8755499c6785。R4 输入：`/tmp/perimeter-r4/{grok-gates.log,bounded-full.log(476/477 exit1),grok-kill-proof.log}`，协调者已独立核验三份原始日志。

### 7.1 小修 1（G2）：stdout 上限按实际 UTF-8 字节

- `execGuardHelper` 累计改 `Buffer.byteLength(text,"utf8")`（原按 UTF-16 单元计，R4 实测 9000 字节多字节输出被误接受）。
- 负控/临界测试齐：恰好 4096 字节（多字节 canonical、跨 chunk 且「路」被字节级劈开 2+1 字节）→ 正常解析；4097 字节（+1 ASCII）→ unknown；9000 字节级（UTF-16 单元 <4096）→ unknown；ASCII 5000 → unknown（既有）。

### 7.2 小修 2：kill oracle 硬化（修 R4 bounded 476/477 首败）

- R4 首败根因：abort 测试在 exec settle 后**立即**断言孙进程死亡——SIGKILL 已发但死亡/收割异步，瞬时窗口误判。
- 修复：精确出生/组身份核验（helper/孙 argv 内嵌唯一 marker，ps stat+command 匹配；pgid==pid 组长校验）；死亡与组空确认改为 **≤3s 总 deadline 轮询**，区分 活进程（marker 匹配运行态）/zombie（已死未收割，仍要求 3s 内收割完成）/PID 复用（command 不匹配 marker = 原进程确已不在）。核心断言（真实杀/组空/sentinel 无伤/await 真实收尾）全部保留，无固定 sleep、无吞断言、不 kill 不明 PID。

### 7.3 G1：home/metadata 移出 guard 路径（in-repo 部分闭合）

- `openEnvironment` 打开时的 `connection.info()` 结果经 `remoteEnvHome` WeakMap 缓存；`createPathGuardResolver` 同步读取，**guard 路径零 info() await**；无元数据立即 fail-closed。
- 实测：永不应答 daemon 下 resolver 拒绝 **0.4ms**（R4 缺口 30014ms）；Docker 套件证明打开缓存生效且守卫解析正常。
- **SDK 侧残留 = blocked**：daemon 掉线后下一次 exec 经 `Connection.request→#connect→#start`（connection.js:124/139/182，均无 ctx/signal；START_TIMEOUT 60s `:15` + 静默 30s `:13`）无预算重连，期间 abort 无法中断（监听挂于 `#send`）。最小 API 需求（session pin 透传 / connect 预算参数）与精确行号见 `s2-path-guard-bootstrap-blocker.md`。取消后无连接子进程尾巴已在正常路径证（精确容器名 pi-env 客户端计数 before/after 相等）。

### 7.4 G3：「deny 前无活动 helper」声明纠正（不采用 R4 的 closed 豁免）

- 事实（R4 原始日志）：close 路径 exec 0ms 返回 unknown，helper 46ms 后才消失 → settle ≠ 死亡确认。
- 修正后口径（源注释 + 本报告）：**Local** exec 在子进程真实退出后才 settle（返回时点已死，测试证明）；**Remote** exec 在 daemon 结果/错误帧后 settle——组杀已发起、死亡确认 **pending/unknown**；deny 两路均 fail-closed。生命周期兜底（close/容器销毁）不是单请求收尾证明。
- 断连测试更名并只断言 deny fail-closed；不再声称单请求已结束。真正闭合需 daemon 杀组后回 ack（最小 API 需求 ③，见 blocker 文档）。
- unconfirmed 追踪：Docker fixture `create→inspect→cleanup→inspect-gone` 精确 owned 名闭环，cleanup 后仍在即显式 unconfirmed（不强杀、不忽略）。

### 7.5 R5 新鲜验证证据

| 运行 | 命令 | 结果 | 墙钟 | 日志（绝对路径） |
|---|---|---|---|---|
| 专项（迭代 5 次+最终态复跑） | `node --test tests/path-guard-exec-helper.test.ts` | 21 pass / 0 fail，exit 0 | ~13s | `/tmp/perimeter-r5/specialized-final.log`（迭代 specialized-1..5 保留） |
| e2e | `node --test tests/protected-paths.test.ts` | 17 pass / 0 fail，exit 0 | - | `/tmp/perimeter-r5/pp-final.log`（迭代 pp-1 保留） |
| 全量真串行 | `npm run test:serial` | **477 pass / 0 fail / 0 skipped / 0 cancelled**，exit 0 | 247.1s | `/tmp/perimeter-r5/serial-full.log` |
| 全量默认有界 | `npm run test:bounded` | **477 pass / 0 fail**，exit 0 | 130.5s | `/tmp/perimeter-r5/bounded-full.log` |
| 静态 | `npx tsc --noEmit` | exit 0 | - | 会话内执行（0 输出） |

- owned 资源快照（观察计数，不杀）：`/tmp/perimeter-r5/resources-{before,after}.log`——全量前后 `label=perimeter.gateway` 容器 0、全局 `docker ps -a` 0、探针进程 0；套件内为精确 owned 名 create→inspect→cleanup→gone 闭环。历史 3 容器/7 未确权孤儿未触碰（当前全局 0，不推断删过）。
- 边界重申：s2-protected-paths / S2 / 企业放行维持 partial；真实集群 Pod kill/close 仍 unknown；G1 SDK 重连预算与 G3 死亡确认两项 **blocked**（blocker 文档），不冒充已闭合。

## 8. R6（grok 第五审 required 跟进）：3 项集成测试静默删除的恢复记录

- 日期：2026-10-17；dispatch：ctx_0a54b0639562。依据：`docs/reviews/grok-s2-protected-paths-slice-a-round-5.md` §5。

### 8.1 事实链（删除 → 恢复）

- **删除根因（如实）**：R5 轮 G2 块重写用 Python 切片 `s[:start]+new_block+s[end:]`，end 锚点（G1 测试）位于集成节**之后**，切片把 `makeRealExtension` fixture 与 3 项「集成（Local 真实 helper）」beforeTool 测试一并切掉，且实施报告 §7 未声明——专项文件 21→21 表面持平掩盖了内容替换。R5 独立审查发现（本审结论引用）。
- **恢复方式**：从本会话首写版逐字恢复（fixture、3 项测试、断言与原版一致；未降断言、未改产品 src）。恢复位置＝原相对位置（G2 块之后、G1 测试之前）。文件仅新增插入节（66 行），其余 21 项测试未改动；R5 已有限批准的 G2 UTF-8 / G1 metadata / oracle 硬化全部原样保留（21→24，无替换式删除）。

### 8.2 恢复的 3 项与等效 e2e 覆盖对照

| 恢复项（单元级 beforeTool，真实 NodeExecutionEnv + createPathGuardResolver） | protected-paths.test.ts 等效 e2e |
|---|---|
| 多级新建文件不误拒，写路径守卫放行 | 正控：普通相对写（多级新目录）与 workspace 绝对路径写不被误拒 |
| 绝对路径在 workspace 内放行 | 同上（/workspace/abs.txt 场景） |
| symlink 外逃/循环/NUL/~越界拒 且 denied 事件无宿主路径 | 反控：symlink 命中保护子树/外逃/假前缀+NUL/循环 symlink fail-closed（单元级额外覆盖 denied 事件脱敏断言） |

- 定位说明：e2e 走完整 Gateway+Docker 链路，恢复的 3 项是**单元级 Local 真实链路**（真实 helper、真实 env、真实 policy，仅 approvals 桩为抛错哨兵），两层互为补充；该差异在 R5 §5 已被接受为「须恢复」而非「可豁免」。

### 8.3 本轮验证证据（诚实范围声明）

| 项 | 结果 | 日志（绝对路径） |
|---|---|---|
| 本文件静态计数 | 24 = 21 + 3（恢复后；21 项名称与 R5 全绿版本一致） | 本节记录 |
| 全仓静态顶层 `test(` 计数 | 405（runner 口径 477 含嵌套子测试/动态注册差异——**本轮未跑全仓实数，不假称 480 已 pass**） | 本节记录 |
| 恢复 3 项限定专项 | `node --test --test-name-pattern 集成 tests/path-guard-exec-helper.test.ts`（bounded runner，120s 外部 deadline，PGID=54686 独立组）：**3 pass / 0 fail / 0 skipped，exit 0，708ms** | `/tmp/perimeter-r6/restored-local.log`（含 raw argv/counts/skip/actualexit/wall header） |
| typecheck | `node node_modules/typescript/bin/tsc --noEmit` exit 0（npx tsc 的 pnpm store 链接损坏，属环境问题，与本轮改动无关） | 会话内执行 |
| owned 资源 | `docker ps -a` 计数 0、探针进程 0（本轮零容器创建） | 会话记录 |

- **范围声明**：本轮仅运行名称含「集成」的 3 项；其余 21 项（含 4 项 Docker 门控）未运行——按协调者指示不跑 Docker 套件/全量（daemon 本轮探测响应 23ms，但授权范围不因此扩大）；旧 477×2 为 R5 前产品作者证据，**不代表当前 480 实跑通过**。Docker 门控测试的 `dockerReady` skip 条件在模块加载时求值（name-pattern 运行的已知副作用，各 4s 超时上限，未创建任何容器）。
- G1 SDK 重连预算与 G3 远端死亡确认维持 **blocked**（§7.3/7.4 与 blocker 文档不变，本轮未顺手改 SDK、未加 race 包装）；s2-protected-paths / S2 / 企业维持 partial。
