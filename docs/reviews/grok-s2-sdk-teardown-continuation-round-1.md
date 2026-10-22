# grok-s2-sdk-teardown-continuation-round-1.md — Pi SDK teardown 结算硬化延续轮真实执行独审（task_1d32155f0dd9 / ctx_0721875c1303；Grok R38）

- 日期：2026-10-18；审者：Grok（唯一 reviewer，原终端/模型复用）。被审对象：Pi task_1d32155f0dd9 交付（author root `/tmp/perimeter-s2-teardown-lMDwlI` 0700/UID501；repo 冻结面=runtime/test/vendor/builder/installer，文档/metadata 收尾仍允许）。目标哈希三方独立核对全符：patch `aac1576e…`、dist/connection.js `fa270daa…`、builder `02b0bd13…`（实测 vendor/pi-env/ 三件逐字节相符）；vendor manifest.original 四文件（a11354ee/b3d31de4/7a0c63f6/21afc6ff）与 manifest.json 记录一致未动。
- 审性质：**真实执行审**。审者 fresh owned 0700 root `/tmp/grok-s2-teardown-r38-dCQxnm`（全部脚本/日志/元数据在 root）；自有外层 runner（预挂墙钟秒截止覆盖子进程全生命周期、setsid 独占 PGID、wait() 取直接子进程真实退出码、ps 观察 direct child+组员 birth/argv，ps 失败=unknown 不冒空组）；author 适配件仅复制+EXPECT/SHA 差异核（sdk5 diff 10 行/probe 8/preflight 10/repro 15，全部 EXPECT 表+头注，语义零改写、断言零削弱）。零 commit/push/reset/stash/clean、零安装、零 pi-mono/paseo 写入、零未知进程扫描/清理、零容器清理。
- **verdict：approve（有界：仅限 S2 SDK teardown 延续切片的 SDK patch+builder 管线+测试本体）**——全部行为证据审者独立复现（见 §2）；附 2 条 required 跟进（证据时钟修复+重跑、文档计数对齐，见 §5，均非产品代码缺陷）。S2 维持 partial；G1 全 3s/G3/S2 企业/客户 external 不升级；54m57s 旧 node 生命周期 unknown 独立保留（本轮全部新执行为新 owned 独立 PGID，不作旧退出倒证）。

## 0. 过程公平记录

1. coor 冻结/计数纠正 send 晚 3 秒 `dispatch_inactive` 未送达——Pi 不视为已读；本审按实际终态文档+实盘判，不引用未送达要求。
2. author root manifest 实测 **20/20 OK**（shasum -c 独立复验）；manifest 只列 20 件（脚本/provenance 子集），root 实际产物多于清单——author 全覆盖不背书，审者证据全部独立重建（本 root）。
3. 审者自身偏差如实记录：①首跑 preflight 因审者 root 子目录 0755 触发 `root_mode_invalid` 红停（chmod 0700 后过，红日志留存）；②sdk5 三次诚实话失败：`b5_fixture_missing`（审者布局缺 fixture）→`unhandled EACCES`（首次运行遗留 0500 只读 daemon 副本挡覆盖）→定位后清自有副本重跑过；③诊断副本（仅 stderr 打印 stack，node --check 过，官方件零改）用于定位 EACCES，定位后即删，不作证据替代；④negpin 负控脚本两次自错（bash git() 自递归/out-dir 预建触发负控①）修正后三态成立。全部红/失败日志原样留存于审 root logs/。

## 1. SDK patch/builder/install 静态核（源码逐行）

- **patch hunk（#teardown 硬化）**：`clearInterval/清 #session/#ready/stdin.end/child.kill` 全入 try，end/kill 各自独立 try/catch，**pending reject+清 map 迁入 finally 独立 finalizer**；正常路径次序与原实现一致；close 幂等由 live 守卫+pending 恰清一次保证；与旧 patch 全 diff 仅此 hunk+index 缩写（报告 §1 与实盘一致）。
- **build.mjs 源管线**：base 固定 pin=manifest.base.head（cdaf6c227）只读 `git show` 提取；owned mkdtemp materialize+`git apply --check`/`apply` 本仓 patch；patched≠manifest.base.sources → 源 drift 拒绝（:106-108）；pin 基线≠sourceBaseHashes → base drift 拒绝（:78）；patch 文件 hash≠patchFileSha256 → 拒绝（:80-84）；base emit vs vendor/original 4/4 SAME 漂移核对保留（:130-143）；out-dir 已存在拒绝（:42，负控①语义）。
- **install 迁移**：安装态实测==新 manifest.patched（preflight 9/9 含此检查）；旧态 unknown→installer fail-closed→受控回滚 original→apply（author §3 记录；installer 测试 14/14 独立过）；original 四文件未动；旧产物 previous/+git index 留底。
- **coor 指认「baseRef 缺/坏 head 退 HEAD+无 git guards」负控实证（审者自有 fixture，完整红留 neg-A/B/C.log）**：
  - A（head=pin 在场）：预校验通过且日志明示 `base pin=53eb87c2…`——pin 被采纳非 HEAD；
  - B（prior 在场+head 删除）：**拒绝**于 build.mjs:78 `base drift：pin HEAD 基线源 hash 与 sourceBaseHashes 不一致——停止`——HEAD 回退被 sourceBaseHashes 背卡，不静默产出；
  - C（head=40hex 不存在）：`git show deadbeef…` Command failed 响亮失败。
  - 结论：生产形态（prior+hash 台账在）**无缺 pin 静默产出路径**；残余=回退无显式告警行（B 的报错文案「pin HEAD」易误读）+builder `bounded()` 60s 默认 SIGTERM、git 子命令无 GIT_* 隔离（对比 repro/tests 有）——记**次要加固建议**（R-Q38-3，optional），非门、非 required。

