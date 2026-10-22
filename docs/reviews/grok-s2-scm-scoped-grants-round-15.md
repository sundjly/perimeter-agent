# R79 复审：R78 历轮非阻塞项收尾（round-15）

- 日期：2026-10-21。只读复审，未运行任何测试/进程。基线 HEAD d6f325e（R74-R76 已提交）。
- 对象：/tmp/perimeter-exec-r78-KoZDveWo/r78-code.diff（10 文件，与工作树逐 hunk 一致）；r78-doc.diff 为 0 字节——原因：合同文档 docs/reviews/s2-scm-scoped-grant-contract.md 整个未入 git 跟踪（untracked），diff 无从产生；⑧ 的措辞已在工作树实文验证（见下）。
- TAP 核验：run3 共 15 份、全部 0 not-ok。attach 2、demo-e2e 2、gitproxy 33、wiring 14、gateway 25、git-e2e 10、git-grants-integration 4、redteam-e2e 4、web-injection 6、protocol-coverage 4、enterprise-s1 31、protected-paths 17、four-eyes 12、docker-owned-ledger 1、docker-backend 顶层 ok 28 但 TAP 汇总行 `# tests 35 / # pass 35 / # fail 0`（含嵌套子测试，与报告 35/35 一致）。unit 65/65（unit-run3/r65-driver）。

## 结论：approve

五项收尾全部落实且真实；③b 删除经逐行核验成立；未发现回归。

## 逐项核验

### (1) attach Authorization 头 + x-demo-actor 改名 —— 通过
- attach.ts demo/dev 分支：token 只进 WS 握手 `Authorization: Bearer`，query 只剩 actor/session。与网关真实对应：`#authenticateWS` 顶部先读 `header = bearer(req.headers.authorization)`，demo 分支 `url.searchParams.get("token") ?? header`——头与 query 等价，行为不变。新 attach 例用本地 server 的 `upgrade` 事件捕获**真实握手报文**断言：query 无 token、actor 在 query、头为精确 Bearer 串——真 oracle。
- production 路径未变：diff 只改 else 分支；`--bearer` 仍仅设 Authorization 头且禁 `--actor`；production WS 拒 query token/actor 的代码原样（server.ts:1693）。
- 改名完整：`x-demo-actor` 仅出现在 gateway `#demoSessionRoute`（demo 模式门内）、web/app.js、wiring 两处头；production 全链路不读该头。gitproxy 侧伪造头负控（gitproxy.test:571 x-perimeter-actor forged）保留且通过——代理从不读 actor 头（A3/N12 语义未动）。

### (2) ③b 不可达论证 —— 逐行核验成立，删除可接受
- demo 下 entry.principal === owner 串：server.ts:1040 `identity.principal ? issuer|subject : actor`——demo identity（query 或 Cookie）都不带 principal → 落 actor ✓。
- `#isAuthorized` demo 恒真（:1133 mode==="demo" return true）✓；production share 前被连接级门先拒：:1977 `opts.isAuthorized(actor, meta.data)` 关连接 4003，先于 :1989 share 分支 ✓。
- `#revoked` 写点枚举准确：#loadRevocations（ctor，:1751）、revokePrincipal（:1827）、restorePrincipal（:1851），无第四写点 ✓。
- revokePrincipal 顺序：先 `#revokeGitGrantPrincipal`（entry 全撤）再 add revoked 再断连——此后任何 onAclChanged 都走 `if (!scope) return` 早退 ✓。
- `setAclVersion` 唯一调用方 = share/unshare 命令处理（server.ts:2002），命令需存活已认证连接；被吊销 owner 连接已断、重连在 upgrade 处 401 ✓；会话死亡路径 onDisposed 同步撤 entry + `session.alive` 闸 ✓。
- 结论：「owner 已吊销/无权→只撤不签」在 entry 存在前提下无可达触发路径；分支保留为纵深防御，公开 API 不可驱动故无直接测试——可接受（该分支无 oracle 一事已在本报告记录在案）。

### (3) R78(a) 回滚例真实 + timer/3xx 改动无副作用 —— 通过
- (a) 例：HOME chmod 0500 → 重签投递步 writeFileSync EACCES，走「写 HOME 失败」回滚支路（零 prod 改动、真实缝）。断言链：active 无该 session（fresh entry 连同移除）、revokedJtis **恰 2**（旧 jti 已撤 + new jti 退役——数字精确，多或少都红）、HOME .gitconfig 仍是旧串、固定类别审计「git grant acl 变更回调失败」在案；收敛轮询带诊断输出。真实回滚 oracle，round-13 缺口闭合。
- OwnedRenewTimer `#gen += 1`：修复真实——若无 bump，被 clear 句柄捕获的 gen 仍等于当前 gen，fake timer 手动触发会执行 onFire；bump 后 gen 失效返回。与 stop() 同构；`skipped-closed` 语义与调用方处理不变；该分支不触 onFire/dispose，无双 dispose。新单元例（setTimeoutImpl 内同步置 closed）正是缺陷场景，fired 恒 0 断言真实。unit 64→65 吻合。
- gitproxy 3xx 补 `preparedDispose?.()`：prepare.dispose 为 R57-6 幂等 Promise（缓存首次收束），3xx 路径调用后即 return，与其余完成路径同纪律；无双 dispose、无语义变化。PKT_MAX 注释 0xfff4=65524 现在正确（旧注释 0xffff-4=65531 确为错）。git-grants.test 删未用 import 无害。

### (4) 测试真实性 —— 无放宽
新增 3 例（attach 握手形态、wiring R78(a)、owned-timer gen）全部为行为级断言，既有用例零删改（对照 HEAD 验证：「只撤不签」例在 HEAD 中从未存在，系 R78 迭代中写出后删除）；demo-e2e/gitproxy 等既有计数与 run30 完全一致，无用例消失。

### (5) modelgw 未动 —— 确认
r78-code.diff 十个文件不含 src/modelgw/**；工作树 modelgw 三文件（secrets.ts/server.ts/upstream-auth.ts，+349 行）为历史未提交改动，不在本轮范围。附带记录：modelgw/server.ts:198 仍读 `x-perimeter-actor` 作审计缺省——历史改动内的既有面，与 gitproxy 合同命名空间划清的问题留待该流收口时处理。

### ⑧ 合同 C2 文案
工作树实文（:132）已含「registry 拉取持续失败时沿用旧快照至 maxStale（production 5s、dev 30s）后 fail-closed」，与 round-14 note 的建议一致、措辞准确。注：该文件 untracked，故 r78-doc.diff 为空，措辞审读以实文为准。

## 残留 notes（不阻塞）
- setAclVersion 兜底审计文案「撤销未完成」在 remint 失败场景名不符实（撤销实际已完成）——round-13 起的 cosmetic 项，R78(a) 例按前缀匹配不受影响，留待顺手修。
- attach demo actor 仍在 query（网关 demo 分支无 actor 头通道），代码注释已如实标注。
- 「只撤不签」纵深防御分支自此无直接测试（不可达所致），如未来该分支可达性变化需补例。

## 证据
diff：/tmp/perimeter-exec-r78-KoZDveWo/r78-code.diff、r78-doc.diff（空）；TAP：同目录 *.run3.tap、unit-run3/r65-driver/tap-r65.log。关键源码位：scripts/attach.ts:31-40；src/gateway/server.ts:1040、1192-1197、1751、1820-1849、1977、2002；src/gateway/owned-renew-timer.ts:68-74；src/gitproxy/server.ts:686-693；tests/wiring.test.ts（R78(a)）、tests/attach.test.ts（握手例）、tests/owned-renew-timer.test.ts（gen 例）。
