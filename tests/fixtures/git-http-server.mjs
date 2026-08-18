/**
 * 最小的 git smart HTTP 服务端，作为凭据代理的测试上游。
 *
 * 存在的理由：Week 3 的验收标准是「沙箱内 git clone + git push 成功，
 * 且 env | grep -i token 为空」。这条只有用真实的 git 客户端跑通才算数，
 * 用 mock HTTP 断言几个 header 是证明不了的。
 *
 * 用法：node git-http-server.mjs <repoRoot> [requiredAuthHeader]
 * 提供 requiredAuthHeader 时会校验 Authorization，用于验证凭据确实被注入。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.argv[2];
const requiredAuth = process.argv[3];
const seen = [];

function run(cmd, args, req, res, contentType) {
	res.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
	const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
	req.pipe(child.stdin);
	child.stdout.pipe(res);
	child.on("error", () => res.end());
}

const server = createServer((req, res) => {
	const url = new URL(req.url, "http://localhost");
	seen.push({ path: url.pathname, auth: req.headers.authorization ?? null });

	if (requiredAuth && req.headers.authorization !== requiredAuth) {
		res.writeHead(401, { "www-authenticate": 'Basic realm="git"' }).end("unauthorized");
		return;
	}
	if (url.pathname === "/__seen") {
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(seen));
		return;
	}

	const m = url.pathname.match(/^\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/);
	if (!m) {
		res.writeHead(404).end("not found");
		return;
	}
	const dir = join(repoRoot, m[1]);
	if (!existsSync(dir)) {
		res.writeHead(404).end("no such repo");
		return;
	}

	if (m[2] === "info/refs") {
		const service = url.searchParams.get("service");
		if (!service) {
			res.writeHead(400).end("dumb protocol not supported");
			return;
		}
		res.writeHead(200, { "content-type": `application/x-${service}-advertisement`, "cache-control": "no-cache" });
		// smart HTTP 的服务广告前缀
		const head = `# service=${service}\n`;
		res.write(`${(head.length + 4).toString(16).padStart(4, "0")}${head}0000`);
		const child = spawn(service, ["--stateless-rpc", "--advertise-refs", dir], { stdio: ["ignore", "pipe", "inherit"] });
		child.stdout.pipe(res);
		return;
	}

	run(m[2], ["--stateless-rpc", dir], req, res, `application/x-${m[2]}-result`);
});

server.listen(0, "127.0.0.1", () => {
	process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});
