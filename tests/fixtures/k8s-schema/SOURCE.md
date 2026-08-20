# Kubernetes JSON schema

用于离线校验 `deploy/` 下生成的清单（见 `tests/k8s-schema.test.ts`）。

- 来源：https://github.com/yannh/kubernetes-json-schema
- 版本：`v1.31.0-standalone-strict`
- 取得方式：
  ```
  curl -O https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master/v1.31.0-standalone-strict/pod.json
  curl -O https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master/v1.31.0-standalone-strict/networkpolicy.json
  ```
- 已剥掉 `description` 字段：它是纯注释性关键字，对验证语义零影响，
  但占了原文件 87% 的体积（637KB → 93KB）。剥离命令：
  ```
  jq 'walk(if type == "object" then del(.description) else . end)' pod.json
  ```

## 版本错配的方向

- schema 比目标集群**旧** → 漏报（清单用了新字段，schema 放行、集群拒）
- schema 比目标集群**新** → 假阳性（新字段被判非法，测试红但清单没问题）

当前 `deploy/sandbox.yaml` 用到的字段都是 1.19 之前就稳定的，风险低。
刻意不在 CI 里下载 schema —— 那会让测试依赖网络，正是存进仓库要避免的。
