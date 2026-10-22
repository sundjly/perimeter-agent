# grok-s2-sdk-session-pin-round-14.md — R13 后真实行为回归「执行前安全门」独审（task_8403a30f3b75 / ctx_fcadc4b7148f）

- 日期：2026-10-18；审者：Grok（唯一 reviewer）。被审对象：Pi task_c156093d73fa / ctx_0bbe315dbf82（`docs/implementation/s2-sdk-session-pin.md` §18 + 私有准备 root `/tmp/perimeter-r14-prep-zJp8vI/`）。
- 审性质：用户已授权下一阶段隔离 owned 真实 daemon/Docker 行为回归；本审为执行前安全门，只评估执行许可条件，**审者零真实资源执行**：未启动任何 daemon、未创建/运行任何容器、未 import/运行任何资源脚本（repro.mjs/preflight.mjs/行为脚本均未运行）、未跑 SDK 定向 5/原 test/全量/installer/builder。审者执行面仅为：`node --check`（纯语法解析）×6、`shasum`/`cmp`/`grep`/`stat`/`ls`、pi-mono 只读 `git rev-parse`/`ls-tree`、以及协调者**纯假** oracle（vm 抽取作者两函数+假 readFileSync，零 SDK/资源 import，经既有 bounded runner，详见 §4）。
- 允许写入范围：本文件、`docs/reviews/handoff-coverage.json`、审者自有 mkdtemp 0700 root `/tmp/grok-s2-r14-review-ywuOYhI1/`。Pi 全部 root（r14-prep-zJp8vI、r12-m4cMpYUE、r12-neg-xgztXCcT、vtVfSNbd、grok r12/r13 roots）与协调者 oracle root 只读未触（oracle 复跑仅向其自身 root 写 source-provenance.json 0600，系脚本自身行为）。
- **verdict：request_changes——required 共 9 项（§3），全部在 owned 副本内可修；修复后须本审对受影响函数定向复审，通过后协调者另派真实执行。**

## 0. 审者偏差披露（事实为本）

本审曾于仓库根短暂误写 6 个杂散文件（`evidence-{preflight.json,runner-preflight.log,plan.md,sdk5-behaviors.mjs,docker-owned-probe.mjs,hashes.txt}`，系 cd 进入仓库后 cp 目标用了相对路径，内容为 Pi 交付件字节副本+审者哈希清单）。**同一分钟内已全部删除并核验**（`ls evidence-*` 无残留；git status 无新增）。如实记录，不隐瞒。

## 1. 交付物与先验复验（全部实测，非转录）

| 项 | 实测 | 先验 | 结论 |
|---|---|---|---|
| repro.mjs（副本） | `47c6b1de46b54c9d…`；与 R13 冻结根 `/tmp/perimeter-sdk-isorebuild-r12-m4cMpYUE/repro.mjs` `cmp` **逐字节相同** | §18/R13 v2.1 终态 | ✓ |
| sdk5-behaviors.mjs / abort-fixture.mjs / docker-owned-probe.mjs / preflight.mjs / plan.md | `a0625d446fb2c410…` / `009148ab9a75af39…` / `956c4e030e6ddec8…` / `0cdb3c4588706740…` / `9adf942d6d314fd0…` | §18 / sha256-deliverables.txt | ✓（audit-notes 内行值陈旧见 O-1） |
| helpers（ps-observer/daemon-resource） | `eaf01cf56f3d073f` / `81d6a84130274d80` | §16.5 R11 终态 | ✓ 未触，R11 门不重开 |
| tests/session-pin.test.ts（perimeter） | `aefcd68dcad0c7ce`（工作树实测） | §16.5 | ✓ 未触 |
| vendor manifest / patch / builder | `0b87934f4c868fde` / `940892b9015167ef` / `4075300079648e8f` | 任务先验 | ✓（builder 未执行） |
| 安装 dist 4 文件 | `d59a1c09…`/`5ba868c9…`/`13394770…`/`6333328d…` | manifest.patched | ✓ 自洽 |
| daemon 二进制 / runner / TS / pi-durable | 904656B `4a1c99b9b78bb6a8…` / runner `23966148ad84b4a7` / TS 5.9.3 / pi-durable 1.1.0 | 既有台账 | ✓ |
| pi-mono 固定对象 | `cdaf6c227d4718a72…`^{commit} 解析成功；base 两 blob `9bfe18df49a2f2d1`/`52092c1d55151a24` 与 patch 头 index 前缀吻合 | §17.1 | ✓（只读） |
| pi-mono 工作树 | HEAD `8efd314fa…`（外部漂移只记录）；两源 `99f27fffffe75e75`/`21b96cd2c7ecb890`＝无 pin 态；原 test `??` 未跟踪、stash 原样 | §17.4 | ✓ 历史保留 |
| preflight 证据自洽 | runner exit 0/timedOut=false/205ms/PGID 87851＝children jsonl 4 行/docker ready×3 | §18 | ✓ |
| `node --check` | 五交付脚本+协调者 oracle 全过 | — | ✓ |

