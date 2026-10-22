# S0: 威胁模型与风险台账

## 1. 威胁主体与动机分析
依据 `docs/handoff.md §5.1`，系统面临的 8 类主要威胁主体如下：
1. **恶意仓库与配置文件**：外部代码库中潜藏的恶意 `AGENTS.md`、`.git/hooks`、`.github/workflows`，试图通过提示词注入（Prompt Injection）欺骗 Agent 越权执行命令。
2. **越权租户/项目成员**：合法凭证持有者试图接入未授权的 repo/team，或试图自批高风险审批。
3. **被窃取的客户端凭据**：攻击者窃取客户端会话 Cookie 或 JWT，试图在浏览器或 API 侧回放。
4. **被攻陷的沙箱容器**：Agent 误执行反弹 Shell 或恶意代码后，沙箱内部进程试图突破网络隔离访问云元数据（169.254.169.254）或宿主目录。
5. **恶意上游与 SSRF 重定向**：JWKS 或模型上游端点返回 HTTP 30x 重定向至内网敏感地址。
6. **误配反向代理/网关**：生产反向代理记录了含凭证的 URL 查询串，或未剥除伪造的转发头。
7. **本地磁盘恶意写者**：网关主机上非特权用户试图通过符号链接逃出 webRoot 或破坏 `stateRoot` 吊销文件。
8. **软件供应链投毒**：上游第三方包注入后门，篡改工具执行逻辑或暗中外传代码。

## 2. 信任边界架构

```mermaid
graph TD
    User["外部浏览器 / CLI"] -->|TLS + 精确 Origin + HttpOnly Cookie / Header| GW["网关进程 (可信边界)"]
    subgraph TrustedZone ["可信边界 (Gateway Host)"]
        GW -->|本地文件系统原子写入| Disk["stateRoot / 审计日志"]
        GW -->|OIDC PKCE S256 (无重定向)| IdP["企业可信 IdP"]
    end
    subgraph SandboxZone ["沙箱隔离区 (Untrusted)"]
        GW -->|管道 / stdin stdout 调度| Agent["Pi Durable 进程 / 沙箱环境"]
        Agent -->|受限网络| GitProxy["凭据代理 (本地回环)"]
        Agent -.->|被 Egress 策略严格阻断| ExtNet["公网 / 元数据服务 (Deny)"]
    end
```

## 3. 风险台账与责任跟踪

| 风险编号 | 风险描述与影响 | 对应阶段 | 处置策略 | 责任人 | 到期状态 / 目标日 | 当前状态 |
|---|---|---|---|---|---|---|
| **RSK-001** | 生产 URL 查询串残留凭据导致日志外泄 | S1 | 废除 search 凭据提取，采用一次性 hash 换取 Cookie 并立即清空，demo 终端移除 token URL | sundy (Sec) | 2026-10-15 | **已关闭（已验证闭环）** |
| **RSK-002** | 网关重启后吊销名单丢失导致撤权凭据复活 | S1 | 在 stateRoot 建立原子持久化吊销存储（0600/0700），损坏或已初始化文件丢失时 fail-closed 拒绝启动并在审计留痕；残余风险：特权 root 物理删除文件将导致服务拒启需人工介入恢复 | sundy (Sec) | 2026-10-15 | **已关闭（代码与子进程验证闭环）** |
| **RSK-003** | 缺乏标准 OIDC 授权码与 PKCE 交互流程 | S1 | 原生实现 RFC 7636 PKCE S256 与 IdP 校验流程，严格 SameSite=Lax/Strict 与 Path=/，多受众 azp 绑定 | sundy (Sec) | 2026-10-15 | **已关闭（本轮闭环）** |
| **RSK-004** | 真实客户 IdP 参数与组映射未打通 | S1 | 待客户安全部门提供生产 issuer/audience 及真实 OIDC 端点 | 待指定 (Customer Sec) | 2026-11-01 | **未关闭 (external_blocked)** |
| **RSK-005** | 本地 LocalBackend 缺乏内核级 cgroup/seccomp 强隔离 | S2 | 引入受限制容器后端，禁止 hostPath 与 docker.sock | 待指定 | 2026-11-15 | **未关闭 (S2 待排期)** |
| **RSK-006** | 真实集群 NetworkPolicy 出口未在集群环境实际探测 | S2 | 待 Kubernetes 集群与 CI 测试网络打通后执行阻断回归 | 待指定 | 2026-11-15 | **未关闭 (external_blocked)** |
| **RSK-007** | 单节点崩溃与重启可能导致在途副作用重放 | S3 | 实现 stateRoot 独占锁与操作幂等收据 (receipt) | 待指定 | 2026-11-30 | **未关闭 (S3 待排期)** |
| **RSK-008** | 商业模型调用成本与用量无法持久对账 | S4 | 实现原子 reserve/settle 预算账本及真实通道 DPA 签署 | 待指定 | 2026-12-01 | **未关闭 (external_blocked)** |
