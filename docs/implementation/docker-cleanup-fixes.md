# Docker 清理专项第一审 request_changes 修复报告

## 1. 修复范围与第一性原理设计

根据 `docs/reviews/grok-docker-cleanup-round-1.md` 的唯一审查结论，本次修复严格聚焦两项 `request_changes`，不扩展范围、不弱化任何断言、不引入新外部 SDK：

### 1.1 消除产品代码全局环境副作用与硬编码路径
- **问题定位**：`src/gateway/execution-backend.ts` 原在模块顶层硬编码了 `/Users/sundy/.orbstack/run/docker.sock` 并对 `process.env.DOCKER_HOST` 赋值。破坏了产品运行时的可移植性，污染了非 Docker 测试与其他环境。
- **修复方案**：
  - 从产品源码彻底删除该全局 mutation 逻辑；
  - `DockerBackend` 生产默认尊重正常平台环境（由宿主机或调用方显式提供 `DOCKER_HOST` / options）；
  - 测试需要的本地 socket 连接收敛到测试文件内部（[`tests/docker-backend.test.ts`](file:///Users/sundy/projects/web-articles/perimeter-agent/tests/docker-backend.test.ts)），使用 `process.env.HOME` 动态定位，绝不在产品代码或公共路径中硬编码用户私有路径；
  - 产品源码执行 `git grep "sundy" src/` 输出为空。

### 1.2 消除 `s1-persistent-revocation` 端口预留竞态 Flake 并增加端口冲突受控负测
- **问题定位**：原测试先通过临时 HTTP 服务器 `listen(0)` 获取端口后立即 `close()`，再交由 `Gateway.listen()` 绑定。在并行文件执行或进程重启重绑时，操作系统 socket 回收延迟或被外部并发抢占，导致 `EADDRINUSE` flake。且 `Gateway.listen()` 原实现未监听 `this.#http` 的 `error` 事件，导致错误无法受控传递给上层捕获。
- **修复方案**：
  - [`src/gateway/server.ts`](file:///Users/sundy/projects/web-articles/perimeter-agent/src/gateway/server.ts)：在 `Gateway.listen()` 的 Promise 中对 `this.#http` 注册 `error` 事件处理器，遇到端口被占等网络异常时受控 reject，防止抛出 unhandled exception；
  - [`tests/enterprise-s1.test.ts`](file:///Users/sundy/projects/web-articles/perimeter-agent/tests/enterprise-s1.test.ts)：
    - 针对 `EADDRINUSE` 实施有限次数（最多 5 次）重分配与重试；
    - 在每次失败 attempt 中，严格调用 `await gwA?.close()`、`await gwB?.close()` 释放自身监听器、定时器与审计文件锁；
    - 遇到非 `EADDRINUSE` 错误（如断言失败）绝不重试，直接抛出；
    - **新增可复现端口冲突受控负测**：预先起占用 blocker 监听端口，断言 `gwConflict.listen()` 必须受控 reject `EADDRINUSE`，且 `close()` 妥善释放资源；释放 blocker 后，网关能够成功重绑该端口。保留全部原正常、撤权、崩溃窗口、删除与损坏 fail-closed 断言。

---

## 2. 根因分析校准（依据 Grok 审查意见）

校准 `docs/implementation/docker-cleanup.md` 中的挂死根因说明：
- Node.js 原生支持顶层 `after()` 钩子，原报告关于顶层钩子失效的表述予以修正；
- 挂死真因为：端到端用例在 40s 等待处超时跳过用例清理，进入 `after()` 后调用 `gateway.close()`，而 `Session.#dispose()` 从不主动 `abort()` 宿主执行连接，导致底层 `docker rm -f` 排在永不关闭的 stdio 流后面；且清理各步骤均缺乏 deadline 保护，造成 `after()` 永久挂起无法返回；
- 本轮修复保留了 `#host.abort()` 先行、清理各步骤 5s 超时保护、用例级 try/finally 逆序释放、mock 子进程 SIGTERM 升级 SIGKILL、8s 快速失败机制，从源头消除了挂死。

---

## 3. 六轮全量验收测试实测数据（依次执行）

依照 Grok 验收要求，全量依次执行串行（`test-concurrency=1`）3 次与并行（默认并发）3 次，记录外部墙钟真实数据：

| 调度轮次 | 调度模式 | 命令 | 测试数 | Pass | Fail | Exit Code | 耗时 | EADDRINUSE | 状态 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 串行第 1 次 | `node --test --test-concurrency=1 --test-reporter=spec "tests/**/*.test.ts"` | 406 | 404 | 2 | 1 | 59.86s | 无 | 自发退出 |
| 2 | 串行第 2 次 | `node --test --test-concurrency=1 --test-reporter=spec "tests/**/*.test.ts"` | 406 | 404 | 2 | 1 | 61.05s | 无 | 自发退出 |
| 3 | 串行第 3 次 | `node --test --test-concurrency=1 --test-reporter=spec "tests/**/*.test.ts"` | 406 | 404 | 2 | 1 | 61.60s | 无 | 自发退出 |
| 4 | 并行第 1 次 | `node --test --test-reporter=spec "tests/**/*.test.ts"` | 406 | 404 | 2 | 1 | 24.36s | 无 | 自发退出 |
| 5 | 并行第 2 次 | `node --test --test-reporter=spec "tests/**/*.test.ts"` | 406 | 404 | 2 | 1 | 24.56s | 无 | 自发退出 |
| 6 | 并行第 3 次 | `node --test --test-reporter=spec "tests/**/*.test.ts"` | 406 | 404 | 2 | 1 | 24.22s | 无 | 自发退出 |

> [!NOTE]
> - 6 次运行中，失败项恒为预期的 2 项 S2 强隔离待实现用例（只读挂载路径与端到端容器策略钩子拦截），完全符合 S2 范围契约；
> - `s1-persistent-revocation` 在 6 轮全量测试中全部一次性通过，未出现任何一次 `EADDRINUSE` flake；
> - 每次运行前后执行 `docker ps -aq --filter label=perimeter.gateway` 均返回空，owned 测试容器零泄漏；
> - `pgrep -f "node --test"` 与 `ps aux | grep mock-model` 无残留进程。

---

## 5. 第二审 request_changes 修复与验证（Round 2）

### 5.1 F3-1 模型日志有界等待修复与正负受控验证
- **问题定位**（依据 `docs/reviews/grok-docker-cleanup-round-2.md`）：
  - WebSocket 收到 `message.end` 仅代表网关事件流通知结束，但本地 mock-model 子进程写盘 `fs.appendFileSync(mockLog)` 存在微小的 OS 文件系统 I/O 延迟，直接 `fs.readFileSync(mockLog)` 偶发因文件尚未就绪触发 `ENOENT` flake（第二审实测在第一轮 90ms 发生 1 次）。
- **修复方案**：
  - 在 [`tests/enterprise-s1.test.ts`](file:///Users/sundy/projects/web-articles/perimeter-agent/tests/enterprise-s1.test.ts) 的 `F3-1` 中引入受控有界等待 `waitForLogContent(filePath, expectedSubstring, timeoutMs = 10_000)`：
    - 采用 25ms 轮询间隔，检查文件存在性及包含内容；
    - 上限 10,000ms（10s），超时则抛出详细诊断异常；
    - 绝不放宽、跳过或吞掉断言，确保模型日志真实包含目标 prompt 与 token 统计；
  - **有界等待 helper 的可靠正/负验证**：
    - 内嵌于 `F3-1` 尾部，不增加额外 `test()` 节点，保证测试总用例数恒定为 406；
    - 负向测试：对一个从不写入的文件轮询，断言在 150ms 超时受控抛出错误；
    - 正向测试：60ms 后异步延迟写出目标内容，验证轮询能够可靠捕获迟到日志并成功返回；
  - **核验 `F3-3` 等同类直读**：
    - 核验 `F3-3`（prompt 注入与凭据窃取阻断）：其原有对照组已配置 5–10s 有界轮询等待，负向组严格断言无敏感 prompt 泄漏，逻辑完备无同类 flake。

### 5.2 第二审后六轮全量验收测试实测数据（依次独立执行）

严格依照 Grok 验收标准，依次执行串行（`--test-concurrency=1`）3 次与并行（默认并发）3 次，每轮独立起止，记录外部墙钟真实数据：

| 调度轮次 | 调度模式 | 命令 | 测试数 | Pass | Fail | Exit Code | 墙钟耗时 | ENOENT / EADDRINUSE Flake | 进程与容器状态 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 串行第 1 次 | `node --test --test-concurrency=1 --test-reporter=spec "tests/**/*.test.ts"` | 406 | 404 | 2 | 1 | 60.80s | 无 (0) | 自发退出，零残留 |
| 2 | 串行第 2 次 | `node --test --test-concurrency=1 --test-reporter=spec "tests/**/*.test.ts"` | 406 | 404 | 2 | 1 | 60.93s | 无 (0) | 自发退出，零残留 |
| 3 | 串行第 3 次 | `node --test --test-concurrency=1 --test-reporter=spec "tests/**/*.test.ts"` | 406 | 404 | 2 | 1 | 61.03s | 无 (0) | 自发退出，零残留 |
| 4 | 并行第 1 次 | `node --test --test-reporter=spec "tests/**/*.test.ts"` | 406 | 404 | 2 | 1 | 24.36s | 无 (0) | 自发退出，零残留 |
| 5 | 并行第 2 次 | `node --test --test-reporter=spec "tests/**/*.test.ts"` | 406 | 404 | 2 | 1 | 24.25s | 无 (0) | 自发退出，零残留 |
| 6 | 并行第 3 次 | `node --test --test-reporter=spec "tests/**/*.test.ts"` | 406 | 404 | 2 | 1 | 24.44s | 无 (0) | 自发退出，零残留 |

> [!IMPORTANT]
> - 6 轮全量测试 100% 稳定为 **406 tests, 404 pass, 2 fail**（两项失败恒为 S2 阶段预期的容器内隔离代码待实现项）；
> - `F3-1` 的 `ENOENT` flake 彻底消除（0 复发）；`s1-persistent-revocation` 端口竞态 0 复发；
> - 6 轮测试全部自发干净退出，无 hang、无超时；
> - owned 容器（`label=perimeter.gateway`）前后均为 0，无任何残留容器与孤儿进程。

---

## 6. 静态检查与基线契约核对

- **TypeScript 类型检查**：`npm run typecheck`（Exit code 0）
- **Git Diff 检查**：`git diff --check`（Exit code 0）
- **代码边界**：未引入新外部 SDK，未改动 S2 两个红测试断言，未改动既往 Grok 复审记录。
- **S0 基线**：`s0-benchmark-baseline` 保持 partial，成本按模拟 $0.00 标注，SHA-256 哈希台账已同步最新值。

