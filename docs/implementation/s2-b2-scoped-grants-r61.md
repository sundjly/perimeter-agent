# S2-B2 修复轮（R61）：R60 五 required 修（task_dbc1eb6d2095 / ctx_ee0aee9088af）

- 日期：2026-10-20。执行者：Pi（原 terminal/incarnation/model 未换）。权限同 R59 收紧：
  仅 native read/edit/write + preamble 准确 Orca 命令（本轮 bash 零其他命令、零解释器/
  heredoc/sed/cat）；ledger/hash/封版全由 coor。typecheck/tests=**unrun/unknown**。
- 根：/tmp/pi-r61-aCT6jSv1（coor 预置 0700；prov coor 独占未写）。baseline38 双侧+二次源
  hash 匹配（coor 亲核）；prior-driver-r59.mjs 为 coor 预置参考。

## 1. R60 五 required 逐项

1. **merge-issue.test 4 处调用去 NOW 实参（3 参对齐实现）**：例 1–5 全部改为
   `mergeIssueIntoEntry(e, principal, signed)`；例 5（different owner throw）同步改。
2. **byte-budget.test 例 1**：`seed(100,0)` → `seed(1050,0)`（对齐注释意图 100+950，实现
   语义未改）。
3. **OwnedRenewTimer.stop() 补 `this.#gen += 1`**（实现缺陷修复，非改断言）：stop 后旧句
   柄 gen 失效——外部手动触发/迟到触发不再执行 onFire，与重排防护同构；arm 顺序（stop 先、
   新 gen 后）保证正常异步路径不受影响。
4. **driver EXPECTED=64** + merge-issue 注释更正（5 例实数，非 4）。
5. **driver 补 `log.once("error")` 计 fail**（写流 ENOSPC/EPIPE 不再 uncaught 崩进程）；
   `let fail` 声明前移（error 监听引用不 TDZ）。

## 2. driver-candidate-r61.mjs（根内唯一新写，≤80 行，未运行）

基于 prior-driver-r59.mjs（coor 预置）修 R60 §4 两缺陷，其余合格面保持（tap 自
node:test/reporters 函数 + pipeline(tests, tap, log)；guard T0 先于动态 imports；R61_RUN_ROOT
lstat 精检；mkdir recursive:false；wx 0600；major≥24；九文件 isolation:none/concurrency:1；
唯一 overall summary 严格判负；fresh wall 在 pipeline+log close 后；R47 排除）。

## 3. 三态

- source/tests 已落（上列 3 test 文件 + 1 实现文件 + driver）；**unrun/unknown**：全部。
- optional 未动：3xx 分支 preparedDispose、driver 冗余注释、doc 计数更正（本文件 §1.4 已
  更正 merge-issue 计数）、R58 元勘误承接（R59doc §3 已记）。
- B2 partial；S2 partial；17 真实验收/P1/gzip/3HTTP/demo/typecheck/driver 全 pending；
  S3–S6 pending、S7 gated、外部原样。用户已授权 review 通过后由 coor commit 代码（不含
  md），Pi 不做任何 git 操作。source_ready 后 coor 静审/封版，再唯一 done，继续 loop。
