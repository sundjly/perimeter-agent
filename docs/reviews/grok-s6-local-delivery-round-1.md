# Grok S6 本地交付包独立评审（round 1）

- 日期：2026-10-22；评审者：Grok（独立 reviewer，只读复审）
- 基线：HEAD `c66c785`（SBOM 证据 `s6:repo:revision=c66c785bc71d7539aaa2e0520fc0d8bb06a1b8e4` 与之一致）。
- 性质：**本地包复审，不是企业放行**。本轮未运行任何测试/tsc/git/网络/子进程；全部结论来自原生只读读取代码、锁文件、文档与 `/tmp` 证据文件。
- 评审对象：`scripts/s6-supply-chain.ts`、`tests/s6-supply-chain.test.ts`、`docs/implementation/s6-local-delivery.md`、`docs/operations/s6-runbook.md`；交叉读 `package.json`、`package-lock.json`、runbook 引用的 backup/restore/deploy/lifecycle 脚本、`docs/handoff.md` §3/§5.2/§7/§9、S2/S4 已实现范围。未审 S5d 其他新 `src/evals` 文件。

## 结论：approve

S6 本地交付包四文件事实准确、语义边界完整、证据链诚实，无阻塞项。本地 SBOM CLI 通过全部核查项；已知未修依赖漏洞如实入账且未被标为清洁；P0 仅作证据索引（partial/local_verified-本地/external_blocked），未声明企业批准。

## 逐项核查

### 1. CycloneDX 1.6 格式
`buildBom`（scripts L192-230）产出 `bomFormat=CycloneDX`、`specVersion=1.6`、`urn:uuid:` serialNumber、`metadata.tools.components`（1.6 合法形态）、组件 `type=library`、`scope` 仅在 optional 时写合法枚举值、`hashes[].alg=SHA-512` 配 128 位小写 hex。实际锁产物 `/tmp/perimeter-s6-sbom-v3.json` 与之逐字段吻合。schema 证据 `/tmp/perimeter-s6-schema-validation.json`（valid=true）为先轮产物；此后唯一 delta 是 licenses 弃 id 改全 `name`——`license.name` 在 1.6 schema 中是无约束字符串，构造上仍合规且更保守（见残余 R7）。

### 2. 全锁 direct/transitive 包含
`parseLock` 遍历 packages 全部键（根条目除外，scripts L143-148）；嵌套 `node_modules` 异版本保留（tests L52-77）。实际核对：锁内 4 个 4 空格缩进键形态扫描确认全部为 `node_modules/…`（无 workspace/link 键，脚本不会误拒）；SBOM `entryCount=componentCount=126`，与 audit 报告 `total dependencies=126` 三方一致；直依赖 4 个 `@earendil-works/*` 与传递依赖（如 `@anthropic-ai/sdk`、`fast-uri`）均在册。

### 3. scoped purl
`toPurl`（scripts L152-156）：名全小写、`@`→`%40`、version 百分号编码，符合 purl 规范 npm 规则；`@scope` 键推导名校验（裸 `@scope`、多段名固定拒，scripts L74-79）。测试 L80-88 与实际产物（`pkg:npm/%40scope/…` 形态 5+ 处）吻合。

### 4. revision unknown 诚实
`readGitRevision`（scripts L237-261）纯文件读取 `.git/HEAD`→松散 ref→`packed-refs`，任何失败返回 `"unknown"` 不虚构；工作树 `gitdir:` 文件形态等不支持场景同样落 unknown（诚实回退）。测试 L205-233 覆盖松散 ref/packed-refs/直连 HEAD/无 .git 四形态。实际产物写入真实 sha。

### 5. license 只 name、只锁证据
有锁内 license 证据才写，一律 `{license:{name:<锁原文>}}`（scripts L90-100、L158-161），UNLICENSED/LicenseRef/自定义名保留原文不冒充 SPDX id，无证据时整个字段不出现（不伪造 unknown）。测试 L112-129 逐类断言含无证据负控。实际产物 `fast-uri` 记 `BSD-3-Clause`、`ajv` 记 `MIT`，与锁条目原文一致。

### 6. hash
`integrity` 仅接受 `sha512-<base64>`（scripts L102-109），解码后非 64 字节抛 `integrity_invalid`（scripts L169-174），输出 `SHA-512` hex。测试 L27/L131-141 用已知向量（`"a"×64`→`"61"×64`）锁定转换正确性；产物 hash 为 128 hex。sha1/含空格形态固定拒有测试（L178-179）。

