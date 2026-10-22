# S6 本机可交付：离线 SBOM CLI + 漏洞扫描规范（s6-local-delivery）

- 日期：2026-10-22；作者：Pi（S6 本机交付包，与 S5c/S5d 并行）
- 性质：**本地运行验证完成，Grok round-1 approve**；企业放行条件仍未满足（本包 Pi 作者未执行 node/test/typecheck/git，运行证据由协调者产生）。
- 范围纪律：只写四个新文件——`scripts/s6-supply-chain.ts`、`tests/s6-supply-chain.test.ts`、本文档、`docs/operations/s6-runbook.md`；未改任何源码、锁文件、vendor、既有 docs/progress。
- 依据：`docs/handoff.md` §5.2（数据与供应链）、§7（S6 企业交付演练）、§9（运维交接）；`package-lock.json`（lockfileVersion 3）。

## 1. 交付物

| 文件 | 内容 |
|---|---|
| `scripts/s6-supply-chain.ts` | 离线 SBOM 生成 CLI（CycloneDX 1.6 JSON）。零网络、零子进程、零新依赖；只读锁文件与 `.git` 元数据文件；不安装依赖、不执行锁中脚本 |
| `tests/s6-supply-chain.test.ts` | fixture 测试（node:test，离线）：完整性/purl/去重、license 证据纪律、未知字段忽略、固定错误类别、CLI 非零退出不产文件、revision 四形态 |
| `docs/operations/s6-runbook.md` | 中文 runbook：审计/磁盘、就绪/独占锁、未知副作用/预算、备份恢复、凭据轮换、发布回滚、资源回收、SBOM/漏洞扫描命令与落盘规范 |

## 2. 语义边界与设计决策

- **输出**：`bomFormat=CycloneDX`、`specVersion=1.6`、`serialNumber=urn:uuid:*`；`metadata.component` 为锁根条目（application）；组件按 purl 排序，除 serialNumber/timestamp 外逐字节确定，便于跨 revision diff。
- **purl**：npm 名全小写；scope 前缀 `@` 编码为 `%40`（`pkg:npm/%40scope/name@1.2.3`）；version 百分号编码。同名同版本包在嵌套 `node_modules` 的多个安装位按 purl 合并为一个组件（bom-ref 唯一性），其余安装位记入组件属性 `s6:lock:alsoAt`。
- **licenses 仅在锁有证据时写，一律 `license.name` 保留锁原文**：不把任意单 token 冒充已知 SPDX id——`UNLICENSED`、`LicenseRef-*`、自定义名都不是可断言的标准 id（协调者评审结论，首轮 id/name 双轨已废弃）；锁里没有 → 整个 `licenses` 字段不出现。**不伪造 unknown**。
- **其他锁内证据**：`integrity: sha512-*` → 组件 `hashes: [{alg: SHA-512, content: <hex>}]`（base64 解码校验 64 字节）；`dev:true` → 属性 `s6:lock:dev`；`optional:true` → `scope: "optional"`；`hasInstallScript:true` → 属性 `s6:lock:hasInstallScript`（安装脚本是供应链风险面，仅标注，从不执行）。
- **覆盖范围显式标注**（`metadata.properties`）：`s6:lock:sourceFile/lockfileVersion/entryCount/componentCount`、`s6:repo:revision`（读 `.git/HEAD`→refs→`packed-refs`，**纯文件读取非 git 命令**，取不到写 `unknown`）、`s6:coverage:vendor=not-covered`、`s6:coverage:containerImage=not-covered`、`s6:coverage:vulnerabilityScan=not-performed`。
- **无效输入不悄悄成功**：JSON 损坏、lockfileVersion≠2/3、packages 缺失、根条目缺 name/version、键形态非法（非 `node_modules/` 前缀、裸 `@scope`、`a/b`）、键推导名与条目 `name` 不一致、version 缺失、license/integrity 类型不符 → 固定类别 `SbomError`，CLI 非零退出且**不写出目标文件**。锁条目未知字段一律忽略。
- **不做**（防过度工程化）：不产出 CycloneDX `dependencies` 依赖图段（列为残余）；不支持 workspace 键形态与 lockfileVersion 1（固定拒）；不做 hash/algo 以外的锁外信息推断。

