import assert from "node:assert/strict";
import { test } from "node:test";
import { signV4 } from "../src/modelgw/sigv4.ts";

/**
 * SigV4 只有一种验证方式算数：官方测试向量。
 * 自己实现的签名「看起来对」毫无意义 —— 签错了 AWS 会直接 403，
 * 而那时错误信息不会告诉你是哪一步算错。
 *
 * **这里只有 get-vanilla 一条是官方向量**（凭据是 AWS 文档里的示例值），
 * 它逐字符比对签名值。其余几条是行为断言：它们能区分对错分支
 * （比如 S3 与非 S3 的路径编码规则），但不能独立证明算法整体正确。
 * 要更强的保证，应当把 aws4_testsuite 的全套向量导进来。
 */

const CREDS = {
	accessKeyId: "AKIDEXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
	region: "us-east-1",
	service: "service",
	now: new Date("2015-08-30T12:36:00Z"),
};

test("官方测试向量 get-vanilla：签名值逐字符匹配", () => {
	// 向量的前提是只签 host 与 x-amz-date，所以关掉 content-sha256。
	// 这一条是整个文件里唯一能证明「算法实现正确」的断言 —— 其余几条
	// 只能证明「某个输入变了签名也变」。
	const headers = signV4({
		method: "GET",
		url: "https://example.amazonaws.com/",
		headers: {},
		body: "",
		includeContentSha: false,
		...CREDS,
	});
	assert.equal(
		headers.authorization,
		"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
			"SignedHeaders=host;x-amz-date, " +
			"Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
	);
});

test("Bedrock 模式下带 x-amz-content-sha256 并让它参与签名", () => {
	const headers = signV4({ method: "GET", url: "https://example.amazonaws.com/", headers: {}, body: "", ...CREDS });
	// 空 body 的 sha256 是一个众所周知的常量
	assert.equal(headers["x-amz-content-sha256"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	assert.match(headers.authorization!, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
});

test("签名密钥逐级派生 —— 原始 secret 不直接参与最终签名", () => {
	// 同样的请求换一个 region，签名必须变（说明 region 真的进了派生链）
	const a = signV4({ method: "GET", url: "https://x.amazonaws.com/", headers: {}, body: "", ...CREDS });
	const b = signV4({ ...CREDS, method: "GET", url: "https://x.amazonaws.com/", headers: {}, body: "", region: "eu-west-1" });
	assert.notEqual(sigOf(a), sigOf(b));
	assert.match(b.authorization!, /\/eu-west-1\//);
});

test("body 参与签名 —— Bedrock 的 InvokeModel 请求体改一个字节签名就变", () => {
	const base = { method: "POST", url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/x/invoke", headers: {}, ...CREDS };
	const a = signV4({ ...base, body: '{"prompt":"hello"}' });
	const b = signV4({ ...base, body: '{"prompt":"hellp"}' });
	assert.notEqual(sigOf(a), sigOf(b));
	assert.notEqual(a["x-amz-content-sha256"], b["x-amz-content-sha256"]);
});

test("query 参数按 key 排序后参与签名，顺序不影响结果", () => {
	const base = { method: "GET", headers: {}, body: "", ...CREDS };
	const a = signV4({ ...base, url: "https://x.amazonaws.com/?b=2&a=1" });
	const b = signV4({ ...base, url: "https://x.amazonaws.com/?a=1&b=2" });
	assert.equal(sigOf(a), sigOf(b), "canonical query 必须排序，否则同一请求两种写法签出两个签名");
});

test("双重编码：`*` 与 `%2A` 必须签出不同的签名", () => {
	// 反过来（视为同一形式）就是 S3 的规则，用在 Bedrock 上必然 403
	const a = signV4({ method: "GET", url: "https://x.amazonaws.com/a*b", headers: {}, body: "", ...CREDS });
	const b = signV4({ method: "GET", url: "https://x.amazonaws.com/a%2Ab", headers: {}, body: "", ...CREDS });
	assert.notEqual(sigOf(a), sigOf(b));
});

test("路径规范化：折叠重复斜杠、消解 . 与 ..", () => {
	const sign = (path: string) =>
		sigOf(signV4({ method: "GET", url: `https://x.amazonaws.com${path}`, headers: {}, body: "", ...CREDS }));
	assert.equal(sign("/model//invoke"), sign("/model/invoke"));
	assert.equal(sign("/a/./b"), sign("/a/b"));
	assert.equal(sign("/a/c/../b"), sign("/a/b"));
});

test("临时凭据的 session token 进签名头", () => {
	const h = signV4({ method: "GET", url: "https://x.amazonaws.com/", headers: {}, body: "", ...CREDS, sessionToken: "TOK" });
	assert.equal(h["x-amz-security-token"], "TOK");
	assert.match(h.authorization!, /x-amz-security-token/, "它必须参与签名，否则 AWS 会拒");
});

test("host 由 URL 推出，调用方不必也不该自己传", () => {
	const h = signV4({ method: "GET", url: "https://bedrock-runtime.eu-west-1.amazonaws.com/", headers: {}, body: "", ...CREDS });
	assert.equal(h.host, "bedrock-runtime.eu-west-1.amazonaws.com");
});

function sigOf(headers: Record<string, string>): string {
	return /Signature=([0-9a-f]+)/.exec(headers.authorization!)![1]!;
}

test("调用方传大小写混用的 header 不会签出重复项", () => {
	// `Host` 与内部写入的 `host` 并存会签出 SignedHeaders=host;host，
	// 而且返回的 map 里还留着调用方那个（可能是伪造的）值
	const h = signV4({
		method: "POST",
		url: "https://real.amazonaws.com/",
		headers: { Host: "evil.example.com", "Content-Type": "application/json", "content-type": "text/plain" },
		body: "{}",
		...CREDS,
	});
	const signed = /SignedHeaders=([^,]+)/.exec(h.authorization!)![1]!;
	assert.deepEqual(signed.split(";"), [...new Set(signed.split(";"))], "SignedHeaders 不得有重复项");
	assert.equal(h.host, "real.amazonaws.com", "host 必须由 url 推出，不接受调用方覆盖");
});
