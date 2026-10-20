import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * B2 scoped grant —— 会话/repo/rw/writeRefs/exp/jti 六维短期能力凭证。
 *
 * 诚实边界（合同 §A4，措辞合同级约束）：
 * - 沙箱里的 grant 串是**能力凭证**：任何读到它的人，在 exp/吊销之前、网络可达范围内
 *   都能以其原 scope 使用它。本机制没有独立调用者证明（无 mTLS 绑定、无 PoP），
 *   **不存在"无 token/不可盗用"这回事**。
 * - 本模块承诺的边界只有四条：scope 最小化（单 repo、rw 位、writeRefs、≤15min）；
 *   jti+活会话登记使跨 session/跨 repo/吊销后的使用被拒；上游组织凭据永不离开代理；
 *   吊销在有界窗口内（≤pollMs，轮询失败最长 maxStale）全面失效。
 * - ref 级**读**控制本层不可安全交付（v0 want 无 refname、v2 可裸 SHA want）——
 *   GrantClaims 出现 readRefs 字段一律构造期抛错（fail-closed），绝不静默当 repo 级读。
 * - 无 JWT 头/alg 协商：编码固定为 `base64url(payloadJSON) + "." + base64url(HMAC-SHA256)`，
 *   只依赖 node:crypto；算法面没有协商就没有降级攻击。
 */

export const GRANT_MAX_TTL_MS = 15 * 60 * 1000; // 合同 A1：exp ≤ 15 分钟
export const MASTER_KEY_MIN_BYTES = 32; // 合同 A1：≥32B
const PAYLOAD_MAX_BYTES = 8 * 1024; // claims 解析有界（防拼接炸弹/超长串）
const TOKEN_MAX_CHARS = 16 * 1024;

export interface GrantCaps {
	/** repo 级全 refs 读（B5①）——本层唯一可交付的读形态 */
	read: boolean;
	write: boolean;
	/** ref glob（`*` 不跨 `/`，大小写敏感）；write=true 时必须非空（签发端锁死） */
	writeRefs: string[];
}

export interface GrantClaims {
	v: 1;
	tenant: string;
	principal: string;
	session: string;
	repo: string;
	caps: GrantCaps;
	/** 绝对过期（ms epoch）；签发端强制 ≤ now + GRANT_MAX_TTL_MS */
	exp: number;
	jti: string;
	/** 签发方 restart epoch（A6 补项）：代理快照 epoch 与此不等 → 旧 epoch grant 拒 */
	epoch: string;
	/** 签发时 aclVersion（A6 补项）：代理与 registry 快照条目逐一比对，变更即拒 */
	aclVersion: number;
}

export class GrantError extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(`git grant 拒绝: ${reason}`);
		this.name = "GrantError";
		this.reason = reason;
	}
}

export function newJti(): string {
	return randomUUID();
}

function b64urlEncode(buf: Buffer): string {
	return buf.toString("base64url");
}

function b64urlDecode(s: string): Buffer {
	// base64url 严格解码：混入 +/ 或 padding 以外的字符会在长度/字符集上暴露
	if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new GrantError("编码非法");
	return Buffer.from(s, "base64url");
}

function hmac(masterKey: Buffer, payloadB64: string): string {
	// 域分隔：标签 + 0x00 + 载荷，防不同用途的签名跨用
	const h = createHmac("sha256", masterKey).update("perimeter-git-grant-v1\x00").update(payloadB64).digest();
	return b64urlEncode(h);
}

