import { createPublicKey, randomBytes, verify, type KeyObject } from "node:crypto";

/**
 * 可信身份：principal 只能由服务端校验凭证得出，永远不来自客户端自报。
 * 本文件只依赖 node:crypto，不引入外部 JWT 库。
 */
export interface Principal {
	/** issuer|sub：不可变主键，不用可变的 email；总长度严格限制在 256 以内 */
	id: string;
	issuer: string;
	subject: string;
	groups: string[];
	/** 毫秒时间戳，连接/会话不得活过它 */
	expiresAt: number;
}

export interface Authenticator {
	authenticate(credential: string, options?: { signal?: AbortSignal }): Promise<Principal>;
	/** share 目标必须是本 IdP 下的 principal id；无此方法则不校验格式 */
	isPrincipalId?(id: string): boolean;
}

export class AuthError extends Error {}

export interface JwkKey {
	kty: string;
	kid?: string;
	use?: string;
	alg?: string;
	crv?: string;
	n?: string;
	e?: string;
	x?: string;
	y?: string;
	[key: string]: unknown;
}

const ALGS: Record<string, { hash: string; kty: "RSA" | "EC"; crv?: string; ieee?: boolean }> = {
	RS256: { hash: "sha256", kty: "RSA" },
	RS384: { hash: "sha384", kty: "RSA" },
	RS512: { hash: "sha512", kty: "RSA" },
	ES256: { hash: "sha256", kty: "EC", crv: "P-256", ieee: true },
	ES384: { hash: "sha384", kty: "EC", crv: "P-384", ieee: true },
};

export interface JwksSource {
	/** kid 缺省时仅当源里恰好一把候选钥匙才返回；未知 kid 触发（限频的）刷新以支持轮换 */
	get(kid: string | undefined, signal?: AbortSignal): Promise<JwkKey | undefined>;
}

export class StaticJwks implements JwksSource {
	keys: JwkKey[];
	constructor(keys: JwkKey[]) {
		this.keys = keys;
	}
	async get(kid: string | undefined, _signal?: AbortSignal): Promise<JwkKey | undefined> {
		return pick(this.keys, kid);
	}
}

function pick(keys: JwkKey[], kid: string | undefined): JwkKey | undefined {
	if (kid !== undefined) return keys.find((key) => key.kid === kid);
	return keys.length === 1 ? keys[0] : undefined;
}

export interface RemoteJwksOptions {
	url: string;
	/** 缓存有效期；超过 maxStaleMs 仍刷新失败则 fail closed */
	ttlMs?: number;
	maxStaleMs?: number;
	/** 刷新尝试的最小间隔，防止缓存失效或故障时高频打 IdP */
	minRefreshMs?: number;
	/** 默认只允许 https；本地测试 IdP 显式放开 */
	allowHttp?: boolean;
	now?: () => number;
}

