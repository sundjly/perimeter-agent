# grok-s2-scm-scoped-grants-round-10.md — R67/R68 真实验收修复轮复审（Grok R69；task_ae420c463d48 / ctx_dc4a072ffb46）

- 日期：2026-10-21；审者：Grok（term_2769b867…，R62/R64/R66 同一 reviewer）。被审对象：R67/R68 验收修复轮（用户授权真实 127.0.0.1+本地 git 验收）。**本轮只读（native read/rg/shasum/stat/diff+Orca），未运行任何东西**；证据根 /tmp/perimeter-exec-r67-J3jFOwfP 只读未写。唯一 repo 写=本文件。
- **判定：approve——生产缺陷修复正确、最小、无行为回归；八项「测试问题」判定全部成立、无以改测掩盖；合同 §5 映射完成，5 处既有覆盖缺口如实列为后续批 required（不阻塞本轮）**。

## 0. 证据链核验（全过）

- 首跑失败面与任务陈述吻合：gitproxy.tap not-ok 22（=2/24）、git-e2e.tap not-ok 7（=1/8）、wiring.tap not-ok 1（=8/9）、git-grants-integration 首跑即 4/4。
- 最终 run4 全绿亲读：gitproxy 24 ok、wiring 9 ok、git-e2e 8 ok、git-grants-integration 4 ok（`^ok` 行逐一在案）；typecheck tc/tc3/tc4 空=tsc 成功签名（exit0 采 coor 在案记录）；unit-run/r65-driver/tap-r65.log=`1..64 pass 64 fail 0`（64 unit 回归，81.8ms）；procs-before2.txt 与 procs-after2.txt **逐字节相同**（无残留；所列进程均为与本验收无关的用户进程）。
- mtime 时序：全部五处改动文件早于 gitproxy.run4.tap——绿跑后零改动，工作区即被测状态。

## 1. 生产缺陷修复：#requestBodyStream（唯一生产改动，两处调用点，toWeb 零残留）

缺陷成立：裸 `Readable.toWeb(req)` 适配器在 fetch 失败/取消后 controller 已 closed，req 残余 'data' → enqueue 抛未捕获 "Invalid state: Controller is already closed" 打崩进程。修法逐项：

- **背压**：`data` 内 `desiredSize<=0 → req.pause()` + `pull → req.resume()`——标准手动背压偶联，队列以默认 HWM=1 有界；不消费即暂停 socket，TCP 背压真实传导。
- **cancel/收束后不炸**：enqueue/close/error 全部 try 包裹；`cancel → req.pause()` 止流，止流后无 data 事件，closed-controller enqueue 不可能再发生（try 为双保险）。
- **拒绝响应仍可送达**：pause 而非 destroy——同一 socket 存活，既有 cancelAndDeny/502 写响应路径不受影响；error 路径 `controller.error` 包裹，req 无 unhandled 'error'。
- **无泄漏/挂起**：监听器随 req/socket 生命周期；消费者放弃路径全部经由既有全寿命 deadline（120s abort → fetch cancel → reader cancel → 本 cancel → pause）收敛，与 R58-② 机制同缝。转发语义不变（chunk 顺序保持，Buffer→Uint8Array 拷贝）；identity 路径 content-encoding 头保留。

## 2. 八项「测试问题」判定（全部成立，无掩盖）

| 判定 | 核验 |
|---|---|
| grant 缺 aclVersion（gitproxy/git-e2e issuer） | validateClaims A6 必填；issuer `as never` 断言绕过 tsc 致 typecheck 未拦——运行期 401/拒签，测试未达既测面 ✓ |
| 未带凭据（#4/#18） | 401 先行，未达既测行为；#18 以 `Basic x-session:<grant>` 对齐真实 insteadOf 形态 ✓ |
| 未带 receive-pack content-type（#5/#12/#14/#19） | B2 三方一致为 caps/allowPush 前置（生产 fail-closed 设计），否则先行 400 ✓ |
| N14 flood 构造错 | 原构造每包自带 flush→首 flush 即收束命令区、余量沦为 PACK（设计无界）→误 200；新构造 700×103B（"0067"=103）无 flush+单收尾 flush=72104B>65536，**真测 >64KiB 拒绝**；断言（403/413 拒+上游零写）原样未弱化 ✓ |
| N15 302→rejection | 生产 `redirect:"error"`（gitproxy :597）→undici 对 3xx 呈现为 fetch rejection→固定类别 502 deny；「重定向」summary 仅注入 fetchImpl 直返 3xx 分支可达（:612 在案）。安全断言全保留：502+deny+跳转目标零请求（标题未动）✓ |
| wiring hex 碰撞数据错 | 原 masterKey 原字节 vs hex 文本=不同字节，byte 级比较本就不碰撞→断言恒失败；改等值字符串形态（同字节异形态= R-Q50-5 本义）✓；expectCtorThrow 先 close 再 fail 防构造残留挂死=测试卫生 ✓ |
| #22 精确 400 | 生产 :468 `deny(400, "拒绝：service 参数重复")` fail-closed 在案，403 断言与实现不符 ✓ |
| R67 强度门前置（wiring） | H1 强度门先于互异检查：12B token 在互异前抛「强度不足」；数据补足 ≥32B 后互异分支真实可达 ✓ |

