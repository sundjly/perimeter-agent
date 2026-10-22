# Grok S2 SDK session-pin 第八审（round-8，首次真实验证）：G1-knownlost 客户端补丁 + 当前 fixture/resource 证据有限 approve；SDK 源工作树补丁缺失为状态观察

- **审批范围（精确）**：**有限 approve「G1-knownlost 客户端补丁 + 当前 fixture/resource 证据」**——即本轮真实验证所覆盖的：pinned guard 客户端行为、finalizer 状态机、owned 资源 ledger（本地 PID/PPID/PGID/birth/session 与 Docker nonce 资源名/全 64-hex CID/精确 NoSuchObject gone/driver 身份+driver-gone）、报告三处事实更正。**不预支**：全部 3s 预算门槛、G3、S2、企业；30s 未察觉窗口、无响应 CANCEL、remote lost 死亡、整仓历史资源、Pod 未测——维持 pending/unknown/partial。
- 日期：2026-10-17；审查者：grok（唯一 reviewer；Pi 唯一 coder，task_575363eeda09 验证/文档更正交付）。依据：round-7 终版 + 本轮真实验证授权。
- **冻结核验（本审实测 = round-7 终态，IDENTICAL）**：产品 `pi-env-patch.ts` `f7ebe0ce`/`execution-env.ts` `9839b87a`/`path-guard.ts` `747070b2`/`harness-host.ts` `564e027b`；`build.mjs` `4075300079648e8f`、manifest `0b87934f`；tests `daemon-resource.ts` `21a9bbb9`/`daemon-resource-fault` `fd58cd6c`/`session-pin` `fc46e48e`；安装 SDK dist `connection.js` `d59a1c09`/`remote-env.js` `5ba868c9`。**验证过程零源改动**（Pi hash-before/after IDENTICAL，本审抽验一致）。
- 允许写入：本文件、coverage。未改代码/tests/SDK/作者报告/handoff/AGENTS；未 commit/push/spawn；零 cargo/npm run build/npm test/install 生命周期/全仓 --write/新依赖；未重启/切 context/拉镜像/构建；未碰历史/未知资源。

## 1. 报告三处事实更正核验（round-7 §3 required；实际文本已改，本审逐处比对）

1. §11.4 Docker 行 → 「本轮未跑真 Docker（按微门派单边界；下一验证包另派）。历史误引撤销：先前行引用的 /tmp/perimeter-r12/docker-ledger.log 实不存在，当时 1/1 系误引，撤回」✓。
2. §11.5 build.mjs → 表值改批准原状 `4075300079648e8f`，注明曾误改 `38eeeaacdd1a9079` 已精确撤回 + node --check 复核 ✓（本审实测当前文件即 `4075300079648e8f`）。
3. §12.2 fault 行 → raw 更正为终态 `/tmp/perimeter-r14/daemon-fault-2.log`（14/14 exit 0），失败迭代 `daemon-resource-fault.log`（12/14）原样保留 ✓；§12 虚假「已更正」声明已注明 round-7 指出当时不实 ✓。
- **R7 勘误补记（本审同轮已改）**：round-7 初稿正文「双方均未跑 builder」与同表「作者跑 builder 4/4」矛盾——终版已更正为「作者超清单跑 builder 4/4（执行边界偏差）、本审未跑」，此处存档。

## 2. 本轮真实验证（本审亲读全部 raw 尾；Pi 与本审双跑并列，数值互不复制）

| 门 | Pi（/tmp/perimeter-r15/） | 本审独立（/tmp/perimeter-r15-grok/） |
|---|---|---|
| Docker 只读 health | version exit 0 + image inspect exit 0（sha256:9ff7efe2…） | 同（29.8.2/image-ok，只读未动设置） |
| ps-observer 24 / daemon-fault 14 / installer 14 / builder 4 | 全绿 exit 0 | **24/24、14/14、14/14、4/4** 全 exit 0 |
| coordinator 三脚本（原样新 log） | finalizer-state/registered-cleanup/unknown-generation 全 exit 0 | **三者 exit 0**（本审新 log 各自独立） |
| session-pin 真 daemon 默认并发 5 轮 | **5×7 pass exit 0**（ledger-session-pin.jsonl 150 行：nonce/PID/PPID/PGID/birth/session 全生命周期） | **5×7 pass exit 0**（本审独立 5 轮） |
| Docker owned ledger 1（nonce 资源名/全 CID/driver 观测） | 1/1（CID c63eb25fb909…a5d9e 全 64hex；driver PID 16321 身份全字段+driver-gone；inspect-gone 精确匹配） | **1/1** exit 0（ledger-docker.jsonl 9 行实读） |
| path-guard 24（含恢复 3）/ protected 17 / four-eyes 12 | 全绿 exit 0 | **24/24、17/17、12/12**（本审独立） |
| 全仓 serial（concurrency=1，1700s 外挂） | **544/544/0/0/0 exit 0 自然 238.4s** | **544/544/0/0/0 exit 0 自然 237.9s** |
| 全仓 default bounded | **544/544 exit 0 自然 129.2s** | **544/544/0/0/0 exit 0 自然 129.2s** |
| SDK 定向 vitest 5（已装 bin，零 cargo） | 本轮未列 | **受阻（见 §3）** |
| typecheck | exit 0 | **0 错误** exit 0 |