export class RemoteJwks implements JwksSource {
	#o: Required<Omit<RemoteJwksOptions, "url" | "now">> & { url: URL; now: () => number };
	#keys: JwkKey[] = [];
	#fetched = false;
	#fetchedAt = 0;
	#attempted = false;
	#attemptedAt = 0;
	#inflight?: {
		promise: Promise<void>;
		controller: AbortController;
		waiters: Set<object>;
	};
	#lastError?: Error;

	constructor(o: RemoteJwksOptions) {
		const url = new URL(o.url);
		if (url.protocol !== "https:" && !(o.allowHttp && url.protocol === "http:")) throw new Error("JWKS URL 必须是 https");
		const ttlMs = o.ttlMs ?? 600_000;
		const maxStaleMs = o.maxStaleMs ?? 3_600_000;
		const minRefreshMs = o.minRefreshMs ?? 10_000;
		const now = o.now ?? Date.now;

		if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
			throw new Error("ttlMs 必须是有限正数");
		}
		if (typeof maxStaleMs !== "number" || !Number.isFinite(maxStaleMs) || maxStaleMs <= 0) {
			throw new Error("maxStaleMs 必须是有限正数");
		}
		if (typeof minRefreshMs !== "number" || !Number.isFinite(minRefreshMs) || minRefreshMs < 0) {
			throw new Error("minRefreshMs 必须是有限非负数");
		}
		if (ttlMs > maxStaleMs) {
			throw new Error("ttlMs 不能大于 maxStaleMs");
		}
		if (minRefreshMs > ttlMs) {
			throw new Error("minRefreshMs 不能大于 ttlMs");
		}
		if (typeof now !== "function") {
			throw new Error("now 必须是函数");
		}

		this.#o = { ttlMs, maxStaleMs, minRefreshMs, allowHttp: !!o.allowHttp, now, url };
	}

	async get(kid: string | undefined, signal?: AbortSignal): Promise<JwkKey | undefined> {
		if (signal?.aborted) throw new AuthError("JWKS 请求已取消");
		const now = this.#o.now();
		if (typeof now !== "number" || !Number.isFinite(now)) throw new AuthError("系统时钟异常");
		const age = this.#fetched ? now - this.#fetchedAt : Infinity;
		const fresh = this.#fetched && age >= 0 && age < this.#o.ttlMs && age < this.#o.maxStaleMs;
		if (fresh) {
			const hit = pick(this.#keys, kid);
			if (hit) return hit;
		}

		// 需要刷新：未拉取过、缓存过期或 kid 未命中。
		// 初次尝试（!#attempted）必须执行，不受 minRefreshMs 阻塞（即使 now === 0）
		const canAttempt = !this.#attempted || (now - this.#attemptedAt >= this.#o.minRefreshMs);
		if (this.#inflight) {
			await this.#waitForInflight(signal);
		} else if (canAttempt) {
			await this.#refresh(signal);
		}

		const currentNow = this.#o.now();
		if (typeof currentNow !== "number" || !Number.isFinite(currentNow)) throw new AuthError("系统时钟异常");
		const currentAge = this.#fetched ? currentNow - this.#fetchedAt : Infinity;
		const staleAllowed = this.#fetched && currentAge >= 0 && currentAge < this.#o.maxStaleMs;

		if (staleAllowed) {
			const key = pick(this.#keys, kid);
			if (key) return key;
			return undefined;
		}

		// 超过 maxStaleMs 或从未成功获取过：严格 fail-closed，绝不能返回过期缓存中的 key
		const reason = this.#lastError ? `: ${this.#lastError.message}` : "";
		throw new AuthError(`JWKS 不可用${reason}`);
	}

	async #waitForInflight(signal?: AbortSignal): Promise<void> {
		const inflight = this.#inflight;
		if (!inflight) return;
		if (signal?.aborted) throw new AuthError("JWKS 请求已取消");
		const waiter: { signal?: AbortSignal } = { signal };
		inflight.waiters.add(waiter);

		try {
			if (signal) {
				await new Promise<void>((resolve, reject) => {
					const onAbort = () => {
						signal.removeEventListener("abort", onAbort);
						inflight.waiters.delete(waiter);
						if (inflight.waiters.size === 0) {
							inflight.controller.abort();
						}
						reject(new AuthError("JWKS 请求已取消"));
					};
					signal.addEventListener("abort", onAbort, { once: true });
					inflight.promise.then(
						() => {
							signal.removeEventListener("abort", onAbort);
							resolve();
						},
						(err) => {
							signal.removeEventListener("abort", onAbort);
							reject(err);
						},
					);
				});
			} else {
				await inflight.promise;
			}
		} finally {
			inflight.waiters.delete(waiter);
		}
	}

	#refresh(signal?: AbortSignal): Promise<void> {
		if (this.#inflight) return this.#waitForInflight(signal);
		this.#attempted = true;
		this.#attemptedAt = this.#o.now();
		const controller = new AbortController();
		const waiters = new Set<object>();

		const timer = setTimeout(() => controller.abort(), 5_000);
		timer.unref();

		const promise = (async () => {
			try {
				const res = await fetch(this.#o.url, { redirect: "error", signal: controller.signal });
				if (!res.ok) throw new Error(`status ${res.status}`);
				if (!res.body) throw new Error("缺少响应体");
				const reader = res.body.getReader();
				const chunks: Uint8Array[] = [];
				let totalBytes = 0;
				const MAX_BYTES = 256 * 1024;
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value) {
						totalBytes += value.byteLength;
						if (totalBytes > MAX_BYTES) {
							controller.abort();
							throw new Error("JWKS 超过 256KiB 大小限制");
						}
						chunks.push(value);
					}
				}
				const text = Buffer.concat(chunks).toString("utf8");
				const parsed = JSON.parse(text) as { keys?: unknown };
				if (!Array.isArray(parsed.keys)) throw new Error("JWKS 格式错误");
				if (parsed.keys.length > 32) throw new Error("JWKS key 数量超过限制");
				this.#keys = parsed.keys.filter((k): k is JwkKey => !!k && typeof k === "object" && typeof (k as Record<string, unknown>).kty === "string");
				this.#fetched = true;
				this.#fetchedAt = this.#o.now();
			} catch (err) {
				this.#lastError = err instanceof Error ? err : new Error(String(err));
				/* 刷新失败保留旧缓存（在 maxStaleMs 内），更新 attemptedAt 防打满 IdP */
			} finally {
				clearTimeout(timer);
				this.#inflight = undefined;
			}
		})();

		this.#inflight = { promise, controller, waiters };
		return this.#waitForInflight(signal);
	}
}