## 2. 执行许可条件逐项评估（静态成立部分）

| 条件 | 证据（文件:行） | 结论 |
|---|---|---|
| import fresh 重建产物（8/8 门），非 current 源/安装态冒充 | sdk5:424-426（无 summary.json 或 verdict≠"8/8 SAME" 红停）；:402-411 import 前逐字节 SHA==manifest.patched，仅 import 本 root `out/patched/dist`；docker-owned-probe:140-145 同门＋:128-135 字节桥 | ✓（模块实例口径见 O-5） |
| deps 最窄现装；daemon owned 字节副本；无下载安装 | sdk5:435-444（仅 `pi-durable` realpath symlink+版本 1.1.0 硬校验，缺包红停）；重建 dist 运行时 import 面=connection.js 仅 node 内建＋remote-env.js `pi-durable/env`+dist 内相对模块（d.ts chord 为 type-only；`./env` 导出实存）；daemon copyFileSync+SHA 复验+0500（:430-433） | ✓ |
| 不跑/不改/不导入原 SDK 5；新五行为另名；历史保留 | 四脚本对原 test 零引用（sdk5:5 仅注释映射）；id `b1_…`/`b5_…` 另名；§18/plan §6 状态保留 | ✓ |
| 注册/身份/kill 纪律；zombie；全 settled 兜底 | track register 同步先于 await+finalizer 状态机（daemon-resource:86-127）；kill 前 inspectIdentity 全字段（:139-156）＋B3/B4 显式调用；waitOwnerGone zombie 等待/deadline 失败、gone 口径不推归属（ps-observer:107-141）；零 pgrep/pkill/kill-0/全局 ps-0 作死亡证明 | ✓（B4/B5 特例缺口见 R-Q14-4/5） |
| 不实现 G3；<2s knownlost 不当全 G1 3s | 无 closeAsync/verifyReap；summary `knownLostBudgetNote`（sdk5:487） | ✓ |
| 0600 白名单 ledger；无 command/env/token/raw 通道；命令内存布尔 | 唯一持久通道=helper `appendLedgerEvent`（12 键白名单+outcome 38 项枚举+driver 深投影+创建即 0600，ps-observer:180-280）；command 仅内存 includes（sdk5:189、probe:110-118）；raw/stack 仅 0700 私有 evidence（sdk5:467-470）；token 永不落盘 | ✓ |
| Docker：单镜像/不 pull/build/restart/切 context；network none/既有 hardening/owned ws/nonce 名/full CID/exact gone/unknown 从严 | IMAGE 常量（probe:38、:152-154 缺镜像 docker_blocked）；docker 子命令白名单 grep 实证（version/image inspect/inspect×2）；`network:"none"`→`--network none`（execution-backend:510）且 bindVerifiedNetwork 未调用零网络创建；hardening :521-535；repo 挂载全 `:ro` :536-541；nonce 名 :157-161；classifyInspectGone 整句精确+live/unknown 从严（:201-209）；driver 投影+不可观测 failures.push（:214-222）。**fullCid 未验 64hex、driver 缺正向出生核验 → R-Q14-7** | 部分 ✓ |
| preflight 只读/blocked 客观 | preflight.mjs 只读 4 子命令；blocked/unknown 只记状态不修服务（:110-118） | ✓（镜像证据投影见 R-Q14-9） |
| R11/R13 门不重开；stage 不预支 | §1 哈希表全符冻结台账；§18/plan §6/summary note 边界一致 | ✓ |

