// 忽略 SIGTERM，用于验证 graceMs 后升级 SIGKILL
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
// handler 注册完成后才宣告就绪：否则 SIGTERM 可能early 于 handler 到达
process.stdout.write('{"type":"ready"}\n');