## 2. 真实执行（审者 root 独立复现；每次一个顺序执行；完整日志留审 root）

| 运行 | Node exit | 外层 wall | 结果 |
|---|---|---|---|
| tailgate-r9（适配版） | 0 | 1s | **6/6**（含④forceSettle 真回收、⑥decision绿→exit-wall写盘跨截止→finalize翻红） |
| wholetimer-r9 | 0 | 1s | **6/6** |
| joinfb-r19 | 0 | 1s | **5/5** |
| purefake-r19 | 0 | 1s | **20/20**（SHA pin cb1e2cc5+docker 5ec9a6a7 校验过） |
| **红对照 r8**（75267a65+tailgate-r8） | 1 | 1s | **①②⑤红、③④绿；①失败=`AssertionError 越窗恒红非零 / 0 !== 4`——语义红，非 TypeError/缺 marker/SHA 错** |
| tests/pi-env-teardown-fault | 0 | 1s | **5/5**（真 pending 屏障=REQUEST 帧写出计数 `requestWrites>=3/>=2`+flushRequests；end 抛/kill 抛/双抛/无故障 closed 语义/original red 对照=close 穿透+pending 150ms 不结算，修复前缺陷实证在案） |
| tests/pi-env-build-negative | 0 | 2s | **4/4**（负控②=patch 应用结果 vs manifest.base.sources drift 拒绝） |
| tests/pi-env-patch-install | 0 | 1s | **14/14** |
| tests/docker-backend | 0 | 15s | **34/34**（真实 docker 29.8.2；含新 start.env.PATH 断言=§6 缺口修复回归） |
| preflight | 0 | 1s | 9/9（安装态==新 patched、docker ready；审者首跑 0700 红留痕） |
| repro（EXPECT 适配版 4529628b） | 0 | 2s | **8/8 SAME（wall 1119ms）**：cdaf6c227+新 patch→base==original==manifest.original、patched==dist==manifest.patched 逐字节；旧 47c6b1de 冻结件原样保留于 r9 root，适配件 SHA 4529628b 如实不同（未冒充不变） |
| sdk5（EXPECT 适配版 cb1e2cc5） | 0 | 6s | **5/5 behaviors pass**（B1 445ms/B2 44ms/B3 49ms/B4 96ms/B5 5097ms）；cleanupAggregate=all-settled；wholeDeadlineFired=false；exit-wall-sdk5.json 在案（wholeWallMsAtFinalize=5762，注明非 OS/Node exit 观测）；children=7 与 events 台账一致 |
| docker-owned-probe（适配版） | 0 | 1s | 生命周期 pass（run→inspect→driver 正向 join→rm→inspect-gone，children=10）；**summary.wallMs=1792324005691.767ms 垃圾值当场复现**（见 R-Q38-1） |
| bounded 全量 serial | 0 | 240s | **564/564 pass、0 fail、0 cancelled、0 skipped、0 todo**（与 author 564/240s 一致；计数取自 runner 输出非 shell exit） |
| typecheck | 0 | 3s | 过 |

oracle 适配 diff 独立核：与 R20 精度备注逐条对应（tailgate③跨文件口径/⑤打桩说明）；loadTail 改返回函数+④`firstRun`+forceSettle 回收（ hang 模型单次调用双 catch，无第二悬 promise）；case_failed 前缀断言=真实组合类别 `case_failed:<case>:<category>` 所需；wholetimer r8 时代锚点改 r9 结构；purefake 沙箱补 DAEMON_COPY/PRIVACY_LEDGER/SUBCOMMAND_TIMEOUT_MS+fake inspect 3 字段（重验不符用例改恒返另一 CID 真实达门）——**断言零削弱，全部机械缺陷修复忠实**。

