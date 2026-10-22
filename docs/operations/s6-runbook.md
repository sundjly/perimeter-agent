# S6 运维 Runbook（本机可执行口径）

- 日期：2026-10-22；依据：`docs/handoff.md` §3.1/§3.3/§9 与 `package.json` 实际入口。**本文不构成企业放行**（真实 CNI/IdP/KMS/DPA/WORM/soak/真实成本/客户具名批准均未闭环）。
- 标记约定：【已实现】＝本仓已有代码入口与测试，命令可直接执行；【人工】＝外部/运维手工步骤，本仓没有自动化，不得用文档勾选冒充完成。

## 0. 入口速查（均为 package.json 实际脚本）

| 目的 | 命令 |
|---|---|
| 启动网关 / 模型网关 / git 代理 | `npm run gateway` / `npm run modelgw` / `npm run gitproxy` |
| 演示（零凭据，mock 模型走真实网关链路） | `npm run demo`（真实模型：`PERIMETER_DEMO_REAL=1`，需 `PERIMETER_MODEL_GATEWAY_URL`、`PERIMETER_MODEL_PROXY_TOKEN`、`PERIMETER_MODEL`） |
| 连接会话冒烟 | `npm run attach -- --session <id> --url http://127.0.0.1:8787 --token demo-token --actor demo@local`（生产用 `--bearer <jwt>`） |
| 全量测试 / 类型检查 | `npm run test:bounded` / `npm run typecheck` |
| 策略生成物再生成（含漂移守卫） | `npm run gen:deploy` |
| 备份 / 恢复 | `npm run backup` / `npm run restore`（见 §4） |
| SIEM 导出 | `npm run export:siem` |
| SBOM 生成（S6） | `node scripts/s6-supply-chain.ts --lock package-lock.json --out <file>`（见 §8） |

## 1. 审计或磁盘故障【已实现边界 + 人工处置】

- 【已实现】网关侧行为：清理失败不中断后续清理；审计唯一写入者是网关；SIEM 导出走 `npm run export:siem`（白名单字段）。
- 【人工】按 §9 纪律：停止新任务与高风险批准（保留 abort/deny/清理）；**不删审计文件腾磁盘**；扩容/清理由运维执行；恢复写入后核对链头再放流量。核对入口：`AuditLog.verify(path, expectedHead)` 已留 API（`src/audit/log.ts`），无现成 CLI——【人工】写一次性脚本或由协调者补验证入口。
- 【人工】磁盘判满：`df -h <stateRoot>`；审计文件路径以部署配置为准（backup 时经 `--audit-file` 显式给出）。

## 2. 服务就绪与独占锁【已实现】

- 【已实现】stateRoot 单实例独占：第二实例启动失败是**预期行为**，不是故障。锁判读原语 `src/gateway/state-lock.ts`（backup/restore 复用同一判定）：`live`（本机活进程）/`foreign-host`（他机锁）/`unparseable`（不可解析）→ 一律拒绝；仅 `stale`（持有进程已死的崩溃残留）放行并在 manifest 注明。
- 【已实现】ready 前网关自检策略/凭据/模型目录/stateRoot 可写（stateRoot 下的 `.readyz-probe-*` 瞬态探针文件；backup 已排除）。liveness 不依赖模型厂商。
- 【人工】双实例疑议时：先确认持锁进程是否存活（进程身份在锁文件内），再决定停哪台；**不得按心跳过期抢活锁**。

## 3. 未知副作用与预算【已实现接口 + 人工对账】

- 【已实现】unsafe 工具执行意图已落盘的，崩溃恢复为 `interrupted`，**可能已有部分副作用**：不自动重放；操作者查看 callId、意图 hash、工作区 diff 后人工确认。git push 恢复先查远端 ref/commit，不"再推一次"。
- 【已实现】模型预算账本（`src/modelgw/budget-ledger.ts`，WAL+FULL，`BEGIN IMMEDIATE` 原子预留）：上游 4xx→release；5xx/2xx 无 usage/我方中止→`usage_unknown`（保留预留，不写 0，不自动重试）；启动时崩溃残留 reserved 标 `usage_unknown`；`strictBudget=true` 缺 `ledgerFile` 启动即炸。
- 【人工】`usage_unknown` 释放：`reconcile()` 接口已就位但外部对账源未接——拿供应商账单/usage 人工对账后调用释放；一个账本文件只允许一个网关进程写。

## 4. 备份与恢复【已实现，前提＝网关已停止】

```bash
# 备份（活锁/他机锁/不可解析锁固定拒；陈旧锁放行并注明）
npm run backup -- --state-root <dir> --workspace-root <dir> --out <备份根> [--audit-file <审计文件>]
# 恢复（只进"新的、空的隔离目录"，绝不覆盖既有状态）
npm run restore -- --backup <backup-<时间戳>> --state-root <新空目录> --workspace-root <新空目录> [--audit-file <out>] [--report <file>]
```

- 产物：`state/`（SQLite 经 `VACUUM INTO` 单文件自洽，双侧 integrity_check+行数比对）、`workspaces/`、`audit/<文件>`（给了 `--audit-file` 才有）、`manifest.json`（sha256+大小+每会话 git HEAD/未提交改动/收据数，最后写）。`gateway.lock` 与 `.homes`（沙箱 HOME，内含 git 代理凭据）**不入备份**；凭据由网关在会话启动时重写。
- 恢复报告解读：`unpushed`（未推送提交数）、dirty（未提交改动，**原样保留，绝不 reset/checkout**）、`outcome_unknown`/非终态收据、`pendingApprovals`——审计未随备份时审批状态如实标 `unknown`（不虚构）。
- 【人工】恢复后先在隔离目录核对报告与抽查文件，再切流量；不得把 metadata 空缺当新 owner（corrupt/quarantined 交运维处理）。

