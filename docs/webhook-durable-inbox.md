# Inbox durável de webhooks — Etapas 1 e 2

Garantia central: **o HTTP 200 só é devolvido depois do COMMIT** do evento em
`public.webhook_inbox` **e** da mensagem correspondente em
`public.webhook_outbox`. Nenhuma operação de contato, conversa, mensagem, mídia
ou campanha acontece dentro da requisição HTTP.

O worker que processa contatos, conversas e mensagens é a Etapa 3 e **não**
existe ainda. Com `WEBHOOK_DURABLE_INBOX_ENABLED=true` e
`WEBHOOK_DURABLE_INBOX_PROCESSING_ENABLED=false`, os eventos ficam acumulando em
`webhook_inbox.status = 'pending'`. A Etapa 2 apenas transporta a referência do
evento até o RabbitMQ.

## Fluxo

1. Validação do provedor (token da Evolution / assinatura HMAC da Meta).
2. Reserva de memória para o corpo (ver "Payloads grandes").
3. Leitura do corpo com teto de bytes, corte por inatividade e teto absoluto.
4. Extração dos identificadores mínimos e da `deduplication_key`.
5. Numa única transação no pool dedicado, com `statement_timeout`:
   `INSERT` na inbox com `ON CONFLICT (provider, deduplication_key) DO NOTHING`
   e `INSERT` na outbox com `ON CONFLICT (inbox_id, routing_key) DO NOTHING`.
6. Só depois do COMMIT dos dois registros, resposta 200.

Falha em qualquer ponto entre 2 e 5 devolve erro retentável — nunca 200.

## Pool dedicado

A ingestão usa um pool PostgreSQL próprio (`src/lib/pg-webhook-inbox.server.ts`),
separado do pool do `nexaboot-web`. Motivo: saturação da UI, do fluxo legado ou
das campanhas não pode impedir a persistência de um webhook.

Dois limites diferentes protegem cada requisição:

- **Aquisição de conexão**: semáforo próprio com `WEBHOOK_INBOX_PG_ACQUIRE_TIMEOUT_MS`.
  O `postgres.js` enfileira indefinidamente quando o pool está cheio; o semáforo
  transforma essa espera infinita em 503 com `Retry-After`.
- **Execução da consulta**: `statement_timeout` aplicado em toda conexão do pool
  e reafirmado com `SET LOCAL` dentro da transação.

O pool da inbox não importa `pg.server` nem o gate de concorrência do web, e
nunca registra a URL do banco em log.

## Payloads grandes

A Evolution é configurada com `base64: true`, então mídia chega embutida no
JSON. O maior arquivo aceito pelo WhatsApp é documento de 100 MB, que em base64
vira ~134 MB, mais o envelope JSON. A Meta não manda binário no webhook (só
ID de mídia), então o caso dimensionante é a Evolution.

Por isso o teto padrão **não** é dimensionado por conforto de memória:

- `WEBHOOK_INBOX_MAX_PAYLOAD_BYTES` = **160 MiB** por padrão, acima do maior
  payload legítimo de qualquer provedor. Um teto menor rejeitaria arquivo
  válido, e é justamente o que o valor anterior (5 MiB) fazia.

O consumo de memória é controlado separadamente, por um **orçamento de bytes
simultâneos** (`src/lib/webhook-inbox-budget.ts`):

- Cada requisição reserva, antes de ler, `min(Content-Length, teto)` — ou o teto
  inteiro quando o cliente não declara `Content-Length`.
- A reserva só é devolvida **depois do COMMIT**, então o pico contabilizado
  cobre toda a vida útil do corpo em memória.
- O pico de memória do processo fica limitado a `WEBHOOK_INBOX_MEMORY_BUDGET_BYTES`
  (padrão 192 MiB), independentemente de quantos webhooks chegarem juntos.
- A fila é FIFO: um payload grande não é ultrapassado indefinidamente por
  payloads pequenos.
- Um payload maior que o orçamento inteiro é admitido sozinho (serializado), em
  vez de ficar bloqueado para sempre.
- O orçamento efetivo nunca é menor que o teto de payload, então um evento do
  tamanho máximo sempre consegue entrar.

