# Grok S2 SDK session-pin 第三审（round-3，终版）：R-Q1/R-Q2/R-Q3/R-Q4/R-Q7 approve；R-Q5/R-Q6/R-Q8 主体落地但资源身份与失败分支残余未闭 → request_changes（收尾修订包）

- 结论：**R-Q1（时序竞态）、R-Q2（证据更正）、R-Q3（runtime 强制 patched）、R-Q4（runtime 负控）、R-Q7（builder 预校验+所有权）approve（逐项独立复证）**；**R-Q5/R-Q6/R-Q8 主体落地但存在资源身份与失败分支残余（协调者 06:00 清单四点，本审逐条实证成立）→ request_changes（收尾修订包，不按作者全闭口径放行）**。SDK 语义 diff 未触及不重开。全量 **506×2 双绿**（本审独立 serial 238.7s/bounded 129.3s，exit 0 自然）+ patch-install 14/14、build-negative 4/4、docker-owned-ledger 1/1、session-pin 7/7、path-guard 24/24、SDK vitest 5/5、静态 0 错。G1 30s 静默窗口/无响应 CANCEL、G3 lost 远端终止维持 pending/unknown/blocked；3s 预算门槛、G3、整体 S2/企业不预支；s2-protected-paths 维持 partial，Pod unknown。
- 日期：2026-10-17；审查者：grok（唯一 reviewer；Pi 唯一 coder，task_7d44fb416f11 修复交付）。依据：round-2 R-Q1～R-Q8 + 协调者 06:00:12Z 追加清单（逐条本审实证）。
- 哈希台账（本审实测全符报告 §8）：`pi-env-patch.ts` `f7ebe0cedbfb24a8`、`execution-env.ts` `9839b87af6c965ea`、`path-guard.ts` `747070b26d9b19a4`（不变）、`scripts/pi-env-patch.ts` `fcd4f96406f1637a`（不变）、`tests/session-pin.test.ts` `b53fa17abd9cb0ff`、`tests/pi-env-patch-install.test.ts` `4ee654a383b61ec5`、`tests/pi-env-build-negative.test.ts` `7e69139eb984479f`、`tests/docker-owned-ledger.test.ts` `40bf753f3cf4c761`、`build.mjs` `4075300079648e8f`、manifest `0b87934f4c868fde`。
- 允许写入：本文件、coverage。未改源/tests/SDK/作者报告/handoff/AGENTS；未 commit/push/spawn；零 cargo/npm run build/npm test/install 生命周期/全仓 --write；未碰 daemon/context/workload/历史资源。

## 1. approve 部分（R-Q1/R-Q2/R-Q3/R-Q4/R-Q7；逐项独立复证）

- **R-Q1**：新用例「kill→身份复核→SIGKILL→本地退出→**teardown barrier**（旧 pinned 只读探针 ≤3 次即时，lost=barrier 达成，非 lost 真实失败）→ unpinned exec 发起唯一新 daemon（lost 类有界重试 ≤3）→ 新 snapshot 命中既有 `#ready` 新 pin 恢复」；作者 run1..5 七项 7/7×5 + 本审独立 7/7。
- **R-Q2**：§8.2 如实更正（fresh=失败迭代、fresh2=6/7；计数更正 498=486+1+11）。
- **R-Q3**：`verifyPiEnvPatchInstalled` 显式 `kind!=="patched"` 即 throw（original/混合/unknown 一律拒）；CLI verify 允许 original 的双语义有对照测试（R-Q3 用例）。
- **R-Q4**：能力门抽为 `assertSnapshotCapability`/`assertPinnedSessionGetter` 纯同步零 spawn 函数；3 项 runtime 负控（original 拒；旧 SDK 无 snapshot 拒且**受控对象方法零调用**；缺/错 getter 拒）——本审独立 14/14。
- **R-Q7**：步骤 0 预校验（工作树源/HEAD 基线/patch 文件 hash 均须与既有 manifest 一致，先于任何 emit/写入）；`--out-dir` mkdtemp 新 owned 或拒已存在；workTmp mkdtemp；**rmSync 已移除**；build-negative 4/4（本审独立）+ build.log 幂等 hash 复现。

