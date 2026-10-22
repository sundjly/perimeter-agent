# S2-B2 scoped-grants R63 实现记录（coder：Pi）

- 日期：2026-10-20；响应 grok-s2-scm-scoped-grants-round-7.md §3 required：R-Q62-1（git-grants 例 8 静态红）。
- 修复：tests/git-grants.test.ts「grant 验证失败 reason 全部固定类别」用例改为 `assert.throws(() => signGrant(原参数), (e) => e instanceof Error && e.message === "caps.writeRefs 非法（固定类别，不透传原文）" && !e.message.includes("not-a-ref"))`。
- 原因：writeRefs glob 校验在 validateClaims 无条件生效（签发/验证共用，src/gitproxy/grants.ts:104），非法 writeRefs 使 signGrant 同步抛 GrantError，原「先签后验」写法不可达 verify 分支。
- 范围：仅该一个 test()，测试计数不变（git-grants 11 例；driver EXPECTED=64 不动）；生产代码与 driver 零改动。
- 纪律：本轮仅 native read/edit/write + Orca 协调命令；typecheck/tests 未运行（unrun）。
