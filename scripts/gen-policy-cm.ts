import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePolicyConfigMap } from "../src/deploy/policy-configmap.ts";

/** 从 config/policy.yaml 生成策略 ConfigMap。CI 里应校验产物无漂移。 */
const root = join(import.meta.dirname, "..");
const out = generatePolicyConfigMap(readFileSync(join(root, "config/policy.yaml"), "utf8"), {
	namespace: process.env.PERIMETER_NAMESPACE ?? "perimeter",
});
const target = join(root, "deploy/policy-configmap.yaml");
writeFileSync(target, out);
console.log(`已生成 ${target}`);
