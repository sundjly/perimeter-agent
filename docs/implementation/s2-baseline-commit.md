# S2 基线提交记录（commit `116e1a6`）

**背景**：此前的提交依赖从未提交的 S2 工作树代码，HEAD 单独 typecheck 有 16 个错误。本次把 73 个代码文件一次性提交（不含 md / progress）。

**验证**：
- 候选树（HEAD + 文件）导出到隔离目录，typecheck 0，61 文件 798/798。
- 提交后从 HEAD 导出复验：62 文件 803/803，无残留。

**复审**：`grok-s2-baseline-commit-round-1`（request_changes：S3c 执行期审计门无测试，即 R-S2B-1）、`round-2`（approve）。

**本轮新代码**：
- `tests/bounded-runner.test.ts` 修复 5 例：
  - 例 4 是模板串里 `\n` 转义错误，子进程因语法错误退出；
  - 其余 4 例的旧 fake 与冻结 runner 的假钟语义不一致。
  - runner 本身未改，sha 仍为 `6f4e2b0f`。
- `tests/audit-gate.test.ts`：两道 audit-unavailable 门的 e2e 与线级单测，变异检验有效。

## 取舍

- `src/modelgw` 的 3 个文件当时按约定未读未审，原样提交；之后已在 S4a–S4c 复审中覆盖。
- 门 2（审批后、执行前的审计门）只有线级单测固定：e2e 中 `Approvals.decide` 的“审计成功先于可用 allow”已先兜住，不存在确定性的 e2e 触发窗口。
- vendor/pi-env 补丁产物没有逐行审查，只核对了 manifest/patch/dist 的哈希与 pin（`cdaf6c22`）是否一致。

## 遗留

- 测试依赖环境布局：
  - `pi-env-patch` 按设计拒绝 symlink 的 `node_modules`；
  - `pi-env-build-negative` 依赖 `../../pi-mono` 相对布局。
  - 导出隔离树验证时需要 APFS 克隆 `node_modules`，并补上 pi-mono 相对软链。
- `kill -9` 后孤儿工具进程组不会被自动回收（中低风险）。