## 3. required（9 项；含协调者 3 条跟进消息的独立核实结论）

1. **R-Q14-1 Docker 整轮预算与口径**：交付 plan.md:17/probe:16,20,231 均为 90s，派单要求 `wholeDocker30s`；改 30s。同时修正「每个 docker/ps 子命令各≤5s」口径：probe 显式子命令 5s 属实；**产品 backend 内部** `plan.start`（docker run -d）为 `openEnvironment:47` 硬编码 `timeout: 30_000`、cleanup `rm -f` 为 `execution-backend:636` 5s——须如实标注，不得宣称全部子命令 5s；整轮 30s runner 为兜底。
2. **R-Q14-2 withDeadline race/unref（协调者红#1+本审独立复现）**：sdk5:209-217 `Promise.race`+`timer.unref()`：deadline 返回后底层 case promise 仍存活，finally 清理可与迟到 snapshot/exec 并行——B4 unpinned 重连在 cleanup 期间懒启动新 daemon 即为真实泄漏路径。修法：deadline 后取消请求（abort）/关闭连接并**真正 join 底层 promise 结算**（有界）后再 finalize；删除 unref。实证：协调者 purefake oracle 0/2 exit1（runner.log PGID 24491），本审独立复跑 **0 pass/2 fail exit 1（PGID 34882，grok-oracle-rerun.log）**。
3. **R-Q14-3 readReady 同步阻塞（协调者红#2+本审独立复现）**：sdk5:184 `Atomics.wait` 同步轮询阻塞事件循环，而 B5 :359-360 两个 async exec 发起后立即 :365 进入读取——SDK 首个 await continuation/transport I/O 无法推进，ready 结构性不可达（3s 假超时）。修法：异步轮询（`await sleep`）。
4. **R-Q14-4 B4 新代提前登记**：sdk5:311-331 先 `tools.exec` 真实重连并多次 await 之后才 `trackDaemon(b4-new)`；中间任一失败（如 :322 factory 断言）新 daemon 无登记，runAllCleanups 只知旧代 → 泄漏。修法：触发重连**之前**预登记新代 cleanup（cleanup 时点迟发现身份：snapshot→observeBirth→dispose，不可观测显式 unknown），不以观察旧 PID gone 替代。
5. **R-Q14-5 B5 fixture 子进程 finalizer 缺失**：sdk5:379-387 仅在 abort-wait 失败后才登记补杀 cleanup；ready/出生核验/abort/sentinel 中途失败路径上 long/sentinel fixture（寿命 8s/0.6s）无登记，longP/sentinelP 不在全量 settled 内（悬空/unhandled 风险）。修法：ready 核验通过后**立即**登记 matchesGeneration 前置的补杀 cleanup；longP/sentinelP 全路径 await/join。
6. **R-Q14-6 lost oracle 强化**：B3 :279-285、B4 barrier :303-308、stale :324-327 仅断言 `code==="unknown"`；原 SDK test（:100-101/:117-118）同时要求 `error.message` 含 "connection lost"——任意 unknown 类错误可假冒 knownlost 通过。修法：加**内存布尔**匹配（不含 "connection lost" 即失败；布尔结果可入 ledger，原文不持久）。
7. **R-Q14-7 Docker CID/driver 证据收紧**：probe:171-175 `fullCid=cid` 仅 `!==undefined`，未验 `^[0-9a-f]{64}$`（"full 64-hex" 声明无守卫）；:109-119 driverProbe 首个 name+` pi-env` 命中即取，未验 ppid/pgid 正整数、birth 非空等正向出生（driver 为产品 spawn 的 `docker exec` 客户端，expected ppid=probe pid 可核）。修法：非 64hex→unknown 失败；driver 正向身份不符→unknown 从严（与 R11 §16.3-2 同口径）。全表 ps 发现方式沿用已批共享格式不改。
8. **R-Q14-8 全路径 settled 与 failure JSON 完整性**：docker-owned-probe try/finally 之后的 :228 `runAllCleanups` 在 finally 自身抛错（如 ledger 写失败）时被跳过——ws/container 清理登记失守；且 main 顶层 catch（:244-253）unhandled 路径只写 raw log 不写 failure-docker.json（stderr 却引用它）；sdk5 顶层 catch（:505-511）同病。修法：清理聚合移入任何异常路径都执行的兜底；unhandled 路径也写完整 failure JSON（固定类别）。
9. **R-Q14-9 preflight 镜像证据白名单**：preflight:152-153 将无 `--format` 的整份 `docker image inspect` JSON 落 `docker-image-id.txt`，与头注「仅 Id」不符（:185-187）。修法：`--format {{.Id}}` 或仅投影 Id 字段；已跑证据原样保留，重跑用修后脚本。

