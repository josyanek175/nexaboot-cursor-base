# NexaBoot — deploy como Node server (Easypanel/VM).
# Multi-stage: build com Bun (respeita bun.lock) e runtime com Node.
# O build gera /app/dist (dist/client + dist/server/server.js).
# O runtime precisa de dist + node_modules + package.json.

# ---------- Stage 1: build ----------
FROM oven/bun:1 AS builder
WORKDIR /app

# Variáveis VITE_* são embutidas em BUILD TIME (cliente). Se a tela de
# atendimento usa a API externa, defina VITE_API_URL como build-arg no Easypanel.
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL

# Instala dependências usando o lockfile.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copia o restante e gera o build de produção (vite build => dist/).
COPY . .
RUN bun run build

# ---------- Stage 2: runtime ----------
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV NITRO_HOST=0.0.0.0
ENV NITRO_PORT=3000

# Saída do build + dependências e manifesto para runtime.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

EXPOSE 3000

# CMD TEMPORÁRIO de diagnóstico — imprime contexto antes de iniciar o Node.
# Volte para: CMD ["node", "dist/server/server.js"] após o diagnóstico.
CMD ["sh", "-c", "echo '=== NEXABOOT STARTING ===' && pwd && ls -la && echo '=== DIST ===' && ls -la dist && echo '=== DIST SERVER ===' && ls -la dist/server && echo '=== ENV ===' && echo PORT=$PORT HOST=$HOST NODE_ENV=$NODE_ENV NITRO_PORT=$NITRO_PORT NITRO_HOST=$NITRO_HOST && echo '=== START NODE ===' && node dist/server/server.js"]