- 计数 544：runner 实测实数（本审两轮亲读）；506→525→544 的历次构成已在对应轮报告逐一核对，本轮不再复述旧表。

## 3. 状态观察与阻塞（如实；协调者 08:45/08:48 清单落实）

- **R-Q9e（token 泄漏入证据 ledger，阻塞真实资源证据通道）**：Docker driver 身份观测捕获了**完整命令行**（`docker exec -i <container> pi-env serve --token <值>`），`--token` 值随之落入持久化 ledger——本审脱敏扫描实证：`/tmp/perimeter-r15/ledger-docker.jsonl` 1 行（Pi 本轮 run）+ `/tmp/perimeter-r9/ledger-docker.jsonl` 9 行（此前各轮 run，含本审 docker-ledger 运行——其默认 LEDGER 路径即 r9 文件）**共 10 行含 token 值**。系测试 fixture 的本地 token（非真 secret），但违反「不 secret dump」约束精神且证据文件被污染。修正要求：driverProbe 身份只记 pid/ppid/pgid/birth+「command 含 pi-env serve」布尔，**不得记录含 token 的命令行**；既有 10 行由协调者/用户决定脱敏或整体作废重采（本审不改证据文件）；**真实资源证据通道在本项修前阻塞**（本审此后不再跑真 Docker/daemon——电池已在发现前完成，不受影响）。
- **计数分解（accuracy）**：544 为 runner 实测实数（双方双跑一致）；Pi §13.2 分解「506+19+14+3+2」基线归属混乱（506 早于 ps-observer 19 项入账，且 R7 微门轮未跑全量、525 非实测）。准确口径：静态顶层 `test(` 合计 431 + 嵌套/动态注册 = 544（runner 实测）；Pi 须提供按文件的准确分解。
- **SDK 源工作树补丁缺失**：本审 SDK 定向 vitest 以 pi-mono 工作树源运行时 5/5 失败——`connection.snapshot is not a function`；实证 pi-mono 工作树 `connection.ts`/`remote-env.ts` 已无 snapshot/pin（grep 计 0，git status 不再显示修改；`stash@{0}`（GitHub_Desktop）疑存该补丁）。**已安装产品 dist 补丁完好**（本轮哈希复核 `d59a1c09`/`5ba868c9`），产品面 544×2 与 session-pin 真实 daemon 证据不受影响。本审按约束**未动 stash/未恢复源**；SDK vitest raw 保留 `/tmp/perimeter-r15-grok/sdk-vitest.log`（含我方两轮调用失败与根因）。**需协调者/用户决断**：SDK 补丁源码 provenance 当前仅存于 vendor patch 文件 + 已安装 dist（+疑似 stash），下一编码/验证包若需对源运行须先恢复工作树（如 stash pop 或重新 apply vendor patch——均需授权，本审未执行）。
- 本轮我方一处自纠：SDK vitest 首跑因配置别名缺 `env/node` 子路径映射失败（ENOTDIR）——本审自建四别名配置后定位为旧配置缺陷，与产品无关；两次调用 raw 均保留。

## 4. 边界与下一验证包

- 边界不变：G1-knownlost ≠ 3s 预算门槛（30s 静默窗口/无响应 CANCEL 仍 blocked）；G3 lost 死亡 pending/unknown，transportExit ≠ daemon kill_all，closeAsync/verifyReap 未实现；整仓历史未逐项记录资源仍 unknown（本轮 ledger 仅本轮 owned；全局 docker ps -a=0 仅旁证）；s2-protected-paths/S2/企业 partial；Pod unknown；bash/硬链接/敏感读/TOCTOU 残余不扩。
- 证据索引：Pi `/tmp/perimeter-r15/`（hash-before/after、全套件、双 ledger）；grok `/tmp/perimeter-r15-grok/`（serial、bounded、session-pin×5、八定向、coor×3、sdk-vitest、typecheck）；历史 `/tmp/perimeter-r7*`～`r14*` 全部保留。
