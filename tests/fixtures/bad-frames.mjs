// 合法 JSON 但不是对象 —— 属性访问会崩掉整个网关进程
process.stdout.write("null\n123\n\"str\"\nnot json\n");
process.stdout.write('{"type":"agent_start"}\n');
setTimeout(() => {}, 500);