## 3. 运行与验收（协调者执行）

```bash
npm run typecheck
node --test tests/s6-supply-chain.test.ts   # 或全量 npm test
node scripts/s6-supply-chain.ts --lock package-lock.json --out scratch/s6-sbom.cdx.json
```

验收判据：typecheck 0；测试全过；SBOM 为合法 JSON、`componentCount>0`、无凭空 `licenses`；`--out` 失败路径返回非零且无产物。真实锁首轮生成后抽查 purl/licenses 与锁一致。

**协调者最终验证记录（2026-10-22）**：10/10 单测通过（`/tmp/perimeter-s6-unit-v3.tap`），全仓 typecheck exit 0（`/tmp/perimeter-s5d-s6-typecheck-final.log`）；真实锁生成 126 个组件。最终 name-only 产物通过 CycloneDX 1.6 官方 schema（`docs/s6/evidence/schema-validation.json`；ajv 仅忽略未用 iri/idn 格式）。负控 `license:42` 保持运行时非法值，仅修双 cast 的映射层级；期间注释误含结束符造成语法错误，已修复，未放宽断言。Grok 独立只读复审 `approve`，详见 `docs/reviews/grok-s6-local-delivery-round-1.md`。原始 SBOM、两份审计报告、命令/退出码/锁哈希/工具版本已归档 `docs/s6/evidence/`。

## 4. 漏洞扫描：命令与落盘规范（执行方＝协调者）

本包脚本不联网、不产出漏洞结论；扫描需网络，由协调者在受控环境执行，规范见 `docs/operations/s6-runbook.md` §8：`npm audit --json`（全量）与 `npm audit --omit=dev --json`（仅运行时）两份原始 JSON 原样落盘，附 meta（UTC 时间、仓库 revision、lockfile sha256、npm 版本、命令原文）；扫描失败必须记 `scan_failed`，**不得写"无漏洞"**。

## 5. P0 证据索引（handoff §5.2 逐项；不是打勾）

状态口径：`local_verified`=有本机运行/测试证据；`partial`=有机制但存在具名缺口；`external_blocked`=被外部条件阻断。**S6 不标记企业放行**；公司试用仍被 soak/真实环境/客户具名批准阻断。

