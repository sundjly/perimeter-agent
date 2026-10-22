# Grok S2 容器基础第二审

- 结论：`request_changes`（限定两项代码残留：extraArgs 任意宿主路径绑定、network 按名核验与按名 launch 的 ID 不绑定。容器行为复验因 docker daemon 停摆未过门槛，明确计为 unverified 而非通过）
- 日期：2026-10-14
- 审查者：grok（唯一 reviewer）
- 对象：`src/gateway/execution-backend.ts`、`src/gateway/server.ts`、`src/gateway/session.ts`、`tests/docker-backend.test.ts` 的本轮加固。基线是 `docs/reviews/grok-s2-container-foundation-round-1.md`。
- 允许写入：本文件与 `docs/reviews/handoff-coverage.json`。未改实现、测试、docs 其它、SDK，未 commit / push / spawn。

## daemon 健康与验证门槛

一次有界只读检查（`docker version`，10s 强制终止）：**超时，daemon 仍处停摆状态**（上轮串行容器 e2e 触发的停摆未恢复）。按约不重启 daemon、不重试整套容器测试。因此：

- 两项历史红灯的当前状态 = **unverified**（上轮已证真绿，但本轮 daemon 不可用，不能沿用为「当前通过」）。
- 六轮全量（串行 3 + 默认 3）= **未执行**，不计任何绿。
- 除 docker 文件外的 31 文件子集跑了 14 分钟未完成被我终止：daemon 停摆下每个 DockerBackend 网关关闭都要吃满 5–10s 有界超时（s2 守卫测试的合规网关关闭、清理路径逐个累积，日志诚实报「容器清理失败 (待reconcile)」并强制终结子进程——deadline 设计生效，无无限挂起，但墙钟不可接受）。已完成的 371 项 ✔ 里无产品失败；enterprise 文件被终止，S1 回归本轮只算部分验证。
- `npm run typecheck` 0；`git diff --check` 0。

**代码审查结论与验证门槛分开**：以下源码结论基于纯本地 argv/URL 装配探针（不碰 daemon），独立于上述门槛成立。

## round-1 六条绕过面的闭合核验（本地探针重放）

| R1 缺口 | 状态 |
|---|---|
| 生产 `network: "host"` | **已闭合**：options 层直接拒绝 |
| `--mount` 未校验 | **已闭合**：`--mount` source/src 过敏感路径校验，docker.sock 实测被拒 |
| `-u` 短选项 root | **已闭合**：`-u 0`/`-u=0`/`-u0`/`--user=*` 全形式拒绝 |
| `--read-only=false` 后置覆写 | **已闭合**：`--read-only=false` 与 `--read-only false` 均拒绝 |
| security-opt 削弱 | **已闭合**：`no-new-privileges=false`/`label=disable`/`seccomp|apparmor=unconfined` 拒绝 |
| 活引用 mutation | **已闭合**：`#opts` `Object.freeze`，构造后改 `options.extraArgs` 不再进入 argv |
| extraArgs `--network/--net` 任意覆盖 | **已闭合**：一律拒绝（含 bridge） |

`session.ts` 域名边界已修复：`new URL()` 后精确 `hostname === "host.docker.internal"` 才改写为 127.0.0.1，后缀域（`host.docker.internal.evil.com`）、username、query 形态均不再匹配，凭证不会发往新域。

## 仍开放的两项（探针实证）

1. **extraArgs 任意宿主路径绑定**：校验是黑名单（`/`、`/etc`、`/root`、`/proc`、`/sys`、`/dev`、`/var/run`、docker.sock 子串），`-v /tmp:/host-tmp` 与 `-v /Users/sundy:/host-home` 原样进入 argv。宿主机任意目录（含用户 home、任意工作目录）仍可注入容器。修复方向：extraArgs 一律拒绝宿主 bind（`-v/--volume/--mount` 全形式），挂载面只由后端自身构造。
2. **network 按名核验、按名 launch**：`verifyDockerNetworkInternal(net)` 在 listen 时按名 inspect `Internal === true` ✓，但 launch 仍拼 `--network <name>`。名字可在核验后被重绑（TOCTOU），核验与使用未绑定同一网络身份。修复方向：inspect 后取 `info.Id`，launch 用 `--network <Id>`。

## S2 其余范围

四眼/DLP/repo-token、bash-python-symlink 保护、本地 egress allowlist 落实仍 missing/partial；真实 CNI egress、客户批准 external。本轮不构成 S2 整体批准，也不构成企业生产批准。

## 给 agy 的下一最小包

1. extraArgs 拒绝一切宿主 bind 形式（`-v`/`--volume`/`--mount`，等号与空格两种写法），宿主挂载只由后端构造路径出现；补 `/tmp`、用户 home 两条负测。
2. 网络身份绑定：`verifyDockerNetworkInternal` 返回 `Id`，Gateway 持有并在 launch 使用 `--network <Id>`；补「名字重绑后仍用原 Id」的核验说明或测试。
3. daemon 恢复后（只读健康检查通过为前提）补做：docker 文件 solo、串行 3 + 默认 3 六轮全量（每轮外部 deadline 先挂），确认两项历史红灯保持真绿、413+ 口径零失败、owned 资源 0，再回来复审本报告的 unverified 项。
