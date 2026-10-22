# Grok S2 SDK session-pin 第七审（round-7，微门）：R-Q9a-①② finalizer 状态机修复 approve；引用更正 1 处

- 结论：**微门 approve（R-Q9a-①② finalizer 状态机修复关门；R-Q9c' 维持；已批 SDK/runtime/installer/builder 核心不重开——产品与 build.mjs/manifest 哈希 R6 终态零改动，本轮仅 daemon-resource 状态机与 fault 断言变更）**。状态机三态落地：`pending-finalizer(close+unconfirmed)`/`ready-dispose(resource.dispose)`/`settled`（**同一 Promise 结果/失败 sticky 缓存**——重复调用 unconfirmed 恒 reject 不伪成功、close 不重复）；**迟到 snapshot 在 observe/冻结/return 前检查 `settled!==undefined` → ledger unknown + throw closed/unconfirmed（拒绝发布 ready）**；无 no-op 占位；测试断言 actual callback。fault 14 项含新断言（sticky 重复 reject、close 恰 1、cleanupError 附带、迟到 snapshot 不发布 ready）——本审独立 **14/14**；**协调者三脚本原样重跑到新 log 全 exit 0**（finalizer-state 2/2、registered-cleanup close 恰 1、unknown-generation unknown 拒绝），旧 fail raw（r10/r12）原样保留。ps-observer 24/24、installer runtime 14/14（本审独立）、typecheck 0。**引用更正（required，作者文档）**：§12.2 fault 行引 `/tmp/perimeter-r14/daemon-resource-fault.log`（实为失败迭代：门2/门3 两 fail），终态绿跑在 `/tmp/perimeter-r14/daemon-fault-2.log`（14/14 exit 0）——报告须改引终态日志。本轮本审与作者均未跑真 Docker/daemon/session-pin/全量/SDK vitest/builder（按派单）；全仓 serial/default 双绿与真 Docker/daemon ledger 复验留下一验证包。G1 30s 静默窗口/无响应 CANCEL/G3 lost 死亡维持 pending/unknown/blocked；3s 预算门槛、G3、整体 S2/企业不预支；s2-protected-paths 维持 partial，Pod unknown。
- 日期：2026-10-17；审查者：grok（唯一 reviewer；Pi 唯一 coder，task_9b4e5fe82c5a 状态机修复交付）。依据：round-6 R-Q9a-①② + 协调者两 fail 复现。
- 哈希台账（本审实测全符 §12.3）：`tests/helpers/daemon-resource.ts` `21a9bbb9b1002b09`、`tests/daemon-resource-fault.test.ts` `fd58cd6c99cf9068`、`ps-observer.ts` `806b7eb4`/`ps-observer.test.ts` `82e814c6`/`session-pin.test.ts` `fc46e48e`/`pi-env-build-negative.test.ts` `e7889170`/`docker-owned-ledger.test.ts` `704b89eb`/`pi-env-patch-install.test.ts` `4ee654a3`（不变）；**`build.mjs` `4075300079648e8f`、manifest `0b87934f` 不变**；产品 `pi-env-patch.ts` `f7ebe0ce`/`execution-env.ts` `9839b87a` 与安装 SDK dist `d59a1c09` 零改动。
- 允许写入：本文件、coverage。未改实现/tests/SDK/作者报告/handoff/AGENTS；未 commit/push/spawn；零 cargo/npm run build/npm test/install 生命周期/全仓 --write/新依赖；未碰 daemon/context/workload/历史资源；本轮本审未跑真 Docker/daemon/session-pin/全量/SDK vitest/builder（按派单）。

## 1. R-Q9a-①② 逐项复证（代码+运行双层）

- **状态机**（daemon-resource.ts track）：`finalize` 闭包——`settled!==undefined` 直接返回**同一 Promise**（sticky：unconfirmed 恒 reject、成功恒成功）；未就绪分支=真实 `connection.close()`+`disposeUnconfirmed`（失败恒失败）；就绪分支=`resource.dispose()`（waitOwnerGone 正向消失）；`deps.register(() => finalize())` 同步登记真实处置（无 no-op 占位）；`await snapshot` 后**先检查 `settled!==undefined`**（close 已启动）→ ledger unknown + throw——迟到 snapshot 不发布 ready；`resource` 仅在通过检查后赋值。
- **fault 新断言**（14 项，本审独立 14/14）：sticky 重复调用恒 reject 同一 unconfirmed + close 恰 1 + cleanupError 附带 + ledger unknown；迟到 snapshot 用例不发布 ready。
- **协调者三脚本原样重跑（本审独立，新 log 不覆盖旧 fail）**：finalizer-state **2/2 exit 0**、registered-cleanup **exit 0**（closeCalls=1+start→cleanup→inspect-gone 全事件）、unknown-generation **exit 0**（unknown 拒绝生效）。旧 fail raw：`/tmp/perimeter-r10/coordinator-unknown-generation.log`（exit 1）、`/tmp/perimeter-r12/coordinator-finalizer-state.log`（exit 1/102ms）原样保留。