| §5.2 条目 | 状态 | 证据与具名缺口 |
|---|---|---|
| 可信身份 | partial | 本地：JWT 验签/JWKS/服务端组映射已实现并有测试（README、handoff S1）。外部：真实客户 IdP Authorization Code+PKCE/SAML 未接 **external_blocked** |
| 浏览器凭证 | partial | Cookie Secure/HttpOnly/SameSite=Strict+严格 Origin 已实现；CSRF token/double-cookie 未实现；长期 token 轮换为人工外部步骤 |
| 完整资源授权 | partial | 服务端授权+四眼角色已实现；§8 资源级负面用例矩阵未逐条落测 |
| 四眼审批 | partial | 独立 approver+防自批铁律有本地测试（README/S2 记录）；真实多人流程未演练 |
| 文件系统隔离 | partial | Docker RO 根/非 root/drop-ALL 本地已测；K8s 侧 sandbox.yaml 生成物 **external_blocked**（kubectl 未配置） |
| 保护路径/敏感读 | partial | S2 Slice A+Phase B 已实现并验证（commit `e162088`）。**保留缺口：clone/repoUrl 路径绕过既有挂载保护；空 init 的 `.git/config`/`.git/hooks` 可写；`Dockerfile.*`/`*.tf`/`*.tfvars`/`*.tf.json`/`.env.*` 未全覆盖；真实 Linux 未验**，其余按 S2 残余台账保留 |
| 可验证出口 | partial | NetworkPolicy/ConfigMap 生成+漂移守卫已有（未 apply）；真实 CNI 默认拒绝负面测试 **external_blocked** |
| SCM 最小权能 | partial | gitproxy 已实现；repo/ref 级细粒度授权与吊销未完整演练 |
| 出站 DLP/数据域 | partial | 生产默认 block+副作用前扫描+`redirect:"error"` 有测试；真实误报率未验；零留存/DPA **external_blocked** |
| 传输与入口 | partial | Host/Origin、Cookie、CSP/textContent 有测试锁定；mTLS/客户入口方案未做 |
| 审计与密钥 | partial | 哈希链+`AuditLog.verify` 入口已实现；外部锚定/WORM **external_blocked**；KMS/Secrets Manager 轮换 **external_blocked** |
| 数据与供应链 | partial | 本包离线 SBOM CLI **local_verified（本地）**：单测通过＋真实锁生成＋官方 schema 校验通过（typecheck exit 0）；**扫描已完成 local_verified**（协调者实跑 `npm audit --package-lock-only --ignore-scripts --json`，原始报告 `/tmp/perimeter-s6-npm-audit.json` 未改写）；**漏洞未修＝发布阻塞**：fast-uri 3.1.5（dev ajv 传递）5×high+1×moderate，fixAvailable true 未修锁（详见 §6.5）；backup/restore 已实现有测试但隔离目录演练未做；镜像 SBOM/发布签名/镜像扫描 **external_blocked**；加密/KMS 未做 |

补充 P0 相关：真实环境 soak **external_blocked**；真实成本/账单对账 **external_blocked**（S4 价格全 0，`reconcile()` 接口就位、外部对账源未接）；客户安全负责人具名批准 **external_blocked**（未获得）。

## 6. 残余与后续

1. SBOM 无 `dependencies` 依赖图段（若下游工具需要，另立小包，勿在本脚本叠加）。
2. lockfileVersion 1 / workspace 键形态不支持（固定拒，npm 现行默认不受影响）。
3. vendor/ 目录与容器镜像在任何 SBOM/扫描范围之外，需外部工具与镜像仓库配合。
4. 漏洞扫描与对账结论属协调者/运维步骤；本包不产漏洞结论，不据此放行任何版本。
5. **已知未修依赖发现（如实入账，发布阻塞项）**：协调者实跑 `npm audit --package-lock-only --ignore-scripts --json`（扫描已完成，原始报告 `/tmp/perimeter-s6-npm-audit.json` 未改写）。发现：fast-uri 3.1.5（isDirect=false，dev ajv→fast-uri 传递，不进生产运行时面），聚合 severity high，6 条 advisory——GHSA-5jgf-p345-68v8（host confusion/IDN，CWE-436）、GHSA-f65p-4m7j-42xc（SSRF/IPv6 归一化，CWE-20/918）、GHSA-fph4-wmhf-6fwf（SSRF/主机名重复解码，CWE-174/918）、GHSA-jqff-g426-hqxp（host confusion/百分号编码 scheme，CWE-177）、GHSA-qw65-cvwx-89v3（authority injection/未验端口，CWE-116），均 CVSS 7.5；GHSA-hrr3-gc8f-f4qj（moderate，主机名大小写归一化，CVSS 4.8）；影响范围聚合 3.0.0–3.1.7。`fixAvailable: true` 但**未修锁**（协调者决策，本包不动 `package-lock.json`）。**仅运行依赖扫描**：`npm audit --package-lock-only --ignore-scripts --omit=dev --json` exit 0、0 个发现（`docs/s6/evidence/npm-audit-prod.json`）。全依赖扫描 exit 1、1 high（`docs/s6/evidence/npm-audit-all.json`），生产依赖扫描无发现不消除开发供应链风险。
