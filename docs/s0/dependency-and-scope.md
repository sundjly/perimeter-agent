# S0: 依赖锁定、模型能力与部署范围记录

## 1. 依赖版本精确锁定
本项目生产核心仅依赖 Node.js 内置模块（`node:crypto`、`node:http`、`node:fs`、`node:path`、`node:stream` 等）及受审计的底层执行引擎包，严禁引入第三方外部 SDK 或未经批准的包。

- `@earendil-works/chord`: `1.1.0`（严格锁定，禁止 `^` 或 `~` 前缀浮动）
- `@earendil-works/pi-ai`: `1.1.0`（严格锁定）
- `@earendil-works/pi-durable`: `1.1.0`（严格锁定）
- `@earendil-works/pi-env`: `1.1.0`（严格锁定）
- `ws`: `^8.18.0`（仅用于 WebSocket 传输协议，通信面严格受限）
- `yaml`: `^2.6.1`（仅用于加载与验证静态策略文件）

构建与测试辅助依赖：
- `typescript`: `^5.7.3`（仅编译与类型检查）
- `@types/node`: `^22.10.1`
- `@types/ws`: `^8.5.13`

## 2. 模型能力清单与边界声明
当前处于本地开发与沙箱基线阶段，所有模型交互仅通过受控的本地 Mock 模型与网关端点进行：
- **Context Window**: 标称 `128,000` tokens，硬性保留输出与工具空间 `8,192` tokens；实际本地 mock 阶段无上下文超限。
- **后台压缩阈值**: `harness-host.ts` 中设定后台触发压缩阈值为 `32,768` tokens。
- **模型价格与成本核算**: 当前基准价格配置全部为 `0`（Prompt: $0.00 / 1M, Completion: $0.00 / 1M, Cache: $0.00 / 1M）。**本阶段测试报告中的金额数字均为 $0.00，绝不冒充真实商业模型计费或经济性优化成功**。
- **上游通道与获批状态**: 真实商业模型通道（如 Bedrock, Azure OpenAI, GCP Vertex AI 等）未在真实环境打通，属于 `s4-real-model` 阶段的 `external_blocked` 事项。

## 3. 当前部署范围与基础设施约束
- **部署模式**: 当前代码仅通过本地单实例网关进程运行于受控主机或 CI 节点，默认绑定 `127.0.0.1` 回环地址。
- **执行隔离环境**:
  - 本地测试阶段采用 `LocalBackend`（直接在隔离子进程/指定 workspaceRoot 中运行）。
  - 沙箱容器模式（`DockerBackend`）：已在宿主机验证通过 OrbStack 本地 socket（`unix:///Users/sundy/.orbstack/run/docker.sock`，Docker daemon 29.8.2 / linux/aarch64）运行，`perimeter-sandbox:test` 镜像就绪（内装静态 `pi-env`）。原 2 项测试红灯（只读挂载路径与容器内策略钩子拦截）已在 S2 彻底修复并通过闭环验证，Docker 安全不变量与生产守卫全部生效，测试套件 100% 绿灯且自发退出、无句柄及孤儿容器泄漏。
  - 集群网络隔离（`deploy/networkpolicy.yaml` 与 KubectlBackend）：尚未在真实 Kubernetes 集群（当前集群为 none）中部署，相关真实出口规则处于 `external_blocked`。
- **存储介质**: `stateRoot` 当前为本地文件系统路径，由单实例网关独占使用。未配置多网关共享存储或持久卷 PVC。

## 4. 基点 Revision 与未提交变更哈希台账
- **Git HEAD Revision**: `b354ffe732ab3dd56b720899d006254ea34c9457`
- **Dirty 源码与测试文件 SHA-256 校验和**:
  - `src/gateway/server.ts`: `f09ca4ab753a0cbc322daf21a1d6c17802c57ced86214c349febe903f1b63e36`
  - `src/gateway/session.ts`: `bcae2deaebf36c301eeb4626ce47648e354460c637024a5e44310908bf12846b`
  - `src/gateway/execution-backend.ts`: `db993bfe5e3eab2156c821b6abd8da8e5be77762320c1f0eb92947ec5e90ab9c`
  - `src/gateway/auth.ts`: `b4961360460c55ad5e0adb26af23ea8f5d4a956b61a68b67346138801b5bc56b`
  - `src/gateway/transport.ts`: `1ce40194303cd6ea3b6b2340cefdffca0e3d399ddfd23e5dfef13657b88270d7`
  - `src/protocol/validate.ts`: `aa71ac0484e5fa58600ed9abd78fdbb55a690c56d0624cd874d751a85619fa9e`
  - `src/evals/benchmark-fixtures.ts`: `01ba1a9264b8c4c367fc7613dc5d5189e636fbf2df35d03c7074fc612cbce2e8`
  - `src/evals/benchmark-pipeline.ts`: `62031faf9aae4628132633235d26083888010a7889ac1162a920798ff2338953`
  - `src/evals/benchmark-runner.ts`: `f84c846a62e9afa4813accdd94e66b37cc3e919e7c61d779b9074b23a3e9748f`
  - `src/evals/benchmark-skeleton.ts`: `2dffdc0db8d70fedfb7e3572d3ce41e579972784317915b540b7aeae020d65c0`
  - `src/evals/gateway-process.ts`: `ce1a50b0881dcbe1a81072c8aa6e6031bfed7d1029ee812c07885998e0914137`
  - `tests/benchmark-runner.test.ts`: `20f9924a59fc3eefc9e3197e81b144bb297cf2dfe18b58b4b2de25f13bd92b52`
  - `tests/enterprise-s1.test.ts`: `a4e5560da79d7ee9bff83937e83c9582e64f583caf5e366a31e255e3b007696a`
  - `tests/docker-backend.test.ts`: `47205d80a75c31be0a2a7eb3d9b29f61258a074223d0f0e5d07731d45313c726`
  - `tests/bounded-runner.test.ts`: `002712dac5b0c8d11ca77aafbbc1fd6b1ec63b724027c1ce1de852a9e4faa30f`
  - `scripts/bounded-test-runner.ts`: `23966148ad84b4a79a666cb2cf90c6fc20ba83eac1ad1516c47925bcff38fff0`
  - `package.json`: `5578b48b579739a814c0d2a50004150696f21287ea637c44fd8261181bc4f0ad`
  - `README.md`: `f5fe26f6f60fe97e4df9706ecc8480a01ea98b1afc51637a6e628f18d234eff8`
  - `web/app.js`: `c83a6dd30bcb63b9580523c74987b77e587063dfbf70006338302f6aee67ce12`
  - `docs/s0/actual-local-mock-benchmark.json`: `e23b8beab24790558a9da13330f22428ddcf385bdc9ea27bade36770974de64a`
  - `docs/implementation/s0-benchmark-runner.md`: `002fb029ab54649605e6df06378a4ed4832828a77b4507bba4d926aacf6752fb`
  - `docs/s0/benchmark-baseline.md`: `e7222a320303dec06914a28edba38c839464b58407e626aecdb3d0be0e6fd1ef`
  - `docs/implementation/s2-container-foundation.md`: `8b3c0f06c3bc4cacd322ba12a495348c84b390fa8704ca92d7d7515e2303c6e0`
  - `docs/implementation/bounded-test-runner.md`: `d51d03a9d590443e38abbeb1878010023c8e3ea9f79f394fe1fecd06bb18f397`
- **任务集定义版本**: `S0-v1.1.0-actual-mock`（30 个固定版本基准任务，包含真实 failsAtStart、代码生成修改与 negative 真实红灯校验，并记录完整 SHA-256 fixtureHash）。


