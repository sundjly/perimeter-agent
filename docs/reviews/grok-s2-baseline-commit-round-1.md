# S2 基线提交复审第 1 轮

- 日期：2026-10-21。只读复审，未运行任何测试/进程。基线 HEAD b90e2ca，候选树=HEAD+72 文件（协调者 write-tree ee195f96…，隔离导出 typecheck 0 / 798 测试全绿，本轮未复跑）。
- 对象：s2b-code.diff（46 文件，+13837/−186）；vendor/pi-env 23 文件按约定只核 manifest/pin/哈希；src/modelgw 3 文件按长期约定只核哈希未读内容。

## 结论：request_changes（仅 1 项必修）

基线内容本身干净：无 WIP/调试残留、无被注释的安全检查、无硬编码凭据、无真实外网地址；与已提交代码（S1/B2/S3a–S3d）双向接线互补、无冲突无回退；bounded-runner.test 改动合规且不放宽守护性质；vendor pin/哈希全部一致。唯一必修是 S3c 轮遗留条件的半个未闭合项（见 R-S2B-1）。

## R-S2B-1（必修）：beforeTool 审计门落地但无 e2e 测试

S3c round-1（docs/reviews/grok-s3c-crash-side-effects-round-1.md）的 MAIN TRACKED OBSERVATION 原文要求：两道 beforeTool audit-unavailable 门"must land with the S2 stream **with an e2e test**"。本次基线即该落地，现状：

- 门已落地并接线：perimeter-extension.ts:85（审批前）与 :162（审批后执行前），harness-host.ts:106 `auditHealthy: () => opts.audit.healthy` ✓。
- 注入脚手架已落地：tests/fixtures/gateway-process.ts:6–16 的 PERIMETER_TEST_AUDIT_BREAK_MARKER ✓。
- **消费方仍为零**：全仓 grep 无任何测试设置该 env、无任何测试传入 `auditHealthy`、无任何断言 `rule:"audit-unavailable"`（crash-side-effects S3c-2 只覆盖 prompt 级门与 readyz，不经 beforeTool）。

修法（仅测试侧，无产品码改动）：新增一个消费 marker 的 e2e（或直接单测两道门），断言固定类别 deny 与 abort/deny 不受影响。若协调者明确决定先落基线、测试随下一轮补，请在提交信息与本报告追加记录中显式声明该边界（S3c 轮同时要求 commit message 声明边界）。

## (1) 残留扫描（+13837 行全量 grep）

- TODO/FIXME/XXX/HACK/debugger：0。console.log 命中均为 CLI/探针/benchmark 报告的正常输出路径。
- 疑似"注释掉的检查"逐条核过：全部是解释性注释（deny 优先级、只读豁免取舍、进程内纵深边界等），无被禁用的守卫。
- 凭据：仅 modelgw.test.ts / redteam.test.ts 的 DLP 夹具（`{{API_KEY_*}}`/`{{SECRET_*}}` 模板占位、AWS 文档示例 AKIA、无密钥体 PEM 头）——HEAD 已有同类（HEAD modelgw 8 处、redteam 1 处），无新增真实密钥。
- 外网地址：仅测试夹具虚构域（idp.corp.local / console.corp.local / evil.* attacker.*）与 host.docker.internal（容器→宿主内部 DNS）；无真实外部端点、无遥测/回连。

## (2) 与已提交代码的冲突/回退：无

双向核验：

- HEAD session.ts:148–151 已预置 guardEnv/getContext/getPrincipal/isProduction 传参，基线 harness-host 恰好补齐这四个选项——HEAD 独立 16 个 typecheck 错误即源于此类"提交侧先引用未提交符号"。
- HEAD server.ts:17 已 import `safeDockerCmd`，:534/:535 调 `verifyDockerNetworkInternal`+`bindVerifiedNetwork`——基线 execution-backend.ts:135 提供实现。
- 方向全部为加固：audit-unavailable 双门、B1 deny_reads、docker extraArgs 九类安全校验+opts 冻结、pinned guard env 拒绝回退 unpinned。policy/engine 的 deny_paths 写面语义与审批疲劳取舍保持不变。
- 记忆中 round-8 的 execution-backend Docker socket 硬编码已消除（dockerClientEnv 仅透传 DOCKER_CLIENT_KEYS）。

## (3) bounded-runner.test.ts（本轮唯一新代码）：合规

