import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * S4b：模型网关的短期 scoped 服务凭证（handoff §4.3「网关身份派生归属」、§5.2 可信身份）。
 *
 * 语义边界，一条都不能让：
 * - 签名算法固定 HMAC-SHA256 + 共享密钥：没有算法协商头（JWT alg 混淆的教训）。
 *   所有失败都归入固定类别，公共响应一律 401「未授权」，类别只进审计（server.ts 侧）。
 * - 字段最少够用：aud（固定 "perimeter-modelgw"，防凭证跨服务重放）、tenant/team/sessionId
 *   （计费归属三元组）、exp（秒级短期）、jti（凭证唯一 id，兼作账本 operationId 命名空间）。
 * - **先验签名再读内容**：payload 在签名通过前不当事实来源；aud/exp 校验都在签名之后。
 * - 签名比较用 timingSafeEqual（常量时间）；长度不等也跑一次等长比较，不用时长泄漏长度。
 * - 归属只来自凭证：x-perimeter-team / x-perimeter-actor 等请求头不参与计费归属
 *   （在 server.ts 执行；本模块只管凭证本身）。
 * - mintScopedToken() 供网关给每个会话签发（S4c 接线，不在本轮）；密钥只存在于网关进程，
 *   与静态网关 token、上游模型凭据互不相同。
 */

/** 固定受众：凭证只对模型网关有效，别的服务即使拿到也验不过 aud */
export const SCOPED_TOKEN_AUDIENCE = "perimeter-modelgw";

/** HMAC-SHA256 密钥下限（32 字节 = 256 位；弱密钥在构造期直接拒，不给静默降级） */
export const MIN_SCOPED_KEY_BYTES = 32;

export type ScopedTokenRejectReason = "malformed" | "bad_signature" | "bad_audience" | "expired";

export interface ScopedTokenIdentity {
	tenant: string;
	team: string;
	sessionId: string;
	/** 凭证唯一 id；网关用它派生账本 operationId（<jti>:<序号>），客户端字符串不参与 */
	jti: string;
}

export type ScopedTokenVerifyResult =
	| { ok: true; identity: ScopedTokenIdentity }
	| { ok: false; reason: ScopedTokenRejectReason };

/** 归属字段字符集：容纳 principal 形态（如 https://issuer|sub），挡控制字符与超长 */
const ID_FIELD = /^[A-Za-z0-9._:@/|+-]{1,200}$/;

/** token 总长上界：六个字段 + 签名远小于此；超长直接 malformed，不做无界解析 */
const MAX_TOKEN_LENGTH = 4096;

export function assertScopedTokenKey(key: Buffer): void {
	if (!Buffer.isBuffer(key) || key.length < MIN_SCOPED_KEY_BYTES) {
		throw new Error(`模型网关 scopedTokenKey 必须是至少 ${MIN_SCOPED_KEY_BYTES} 字节的 Buffer`);
	}
}

function hmac(key: Buffer, body: string): Buffer {
	return createHmac("sha256", key).update(body, "utf8").digest();
}

/** 严格 Base-64url（URL 安全字母表，无 padding）解码：Buffer.from 会静默跳过非法字符，所以先查字符集与长度 */
function decodeB64url(s: string): Buffer | undefined {
	if (s.length === 0 || s.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(s)) return undefined;
	return Buffer.from(s, "base64url");
}

export interface MintScopedTokenOptions {
	tenant: string;
	team: string;
	sessionId: string;
	/** 有效期；向上取整到秒，最小 1s —— 不发永久凭证 */
	ttlMs: number;
	/** 缺省随机 UUID；S4c 按会话签发时可显式指定以便对账 */
	jti?: string;
	/** 测试注入当前时间；缺省 Date.now() */
	now?: number;
}

export function mintScopedToken(key: Buffer, opts: MintScopedTokenOptions): string {
	assertScopedTokenKey(key);
	// 签发侧就校验归属字段：签出去的 token 必须能通过 verify，坏字段不该等到验签时才发现
	for (const [name, value] of [["tenant", opts.tenant], ["team", opts.team], ["sessionId", opts.sessionId]] as const) {
		if (typeof value !== "string" || !ID_FIELD.test(value)) throw new Error(`mintScopedToken：${name} 取值非法`);
	}
	if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) throw new Error("mintScopedToken：ttlMs 必须是正数");
	if (opts.jti !== undefined && (typeof opts.jti !== "string" || !ID_FIELD.test(opts.jti))) {
		throw new Error("mintScopedToken：jti 取值非法");
	}
	const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
	const payload = {
		aud: SCOPED_TOKEN_AUDIENCE,
		tenant: opts.tenant,
		team: opts.team,
		sessionId: opts.sessionId,
		exp: nowSec + Math.max(1, Math.ceil(opts.ttlMs / 1000)),
		jti: opts.jti ?? randomUUID(),
	};
	const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
	return `${body}.${hmac(key, body).toString("base64url")}`;
}

export function verifyScopedToken(token: string, key: Buffer, now = Date.now()): ScopedTokenVerifyResult {
	assertScopedTokenKey(key);
	if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
	const dot = token.indexOf(".");
	// 恰好两段（JWT 三段式直接 malformed —— 不认别的格式）
	if (dot <= 0 || token.indexOf(".", dot + 1) >= 0) return { ok: false, reason: "malformed" };
	const body = token.slice(0, dot);
	const bodyBuf = decodeB64url(body);
	const sigBuf = decodeB64url(token.slice(dot + 1));
	if (bodyBuf === undefined || sigBuf === undefined) return { ok: false, reason: "malformed" };
	const expected = hmac(key, body);
	if (sigBuf.length !== expected.length) {
		timingSafeEqual(expected, expected); // 长度不等：跑一次等长比较抹平时长差，再固定拒绝
		return { ok: false, reason: "bad_signature" };
	}
	if (!timingSafeEqual(sigBuf, expected)) return { ok: false, reason: "bad_signature" };
	// 签名通过后，payload 才是事实来源
	let payload: unknown;
	try {
		payload = JSON.parse(bodyBuf.toString("utf8"));
	} catch {
		return { ok: false, reason: "malformed" };
	}
	if (typeof payload !== "object" || payload === null) return { ok: false, reason: "malformed" };
	const p = payload as Record<string, unknown>;
	if (p.aud !== SCOPED_TOKEN_AUDIENCE) return { ok: false, reason: "bad_audience" };
	if (typeof p.exp !== "number" || !Number.isFinite(p.exp)) return { ok: false, reason: "malformed" };
	if (p.exp * 1000 <= now) return { ok: false, reason: "expired" };
	for (const [name, value] of [["tenant", p.tenant], ["team", p.team], ["sessionId", p.sessionId], ["jti", p.jti]] as const) {
		if (typeof value !== "string" || !ID_FIELD.test(value)) return { ok: false, reason: "malformed" };
	}
	return {
		ok: true,
		identity: { tenant: p.tenant as string, team: p.team as string, sessionId: p.sessionId as string, jti: p.jti as string },
	};
}