### 7. 离线：无命令执行/联网/密钥
imports 仅 `node:crypto randomUUID`、`node:fs`、`node:path`（scripts L20-22）；零 `fetch`/`child_process`/env 读取；`hasInstallScript` 只记属性（scripts L176-178），从不执行；写面仅 `--out` 文件或 stdout，摘要走 stderr。

### 8. invalid 输入非零不写产物
全部异常路径（损坏 JSON/版本 1/packages 缺失/根条目坏/键形态/名称不一致/版本缺失/license/integrity）抛固定类别 `SbomError`；`main` 返回 1，序列化完整后才 `writeFileSync`（scripts L294-296），失败绝不产出部分 SBOM。测试 L165-179 逐类别断言 code，L181-202 断言失败路径目标文件不存在（含未知 flag、缺文件）。TAP 证据 `/tmp/perimeter-s6-unit-v3.tap`：10/10 pass、0 fail。

### 9. 测试实质性
四个 suite 覆盖完整性/去重 alsoAt/purl、license 证据纪律（含非 SPDX 单 token）、hash/dev/optional/hasInstallScript、未知字段忽略、12 类固定错误、CLI 成功/失败产物纪律、revision 四形态。断言到字段级而非冒烟，属实质 fixture 测试。小缺口见非阻塞意见 N6。

### 10. TS2322 修复核验（本轮重点）
`tests/s6-supply-chain.test.ts` **L177**：`{ "node_modules/foo": { version: "1.0.0", license: 42 } } as unknown as Record<string, FixtureEntry>`——双 cast 现位于传给 `fixtureLock` 的**映射层级**，与协调者指定修法一致；运行时非法值（42）保持原样进入 `parseLock`，`license_unsupported` 负控语义不变（L179 断言仍生效）。L172 另有一处同层级冗余 cast（本无需 cast，无害）。本轮未运行 tsc（只读纪律），复跑归协调者（残余 R6）；静态检查测试文件其余部分无其他类型缝。

### 11. Runbook 命令与实现匹配
逐条对照：§0 全部命令均为 `package.json` 实际脚本（gateway/modelgw/gitproxy/demo/attach/backup/restore/gen:deploy/export:siem/test:bounded/typecheck）；§8 SBOM 命令与脚本参数一致；§4 backup/restore flags 与 `scripts/backup.ts` L254、`scripts/restore.ts` L305 usage 字符串逐字一致；§2 锁判读四态 live/stale/foreign-host/unparseable 与 `src/gateway/state-lock.ts` L134-153 一致；§3 budget-ledger（WAL+FULL、BEGIN IMMEDIATE、usage_unknown 保守保留、strictBudget 强制 ledgerFile、`reconcile()` L222）与 `src/modelgw/budget-ledger.ts` 一致；§1 `AuditLog.verify(path, expectedHead)` API 在 `src/audit/log.ts` L272（无 CLI 的表述属实）；§6 漂移守卫有测试锁定（`tests/k8s-schema.test.ts` L152-163 两个"无漂移"用例）；attach 冲突参数（--bearer/--token 互斥、--bearer 禁 --actor）与 demo 环境变量均与实现一致。§8 审计命令为协调者联网步骤，与本地包无冲突；已知漏洞表述（§8 末条）与 audit 证据一致且未标清洁。

### 12. P0 证据索引口径（handoff §5.2 对照）
impl §5 逐行给出状态+证据+具名缺口，与 handoff §5.2 条目一一对应；抽查属实：S2 保护路径 commit `e162088`（18/18×3，hardlink/init 流形残余）与 `docs/implementation/s2-protected-paths-plan.md` L47 记录一致；S4 价格全 0 与 handoff §4.1 一致；four-eyes 有 `tests/four-eyes.test.ts`。全文明确"S6 不标记企业放行"，runbook 开头同此声明。口径符合任务约束（证据索引/partial/external_blocked；`local_verified` 是文档图例内的本机证据态，且每处均附具名外部缺口）。

