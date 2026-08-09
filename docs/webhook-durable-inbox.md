# Inbox durável de webhooks — Etapas 1, 2 e 3

Garantia central da ingestão: **o HTTP 200 só é devolvido depois do COMMIT** do
evento em `public.webhook_inbox` **e** da mensagem correspondente em
`public.webhook_outbox`. Nenhuma operação de contato, conversa, mensagem, mídia
ou campanha acontece dentro da requisição HTTP.

A Etapa 3 (message-worker) consome a referência publicada no RabbitMQ, carrega o
payload original pela `inbox_id` e executa o mesmo domínio que a rota legada —
sem download de mídia. O ACK no RabbitMQ só ocorre depois do COMMIT no
PostgreSQL (incluindo o caso de retry durável).

## Fluxo completo

```
Provedor → HTTP (token/HMAC) → INSERT inbox + outbox (mesma TX) → 200
                                      ↓
                            outbox-publisher → RabbitMQ
                                      ↓
                            message-worker → claim inbox → domínio → COMMIT
                                      ↓
                   (media_jobs + campaign_jobs na mesma TX)
                                      ↓
                            ACK RabbitMQ
                                      ↓
              retry-dispatcher republica quando available_at vence
                                      ↓
                            (futuro) media-worker / campaign-inbound-worker
```

1. Validação do provedor (token da Evolution / assinatura HMAC da Meta).
2. Reserva de memória para o corpo.
3. Leitura do corpo com teto de bytes, corte por inatividade e teto absoluto.
4. Extração dos identificadores mínimos, `conversation_key` e `deduplication_key`.
5. Numa única transação no pool dedicado: `INSERT` na inbox e na outbox.
6. Só depois do COMMIT dos dois registros, resposta 200.
7. O publicador claima a outbox, publica no RabbitMQ e marca `published` só após
   o publisher confirm.
8. O message-worker valida o envelope (`schemaVersion` + `inboxId`), claima a
   inbox, processa sob advisory lock por conversa e marca `processed` no mesmo
   COMMIT do contato/conversa/mensagem **e** das tarefas `webhook_media_jobs` /
   `webhook_campaign_jobs`.
9. ACK no RabbitMQ. Se o processo morrer entre COMMIT e ACK, a reentrega
   encontra `processed` e só confirma — sem duplicar. Efeitos pós-domínio
   (campanha) vivem nas tarefas duráveis, não dependem dessa reentrega.

## Flags (todas as novas default `false`, exceto o legado)

| Variável | Default | Papel |
|---|---|---|
| `WEBHOOK_DURABLE_INBOX_ENABLED` | `false` | Desvia a rota HTTP para a ingestão durável. |
| `WEBHOOK_OUTBOX_PUBLISHER_ENABLED` | `false` | Liga o serviço publicador (além de `RABBITMQ_ENABLED`). |
| `WEBHOOK_RABBITMQ_PROCESSING_ENABLED` | `false` | Liga o message-worker. |
| `WEBHOOK_LEGACY_PROCESSING_ENABLED` | `true` | Kill-switch do processamento dentro da requisição. Default `true` porque é o comportamento de produção hoje. |
| `WEBHOOK_DURABLE_INBOX_PROCESSING_ENABLED` | `false` | Reservada; a Etapa 1 já a expõe nos logs. |

Combinação alvo (sem processamento duplo):

```
WEBHOOK_DURABLE_INBOX_ENABLED=true
WEBHOOK_OUTBOX_PUBLISHER_ENABLED=true
RABBITMQ_ENABLED=true
WEBHOOK_RABBITMQ_PROCESSING_ENABLED=true
WEBHOOK_LEGACY_PROCESSING_ENABLED=false
```

Com legado e worker ativos ao mesmo tempo o worker emite
`WEBHOOK_MESSAGE_CONFIG_CONFLICT` com severidade `danger`. A rota, com a inbox
durável ligada, já não processa inline — o risco real de duplicidade é ligar o
worker sem desviar a rota.

## Message-worker (Etapa 3)

Entrypoint: `scripts/webhook-message-worker.ts`  
Script: `npm run webhook:message-worker`

Com `WEBHOOK_RABBITMQ_PROCESSING_ENABLED=false` o processo fica **estacionado**:
não conecta ao RabbitMQ, não abre pool, não processa a inbox. Continua vivo
para o orquestrador.

### Claim e lease

Status elegíveis: `pending`, `queued`, `retry`, e `processing` com lease
expirado. O claim é um `UPDATE … FOR UPDATE SKIP LOCKED` atômico.

- `processed` → ACK sem reprocessar (cobre a falha entre COMMIT e ACK).
- `processing` com lease válido → ACK (não prende prefetch; outro worker é o
  dono; o republisher / lease expirado cuida do progresso).
- Erro temporário → `retry` + `available_at` com backoff + **ACK imediato**.
  O republisher (`processInboxRetryBatch`) republica quando `available_at`
  vence. **Não** se usa NACK com sleep: isso prendia slot de prefetch durante
  todo o backoff.
