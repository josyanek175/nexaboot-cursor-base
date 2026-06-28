# NexaBoot — deploy como Node server (Easypanel/VM).
# Multi-stage: build com Bun (respeita bun.lock) e runtime com Node.
# Com o plugin nitro(), o build gera /app/.output (servidor Node auto-contido).
# A saída .output NÃO precisa de node_modules em runtime.

# ---------- Stage 1: build ----------
FROM oven/bun:1 AS builder
WORKDIR /app

# Variáveis VITE_* são embutidas em BUILD TIME (cliente). Se a tela de
# atendimento usa a API externa, defina VITE_API_URL como build-arg no Easypanel.
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL

# Força o preset Node do Nitro durante o build.
ENV NITRO_PRESET=node-server

# Instala dependências usando o lockfile.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copia o restante e gera o build de produção (vite build => .output/).
COPY . .
RUN bun run build

# ---------- Stage 2: runtime ----------
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV NITRO_PORT=3000
ENV NITRO_HOST=0.0.0.0

# Saída auto-contida do Nitro (node-server).
COPY --from=builder /app/.output ./.output

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