## 2. 残余 required（协调者 06:00 清单四点，本审逐条实证成立；不降建议）

- **R-Q9a（track/finally 失败分支泄漏）**：`DaemonResource.track` 先 `await snapshot` 后构造登记——snapshot/构造期 ps 观察抛错即无任何登记，活 transport 泄漏；全局 `after` 为顺序 for-await，**首个 cleanup throw 跳过其余全部**；R-Q1 用例重连产生的新 daemon（calls 2）**无新 track/nonce/birth**，dispose 只关当前 Connection 并等旧 pid——新代消失未证；`openEnvironment` 首查/断言失败仅同步 close 无 await 观察。修正：track 前置登记（先登记后冒险）、after 全量 settled 逐项报告、重连代建立新 track/ledger、openEnvironment 失败路径 await 观察或如实 unknown。
- **R-Q9b（kill 前身份校验不实）**：`inspectIdentity` 记录 `id.birth/id.pgid/id.command` 但**未与构造期观测比对**（只比 `id.ppid===process.pid` 与「测试进程当前 pgid===登记 pgid」——后者证明测试进程未换组，不证明 daemon 当前 pgid 仍一致）；kill 前必须比对 id.birth/id.pgid/id.command-marker 与出生记录，不符即 unknown 拒杀。
- **R-Q9c（psIdentity gone 语义过宽）**：`status!==0 && stdout 空 && stderr 空` → 一律 gone（不限 exit 1；signal/null/exit 2 空输出也判 gone）；`waitGone` 复用判定仅匹配共同 daemon 路径 marker，无 nonce/birth 比对。修正：gone 仅限「exit 1 + 双空输出」；其余一律 unknown 并使测试失败；复用判定须带 birth/nonce 身份；补 observer 负控（模拟 signal/exit2/换 marker）。
- **R-Q9d（Docker ledger 用例失败分支与 gone 判定）**：`backend.environment` await 在 try 外（失败即无 ledger/无清理尝试）；`rmSync(ws)` 在 finally 之后（断言失败即漏删临时目录）；inspect-gone 以**名**而非已确认完整 CID 判定（同名容器可假通过）；gone 判定「任意非 0/timeout/null 都算 gone」与 R-Q9c 同病；ledger CID 仅 12 hex 截断。修正（按 docker CLI 语义，**撤回本审初稿误写**）：**gone 的判定 = 对同一完整 owned CID 向 daemon 取得明确 No such object/container 且目标 ID 匹配（通常 exit 1，stderr 精确白名单，如 `No such object: <cid>`）；`docker inspect` exit 0 且 Id 匹配恰证容器仍在（live，判失败）**；timeout/null/status 2/连接失败一律 unknown——不得以泛 non-zero 当 gone。

（以上为旧 R-Q5/R-Q6/R-Q8 的未闭残余，非扩 scope：R-Q5 未知/Z 语义主体、R-Q6 登记模式主体、R-Q8 ledger 双份与 Docker 真实控制主体均已落地并有本审独立复证。）

## 3. 运行证据（真实 argv/PGID/deadline/counts/exit/墙钟；历史 raw 未抹）

