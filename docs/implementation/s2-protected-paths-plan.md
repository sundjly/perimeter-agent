# S2 保护路径/敏感读（s2-protected-paths）最小实现方案（只读调研产出）

- 日期：2026-10-15；作者：Pi（task_833577d0e3e5 / ctx_fb2199720aa1）
- 性质：**只读调研 + 方案**。本轮零代码改动；实现待协调者选型后另开编码包，grok retained 只审实现。
- 目标条目：`docs/handoff.md §5.2 保护路径/敏感读`（coverage `s2-protected-paths`，partial，依赖 `s2-container-hardening`）。
- 范围纪律：不扩展 DLP / repo-token / 集群工作；无 SDK/provider/deps/Durable API/cache-prefix 变更。

## 1. 现有真实边界（已核实的 OS/FS 事实，非策略字符串）

DockerBackend 容器（`launch()` 实测 argv）：
- 根文件系统 `--read-only`；可写面仅 `/workspace`（bind rw）、`/tmp`（tmpfs rw,noexec,nosuid,nodev,512m）、HOME tmpfs（64m）。
- 只读 bind：`src/`、`config/`、`node_modules/`（挂 `/opt/perimeter/*:ro`）→ 容器内写 policy/网关源码被内核拒绝。
- 非 root（网关 uid/gid）、`--cap-drop ALL`、`no-new-privileges`、memory/cpu/pids 上限；宿主机其余部分不在容器命名空间内。
- LocalBackend 无任何隔离（宿主全量可写），生产守卫已 fail-closed 拒其入生产。

策略层（`perimeter-extension.beforeTool` → `PolicyEngine`）：
- 带 `path` 的工具按词法 glob 匹配 `deny_paths`（CI/秘密/AGENTS/.pi/.git hooks+config/.gitconfig 等）；只读工具 `read` 豁免（设计如此）。
- bash 无 path 参数：`deny_paths` 对 bash 天然不生效，仅命令模式匹配兜底（README 明示不是安全边界）。

## 2. 真实缺口（按执行链定位）

1. **pi 工具路径纯词法解析**：`write/edit` 的 `resolveToolPath → absolutePath` 只是 `resolve(cwd, path)`——接受绝对路径、不解析 symlink、不校验 workspace 包含关系（pi-durable/pi-env 源码核实）。`/etc/passwd`、`../../outside` 均按字面放行到工具层。
2. **symlink**：workspace 内 `ln -s /etc x` 后写 `x/passwd`——容器内落点在只读根 → 内核拒绝（Docker 场景被 OS 边界兜住）；但 `ln -s .github/workflows ci` 后经 `write ci/x.yml` 词法 glob 不命中 → **受保护子树写入成功**（rw bind 内，OS 不拦）。LocalBackend 下外逃直达宿主。
3. **TOCTOU**：策略在 beforeTool 检查字符串路径，pi 稍后自行 open；`file-mutation-queue` 自述「不是对 bash/其他进程的锁」。同会话顺序执行收窄了窗口，但 check/use 之间由会话外进程换 symlink 仍成立。
4. **hardlink**：容器内 `ln /etc/passwd l` 跨 overlay 设备失败；但同宿主文件系统上 workspace 与 repoRoot 共享超级块——`ln` 穿 RW mount 建硬链接后**经 rw 路径写 ro 挂载的 inode 可成功**（RO 是挂载旗标非 inode 旗标）。来源是 bash `ln`（无 path）→ 回到 bash 缺口。
5. **敏感读**：`read` 豁免 + bash `cat` 无 path——workspace 内 `.env`/秘密可读；容器挂载不含宿主秘密（能读的只有 workspace 内容与三个 ro 子树），故面为「repo 内自带秘密」+ 与 DLP 条目相邻但本条只管「未授权 secret 读取」。
6. **AGENTS/.pi**：写侧已有词法 deny；读侧 AGENTS.md 本身即指令载体（prompt injection 面，属提示词威胁模型，非本 FS 条目可闭合）。

**明确不算边界的**：shell 正则/命令黑名单（自述非边界）；「三只 ro 挂载」≠ workspace 保护（ro 只覆盖那三棵子树）；事后 diff 审计非事前边界。

## 3. 优先实现切片（单一、最小、无 SDK/deps 变更）

