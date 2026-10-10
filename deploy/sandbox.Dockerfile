# 沙箱只提供工具执行环境，agent 循环与凭据留在可信网关。
FROM node:22.19-alpine
RUN apk add --no-cache git
WORKDIR /opt/pi-env
RUN npm install --omit=dev --save-exact @earendil-works/pi-env@1.1.0 && \
    case "$(uname -m)" in aarch64) arch=arm64 ;; x86_64) arch=x64 ;; *) exit 1 ;; esac && \
    cp node_modules/@earendil-works/pi-env/bin/pi-env-linux-${arch}/pi-env /usr/local/bin/pi-env && \
    chmod 755 /usr/local/bin/pi-env && rm -rf /opt/pi-env
RUN adduser -D -u 10001 -h /home/agent agent
USER 10001
WORKDIR /workspace
CMD ["/bin/sh", "-c", "while :; do sleep 3600; done"]
