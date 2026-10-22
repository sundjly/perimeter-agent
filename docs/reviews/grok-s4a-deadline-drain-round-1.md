# S4a 复审第 1 轮：模型网关分段 deadline / 写回 drain / 断流取消

- 日期：2026-10-22。只读复审，未运行任何测试/进程。基线 HEAD e162088；本轮按用户授权正常读取 src/modelgw/** 内容。
- 对象 s4a-code.diff（server.ts、upstream-auth.ts、新测试 tests/modelgw-deadline.test.ts 532 行）；现有 modelgw.test.ts 未在 diff 中（未动，54 例保持）。

## 结论：approve（3 条 note，不阻塞）

## (1) 五段 deadline 覆盖与释放：通过

每个 await 均有计时覆盖：readBody→bodyMs（readBodyBounded race+finally clear）；authorizeUpstream→connect+total（signal 传入，ac.abort 生效）；上游 fetch→connect+total（signal，disarm 于头到达后）；reader.read→first_token（首 chunk 前）/idle（之后逐 chunk 重臂），disarm 在 finally；drain 等待→idle 重臂+total。total 在认证前 arm、请求收尾 finally disarmAll，超时 fire 时先 delete 再调 fire——node --test 自然退出（三连跑佐证无句柄残留）。超时/中止路径：ac.abort() 传播至 fetch 与 reader（catch 按 abort.cause 归因返回，不误报上游故障）；上游侧经 fake `closed()` 实测观测到连接关闭。预写头后超时 res.destroy()（客户端见截断流），预写头前超时 504 固定文案（`UPSTREAM_TIMEOUT_MESSAGE`，无 AbortError/TimeoutError 字样——测试显式断言）。

## (2) 背压真有界：通过

writeChunk 仅缓冲当前一个 chunk+socket 缓冲；write=false 时等 drain/close/error（三监听一次性解除），等待受 idle 重臂与 total 约束；超时→destroy→close 解除等待。背压测试用 4MiB 洪水+客户端 pause：untilStable 证明上游停在中途（`stable < TOTAL`）且 400ms 内保持停止（网关在等 drain，非无界缓冲），resume 后字节数完整（TOTAL+trailer 精确相等）并正常计费。

## (3) abort.cause 单一事实源：竞态处理正确

cause 非空即不再改写（先到先得）：超时与断开同时由先设置方归因；timeout→res.destroy() 触发的 'close' 被 `cause===null` 守卫挡住不改写；完整成功流 res.end() 同步置 writableEnded=true，随后的 'close' 不触发 client 归因——计量不受断开误伤（正控 120 token 精确）。fetch 完成与 abort 的窄窗口有专门分支按已记录原因收尾，不把死响应写给客户端。

## (4) 换 token 的 AbortSignal.any：正确

gcp refresh 用 `AbortSignal.any([固定10s, 网关 signal])` 取更早者，redirect:"error" 与 allowlist 预检保留；测试以可编程 fetchImpl 断言 token 请求收到 abort、上游零调用、504+usage_unknown。note-1：token 刷新 inflight 去重使共享任务被任一请求的 signal 中止，并发等待者会收到连带 502（窗口=刷新在途期，自愈，inflight finally 清除）——已知取舍，可接受。

## (5) 固定文案/计量/既有行为：通过

408/504/502 均固定文案，内部错误详情只进审计；中止/断流审计固定类别含段别+usage_unknown，不写 0 token 假成功、不计费（usedTokens 断言为 0）；完整成功流计量行为逐字节不变（正控 120）。DLP 扫描链、assertAllowed（含 GCP token host）、MAX_BODY_BYTES/413、redirect:"error"、401 均原位未动；modelgw.test.ts 零改动。

## (6) 测试真实性与计时脆弱性：真测，不脆弱

9 例对应需求逐项：四段超时各一例（段别断言互相隔离——total 例用 30ms 滴流使 idle(500) 恒不触发，并断言无 segment=idle 审计）；断言包含上游侧 socket 关闭观测、固定文案反模式（!includes("Error")）、审计段别+usage_unknown、零计费/精确计费；背压例以 4MiB>socket 缓冲逼出真实传播。计时裕量均为常数量级（deadline 150-500ms vs 事件即时；等待全部有界轮询），无假绿方向竞态。中间问题披露如实：①fake flushHeaders 是真实 Node 语义（未 flush 则网关收不到头）；②waitForAudit 为有界轮询、谓词未放宽（仍要求段别+usage_unknown）；③flushHeaders 修的是生产缺陷（真实网关此前首 token 超时客户端只见裸断连）。

## (7) 既有行为放宽检查：无

见 (5)。modelgw 54 例与全量 63 文件 821/821（coordinator）与静态结论一致。

## Notes（不阻塞）

- note-1：GCP inflight 共享刷新任务被单请求 abort 连带中止 → 并发等待者连带 502（自愈，窗口小）。
- note-2：fetch 已成功解析但 cause 已置的窄窗口直接 return，timeout-cause 客户端拿到裸断连而非 504（可统一为写 504；现状 fail-closed 方向正确，窗口极窄）。
- note-3：GatewayDeadlines 注释称 total「覆盖以上所有段」，实现中 total 在 body_read 之后才 arm（body 仅受 bodyMs 约束）——行为合理，注释措辞与实现不一致，建议下次顺手改注释。

## 范围声明

逐行核对 server.ts 全部新增/改动 hunk（deadlines、DeadlineWatch、AbortState、pipeAndMeter、writeChunk、readBodyBounded、#route 上游段重写）、upstream-auth.ts 全部 hunk、modelgw-deadline.test.ts 全文；对照 handoff §3.2/§4.1 与任务书逐条；抽查现行 #handle/#route 上下文与不变量位置（allowlist/413/redirect/DLP）；核验 v3 TAP 汇总与 all.txt 尾部。未重审未改动文件。
