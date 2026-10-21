import { createHash, createSign } from "node:crypto";
import { signV4 } from "./sigv4.ts";

/**
 * 上游认证方式。
 *
 * 策略文档 §7.2 把「Bedrock / Vertex / Azure OpenAI / 自托管 vLLM」列为
 * **必须**支持 —— 那是企业唯一能过审的模型通道。
 *
 * 支持方式是「**OpenAI 兼容面 + 各自的认证**」，不是协议转换：
 * 沙箱发 OpenAI 格式，网关注入认证后打到上游的 OpenAI 兼容端点
 * （Azure、vLLM 原生就是；Bedrock 有 /openai/v1/chat/completions；
 * Vertex 有 .../endpoints/openapi/chat/completions）。
 *
 * **不要理解成「沙箱发原生格式、网关只管转发」** —— 那条路走不通：
 * 要产出 Bedrock 原生 body 就得在沙箱里跑 AWS SDK 并持有 AWS 凭据，
 * 而把凭据挡在沙箱外正是这个网关存在的理由。
 *
 * 网关因此不解析 body，只按上游类型选认证方式与路径。这条边界让本文件
 * 保持在 100 行出头，也让「加一个 provider」不等于「再实现一遍它的 API」。
 */
export type UpstreamAuth =
	/** Authorization: Bearer <key>，或自定义 header（Azure 用 api-key） */
	| { kind: "static"; apiKey: string; header?: string }
	/** AWS Bedrock：SigV4 签名 */
	| { kind: "sigv4"; accessKeyId: string; secretAccessKey: string; sessionToken?: string; region: string; service?: string }
	/** Google Vertex：service account → OAuth2 access token（1 小时有效，需缓存） */
	| { kind: "gcp"; clientEmail: string; privateKey: string; scope?: string };

export interface SignedRequest {
	headers: Record<string, string>;
}

/**
 * 为一次上游请求算出认证头。
 * fetchImpl 只有 gcp 分支用得到（换 token 是一次网络调用），注入是为了可测。
 */
export async function authorizeUpstream(
	auth: UpstreamAuth,
	req: { method: string; url: string; body: string },
	fetchImpl: typeof fetch = fetch,
): Promise<SignedRequest> {
	switch (auth.kind) {
		case "static":
			return {
				headers: auth.header ? { [auth.header]: auth.apiKey } : { authorization: `Bearer ${auth.apiKey}` },
			};
		case "sigv4":
			return {
				headers: signV4({
					method: req.method,
					url: req.url,
					headers: { "content-type": "application/json" },
					body: req.body,
					region: auth.region,
					service: auth.service ?? "bedrock",
					accessKeyId: auth.accessKeyId,
					secretAccessKey: auth.secretAccessKey,
					sessionToken: auth.sessionToken,
				}),
			};
		case "gcp":
			return { headers: { authorization: `Bearer ${await gcpAccessToken(auth, fetchImpl)}` } };
	}
}

interface CachedToken {
	token: string;
	expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();
/** 正在换的 token。缓存 Promise 而不是字符串，否则 N 个并发请求会打出 N 次换取 */
const inflight = new Map<string, Promise<string>>();

/**
 * service account → access token。
 *
 * Vertex 的 token 只有 1 小时有效期，所以静态配一个 token 是不实用的 ——
 * 必须能自己换。缓存到期前 60 秒刷新：正好卡在边界上换会在时钟有偏差的
 * 节点上间歇性 401，而那种失败极难复现。
 */
/** 换 token 的固定出口。它也该在 allowlist 里 —— 见 config/policy.yaml 的注释 */
export const GCP_TOKEN_HOST = "oauth2.googleapis.com";

export async function gcpAccessToken(
	auth: Extract<UpstreamAuth, { kind: "gcp" }>,
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	const scope = auth.scope ?? "https://www.googleapis.com/auth/cloud-platform";
	// key 带私钥指纹：SA 轮换密钥后不该继续用旧 token 到过期
	const key = `${auth.clientEmail}:${scope}:${createHash("sha256").update(auth.privateKey).digest("hex").slice(0, 12)}`;
	const hit = tokenCache.get(key);
	if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;

	const pending = inflight.get(key);
	if (pending) return pending;

	const task = refresh(auth, scope, key, fetchImpl).finally(() => inflight.delete(key));
	inflight.set(key, task);
	return task;
}

async function refresh(
	auth: Extract<UpstreamAuth, { kind: "gcp" }>,
	scope: string,
	key: string,
	fetchImpl: typeof fetch,
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const claims = {
		iss: auth.clientEmail,
		scope,
		aud: "https://oauth2.googleapis.com/token",
		iat: now,
		exp: now + 3600,
	};
	const jwt = signJwtRs256(claims, auth.privateKey);

	let res: Response;
	try {
		res = await fetchImpl(`https://${GCP_TOKEN_HOST}/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString(),
			// 没有超时的话 Google 挂起会让这条请求永远挂着
			signal: AbortSignal.timeout(10_000),
			// B3：token 端点同样逐跳拒绝重定向 —— 换 token 的请求携带凭据断言，
			// 跟随重定向等于把断言发到未批准目的地（跨/同 host 多跳都拒）。
			redirect: "error",
		});
	} catch (err) {
		return fallbackOrThrow(key, `换取 GCP access token 失败：${err instanceof Error ? err.message : String(err)}`);
	}
	if (!res.ok) {
		return fallbackOrThrow(key, `换取 GCP access token 失败：${res.status} ${await res.text()}`);
	}
	const data = (await res.json()) as { access_token?: string; expires_in?: number };
	if (!data.access_token) return fallbackOrThrow(key, "GCP 未返回 access_token");

	tokenCache.set(key, { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 });
	return data.access_token;
}

/**
 * 刷新失败时回退到手上仍然可用的旧 token。
 * 刷新是在过期前 60 秒发起的，此时旧 token 往往还能用 —— Google 抖一下
 * 就把它扔掉、直接 502，是没必要的脆弱。
 */
function fallbackOrThrow(key: string, message: string): string {
	const hit = tokenCache.get(key);
	if (hit && hit.expiresAt > Date.now()) {
		console.error(`${message}（回退到尚未过期的旧 token）`);
		return hit.token;
	}
	throw new Error(message);
}

/** 仅供测试：清掉 token 缓存 */
export function clearTokenCache(): void {
	tokenCache.clear();
	inflight.clear();
}

function signJwtRs256(claims: object, privateKey: string): string {
	const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = b64url(JSON.stringify(claims));
	const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey);
	return `${header}.${payload}.${b64url(signature)}`;
}

function b64url(data: string | Buffer): string {
	return Buffer.from(data).toString("base64url");
}
