# R77 复审：R76 修 round-13 R1/R2/R3（round-14）

- 日期：2026-10-21。只读复审，未运行任何测试/进程。
- 对象：/tmp/perimeter-exec-r67-J3jFOwfP/r76-code.diff（9 文件合并 diff：attach.ts、demo.ts、gateway/server.ts、gitproxy/server.ts、attach.test、demo-e2e、gitproxy.test、wiring.test、web/app.js），逐 hunk 与工作树对照核验。上一轮报告 grok-s2-scm-scoped-grants-round-13.md 的 R1/R2/R3 为本轮验收基线。
- TAP 核验：run30 共 11 份全部 0 not-ok，计数与报告一致——attach 1、demo-e2e 2、gitproxy 33、wiring 13、gateway 25、git-e2e 10、git-grants-integration 4、redteam-e2e 4、web-injection 6、protocol-coverage 4、enterprise-s1 31。typecheck 0 与「无残留进程」为 coordinator 口述，未独立验证。

## 结论：approve

round-13 三项必修全部真实闭合，且各配了能红的负控 oracle；未发现新的安全回归。残留仅记录性 notes。

## 逐项核验

### ① 安全 —— 通过
- **#route 失败出口完备**：A6 段现为唯一判定 `#checkGrantAgainstSnapshot`（epoch→jti→session→principal/tenant/repo 五 scope→aclVersion，gitproxy/server.ts:415-436）。首判失败且 mayFlip → 等待重拉 → 复查 `#snapshotFresh` → 同一实现复判；四个出口（重拉失败 / 复判后快照超龄 / 复判仍失败带「（重拉后复核）」/ 非 mayFlip 直接拒）全部 deny，无落穿。上轮指出的「非 mayFlip 失败分支漏 deny」绕过已修复（server.ts:509-526 第二个 `if (!check.ok)` 在位）。
- **重拉不可被未验签请求触发/放大**：触发点仍严格位于 `verifyGrant`（HMAC）+ repo 全等 + `#snapshotFresh` 之后；mayFlip=false 的失败不再消耗重拉额度（比上轮更收紧）；单飞 + 全局 1s 限流不变；单请求至多重拉一次、等待 ≤1.2s。
- **demo cookie 不影响 production**：`#demoSessionRoute` 仅 `mode==="demo"` 注册，production `/auth/session` 仍走 IdP `#authRoute`，静态 token 在 production 不被接受；production WS 拒 query token/actor 不变（enterprise-s1 :350-358、:1909-1918 静态+运行时双断言，31/31）。demo cookie 路径校验吊销+过期；`__Host-` 前缀 + HttpOnly + Secure + SameSite=Strict 与生产同形态；CSWSH 由 SameSite=Strict + WS 升级 Origin 精确校验双覆盖。app.js 已恢复 S1（query 凭据删除 + 一次性 hash 引导 + 地址栏抹除）。
- notes（不阻塞）：attach.ts `--token` 路径仍把 token 放 WS query（dev/demo 工具，`--bearer` 为生产路径，建议文档标注）；`x-perimeter-actor` 命名与 gitproxy 合同「x-perimeter-* 不进授权判定」措辞表面冲突（不同组件、demo 专用，建议后续改名）；审批人模板漏 `#actor=` 时会以 demo@local（owner）接入——demo 自报身份模型的既有性质，非新缺口。

### ② R2 与合同 C2 —— 满足（正常路径），一处措辞级残留
- `pollEvery = max(250, min(pollMs, maxAuthAge−1s))`：demo pollMs 4000 → dev 轮询 4s，吊销/轮换 ≤4s 生效 ≤5s ✓；production 4s 不变 ✓。pollMs 从「校验后死配置」变为真实驱动节奏，gitproxy 头注释同步改为「≤min(pollMs, maxAuthAge−1s)，无默认」——round-13 的死配置与失实措辞两项均闭合。
- 实测 oracle：R76/R2 例 dev+pollMs 300 下吊销生效实测 <5s ✓。
- 残留（note）：registry 拉取持续失败时旧快照沿用至 maxStale——dev 30s、production 5s，头注释已如实披露；建议合同 C2 文本补「轮询失败模式下 dev=30s」的显式限定，消除字面歧义。

### ③ 测试真实性 —— 通过，「未带后缀」判据充分
- 后缀判据是确定性的：重拉路径拒绝恒带「（重拉后复核）」，`/（旧 grant 失效）$/` 锚定结尾即可证明该请求未走重拉；与拉取计数差（≤1 容后台拍）互为印证。固定类别文案本就是本套件的一贯 oracle 风格，非放宽。
- 新 R1 例 (a)(b)(c) 正好覆盖 round-13 指出的三个洞：重拉失败→maxStale 拒、重拉后 jti 已吊销→拒、重拉后 epoch 变化→拒，且每例断言 `up.seen.length===0`（上游零请求，强于状态码）。
- attach 例真实子进程 + open 前 stdin 写入（正是缺陷时序），先等 owner 建会话再探测（R76-v8 竞态有守卫）；wiring R76 例按 app.js 真实请求序列走通 cookie 入口并断言未 share 非成员 4003。无断言删除/弱化。
- 证据留痕（note）：demo-browser3.log 仅含 banner/启动输出，人工双人流程本身无逐步留痕（462d946 到达为 coordinator 叙述）；功能等价序列已由 wiring R76 例 + demo-e2e R74 例自动化覆盖，可接受。

### ④ 其余观察
- `#refreshSnapshotAwaited` 失败/超时后的拒绝文案统一为「快照缺失或超过 maxStale」，快照其实新鲜时措辞略不精确——方向保守（fail-closed），记录即可。
- app.js 审批按钮收紧为 approver-only、重连退避、4001/4003 停止重连：合理。
- wiring 13 = 12+1、gitproxy 33 = 31+2、attach 1：与 diff 增量一致。

## 与 round-13 必修清单对照
- R1（重拉后完整重走 + 新鲜度复查）→ 闭合（#checkGrantAgainstSnapshot + 复查 + (a)(b)(c) oracle）。
- R2（C2 定案 / 死 pollMs / 失实注释）→ 闭合（pollEvery 公式 + demo 4000 + 注释改写；dev 故障模式 30s 以 note 转 contract 文本建议）。
- R3（demo 浏览器入口）→ 闭合（demo /auth/session + demo WS cookie + banner 模板 + attach 排队修复 + 浏览器流程实测叙述）。

## 证据
- diff：/tmp/perimeter-exec-r67-J3jFOwfP/r76-code.diff；TAP：同目录 *.run30.tap（11 份）；demo-browser3.log / attach-banner.log。
- 关键源码位：src/gitproxy/server.ts:237-239（pollEvery）、412-436（唯一判定）、502-527（A6 管道）；src/gateway/server.ts:1159-1213（demo /auth/session）、1668-1698（demo WS 三路认证）；web/app.js:47-100（hash 引导 + cookie WS）；tests/gitproxy.test.ts（R74 后缀判据 + R1 三例 + R76/R2 计时）、tests/wiring.test.ts（R76 入口例）、tests/attach.test.ts。