export interface JwtOptions {
	issuer: string;
	audience: string;
	jwks: JwksSource;
	/** 默认 RS256/ES256；只能是 ALGS 内的非对称算法，none/HS* 构造时即抛错 */
	algorithms?: string[];
	clockSkewSec?: number;
	groupsClaim?: string;
	now?: () => number;
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const decode = (part: string) => {
	if (!B64URL.test(part)) throw new AuthError("token 编码非法");
	return Buffer.from(part, "base64url");
};
const json = (part: string): Record<string, unknown> => {
	let v: unknown;
	try { v = JSON.parse(decode(part).toString("utf8")); } catch { throw new AuthError("token 编码非法"); }
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new AuthError("token 编码非法");
	return v as Record<string, unknown>;
};

// issuer 不含 | 且长度 <= 160；sub 不含 | 且长度 <= 80，统一拼接为无歧义 ${issuer}|${sub}，总长 <= 241 <= 256
const SUB_REGEX = /^[A-Za-z0-9._~:/-]{1,80}$/;

export class JwtAuthenticator implements Authenticator {
	#o: JwtOptions;
	#algs: string[];
	#keyCache = new WeakMap<object, KeyObject>();

	constructor(o: JwtOptions) {
		if (!o || typeof o !== "object") throw new Error("JwtOptions 必须是对象");
		if (!o.issuer || typeof o.issuer !== "string") throw new Error("必须配置 issuer 与 audience");
		if (!o.audience || typeof o.audience !== "string") throw new Error("必须配置 issuer 与 audience");
		if (o.issuer.includes("|") || o.issuer.length > 160 || /[\x00-\x1f\s]/.test(o.issuer)) {
			throw new Error("issuer 格式非法或超过 160 字符");
		}
		if (o.audience.length > 160 || /[\x00-\x1f\s]/.test(o.audience)) {
			throw new Error("audience 格式非法或超过 160 字符");
		}
		if (!o.jwks || typeof o.jwks.get !== "function") {
			throw new Error("必须提供合法的 jwks 源");
		}

		const algs = o.algorithms ?? ["RS256", "ES256"];
		if (!Array.isArray(algs) || algs.length === 0) {
			throw new Error("算法 allowlist 只能含 RS256/384/512、ES256/384");
		}
		const uniqueAlgs = new Set(algs);
		if (uniqueAlgs.size !== algs.length) {
			throw new Error("算法 allowlist 不能包含重复算法");
		}
		for (const alg of algs) {
			if (typeof alg !== "string" || !Object.hasOwn(ALGS, alg)) {
				throw new Error("算法 allowlist 只能含 RS256/384/512、ES256/384");
			}
		}
		this.#algs = algs;

		if (o.clockSkewSec !== undefined) {
			if (typeof o.clockSkewSec !== "number" || !Number.isFinite(o.clockSkewSec) || o.clockSkewSec < 0 || o.clockSkewSec > 300) {
				throw new Error("clockSkewSec 必须是 0 到 300 秒之间的有限非负数");
			}
		}

		if (o.groupsClaim !== undefined) {
			if (typeof o.groupsClaim !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(o.groupsClaim) || ["__proto__", "constructor", "prototype"].includes(o.groupsClaim)) {
				throw new Error("groupsClaim 格式非法");
			}
		}

		if (o.now !== undefined && typeof o.now !== "function") {
			throw new Error("now 必须是函数");
		}

		this.#o = o;
	}

