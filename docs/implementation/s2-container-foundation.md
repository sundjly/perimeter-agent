# 企业化规格 S2 容器隔离基底与生产安全守卫实施报告 (S2 Implementation Report)

## 1. 目标与背景
依据 `docs/handoff.md` 企业化规格 §5.2 与 §7，以及 Grok 第一审（Round 1）审查意见，Perimeter 必须在保证 4 条核心铁律（代码不离 Data Plane、凭据不进沙箱、egress 默认拒绝、工具调用留痕）的前提下，完成 S2 阶段的容器隔离基底与生产安全启动守卫。

在本次实现中：
1. **两项历史红灯持续真绿**：彻底保持只读挂载面（`src:ro`, `config:ro`, `node_modules:ro`）与容器端到端双向策略断言（`allowed-marker.txt`="safe marker" 正向落盘，CI 路径 `policy.denied` 且未落盘）；
2. **六处独立确认绕过最小修复**：
   - **生产网络守卫**：生产模式拒绝 `host` 与默认 `bridge` 网络；仅 `none` 直接可用；其它 named network 必须在 `listen()` 前通过 bounded `docker network inspect` 验证 `Internal: true` 且绑定真实 network identity，失败/未知 fail-closed 拒启动；禁止通过 `extraArgs` 另加 `--network`/`--net` 覆盖；
   - **真实后端实例校验**：严格验证 `cfg.backend instanceof DockerBackend || cfg.backend instanceof KubectlBackend`，拒绝 plain fake `{ kind: "docker" }` 对象与任何 `LocalBackend` 及其子类伪装；禁止 `allowLocal` 参数绕过；
   - **extraArgs 全语法解析与防御**：全面覆盖短选项与等号形式（`-u 0`, `-u=0`, `-u0`, `--user root:root`, `0:0` 等）、`--mount` 敏感路径（`docker.sock`, `/` 等）、`--read-only=false`、`--security-opt no-new-privileges=false/unconfined`、`--name` 覆写等；保留测试合法 `--add-host`；
   - **不可变配置防御 (Freeze)**：`DockerBackend` 构造时深拷贝并 `Object.freeze` 所有 opts（含 `extraArgs`、`env`），`options` getter 返回冻结对象，外部 mutation 绝不渗透进内部 argv；
   - **session.ts 精确 URL 域名边界**：采用 `new URL()` 精确匹配 `hostname === "host.docker.internal"`，仅改写 hostname 为 `127.0.0.1`，绝不改写后缀域名（如 `host.docker.internal.attacker.com`）、伪装 username 或 query，防凭证外发攻击域；
   - **Docker 调用与清理超时安全管理**：`safeDockerCmd` 设置精确 deadline，超时后向子进程组发送 SIGTERM 并定时 SIGKILL 确保进程真实退出（杜绝 Promise.race 掩盖 live work）；清理失败或超时资源记录为 `unconfirmedResources`（待 reconcile），绝不虚称 0。
3. **Docker daemon 健康探测与真实执行状态**：有限只读健康探测当前测试 socket，当宿主机 daemon 挂死时 fast-fail 诊断，不循环重压 daemon，本地代码/纯 argv/URL/守卫测试全部绿灯通过。

---

## 2. 核心红灯根因分析与精确修复

### 2.1 测试 1：策略扩展依赖只读挂载失败
- **失败现象**：`docker 后端只挂工作区、HOME 与扩展所需的三个只读子树` 断言失败，容器内策略引擎找不到 `/opt/perimeter/config/policy.yaml`。
- **根因分析**：
  原有 `DockerBackend.launch()` 仅挂载了沙箱工作区与 HOME，未将宿主机执行策略扩展与 node_modules 挂载进容器只读路径，导致挂载点数量不匹配且容器内缺少策略上下文。
- **精确修复**：
  在 `src/gateway/execution-backend.ts` 中配置容器启动参数，追加 3 个只读挂载点：
  - `-v ${repoRoot}/src:/opt/perimeter/src:ro`
  - `-v ${repoRoot}/config:/opt/perimeter/config:ro`
  - `-v ${repoRoot}/node_modules:/opt/perimeter/node_modules:ro`
  同时保持根文件系统只读（`--read-only`）、挂载 tmpfs、non-root 用户运行。

