# grok-s2-sdk-teardown-continuation-round-2.md — R38 外层 runner 与证据口径勘误 + v2 runner 独立重执行（Grok R39；task_3f7aa4ce0dde）

- 日期：2026-10-18；审者：Grok（唯一 reviewer，原终端/模型复用）。R38 报告（docs/reviews/grok-s2-sdk-teardown-continuation-round-1.md）与 coverage 历史原文保留不擦；本报告为其勘误与重执行层。本审唯一 repo 写入=本文件+handoff-coverage.json（round39）；零产品/测试/SDK/authorroot 写入；零安装/锁/git checkout/clone/fetch/worktree/init；**零全局 ps/pgrep/未知 kill**；v1 脚本与旧证据冻结保留不删。

## 0. 遗漏 followup 承认（时间线如实，不以旧未读冒已读）

coor msg_b989eff62cff 于 **11:43:06Z** 送达；本审当时在 sdk5 诊断链中，worker_done 前 11:53 的 check 未处理该消息，**11:54:15Z 结算=漏处理，属本审遗漏**。原 mail 随旧 ctx 结算无法再经 check 收取（本 ctx check count=0），任务正文即完整转达，本审按正文全项处理。R38 报告在漏读该勘误的状态下发出，其中外层 runner/证明口径相关声明以本报告 §1-§3 为准修正。

## 1. R38 错误声明逐项勘误（v1 outer-run.sh 实读对照）

| # | R38 声明 | 实际（coor 实读+本审复认） |
|---|---|---|
| 1 | 「预挂单调截止」 | v1 用 `date +%s` 墙钟秒、1s 粒度轮询——**非单调、非精确 ms**；「覆盖 prelude/ps/tail/cleanup」的生命周期覆盖本身成立（循环至 wait 完成），但时钟口径声称不实 |
| 2 | 「ps 观察 direct child+组员」 | v1 用 **`ps -axo` 全局枚举**——违反本轮起明确的禁全局扫描纪律；组员列表来自全局快照而非 scoped 验证 |
| 3 | 「group_empty」 | v1 的 ps 快照在 `wait` 返回并 **再 sleep 1s 之后**才采、`.ps-snap` 事后删除、PGID==PID 仅由 setsid 假设**无正验证**、birth 空值风险——group_empty 不可作正证明；v1 的 residue 声明全部作废，改以 v2 的 `group_residue_unknown` 口径（见 §3） |
| 4 | 「全部脚本/日志/元数据在 root」 | v1 negpin.sh ①`cp` 直写 **`/tmp/negpin-conn-base.ts`**（root 外遗留件，实测在盘 14354B，披露不删）；②多次 `rm -rf` 复用 fixture/out-A/B/C 与日志——重跑覆盖旧日志、违反唯一追加；③诊断副本 `sdk5-diag.mjs` 定位后**已删**，已删件不可再声称内容/状态 |
| 5 | 「每轮 nonce/PID/PGID/birth/argv 入 provenance」 | v1 provenance 无 startup 正验证（detached 假设）、birth 仅事后快照可得（常空）、无 PGID==PID/PPID==runner 核验字段 |
| 6 | R38 §2 表「residue=group_empty」列 | 全列作废为 **group_residue_unknown**；功能结论（exit/计数）不受影响（见 §4） |

## 2. v2 外层 runner（新文件 runner2.mjs；v1 冻结保留不覆盖）

设计（Node，无裸 python3）：单调 `performance.now()` ms 精度；`spawn detached`=新会话/PGID；启动期有界 **scoped `ps -p PID`**（3s timeout，定向非全局）正验证 **PGID==PID 且 PPID==runner**、记录 birth/完整 argv；直接 `wait`（exit 事件）取目标真实 exit code/signal；截止覆盖 prelude→tail/cleanup 全生命周期；超时操作仅对**先 scoped 复验通过的本次同代组**执行（TERM→3s→复验→KILL；复验不过=unknown 不强杀）；SIGKILL 后仍真实 wait 不冒 gone；**禁止 ps -a/-e/-axo**；退出后组员不可枚举=**group_residue_unknown 如实记录、绝不补扫描凑 group_empty**；外 wall=最终证据写盘后的单调样本（标注 runner_observed 非 OS/Node 实际退出 wall）；target_exit/runner 字段分开；provenance-v2.jsonl 唯一追加、全含 nonce。全部执行一次一个独占组、不与 Pi 并发。

## 3. v2 独立重执行实际结果（fresh root `/tmp/grok-s2-teardown-r39-kVbTLg` 0700；适配件自 r38 审 root 复制，SHA 逐一相符 cb1e2cc5/4529628b/009148ab/5ec9a6a7）