	isPrincipalId(id: string): boolean {
		if (typeof id !== "string" || id.length > 256 || !id.startsWith(this.#o.issuer + "|")) return false;
		const sub = id.slice(this.#o.issuer.length + 1);
		return SUB_REGEX.test(sub);
	}

	async authenticate(token: string, options?: { signal?: AbortSignal }): Promise<Principal> {
		if (options?.signal?.aborted) throw new AuthError("验签已中止");
		const parts = token.split(".");
		if (parts.length !== 3 || token.length > 16 * 1024) throw new AuthError("token 格式非法");
		const headerPart = parts[0];
		const claimsPart = parts[1];
		const sigPart = parts[2];
		if (!headerPart || !claimsPart || sigPart === undefined) throw new AuthError("token 格式非法");

		const header = json(headerPart);
		const alg = typeof header.alg === "string" ? header.alg : "";
		if (!this.#algs.includes(alg)) throw new AuthError("算法不在 allowlist");
		if ("crit" in header || (header.kid !== undefined && typeof header.kid !== "string")) throw new AuthError("token header 非法");

		const spec = ALGS[alg];
		if (!spec) throw new AuthError("不支持的算法");

		const jwk = await this.#o.jwks.get(header.kid as string | undefined, options?.signal);
		if (options?.signal?.aborted) throw new AuthError("验签已中止");
		if (!jwk || jwk.kty !== spec.kty || (jwk.use && jwk.use !== "sig") || (jwk.alg && jwk.alg !== alg) || (spec.crv && jwk.crv !== spec.crv)) {
			throw new AuthError("找不到匹配的验签密钥");
		}

		let key = this.#keyCache.get(jwk);
		if (!key) {
			try {
				key = createPublicKey({ key: jwk as unknown as import("node:crypto").JsonWebKey, format: "jwk" });
			} catch {
				throw new AuthError("验签密钥非法");
			}
			if (spec.kty === "RSA" && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
				throw new AuthError("RSA 密钥过短");
			}
			this.#keyCache.set(jwk, key);
		}

		const sig = decode(sigPart);
		const data = Buffer.from(`${headerPart}.${claimsPart}`);
		let ok = false;
		try {
			ok = verify(spec.hash, data, spec.ieee ? { key, dsaEncoding: "ieee-p1363" } : key, sig);
		} catch {
			/* 签名畸形按失败处理 */
		}
		if (!ok) throw new AuthError("签名无效");

		const claims = json(claimsPart);
		const rawNow = this.#o.now?.() ?? Date.now();
		if (typeof rawNow !== "number" || !Number.isFinite(rawNow)) throw new AuthError("系统时钟异常");
		const now = rawNow / 1000;
		const skew = this.#o.clockSkewSec ?? 30;
		const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : undefined;

		if (claims.iss !== this.#o.issuer) throw new AuthError("issuer 不匹配");
		const aud = claims.aud;
		if (!(aud === this.#o.audience || (Array.isArray(aud) && aud.includes(this.#o.audience)))) throw new AuthError("audience 不匹配");

		const exp = num(claims.exp);
		if (exp === undefined) throw new AuthError("缺少 exp");
		if (now - skew >= exp) throw new AuthError("token 已过期");
		if (claims.nbf !== undefined && (num(claims.nbf) === undefined || now + skew < (claims.nbf as number))) throw new AuthError("token 尚未生效");
		if (claims.iat !== undefined && (num(claims.iat) === undefined || now + skew < (claims.iat as number))) throw new AuthError("iat 在未来");

		const sub = claims.sub;
		if (typeof sub !== "string" || !SUB_REGEX.test(sub)) throw new AuthError("sub 无效");

		const raw = claims[this.#o.groupsClaim ?? "groups"];
		const groups = Array.isArray(raw) ? raw.filter((g): g is string => typeof g === "string" && g.length <= 256).slice(0, 256) : [];

		const principalId = `${this.#o.issuer}|${sub}`;
		return { id: principalId, issuer: this.#o.issuer, subject: sub, groups, expiresAt: exp * 1000 };
	}
}

/** 服务端 scope 推导：由 IdP 组映射到 repo/team，按组名排序取第一个命中；无命中则拒绝创建 */
export function scopeFromGroups(map: Record<string, { repo: string; team: string }>): (actorOrPrincipal: string | Principal, principal?: Principal) => { repo: string; team: string } | undefined {
	if (!map || typeof map !== "object") throw new Error("group config 必须是合法对象");
	for (const [group, scope] of Object.entries(map)) {
		if (["__proto__", "constructor", "prototype"].includes(group)) throw new Error("group 名称非法");
		if (!scope || typeof scope.repo !== "string" || typeof scope.team !== "string" || !scope.repo || !scope.team) {
			throw new Error(`group ${group} 的 scope 配置非法`);
		}
	}
	return (actorOrPrincipal, principal) => {
		const p = typeof actorOrPrincipal === "object" && actorOrPrincipal !== null ? actorOrPrincipal : principal;
		if (!p || !Array.isArray(p.groups)) return undefined;
		for (const group of [...p.groups].sort()) if (Object.hasOwn(map, group)) return map[group];
	};
}

export interface PersistedBrowserSession {
	sessionId: string;
	principal: Principal;
	sessionExpiresAt: number;
}

/** 浏览器会话：cookie 里只有不透明随机 id，principal 与过期时间只在服务端 */
export class BrowserSessions {
	#map = new Map<string, { principal: Principal; sessionExpiresAt: number }>();
	#max: number;
	#now: () => number;

	constructor(max = 1000, now: () => number = Date.now) {
		this.#max = max;
		this.#now = now;
	}

	create(principal: Principal, maxTtlMs: number): { id: string; expiresAt: number } {
		const t = this.#now();
		for (const [id, s] of this.#map) if (s.sessionExpiresAt <= t) this.#map.delete(id);
		if (this.#map.size >= this.#max) throw new AuthError("会话数已达上限");
		const id = randomBytes(32).toString("base64url");
		const expiresAt = Math.min(principal.expiresAt, t + maxTtlMs);
		this.#map.set(id, { principal: { ...principal }, sessionExpiresAt: expiresAt });
		return { id, expiresAt };
	}

	get(id: string): Principal | undefined {
		const s = this.#map.get(id);
		if (!s) return undefined;
		if (s.sessionExpiresAt <= this.#now()) { this.#map.delete(id); return undefined; }
		return { ...s.principal, expiresAt: s.sessionExpiresAt };
	}

	delete(id: string): void { this.#map.delete(id); }
	revokePrincipal(principalId: string): void {
		for (const [id, s] of this.#map) {
			if (s.principal.id === principalId) this.#map.delete(id);
		}
	}
	restore(id: string, principal: Principal, sessionExpiresAt: number): boolean {
		if (typeof id !== "string" || !id) return false;
		if (!principal || typeof principal !== "object") return false;
		if (typeof principal.id !== "string" || !principal.id) return false;
		if (typeof principal.issuer !== "string" || !principal.issuer) return false;
		if (typeof principal.subject !== "string" || !principal.subject) return false;
		if (!Array.isArray(principal.groups) || !principal.groups.every((g) => typeof g === "string")) return false;
		if (typeof principal.expiresAt !== "number" || !Number.isFinite(principal.expiresAt)) return false;
		if (typeof sessionExpiresAt !== "number" || !Number.isFinite(sessionExpiresAt)) return false;
		if (sessionExpiresAt <= this.#now()) return false;

		this.#map.set(id, { principal: { ...principal }, sessionExpiresAt });
		return true;
	}
	dump(): PersistedBrowserSession[] {
		const res: PersistedBrowserSession[] = [];
		const t = this.#now();
		for (const [sessionId, s] of this.#map) {
			if (s.sessionExpiresAt > t) {
				res.push({
					sessionId,
					principal: { ...s.principal },
					sessionExpiresAt: s.sessionExpiresAt,
				});
			}
		}
		return res;
	}
}
