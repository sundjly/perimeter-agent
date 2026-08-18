import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateNetworkPolicy } from "../src/deploy/netpol.ts";

/** 从 config/policy.yaml 重新生成沙箱 NetworkPolicy。CI 里应校验产物无漂移。 */
const root = join(import.meta.dirname, "..");
const policy = readFileSync(join(root, "config/policy.yaml"), "utf8");
const out = generateNetworkPolicy(policy, {
	namespace: process.env.PERIMETER_NAMESPACE ?? "perimeter",
	podLabel: { "app.kubernetes.io/name": "perimeter-sandbox" },
});
const target = join(root, "deploy/networkpolicy.yaml");
writeFileSync(target, out);
console.log(`已生成 ${target}`);
