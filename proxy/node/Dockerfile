# Live Web proxy (self-hosted). Build from the /proxy directory:
#   docker build -f node/Dockerfile -t live-web-proxy .
#   docker run -p 8787:8787 -e ALLOWED_HOSTS="dash.example.com" -e ADDIN_ORIGIN="https://liveweb.example.com" live-web-proxy
# Put it behind an HTTPS reverse proxy (Caddy, nginx, IIS ARR, Cloudflare Tunnel...).
FROM node:24-alpine
WORKDIR /app
COPY node/package.json node/package-lock.json* ./node/
RUN cd node && npm install --omit=dev --no-audit --no-fund
COPY shared ./shared
COPY node/server.ts ./node/server.ts
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
USER node
WORKDIR /app/node
CMD ["node", "server.ts"]
