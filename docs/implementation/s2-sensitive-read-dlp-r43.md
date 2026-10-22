# S2 敏感读/DLP/监督器 R43 修复轮（s2-sensitive-read-dlp-r43；task_3c812ecc2db6 / ctx_f2e71a3ffd38）

- 日期：2026-10-19。执行者：Pi（原 coder terminal/model 复用）。性质：R42（Grok 独审
  request_changes R-Q42-1/2）两项安全缺陷实修 + coor 三封 WIP 源门（msg_77065ae4717e /
  msg_82b3621748c6 / msg_7c38ca7d0bcd）实修 + 受影响 spawn-free causal 测试。
- 与 R42 的关系：R42 报告为复核依据；其"_~ 是 0x5F–0x7E 区间"假说经字节级实证为假
  （`{`/`}`/`|`/反引号均不在值类内，见 §1）——按 coor 裁决未据此改 regex；`{{SECRET_…}}`
  夹具在磁盘上的真实字节为类内字母数字值（本环境 secret 门面双向替换），raw 命中即设计内。

## 1. 修复 A（R-Q42-1）：DLP 同条目 key→value 语义赋值 + 重复键保守拒（src/modelgw/secrets.ts）

- **缺陷**：结构化 body 中 key 与 value 是 JSON.parse 后两个独立字符串，raw+decoded 双层
  独立扫描互相不可见（逃逸 key 无 `[:=`、值无凭据前缀形态 → 全空 → 200 透传，A1–A5 实锤）。
- **实修**：
  1. `extractJsonStringTokens`：线性容错 tokenizer 直接从原始 body 提取全部字符串出现，
     每串记录解码文本 + isKey（冒号后跳空白）+ rawStart（开引号原始位置）+ valueAt（key
     冒号后第一非空白位置）+ 对象嵌套栈（每层 object 独立 key 集）；
  2. own-value 判定：凭据名 key 与「冒号后紧邻原始位置上的字符串」合成 `${key}: ${value}`
     过规则——token 序相邻不算 own value（`[{"password":null},"12+串"]`、
     `{"password":["12+串"]}`、number/bool/null 一律不配对，仅直接字符串 value）；
  3. 同一对象内真重复 key（含转义重复键）→ `json_duplicate_key` fail-closed 403（塌缩使
     前条值不可见，任务允许的保守拒歧义路径；嵌套同名键如各层 `type` 合法不拒）；
  4. 原始结构深度界限在 tokenizer 栈上强制（MAX_JSON_DEPTH），token 数上限
     MAX_JSON_NODES 独立于塌缩文档 nodes；JSON.parse 合法性 + walk 有界遍历保留；
  5. 独立扫描（每串过全部规则）+ 合成串扫描并集，kind+hint 去重；raw 扫描层不变；
     `{{SECRET_…}}` 具体值完全落值类内（无需按假说改 regex）。
- **负控（真实 HTTP + raw 串直 POST）**：A1（coor 夹具 pass\u0077ord）、A2/A3
  （api_key/token 逃逸）、A4 任意嵌套、A5 跨 chunk 中停 80ms → 全部 403 + 上游/GCP 换
  token 零调用；A9b 转义重复键、未转义重复键 → 保守拒 403；边界组（数组兄弟/数组值/
  number/bool/null/短值/innocent key 长值）→ 200 逐字节透传；clean 逃逸 key → 200。
- **红→绿因果**：先写 11 条新负控对旧码跑（红 9：全部 200 放行/塌缩丢失语义红）后实修
  （绿 11→WIP 后 12+2）；日志 nonce 见 evidence root。
- **WIP 源门落实**：own-value 用原始位置而非 token 序相邻（msg_82b3621748c6 ①）；重复键
  保守拒 + token 上限 + 原始深度栈（同条①）；全局键名去重误杀嵌套同名键的中间缺陷
  （缓存亲和测试抓到）已改为同对象真重复检测。

## 2. 修复 B（R-Q42-2）：bounded-test-runner 清理信号纪律 + 注入缝（scripts/bounded-test-runner.ts）

