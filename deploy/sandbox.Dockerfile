# 沙箱参考镜像。生产上这里应当是**客户自带的构建镜像** ——
# 环境保真度（pip / Go / Rust / native 模块 / 任意 Node 版本）正是选云沙箱
# 而不是浏览器内执行的首要理由，那些依赖只有客户自己的镜像才有。
#
# 本文件的用途是给出最小可用形态，并作为容器执行后端的验证基线。
# 锁小版本：仓库要求 node >= 22.18（容器里跑的正是 .ts 扩展，
# 无标志的 type stripping 依赖它）。浮动的 node:22 有可能滑到更低的补丁版。
FROM node:22.18-alpine

# git 是必需的：agent 要在工作区里 commit，凭据由 git 代理注入
RUN apk add --no-cache git

# 版本锁死。pi 的 RPC 协议在小版本间是稳的，但事件名变更会让策略钩子
# 静默失效（见 policy-extension.ts 的 hook-armed 握手），不要用 latest。
ARG PI_VERSION=0.84.2
RUN npm i -g @earendil-works/pi-coding-agent@${PI_VERSION}

# 策略扩展及其依赖装进镜像，而不是从宿主机挂。两个理由：
# ① node_modules 是平台相关的，从 macOS 宿主机挂进 Linux 容器会在 native
#    模块上出 ABI 问题（当前只有纯 JS 依赖所以没炸，加一个就炸）；
# ② K8s 侧没有 bind mount，而 ConfigMap 有 1MiB 上限 —— node_modules 27MB，
#    差 27 倍，configMap 方案根本不可行。装进镜像是唯一对两种形态都成立的做法。
# 同时让「策略代码不可变」成为镜像属性，而不是一个挂载选项。
WORKDIR /opt/perimeter
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY config/ ./config/

# 非 root。与 deploy/sandbox.yaml 的 runAsUser 保持一致。
RUN adduser -D -u 10001 -h /home/agent agent
USER 10001
WORKDIR /workspace

# 不设 ENTRYPOINT：由网关的执行后端决定如何启动 pi，
# 因为参数（--mode rpc、扩展路径、provider）都是每会话生成的。