- Erro permanente ou excesso de tentativas → `dead_letter` + ACK (payload
  preservado).

### Domínio reutilizável

| Função | Arquivo |
|---|---|
| `processEvolutionInboxEvent` | `src/lib/webhook-evolution-processing.server.ts` |
| `processMetaInboxEvent` | `src/lib/webhook-meta-processing.server.ts` |
| `processMetaStatusUpdates` | `src/lib/webhook-meta-status.server.ts` |
| `ensureCampaignJob` | `src/lib/webhook-campaign-jobs.server.ts` |
| `upsertInboundContact` / conversa / mensagem | `src/lib/crm-inbound.server.ts` (agora aceitam `sql` injetado) |

A rota legada da Evolution passou a chamar `processEvolutionInboxEvent` com
`media: { mode: "inline" }` — o download continua acontecendo na requisição
quando a flag durável está desligada. O worker chama a mesma função com
`media: { mode: "job", inboxId }`.

### Status Meta

Eventos `sent` / `delivered` / `read` / `failed` são processados de forma
idempotente (progressão monotônica; `failed` → `error` sem regredir
delivered/read). Se o status chegar antes da mensagem existir, a inbox vai a
`retry` — **nunca** `processed` silenciosamente. Campos Meta desconhecidos
sem messages/statuses reconhecíveis viram erro permanente (`dead_letter`), não
sucesso vazio.

### Campanha durável

`public.webhook_campaign_jobs` nasce **dentro da mesma transação** que marca a
inbox `processed`. O processamento imediato após o COMMIT é só otimização:
falha não perde o trabalho e a reentrega da inbox (`already_processed`) não é
o mecanismo de retry da campanha. Um worker dedicado de campanha inbound pode
consumir a tabela depois; nesta etapa a otimização pós-COMMIT permanece.

### Idempotência

- Mensagens: `ON CONFLICT (conversation_id, external_message_id) DO NOTHING`
  (índice parcial já existente). Reentrega não cria segunda linha e **não**
  incrementa `unread_count` de novo.
- Contatos: busca por `(company_id, phone_match)` + recuperação de corrida.
- Conversas: busca por `(company_id, channel_id, contact_id)` + log
  `CONVERSATION_DUPLICATE_DETECTED` se houver mais de uma viva.
- Mídia: `UNIQUE (message_id)` em `webhook_media_jobs`.
- Campanha: `UNIQUE (message_id)` em `webhook_campaign_jobs`.

### Unicidade de conversa (bloqueador de produção)

Hoje a unicidade lógica `(company_id, whatsapp_channel_id, contact_id)` é
convenção de código, **não** garantia de banco. Correções concorrentes podem
ainda criar duplicatas.

- Proposta (não aplicar automaticamente):
  `docs/migrations/20260809_conversations_unique_proposed.sql`
- Pré-requisito: zerar duplicados existentes (diagnóstico no próprio arquivo),
  dump de `public.conversations`, então criar o índice UNIQUE parcial.
- Até lá: trate como **bloqueador de produção** para cutover completo; a
  detecção explícita `CONVERSATION_DUPLICATE_DETECTED` já está no domínio.

### Ordem por conversa

`pg_advisory_xact_lock` com chave derivada de `sha256(companyId:conversationKey)`.
Mensagens de conversas diferentes processam em paralelo. O lock é liberado no
COMMIT/ROLLBACK — nunca é mantido durante HTTP externo (não há HTTP na
transação).

Limitação documentada: se o provedor entregar eventos fora de ordem, o worker
preserva a ordem de consumo por conversa, mas não reordena pelo timestamp do
provedor.

### Mídia

O message-worker **não** baixa, descriptografa nem armazena anexo. Grava a
mensagem com `media_status='pending'`, cria a tarefa em
`public.webhook_media_jobs` e segue. O media-worker é etapa futura.

### Variáveis do message-worker

| Variável | Default |
|---|---|
| `WEBHOOK_MESSAGE_MAX_ATTEMPTS` | `8` |
| `WEBHOOK_MESSAGE_BASE_RETRY_MS` | `2000` |
| `WEBHOOK_MESSAGE_MAX_RETRY_MS` | `300000` |
| `WEBHOOK_MESSAGE_LEASE_MS` | `120000` |
| `WEBHOOK_MESSAGE_PREFETCH` | `8` |
| `WEBHOOK_MESSAGE_LEASE_CONFLICT_DELAY_MS` | `5000` (legado; conflito agora dá ACK) |

## Pool dedicado

A ingestão e os serviços dedicados usam o pool
`src/lib/pg-webhook-inbox.server.ts`, separado do pool do `nexaboot-web`.

## Payloads grandes

Ver Etapa 1: teto default 160 MiB, orçamento de memória separado, stall timeout
e total timeout. Eventos grandes ficam no PostgreSQL; a mensagem do RabbitMQ
carrega só a referência.

## Observabilidade

Logs do worker (nunca com payload bruto, base64, tokens ou credenciais):

