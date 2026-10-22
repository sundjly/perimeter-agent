# Grok S2 SDK session-pin 第六审（round-6，微门终版）：normal 登记处置已证；finalizer 状态机 2 个 actual fail → request_changes（R-Q9a 状态机收尾）

- 结论：**request_changes（同一 R-Q9a 的 finalizer 状态机收尾）**。已证并维持：①登记 callback 改为**真实闭包**（未就绪=真实 `connection.close()`+`disposeUnconfirmed` 失败；就绪后重绑实例 `dispose()`）；②session-pin **删除全部 6 处手动 dispose 绕过**（登记 callback 是唯一清理通道）；③**normal 分支已证**：门1 只调登记 callback→close 恰 1+正向 gone+重复调用不重复 close（本审独立 14/14 含三门，协调者独立复跑 exit 0/63ms 同证）；④builder 误改撤回独立核验（`build.mjs` 实测 `4075300079648e8f`、manifest `0b87934f` 恢复正确）；⑤本轮零越界（r12 无真 Docker/daemon/session-pin/全量/SDK vitest 运行）。**但 finalizer 状态机存在 2 个 actual fail（协调者纯 fake 复现 `/tmp/perimeter-r12/coordinator-finalizer-state.{test.mjs,log}`，runner 15s/PGID 55902、exit 1/102ms，本审亲读）**：**R-Q9a-①** snapshot reject 且 catch 完成 unconfirmed 收尾后，**再次调用登记 callback 竟成功 resolve**（`closedOnce` 早退把未确认收尾变成成功）——重复调用必须保留同一 unconfirmed 失败；**R-Q9a-②** snapshot pending 期间登记 callback 已触发 close+unconfirmed 后，**迟到的 snapshot 仍让 track resolve 出 ready 资源**——close 已启动即须拒绝发布 ready。修法：同一 cleanup 结果/失败缓存不变形（失败恒失败）+ close-started 后拒绝 ready 发布；测试断言 actual callback 而非手动 dispose。微门 approve ≠ 现实资源验证；全仓 serial/default 双绿与真 Docker/daemon ledger 复验留下一验证包。G1 30s 静默窗口/无响应 CANCEL/G3 lost 死亡维持 pending/unknown/blocked；3s 预算门槛、G3、整体 S2/企业不预支；s2-protected-paths 维持 partial，Pod unknown。
- 日期：2026-10-17；审查者：grok（唯一 reviewer；Pi 唯一 coder，task_7612ffb21b61 微门交付）。依据：round-5 唯一 required + 协调者 07:20/08:01 清单。
- 哈希台账（本审实测）：`tests/helpers/daemon-resource.ts` `b20057f008d9ca8c`、`tests/session-pin.test.ts` `fc46e48e38389a85`、`tests/daemon-resource-fault.test.ts` `3e2188e9c525a113`、`ps-observer.ts`/`ps-observer.test.ts`/`docker-owned-ledger.test.ts` 不变（`806b7eb4`/`82e814c6`/`704b89eb`）；**`build.mjs` `4075300079648e8f`（误改已撤回，协调者独立核验一致）**、manifest `0b87934f`；产品 `pi-env-patch.ts` `f7ebe0ce`/`execution-env.ts` `9839b87a` 与安装 SDK dist `d59a1c09` 零改动。
- 允许写入：本文件、coverage。未改实现/tests/SDK/作者报告/handoff/AGENTS；未 commit/push/spawn；零 cargo/npm run build/npm test/install 生命周期/全仓 --write/新依赖；未碰 daemon/context/workload/历史资源；本轮本审未跑真 Docker/daemon/session-pin/全量/SDK vitest（按派单）。

## 1. 已证部分（维持，不重开）

