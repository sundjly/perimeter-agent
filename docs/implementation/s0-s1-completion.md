# S0 与 S1 阶段完成总结报告

## 1. 概述与范围契约

本项目严格按照 `docs/handoff.md` §3/4/5/7 及 `docs/reviews/handoff-coverage.json` 针对 S0 与 S1 阶段的所有缺失（missing/partial）项进行系统化推进与交付。
全程严守工程纪律：
- **未引入任何新 SDK**（保持依赖树锁定，仅使用 Node.js 22 内置网络与加密原语）。
- **未越界进入 S2–S7 阶段**（S2 容器只读与策略钩子 2 项测试如实暴露失败，恢复锁、模型限额等未就绪项按规范声明，不在此伪造 S2 全绿）。
- **未修改或覆盖 Grok 既往复审记录**（保留历史审查权威性）。
- **不伪造测试绿灯与商业成本**（评测任务基于本地合成模拟，价格配置恒为 $0.00，绝不冒充真实云端商业模型零成本；真实客户 IdP 与真实 K8s 集群标记 external_blocked）。

---

## 2. S0 基线与契约交付细节

### 2.1 依赖、能力与部署范围基线
- **文档产出**：[`docs/s0/dependency-and-scope.md`](file:///Users/sundy/projects/web-articles/perimeter-agent/docs/s0/dependency-and-scope.md)
- **锁定事实**：
  - 四个核心 Pi 包版本精确锁定为 `1.1.0`（`@earendil-works/chord`, `@earendil-works/pi-ai`, `@earendil-works/pi-durable`, `@earendil-works/pi-env`），无通配符或动态版本。
  - 模型上下文窗口固定为 128k tokens，无隐藏动态扩展；当前测试与评估模型成本恒为 `$0.00`。
  - 网关严格声明为单节点实例部署，跨节点状态同步与分布式锁属于 S7 远期目标，当前不假设集群状态一致性。

### 2.2 威胁模型与 8 类关键风险台账
- **文档产出**：[`docs/s0/threat-model.md`](file:///Users/sundy/projects/web-articles/perimeter-agent/docs/s0/threat-model.md)
- **核心内容**：
  - 定义 8 类威胁主体（恶意外部用户、受限内部协作者、失陷/越界 Agent、恶意下游工具/依赖、流氓 IdP/中间人、本地非特权进程、遗留僵尸容器、恶意网络邻居）。
  - Mermaid 信任边界图明确划分不可信浏览器、DMZ 网关、受限沙箱与特权凭证管理域。
  - 建立 8 项关键风险台账（TM-01 至 TM-08），未指定安全负责人统一标注为「待指定」，补齐 root 物理删除残余风险。

### 2.3 评测任务集与测量骨架
- **代码与报告**：
  - 评测骨架实现：[`src/evals/benchmark-skeleton.ts`](file:///Users/sundy/projects/web-articles/perimeter-agent/src/evals/benchmark-skeleton.ts)
  - 基准报告：[`docs/s0/benchmark-baseline.md`](file:///Users/sundy/projects/web-articles/perimeter-agent/docs/s0/benchmark-baseline.md)
- **核心指标**：
  - 建立 30 个固定版本标准任务集（包含代码编辑、漏洞修复、长上下文审查与多文件重构）。
  - 测量冷启动（≤1500ms）、热启动交互（≤200ms）及崩溃恢复延迟。
  - 报告明确声明数据为本地骨架模拟生成（Synthetic Simulation），所有模型价格恒为 `$0.00`，商业生产计费与真实集群消耗标明 `external_blocked`。

---

## 3. S1 入口与可信身份交付细节

### 3.1 OIDC Authorization Code + PKCE S256 协议
- **实现位置**：[`src/gateway/server.ts`](file:///Users/sundy/projects/web-articles/perimeter-agent/src/gateway/server.ts)
- **关键机制**：
  - `/auth/oidc/login`：生成强随机 `verifier`、`state` 与 `nonce`，采用 RFC 7636 标准 SHA-256 计算 `code_challenge`（`S256`）；签发 HMAC 短 TTL（5 分钟）`Path=/; HttpOnly; Secure; SameSite=Lax` 临时 Cookie（确保跨站顶层重定向回调携带该 Cookie，而最终 session Cookie 仍严格使用 `SameSite=Strict`）。
  - `/auth/oidc/callback`：
    - 校验临时 Cookie 签名（使用 `timingSafeEqual` 防御时序侧信道）与有效期，严格比对 `state`（公开 `state` 与 HttpOnly 绑定 Cookie 完全独立，伪造 `Cookie=state` 直接 400 拒绝）；
    - 完整 callback 流程（外部 Token Exchange 与 JWT 验签）**完全共享网关现有真实 `AuthWorkGate`（限额 20 并发）**，不设任何旁路放水；
    - 共享 `AbortSignal`，客户端断开（`socket close`）或网关关闭时立即中止底层连接与验签，且持满 slot 直到全部 settle，超时或取消时绝不颁发迟到 Cookie；
    - 多受众支持：当 `aud` 为数组或包含多个受众时，强制校验 `azp === clientId`；
    - 以 `redirect: "manual"` 阻断向内部私有地址的 SSRF 重定向攻击；流式接收 Token 响应并强制 64KiB 边界限制；校验 JWT 签名并比对 `nonce` claims；
    - 成功后通过 302 重定向到 `/`，彻底从 URL 中抹除 code 与 state，不泄漏任何凭证，并颁发正式会话 Cookie 与销毁临时 PKCE Cookie。
- **集成测试**：[`tests/enterprise-s1.test.ts`](file:///Users/sundy/projects/web-articles/perimeter-agent/tests/enterprise-s1.test.ts) 中的 `s1-pkce`
  - 覆盖正常登录流程、跨浏览器 state 伪造（400）、无 PKCE Cookie（400）、伪造 `Cookie=state` 签名失败拒绝（400）、授权码重放（401）、Nonce 错配（401）、Token 端点恶意 302 重定向阻断（401）、超大响应截断防洪泛（400）、多受众与 azp 强绑定校验。

### 3.2 持久化吊销与会话存储
- **实现位置**：
  - [`src/gateway/auth.ts`](file:///Users/sundy/projects/web-articles/perimeter-agent/src/gateway/auth.ts)（`BrowserSessions` 增加 `dump` 与 `restore`，彻底解耦 `sessionId` 与 `principalId`）
  - [`src/gateway/server.ts`](file:///Users/sundy/projects/web-articles/perimeter-agent/src/gateway/server.ts)（`#loadRevocations`, `#saveRevocations`, `#loadSessions`, `#saveSessions`）
- **关键机制**：
  - 在配置的 `stateRoot`（强制权限 0700）下原子写入临时文件后 rename，生成 `revocations.json` 与 `browser-sessions.json`（强制权限 0600）。
  - **Fail-Closed 铁律**：若持久化文件损坏（非法 JSON 或字段类型错误）或已初始化状态下缺失 `revocations.json`，网关构造函数立即 fail-closed 拒启并记录审计；构造阶段异常安全关闭 audit 锁。
  - 启动加载时主动根据 `principal.id` 过滤已被吊销主体的遗留会话，未吊销主体保留真实 `principal` 身份，阻断崩溃窗口遗留会话。
- **集成测试**：[`tests/enterprise-s1.test.ts`](file:///Users/sundy/projects/web-articles/perimeter-agent/tests/enterprise-s1.test.ts) 中的 `s1-persistent-revocation` 与 `s1-child-process-persistence`
  - 测试跨网关实例重启与独立子进程生命周期：网关 A 吊销 Alice 后退出，网关 B 在同一 stateRoot 启动，验证 Alice 持有效 JWT 或旧 Cookie 均被严格 401 拒绝；Bob 凭旧 Cookie 正常接入且保持主体身份；显式调用 `restorePrincipal` 后立即恢复访问；损坏或缺失 `revocations.json` 验证网关 `fail-closed` 拒启。

---

## 4. 验证与门禁结果

- **测试套件运行**：
  - 核心测试套件（27 个测试文件）：378 项测试全部通过（pass 378, fail 0）。
  - `enterprise-s1.test.ts`：31 项测试全部通过（pass 31, fail 0）。
  - `docker-backend.test.ts`（Docker 隔离套件）：20 pass, 2 fail（2 项测试因策略文件只读挂载与端到端钩子属 S2 强隔离范畴，S1 未作 S2 阶段实现；cleanups 增加 5000ms deadline 超时确保退出，单列汇报绝不虚报全绿）。
- **静态类型检查**：
  - `npm run typecheck`：`tsc --noEmit` 0 错误。
- **代码格式与差异检查**：
  - `git diff --check`：无空白符残留、无合并标记残留。
- **台账同步**：
  - [`docs/implementation-progress.json`](file:///Users/sundy/projects/web-articles/perimeter-agent/docs/implementation-progress.json) 与 [`docs/s0/dependency-and-scope.md`](file:///Users/sundy/projects/web-articles/perimeter-agent/docs/s0/dependency-and-scope.md) 已更新，记录各 dirty 文件真实 SHA-256，外部阻断如实保留为 `external_blocked`。
