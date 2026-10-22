# S2 敏感读/DLP/监督器三缺陷修复轮（s2-sensitive-read-dlp-followup；task_eb31faea55d8 / ctx_9c9b4512f835）

- 日期：2026-10-18。性质：R40 三处实质缺陷的最小实修 + 真因果负控（先语义红后绿）+ R40 遗漏 mail/自引 manifest
  等历史纠正（只追加，冻结件不回写）。执行者：Pi（原 coder terminal/model 复用）。
- 本轮与 R40 的关系：R40 的功能绿（590×2、probe 483ms/578ms 自然 exit0）保留；其安全证明口径收缩——
  **groupResidue=empty 不再采信**（对照查询推断被证伪）、监督器同代/强安全声明降级为 partial、
  path-guard stats:null 混同、DLP unicode 逃逸漏检三缺陷本轮修复。

## 0. 时序与遗漏 mail 纠正（历史不洗，如实入档）

- R40 结算前，coor 于 2026-10-18T12:43:27Z 成功 enqueue **msg_b44c665084fc**（晚于我已处理的 msg_70b8b4179113）；
  我未 check 到该消息便于 13:15:59Z 发出 worker_done，且报告称「唯一 followup 已闭合」——**该表述错误**。
  本 task 正文即该消息完整内容的转达；旧 ctx（ctx_f6ce85f360dc）已 settle，不在旧 ctx 继续收发。
- coor 复读 R40 sha256-root-manifest-r40.txt 发现：**末尾实际含
  `78d91d4318cdc6a8ef612ac67215a8820e14d9c4799a4989fb1a1979e9239ff7  sha256-root-manifest-r40.txt`** ——
  直接违背该清单头注「非自引用」与 R40 报告的非自引声明。根因：第二次生成清单时把第一次生成的清单文件
  自身也走了遍历（记录了旧版自身的哈希）。**该清单按控制失败处理；R40 root 冻结不回写**，本节即为历史
  纠正的追加位置。R40 root 实际 99 行（含注释/空行），「#files=95」与 94 条安全条目等口径混异一并作废。
- R40 RUN-RECORD #5 自述 debug-first-steps.mjs「手动无 runner」运行——这是 R40 声称
  「此后零 plain run」之后**真实新增的无外 deadline 诊断运行**，与口径矛盾，继续披露不删。
- R40 旧 probe 功能观察（summary.wallMs=482.961ms / runner 578ms / 自然 exit0）保留；
  其 groupResidue=empty 的**安全证明不采信**（本轮证实推断链不成立）。
- r40 root 内 base/patched/out 为既有重建/编译产物，本轮只读复制未触；无 SDK 重建。

## 1. 修复 1：path-guard helper statOf fail-closed（src/runtime/path-guard.ts）

- **缺陷**：statOf 对 lstat 一切异常 catch→null；realpath 成功（目标真实存在）后的 stat 权限/竞态异常
  被折叠成 `ok+stats:null`，与「目标不存在（回溯）」混同 → 硬链接检查被静默跳过。
- **修复**：realpath 成功路径上 lstat 异常一律按白名单类别 fail-closed（EACCES→permission_denied、
  竞态 ENOENT→not_found、ELOOP→not_supported、其它→unknown）；`stats:null` 只来自真实不存在目标的
  祖先回溯分支。
- **红证据（真实因果，非 TypeError/setup）**：注入缝=仅对 victim-* 文件名抛 fs 异常的 helper 变体
  （与测试同缝）；对 R40 旧实现按其在案文档逐字重建执行（git index 无 path-guard.ts——该文件 R40 新增、
  staged 版早于 stats，故为重建式红，已在本轮 evidence root RED-EVIDENCE-statOf.md 留档）：
  实测 EACCES/ENOENT 均 `ok:true,stats:null`（旧码语义红成立）。修复后同断言绿。