## 5. 凭据轮换【人工为主】

- 范围：模型 key（含 `PERIMETER_MODEL_SCOPED_KEY`，hex/base64 且 ≥32 字节）、git 代理 token、浏览器 token、CLI 凭证。配置都在部署/环境侧，本仓无密钥管理实现——【人工】在 Secrets Manager/KMS 或客户等效方案轮换，**不写仓库/产物/日志**。
- 泄露处置（§9）：隔离入口与沙箱 → 吊销服务与客户端凭证 → 轮换 Git/模型 key → 定位日志/备份/产物暴露面 → 恢复前重跑出口/身份负面测试；**不把泄露的 secret 发给模型排查**。
- 【已实现】scoped token 校验：归属只取自 HMAC 签名（aud/tenant/team/sessionId/exp/jti），静态 token 只归 `defaultTeam`；签名密钥不进沙箱、客户端事件与审计。

## 6. 发布回滚【人工纪律 + 已实现生成物】

- 【人工】发布前记录：镜像 digest、依赖锁（`package-lock.json`）、policy/schema/价格版本；先备份（§4）并 canary。
- 【人工】schema 不向后兼容时：恢复整套一致备份或前向修复，**不是只换旧镜像**；回滚不得放宽授权/出口/审批。
- 【已实现】policy.yaml 变更后 `npm run gen:deploy` 再生成 NetworkPolicy/ConfigMap（两侧均有漂移守卫）；egress 是部署承诺，生成物没有 apply——apply 与真实出口验证在部署侧（真实 CNI 仍未验证）。

## 7. 资源回收边界【已实现语义 + 人工红线】

- 【人工红线】只按稳定 deployment/session label 回收；**不得按模糊名称删除其他租户资源**。
- 【已实现】沙箱容器 `--rm` 收尾、临时目录 finally 清理；会话空闲关闭时关闭 attachment（网页自动重连）；Pod 工作区是 emptyDir——删 Pod 丢未推送改动（PVC 未做），回收前先查备份报告里的 unpushed/dirty。
- 【人工】备份产物按保留策略清理；活跃 stateRoot 内的 sqlite/审计文件一律不手删，停机后走 backup/restore 通道。

## 8. SBOM 与漏洞扫描（S6）

- SBOM 生成【已实现，离线零子进程】：

```bash
mkdir -p scratch
s6_stamp=$(date -u +%Y%m%dT%H%M%SZ)
node scripts/s6-supply-chain.ts --lock package-lock.json --out "scratch/s6-sbom-${s6_stamp}.cdx.json"
```

  产物为 CycloneDX 1.6 JSON；licenses 仅在锁有证据时写；覆盖范围（vendor/镜像/扫描不在内）与仓库 revision 见其 `metadata.properties`。
- 漏洞扫描【人工/协调者执行，需网络；本包脚本不联网、不产漏洞结论】：

```bash
mkdir -p scratch
s6_scan_stamp=$(date -u +%Y%m%dT%H%M%SZ)
sha256sum package-lock.json > "scratch/npm-audit-${s6_scan_stamp}.locksum" # macOS 可用 shasum -a 256
npm --version >> "scratch/npm-audit-${s6_scan_stamp}.locksum"
npm audit --package-lock-only --ignore-scripts --json > "scratch/npm-audit-${s6_scan_stamp}-all.json" # 含 dev
npm audit --package-lock-only --ignore-scripts --omit=dev --json > "scratch/npm-audit-${s6_scan_stamp}-prod.json"
```

- 落盘规范：原始 JSON **原样落盘不编辑**；同目录 meta 记录 UTC 时间、仓库 revision（与 SBOM `s6:repo:revision` 同源）、lockfile sha256、npm 版本、命令原文；结论另写摘要并区分"扫描器报出"与"已核实可利用"；扫描失败/网络不通必须记 `scan_failed`，**不得写"无漏洞"**。
- 范围边界：vendor/ 目录与容器镜像不在 npm SBOM/audit 覆盖内（镜像 SBOM/镜像扫描需外部工具，external_blocked）。
- 当前两份实际扫描及退出码/命令/锁哈希已归档 `docs/s6/evidence/`：全依赖 1 high（exit 1）；仅生产依赖 0 个发现（exit 0）。这是注册表扫描范围内的结果，vendor/镜像仍未覆盖。
- 当前已知未修发现：fast-uri 3.1.5（dev ajv 传递）5×high+1×moderate，fixAvailable true 未修锁——**扫描已完成 ≠ 已修复，属发布阻塞项**；记账与 GHSA 细节见 `docs/implementation/s6-local-delivery.md` §6.5。

## 9. 已实现接口 vs 人工外部步骤（总表）

| 已实现（可直接执行/有测试） | 人工外部（未自动化，不得冒充完成） |
|---|---|
| backup/restore 全流程与校验、state-lock 判读、预算账本与 usage_unknown 记账、审计哈希链+verify API、SIEM 导出、gen:deploy 生成物、SBOM 生成 | 真实集群/CNI 出口验证、IdP 接入与凭证轮换、KMS/WORM/外部审计锚定、DPA 与零留存合同、隔离目录恢复演练、漏洞扫描执行与结论、发布 canary/回滚决策、资源回收审批、soak、成本对账、客户安全负责人具名批准 |