| 运行 | Pi（/tmp/perimeter-r9/） | 本审独立（/tmp/perimeter-r9-grok/） |
|---|---|---|
| 全量 serial（concurrency=1） | **506/506/0/0/0 exit 0 自然 238.6s（runner 238574ms）** | **506/506/0/0/0 exit 0 自然 238.7s** |
| 全量 bounded（默认并发） | **506/506 exit 0 自然 129.3s（runner 129341ms）** | **506/506/0/0/0 exit 0 自然 129.3s** |
| patch-install 14（含 R-Q3/Q4 负控） | 迭代 13/14→终 **14/14** | **14/14** exit 0 |
| build-negative 4 | 4/4 | **4/4** exit 0 |
| docker-owned-ledger 1（真实 CID 生命周期） | 1/1（ledger 4 次容器闭环：42579f00d36f/30283c3949ce/a58b43303a83/c4c1fa36f6e1） | **1/1** exit 0（自有 nonce 追加 ledger） |
| session-pin 7（默认并发） | **连续 5 轮 7/7**（run1..5） | **7/7** exit 0 |
| path-guard 24 / pp 17 / four-eyes 12 | 全绿 | **24/24**（pp/four-eyes 含于 serial） |
| SDK 定向 vitest（已装 1.1 darwin-arm64 bin，零 cargo） | 5/5（625ms） | **5/5**（814ms） |
| 静态 | exit 0 | **0 错误** exit 0（3.0s） |

- 计数：506 = 498 + 3（patch-install runtime 负控）+ 4（build-negative）+ 1（docker-owned-ledger）——本审按文件逐一 count 复核；报告 §8.2「+8」漏列 docker-ledger +1（总数正确，措辞小疵）。
- 498×2 与本轮 506×2 raw tails 均已实读；历史 raw（R7 bounded① 485/486、② 486；R8 fresh/fresh2 失败）保留未抹。

## 3b. 勘误记录（本审初稿两处，2026-10-17 修订；协调者发现后经本审亲读原始日志与 docker CLI 语义确证）

1. **R-Q9d 修正句逻辑反了（已撤回重写）**：初稿写「gone 按完整 CID inspect 且仅 exit 0+Id 匹配为已删」——`docker inspect` exit 0 且 Id 匹配恰证容器**仍存在**（live，应判失败）；正确语义以 §2 R-Q9d 修订句为准：gone 须对同一完整 owned CID 向 daemon 取得明确 `No such object/container` 且目标 ID 匹配（通常 exit 1 + stderr 精确白名单，如 `No such object: <cid>`）；timeout/null/status 2/连接失败=unknown，泛 non-zero ≠ gone。此为文档表述勘误，Pi 实现须按修订句而非初稿句。
2. **§3 Pi 墙钟误值（已更正）**：初稿 Pi 列 serial 244.9s/bounded 130.9s 系 R8 轮数值误复制；本审亲读 `/tmp/perimeter-r9/serial-full.log`（inner 238531.709375ms、runner 238574ms、exit 0 自然）与 `/tmp/perimeter-r9/bounded-full.log`（inner 129301.423584ms、runner 129341ms、exit 0 自然）后更正为 238.6s/129.3s。

## 4. 放行与边界

- 收尾修订包范围 = R-Q9a～R-Q9d（测试/fixture 层为主，SDK 语义与 installer 核心不再触及）；修后验收：R-Q9c observer 负控 + R-Q9a 全量 settled 清理实证 + session-pin 默认并发 ≥5 轮全绿 + serial/bounded 双绿（raw header）+ R-Q9d ledger 含全 CID 生命周期。
- 边界不变：G1-knownlost ≠ 3s 预算门槛（30s 静默窗口/无响应 CANCEL 仍 blocked）；G3 lost 死亡 pending/unknown，transportExit ≠ daemon kill_all，closeAsync/verifyReap 未实现；整仓历史未逐项记录资源仍 unknown（本轮 ledger 仅覆盖本轮 owned 对象）；s2-protected-paths/S2/企业 partial；Pod unknown；bash/硬链接/敏感读/TOCTOU 残余不扩。
- 证据索引：Pi `/tmp/perimeter-r9/`；grok `/tmp/perimeter-r9-grok/`；历史 `/tmp/perimeter-r7*`、`/tmp/perimeter-r8*`；报告前各日志尾已实读。