### 2.2 测试 2：端到端容器内执行与策略钩子拦截异常
- **失败现象**：`端到端：整个会话跑在容器里，策略钩子仍然生效` 超时或收到 `command_failed`。
- **三重根因与精确修复**：
  1. **沙箱镜像缺少静态 `pi-env`**：基础 alpine 镜像没有 `/usr/local/bin/pi-env`，常驻容器内的 `docker exec -i ... pi-env` 报退出码 127。*修复*：通过 `deploy/sandbox.Dockerfile` 构建新测试镜像 `perimeter-sandbox:test`，注入跨架构静态编译的 `pi-env` 二进制文件。
  2. **协议层 `requestId` 必填契约匹配**：S1 引入了严格的命令校验（`src/protocol/validate.ts`），要求 prompt 命令必须包含合法 `requestId`。原有测试 fixture 发送裸 prompt 导致被前置守卫拦截。*修复*：遵循 coordinator 明确指令，**严格保持 validator 中的 requestId 必填规则不变**，在 `tests/docker-backend.test.ts` 的端到端测试中规范传递 `requestId: "req-e2e-ci"`；同时增加正向安全文件写入断言（`allowed-marker.txt` 内容 `"safe marker"` 成功落盘），与 CI 敏感路径拒绝断言（`policy.denied`，rule 为 `ci-iac-secrets-off-limits`，文件未落盘）形成完整正反 oracle。
  3. **宿主机 HarnessHost 访问容器网络别名映射**：HarnessHost 运行在宿主机网关进程内，当网关向容器注入模型代理地址 `http://host.docker.internal:${port}/v1` 时，宿主机本身向 `host.docker.internal` 发请求会抛出 `ENOTFOUND`。*修复*：在 `src/gateway/session.ts` 中对 `opts.wiring.modelGatewayUrl` 进行回环映射规范化，若精确匹配 `hostname === "host.docker.internal"`，网关宿主侧模型客户端自动映射为 `127.0.0.1`。

---

## 3. Grok R1 六处独立确认绕过最小修复

### 3.1 生产网络守卫与 named network 实际校验 (`src/gateway/server.ts`)
- 生产模式下配置 `network: "host"` 或默认 `bridge` 一律抛错拒绝；
- 仅 `network: "none"` 可以直接放行（Docker 原生断网保证）；
- 任何其它 named network（如 `internal` 或自定义网络）不是能力证明：在网关 `listen()` 启动前，通过带 3000ms bounded timeout 的 `safeDockerCmd(["network", "inspect", net], 3000)` 检查其 JSON 配置，必须严格满足 `info.Internal === true` 且绑定真实 identity；若网络不存在、超时或 `Internal !== true`，立即 fail-closed 抛错拒绝启动；
- 验证隔离后端真实实例：严格要求 `cfg.backend instanceof DockerBackend || cfg.backend instanceof KubectlBackend`，坚决拦截伪造 `kind: "docker"` 的普通对象；
- 禁止通过 `extraArgs` 指定 `--network` 或 `--net` 覆盖网络。

### 3.2 extraArgs 严格安全解析与防御 (`src/gateway/execution-backend.ts`)
- `validateDockerSecurity` 遍历解析所有 argument（支持短选项、等号连接与紧凑语法）：
  - 用户身份：拦截 `-u 0`, `-u=0`, `-u0`, `--user 0`, `--user=0`, `--user root:root`, `0:0` 等；
  - 特权与 caps：拦截 `--privileged`、`--cap-add`；
  - 网络与命名空间：拦截 `--network/--net`、`--pid=host`、`--ipc=host`、`--uts=host`、`--userns=host`；
  - 只读根覆盖：拦截 `--read-only=false`；
  - 安全选项削弱：拦截 `--security-opt` 中的 `no-new-privileges=false`, `label=disable`, `seccomp=unconfined` 等；
  - 卷与 Mount 逃逸：同时拦截 `-v` / `--volume` 和 `--mount`（解析 `source=` / `src=`）指向 `/var/run/docker.sock`、`/`、`/etc`、`/root` 等宿主敏感路径；
  - 容器名覆写：拦截 `--name`；
  - 白名单参数：合法保留 `--add-host host.docker.internal:host-gateway`。

### 3.3 构造不可变防御 (Freeze) (`src/gateway/execution-backend.ts`)
- `DockerBackend` 构造函数对 options 做深拷贝，并对自身及 `extraArgs`、`env` 深度执行 `Object.freeze`；
- `get options()` 返回该冻结对象；外部后续对原 options 或 getter 返回值的任何 mutation 均抛出 TypeError 或被丢弃，绝对无法渗透进内部 `launch` / `environmentPlan` 的实际 argv。

