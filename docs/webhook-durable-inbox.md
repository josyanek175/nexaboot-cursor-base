# Inbox durável de webhooks — Etapa 1 (ingestão)

Garantia central desta etapa: **o HTTP 200 só é devolvido depois do COMMIT** do
evento em `public.webhook_inbox`. Nenhuma operação de contato, conversa,
mensagem, mídia ou campanha acontece dentro da requisição HTTP.

O worker de processamento é a Etapa 2 e **não** existe ainda. Com
`WEBHOOK_DURABLE_INBOX_ENABLED=true` e `WEBHOOK_DURABLE_INBOX_PROCESSING_ENABLED=false`,
os eventos ficam acumulando em `status = 'pending'`.

## Fluxo

1. Validação do provedor (token da Evolution / assinatura HMAC da Meta).
2. Reserva de memória para o corpo (ver "Payloads grandes").
3. Leitura do corpo com teto de bytes, corte por inatividade e teto absoluto.
4. Extração dos identificadores mínimos e da `deduplication_key`.
5. `INSERT ... ON CONFLICT (provider, deduplication_key) DO NOTHING` no pool
   dedicado, dentro de transação com `statement_timeout`.
6. Só depois do COMMIT, resposta 200.

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
| `WEBHOOK_DURABLE_INBOX_PROCESSING_ENABLED` | `false` | Reservada para a Etapa 2. Sem efeito hoje. |
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

## Logs

`WEBHOOK_INBOX_RECEIVED`, `WEBHOOK_INBOX_PERSISTED`, `WEBHOOK_INBOX_DUPLICATE`,
`WEBHOOK_INBOX_PERSIST_FAILED`, `WEBHOOK_INBOX_PAYLOAD_REJECTED`,
`WEBHOOK_INBOX_THROTTLED`, `WEBHOOK_INBOX_POOL_CONFIG`.

Nenhum registra token, segredo, DSN ou payload completo. Os headers salvos em
`request_headers` passam por allowlist; headers sensíveis viram apenas um
booleano de presença (`has_apikey`, `has_x_hub_signature_256`, `has_cookie`).

## Migration

- Aplicar: `docs/migrations/20260808_webhook_inbox.sql`
- Reverter: `docs/migrations/20260808_webhook_inbox_rollback.sql`

A migration é transacional e não apaga payload automaticamente. Ela precisa ser
aplicada **antes** de ligar `WEBHOOK_DURABLE_INBOX_ENABLED`.

## Rollback

`WEBHOOK_DURABLE_INBOX_ENABLED=false` devolve o comportamento anterior na hora,
sem deploy: as rotas voltam a chamar o processador legado pelo gate de
concorrência. A tabela pode ficar no lugar; derrubá-la só é necessário se a
migration for revertida.

## Testes

```
npx tsx scripts/test-webhook-inbox.mjs
```