- **核心变更**：
  1. `ps -g` 组员枚举删除（getGroupPids/groupEmpty 移除）；groupResidue 类型收窄为恒
     `"unknown"`——无 empty 证据通道，绝不冒充已清空；
  2. 身份四正证（PGID+birth+PPID=本 runner+完整预期 command 白空格归一化比对；ps 的
     八进制控制符转义先解码再比对——多行 argv 的 macOS ps 输出形态）缺一/变/失败 → 零
     信号；组级与 direct fallback 同一把尺（b5/b9 形态转零信号）；
  3. cleanup 经 `childExited()` 动态 getter 读真实 exit（runBounded 由 exit 事件驱动，字面
     false 删除）；TERM 核验后、紧邻每枪重查 budget/exit；grace 每轮先查 exit；ps 观察失败
     先让出一个宏任务再查 exit（同步 ps 期间排队的 exit 不算观察失败），仍失败 → unknown
     零补杀（b2 转绿）；
  4. KILL 前 fresh 重核验（独立预算）；组模式单发 `-pgid` KILL，不补冗余 direct 枪（第二枪
     不打复用 PID）；grace 从 TERM 后起算 + sleep=min(50,剩余,grace 剩余)（核验耗时不得吃
     grace）；ps-null/超时/身份改变/预算耗尽 → 零 KILL（b2/b4 形态）；
  5. validateProcessGroup 总绝对单调预算：每次 ps=floor(min(cap,当前剩余))、≤0 零 spawn，
     重试共享同一总预算（b6b 固定 7 次废除）；初次 safe 即校验 PPID/birth/command；
     runner/parent PGID 观察失败 → safe=false（未知组零信号，口径收缩）；
  6. 预算 guard 统一置于注入之前（deps.procInfo 收 floor 后 budget，零预算 fake 同样不
     观察）；生产 ps 固定 `/bin/ps`（不经 PATH）+ `killSignal: SIGKILL`（owned CLI 防
     TERM-resistant shim 挂死）；
  7. runBounded：exit/close 监听在 spawn 返回后立即注册；启动日志 fallible（抛错→零
     spawn+timer 收敛+受控拒绝）；prelude 后 fresh 剩余检查（耗尽零 spawn）；无 PID 路径
     有界等（注入钟+真实钟双界限）；spawn 同步抛/cleanup 内抛错 → 失败收敛（timer 必清、
     非零、不伪装安全结算）；
  8. 收尾次序：结算 → 全部 finalizer IO（执行完毕 onLog + finalizeIO）→ 新鲜预算 check
     （sticky 只红不绿）→ runnerWall 采样（不早采样再 IO）→ 清 timer；冗余「runner 返回」
     日志删除；finalizeIO snapshot 填已知结算值（非占位 0）+ `pre_final_io` 标注；CLI 行
     wall 如实标 `wallAtCliLog`（最终 wall 只由回调后结果/外层 OS wait 给出）；
  9. 三 wall 分开保留（actualExit/close/runnerWall）；grace 扩展=调用方请求的 graceMs+2s
     与剩余总预算取大，KILL 后有界 2s kill-lat margin 真 close，未证=124+unknown；注入钟
     与真实单调钟双界限防死锁（static fake clock 也不久转）。
- **红→绿因果（纯 fake：signal 只记录不投递、ps 经缝、无真实 child）**：对 R41 旧实现插
  桩重建件先跑 b1/b2/b4/b5/b9/b6b/b7 七形态（全部缺陷实锤），再对新实现 16+ 条 fake 转绿；
  真实 child 用例（≤10s、runBounded 内部持句柄真 exit+close await）34/34 → 45/45 全绿。
- **已知边界（如实）**：组员终态无正证 → residue 恒 unknown；外层 parent 实际 OS wait 在
  本进程边界外由调用方观测；内核终止时延无静态保证。

## 3. 验证（全部经受监督 bounded runner，依次实际 wait 完成再下一件）

| 运行 | 结果 |
|---|---|
| R43 DLP 负控（先红后绿） | 红 9 fail → 绿 12 pass（pattern=R43） |
| tests/modelgw.test.ts 全文件 | 54/54 pass exit 0（含缓存亲和回归） |
| R43 runner fake 红对照（旧插桩重建件） | 7 形态缺陷全部实锤（b1/b2/b4/b5/b9/b6b/b7） |
| tests/bounded-runner.test.ts 全文件 | 45/45 pass exit 0（真实+fake） |
| tsc --noEmit | exit 0（0 error） |
| 全量 bounded 一轮（原始实数，日志 /tmp/pi-r43-hEncj8ku/log-full-bounded-r43.txt 819–826 行） | **tests 615 / suites 10 / pass 598 / fail 11 / cancelled 1 / skipped 5 / todo 0；target 自报 duration_ms 5701958ms（95min）与 1500s 预算头冲突；runner 无 actual exit/close/final wall 收尾（外部 SIGKILL，终态 unknown）** |