### 3.4 session.ts 模型网关地址精确 URL 边界 (`src/gateway/session.ts`)
- 放弃易受污染的 `baseUrl.includes("://host.docker.internal")` 字符串替换；
- 采用 `new URL(baseUrl)` 精确比对 `u.hostname.toLowerCase() === "host.docker.internal"`；
- 仅当主机名精确匹配时替换为 `127.0.0.1`，保留原端口与路径；
- 负测证明：后缀域名（`http://host.docker.internal.attacker.com`）、伪装 username（`http://host.docker.internal@attacker.com`）、query 参数包含等均绝不改写，杜绝凭证外发。

### 3.5 Docker 调用生命周期与子进程安全终结 (`src/gateway/execution-backend.ts`)
- 实现 `safeDockerCmd(args, timeoutMs)`：超时向子进程组发送 SIGTERM，并在 1000ms 后补发 SIGKILL 确保进程真实退出，捕获退出码与信号；杜绝 `Promise.race` 掩盖 live work；
- `cleanup` 与 `reapOrphans` 具备快速超时限制（2500ms~5000ms）；若清理失败，将容器 ID 记录入待对账集合 `#unconfirmedResources`，绝不虚报为 0。

---

## 4. 测试与验证状态

---

## 5. Grok R2 审查遗留两项最小闭合 (Round 2 Addendum)

依据 `docs/reviews/grok-s2-container-foundation-round-2.md` 的审查意见，针对探针发现的两个本地实现残留进行了严格最小修复：

### 5.1 extraArgs 彻底禁止自定义挂载 (`src/gateway/execution-backend.ts`)
- **根因**：原先使用敏感路径黑名单（仅排查 `/`、`/etc`、`docker.sock` 等），`-v /tmp:/t`、`-v /Users/sundy:/h` 等宿主机任意目录仍可能被注入。
- **修复**：遵循第一性原理，从黑名单改为白名单收敛——在 `validateDockerSecurity` 中彻底拒绝一切 `-v`、`--volume`、`--mount` 形式（包括分离空格、等号连接、紧凑短选项如 `-v/tmp:...`），挂载面只能由后端内部从受信任的 `LaunchContext` 构造（即工作区、HOME 及 3 个 `:ro` 扩展目录）。
- **测试**：在 `tests/docker-backend.test.ts` 中补充了对 `/tmp`、用户 home 目录、命名卷、`--volume` 等的全量拦截测试，均抛出 `禁止通过 extraArgs 指定任何自定义挂载`。

### 5.2 网络身份绑定与不可变防护（防 TOCTOU）(`src/gateway/server.ts` & `src/gateway/execution-backend.ts`)
- **根因**：原有网关 `listen()` 仅按名 inspect 检查了 `Internal === true`，但在容器 `launch` 时仍按 name 拼入 `--network`。若在 inspect 完成到容器启动之间该网络名称被重绑到非 internal 网络，将导致容器逃逸隔离（TOCTOU 漏洞）。
- **修复**：
  1. `verifyDockerNetworkInternal(net)`：校验 `Internal === true` 后，解析并严格校验 `info.Id`（合法非空 string）并返回；`net === "none"` 直接返回 `"none"`。
  2. `Gateway.listen()`：获取返回的 `verifiedId` 后，显式调用 `DockerBackend.bindVerifiedNetwork(verifiedId)`。
  3. `DockerBackend`：维护内部不可变 `#verifiedNetworkId`，在 `launch()` 及 `environmentPlan()` 中统一锁死使用该不可变 network ID，外部重命名或篡改 name 绝不影响容器内部真实绑定的网络。
- **测试**：在 `tests/docker-backend.test.ts` 中模拟验证前后的 argv 行为，断言绑定后 `launch` 与 `environmentPlan` 的 `--network` 参数始终指向 `verifiedNetworkId`。

### 5.3 验证状态说明与资源确认
- `tests/docker-backend.test.ts` 34 项测试全部 PASS（34 pass, 0 fail），覆盖纯本地 argv、静态安全校验以及真实容器隔离（当前宿主 Docker daemon 正常响应）；
- `docker ps -aq --filter "label=perimeter.gateway"` 扫描确认 owned 遗留容器数为 0；
- 静态检查 `npm run typecheck` 与 `git diff --check` 完全干净通过。