/** claims 形状与界限校验（签发与验证共用同一把尺；readRefs 出现即抛） */
export function validateClaims(claims: unknown, nowMs: number, opts: { issuing: boolean }): GrantClaims {
	if (typeof claims !== "object" || claims === null) throw new GrantError("claims 非对象");
	const c = claims as Record<string, unknown>;
	if (c.v !== 1) throw new GrantError("版本不支持");
	if ("readRefs" in c || ("caps" in c && typeof c.caps === "object" && c.caps !== null && "readRefs" in (c.caps as object))) {
		// B5②：ref 级读控制代理层不可交付——配置/claims 出现即 fail-closed，不静默降级
		throw new GrantError("readRefs 不被支持（ref 级读控制超出代理能力，需上游只读权限）");
	}
	for (const k of ["tenant", "principal", "session", "repo", "jti"] as const) {
		if (typeof c[k] !== "string" || (c[k] as string).length === 0 || (c[k] as string).length > 256) {
			throw new GrantError(`claims.${k} 非法`);
		}
	}
	if (typeof c.exp !== "number" || !Number.isFinite(c.exp)) throw new GrantError("claims.exp 非法");
	if (typeof c.epoch !== "string" || c.epoch.length === 0 || c.epoch.length > 128) throw new GrantError("claims.epoch 非法（restart epoch 必填，A6）");
	if (typeof c.aclVersion !== "number" || !Number.isSafeInteger(c.aclVersion) || c.aclVersion < 1) throw new GrantError("claims.aclVersion 非法（A6 必填，可对比字段）");
	const caps = c.caps;
	if (typeof caps !== "object" || caps === null) throw new GrantError("claims.caps 非法");
	const cc = caps as Record<string, unknown>;
	if (typeof cc.read !== "boolean" || typeof cc.write !== "boolean") throw new GrantError("caps.read/write 必须为布尔");
	if (!Array.isArray(cc.writeRefs) || cc.writeRefs.some((r) => typeof r !== "string")) throw new GrantError("caps.writeRefs 非法");
	const writeRefs = cc.writeRefs as string[];
	if (cc.write === true && writeRefs.length === 0) throw new GrantError("write=true 必须携带 writeRefs");
	if (cc.write === false && writeRefs.length > 0) throw new GrantError("write=false 不得携带 writeRefs");
	if (cc.write === true) {
		for (const r of writeRefs) {
			if (!isValidRefGlob(r)) throw new GrantError("caps.writeRefs 非法（固定类别，不透传原文）");
		}
	}
	if (opts.issuing) {
		// 签发端：TTL 上限锁死（验证端不重复判 now+TTL——验证只看 exp 与 now）
		if (c.exp <= nowMs) throw new GrantError("exp 必须在未来");
		if (c.exp > nowMs + GRANT_MAX_TTL_MS) throw new GrantError(`exp 超过 ${GRANT_MAX_TTL_MS / 1000}min 上限`);
	}
	return {
		v: 1,
		tenant: c.tenant as string,
		principal: c.principal as string,
		session: c.session as string,
		repo: c.repo as string,
		caps: { read: cc.read as boolean, write: cc.write as boolean, writeRefs },
		exp: c.exp,
		jti: c.jti as string,
		epoch: c.epoch as string,
		aclVersion: c.aclVersion as number,
	};
}

export function assertMasterKey(masterKey: Buffer | string): Buffer {
	const key = Buffer.isBuffer(masterKey) ? masterKey : Buffer.from(masterKey, "utf8");
	if (key.length < MASTER_KEY_MIN_BYTES) throw new GrantError(`masterKey 必须 ≥${MASTER_KEY_MIN_BYTES} 字节`);
	return key;
}

/** 签发：payload + HMAC（TTL 在 validateClaims 内锁死 ≤15min） */
export function signGrant(claims: GrantClaims, masterKey: Buffer | string, nowMs: number): string {
	const key = assertMasterKey(masterKey);
	validateClaims(claims, nowMs, { issuing: true });
	const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(claims), "utf8"));
	return `${payloadB64}.${hmac(key, payloadB64)}`;
}

export type VerifyResult =
	| { ok: true; claims: GrantClaims }
	| { ok: false; reason: string };