Dimensionamento: reserve `WEBHOOK_INBOX_MEMORY_BUDGET_BYTES` + folga de heap no
limite de memória do container. Aumentar o orçamento aumenta a concorrência de
eventos grandes; diminuir serializa mais.

### Nada é descartado em silêncio

| Situação | Resposta | Log |
| --- | --- | --- |
| `Content-Length` acima do teto | 413 (sem ler o corpo) | `WEBHOOK_INBOX_PAYLOAD_REJECTED` |
| Corpo excede o teto durante a leitura | 413 | `WEBHOOK_INBOX_PAYLOAD_REJECTED` |
| Conexão parada / lenta demais | 408 | `WEBHOOK_INBOX_PAYLOAD_REJECTED` |
| Sem orçamento de memória a tempo | 503 + `Retry-After` | `WEBHOOK_INBOX_THROTTLED` |
| Sem conexão do pool a tempo | 503 + `Retry-After` | `WEBHOOK_INBOX_PERSIST_FAILED` |
| Falha de banco | 503 + `Retry-After` | `WEBHOOK_INBOX_PERSIST_FAILED` |

O 413 só é alcançável acima do máximo dos provedores, ou seja, por requisição
anômala. Todo caso transitório (memória, conexão, banco) devolve 503 retentável,
para que o provedor reenvie.

## Timeouts de leitura do corpo

Um prazo único de 5 s matava mídia grande legítima. A leitura passou a ter dois
prazos independentes:

- `WEBHOOK_INBOX_BODY_STALL_TIMEOUT_MS` (padrão 15 s): tempo máximo **sem
  receber nenhum byte novo**. Upload lento que continua progredindo não é
  cortado; conexão travada é.
- `WEBHOOK_INBOX_BODY_TIMEOUT_MS` (padrão 120 s): teto absoluto, contra
  slow-loris. O prazo de inatividade nunca ultrapassa o teto absoluto.

Em qualquer corte o reader é cancelado, então a requisição não fica pendurada.

## Variáveis

| Variável | Default | Efeito |
| --- | --- | --- |
| `WEBHOOK_DURABLE_INBOX_ENABLED` | `false` | Liga a ingestão durável. Desligada, o fluxo legado continua igual. |
| `WEBHOOK_DURABLE_INBOX_PROCESSING_ENABLED` | `false` | Reservada para a Etapa 3 (worker de mensagens). Sem efeito hoje. |
| `WEBHOOK_INBOX_DATABASE_URL` | `DATABASE_URL` | Banco do pool dedicado. |
| `WEBHOOK_INBOX_PG_POOL_MAX` | `3` | Conexões do pool da inbox. |
| `WEBHOOK_INBOX_PG_CONNECT_TIMEOUT_SEC` | `10` | Timeout de conexão TCP/handshake. |
| `WEBHOOK_INBOX_PG_IDLE_TIMEOUT_SEC` | `20` | Encerramento de conexão ociosa. |
| `WEBHOOK_INBOX_PG_ACQUIRE_TIMEOUT_MS` | `3000` | Espera máxima por um slot do pool. |
| `WEBHOOK_INBOX_PG_STATEMENT_TIMEOUT_MS` | `30000` | Timeout de execução do INSERT. |
| `WEBHOOK_INBOX_MAX_PAYLOAD_BYTES` | `167772160` (160 MiB) | Teto do corpo aceito. |
| `WEBHOOK_INBOX_MEMORY_BUDGET_BYTES` | `201326592` (192 MiB) | Bytes de corpo simultâneos em memória. |
| `WEBHOOK_INBOX_MEMORY_ACQUIRE_TIMEOUT_MS` | `10000` | Espera máxima por orçamento de memória. |
| `WEBHOOK_INBOX_BODY_STALL_TIMEOUT_MS` | `15000` | Tempo máximo sem bytes novos. |
| `WEBHOOK_INBOX_BODY_TIMEOUT_MS` | `120000` | Teto absoluto da leitura do corpo. |

## Outbox transacional (Etapa 2)

