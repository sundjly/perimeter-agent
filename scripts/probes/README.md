# 四眼 standalone 生产链探针

独立冷进程验证四眼审批生产链（真实 Gateway/Harness/DockerBackend + 仓库真实 policy），不依赖测试套件预热。诊断依据与场景 oracle 见 `docs/implementation/s2-four-eyes-standalone.md`。

## 用法

```sh
# 外层必须用已批准 bounded runner 提供看护死线（建议 180s）
node scripts/bounded-test-runner.ts --timeout 180s \
  node --experimental-strip-types scripts/probes/four-eyes-standalone.ts --scenario all
```

`--scenario`：`all`（默认）| `ng`（git-less fail-closed 负控）| `git`（临时 git 正控）| `ctx`（request 后上下文丢失负控）

退出码：`0` = 所选场景 oracle 全过；`1` = 存在失败（manifest 含逐阶段证据）；`2` = policy 预检失败（write package.json 未命中 require_approval，结果不可信）。

## 证据位置

- 逐阶段 manifest：`$TMPDIR/perimeter-fe-probe/<runId>/manifest.json`（每阶段即时落盘，外层死线强杀也留证）。
- 阶段时间线（脱敏）：mock/网关/WS open/session.ready 时延、帧类型有界记录（≤300）、close code/reason；超时时自动附 own 容器状态与 `docker logs --tail 40`。
- 不输出 JWT/cookie/env/模型上游秘密。

## 约束

- 需要本机 docker 与镜像 `perimeter-sandbox:test`（复用既有测试镜像，不构建/不重启 daemon）。
- 每场景新建独立容器（gatewayId 含唯一 runId）；结束时按 gatewayId 精确清理本次容器；历史 labeled 容器仅登记不动。
- 每次运行都是全新 OS 进程：不要依赖上一次运行留下的任何状态；也不要在无外层死线的情况下裸跑。
- 泄漏判定只看本次 own 容器 ID 逐一核验（manifest \`cleanupVerification\`），全局 labeled 计数仅环境参考。
- 保留运行日志与 manifest 至核验完成：日志统一落 \`$TMPDIR/perimeter-fe-probe/logs/\`。
