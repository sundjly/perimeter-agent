# s2-path-guard-bootstrap-blocker.md — G1/G3 SDK 侧边界与最小 API 需求（R5，blocked 项台账）

- 日期：2026-10-16；作者：Pi（task_9e90ba1cc5f4 / ctx_8755499c6785）
- 结论先行：**本仓可修的两处已修并有实测证据（G1 in-repo 部分、G2、G3 措辞/断言）；SDK 侧连接预算与远端死亡确认两点为真实阻碍，明确列 blocked**，不叠 wrapper、不改 SDK、不造 provider。此前 477×2 与 R4 476/477 首败均为历史，本轮新鲜 477×2 全绿（见 s2-path-guard-exec-helper.md §7）。

## 1. G1：连接 bootstrap/reconnect 预算不受守卫预算约束（SDK 侧残留 → blocked）

### 1.1 已核源码事实（node_modules/@earendil-works/pi-env/dist/）

| 位置 | 事实 |
|---|---|
| `connection.js:15` | `START_TIMEOUT_MS = 60_000`（启动回答上限） |
| `connection.js:13` + `Session` 构造（`lastSeen = Date.now()`） | 静默 30s 兜底 → never-respond daemon 实测 30014ms 报 `connection timed out`（R4 原始日志） |
| `connection.js:124-126` `request()` | 无 `options.session` 时一律 `await this.#connect()` |
| `connection.js:139-150` `#connect()` | 无 signal/ctx 参数 |
| `connection.js:182` `#start()` | 无 signal/ctx；spawn daemon 子进程后等 hello |
| `connection.js:262-267` `#teardown` | `stdin.end(); child.kill()`；G1 探针证 teardown 后**无残留子进程** |
| `remote-env.js` exec（`:776` 附近） | 只传 `signal: controller.signal`，**不 pin session**；无 `cwd` 选项时不经 `#resolve/info()` |

推论：daemon 掉线（或从未连上）后，**下一次 `exec` 在 SDK 内部先走无 ctx 的重连/首连**，受 SDK 自身 30/60s 定时器约束，不受守卫 3s 预算约束；期间 guard abort 的 CANCEL 写不进去（abort 监听在 `#send` 才挂上，连接建立前的 abort 无效果），已开始的连接启动会继续到 SDK 定时器收尾。

### 1.2 本轮已闭合的 in-repo 部分（有实测证据）

- metadata（HOME）在 **env 打开时一次性取得**：`openEnvironment` 本就 `await connection.info()`（`src/runtime/execution-env.ts`），现经 `remoteEnvHome` WeakMap 缓存；守卫路径**同步读取，零 info() await**。
- 无打开元数据的 Remote env → 立即 fail-closed（`code=unknown`），不现场连连：in-repo 测试实测 **0.4ms 拒绝**（R4 缺口为 30014ms），且首连失败后无本进程残留子进程（SDK teardown 已杀，G1 探针复核）。
- 取消后无连接子进程尾巴（正常路径）：Docker timeout/abort 测试以精确容器名统计 `pi-env` 客户端进程数 before/after 相等——取消不触发新连接。

### 1.3 残余（blocked，需协调者/SDK 决策）

生产会话 daemon 在打开时已连；guard 正常路径零连接。**仅当 daemon 死亡后**，下一个守卫请求落入 SDK 30~60s 重连预算。无法在本仓闭合，因为：
- `Connection`/`RemoteExecutionEnv` 公开接口没有 per-request connect timeout，也没有 session pin 透传。
- 用 `controller.signal + Promise.race` 只是停止等待，连接仍在后台走完（R4 §4 已认定不采用）；`awaitWithContext` 早返回同理违反本轮要求。

**最小 API 需求（择一，未实施）**：
1. `Connection.request`/`RemoteExecutionEnv.exec` 支持把请求 pin 到已知 live session（`options.session` 已存在于 `request()`，exec 未透传）——daemon 掉线后守卫**立即**以 `connection lost` fail-closed，无重连等待；
2. 或 `ConnectionOptions`/`request` 暴露 connect 预算参数，供守卫传入 guardTimeoutMs。

## 2. G3：远端 deny 返回 ≠ helper 死亡确认（已知边界，非豁免）

- R4 原始日志：`connection.close` 后 exec **0ms** 返回 `unknown`，容器内 helper（pid 32）**46ms 后**才消失——即 settle 时点 helper 仍活动；daemon 硬杀/OOM 可能更久。
- 已纠正（源注释 + 报告）：**「deny 前无活动 helper」仅 Local 成立**（exec 在子进程真实退出后才 settle，测试已证）；Remote 的 exec 在 daemon 结果/错误帧后 settle——组杀已由 daemon 发起，但客户端**不 await 进程死亡确认**，死亡时点记 **pending/unknown**。
- 生命周期兜底（连接关闭/daemon 退出杀全部组/容器销毁）**不是单请求收尾证明**；断连测试已改名并只断言 fail-closed deny，不虚报单请求已结束。
- 真正闭合需要 daemon 在杀组后**确认收割再回帧**（如 `aborted{reaped:true}` ack），属协议/SDK 扩展——列最小 API 需求 ③，未实施。
- unconfirmed 追踪：Docker fixture 以精确 owned 容器名 `create→inspect→cleanup→inspect-gone` 闭环；cleanup 后仍存在即显式报 unconfirmed（不按 label/名称强杀、不忽略、不虚报 clean）。

## 3. 本轮交付边界声明

- 两个独立小缺陷（G2 字节契约、G2/kill oracle）已修 + 实测；G1 in-repo 部分已闭合；G1 SDK 重连预算与 G3 死亡确认 = **blocked**（有精确行号与最小 API 需求），不用未知状态冒充安全成功，不为全绿强推未经确认的 session/SDK 改造。
- s2-protected-paths / S2 / 企业放行维持 partial；既有已证能力（真实 kill、Node/Docker 后续健康、四眼、白名单）不回退。
