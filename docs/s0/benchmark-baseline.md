# S0: 固定任务集与冷/热/恢复基准测量报告

- **套件版本**: S0-v1.0.0
- **生成日期**: 2026-10-13
- **环境**: 本地测试 / Mock 模型环境
- **价格声明**: 当前所有模型价格恒定为 **$0.00**（Prompt: $0.00, Completion: $0.00, Cache: $0.00）。**本报告不含任何真实商业模型调用金额，不冒充真实经济性达标**。真实获批通道与 DPA 对账属于 S4 阶段的 `external_blocked`。

---

## 1. 固定基准任务集（30 个固定版本任务）
任务涵盖 R7 规范中的四类核心任务（bug-fix: 14 项, test-coverage: 7 项, dependency-upgrade: 1 项, refactor: 8 项）：
1. `task-01-range-off-by-one`: 修复区间求和边界差一错误 (bug-fix, low)
2. `task-02-semver-coverage`: 补齐语义化版本解析边界测试 (test-coverage, low)
3. `task-03-legacy-url-migration`: 迁移废弃 url 接口至标准 WHATWG URL (dependency-upgrade, medium)
4. `task-04-slice-dedupe-refactor`: 重构切片去重逻辑，提升时间复杂度 (refactor, medium)
5. `task-05-null-pointer-guard`: 处理多层嵌套结构解构空指针 (bug-fix, low)
6. `task-06-hex-color-parser`: 增加十六进制颜色缩写与 alpha 测试覆盖 (test-coverage, low)
7. `task-07-stream-backpressure-leak`: 修复背压未暂停导致的内存持续增长 (bug-fix, high)
8. `task-08-uuid-v4-validator`: 补全 UUID v4 严格字符集与正则测试 (test-coverage, low)
9. `task-09-crypto-timing-attack`: 替换普通等号为 timingSafeEqual 防御时序攻击 (bug-fix, medium)
10. `task-10-event-emitter-leak`: 移除临时 listener 消除未释放监听器告警 (bug-fix, low)
11. `task-11-json-depth-limit`: 入站 JSON 解析层增加递归深度防护 (bug-fix, medium)
12. `task-12-retry-exponential-jitter`: 为重试退避增加全抖动 (Full Jitter) (refactor, medium)
13. `task-13-cookie-samesite-parser`: 修复 SameSite 属性大小写不敏感解析 (bug-fix, low)
14. `task-14-query-param-array-merge`: URL 同名查询参数合并为数组时避免原型污染 (bug-fix, medium)
15. `task-15-utf8-surrogate-split`: 修复定长分片切断 UTF-8 代理对产生的乱码 (bug-fix, medium)
16. `task-16-base64url-padding`: 规范化无填充 base64url 解码 (bug-fix, low)
17. `task-17-abort-controller-cascade`: 级联传递 AbortSignal 防止孤儿异步操作 (refactor, medium)
18. `task-18-header-casing-fold`: HTTP Header 键名规范化折叠 (refactor, low)
19. `task-19-etag-weak-validator`: 增加弱 ETag (W/) 匹配断言测试 (test-coverage, low)
20. `task-20-status-code-range-assert`: 增加非法 HTTP 状态码抛错测试 (test-coverage, low)
21. `task-21-jwt-clock-skew-edge`: JWT 时钟漂移边界极限用例 (test-coverage, medium)
22. `task-22-file-descriptor-close`: 确保异常抛出路径下文件描述符被安全关闭 (bug-fix, medium)
23. `task-23-safe-path-join`: 防御路径拼接穿越穿越到父级目录 (bug-fix, medium)
24. `task-24-regex-redos-mitigation`: 优化指数回溯正则为非回溯状态机 (refactor, high)
25. `task-25-bigint-serialization`: 防止序列化时丢失 BigInt 精度 (bug-fix, low)
26. `task-26-websocket-frame-masking`: 补齐客户端 WS 帧必须掩码 (Masking) 的测试 (test-coverage, medium)
27. `task-27-lru-cache-eviction`: 为 LRU 缓存添加确定性容量淘汰机制 (refactor, medium)
28. `task-28-graceful-drain-timeout`: 进程退出时给在途请求 5s drain 超时 (refactor, medium)
29. `task-29-circular-reference-inspect`: 格式化日志时检测对象循环引用 (bug-fix, low)
30. `task-30-atomic-file-replace`: 使用 tmp 文件加 renameSync 实现原子文件覆盖 (refactor, medium)

---

## 2. 三组模式基准测量汇总（模拟测量 / Synthetic Simulation）

> [!NOTE]
> **真实性声明**：下表测量汇总数字基于 `src/evals/benchmark-skeleton.ts` 本地骨架模拟（Synthetic），时长由模拟随机区间生成，成功率基于骨架空转预期。当前尚无接入真实商业模型的跑批 runner 管道，绝非生产集群大样本实测数据。金额恒定声明为 $0.00，不代表真实商业经济效益。

| 测量模式 (Mode) | 任务样本数 | 模拟通过率 (Synthetic Pass Rate) | 模拟平均延迟 (Synthetic Duration) | 预估输入 Tokens | 预估缓存命中 Tokens | 计费金额 (Cost) |
|---|---|---|---|---|---|---|
| **冷缓存 (Cold Cache)** | 30 | 100.0% (模拟) | ~200 ms (模拟) | ~1,200 / 任务 | 0 (未命中) | **$0.00** |
| **热缓存 (Warm Cache)** | 30 | 100.0% (模拟) | ~100 ms (模拟) | ~300 / 任务 | ~900 (预估命中 75%) | **$0.00** |
| **重启恢复 (Recovery)** | 30 | 100.0% (模拟) | ~135 ms (模拟) | ~800 / 任务 | ~400 (预估命中 33%) | **$0.00** |

