# R75 复审：R74「运行中 share 后审批 push 必然 403」修复（round-13）

- 日期：2026-10-21。只读复审，未运行任何测试/进程。
- 审查对象：`/tmp/perimeter-exec-r67-J3jFOwfP/r74-code.diff`（相对 HEAD，6 文件：scripts/demo.ts、src/gateway/server.ts、src/gitproxy/server.ts、tests/demo-e2e、tests/gitproxy、tests/wiring），并对照工作树源码逐行核验。
- TAP 证据核验：run21 共 8 份，计数与报告一致——demo-e2e 2/0、gitproxy 31/0、wiring 12/0、gateway 25/0、git-e2e 10/0、git-grants-integration 4/0、redteam-e2e 4/0、web-injection 6/0（ok/not-ok）；64 unit 见 unit-run21/r65-driver（64 ok / 0 fail）。typecheck 0 为 coordinator 口述，复审未独立验证。

## 结论：request_changes

方案 (a) 主链路实现正确（撤旧先于重签、事务回滚、share 鉴权门），代理重拉的单飞/限流/验签顺序正确；但存在 1 个新引入的 fail-closed 缺口、1 个合同 C2 达标问题、1 个 demo 人工入口断链，均需修。

## 逐项核验

### ① 重签时序与 fail-closed —— 通过（无公开 API 绕过）
- 时序：`onAclChanged` 先 `#revokeGitGrantSession`（内存撤 + fallible save，先于重签）→ 会话存活/owner 未吊销/`#isAuthorized` 三道闸 → `#remintGitGrant`。回调用异常由 `Session.setAclVersion` 固定类别审计接住（session.ts:140-146）。
- 回滚语义（grant-rotation.ts 实读）：R74 流中旧 jti 在前置撤销步已全部入 revoked，故 `planRotation.newlyRevoked=[]`，`rollbackRotation` 还原为空集——**旧不复活恰由「撤销先于重签」保证**；失败路径 `retireUndeliveredNew` 使新 jti 不可用、fresh entry 删除不留半登记、`currentExpAt` 恢复；代理消费的是网关内存快照，磁盘 save#3 失败的「磁盘 unknown」已被诚实审计。
- 绕过面：share 命令要求发送连接过 per-command `isAuthorized` 门 + `roleOf==owner` + 防自批（actor≠owner≠被分享人，server.ts:1933-1936）；`#remintGitGrant` cap 沿用 prior `maxExpAt`，重签不越过原身份有效期；owner 吊销/无权分支只撤不签，`#isAuthorized` demo 恒真但 demo 本无真实身份面（构造期强制无 auth，server.ts:300）。未发现绕过路径。
- 残留（无害，记录）：失败回滚后 existing entry 的 `aclVersion` 残留新值、`maxExpAt` cap 更新不回滚——均朝 fail-closed 方向。

### ② 代理等待重拉 —— 单飞/限流/验签顺序通过，但重拉后判定不完整（R1）
- 未验签请求不可触发：`verifyGrant`（HMAC）+ repo 全等先于 miss/aclVersion 两条触发路径（gitproxy/server.ts:453-461）。已确认。
- 频率：`#refreshSnapshotOnce` 单飞 + `notBefore=+1s`（含失败后退避）；并发等待者全局收敛为 ≤1 次拉取/秒；单请求至多一次自身重拉 + ≤1.2s 等待。registry 负载有界，成立。
- 等待者资源：无并发等待者上限，每个持有效 grant 的请求可挂住 socket ≤1.2s——需持有有效签名 grant 才可达，属常态 slowloris 面，可接受（记录）。
- **R1（required）：重拉后仅重查 session/aclVersion，未按新快照重走 epoch/jti/revokedJtis，且等待路径结束后不复查 `#snapshotFresh`。** 后果：(a) miss 路径在等待后若重拉失败/超时，可依据已超 maxAuthAge 的旧快照放行（production 下最多超 1.2s）；(b) 重拉成功拿到的新快照中 claims.jti 已入 revokedJtis 时仍放行（冷启动 miss + 窗口内 renew 轮换的组合，≤1.2s 缝）。代码注释自称「重拉后按新快照重走 session 判定」，实际只走了一半。修复：重拉后回到 A6 块头重验全部字段 + 复查新鲜度（失败则 fail-closed）。