- 冻结 runner 哈希未变：sha256(scripts/bounded-test-runner.ts)=6f4e2b0f034f… ✓。
- 例4（:115）：模板串 `'READY\\n'` 转义修复（根因注释如实），断言只增不减（READY 前置证据 + actualSignal=SIGKILL + targetExitProven），TOTAL=4000 的保留理由（R47 RESERVE 下 900→target 50ms 竞态）已注明。
- 例32/36/44（:712/:765/:892）：`runBoundedFakeDeps` 同锚假钟调度器——timer 与 child exit/close 事件全部在 deps.sleep 推进的假钟上派发，与冻结契约"等待由 deps.sleep 有界循环驱动、可全 fake"一致；语义保持：overBudget sticky red、自然退出零信号、finalizeIO snapshot 填真实结算值。
- 例45（:907）："零信号"改"精确单发 direct TERM"符合冻结语义，经代码核实：cleanupProcessGroup 中 TERM 扳机先于"SIGTERM 已发"onLog，onLog 为裸调用，异常→runBounded catch→stickyFail→finally 清双 timer→reject，KILL 升级被跳过——deepEqual(`["777007:SIGTERM"]`) 是对冻结行为的精确刻画且严于旧断言（另断言零 KILL 补杀）。非恒真：direct fallback 路径经 fake procInfo 的共享 PGID 规则推导（runnerPgid===childPgid→safe=false），身份四正证仍必经。

## (4) vendor manifest/pin：一致

- pin：current 与 previous manifest `base.head` 均为 cdaf6c227（cdaf6c227d4718a72b59ccd02152c9614df44cfc 短形）；8efd314f 仅出现在 build.mjs 注释中作为"禁止替代 pin 的漂移示例"。
- 哈希：dist 4 文件==manifest.files[].patched，original 4 文件==[].original，patch/env-session-pin.patch sha256==manifest.patchFileSha256（aac1576e…），全部逐字节复算一致。
- build.mjs 预校验链完整：pin 与 manifest.sourceBaseHashes 比对、patch 哈希比对、patched 源=base+git apply（不读工作树）、drift 即停。

## (5) 高风险面抽查

- path-guard.ts（新 242 行）：fail-closed 全程——stdout 严格协议（4 字段/2 字段形状、4096 字节上限按 UTF-8 计）、错误类别白名单、R41 的 lstat 异常不折叠 null、远端强制 pinned+缓存 home、绝不猜宿主路径=容器路径、边界披露如实（Pod unknown、setsid 逃逸、30s 静默窗）。
- perimeter-extension beforeTool：审计门先于一切落账与策略判定；canonical 与词法两判定取更严（rank 比较）；nlink>1 常规文件保守拒；获批后新阶段漂移复检+审批后第二道审计门；能力缺失生产 fail-closed、demo 留审计痕迹。
- execution-backend：root/host 网络/cap-add/--user root/pid-ipc-uts-userns host/只读根关闭/security-opt 削弱/自定义挂载/--name 九类拒绝；safeDockerCmd detached+组杀+TERM→KILL 升级。
- policy/engine：deny_reads 仅作用于 read_only_tools 名单带 path 调用，deny 优先级不变，require_approval 面不扩大；config/policy.yaml 与 deploy/policy-configmap.yaml 同步一致。
- approvals（+354）：四眼上下文绑定含 gitRevision/policyHash 零值占位拒绝、aclVersion≥1；生产上下文不可靠拒不发起审批。

## 核对范围声明

实际逐行/逐 hunk 核对：bounded-runner.test.ts 五例及其依赖的 runner 语义段（cleanupProcessGroup/runBounded/validateProcessGroup/getProcInfo）、path-guard.ts 全文、perimeter-extension beforeTool 全 hunk、execution-backend 新增 191 行、policy/engine 全 hunk、config 两份 yaml 新增节、execution-env/harness-host 全 hunk、approvals 关键新增（上下文核验/过期路径）、vendor manifest×2/patch 头/build.mjs 前 110 行+哈希复算、全量 +/− 行的扫描类 grep。其余 evals/benchmark、pi-env-patch、其余测试文件依赖历史轮 approve 记录（grok-s0/s2/bounded 系列）未逐行重审。modelgw 3 文件未读内容，仅哈希比对。

## 证据文件瑕疵（记录，不阻塞）

/tmp/perimeter-exec-s2b-hbJBblbP/s2b-modelgw.txt 的行数列与实测不符（secrets 292≠"242 8"、server 464≠"104 8"、upstream-auth 173≠"3 0"）；三文件 sha256 列与实测完全一致，以哈希为准。

## 基线外事项（转记，非本轮范围）

协调者证据披露：首次导出因 symlink 安装路径被 pi-env-patch 拒绝、pi-env-build-negative 依赖相对布局导致 10 文件环境性失败（重导出后全绿）；path-guard-exec-helper 曾留 4 个自有容器已清理。