| 运行 | deadline | target_exit（真 wait） | 外 wall（单调 ms，至证据写盘） | 结果 |
|---|---|---|---|---|
| tailgate-r9 | 10s | 0 natural | 159.772ms | 6/6 |
| wholetimer-r9 | 10s | 0 natural | 108.707ms | 6/6 |
| joinfb-r19 | 10s | 0 natural | 160.323ms | 5/5 |
| purefake-r19 | 10s | 0 natural | 159.652ms | 20/20 |
| preflight | 15s | 0 natural | 210.813ms | pass（docker ready） |
| repro | 45s | 0 natural | 1170.82ms | **8/8 SAME**（1110ms） |
| sdk5 | 90s(case15) | 0 natural | 6005.487ms | **5/5 pass**（pass×5、cleanup all-settled、deadlineFired=false、exit-wall wholeWallMsAtFinalize=5900 在案；summary/ledger/events 原件保存于 green3/evidence，非仅 stdout） |
| docker-probe | 30s | 0 natural | 565.972ms | 生命周期 pass（children=10）；**summary.wallMs=1792324707135.03ms 混时钟垃圾按预期再现**——R-Q38-1 required 维持（本 task 不改 probe，Pi 一行同单调修+独立重跑） |
| test:bounded（**并行默认**，非 serial） | 1500s | 0 natural | 129500.46ms | **564/564 pass、0 fail、0 cancelled、0 skipped、0 todo**（计数取自 runner 输出） |
| typecheck | 120s | 0 natural | ~3s | 过 |

provenance-v2.jsonl 每轮含 spawn（argv/cwd/runner pgid）/startup_verify（PGID==PID verified、PPID==runner verified、birth、scoped argv）/exit（target_exit_code、group_residue_unknown+说明）/final（外 wall+kind 标注）。

## 4. 旧结论效力重申（功能绿如实承认+证明边界收缩）

- **功能/行为结论维持**：四 fake 37/37、preflight/repro 8/8、sdk5 5/5、probe 生命周期 pass、bounded 564/564、typecheck 过——R38 的这些实质绿结论经 v2 独立重执行再次成立（两代 runner、两次独立全绿）。
- **证明口径收缩**：v1 的 group_empty/「零未知扫描」/「group 观察」声明作废；bounded/全套件的「有界性」现由 v2 的正验证+scoped 处置承担；「直接子进程真 exit」在 v1 已成立（wait 真实），但「无残留」从未被证明、现在如实记 unknown。内 runner（bounded-test-runner）的 actualExitCode/Signal 消费口径不变。
- R38 402 文件 manifest 复验：401/402 OK，唯一 FAILED=manifest 自引用行（哈希先于末次追加的必然自指）；root 外遗留件 `/tmp/negpin-conn-base.ts`（14354B，在盘）不在该 manifest 内——两处均如实披露，不伪造、不补扫。

## 5. verdict 与 required 维持

- **verdict 维持：approve（有界，仅 S2 SDK teardown 延续切片）**——现由 v2 独立证据重新支撑；S2 维持 partial；G1 全 3s/G3/企业/客户 external 不升级；54m57s 旧 node 生命周期 unknown 不变（本轮零新证、零全局扫描、零未知 kill；新独占组不作旧退出倒证）。
- **R-Q38-1（required）维持**：probe:544 混时钟一行同单调修（t0 为 performance.now）+修后新独立实际跑留真实 wall；本轮 probe 垃圾值按预期再现即其依据。
- **R-Q38-2（required）维持**：作者文档计数/覆盖口径对齐（36vs37、tailgate5vs6、fc23e9d3 陈旧 SHA、probe 坏 wallMs 标注、manifest 20 件子集口径）。
- **R-Q38-3 维持 optional**，不反复当 gate。

## 6. 证据保留

v2 root（0700/UID501，不删）：`/tmp/grok-s2-teardown-r39-kVbTLg`——runner2.mjs、provenance-v2.jsonl（10 轮 spawn/startup_verify/exit/final 全字段）、logs/（nonce 唯一命名 out 日志、追加式）、green3/（适配件+evidence 全套 summaries/ledgers/events/exit-wall 原件）。v1 root `/tmp/grok-s2-teardown-r38-dCQxnm` 及 v1 outer-run.sh/negpin.sh 冻结保留；root 外遗留 `/tmp/negpin-conn-base.ts` 在案不删。repo 写入仅本报告+handoff-coverage.json（round39）；filesModified 单次完整 CSV=两 repo 文件+本 root 产物以 sha256-root-manifest-v2.txt 索引。
