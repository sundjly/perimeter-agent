# Grok S2 容器基础第三审

- 结论：`approve`（限定 S2 容器基础本包：R1 六条绕过面与 R2 两项残留全部闭合，两项历史红灯 fresh 真绿，六轮全量零失败零挂起。S2 整体与企业生产不批准，真实 CNI/客户批准仍 external）
- 日期：2026-10-14
- 审查者：grok（唯一 reviewer）
- 对象：`src/gateway/execution-backend.ts` `db993bfe5e3eab21`、`server.ts` `f09ca4ab753a0cbc`、`session.ts` `bcae2deaebf36c30`、`tests/docker-backend.test.ts` `47205d80a75c31be`。基线是 `docs/reviews/grok-s2-container-foundation-round-2.md`。
- 允许写入：本文件与 `docs/reviews/handoff-coverage.json`。未改实现、测试、docs 其它、handoff、SDK，未 commit / push / spawn 额外进程。

## R1 六条与 R2 两项残留的闭合核验（纯本地探针 + fake CLI）

| 项 | 状态 |
|---|---|
| 生产 `network: "host"` | 已闭合：options 层拒绝 |
| extraArgs `--network/--net` 任意覆盖 | 已闭合：一律拒绝（含 bridge） |
| `--read-only=false` / security-opt 削弱 | 已闭合：等号与空格两种形式、`no-new-privileges=false` 均拒 |
| `--mount` 未校验 | 已闭合：source/src 过敏感路径校验 |
| `-u` 短选项 root | 已闭合：`-u 0`/`-u=0`/`-u0`/`--user=*` 全形式拒 |
| 活引用 mutation | 已闭合：`#opts` Object.freeze，构造后改 extraArgs 不进 argv |
| 未知选项吞参 | 已闭合：`--unknown-flag --privileged` 仍被逐参校验拒绝 |
| 挂载全形式 | 已闭合：9 种形式（空格/等号/紧凑 ` -v…`/`--mount`/`--mount=`/named volume/relative path）全部拒绝，launch 挂载面只剩 backend 自构的 workspace/HOME/三个 ro 子树 |
| network 按名核验、按名 launch（TOCTOU） | 已闭合：`verifyDockerNetworkInternal` 校验 `Internal===true` 且返回非空 `info.Id`；listen 绑定该 Id；launch 用 `--network <Id>`。fake CLI 行为学实证：inspect name→`ID_AAAA` 绑定后，name 重绑返回 `ID_BBBB`，launch 仍用 `ID_AAAA`。`none` 跳过 inspect 直接绑定 |
| session.ts 域名边界 | 保持：`u.hostname === "host.docker.internal"` 精确比较（本轮哈希内未回退） |

## 执行口径纠正与真串行补验（2026-10-14，coordinator 核查后）

上表六轮的执行口径有误，予以纠正：我的 deadline helper 只执行了 `node --test --test-reporter=spec $f`，**没有传 `--test-concurrency=1`**，因此六轮全部是默认并发，并非「串行 3 + 默认 3」。文件轮次串行与并发=1 是两回事，此前标注混淆了两者。六轮默认并发的结果（417/417/0 ×6、自发退出、owned 0）仍然有效并保留；「串行 3 轮」在补验前按 unverified 处理，不推进下一包。

daemon 一次 3 秒只读健康检查通过后，已按真实命令补验三轮（每轮启动前独立外部 deadline 900s，watchdog 对捕获的进程组 TERM→KILL）：

| 轮次 | argv | exit | 耗时 | total | pass | fail | skipped |
|---|---|---|---|---|---|---|---|
| 真串行 1 | `node --test --test-concurrency=1 --test-reporter=spec tests/*.test.ts` | 0（自然退出） | 56s | 417 | 417 | 0 | 0 |
| 真串行 2 | 同上 | 0 | 58s | 417 | 417 | 0 | 0 |
| 真串行 3 | 同上 | 0 | 57s | 417 | 417 | 0 | 0 |

- 当前实际总数 417（非旧口径 413 或 406），容器子套件真实执行（skipped 0），两旧红保持真绿。
- owned 容器补验前 0、后 0；`pgrep "node --test"` 与 mock-model 无残留；`npm run typecheck` 0、`git diff --check` 0 复核。
- watchdog 保留缺陷如实记录：macOS 下 python `os.setpgrp()` 未生效，捕获的 PGID 落在父 shell 组（三轮同为 41333），若触发会殃及整条链；三轮 56–58s 自然完成，watchdog 未触发，故未掩盖任何证据；跑后 `pgrep` 证实无孤儿。串行 gate 判定 pass 的依据是真实 exit 0 + 计数 + skipped 0 + owned 0，不依赖该缺陷计数。

## 行为复验（daemon 已恢复；一次有界健康检查通过）

- daemon 健康（3s 只读检查通过，29.8.2）。
- `tests/docker-backend.test.ts` solo：34 tests，34 pass，0 fail，15s 自发退出 exit 0。两项历史红灯 fresh 真绿（只读挂载断言、容器端到端 `policy.denied` + CI 未落盘 + `allowed-marker.txt` 正向对照），容器子套件真实执行（非 skip/guard-only）。
- 六轮全量（**默认并发**，每轮预先挂外部 deadline）：全部 417 tests，417 pass，0 fail，exit 0，17–18s 自发退出，零 flake。真串行三轮见上节补验。
- `label=perimeter.gateway` owned 容器前后均为 0。
- `npm run typecheck` 0；`git diff --check` 0。
- 身份/PKCE/撤权/JWKS/20slot/Durable/缓存前缀回归全绿（417 口径含 S0/S1 全部测试）。

## S0 哈希

`dependency-and-scope.md` 台账与本轮实测一致（`server.ts` `f09ca4ab…`、`session.ts` `bcae2dea…`、`execution-backend.ts` `db993bfe…` 均在册）。

## 台账与边界

- `s2-container-hardening`：`partial` → `implemented`（容器隔离基底与安全不变量已闭环并有真实容器证据）。
- `s2-no-local-backend`：保持 `implemented`。
- `s2-real-egress`：保持 external（真实 CNI/集群出口）；本地的 Internal 网络核验机制已落地，不代表真实集群出口已验证。
- S2 其余范围——四眼、DLP、repo-token、bash-python-symlink 保护、本地 egress allowlist 的完整落实——仍按事实 missing/partial，本轮不批准 S2 整体，更不批准企业生产。
- handoff §7：S3 只依赖 S1，不被 S2 cluster 阻塞；S4 依赖 S1 与 S3。下一批按台账为 S2 剩余项（四眼/DLP/repo-token/symlink/本地 egress）与 S3 stateRoot 独占锁、S4 持久预算。
