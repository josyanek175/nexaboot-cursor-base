# NexaBoot — deploy como Node server (Easypanel/VM).
# Multi-stage: build com Bun (respeita bun.lock) e runtime enxuto com Node.
# A saída do Nitro (.output) é auto-contida: NÃO precisa de node_modules em runtime.

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

# Copia o restante e gera o build de produção (vite build => .output via Nitro).
COPY . .
RUN bun run build

# ---------- Stage 2: runtime ----------
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
# Nitro node-server lê PORT e HOST. 0.0.0.0 é necessário dentro do container.
ENV PORT=3000
ENV HOST=0.0.0.0

# Apenas a saída auto-contida do servidor.
COPY --from=builder /app/.output ./.output

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
