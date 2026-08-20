import { createHash, createHmac } from "node:crypto";

export interface SigV4Input {
	method: string;
	/** 完整 URL，含 query */
	url: string;
	/** 已有的请求头。host 会被自动补上 */
	headers: Record<string, string>;
	/** 请求体。Bedrock 的 InvokeModel 是 JSON，签名要对它做 hash */
	body: string | Buffer;
	region: string;
	/** bedrock / bedrock-runtime 等 */
	service: string;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	/**
	 * 是否加 x-amz-content-sha256 并让它参与签名。
	 * Bedrock 要求带（默认 true）；有些 AWS 服务不接受这个头，
	 * 官方测试向量也是在不带它的前提下算的。
	 */
	includeContentSha?: boolean;
	/** 仅供测试注入固定时间 */
	now?: Date;
}

/**
 * AWS SigV4 签名。
 *
 * 自己实现而不是引 `@aws-sdk/client-bedrock-runtime`：那个包会把依赖树从
 * 两个（ws + yaml）拉到上百个，而网关这里只需要「给一个 HTTP 请求加签名头」
 * 这一件事 —— 我们**不解析也不构造 Bedrock 的 body**，沙箱里的 pi 发什么
 * 原生格式就转发什么。模型网关的职责是出口控制与凭据注入，不是协议转换。
 *
 * 算法本身有官方测试向量（aws4_testsuite），见配套测试。
 */
export function signV4(input: SigV4Input): Record<string, string> {
	const now = input.now ?? new Date();
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20150830T123600Z
	const dateStamp = amzDate.slice(0, 8);
	const url = new URL(input.url);

	const headers: Record<string, string> = { ...input.headers, host: url.host, "x-amz-date": amzDate };
	if (input.sessionToken) headers["x-amz-security-token"] = input.sessionToken;

	const payloadHash = sha256Hex(input.body);
	if (input.includeContentSha !== false) headers["x-amz-content-sha256"] = payloadHash;

	// ── 1. canonical request ──
	const sorted = Object.keys(headers)
		.map((k) => [k.toLowerCase(), headers[k]!] as const)
		.sort((a, b) => (a[0] < b[0] ? -1 : 1));
	const canonicalHeaders = `${sorted.map(([k, v]) => `${k}:${v.trim().replace(/\s+/g, " ")}`).join("\n")}\n`;
	const signedHeaders = sorted.map(([k]) => k).join(";");
	const canonicalRequest = [
		input.method.toUpperCase(),
		canonicalUri(url.pathname),
		canonicalQuery(url.searchParams),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join("\n");

	// ── 2. string to sign ──
	const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
	const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

	// ── 3. 派生签名密钥：逐级 HMAC，原始 secret 不直接参与最终签名 ──
	const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
	const kRegion = hmac(kDate, input.region);
	const kService = hmac(kRegion, input.service);
	const kSigning = hmac(kService, "aws4_request");
	const signature = hmac(kSigning, stringToSign).toString("hex");

	headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
	return headers;
}

/**
 * canonical URI（**非 S3** 服务的规则）。两步：
 *
 * 1. RFC3986 路径规范化：折叠重复的 `/`、丢掉 `.`、弹出 `..`
 * 2. 对已经百分号编码过的路径**再编码一次**（`%3A` → `%253A`）
 *
 * 第 2 步最容易搞错：直觉是「解码后编码一次」，那是 S3 的分支。
 * 用错的后果非常具体 —— Bedrock 的模型 id 一律形如
 * `anthropic.claude-...-v1:0`，URL 里是 `%3A`，签名对不上就是每个请求
 * 都拿 403 SignatureDoesNotMatch，而 AWS 不会告诉你是哪一步算错。
 */
function canonicalUri(pathname: string): string {
	if (!pathname || pathname === "/") return "/";
	const out: string[] = [];
	for (const seg of pathname.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") out.pop();
		else out.push(encodeRfc3986(seg));
	}
	const joined = `/${out.join("/")}`;
	// 保留原路径的尾部斜杠语义
	return pathname.endsWith("/") && joined !== "/" ? `${joined}/` : joined;
}

/** query 按 key 排序，key 与 value 都要 RFC3986 转义 */
function canonicalQuery(params: URLSearchParams): string {
	const pairs: [string, string][] = [];
	for (const [k, v] of params) pairs.push([encodeRfc3986(k), encodeRfc3986(v)]);
	pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
	return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/** encodeURIComponent 漏了 ! ' ( ) * —— AWS 要求它们也编码 */
function encodeRfc3986(s: string): string {
	return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256Hex(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
	return createHmac("sha256", key).update(data, "utf8").digest();
}
