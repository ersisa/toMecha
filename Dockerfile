# syntax=docker/dockerfile:1.4
# 像素机甲对战 - 极简 Node.js 游戏服务器（零外部依赖）
FROM node:20.11.1-slim AS runtime

LABEL maintainer="mecha-battle"
LABEL description="Mecha Battle Multiplayer WebSocket Game Server"

WORKDIR /app

# 生产模式 + 默认 HTTP 监听 8080
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

# 只复制游戏静态资源 + server.js（无需 package.json、无需 npm install）
# 文件清单：index.html, style.css, game.js, server.js, js/ 子目录
COPY --chown=1000:1000  index.html  style.css  game.js  server.js  ./
COPY --chown=1000:1000  js/  ./js/

# 使用非 root 用户（node 用户 uid=1000 已存在于 slim 镜像）
USER 1000

EXPOSE 8080

# Healthcheck：直接请求首页（零依赖，无需 curl/wget）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT||8080) + '/', r => process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# 入口：直接跑 server.js（默认就是 HTTP 8080，0.0.0.0 全网卡监听）
CMD ["node", "server.js"]