- **R-Q9a normal 分支**：门1 成功路径只调登记 callback→close 恰 1+inspect-gone gone+重复调用不重复 close（本审独立 14/14 含此门；协调者独立复跑 `/tmp/perimeter-r12/coordinator-independent-finalizer.log` exit 0/63ms 同证）。session-pin 6 处手动绕过全删（grep=0），`trackDaemon()` 走同一模块同一路径。
- **R-Q9c'/d' 收紧维持**：waitOwnerGone 无效 generation=unknown/同 birth 漂移=unknown/真实 birth 不同=reuse；classifyInspectGone 整句白名单（status1 恰等 `error: no such object: <fullCID>`；status0+同 CID=live 判失败；其余 unknown）+ fake CLI 负控 5 项——本审 ps-observer 24/24 独立复跑。
- **installer runtime 14/14**（本审独立）；typecheck 0 错误（本审独立）。
- **builder 撤回核验**：Pi 曾误改 build.mjs（emit 失败 try/catch+8/-1 且误写 TS as 语法）→ 按协调者指令精确撤回；本审实测 `4075300079648e8f` 恢复正确（协调者独立核验一致）。fixture-src/ 归属待确认（保留不清）。

## 2. required：R-Q9a finalizer 状态机（协调者纯 fake 复现，本审亲读 raw 确证；非新业务 scope）

- **R-Q9a-①（重复 unconfirmed 伪成功）**：snapshot reject → track catch 经登记闭包完成 close+unconfirmed → **再次调用登记 callback 因 `closedOnce` 早退而成功 resolve**。重复调用必须**保留同一 unconfirmed 失败**（缓存同一 cleanup 结果/失败：失败恒失败，不因已 close 变成功）。
- **R-Q9a-②（pending-close 后假 ready）**：snapshot pending 期间登记 callback 已触发 close+unconfirmed，迟到的 snapshot 仍让 `track` resolve 出 ready 资源。**close 已启动即拒绝发布 ready**（track 返回前检查 close-started 标志，命中即 reject unconfirmed/closed）。
- 修法（协调者指定方向）：finalizer 状态机三态化——`pending-finalizer（close+unconfirmed）`/`ready-dispose`/`settled`，cleanup 结果缓存不变形；测试须断言 actual callback（协调者脚本即模板，纳入回归不得只跑 happy daemon）。
- 既有 raw 保留：`/tmp/perimeter-r12/coordinator-finalizer-state.log`（exit 1）等全部失败历史未抹。

## 3. 文档更正（2 处，作者报告）与执行边界

1. §11.5 哈希表 `build.mjs 38eeeaacdd1a9079（emit 失败详情透传）`为撤回前陈旧值——实测当前为批准原状 `4075300079648e8f`；表值须更正并注明撤回。
2. §11.4 Docker 行「Docker owned ledger（收紧后）1 pass | /tmp/perimeter-r12/docker-ledger.log」——该日志**不存在**，本轮按派单未跑真 Docker（r12 无任何真实容器证据）；该行应删除或标「本轮未跑（下一验证包）」。
- 执行边界：上轮（R5）越界跑真 Docker/daemon 已记录；本轮零越界（本审亦未跑）。下一验证包（另派）口径：全仓 serial（concurrency=1）/default 双绿（raw header）+ 真 Docker/daemon owned ledger 复验 + session-pin 默认并发 ≥5 轮 + R-Q9a 状态机修后协调者脚本回归。

## 4. 边界不变

G1-knownlost ≠ 3s 预算门槛（30s 静默窗口/无响应 CANCEL 仍 blocked）；G3 lost 死亡 pending/unknown，transportExit ≠ daemon kill_all，closeAsync/verifyReap 未实现；整仓历史未逐项记录资源仍 unknown；s2-protected-paths/S2/企业 partial；Pod unknown；bash/硬链接/敏感读/TOCTOU 残余不扩。
证据索引：Pi `/tmp/perimeter-r12/`；grok `/tmp/perimeter-r12-grok/`；协调者复现 `/tmp/perimeter-r12/coordinator-finalizer-state.{test.mjs,log}`、`coordinator-independent-finalizer.log`；历史 `/tmp/perimeter-r7*`～`r11*` 全部保留；报告前各日志尾已实读。