### ③ dev 轮询 ≈29s 与合同 C2 ≤5s —— 确认违反，且 demo 的 pollMs 是死配置（R2）
- 实读 `#startPolling`：`pollEvery = max(250, maxAuthAge - 1s)`，production=4s（age 上限 5s）✓ C2；**dev maxAuthAge=30s → 轮询 ≈29s**。构造期校验的 `registry.pollMs` 在循环中完全不被消费（仅 61/184-187 行出现）。
- 因此：demo.ts（dev 模式）新增的 `pollMs: 5_000` 是**校验通过但无效的配置**，给人 5s 吊销窗口的假象；gitproxy 头注释「吊销在 ≤pollMs（默认 5s…）」失实（pollMs 为必填、无默认，且不控节奏）。demo-e2e share 例能通过，是因为新 grant 的 aclVersion 高于快照触发了请求侧重拉，与快照轮询节奏无关。
- C2 合同文本无模式限定（「代理 ≤5s 窗口内全拒」，scope 含 aclVersion 变更与销毁/登出/revokePrincipal）。在 dev 下，stale 快照期间旧 grant 与快照同 version 且 jti 不在旧吊销表 → 可继续用至 ≈29s：**按合同字面，dev/demo 不达标；production 达标**。wiring 测试 8s 等待窗口（注释自认「不枙 5s 死限」）是按 production 4s 轮询口径写的。
- 处置三选一（需 coordinator/用户定）：(a) 合同/措辞显式把 C2 限定 production、dev 标注低保障；(b) dev maxAuthAge 收紧 ≤5s；(c) 让 pollMs 真实生效并让 demo 显式受益。无论选哪个，demo.ts 的死 pollMs 与头注释失实必须修正。

### ④ 测试真实性 —— 通过，无放宽断言；两处覆盖缺口（记录）
- gitproxy R74 例：真实经 production 模式代理 + 注入 registryFetch，断言 200/403 迁移、高/低 version 方向、拉取计数上限——真 oracle。`elapsedC>=500` 弱于真实 ~1s 窗口，但与计数断言配对，可接受。
- wiring R74 例：production 代理 + 预留端口（正确避开 production 禁回填）、真实 git 上游、share→旧 grant 403/新 grant 200/registry aclVersion=2/revokedJtis>0——真链路。旧 grant 403 的 8s 上界是等待窗不是断言放宽（见 ③）。
- demo-e2e share 例：真实 WS share → HOME .gitconfig grant 轮换 → approver 批准 → 上游真到达 → 审计 identity → 六类秘密零泄漏扫全树。旧用例保留为 `approverPreseeded=true` 变体，无删除/弱化。
- 缺口（optional 后续）：remint 失败回滚（save/writer 注入失败）与「owner 吊销/无权只撤不签」分支无直接测试，目前仅靠 rotation 纯缝单测间接覆盖。
- 另注：demo-e2e/wiring 的 `resolveScope` 在 `mode:"demo"` 下是装饰（`#isAuthorized` demo 短路恒真，server.ts:1133），拓扑对齐 demo.ts 可，勿据此声称生产鉴权被测到。

### 附加发现：demo 人工入口断链（R3，required）
banner 改为裸 `http://127.0.0.1:PORT/`，但：demo 模式构造期强制无 auth adapter（server.ts:300）→ `/auth/session` 内 `#cfg.auth!.authenticate` 必 TypeError→401；当前工作树 web/app.js（web-injection 流，不在本 diff 内）已删除 query token 透传、只认 `#token=` hash→cookie 流，而 demo WS 认证只收 query/header token（`#authenticateWS` demo 分支）。结果：按 banner 打开的浏览器永远无法建立 WS（401 重连环）。冒烟日志（demo-smoke.log）只证明 banner 文本打印。「demo 冒烟就绪」对人工双人流程是过度声明。修复方向：banner 恢复可用入口并让 app.js 在 demo 模式透传 query token，或给 demo WS 认证增加 cookie 路径。

## 必修清单
- R1：代理重拉后按新快照重走完整 A6 判定（epoch/jti/revoked/session/aclVersion）+ 复查 `#snapshotFresh`，失败 fail-closed（src/gitproxy/server.ts:486-521）。
- R2：C2 与 dev 模式关系定案（合同限定 / 收紧 dev 默认 / pollMs 生效，三选一）；删除或兑现 demo.ts 的 `pollMs: 5_000`；修正 gitproxy 头注释「≤pollMs（默认 5s）」。
- R3：修复 demo 浏览器入口（banner × app.js × demo WS 认证三者对齐），冒烟需覆盖「按 banner 打开能连上」。

## 证据
- diff：/tmp/perimeter-exec-r67-J3jFOwfP/r74-code.diff；TAP：同目录 *.run21.tap（8 份）；demo 冒烟：demo-smoke.log。
- 关键源码位：src/gitproxy/server.ts:236-260（pollEvery 推导）、395-521（等待重拉与判定）；src/gateway/server.ts:773-806（remint）、1065-1083（onAclChanged）、1132-1141（isAuthorized）、1932-1949（share 门）；src/gateway/session.ts:136-147；src/gateway/grant-rotation.ts（事务原语）；docs/reviews/s2-scm-scoped-grant-contract.md §C2/C3。
