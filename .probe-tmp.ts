import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Gateway } from "/Users/sundy/projects/web-articles/perimeter-agent/src/gateway/server.ts";
import { DockerBackend } from "/Users/sundy/projects/web-articles/perimeter-agent/src/gateway/execution-backend.ts";
import { WebSocket } from "ws";

const dir = mkdtempSync(join(tmpdir(), "probe-"));
const wsRoot = join(dir, "workspaces");
mkdirSync(wsRoot, { recursive: true });
const gw = new Gateway({
  port: 0, host: "127.0.0.1", token: "gw-token",
  policyFile: "/Users/sundy/projects/web-articles/perimeter-agent/config/policy.yaml",
  auditFile: join(dir, "a.jsonl"),
  workspaceRoot: wsRoot,
  webRoot: "/Users/sundy/projects/web-articles/perimeter-agent/web",
  piArgs: ["--no-session"],
  wiring: { proxyToken: "SUPER-SECRET-PROXY-TOKEN", modelGatewayUrl: "http://mg:8080/v1", model: "m1", gitProxyUrl: "http://gp:8080", scmHosts: ["github.com"] },
  backend: new DockerBackend({ image: "img:test", repoRoot: "/Users/sundy/projects/web-articles/perimeter-agent", env: { EXTRA_OPERATOR_SECRET: "AKIA-EXAMPLE-KEY" } }),
});
const port = await gw.listen();
const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=gw-token&actor=me@x`);
await new Promise((r) => ws.once("open", r));
await new Promise((r) => setTimeout(r, 1500));
// 模拟运维/其他本地用户跑 ps
const ps = execFileSync("ps", ["-Ao", "args="], { encoding: "utf8", maxBuffer: 1 << 26 });
const lines = ps.split("\n").filter((l) => l.includes("docker") && l.includes("run"));
console.log("=== ps -Ao args= 里看到的 docker run 命令行 ===");
console.log(lines.join("\n") || "(未捕获到)");
ws.close();
await gw.close();
process.exit(0);
