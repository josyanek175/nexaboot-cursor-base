/**
 * EasyPanel — serviço dedicado do campaign-worker (modo direct).
 *
 * Fase 1: uma réplica, concorrência 1, sem migration, sem lock_token.
 * Rollback: voltar CAMPAIGN_WORKER_MODE=http no web + poller HTTP.
 */

# Campaign worker directo (EasyPanel DEV)

## Visão geral

| Processo | Papel |
|---|---|
| `nexaboot-web` | UI + APIs. Com `CAMPAIGN_WORKER_MODE=http` (default) ainda executa ticks via `POST /api/campaigns/worker/tick`. |
| `nexaboot-campaign-worker` | Processo dedicado: `npm run campaign:worker:direct`. Pool PostgreSQL próprio. |

Modos (`CAMPAIGN_WORKER_MODE`):

| Valor | Comportamento |
|---|---|
| `http` (default se ausente) | Rota tick activa; start/resume podem disparar tick no web. Compatível com poller HTTP legado. |
| `direct` | Rota tick responde **503** `worker_mode_direct`. Start/resume só actualizam estado no banco. Worker directo processa. |
| `disabled` | Rota tick **503** `worker_disabled`. Nenhum processamento de campanhas. |

**Importante:** na Fase 1 o default é `http` para não desligar o worker actual por ausência de env.

## Variáveis do serviço worker (EasyPanel)

```bash
CAMPAIGN_WORKER_MODE=direct
CAMPAIGN_WORKER_ENABLED=true
CAMPAIGN_WORKER_CONCURRENCY=1

# Preferir URL dedicada; fallback DATABASE_URL só neste serviço
CAMPAIGN_WORKER_DATABASE_URL=postgres://...
# DATABASE_URL=...   # opcional, só se não houver CAMPAIGN_WORKER_DATABASE_URL

CAMPAIGN_WORKER_PG_POOL_MAX=2
CAMPAIGN_WORKER_PG_CONNECT_TIMEOUT_SEC=10
CAMPAIGN_WORKER_PG_IDLE_TIMEOUT_SEC=20

CAMPAIGN_WORKER_IDLE_MS=5000
CAMPAIGN_WORKER_ERROR_DELAY_MS=10000
CAMPAIGN_WORKER_SHUTDOWN_TIMEOUT_MS=30000

# Health HTTP opcional (default desligado)
# CAMPAIGN_WORKER_HEALTH_ENABLED=true
# CAMPAIGN_WORKER_HEALTH_PORT=8081
```

Também necessárias para envio (iguais ao web, sem secrets em logs):

- `EVOLUTION_API_URL` / `EVOLUTION_API_KEY` (se Evolution)
- Credenciais Meta já usadas pelo código de envio (via DB / env existentes)

**Não** definir no worker:

- Bootstrap web / `src/server.ts`
- `CAMPAIGN_WORKER_SECRET` (só para poller HTTP)

## Start command

```bash
npm run campaign:worker:direct
# equivalente: npx tsx scripts/campaign-worker-direct.mjs
```

Réplicas: **1** apenas. `CAMPAIGN_WORKER_CONCURRENCY` > 1 falha no startup.

## Checklist — criar serviço EasyPanel DEV

1. Criar app/serviço `nexaboot-campaign-worker` a partir do **mesmo** repositório / imagem do web (branch desta feature).
2. Start: `npm run campaign:worker:direct` (após `npm ci` / build de deps; não precisa do servidor Nitro/web).
3. Definir envs acima com `MODE=direct` e `ENABLED=true`.
4. `CAMPAIGN_WORKER_DATABASE_URL` apontando ao **mesmo** Postgres do web (ou read-write equivalente).
5. Pool: `CAMPAIGN_WORKER_PG_POOL_MAX=2` (não reutilizar o pool do web).
6. Réplicas = **1**.
7. (Opcional) Health: `CAMPAIGN_WORKER_HEALTH_ENABLED=true` + probe `GET /health` na porta `8081`.
8. **Ainda não** alterar o web: manter `CAMPAIGN_WORKER_MODE` ausente ou `http` e o poller HTTP a correr.
9. Arrancar o serviço worker e verificar logs `campaign_worker_direct_started`.
10. Smoke: campanha de teste com 1 contacto — confirmar envio sem erro de pool no web.

## Checklist — cortar o poller HTTP sem risco

Só depois do worker direct estável em DEV:

1. No **web**, definir `CAMPAIGN_WORKER_MODE=direct` (redeploy web).
2. Confirmar `POST /api/campaigns/worker/tick` → **503** `worker_mode_direct`.
3. Confirmar start/resume devolvem `workerMode: "direct"` e `tick: null`.
4. Confirmar worker direct continua a processar (logs `campaign_worker_tick_ok`).
5. Parar / remover o serviço/poller `scripts/campaign-worker.mjs` (HTTP).
6. Manter **uma** réplica do worker direct.
7. Monitorizar 24–48h (filas, stale recovery, erros Meta/Evolution).

Ordem segura: **worker direct UP → web MODE=direct → parar poller HTTP**. Nunca o inverso.

## Rollback

1. No web: `CAMPAIGN_WORKER_MODE=http` (ou remover a env) + redeploy.
2. Religar o poller HTTP (`npm run campaign:worker` / serviço EasyPanel antigo).
3. Parar o serviço `nexaboot-campaign-worker` (ou `CAMPAIGN_WORKER_ENABLED=false`).
4. Confirmar tick HTTP 200 e envios.

Não há migration nesta fase — rollback é só env + processos.

## Segurança / logs

Logs estruturados JSON **sem**: mensagem de template, telefone completo, tokens, API keys, `raw_payload`, URLs de DB.

## Concorrência (Fase 1)

- Uma réplica.
- `FOR UPDATE SKIP LOCKED` + stale recovery existentes mantidos.
- Sem `lock_token` / sem migration.