## 3. 合同 §5 映射（N1–N16+P1 → run4 TAP ok 行）

| 行 | 通过测试（run4 亲读） | 状态 |
|---|---|---|
| N1 跨 repo | git-grants-integration ok3（repo 失配→拒）+ gitproxy ok16（allowlist 面） | ✓ |
| N2 跨/未登记 session | integration ok2（session 未登记→拒） | ✓ |
| N3 ref 越权写 | gitproxy ok9（HTTP，越域 ref→403 上游零写）；**真实 git 越权写分支无** | **partial** |
| N4 只读 grant 推送 | gitproxy ok6（caps 层先于解析）+ git-e2e ok5（真机 push 拒且不到上游） | ✓ |
| N5 过期 | **无 HTTP 层验收例**（仅 unit git-grants 过期例） | **缺失** |
| N6 吊销 | integration ok3（jti 吊销→拒）+ ok4（maxStale fail-closed） | ✓ |
| N7 旧 jti | integration ok3（换发后旧 jti=revoked 同机制） | ✓ |
| N8 编码/双斜杠/大小写 | 机制面=allowlist 全等（ok16）+路由 raw `//`/`..` 403；**无 %编码/大写显式负控** | **partial** |
| N9 service 重复/大小写/缺失 | gitproxy ok22（重复→400 判定转发一致）+ ok24（大小写不透传）+ ok21（仅 service 透传）+ ok17（非 git 端点/缺 service 400 族） | ✓ |
| N10 v2 裸 SHA want | git-e2e ok1/ok2（现代 git 默认 v2 握手隐式过）；**无显式裸 SHA/protocol.version=2 例** | **implicit** |
| N11 claims 篡改 | gitproxy ok7（HMAC 失败→403 上游零写） | ✓ |
| N12 伪造头 | **无 x-perimeter-* 伪造头负控**（审计 identity=grant 无显式断言） | **缺失** |
| N13 未登记时序 | integration ok2/ok3（快照剔除后使用→拒） | ✓ |
| N14 超限/畸形 | gitproxy ok10（>64KiB→413，真测）+ unit receive-pack 13 例（坏长度/空命令区/编码）+ gitproxy ok14/19（"0000" 空命令区 403 路径） | ✓ |
| N15 redirect | gitproxy ok12（302→502+deny，跳转目标零请求） | ✓ |
| N16 legacy | gitproxy ok11（production 构造两抛错）+ unit git-grants legacy（dev 显式可构造） | ✓ |
| P1 真实 git 正例 | git-e2e ok1（clone）+ ok2（push 真到上游）+ ok3（全树无凭据）+ gitproxy ok5（git.push allow 留痕） | ✓ |

## 4. 结论与后续

- **本轮修复面：approve**。生产改动仅 #requestBodyStream 一处（含 :752 prepare 同缝替换），测试改动全部为让既测面真实可达/构造保真，断言语义未放宽（N14 断言原样、N15 安全断言全保留、#22 对齐生产既有 400）。
- **required（后续批，合同 §5 收口缺口，非本轮引入）**：①N3 真实 git 越权写例（write grant 打 writeRefs 外分支+上游 HEAD/pack 不变）；②N5 HTTP 层过期例；③N8 %编码/双斜杠/大写显式负控；④N10 显式 protocol.version=2/裸 SHA want 例；⑤N12 伪造头负控（审计 identity=grant 真值、summary 无假值）。
- 17 项真实验收面其余（demo 双进程 C3 等）维持 pending；optional 维持（PKT_MAX 注释、git-grants 未用 import、close-during-arm、3xx dispose、R58 元勘误）。

## 5. 元信息

本轮零行为达成（native read/rg/shasum/stat/diff+Orca；未运行任何测试/编译/解释器；Git 未触）。typecheck exit code 与驱动退出码采 coor 在案记录（本轮未复跑；工件一致性已核：TAP 总行、空 stderr、mtime 时序）。本报告不含自身 hash。