## 4. 协调者跟进核实记录（3 条消息逐项）

- 消息1（race/unref、readReady 同步阻塞、B4 迟登记、lost 判定、B5 finalizer、Docker 90s）：全部核实成立 → R-Q14-2/3/4/5/6/1。
- 消息2（fullCid 64hex、driver 正向出生、backend 内部预算、全路径 settled、preflight Id 投影、planSha 真值、owned/installed 桥接口径、门的意义）：核实成立 → R-Q14-7/1/8/9、O-1、O-5。backend 预算实测：`openEnvironment:47` start=30s、`execution-backend:636` cleanup=5s（另有 reapOrphans :658 2.5s，probe 不触发）。
- 消息3（purefake oracle 落盘 0/2 exit1）：oracle 文件已亲读——仅 vm 抽取作者现 SHA（`a0625d44…`，source-provenance.json 在其 root 0600）的 `withDeadline`/`readReady`+假 readFileSync/fail，零资源零 SDK import。本审独立复跑（bounded runner 10s）：**tests 2 / pass 0 / fail 2 / exit 1 / PGID 34882**，红冻结未改。

## 5. 观察项（不阻塞；随修复包文本同步）

- **O-1** audit-notes.md:25 行内 plan.md SHA `0dbbcad6…` 为 r2 修订前旧值；真值 `9adf942d…`（§18/deliverables 一致）。重发时保留版本序更正。
- **O-2**（并入 R-Q14-2/3）。
- **O-3**（并入 R-Q14-8：unhandled 通道补 failure JSON；固定类别纪律维持）。
- **O-4** sdk5:383 outcome `abort-kill-unproven` 在 38 项枚举外→ledger 映射 unknown（plan §5 已披露；精确类别由 failure-sdk5.json 承载）。helpers 本轮禁改，维持现状正确。
- **O-5** 桥接措辞精确化（须写入重发文本）：owned dist 类与产品 installed dist 类是**不同模块实例**，桥接为**字节级**等同（已证），不声称「所有连接都是 owned 实例」；五行为连接全 owned-dist；Docker probe 的 guard 实例 owned-dist、产品 backend 内部连接为 installed-dist 字节等同实例。

## 6. 边界声明

本审只证明：交付脚本集的静态/先验状态，以及 9 项 required 的精确定位。它不构成：任何真实行为通过；G1 全部 3s 预算（30s 静默窗口/无响应 CANCEL 仍 blocked）；G3 lost；S2 企业接受；原 SDK 5 已跑（未跑+未导入，历史「current 源 5 fail」保留）；stage 任何上调（s2-path-guard/protected-paths partial、real-egress external_blocked 不变）。R11 日志门/R13 artifact 门不重开；本审与协调者均未运行任何真实资源。修复全部限于 owned 副本（prep root 冻结，重发须 fresh root 重新复制并同步 SHA/文本）；**修复后由本审对 R-Q14-2~9 受影响函数定向复审（可再用 purefake 接缝法），通过后协调者另派真实执行**。

## 7. 证据保留

审者审计 root（0700，不删）：`/tmp/grok-s2-r14-review-ywuOYhI1/{evidence-hashes.txt, evidence-preflight.json, evidence-runner-preflight.log, evidence-plan.md, evidence-sdk5-behaviors.mjs, evidence-docker-owned-probe.mjs, grok-oracle-rerun.log}`。协调者 oracle root `/tmp/perimeter-coordinator-r14-oracles-phIYrr/`（冻结）。Pi 交付 root `/tmp/perimeter-r14-prep-zJp8vI/` 与全部历史 root 只读未触。