/** 验证：有界解析 + HMAC（常数时间比较）+ claims 形状 + exp；吊销/登记由调用方查快照 */
export function verifyGrant(token: string, masterKey: Buffer | string, nowMs: number): VerifyResult {
	try {
		if (typeof token !== "string" || token.length === 0 || token.length > TOKEN_MAX_CHARS) {
			return { ok: false, reason: "grant 串缺失或超长" };
		}
		const dot = token.indexOf(".");
		if (dot <= 0 || dot !== token.lastIndexOf(".")) return { ok: false, reason: "grant 格式非法" };
		const payloadB64 = token.slice(0, dot);
		const sigB64 = token.slice(dot + 1);
		const payload = b64urlDecode(payloadB64);
		if (payload.length > PAYLOAD_MAX_BYTES) return { ok: false, reason: "payload 超限" };
		const key = assertMasterKey(masterKey);
		const expected = Buffer.from(hmac(key, payloadB64), "base64url");
		const got = b64urlDecode(sigB64);
		if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
			return { ok: false, reason: "HMAC 验签失败" };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload.toString("utf8"));
		} catch {
			return { ok: false, reason: "payload 非合法 JSON" };
		}
		const claims = validateClaims(parsed, nowMs, { issuing: false });
		if (claims.exp <= nowMs) return { ok: false, reason: "grant 已过期" };
		return { ok: true, claims };
	} catch (e) {
		const reason = e instanceof GrantError ? e.reason : "grant 解析失败";
		return { ok: false, reason };
	}
}

/**
 * ref glob：`*` 不跨 `/`（refs 语义），大小写敏感（git ref 语义），其余字符字面。
 * 独立实现而非复用 pathGlobToRegex（后者大小写不敏感、`**` 跨层——ref 语义都不要）。
 */
export function refGlobMatch(pattern: string, refname: string): boolean {
	let re = "";
	for (const c of pattern) {
		if (c === "*") re += "[^/]*";
		else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`).test(refname);
}

/**
 * refname 合法性（唯一一把尺，receive-pack 与签发方共用；R50 R-Q50-9 收敛）：UTF-8 由
 * 调用方 fatal 解码保证；此处 enforcing Git check-ref-format 规则的验证端子集：refs/
 * 前缀、无空格/控制字符/`~^:?*[\\`、无 `@{`、无 `..`/`//`、分量不以 `.` 开头、分量
 * 不以 `.lock` 结尾、不以 `/` 或 `.` 结尾。
 */
export function isValidRefname(refname: string): boolean {
	if (typeof refname !== "string" || refname.length === 0 || refname.length > 256) return false;
	if (!refname.startsWith("refs/")) return false;
	if (!/^[^\s\x00-\x1f\x7f]+$/.test(refname)) return false;
	if (/[~^:?*\[\\]/.test(refname)) return false;
	if (refname.includes("@{") || refname.includes("..") || refname.includes("//")) return false;
	if (refname.endsWith("/") || refname.endsWith(".") || refname.endsWith(".lock")) return false;
	for (const comp of refname.split("/")) {
		if (comp.length === 0 || comp.startsWith(".") || comp.endsWith(".lock")) return false;
	}
	return true;
}

/** SHA-1（40 hex）——本子集只接受 SHA-1 值域，SHA-256 仓库不在支持声明内（合同 B6 明确取舍） */
export function isSha1(s: string): boolean {
	return /^[0-9a-f]{40}$/.test(s);
}

/**
 * writeRefs glob 形状（H53-b 同尺）：refs/ 前缀、≤256、无 `**`（跨段通配不支持）、
 * `*` 只能在单个分量内（不跨 `/`，与 refGlobMatch 语义一致）、无其它非法 refname 字符。
 * validateClaims 与 Gateway 构造期共用本尺，不再两把。
 */
export function isValidRefGlob(g: string): boolean {
	if (typeof g !== "string" || g.length === 0 || g.length > 256) return false;
	if (!g.startsWith("refs/")) return false;
	if (g.includes("**")) return false;
	if (/[~^:?\[\\]|@\{|\.\.|\/\//.test(g)) return false;
	for (const comp of g.split("/")) {
		if (comp.length === 0 || comp.startsWith(".") || comp.endsWith(".lock")) return false;
		if (comp.includes("*")) {
			// `*` 只能在段内：整段必须为「无空白的非*字符与*的混合」，且至多一个*（与 refGlobMatch 实现一致）
			if (!/^[^\s*/]*\*[^\s*/]*$/.test(comp)) return false;
		}
	}
	return true;
}
