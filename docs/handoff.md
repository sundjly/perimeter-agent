# perimeter-agent 交接

已按 `durable-rearchitecture.md` 的 M0→M7 顺序迁到 Pi Durable。API 以精确锁定的 node_modules 1.1.0 为准；差异、取舍与总结见规格 §9。每个里程碑经 subagent review、npm test / typecheck 全绿后独立提交，不 push。

## 五分钟上手

```bash
npm install
npm run demo
npm test
npm run typecheck
npm run attach -- --session <id> --token demo-token
```

Node ≥22.19，git；不再需要全局 pi。零凭据 demo 使用 mock-model，经真实模型网关与 git 代理完成放行 / 拒绝 / 审批。真实模型配置 `PERIMETER_MODEL_GATEWAY_URL`、`PERIMETER_MODEL_PROXY_TOKEN`、`PERIMETER_MODEL`；SDK 与上游凭据只在可信网关，gitProxyToken 必须与模型/浏览器 token 不同。

## 铁律与读代码顺序

1. `src/protocol/types.ts`：纯自有 v2 类型；客户端消费 snapshot + 增量，不再 replay/gap/resume。
2. `config/policy.yaml`：策略唯一事实来源。bash 路径规则不生效，命令黑名单不是安全边界；read 仍豁免路径限制。
3. `src/runtime/harness-host.ts`：SQLite、懒打开/resume、选中 perimeter 扩展的运行时断言。所有 durable 依赖只在 runtime 与 translate。
4. `perimeter-extension.ts` / `approvals.ts`：先策略后执行，异常 block；审批 doc 原子 first-wins、超时拒绝、批准人审计。模型工具意图也先审计，覆盖 beforeTool 之前的参数校验失败。
5. `src/gateway/session.ts` / `server.ts`：Hub、成员授权、在场、有界队列、稳定快照栅栏、生命周期。
6. `web/view-model.js`：网页和 CLI 共用纯 reducer。所有 DOM 文本走 textContent，CSP 同源。

代码只记 hash 的铁律保留 command/summary 片段的既有例外；SIEM 白名单不变。沙箱无模型配置/token；local 工具强制不继承进程环境，生产依靠 Docker/Pod 文件系统隔离。审计唯一写入者仍是网关。egress 是部署承诺，生成物没有 apply；Docker 默认 bridge 仍可出公网，必须配置 internal 网络。

## 会咬人的坑

| 坑 | 处理 |
|---|---|
| NodeExecutionEnv 的 shellEnv 不会替换 process.env | runtime 的 localEnvironment 强制 inheritEnv:false，显式给 PATH/HOME；真实 bash 环境守卫已负面验证 |
| beforeTool 发生在参数校验之后 | Generation.afterResponse 对所有工具意图过策略并记 hash；实际执行前再次判定，非法参数不执行 |
| pi-env Connection 自己追加 serve/token 参数 | command 只给 docker/kubectl exec -i … pi-env，不重复参数 |
| durable 的 safe 工具恢复会直接执行，不重跑 beforeTool | 保持 CodingTools 的 unsafe 默认；执行阶段恢复为 interrupted，可能已有副作用 |
| 审批中途 kill -9 | 旧 pending 标过期并审计；call 阶段恢复重新请求，旧审批 id 无效 |
| 一进程独占 SQLite，没有跨进程锁 | 单实例/独占 stateRoot；水平扩展与 sticky 路由未做 |
| 快照读取期间仍可能来事件 | seq 稳定后同步入 attachment 队列，再接增量，避免旧快照带新游标 |
| 关 WebSocket 不等于中止任务 |任务继续；evals 验收前 abort 并等收尾 |
| 空闲关闭后原连接仍开着会吞消息 | 回收时关闭 attachment，网页自动重新 attach 持久会话 |
| node --test 无测试文件仍可能退出 0 | golden suite 判据保留 test -f 与实际 pass 数检查 |
| NODE_TEST_CONTEXT 污染验收 | exec 白名单与工具 inheritEnv:false |
| execFile timeout 只杀直接子进程 | eval backend 保留 detached + killpg |
| Linux bind mount 属主与 macOS 不同 | 容器 uid/gid 默认网关身份；Linux 仍须部署验证 |
| kubectl cp 需要 tar | 必须列入客户镜像前置条件 |

**清理失败不能中断后续清理。** stop 等待启动收尾，按顺序分别关闭事件流、Harness、执行连接、沙箱；审计失败同样不跳过清理。一个会话失败不能把整个网关带崩。

## 改了 X 要记得改 Y

- policy.yaml → `npm run gen:deploy`（NetworkPolicy 与 ConfigMap 都有漂移守卫）。目前沙箱出口只有 git 代理 + DNS。
- 协议事件 → CLIENT_EVENT_TYPES + 共享 reducer + protocol-coverage 测试；双向穷尽性保留。
- Audit 字段 → 核对 SIEM 白名单，不能展开整个 AuditEntry。
- sandbox.yaml 的五项安全约束 → DockerBackend 与相应测试。
- 运行时依赖 → 明确说明理由、精确锁定 Pi 包、更新白名单与 Node 导入守卫。原 ws/yaml 限制为持久运行时放宽，不是取消依赖纪律。
- 静态 section / tools / block 文本 → 跑 cache 测试；不能塞时间、UUID、审批人或在场人数。
- 守卫测试 → 临时改坏实际路径，确认变红，再恢复；边界变红若是策略加固，更新期望，不回退策略。

## 实证与下一步

已测：本地完整产品链路、git clone/push、多个展示端状态、角色拒绝、先到先得、真实 kill -9 恢复 transcript/owner/审批、稳定前缀与 UUID、缓存字段透传、注入/CSP、环境凭据隔离。历史 SigV4/Vertex 离线验证保持。

仍未实证：真实模型上游、生产缓存收益/吞吐、Docker 新镜像运行、真实 K8s、生产 egress。Pod 工作区仍是 emptyDir，删除 Pod 会丢未推送的改动；生产需持久工作区方案。local 无文件系统隔离，不能作为生产安全边界。没有真实模型基线数字，模型目录价格为 0，不把它当真实计费。

下一步：目标集群/新镜像验证、真实模型与缓存收益评测、POC 客户任务集；再做可信身份、水平扩展和四眼审批。本次未做 OIDC/SAML、跨进程 SQLite、sticky 扩容、四眼审批、Helm、多 SCM、monorepo。

## 流程约定

实现 → subagent review → 修复 → 验证 → commit。历史 F13 未 review 与 F19 reviewer 改坏源文件的事实保留在 review-log，不改写历史。与已知绿灯矛盾的 review 先核对工作区，再核对结论，但不能因此忽略守卫缺口。