- 保留控制：symlink/ELOOP、sessionPin G1、协议白名单（stats 形状非法→invalid）、byte 4096/4097/9000
  全部原样（本轮 path-guard 32/32 绿）。

## 2. 修复 2：modelgw 完整 body 语义解码扫描（src/modelgw/server.ts、secrets.ts）

- **缺陷**：仅裸文本扫描（R40 只给 credential-assignment 加了反斜线字符类）；`\uXXXX` 逐字节逃逸对裸扫描
  不可见而上游 JSON 解码后收到明文 secret。
- **修复**：读入 Buffer → `decodeStrictUtf8`（fatal，有损替换序列直接拒）→ raw 扫描（保留）+
  `scanJsonDecoded`（JSON.parse 后有界遍历**全部 key 与 string value**：深度≤64、节点≤8192，超限
  fail-closed；key/value 各自独立扫描、**不拼接不跨字段误拼**防误报）。非法 JSON/非法 UTF-8/嵌套超限
  → 403；扫描器抛错或**非法返回**（null/非数组/未知 kind/超长或非串 hint）→ 503（`validateFindings`
  对注入实现与默认实现同一把尺，kind 必须 ∈ KNOWN_KINDS）。全部发生在任何换 token/fetch 之前。
  上游收到的 body 仍逐字节透传（语义扫描不改写）。
- **红证据（真实因果）**：red-run-r41（合规外监督 outer-supervise.mjs，见 §4）实测 6 条新负控全红：
  unicode 逃逸赋值/逃逸独立 token（当前 200 且上游收到）/非法 JSON（200 透传）/非法 UTF-8（200）/
  200 层深嵌套（200）/扫描器非法返回五形态（放行）。修复后全绿。
- 保留：正常 body 逐字节透明、显式获批 audit 语义、TP/commitSHA/base64/UUID 对照、双模式 scan-failure 拒、
  GCP 换 token 与上游 fetch `redirect:"error"` 真负控（本轮全部绿）。
  **边界如实**：可信收费归属（B7）仍 partial；DLP 机制≠企业合规（真实误报率/DPA/零留存 external）。

## 3. 修复 3：bounded-test-runner 严格 deadline 时序（scripts/bounded-test-runner.ts）

- **本轮证实并修复的缺陷**（对应 coor 列举）：
  1. `groupEmpty()` ps -g 失败后用「ps 自身可用」推断空组——推断不成立，已废：**空组正证只有
     「ps -g 查询成功且无成员」**，失败一律 unknown；
  2. getGroupPids 无 timeout / getProcInfo 固定 3s / 启动 5 重试 / cleanup ps 不受 remaining →
     全部 ps 观察统一 `timeout=floor(min(3000, 剩余))`，剩余 ≤0 零 spawn；
  3. childExitedConfirmed 后「重新枚举成员 PGID 匹配=同代」已删除——**leader 已退出的组零信号 +
     residue=unknown**（重新枚举不构成同代证明；PID/PGID 复用者不可冒杀）；
  4. expectedBirth 缺失时 PGID 匹配即 verified → 现在**同代三正证（PGID+birth+PPID=本runner）缺一不可**；
  5. isPidAlive fallback 对已 close 的疑似复用 PID 下手 → 单发 fallback 必须**身份正证（birth 匹配+PPID=
     本runner）且未 settled**；close 之后的 PID 一律不再触碰；
  6. timer 在 close 后即清而 final cleanup/log 未完 → 收尾次序改为：结算→最后 onLog IO→**新鲜预算
     check（green->red sticky，超预算翻 124 不回绿）**→runnerWall 采样→才 clear 两个预挂 timer；
  7. 超时后额外 4s cleanup+5s wait 越窗 → 总 deadline（timeoutMs）预挂于 spawn 前，target deadline=
     总-预留；TERM→grace→KILL→真 wait 全部有界于总 deadline 内；耗尽仍未退出=**unproven_unknown
     （exit 124 + settlement=unproven_unknown）**，不赠予时间、不无限等待、绝不 process.exit(0) 伪 settle；
  8. nodeExitWall 实为 close(含 stdio) → 新增 **actualExitWallMs（exit 事件）**，closeWallMs（nodeExitWallMs
     为兼容别名）、runnerWallMs（最终采样，标注 runner_observed 非 OS exit wall）三 wall 分开。
  9. KILL 升级不再二次 ps 复验：直接子进程未被本 runner reap 前内核保证 PID/PGID 不复用（持有 wait 句柄），
     TERM 时刻的同代三正证继续锚定；短 deadline 下二次 ps 反而吃光预算导致该杀不杀（本轮实测教训入码注）。