Publicar direto no RabbitMQ dentro do handler HTTP reintroduziria exatamente o
problema que a inbox resolveu: broker fora do ar viraria erro no endpoint. Por
isso a ingestão grava a mensagem numa tabela (`public.webhook_outbox`) na mesma
transação da inbox, e um serviço separado publica depois.

Consequências práticas:

- **Nunca existe inbox sem outbox.** Se o `INSERT` da outbox falhar, a
  transação inteira sofre rollback e o endpoint devolve 503.
- **Evento duplicado também é reparado.** A reentrega localiza a inbox
  existente e garante a outbox correspondente. Isso conserta eventos gravados
  pela Etapa 1, antes desta tabela existir.
- **RabbitMQ indisponível não afeta o endpoint.** Nem `src/routes` nem
  `webhook-inbox.server.ts` importam a camada do broker.

### Mensagem publicada

Só referências e metadados — o payload bruto (que pode ter mais de 100 MB de
mídia em base64) fica apenas na inbox e será carregado pelo worker da Etapa 3
através do `inboxId`:

```json
{
  "schemaVersion": 1,
  "inboxId": "…", "provider": "evolution", "eventType": "messages.upsert",
  "companyId": null, "channelId": null, "instanceName": "nexa-01",
  "externalEventId": null, "externalMessageId": "WAMID-A",
  "conversationKey": "5511…@s.whatsapp.net", "receivedAt": "…"
}
```

A routing key é `<provider>.<evento>` normalizada (`evolution.messages.upsert`).

### Serviço publicador

```
npm run webhook:outbox-publisher
```

Ciclo: recupera leases vencidos → reivindica um lote com
`FOR UPDATE SKIP LOCKED` marcando `publishing` e criando lease → publica →
**espera o publisher confirm** → só então grava `published`.

- `published` nunca é gravado sem confirmação do broker.
- Falha antes do confirm vira `retry` com backoff exponencial e jitter.
- Estourado `WEBHOOK_OUTBOX_MAX_ATTEMPTS`, vira `dead_letter` preservando
  payload, tentativas e `last_error`. Nada é apagado, nunca.
- Lease vencido é recuperado por outra réplica; `SKIP LOCKED` permite várias
  réplicas sem que duas peguem a mesma linha.
- `SIGTERM`/`SIGINT` param de iniciar publicações novas e devolvem à fila as
  linhas reservadas que não chegaram a ser publicadas (a tentativa é
  estornada).
- Com `RABBITMQ_ENABLED=false` o processo fica **estacionado**: não abre pool,
  não consulta a outbox e dorme em intervalo longo. Ele continua vivo de
  propósito, para o orquestrador não entrar em laço de restart.

`amqplib` é carregado por import dinâmico, então o bundle do web não o contém e
build e testes não precisam de broker.

### Variáveis da Etapa 2

| Variável | Default | Efeito |
| --- | --- | --- |
| `RABBITMQ_ENABLED` | `false` | Liga o publicador. Desligada, ele fica estacionado. |
| `RABBITMQ_URL` | — | Obrigatória quando habilitado. Nunca aparece em log. |
| `RABBITMQ_EXCHANGE` | `nexaboot.dev.webhooks` | Exchange topic durable. Lida também na ingestão. |
| `RABBITMQ_WEBHOOK_QUEUE` | `nexaboot.dev.webhook.queue` | Fila durable com dead letter para a DLQ. |
| `RABBITMQ_WEBHOOK_DLQ` | `nexaboot.dev.webhook.dlq` | Fila durable de dead letter. |
| `RABBITMQ_PREFETCH` | `10` | Prefetch do canal. |
| `RABBITMQ_CONNECT_TIMEOUT_MS` | `10000` | Timeout de conexão com o broker. |
| `RABBITMQ_RECONNECT_MIN_MS` | `1000` | Piso do backoff de reconexão. |
| `RABBITMQ_RECONNECT_MAX_MS` | `30000` | Teto do backoff de reconexão. |
| `WEBHOOK_OUTBOX_MAX_ATTEMPTS` | `10` | Tentativas antes do `dead_letter`. |
| `WEBHOOK_OUTBOX_BASE_RETRY_MS` | `1000` | Base do backoff exponencial. |
| `WEBHOOK_OUTBOX_MAX_RETRY_MS` | `300000` | Teto do backoff. Nunca menor que a base. |
| `WEBHOOK_OUTBOX_LEASE_MS` | `60000` | Validade da reserva de uma linha. |
| `WEBHOOK_OUTBOX_BATCH_SIZE` | `50` | Linhas por ciclo. |
| `WEBHOOK_OUTBOX_POLL_INTERVAL_MS` | `1000` | Intervalo entre ciclos. |