### 13. 漏洞披露（不标清洁）
`/tmp/perimeter-s6-npm-audit.json`：仅 fast-uri 3.1.5，severity high、`fixAvailable:true`、range 3.0.0–3.1.7，via 含 5×high（CVSS 7.5）+1×moderate（4.8）；`/tmp/perimeter-s6-fast-uri-path.json` 证实 dev 链 root→ajv/ajv-formats→fast-uri。impl §6.5 与 runbook §8 的 GHSA/CWE/CVSS/范围逐项与证据吻合，明写"扫描已完成 ≠ 已修复，属发布阻塞项"，锁未动。SBOM 自身 `s6:coverage:vulnerabilityScan=not-performed`，不产漏洞结论——未将有漏洞的锁标为清洁。

## 阻塞项

无。

## 非阻塞意见（建议，不阻塞 approve）

- N1（文档数字）：impl L36 "真实锁（1765 行）"，实际 `package-lock.json` 为 1760 行。下次顺手改。
- N2（命令变体）：runbook §8 规范命令为 `npm audit --json` / `--omit=dev`，实际执行记录（impl §5.2/§6.5）是 `npm audit --package-lock-only --ignore-scripts --json`。落盘规范要求记命令原文，建议 §8 补注该 lock-only 变体，避免后来者对不上证据。
- N3（可移植性）：runbook §8 `sha256sum` 在 macOS 缺省不存在（`shasum -a 256` 等价）。运维口径面向 Linux 部署可接受，建议加一行替代写法。
- N4（状态词汇一致性）：impl §5 四眼审批行状态 `local_verified（本地）`，其他行均为 `partial`。图例定义了该态且行内带具名缺口，事实无损；建议统一为 `partial` 以对齐任务口径"P0 只能证据索引/partial/external_blocked"。
- N5（极端分歧证据略损）：同 purl 去重时（scripts L196-206）仅记 `s6:lock:alsoAt`，保留首见条目的 dev/license/integrity 标志；锁内同名同版本条目标志通常一致，若极端分歧则第二安装位的标志差异不入册。可选改进，不要求本轮。
- N6（测试缺口）：license `string[]` 形态、`integrity_invalid`（base64 解码后非 64 字节，scripts L169-174）路径、`--out` 省略走 stdout 的分支均无直接断言。均为简单分支，可下次补。

## 残余（如实入账，不因 approve 消失）

- **R1 未修依赖漏洞（发布阻塞）**：fast-uri 3.1.5（dev，ajv→fast-uri 传递，不进生产运行时面），5×high+1×moderate，`fixAvailable:true` 未修锁（锁禁改，协调者决策）。升级或书面例外由协调者另立决策；在此之前不得放行发布。
- **R2 覆盖缺口**：`vendor/`（`vendor/pi-env` 在场）与容器镜像不在任何 SBOM/audit 覆盖内（产物 metadata.properties 已标 `not-covered`）；镜像 SBOM/签名/镜像扫描需外部工具，external_blocked。
- **R3 企业条件 external_blocked**：真实环境 soak、真实成本/账单对账（S4 价格全 0）、客户安全负责人具名批准均未获得；本轮 approve 仅指本地包质量，不构成任何企业放行。
- **R4**：隔离目录恢复演练未做（impl §5.2 已如实记录）；SBOM 无 `dependencies` 依赖图段（设计取舍，已列残余）；lockfileVersion 1/workspace 键形态固定拒（显式边界）。
- **R5**：prod-only（`--omit=dev`）audit 报告缺失，现证据仅 -all 一份；fast-uri 为 dev-only，prod 报告预期干净，建议协调者补跑落盘。
- **R6**：typecheck 复跑待协调者（本轮只读核验 L177 cast 已在映射层级；未运行 tsc）。
- **R7**：官方 schema 校验证据为先轮产物（license 改 name 前）；name-only 构造上合规，建议对最终产物复跑一次校验以闭环。

## 证据清单

- `/tmp/perimeter-s6-unit-v3.tap`：10/10 pass，4 suites，0 fail（含 stderr 的 CLI 失败路径输出）。
- `/tmp/perimeter-s6-sbom-v3.json`：实际锁产物；entryCount=componentCount=126；revision=c66c785…；fast-uri/ajv 条目含 dev 属性、锁内 license、SHA-512 hex。
- `/tmp/perimeter-s6-schema-validation.json`：先轮 SBOM 官方 CycloneDX 1.6 schema valid=true（ajv 忽略未用 iri/idn format；最终产物未用相关字段）。
- `/tmp/perimeter-s6-npm-audit.json`、`/tmp/perimeter-s6-fast-uri-path.json`：1 high（fast-uri 3.1.5）与 dev 传递链证据。