- **红证据**：red-run-r41/red-run2-r41（外监督=本轮 owned root 的 outer-supervise.mjs，单调预挂 deadline/
  scoped ps 正验证 birth/零全局扫描，非被测 runner 自证）：orphan 新契约、birth 缺失零信号、
  childExitedConfirmed 零信号、预算 0 零信号零 spawn、无辜 PID 不杀、sticky red、exit/close wall 字段、
  residue=unknown 等全部先红后绿。**待测 bug runner 未自证**。
- 旧测试契约更新（允许范围）：「leader 退出后彻底清理孤儿」→「无正证不杀/unknown + 测试以自身登记身份
  自清理（验证死后不留残留）」；R40 的 `groupEmpty(gone)===true` 断言改为 `null`；
  `groupResidue==="empty"` 断言改 `unknown`。无删测试、无 skip、无负控弱化。
- 顶部强断言（「完整生命周期收割/彻底清空」）改为诚实 partial 表述；CLI 输出附
  target_exit/close/settlement/kill/residue/overBudget/actualExitWall/closeWall/runnerWall 真实状态。

## 4. 本轮验证台账（全部真实 exit / 真实 wall；一次一个独占，前次 true wait 后才下一次）

| # | 验证 | 监督 | 结果 |
|---|---|---|---|
| 1 | 红跑 1（pg/mgw/runner 三文件，旧码） | outer-supervise.mjs（300s 预挂） | exit 1，20 语义红（73 pass） |
| 2 | 红跑 2（runner 更新后复验 orphan 契约） | outer-supervise.mjs（120s） | exit 1（orphan 等红） |
| 3 | target：bounded-runner（修后） | 修后 runner CLI | 19/19，exit 0 |
| 4 | target：path-guard+modelgw（修后） | 修后 runner CLI | 74/74，exit 0 |
| 5 | 全量并行 test:bounded | 修后 runner | **608/608，0 fail/cancelled/skipped/todo**，129.8s，exit 0 |
| 6 | 全量串行 test:serial | 修后 runner | **608/608，0 fail/cancelled/skipped/todo**，246.0s，exit 0 |
| 7 | typecheck | — | 过，exit 0 |
| 8 | repro（r41 root） | 修后 runner 45s | 8/8 SAME，exit 0 自然（actualExitWall 1375ms） |
| 9 | probe r41（4782c07d 直复制未再改） | 修后 runner 30s | **exit 0 自然 pass**：actualExitWall 609.7ms、summary.wallMs=522.697ms、children=10、cleanup all-settled、**residue=unknown（诚实）** |

608 = 590 基线 + 18 新增/更新。旧 R39 37 oracle / SDK5 / 旧 negative pin 未重跑（与本轮修复面无关，按指示跳过）。

## 5. 偏差披露（原样保留；历史不洗）

1. **本轮新增 1 次 plain `node --test`（无外 deadline）**：用于读 sticky-red 测试失败详情（在该套件已经
   bounded 绿/红判定之后）；与前轮 R40 的 5 次同类；此后停止。R40 的 RUN-RECORD #5 无界运行矛盾见 §0。
2. 本轮文件装配过程中产生过一次错误中间态（runner 文件重复定义），由 typecheck 捕获后立即以完整重写修复；
   中间态未运行任何测试，无影响面。误建空文件 scripts/bounded-test-runner.ts.bak 已删（自建 scratch，非证据）。
   /tmp/runner-{head,core,cli-tail}.txt 为装配 scratch，保留在盘。