Os nomes default são de DEV de propósito. **DEV e produção precisam de nomes
(ou vhosts) diferentes**: publicar evento de teste numa fila de produção entrega
mensagem a cliente real.

## Logs

Ingestão: `WEBHOOK_INBOX_RECEIVED`, `WEBHOOK_INBOX_PERSISTED`,
`WEBHOOK_INBOX_DUPLICATE`, `WEBHOOK_INBOX_PERSIST_FAILED`,
`WEBHOOK_INBOX_PAYLOAD_REJECTED`, `WEBHOOK_INBOX_THROTTLED`,
`WEBHOOK_INBOX_POOL_CONFIG`, `WEBHOOK_OUTBOX_CREATED`,
`WEBHOOK_OUTBOX_DUPLICATE`.

Publicador: `WEBHOOK_OUTBOX_CLAIMED`, `WEBHOOK_OUTBOX_PUBLISH_START`,
`WEBHOOK_OUTBOX_PUBLISHED`, `WEBHOOK_OUTBOX_PUBLISH_RETRY`,
`WEBHOOK_OUTBOX_DEAD_LETTER`, `WEBHOOK_OUTBOX_LEASE_RECOVERED`,
`WEBHOOK_OUTBOX_PUBLISHER_STARTED`, `WEBHOOK_OUTBOX_PUBLISHER_PARKED`,
`WEBHOOK_OUTBOX_PUBLISHER_STOPPING`, `WEBHOOK_OUTBOX_PUBLISHER_STOPPED`,
`WEBHOOK_OUTBOX_PUBLISHER_FAILED`.

Broker: `RABBITMQ_CONNECTED`, `RABBITMQ_DISCONNECTED`,
`RABBITMQ_RECONNECT_SCHEDULED`.

Nenhum registra token, segredo, DSN, `RABBITMQ_URL`, senha, payload bruto ou
base64. Erros externos passam por máscara antes de virar log ou `last_error`.
Os headers salvos em `request_headers` passam por allowlist; headers sensíveis
viram apenas um booleano de presença (`has_apikey`, `has_x_hub_signature_256`,
`has_cookie`).

## Migrations

Aplicar nesta ordem (a outbox tem FK para a inbox):

1. `docs/migrations/20260808_webhook_inbox.sql`
2. `docs/migrations/20260808_webhook_outbox.sql`

Reverter na ordem inversa:

1. `docs/migrations/20260808_webhook_outbox_rollback.sql`
2. `docs/migrations/20260808_webhook_inbox_rollback.sql`

As duas são transacionais e não apagam payload automaticamente. Ambas precisam
estar aplicadas **antes** de ligar `WEBHOOK_DURABLE_INBOX_ENABLED`: com a flag
ligada e a outbox ausente, a transação falha e a ingestão responde 503.

O rollback da outbox **não** toca em `webhook_inbox`.

## Rollback

`WEBHOOK_DURABLE_INBOX_ENABLED=false` devolve o comportamento anterior na hora,
sem deploy: as rotas voltam a chamar o processador legado pelo gate de
concorrência. `RABBITMQ_ENABLED=false` estaciona o publicador sem perder nada —
as mensagens continuam `pending` na outbox. As tabelas podem ficar no lugar;
derrubá-las só é necessário se as migrations forem revertidas.

## Testes

```
npx tsx scripts/test-webhook-inbox.mjs
npx tsx scripts/test-webhook-outbox.mjs
```

Integração opcional com um broker de DEV (ignorada por padrão, nunca no CI):

```
WEBHOOK_OUTBOX_INTEGRATION=true RABBITMQ_ENABLED=true RABBITMQ_URL=amqp://… \
  npx tsx scripts/test-webhook-outbox-integration.mjs
```