**Slice A：与工具同一 ExecutionEnv 的 canonicalPath 收口（path-carrying 工具的 symlink/绝对路径/越界/受保护子树命中）**

- 【2026-10-15 事实修正】初版假设「宿主侧 realpath 对 bind mount 与容器视角等价」**不成立**：Local 与 Docker/Pod 是不同 namespace，宿主 realpath 不能代表容器/Pod 视角。协调者已核实 `ExecutionEnv.canonicalPath(path, Context)` 为接口方法（node 实现 = fs.realpath；RemoteExecutionEnv = RPC `realpath`，remote `#resolve` 为词法解析），且 `HarnessHost.open` 的 `opts.env` 正是工具实际使用的执行环境——HookApi 无 env 不妨碍在 harness-host 以闭包注入该能力。
- 做法：harness-host 以**同一 envFactory**（`opts.env ?? localEnvironment(workspace)`，与传给 Harness.open 的完全一致）构造 `resolveCanonicalPath(raw)`/`workspaceCanonical()` 闭包注入 `perimeterExtension`；`beforeTool` 对带 path 的 action：`canonicalPath` 失败按错误码分派——`not_found` 时对 raw 的词法规范化路径**逐级有界向上找最近存在祖先**（其余祖先段按原词法拼接），`permission_denied`/ELOOP/连接失败/abort 等**不得吞为 allow**（fail-closed deny）；要求
  (a) canonical 结果严格位于 workspace canonical 根之下（不含 startsWith 假包含，用根相等或 `根 + "/"` 前缀）；(b) canonical 路径再过一次同一 policy（deny 不漏、require_approval 不丢）；(c) NUL/歧义输入直接拒。
- 理由：关闭 §2.1/§2.2/§2.3 的工具路径面；只改本仓 `perimeter-extension.ts`/`harness-host.ts`，无 SDK/deps；同 env 解析保证 Docker/Pod 下为容器/Pod 内视角，Local 下为宿主视角（本来就是同 namespace，成立）。
- 【实现状态 2026-10-15】Slice A 已实现并全绿（447/447 双跑），详见 `docs/implementation/s2-protected-paths-slice-a.md`；bash/hardlink/检查-使用全竞态仍为 Phase B 残余，s2-protected-paths 标记 partial。
- TOCTOU 残窗如实声明：顺序执行收窄、会话外竞态与 bash 内自含攻击不由此切片闭合（见 Phase B）。

**Phase B（切片 A 落地后另立包，需执行设计决策，本包不做）**

