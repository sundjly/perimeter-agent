import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { signV4 } from "../src/modelgw/sigv4.ts";

/**
 * 与独立实现交叉验证 SigV4。
 *
 * 为什么需要这一层：单一官方向量（get-vanilla）的路径就是 `/`，恰好绕开了
 * canonicalUri 的全部逻辑 —— 第一版把非 S3 的「双重编码」写成了 S3 的
 * 「解码后单次编码」，get-vanilla 照样绿，而真实的 Bedrock 模型 id
 * （`anthropic.claude-...-v1:0` → URL 里是 `%3A`）每个请求都会 403。
 * 那个 bug 是靠与 aws4 对拍才发现的，所以把这个方法固化下来。
 *
 * aws4 是 aws-sdk-js v2 使用的签名实现，与本仓库的实现完全独立，
 * 且自身跑 AWS 官方的 aws4_testsuite 全套向量。
 *
 * **证明的边界要说准确**：在下面这批输入形态与四种头集合组合上，两个独立
 * 实现的 Authorization 头逐字符一致。**不是**全域一致（已知两处差异落在
 * 本网关到不了的输入空间里：空 query key、fragment），更**不等于**
 * 「对真实 AWS 验证过」—— 后者需要真实凭据。
 */

const require_ = createRequire(import.meta.url);
let aws4: {
	sign: (opts: Record<string, unknown>, creds: Record<string, string>) => { headers: Record<string, string> };
} | null = null;
try {
	aws4 = require_("aws4");
} catch (err) {
	// 只有「没装」才跳过。加载失败（版本不兼容、文件损坏）必须抛 ——
	// 否则真失败会伪装成 skip，正是这个文件要防的那类问题。
	if ((err as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw err;
	aws4 = null;
}

const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const REGION = "us-east-1";
const SERVICE = "bedrock";
const HOST = "bedrock-runtime.us-east-1.amazonaws.com";

/** 真实会遇到的路径形态，重点是 Bedrock 的模型 id 与 ARN */
const CASES: { name: string; path: string; body: string; method?: string }[] = [
	{ name: "根路径", path: "/", body: "" },
	{ name: "Bedrock 模型 id（含 %3A）", path: "/model/anthropic.claude-sonnet-4-20250514-v1%3A0/invoke", body: '{"x":1}' },
	{ name: "Bedrock OpenAI 兼容端点", path: "/openai/v1/chat/completions", body: '{"model":"m"}' },
	{
		name: "推理配置 ARN（含大量 %2F）",
		path: "/model/arn%3Aaws%3Abedrock%3Aus-east-1%3A123456789012%3Ainference-profile%2Fus.anthropic.claude%3A0/invoke",
		body: "{}",
	},
	{ name: "重复斜杠", path: "/model//invoke", body: "{}" },
	{ name: "点段", path: "/a/./b", body: "{}" },
	{ name: "父目录段", path: "/a/c/../b", body: "{}" },
	{ name: "空格已编码", path: "/%20/foo", body: "{}" },
	{ name: "星号", path: "/a*b", body: "{}" },
	{ name: "已编码的星号", path: "/a%2Ab", body: "{}" },
	{ name: "波浪线（unreserved，不该编码）", path: "/a~b", body: "{}" },
	{ name: "query 乱序", path: "/x?b=2&a=1", body: "{}" },
	{ name: "query 重复 key（要按 value 排序）", path: "/x?a=2&a=1", body: "{}" },
	{ name: "query 含特殊字符", path: "/x?k=a%20b&j=c%2Fd", body: "{}" },
	{ name: "尾部斜杠", path: "/model/", body: "{}" },
	{ name: "GET 空 body", path: "/ping", body: "", method: "GET" },
];

/**
 * 四种头集合。**生产走的是 sha=true**，而此前这条对拍只跑过 sha=false ——
 * 也就是说 AWS 实际校验的那个 canonical request 一次都没被比对过。
 * 临时凭据（IRSA/STS）在企业里是常态，同样要覆盖。
 */
const VARIANTS: { name: string; sha: boolean; token?: string }[] = [
	{ name: "无 content-sha", sha: false },
	{ name: "带 content-sha（生产形态）", sha: true },
	{ name: "临时凭据", sha: false, token: "STSTOKEN==" },
	{ name: "带 content-sha + 临时凭据（IRSA 形态）", sha: true, token: "STSTOKEN==" },
];

for (const v of VARIANTS) {
	for (const c of CASES) {
		test(`交叉验证[${v.name}]：${c.name}`, { skip: aws4 ? false : "未安装 aws4（它在 devDependencies 里）" }, () => {
			const method = c.method ?? "POST";
			const [pathname, search] = c.path.split("?");

			const theirHeaders: Record<string, string> = { "content-type": "application/json" };
			if (v.sha) theirHeaders["x-amz-content-sha256"] = createHash("sha256").update(c.body).digest("hex");

			// aws4 内部用 new Date()，mock 不住；改为读出它用的时间戳再喂给
			// 本实现，把「时间」这个自由变量消掉。X-Amz-Date 精度到秒，
			// 反解出的 Date 毫秒为 0，两边必然同串，不会 flake。
			const theirs = aws4!.sign(
				{
					host: HOST,
					method,
					path: search ? `${pathname}?${search}` : pathname,
					headers: theirHeaders,
					body: c.body,
					service: SERVICE,
					region: REGION,
				},
				{ ...CREDS, ...(v.token ? { sessionToken: v.token } : {}) },
			);
			const stamp = theirs.headers["X-Amz-Date"]!;

			// aws4 对有 body 的请求自动补 content-length 并签它。
			// 这是双方输入不同，不是算法分歧 —— 显式对齐才比得出算法本身。
			const extra: Record<string, string> = c.body ? { "content-length": String(Buffer.byteLength(c.body)) } : {};
			const mine = signV4({
				method,
				url: `https://${HOST}${c.path}`,
				headers: { "content-type": "application/json", ...extra },
				body: c.body,
				region: REGION,
				service: SERVICE,
				...CREDS,
				sessionToken: v.token,
				includeContentSha: v.sha,
				now: parseAmzDate(stamp),
			});

			// 比整个 Authorization 头而不只是 signature：Credential 的 scope 串、
			// SignedHeaders 列表、逗号与空格的格式，AWS 也都解析
			assert.equal(mine.authorization, theirs.headers.Authorization, c.path);
		});
	}
}

function parseAmzDate(stamp: string): Date {
	return new Date(
		`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
	);
}