- `WEBHOOK_MESSAGE_RECEIVED`
- `WEBHOOK_MESSAGE_CLAIMED`
- `WEBHOOK_MESSAGE_ALREADY_PROCESSED`
- `WEBHOOK_MESSAGE_PROCESS_START`
- `WEBHOOK_MESSAGE_PROCESS_SUCCESS`
- `WEBHOOK_MESSAGE_RETRY`
- `WEBHOOK_MESSAGE_DEAD_LETTER`
- `WEBHOOK_MESSAGE_LEASE_CONFLICT`
- `WEBHOOK_MESSAGE_INVALID_ENVELOPE`
- `WEBHOOK_MESSAGE_ACK` / `WEBHOOK_MESSAGE_NACK`
- `WEBHOOK_MESSAGE_CONFIG_CONFLICT`
- `WEBHOOK_INBOX_RETRY_REPUBLISHED` / `WEBHOOK_INBOX_RETRY_DISPATCH`
- `MEDIA_JOB_CREATED` / `MEDIA_JOB_DUPLICATE`
- `WEBHOOK_CAMPAIGN_JOB_CREATED` / `WEBHOOK_CAMPAIGN_JOB_PROCESSED` / `WEBHOOK_CAMPAIGN_JOB_RETRY`
- `META_STATUS_UPDATED` / `META_STATUS_NOOP`
- `CONVERSATION_DUPLICATE_DETECTED`

O `/api/health` expõe o bloco `webhooks` com as flags e o snapshot do worker
(no processo web o worker aparece desligado — o snapshot real vive no processo
do message-worker).

## Migrations

Aplicar nesta ordem:

1. `docs/migrations/20260808_webhook_inbox.sql`
2. `docs/migrations/20260808_webhook_outbox.sql`
3. `docs/migrations/20260809_webhook_inbox_stage3.sql` (coluna `conversation_key`, status `queued`)
4. `docs/migrations/20260809_webhook_media_jobs.sql` (`webhook_media_jobs` + `messages.media_status`)
5. `docs/migrations/20260809_webhook_campaign_jobs.sql` (`webhook_campaign_jobs`)

Proposta separada (não automática):

- `docs/migrations/20260809_conversations_unique_proposed.sql`

A etapa 3 precisa estar aplicada **antes** de subir o código que grava
`conversation_key`: sem a coluna, a ingestão responde 503.

## Rollback

### 1. Rollback operacional por flags (primeira opção em incidente)

Use isto **antes** de qualquer SQL destrutivo. Não apaga registros.

1. `WEBHOOK_RABBITMQ_PROCESSING_ENABLED=false` — estaciona o worker.
2. `WEBHOOK_OUTBOX_PUBLISHER_ENABLED=false` / `RABBITMQ_ENABLED=false` — estaciona o publicador.
3. `WEBHOOK_DURABLE_INBOX_ENABLED=false` — a rota volta ao processamento legado
   (com `WEBHOOK_LEGACY_PROCESSING_ENABLED=true`, o default).

**Preserve** `webhook_inbox`, `webhook_outbox`, `webhook_media_jobs` e
`webhook_campaign_jobs` para reprocessamento. Nada disso deve ser apagado durante
incidente.

### 2. Migrations destrutivas (somente após backup/dump confirmado)

`DROP TABLE` **apaga payload** e tarefas pendentes. Não use rollback SQL
destrutivo durante incidente. Só rode os scripts `*_rollback.sql` depois de:

1. Confirmar dump/backup das tabelas envolvidas.
2. Parar publisher e message-worker.
3. Aceitar perda irreversível de linhas ainda não processadas naquela tabela.

Ordem inversa (quando explicitamente aprovado):

1. `docs/migrations/20260809_webhook_campaign_jobs_rollback.sql` — `DROP TABLE` apaga tarefas de campanha.
2. `docs/migrations/20260809_webhook_media_jobs_rollback.sql` — `DROP TABLE` apaga tarefas de mídia (mensagens/inbox ficam).
3. `docs/migrations/20260809_webhook_inbox_stage3_rollback.sql`
4. `docs/migrations/20260808_webhook_outbox_rollback.sql` — `DROP TABLE` apaga outbox.
5. `docs/migrations/20260808_webhook_inbox_rollback.sql` — `DROP TABLE` apaga **payload bruto** da inbox.

## Testes

```
npx tsx scripts/test-webhook-inbox.mjs
npx tsx scripts/test-webhook-outbox.mjs
npx tsx scripts/test-webhook-message-worker.mjs
```

Integração opcional com broker de DEV (ignorada por padrão):

```
WEBHOOK_OUTBOX_INTEGRATION=true RABBITMQ_ENABLED=true RABBITMQ_URL=amqp://… \
  npx tsx scripts/test-webhook-outbox-integration.mjs

WEBHOOK_MESSAGE_WORKER_INTEGRATION=true RABBITMQ_ENABLED=true RABBITMQ_URL=amqp://… \
  npx tsx scripts/test-webhook-message-worker-integration.mjs
```