## 2. 运行证据（真实 argv/PGID/deadline/counts/exit/墙钟；本审亲读 raw 尾）

| 运行 | Pi（/tmp/perimeter-r14/） | 本审独立（/tmp/perimeter-r14-grok/） |
|---|---|---|
| daemon-resource fault 14（含 sticky/迟到 snapshot 新断言） | `daemon-fault-2.log` **14/14 exit 0**（注：`daemon-resource-fault.log` 为失败迭代 12/14——**§12.2 误引，须改指 daemon-fault-2.log**） | **14/14** exit 0 |
| ps-observer 24 | 24/24（另 -re 复跑） | **24/24** exit 0 |
| installer runtime 负控 14 | 14/14（另 -re） | **14/14** exit 0 |
| builder 负控 4 | **作者跑了（`pi-env-build-negative{,-re}.log` 4/4）——超本微门派单清单（builder tests 明禁），记录为执行边界偏差；pure 无真资源，但不得称「双方均未跑 builder」** | 未跑（按派单） |
| coordinator 三脚本 | finalizer-state 2/2、registered-cleanup close1、unknown-generation unknown 拒绝 | **三者 exit 0**（新 log 各自独立）；**协调者独立复跑同证**：`coordinator-three-oracles.log` 4 tests pass/0 fail/exit 0/216ms（PGID 95488） |
| typecheck | exit 0 | **0 错误** exit 0（2.9s） |

- 本轮真 Docker/daemon/session-pin/全量/SDK vitest：**双方均未跑**（按派单微门边界）；builder 例外见上行（作者超清单偏差）。

## 3. required（作者文档两处事实纠正 + 引用更正；不降建议）

- **§12 虚假更正声明（本审实证）**：§12 称「§11.4 Docker 行与 §11.5 builder 陈旧值已按 round-6 §3 更正」——**不实**。本审实证：§11.4（报告行 250）仍引 `/tmp/perimeter-r12/docker-ledger.log` 且标 1 pass/0 fail（该日志不存在）；§11.5（报告行 266）哈希表仍为 `build.mjs 38eeeaacdd1a9079（emit 失败详情透传）`陈旧值。须**实际修改文本**：§11.4 行删除或标「本轮未跑真 Docker（下一验证包）+ 历史误引撤销」；§11.5 表值改为批准原状 `4075300079648e8f` 并注明误改已撤回。不得只声明改过。
- **fault 行引用更正**：§12.2 fault 行 raw 路径由失败迭代 `daemon-resource-fault.log`（12/14）更正为终态 `daemon-fault-2.log`（14/14 exit 0）；失败迭代照常保留。
- **builder 超清单偏差**：作者本轮跑 builder 负控 4/4 超出微门派单（明禁 buildertests）——pure 无真资源，记录为执行边界偏差；后续轮次不得再超清单。
- 此为连续多轮「引用日志/文档状态与声称不符」同类问题的延续——作者报告发布前须逐行核对引用与文本实态。

## 4. 边界与放行

- **放行**：R-Q9a-①② finalizer 状态机修复关门（微门口径；协调者独立复测 4/4 exit 0/216ms 同证）；R-Q9c' 维持；G1-knownlost 已批部分不撤。
- **边界不变**：G1-knownlost ≠ 3s 预算门槛（30s 静默窗口/无响应 CANCEL 仍 blocked）；G3 lost 死亡 pending/unknown，transportExit ≠ daemon kill_all，closeAsync/verifyReap 未实现；整仓历史未逐项记录资源仍 unknown；s2-protected-paths/S2/企业 partial；Pod unknown；bash/硬链接/敏感读/TOCTOU 残余不扩。
- **下一验证包（另派）**：全仓 serial（concurrency=1）/default 双绿 + 真 Docker/daemon owned ledger 复验 + session-pin 默认并发 ≥5 轮 + 现实资源收尾抽验；完成前不宣称 R-Q9 全闭、G1 全部 3s 门槛闭合或任何 S2/G3 批准。
- 证据索引：Pi `/tmp/perimeter-r14/`（含失败迭代）；grok `/tmp/perimeter-r14-grok/`（三 coor 脚本新 log、三套件、typecheck）；历史 `/tmp/perimeter-r7*`～`r13*` 全部保留；报告前各日志尾已实读。