- bash/FS 层：按 policy 受保护清单在会话准备期做 **RO-overlay 挂载**（`--mount type=tmpfs,ro,dst=/workspace/.git/hooks` 等并列 bind/`--mount`，DockerBackend 本仓代码可改；K8s 侧对应 emptyDir+RO volumeMount，deploy/ 另改）：bash 写受保护路径被内核拒绝；`.git/config` 用「宿主侧拷贝 + ro 单文件 bind」保读。hardlink 经 bash 创建 → Phase B 后只剩「rw 路径写共享 inode」残余，需 `protected_hardlinks` sysctl 或 LSM——超出挂载设计，列为已知残余。
- 敏感读：read 豁免是产品语义；FS 层无法按文件做「读闸」除非秘密不进 workspace（运维约束）或引入 DLP（明确不属本条）。
- 【实现状态 2026-10-21（Phase B 编码包 task_7de876ab211d / ctx_36bd6764cd8a，仅源码交付，待协调者运行验证）】已实现：`src/gateway/protected-mounts.ts`（deny_paths → 确定性子路径推导 + 宿主侧 stub 预创建 + RO bind 清单，含规范化/包含性/祖先去重/symlink 拒挂）、`DockerBackend.launch` 按 policy 派生挂载（策略损坏 fail-closed 拒启动；不接受客户端输入；禁挂根与 .git 整体）、`LaunchContext.repoUrl` 流形门控（clone 需空目录，clone 型会话整体让位）、空只读 `GIT_TEMPLATE_DIR`（防模板拷贝写穿 ro hooks，不破坏 init 流程）、`deploy/sandbox.yaml` RO subPath 生成物（**external_blocked**：kubectl 未配置，未在真实集群验证）、`tests/protected-paths-docker.test.ts`（单测 + K8s 生成物同源钉死 + 真实容器红队/正控）。映射 21 条、未覆盖 5 条（`Dockerfile.*`/`*.tf`/`*.tfvars`/`*.tf.json`/`.env.*` 通配符段无法映射为确定子路径）。已知残余如实：① **clone/init 流形**（repoUrl 非空或容器内 git init）下 `.git/config`/`.git/hooks` 由 git 新建于 rw 面，FS 不可护（clone 需空目录），词法策略仍拦 path 工具——pre-seeded 流形无此残余；② hardlink write-through（RO 是挂载旗标非 inode 旗标，见 §2.4）需 `protected_hardlinks` sysctl 或 LSM，测试如实验证并记录、不声称闭合；③ 任意深度嵌套同名路径只受词法策略（挂载仅覆盖根部确定路径）；④ `$HOME/.gitconfig`（tmpfs）与容器内 `core.hooksPath` 类绕道不在 workspace 挂载面内（egress deny-all 与凭据不进沙箱仍是兜底边界）。
- 【验证与提交 2026-10-22，commit `e162088`】协调者实跑：typecheck 0；`protected-paths-docker` 18/18 连跑 3 次；相关 Docker/会话套件全绿；无残留容器。中途修复：JSDoc 内 `*/` 提前结束注释；**生产缺陷** `hasWildcard` 在剥离结尾 `/**` 前执行，8 个目录条目全部漏挂（单测抓到）；测试 Buffer 用 `assert.equal` 引用比较。复审 `grok-s2-protected-paths-phase-b-round-{1,2}`（round-1 request_changes：测试标题虚假保护声明；round-2 approve）。本机实测：hardlink 在 `ln` 步骤失败（darwin/OrbStack），Linux 需另验；init 流形 `.git/config`/`.git/hooks` 可写。
- **定级（按流形分账）**：pre-seeded workspace 流形 FS 面已闭合；**repoUrl/clone 流形（常见 SCM 生产流）FS 面零保护**——受保护挂载整体让位。s2-protected-paths 整体仍 **partial**。下一步候选：宿主侧先 clone 再挂载（改会话启动流程，独立设计包）。

## 4. 正/反控与失败证据设计（实现包的验收，本轮不执行）

- 正控：workspace 普通文件 `write` 成功；`read` 读普通文件成功；git 仓库内正常开发流（不含受保护路径）不受影响。
- 反控（全部要求「工具层拒 + 审计 deny + 容器内文件未变」三证）：
  1. symlink→`/etc/passwd`（外逃）2. symlink→`.github/workflows`（保护子树）3. 绝对路径 `/tmp/x`（出 workspace）4. `..` 越界 5. `AGENTS.override.md` 直写 6. TOCTOU 残窗说明用例（预期：Slice A 后仅剩声明的残窗）。
  7. **bash 反控如实预期失败**：`echo > .github/workflows/ci.yml` 在 Slice A 后仍不拦——该负控归 Phase B，验收文档必须分开记账，不得合并谎称闭合。
- 失败证据：每条反控留 beforeTool deny 审计 + `policy.denied` 事件 + 容器内 `stat` 原样对照；全部经 bounded runner 外层死线、own 精确资源、无 process.exit（沿用 standalone 探针纪律）。

## 5. 触及文件（实现包预计）

`src/runtime/perimeter-extension.ts`（canonical 路径守卫）、`src/runtime/harness-host.ts`（注入同 env 的 canonicalPath 闭包）、`tests/four-eyes.test.ts` 或新增 `tests/protected-paths.test.ts`（§4 正反控）、`config/policy.yaml` 不动（复用现有清单）。产物零新增依赖。

## 6. 未知与残余（一次说清）

- grok 环境与 macOS/OrbStack 的 hardlink/设备语义差异未实测（本轮零执行）；Phase B 设计需在真实 Linux 部署复核。
- 宿主侧 realpath 对「容器内才存在的 symlink 目标」给出宿主映射路径——拒绝逻辑不受影响，但诊断信息要标注「宿主视角」。
- bash 全量路径化（Phase B）依赖部署侧挂载能力差异（docker `--mount` vs K8s volumeMount），两侧行为需分别验收。
- S2 整体与企业放行仍不批准（真实 CNI/客户审批 external；本条闭合后 s2-protected-paths 才可议 implemented）。