---

## 3. 真实本地执行管道基准测量汇总（Actual Local Mock Pipeline - 270 次实测）

依照 handoff §4.4 与 Grok R1 审查意见，通过真实 `Gateway` -> `HarnessHost` (Durable SQLite) -> `LocalBackend` (宿主机子进程) -> `ModelGateway` -> `LocalBenchmarkMockServer` 执行全量 30 任务 × 3 模式 × 3 重复 = 270 次实测（纯真实单调时钟计时，严禁预写答案或随机数造数）：

> [!IMPORTANT]
> **本地 Mock、执行环境与成本声明**：
> 1. 本次测量基于本地 Mock 模型端点与 **LocalBackend 宿主机子进程（非强隔离，企业级容器强隔离属于 S2 待实现项）**，明确为本地环境（非企业生产上线）；
> 2. 模型价格按本地 Mock 配置为 **$0.00**。真实商业模型通道调用与 DPA 账单对账属于 S4 阶段的 `external_blocked`，**真实商业成本严格记录为 null / unknown**，绝不伪造商业 cache 命中率或 20% 成本优化达成；
> 3. 每个任务在运行前均经过 `failsAtStart` 验证，起点必须真实失败；模型通过真实的 tool_call (bash 工具) 执行修复，并通过本地子进程内 `node --test` 验收产物退出码；
> 4. **Recovery 模式真实性**：通过 `src/evals/gateway-process.ts` 真实 spawn 独立操作系统子进程 A 执行初始任务，通过优雅 close 确认实例 A 释放 handle 自然退出并记录 exitCode 0 与 PID；随后在相同 stateRoot + workspace 启动独立操作系统子进程 B（验证 PID_A != PID_B），测量单调恢复时间，并逐字节验证未提交产物连续性；
> 5. **Token 真实性**：删除所有 80/40/25 硬编码合成常量，完全通过 SSE 与网关事件动态提取累计 usage；Mock 未声明缓存命中时诚实标记为 `null` / `unknown`，不伪造缓存收益；
> 6. **内存测量主体披露**：Peak RSS 测量主体为 runner 运行进程自身（PID: 88126），不代表独立的 Gateway/Harness 子进程内存；
> 7. **资源与目录隔离**：仅清理本次已正面识别的 owned runRoot exact path，绝不执行通配符扫盘，保留 22 个未确认归属的历史遗留目录；
> 8. 详细逐次测量记录与 Provenance SHA-256 哈希保存在机器可读的 [`docs/s0/actual-local-mock-benchmark.json`](file:///Users/sundy/projects/web-articles/perimeter-agent/docs/s0/actual-local-mock-benchmark.json)。

| 测量模式 (Mode) | 任务数 | 重复次数 | 实测测量数 | 实测通过率 (Pass Rate) | 实测平均耗时 (Duration) | 实测平均 TTFT | 模式专属实测特征 | 计费金额 (Mock Configured) | 真实商业成本 (Real Commercial Cost) |
|---|---|---|---|---|---|---|---|---|---|
| **冷启动 (Cold)** | 30 | 3 | 90 | **100.0%** (90/90) | **233 ms** | 36 ms | 起点 failsAtStart 100% 真实红灯；LocalBackend 宿主子进程 | **$0.00** | null (未知 / external_blocked) |
| **热复用 (Warm)** | 30 | 3 | 90 | **100.0%** (90/90) | **232 ms** | 35 ms | 真实事件动态提取（mock 未报告缓存时显式为 null） | **$0.00** | null (未知 / external_blocked) |
| **重启恢复 (Recovery)** | 30 | 3 | 90 | **100.0%** (90/90) | **464 ms** | 299 ms | **真实独立 OS 子进程 A/B 重启**（PID_A != PID_B，A 确认退出）<br>**平均恢复就绪耗时: 264 ms**<br>未提交产物连续性: 100% | **$0.00** | null (未知 / external_blocked) |
| **全量实测 (Total)** | **30** | **3** | **270** | **100.0%** (270/270) | **309 ms** | 123 ms | **外部总墙钟耗时: 134.28s** (上限 900s) | **$0.00** | null (未知 / external_blocked) |

- **峰值内存占用 (Peak RSS)**: 252.1 MB（测量主体: runner 运行进程，PID 88126）
- **全局 Deadline 约束**: 设定硬性上限 15 分钟（900s），实际全量跑批耗时 134.28s（安全裕度 >85%）。

---

## 4. 验收与可复跑性结论
- 跑批 CLI 位于 `src/evals/benchmark-runner.ts`，可随时独立执行：
  ```sh
  node src/evals/benchmark-runner.ts --repetitions 3 --output docs/s0/actual-local-mock-benchmark.json
  ```
- 自动化测试位于 [`tests/benchmark-runner.test.ts`](file:///Users/sundy/projects/web-articles/perimeter-agent/tests/benchmark-runner.test.ts)，涵盖规格完整性、failsAtStart 真实性、Negative 失败真实性、真实独立 OS 子进程 PID 与退出断言、动态 usage 事件解析与缺失降级自证、期限退出与资源保护守卫。
- 确认当前指标在 Local/Mock 下成立，无未关闭崩溃，未冒充真实商业模型完成率与经济效益指标。真实生产跑批管道与外部商业成本对账属于 S4 阶段。


