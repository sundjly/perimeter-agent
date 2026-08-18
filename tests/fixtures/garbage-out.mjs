// 输出一行不可解析的内容，验证协议错误不打断会话
process.stdout.write("not json\n");
setTimeout(() => {}, 200);
