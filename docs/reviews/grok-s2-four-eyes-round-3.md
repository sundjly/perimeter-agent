# Grok S2 四眼审批第三审（standalone 门槛补验）

- 结论：`approve`（限定四眼 standalone 门槛补验：三次全新 OS 进程（冷单场景 + 两轮全场景）三场景全过、握手有界、资源账实相符，R2 的 unverified 门槛关闭；`s2-four-eyes` 按实证恢复 implemented。真实模型/CNI/客户批准仍 external，企业生产不批准）
- **【R3 最小更正，2026-10-15】** 协调者未接受本轮 approve：无条件 preflight 仍有预热、`process.exit` 不构成自然退出、cleanup 吞错不得豁免为探针可接受。三项已由 Pi 在探针改造（`b25db1168d08b714`）中修复，并经 `grok-s2-four-eyes-round-4.md` 第四审按原 oracle 独立复验通过；本轮结论由该轮与 R2 纠正节取代。
- 日期：2026-10-15
- 审查者：grok（唯一 reviewer）
- 对象：`scripts/probes/four-eyes-standalone.ts` `8389119b2c3d5ebd`（Pi 新增探针，产品代码零改动——本轮 diff 复核仅新增探针与文档）与 `docs/implementation/s2-four-eyes-standalone.md`。基线是 `docs/reviews/grok-s2-four-eyes-round-2.md`。
- 允许写入：`docs/reviews/grok-s2-four-eyes-round-3.md`、`docs/reviews/grok-s2-four-eyes-round-2.md`（最小更正）与 `docs/reviews/handoff-coverage.json`。未改实现、测试、其它 docs、SDK，未 commit / push / spawn 新 worker。

## 执行口径纠正确认（对 R2/round-3 补验节的落实）

- R2 报告中「435 = 427+8 为当前实际总数」「Pi 439 属口径混算不复现」「s2-four-eyes partial → implemented（本包升格）」三处过时断言已标注**撤回**（见 R2 文件内【已撤回】标记）：435 的原始日志在收尾清理中已删除、无法重构；新鲜实测 serial 与 bounded 均 **439/439/0**（runId `r20-serial`/`r20-bounded`，日志 `/tmp/r20-serial.log`、`/tmp/r20-bounded.log`，外层 bounded runner 1700s、内层 1500s）。
- r20 的 439×2 作为**历史证据保留**（本轮无产品改动，不重跑全量）；本轮新鲜证据为下述 standalone 探针与四眼专项直跑。

## 独立 standalone 门槛复验（我的三次全新 OS 进程）

| 运行 | 命令 | preflight 握手 | ng | git | ctx | exit | 墙钟 | labeled 容器（后） |
|---|---|---|---|---|---|---|---|---|
| 冷单场景 | `bounded(180s) → probe --scenario ng` | 169ms | pass 508ms | — | — | 0 自然 | ~1.1s | 3（=历史 3，own 已清） |
| 全场景 1 | `bounded(180s) → probe --scenario all` | 178ms | pass | pass | pass | 0 自然 | ~2.9s | 3 |
| 全场景 2 | `bounded(180s) → probe --scenario all` | 186ms | pass | pass | pass | 0 自然 | ~2.9s | 3 |

- **冷证据**：单场景首跑的 preflight 握手 169ms 即为该进程首个容器握手测量——有界、无挂起；ng 场景（git-less fail-closed）508ms 通过。
- 三场景 oracle 与 R1/R2 一致：ng = `policy.denied`（上下文不可靠）+ 零 approval 事件 + marker 不写 + 审计无 allow；git = 临时 git 真实 HEAD + 独立 B（不同 subject）allow → marker 落盘 + 审计 `approval.decision allow`（actor/approver 逐一断言）；ctx = request 后删 `.git` → decide 拒（审批意图上下文已失效）+ marker 不写。
- 每轮后 labeled 容器实测回落 3（历史保留，own 清理账实相符——不以 manifest 声明代实际核验）；无 `node --test`/mock-model 残留。
- R1 六条与 R2 残留的既有结论（跨凭证自批、角色矩阵、撤权联动、审计故障 reopen、args 变更拒）未被推翻：439×2 全量与四眼 12/12 直跑均绿。

## 对 Pi 探针的保留意见（记录，不阻塞本包）

1. `--scenario all` 下 preflight 在三场景前**无条件**创建同镜像环境（虽然注释称不预热判定）——会轻度预热 daemon/镜像，使「冷」不完全纯。缓解证据：单场景冷跑的 preflight 握手 169ms 有界，且 R1 的挂起形态是 240s 零事件而非慢。建议 Pi 后续给 preflight 加 `--no-preflight` 开关。
2. `main` 末 `process.exit(allPassed?0:1)`、preflight 失败 `exit(2)`、catch `exit(1)`：探针级可接受（每场景子进程在各自 finally 关闭、phase 逐段落盘、外层 bounded 为兜底死线），但若场景 finally 里的同步 `execFileSync docker rm -f` 遇 daemon 停摆会无限挂起，只能靠外层死线——记录为探针鲁棒性待改进。
3. cleanup 的 catch 吞错 + manifest 仅记全局 remaining：以我每轮后的实际 `docker ps` 计数核验（=3 历史），账实相符；「manifest 声明」未被单独采信。
4. 产品侧 `openEnvironment` 的 `Connection.info()` 握手无超时是唯一能产生 R1 挂起形态的无界 await（Pi 定位）；本轮三次冷进程未复现挂起，按证据纪律记为 unknown 假说 + 加固建议（给握手加有界超时），不作为已证产品缺陷。

## 台账与边界

- `s2-four-eyes`：`partial` → `implemented`（恢复并维持；R1 缺口闭合 + standalone 门槛三轮独立通过）。
- S2 其余 DLP/repo-token/敏感路径/symlink/本地 egress 保持 missing/partial；真实 CNI/客户批准 external；S3/S4 按依赖；企业生产不批准。
- 历史资源：3 个 13:56–14:01 的 owned 遗留容器登记保留未动（与 Pi §6 台账一致）。