3. 红 run #1 中 path-guard 三测当时因夹具错误（未传 victim 路径）失败，**该三测的红不算语义红**；真正的
   语义红以 §1 的重建式 RED-EVIDENCE-statOf.md 为准（判定链已核对）。
4. 历史（R40 及更早）偏差：4 次裸 python3 heredoc、5 次 plain node --test、r40 root tee 覆盖首 run 日志、
   实现-先于-红跑、R40 manifest 自引——全部保留不洗，纠正仅以追加方式记录于本文档。

## 6. 边界与未完成（不勾完）

- **S2 维持 partial**：B2（gitproxy scoped session/repo/ref/rw grant）未实现（下一批，待 Grok 动态复审本轮后）；
  强 OS 隔离=deployment-boundary 仍为 B12 外部验证条件（进程内纵深≠OS 边界；bash 盲区/TOCTOU 竞态如实保留）；
  B3 DLP≠企业合规；真实 DPA/零留存/客户批准 external blocked；G1 全 3s/G3 不变；B7 收费归属 partial。
- 监督器：硬 timeout 的物理保证不存在（内核终止时延未静态证明）；residue 在不枚举成员的纪律下只能 unknown；
  旧 root/旧报告中已写空的 empty/zero-residue 表述不改写（以本文档口径收缩为准）。
- 54m57s 旧 node 生命周期 unknown 原样保留；legacy 资源零清理；无全局 ps/pgrep/未知 kill。
- 无 commit/push/reset/stash/clean；不动依赖锁/vendor/installer；不触外部 pi-mono/paseo。

## 7. 证据与足迹（本任务）

- 本轮 owned root：`/tmp/perimeter-r41-lI6S3wun6uyI`（0700）——outer-supervise.mjs、RED-EVIDENCE-statOf.md、
  path-guard.r40-index.ts（git show 只读导出，实为 staged 旧版，无 statOf）、repro/probe 复制件与运行日志、
  evidence/（repro+probe 产物）、provenance-r41.jsonl。**清单（sha256-root-manifest-r41.txt）在全部文件定稿后
  一次性生成：排除清单自身与 node_modules 只读 symlink，覆盖其余全部 regular file，条目数=精确文件数；
  清单自身 sha256 只记录于本文档与 worker_done（绝不 append 回清单）**。
- 冻结未触：/tmp/perimeter-r40-PRkN05B3Td1q（含其自引 manifest，按 §0 处理）、/tmp/grok-s2-teardown-r38-dCQxnm、
  /tmp/grok-s2-teardown-r39-kVbTLg、全部旧 root/报告/§18.3/§18.4。
- repo 改动（本任务实际新改）：src/runtime/path-guard.ts、src/modelgw/secrets.ts、src/modelgw/server.ts、
  scripts/bounded-test-runner.ts、tests/bounded-runner.test.ts、tests/path-guard-exec-helper.test.ts、
  tests/modelgw.test.ts、docs/implementation/s2-sensitive-read-dlp-followup.md（本文件）、
  docs/implementation-progress.json（追加）。

## 8. r41 清单定稿（生成一次；自身摘要外记）

- `/tmp/perimeter-r41-lI6S3wun6uyI/sha256-root-manifest-r41.txt`：**95 条 regular file**（含逐条 mode/uid），
  排除清单自身与全部 symlink（node_modules 只读 symlink ×3 明示），生成后不再重写；
  自检无自身哈希行（R40 自引失败不再重犯）。
- **清单自身 sha256（只记于此与 worker_done，不入清单）**：
  `e63af6e6fac7a659e17f93a62efa1cc2cb73ff7967cf51fd2e6081cab056cf16`
- R40 root 冻结复核：本轮零写入（含其自引 manifest，按 §0 作为历史控制失败保留）。