## 3. 口径与偏差（保留不洗）

- **审者外层 runner 口径**：截止覆盖 prelude/ps/tail/cleanup；real exit=wait() 直接子进程；每轮 nonce/PID/PGID/birth/argv/group 入 provenance.jsonl；终态全部 group_empty（审者自有 ps 观察；不消费 author runner getGroupPids 折叠[]的 zero-residue）。author run_logged.py `proc.wait()` 无自身 deadline（:35）、macOS `ps -g` 失败=unknown——与 author residue_unknown 披露一致，不构成本轮证据缺口。
- **author 偏差如实保留**：/tmp 调试件直写直跑+process.exit 假结算（§8 披露，原件未删）；本轮前段裸 python3 违规（§8 披露已停用）；两次原样失败 failure.json/failure-docker.json 留存；owned 临时 git 仓生成 patch（§9 台账，gitinit 重建来源如实）。均不洗、不回改；文档须与之一致（见 R-Q38-2③）。
- 54m57s unknown 独立保留；本轮新 owned 组不作旧退出证明；不因旧 unknown 收回本轮执行授权。

## 4. 与 author 报告实盘差异（独立核出）

| # | 报告 | 实盘 |
|---|---|---|
| 1 | §0 表「适配版绿 36/36」；§18.3 时点「tailgate5/5」 | 实际终态 **37/37**（tailgate 6）；§5.3 已是 37——同文档自相矛盾，陈旧计数未同步 |
| 2 | §5「green/（适配运行版 sdk5 fc23e9d3…）」 | author root manifest 与实盘均 **cb1e2cc5**（green/ 与顶层同字节）；fc23e9d3 为陈旧值 |
| 3 | §10 evidence root 描述 | manifest 20/20 属实（审者复验）；但 manifest 只覆盖 20 件脚本/provenance 子集，非全 root 产物（与 coor 判断一致） |
| 4 | probe green 输出 wall=~580ms（正文） | 实测外层 ~1s；summary.wallMs 字段=混时钟垃圾 1.79e12（Date.now−performance.t0），正文 ~580ms 为内 runner 外测值——报告未标明 summary 字段已坏 |

## 5. required 跟进（最小必须修项；非产品代码缺陷，不回滚本轮 approve 主体）

- **R-Q38-1（证据时钟，code required）**：docker-owned-probe.mjs:544 `wallMs: Date.now() - t0`（t0=:131 performance.now 单调）→ 改 `elapsedMs()`（同单调时钟；:207/:218 的 Date.now 成对用法不动）；修后须**新独立实际跑一次 probe** 留真实 wall。行为结论不受影响（pass 判定基于 ledger 事件链），但 summary 证据字段当前为垃圾值，不得继续以坏字段留证。
- **R-Q38-2（文档对齐，metadata required）**：①§0 表 36/36→37/37（6+6+5+20）；②§18.3 时点 tailgate 5/5→6/6；③§5 sdk5 SHA fc23e9d3→cb1e2cc5（并注明 green/==顶层同字节）；④probe wallMs 坏值在报告中如实标注（正文 ~580ms=内 runner 外测、summary 字段待 R-Q38-1 修复后重采）；⑤manifest 覆盖口径写明「20/20 子集清单，非全 root 产物」。
- **R-Q38-3（optional 加固，非门）**：build.mjs baseRef 回退 HEAD 时打显式告警行（或 prior 存在且 head 缺失直接拒绝）；builder git 子命令补 GIT_CONFIG_NOSYSTEM/GIT_TERMINAL_PROMPT=0 隔离；`bounded()` 超时 killSignal 显式化。做不做均不影响本 verdict。

## 6. 边界维持

S2 维持 partial（真实集群出口/敏感读封闭/DLP/repo-scoped token 等 §5.2 P0 与 CNI/客户环境 external）；G1 全 3s 预算（30s 静默窗口）/G3/企业接受不升级；SIGKILL+waitpid 内核时延未静态证明（恒红门+runner 兜底为结构保证）；本轮 SDK patch 语义边界=客户端 close 结算硬化，协议零变化，sessionPin/G1 行为以 sdk5 5/5+564 全量回归为证，产品面不动。

## 7. 证据保留

审者 root（0700/UID501，不删）：`/tmp/grok-s2-teardown-r38-dCQxnm`——outer-run.sh/negpin.sh、logs/provenance.jsonl（16 轮运行 nonce/PID/PGID/exit/外层 wall/residue）、green|red 适配件副本与全部红绿日志（含 tailgate-r8-red 0!==4 完整红、negpin A/B/C、sdk5 三次诚实话失败与诊断定位链）。author root 只读零改动；repo 写入仅本报告+handoff-coverage.json（round38）。
