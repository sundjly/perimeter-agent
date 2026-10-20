// 凭据域互异校验纯 unit（R51 H1/R-Q50-5 同缝模块；resource-free：零网络/零 timer/零 FS）。
// 覆盖：两两互异、字节级碰撞（含 hex-vs-raw 形态差）、强度、空值跳过、同名自碰。
// 本文件为源码交付，未运行（R51 执行禁令；由 coor 新轮预审实际脚本后执行）。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { assertDistinctCredentialDomains, assertMasterKeyStrength, sameCredentialBytes, toDomainBytes, CredentialDomainError } from "../src/gateway/credential-domains.ts";

test("credential-domains：合法互异配置不抛（正控）", () => {
	assert.doesNotThrow(() =>
		assertDistinctCredentialDomains([
			{ name: "gateway", value: "browser-token" },
			{ name: "model", value: "model-token" },
			{ name: "gitProxy", value: "git-proxy-token" },
			{ name: "masterKey", value: randomBytes(32) },
			{ name: "internalToken", value: "registry-internal-token-0123456789" },
		]),
	);
});

test("credential-domains：任意一对碰撞都拒（每对负控）", () => {
	const base = [
		{ name: "a", value: "alpha" },
		{ name: "b", value: "beta" },
		{ name: "c", value: "gamma" },
	];
	for (let i = 0; i < base.length; i++) {
		for (let j = i + 1; j < base.length; j++) {
			const mutated = base.map((e, k) => (k === j ? { name: e.name, value: base[i]!.value } : e));
			assert.throws(() => assertDistinctCredentialDomains(mutated), CredentialDomainError, `(${base[i]!.name},${base[j]!.name}) 碰撞必须拒`);
		}
	}
});

test("credential-domains：hex/字符串形态差不藏碰撞（R-Q50-5 字节级）", () => {
	const raw = "registry-internal-token-0123456789";
	// masterKey 原字节恰等于某 token 字符串的 UTF-8 字节（旧 hex 形态比较漏检的形态）
	const keyAsBuffer = Buffer.from(raw, "utf8");
	assert.throws(
		() => assertDistinctCredentialDomains([{ name: "masterKey", value: keyAsBuffer }, { name: "internalToken", value: raw }]),
		CredentialDomainError,
	);
	// hex 字符串形态与原字节不同：不误报
	const hexForm = keyAsBuffer.toString("hex");
	assert.doesNotThrow(() => assertDistinctCredentialDomains([{ name: "masterKey", value: hexForm }, { name: "internalToken", value: raw }]));
});

test("credential-domains：空值跳过；同名同值自碰拒；工具函数一致", () => {
	assert.doesNotThrow(() => assertDistinctCredentialDomains([{ name: "a", value: "" }, { name: "b", value: "x" }]));
	assert.throws(() => assertDistinctCredentialDomains([{ name: "dup", value: "same" }, { name: "dup", value: "same" }]), CredentialDomainError);
	assert.equal(sameCredentialBytes(Buffer.from("ab"), "ab"), true);
	assert.equal(sameCredentialBytes("ab", Buffer.from("cd")), false);
	assert.deepEqual(toDomainBytes("ab"), Buffer.from([0x61, 0x62]));
});

test("credential-domains：强度 ≥32B（负控含 31B 边界）", () => {
	assert.doesNotThrow(() => assertMasterKeyStrength(randomBytes(32)));
	assert.throws(() => assertMasterKeyStrength(randomBytes(31)), /强度不足/);
	assert.throws(() => assertMasterKeyStrength("short"), /强度不足/);
});