11 个 fail 全部在 tests/enterprise-s1.test.ts（真实 DockerBackend 路径，单项 22.5–33.5s，
与 docker 调用 2.5–5s 超时×N 的时长形态一致；daemon 无响应直接归因证据=docker info
20s×2 无返回；未重跑前不做超出此的单项归因，全部失败逐项原因=unknown 如实保留）。
skipped 5（docker/镜像不可用 skip）。cancelled 1。**不采用「只跑了 124 个测试」或「全部
失败均 Docker、runner 预算安全已证明」口径**；不补证重跑。按 coor 裁决（msg_aa4339dda6d6
选 b）：全量/serial 不再重跑；当轮 full 日志原样保留。serial 未跑（同裁决）。

## 4. 全量当轮实录与偏差台账（历史不洗）

- 全量 bounded 一轮（--timeout 1500s 头）：测试执行实际完成并出总结（tests 615/pass 598/
  fail 11/cancelled 1/skipped 5/todo 0），但 target 自报 duration_ms 5701958ms（95min）
  与 25min 预算头冲突；11 fail 全在 enterprise-s1（真实容器路径，单项 22.5–33.5s，与
  docker 调用超时时长形态一致；daemon 无响应直接归因=docker info 20s×2 exit124）；
  日志尾 924 行无 bounded-runner actual exit/close/final wall——runner 被外部 SIGKILL，
  **外层 runner 终态 unknown**（不能把 tool timeout 等同 OS wait，也不宣称预算安全已证明）。
- docker daemon 直接归因证据：`docker info` 经 bounded runner 两轮各 20s 无响应（exit 124，
  runner TERM→child 143 退出）；5 个 skip（docker/镜像不可用）与 11 个 enterprise-s1 fail
  与之时长形态一致，但未重跑前不做更强单项归因；按 unknown 停，不再重跑 full/serial（裁
  决 b）。
- 孤儿 PGID 4818（本 run 泄漏的 node --test 组）：受监督 reap 脚本按登记身份（PID=PGID=4818、
  birth=Mon Oct 19 01:10:07 2026、command=node --test --test-reporter=spec）四元组正证后
  TERM(-4818) → grace ≤4.5s → gone。**证据路径** /tmp/pi-r43-hEncj8ku/log-reap4818-r43.txt。
  脚本未持 ChildProcess 句柄 → exit/close/OS-wait **无正向证据，记 unknown**；不以事后
  ps 空 追认 join。此后未再 kill/扫描。
- 违规/偏差（原样保留）：① `python3 -c ""` 空跑 ×2（裸 python3，无副作用，已停止）；
  ② 直接 bash `ps -p 4818`/`ps -g 4818` 诊断各一次（无 timeout 包装）；③ 误跑
  `npm run test:bounded.sig`（不存在 target，92ms exit 1）；④ 两次 runner 误共用
  --run-id full-bounded-r43（日志文件不同，无覆盖）；⑤ 全量首轮 runner 被 tool SIGKILL
  终态 unknown（如上）；⑥ 一次 scratch 探针设计错误（"{" 单字符 <12 误判类成员）当轮
  即以无量纲探针纠正；⑦ coor 侧 check 过滤延迟致 ask 超时一次（coor 自留记录，非我方
  违规）；⑧ /tmp 早期探针文件（regex-fact*.mjs 等）写盘 0644 于 0700 root 内。
- prov-r43.jsonl：coor 读时为空——本轮 ledger 未持续写入（偏差如实，不后补假称 prearmed）；
  本文件与本 doc 即足迹记录，manifest 见 evidence root。

## 5. 交付物与状态

- 产品：src/modelgw/secrets.ts、src/modelgw/server.ts（未改逻辑，仅 R41 注释引用面）、
  scripts/bounded-test-runner.ts；测试：tests/modelgw.test.ts、tests/bounded-runner.test.ts。
- 状态：S2 维持 partial（DLP≠企业合规、B2 pending、强 OS 隔离=B12 external、G1 全 3s/
  G3/54m57s unknown 原样）；S3–S6 pending、S7 受 S6+测量前置。本轮不自称全功能完成；
  后续独立 Grok 在冻结代码上复审，B2 实做另派。
