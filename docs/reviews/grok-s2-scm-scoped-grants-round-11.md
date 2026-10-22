# grok-s2-scm-scoped-grants-round-11.md — R70 覆盖缺口补齐轮复审（Grok R71；task_01927ce33e6d / ctx_1ad69736f8f4）

- 日期：2026-10-21；审者：Grok（term_2769b867…，R62 起同一 reviewer）。被审对象：R70 只增测试（补 round-10 §4 五处缺口：N3 真机/N5/N8/N10/N12）。**本轮只读（native read/rg/shasum/stat/diff+Orca），未运行任何东西**；证据根 /tmp/perimeter-exec-r67-J3jFOwfP 只读未写。唯一 repo 写=本文件。
- **判定：approve——五个新用例均为「真测」（负控确实打到被测门，deny summary/identity 断言来自真实审计文件证明命中原因）；helper 全部可选参数向后兼容；合同 §5 17 行首次全数有 run6 绿色 ok 行对应**。

## 0. 证据链核验（全过）

- run6：gitproxy 27 ok（新增 ok25 N5 / ok26 N8 / ok27 N12）、git-e2e 10 ok（新增 ok9 N3 / ok10 N10）、wiring 9 ok、git-grants-integration 4 ok——既有用例名逐一未变仍绿（向后兼容的运行期佐证）。
- run5 唯一失败=ok26 N8（http.request 字符串 URL 被 WHATWG 规范化吃掉点段→打到正常路径）——run6 改 `options.path` 原样发送后转绿：失败原因与修法对应，诚实迭代在案。
- unit-run6 tap：`pass 64 fail 0`（74.6ms）；typecheck tc/tc3/tc4/tc5/tc6 六轮全空=成功签名（tc6 为 R70 终轮；exit0 采 coor 在案记录）。
- mtime：tests/gitproxy.test.ts、tests/git-e2e.test.ts 均早于 gitproxy.run6.tap——绿跑后零改动。
- 证据缺口如实：run6 无独立 procs 快照（procs-before2/after2 为 R69 轮对照且逐字节恒定）；「无新残留」采 coor 在案记录+R70 改动面为纯测试增补（沿用既有 cleanups 模式）佐证。

## 1. 五个新用例「真测」判定（逐个）

- **N3 真机越权写（git-e2e ok9）**：grant 写域签发端限定 `refs/heads/feature/*`。正控先行（域内 feature/x 推上、上游 log 含域内提交——证明写能力真实在用，排除基础设施性假绿）；负控 `push HEAD:refs/heads/other`→403；**上游不变三重证明**：main HEAD 与推前 rev-parse 相同、`refs/heads/other` 上游不存在、main log 无越权提交；deny summary 含 "writeRefs" 证明命中的是写域门而非旁因 ✓。
- **N5 HTTP 过期（gitproxy ok25）**：签发时钟回拨 700s（exp=签发now+600s<当下；签名时 exp>签发now 且 ≤15min 仍合法——排除签发期拒绝假绿）→403+上游零请求+deny summary 含「过期」证明命中的是过期门；无真实 sleep ✓。
- **N8 四形态（gitproxy ok26）**：%编码/大写（allowlist 字面量不解码不全等）、双斜杠（raw url 先查）、`..` 经 `options.path` 原样发（run5 已证字符串 URL 会规范化假打）——四形态均真达服务端 raw 检查，[403,404] 为合同 N8 明示区间，集体 `up.seen.length===0` ✓。
- **N10 显式 v2（git-e2e ok10）**：`-c protocol.version=2` clone+fetch 正例（git-protocol 头透传/回落协商，与 B3「授权与版本无关」一致）+ 同一只读 grant 打 receive-pack→403+上游 main log 无该提交+deny「无写能力」。覆盖口径在测试注释如实：裸 SHA want 属 B5① pass-through 设计内，fixture 上游为 v0 自动回落——恰为合同 N10 行原文要求的形态 ✓。
- **N12 伪造头（gitproxy ok27）**：三态——无 grant+伪造→401（伪造头不构成凭据）；只读 grant+伪造打 receive-pack→403 caps 层；合法读 grant+伪造→200 且上游见注入凭据（`up.seen[0].auth===UPSTREAM_AUTH`、`seen.length===1`）。identity 断言取自**真实审计文件**（auditEntries）：sessionId="sess-test"/actor="principal-test"/team="tenant-test" 与 grants.ts 常量逐一吻合，整条 deny JSON 不含 "forged-" ✓。

## 2. helper 向后兼容（全过）

`makeIssuer` 增 `now?`（缺省 Date.now()，exp 与签名时钟同源——旧行为逐位不变）；git-e2e issuer/`startProxy.issue` 增 `writeRefs?`（缺省 `["refs/heads/*"]` 不变）；`sandboxHome` 增第三参 `grantOpts={}`（缺省 `write:true` 不变）。run6 既有 51 例名全部未变仍绿=运行期佐证。

## 3. 合同 §5 全表（run6 ok 行引用）

| 行 | run6 对应 | 状态 |
|---|---|---|
| N1 | integration ok3（repo 失配）+ gitproxy ok16 | ✓ |
| N2 | integration ok2（session 未登记） | ✓ |
| N3 | gitproxy ok9（HTTP）+ **git-e2e ok9（真机+上游三重不变）** | ✓ |
| N4 | gitproxy ok6 + git-e2e ok5 | ✓ |
| N5 | **gitproxy ok25** | ✓ |
| N6 | integration ok3（jti 吊销）+ ok4（maxStale fail-closed） | ✓ |
| N7 | integration ok3（旧 jti=revoked 同机制） | ✓ |
| N8 | **gitproxy ok26**（四形态真达 raw 检查） | ✓ |
| N9 | gitproxy ok22/ok24/ok21/ok17 | ✓ |
| N10 | **git-e2e ok10**（显式 v2；裸 SHA=pass-through 设计内，注释如实） | ✓ |
| N11 | gitproxy ok7 | ✓ |
| N12 | **gitproxy ok27**（真实审计 identity 断言） | ✓ |
| N13 | integration ok2/ok3 | ✓ |
| N14 | gitproxy ok10 + unit receive-pack 13 例 + ok14/19 | ✓ |
| N15 | gitproxy ok12 | ✓ |
| N16 | gitproxy ok11 + unit git-grants legacy（64-unit run6 在案） | ✓ |
| P1 | git-e2e ok1/ok2/ok3 + gitproxy ok5 | ✓ |

**17/17 全数有绿色 ok 行对应**；round-10 §4 五项 required 全部闭合。

## 4. 结论与后续

- **approve**。R70 改动面=纯测试增补（r70-code.diff 相对 HEAD 1deaddc 仅 tests/git-e2e.test.ts 与 tests/gitproxy.test.ts 两个文件），零生产改动；既有断言零放宽。
- 后续维持：17 项真实验收面其余项（demo 双进程 C3 等）pending；optional 维持（PKT_MAX 注释、git-grants 未用 import、close-during-arm、3xx dispose、R58 元勘误）。

## 5. 元信息

本轮零行为达成（native read/rg/shasum/stat/diff+Orca；未运行任何测试/编译/解释器；Git 未触）。typecheck exit0 与 run6 进程残留采 coor 在案记录（本轮未复跑；TAP 总行/mtime/常量吻合已独立核验）。本报告不含自身 hash。
