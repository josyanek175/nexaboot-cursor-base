/**
 * Testes da ETAPA 2: outbox transacional + publicador RabbitMQ.
 *
 * Nenhum teste conecta em RabbitMQ ou PostgreSQL de verdade. O broker é
 * substituído por um driver falso e o banco por um fake com semântica
 * transacional (ver test-webhook-db-fake.mjs). O teste de integração opcional
 * com broker real fica em test-webhook-outbox-integration.mjs.
 *
 *   npx tsx scripts/test-webhook-outbox.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertRabbitConfig,
  createRabbitPublisher,
  isRabbitUnavailable,
  maskRabbitError,
  RABBITMQ_DEFAULT_EXCHANGE,
  RabbitUnavailableError,
  readRabbitConfig,
} from "../src/lib/rabbitmq.server.ts";
import {
  buildOutboxMessagePayload,
  buildOutboxRoutingKey,
  computeOutboxRetryDelayMs,
  OUTBOX_MESSAGE_SCHEMA_VERSION,
  readWebhookOutboxConfig,
  readWebhookOutboxExchange,
  shouldDeadLetter,
  WEBHOOK_OUTBOX_DEFAULT_BATCH_SIZE,
  WEBHOOK_OUTBOX_DEFAULT_LEASE_MS,
  WEBHOOK_OUTBOX_DEFAULT_MAX_ATTEMPTS,
  WEBHOOK_OUTBOX_PARKED_POLL_INTERVAL_MS,
} from "../src/lib/webhook-outbox-core.ts";
import {
  createSqlOutboxRepository,
  ensureOutboxForInbox,
} from "../src/lib/webhook-outbox.server.ts";
import {
  processOutboxBatch,
  runWebhookOutboxPublisherLoop,
} from "../src/lib/webhook-outbox-publisher.server.ts";
import { ingestWebhookEvent, ingestWebhookRequestToInbox } from "../src/lib/webhook-inbox.server.ts";
import { extractWebhookIdentifiers } from "../src/lib/webhook-inbox-core.ts";
import { createStore, makeSql } from "./test-webhook-db-fake.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

let failed = 0;
function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

const silent = { log: () => {}, logError: () => {} };
const tick = () => new Promise((r) => setTimeout(r, 0));

const evolutionPayload = {
  event: "messages.upsert",
  instance: "nexa-01",
  data: {
    key: { remoteJid: "5511999999999@s.whatsapp.net", fromMe: false, id: "WAMID-A" },
    pushName: "Cliente",
    message: { conversation: "ola" },
  },
};

function makeRequest(bodyObject, headers = {}) {
  return new Request("https://app.nexaboot.com/api/webhooks/evolution", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof bodyObject === "string" ? bodyObject : JSON.stringify(bodyObject),
  });
}

// ---------------------------------------------------------------------------
// Configuração da outbox
// ---------------------------------------------------------------------------

{
  const config = readWebhookOutboxConfig({});
  assert("max attempts default", config.maxAttempts === WEBHOOK_OUTBOX_DEFAULT_MAX_ATTEMPTS);
  assert("base retry default", config.baseRetryMs === 1000);
  assert("max retry default", config.maxRetryMs === 300_000);
  assert("lease default", config.leaseMs === WEBHOOK_OUTBOX_DEFAULT_LEASE_MS);
  assert("batch size default", config.batchSize === WEBHOOK_OUTBOX_DEFAULT_BATCH_SIZE);
  assert("poll interval default", config.pollIntervalMs === 1000);
}

{
  const config = readWebhookOutboxConfig({
    WEBHOOK_OUTBOX_MAX_ATTEMPTS: "4",
    WEBHOOK_OUTBOX_BASE_RETRY_MS: "250",
    WEBHOOK_OUTBOX_MAX_RETRY_MS: "9000",
    WEBHOOK_OUTBOX_LEASE_MS: "15000",
    WEBHOOK_OUTBOX_BATCH_SIZE: "7",
    WEBHOOK_OUTBOX_POLL_INTERVAL_MS: "500",
  });
  assert("max attempts customizado", config.maxAttempts === 4);
  assert("base retry customizado", config.baseRetryMs === 250);
  assert("max retry customizado", config.maxRetryMs === 9000);
  assert("lease customizado", config.leaseMs === 15_000);
  assert("batch size customizado", config.batchSize === 7);
  assert("poll interval customizado", config.pollIntervalMs === 500);
}

{
  const config = readWebhookOutboxConfig({
    WEBHOOK_OUTBOX_MAX_ATTEMPTS: "0",
    WEBHOOK_OUTBOX_BASE_RETRY_MS: "-5",
    WEBHOOK_OUTBOX_BATCH_SIZE: "abc",
    WEBHOOK_OUTBOX_LEASE_MS: "",
  });
  assert("valor invalido volta ao default (attempts)", config.maxAttempts === 10);
  assert("valor invalido volta ao default (base retry)", config.baseRetryMs === 1000);
  assert("valor invalido volta ao default (batch)", config.batchSize === 50);
  assert("valor vazio volta ao default (lease)", config.leaseMs === 60_000);
}

{
  // Teto abaixo da base é contraditório: a base tem que vencer para o delay
  // nunca ficar menor que o mínimo configurado.
  const config = readWebhookOutboxConfig({
    WEBHOOK_OUTBOX_BASE_RETRY_MS: "5000",
    WEBHOOK_OUTBOX_MAX_RETRY_MS: "1000",
  });
  assert("max retry nunca menor que base", config.maxRetryMs === 5000);
}

// ---------------------------------------------------------------------------
// 12. Backoff exponencial com jitter
// ---------------------------------------------------------------------------

{
  const config = { baseRetryMs: 1000, maxRetryMs: 60_000 };
  const ceilings = [1, 2, 3, 4, 5, 6, 7].map((a) =>
    computeOutboxRetryDelayMs(a, config, () => 1),
  );
  assert("backoff cresce exponencialmente", ceilings[0] === 1000 && ceilings[1] === 2000 && ceilings[2] === 4000);
  assert("backoff e monotonico", ceilings.every((v, i) => i === 0 || v >= ceilings[i - 1]));
  assert("backoff respeita o teto", ceilings.every((v) => v <= 60_000));
  assert("backoff satura no teto", computeOutboxRetryDelayMs(30, config, () => 1) === 60_000);
}

{
  const config = { baseRetryMs: 1000, maxRetryMs: 60_000 };
  const low = computeOutboxRetryDelayMs(5, config, () => 0);
  const high = computeOutboxRetryDelayMs(5, config, () => 1);
  assert("jitter nunca cai abaixo da base", low >= 1000);
  assert("jitter varia dentro do teto da tentativa", high === 16_000 && low < high);

  const samples = new Set();
  let seq = 0;
  for (let i = 0; i < 20; i += 1) {
    seq += 0.05;
    samples.add(computeOutboxRetryDelayMs(6, config, () => seq % 1));
  }
  assert("jitter produz valores distintos", samples.size > 1);
}

{
  // Expoente enorme não pode virar Infinity nem NaN.
  const v = computeOutboxRetryDelayMs(10_000, { baseRetryMs: 1000, maxRetryMs: 300_000 }, () => 1);
  assert("backoff com tentativa altissima continua finito", Number.isFinite(v) && v === 300_000);
}

{
  assert("dead letter no limite", shouldDeadLetter(10, { maxAttempts: 10 }) === true);
  assert("dead letter acima do limite", shouldDeadLetter(11, { maxAttempts: 10 }) === true);
  assert("sem dead letter antes do limite", shouldDeadLetter(9, { maxAttempts: 10 }) === false);
}

// ---------------------------------------------------------------------------
// Routing key e exchange
// ---------------------------------------------------------------------------

{
  assert(
    "routing key evolution",
    buildOutboxRoutingKey("evolution", "messages.upsert") === "evolution.messages.upsert",
  );
  assert("routing key meta", buildOutboxRoutingKey("meta", "messages") === "meta.messages");
  assert("routing key sem evento", buildOutboxRoutingKey("evolution", null) === "evolution.unknown");
  assert(
    "routing key normaliza caracteres invalidos",
    buildOutboxRoutingKey("meta", "messages,message_template_status_update") ===
      "meta.messages_message_template_status_update",
  );
  assert(
    "routing key normaliza maiusculas e espacos",
    buildOutboxRoutingKey("evolution", "  MESSAGES UPSERT ") === "evolution.messages_upsert",
  );
  assert(
    "routing key nao passa de 200 chars",
    buildOutboxRoutingKey("evolution", "x".repeat(500)).length <= 200,
  );
}

{
  assert("exchange default e de DEV", readWebhookOutboxExchange({}) === "nexaboot.dev.webhooks");
  assert("exchange default exportada", RABBITMQ_DEFAULT_EXCHANGE === "nexaboot.dev.webhooks");
  assert(
    "exchange customizada",
    readWebhookOutboxExchange({ RABBITMQ_EXCHANGE: "nexaboot.prod.webhooks" }) ===
      "nexaboot.prod.webhooks",
  );
}

// ---------------------------------------------------------------------------
// 14. Payload da outbox: pequeno, sem payload bruto nem base64
// ---------------------------------------------------------------------------

{
  const identifiers = extractWebhookIdentifiers("evolution", evolutionPayload);
  assert("conversation key evolution", identifiers.conversationKey === "5511999999999@s.whatsapp.net");

  const message = buildOutboxMessagePayload({
    inboxId: "11111111-1111-1111-1111-111111111111",
    provider: "evolution",
    identifiers,
    companyId: "22222222-2222-2222-2222-222222222222",
    channelId: null,
    receivedAt: "2026-08-08T12:00:00.000Z",
  });

  assert("schema version presente", message.schemaVersion === OUTBOX_MESSAGE_SCHEMA_VERSION);
  assert("inboxId presente", message.inboxId === "11111111-1111-1111-1111-111111111111");
  assert("provider presente", message.provider === "evolution");
  assert("eventType presente", message.eventType === "messages.upsert");
  assert("instanceName presente", message.instanceName === "nexa-01");
  assert("externalMessageId presente", message.externalMessageId === "WAMID-A");
  assert("conversationKey presente", message.conversationKey === "5511999999999@s.whatsapp.net");
  assert("receivedAt presente", message.receivedAt === "2026-08-08T12:00:00.000Z");

  const keys = Object.keys(message).sort();
  assert(
    "mensagem tem apenas referencias e metadados",
    keys.join(",") ===
      "channelId,companyId,conversationKey,eventType,externalEventId,externalMessageId,inboxId,instanceName,provider,receivedAt,schemaVersion",
  );

  const serialized = JSON.stringify(message);
  assert("mensagem nao carrega o texto da mensagem", !serialized.includes('"ola"'));
  assert("mensagem nao carrega o campo message", !serialized.includes('"message"'));
  assert("mensagem nao carrega pushName", !serialized.includes("Cliente"));
  assert("mensagem e pequena", serialized.length < 700);
}

{
  // Mídia em base64 é exatamente o caso que não pode ser duplicado na fila.
  const base64 = "A".repeat(5000);
  const heavy = {
    event: "messages.upsert",
    instance: "nexa-01",
    data: {
      key: { remoteJid: "5511@s.whatsapp.net", id: "WAMID-B" },
      message: { imageMessage: { jpegThumbnail: base64 } },
      base64,
    },
  };
  const message = buildOutboxMessagePayload({
    inboxId: "33333333-3333-3333-3333-333333333333",
    provider: "evolution",
    identifiers: extractWebhookIdentifiers("evolution", heavy),
    receivedAt: new Date().toISOString(),
  });
  const serialized = JSON.stringify(message);
  assert("mensagem nao contem base64", !serialized.includes(base64.slice(0, 100)));
  assert("mensagem continua pequena com midia grande", serialized.length < 700);
}

{
  const metaPayload = {
    entry: [
      {
        id: "ENTRY-1",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "PNID-1" },
              contacts: [{ wa_id: "5511888888888" }],
              messages: [{ id: "wamid.META-1", from: "5511888888888" }],
            },
          },
        ],
      },
    ],
  };
  const identifiers = extractWebhookIdentifiers("meta", metaPayload);
  assert("conversation key meta vem de contacts", identifiers.conversationKey === "5511888888888");
  assert("meta mantem external event id", identifiers.externalEventId === "ENTRY-1");
}

// ---------------------------------------------------------------------------
// 1, 2, 3. Atomicidade inbox + outbox
// ---------------------------------------------------------------------------

{
  const store = createStore();
  const { sql, state } = makeSql(store);

  const outcome = await ingestWebhookEvent({
    sql,
    provider: "evolution",
    rawBody: JSON.stringify(evolutionPayload),
    payloadSizeBytes: 120,
    headers: new Headers({ "content-type": "application/json" }),
    ...silent,
  });

  assert("evento novo persistido", outcome.status === "persisted");
  assert("inbox tem exatamente uma linha", store.rows.length === 1);
  assert("outbox tem exatamente uma linha", store.outbox.length === 1);
  assert("outbox aponta para a inbox", store.outbox[0].inbox_id === store.rows[0].id);
  assert("outcome expoe o outboxId", outcome.outboxId === store.outbox[0].id);
  assert("apenas um COMMIT", state.commits === 1);
  assert("nenhum ROLLBACK", state.rollbacks === 0);

  const inboxIndex = state.queries.findIndex((q) => q.includes("INSERT INTO public.webhook_inbox"));
  const outboxIndex = state.queries.findIndex((q) =>
    q.includes("INSERT INTO public.webhook_outbox"),
  );
  assert("inbox e outbox gravadas na mesma transacao", inboxIndex >= 0 && outboxIndex > inboxIndex);

  assert("outbox usa a exchange resolvida", store.outbox[0].exchange_name === "nexaboot.dev.webhooks");
  assert("outbox usa routing key derivada", store.outbox[0].routing_key === "evolution.messages.upsert");
  assert("outbox nasce pending", store.outbox[0].status === "pending");

  const message = JSON.parse(store.outbox[0].message_payload);
  assert("mensagem gravada referencia a inbox", message.inboxId === store.rows[0].id);
  assert("mensagem gravada nao tem payload bruto", !store.outbox[0].message_payload.includes("pushName"));
}

{
  // 2. Falha no INSERT da outbox desfaz o INSERT da inbox.
  const store = createStore();
  const { sql, state } = makeSql(store, { failOnOutboxInsert: true });

  const outcome = await ingestWebhookEvent({
    sql,
    provider: "evolution",
    rawBody: JSON.stringify(evolutionPayload),
    payloadSizeBytes: 120,
    headers: new Headers(),
    ...silent,
  });

  assert("falha na outbox devolve failed", outcome.status === "failed");
  assert("inbox foi desfeita", store.rows.length === 0);
  assert("outbox continua vazia", store.outbox.length === 0);
  assert("transacao sofreu rollback", state.rollbacks === 1);
  assert("nenhum COMMIT aconteceu", state.commits === 0);
}

{
  // 3. HTTP 200 só depois do COMMIT dos dois registros.
  const store = createStore();
  const { sql, state } = makeSql(store, { commitDelayMs: 30 });

  const response = await ingestWebhookRequestToInbox({
    sql,
    provider: "evolution",
    request: makeRequest(evolutionPayload),
    ...silent,
  });
  const respondedAt = Date.now();

  assert("resposta 200", response.status === 200);
  assert("200 so depois do COMMIT", state.commits === 1 && respondedAt >= state.committedAt);
  assert("inbox gravada antes do 200", store.rows.length === 1);
  assert("outbox gravada antes do 200", store.outbox.length === 1);
}

{
  // Falha de persistência não pode virar 200 nem deixar outbox órfã.
  const store = createStore();
  const { sql } = makeSql(store, { failOnOutboxInsert: true });

  const response = await ingestWebhookRequestToInbox({
    sql,
    provider: "evolution",
    request: makeRequest(evolutionPayload),
    ...silent,
  });

  assert("falha da outbox devolve 503", response.status === 503);
  assert("503 traz Retry-After", response.headers.get("Retry-After") != null);
  assert("nada foi persistido", store.rows.length === 0 && store.outbox.length === 0);
}

{
  // 4. Duplicado não cria segunda inbox nem segunda outbox.
  const store = createStore();
  const { sql, state } = makeSql(store);
  const args = {
    sql,
    provider: "evolution",
    rawBody: JSON.stringify(evolutionPayload),
    payloadSizeBytes: 120,
    headers: new Headers(),
    ...silent,
  };

  const first = await ingestWebhookEvent(args);
  const second = await ingestWebhookEvent(args);

  assert("primeiro evento persistido", first.status === "persisted");
  assert("segundo evento e duplicado", second.status === "duplicate");
  assert("inbox continua com uma linha", store.rows.length === 1);
  assert("outbox continua com uma linha", store.outbox.length === 1);
  assert("duplicado devolve o mesmo inboxId", second.inboxId === first.inboxId);
  assert("duplicado devolve o mesmo outboxId", second.outboxId === first.outboxId);
  assert("dois COMMITs, nenhum rollback", state.commits === 2 && state.rollbacks === 0);
}

{
  // 5. Inbox duplicada sem outbox é reparada (evento gravado pela etapa 1).
  const store = createStore();
  const logs = [];
  const { sql } = makeSql(store);

  const identifiers = extractWebhookIdentifiers("evolution", evolutionPayload);
  const dedupKey = `evolution:${identifiers.instanceName}:${identifiers.eventType}:WAMID-A`;
  store.rows.push({
    id: "inbox-legado",
    provider: "evolution",
    deduplication_key: dedupKey,
    received_at: "2026-08-01T10:00:00.000Z",
    status: "pending",
  });

  const outcome = await ingestWebhookEvent({
    sql,
    provider: "evolution",
    rawBody: JSON.stringify(evolutionPayload),
    payloadSizeBytes: 120,
    headers: new Headers(),
    log: (tag, data) => logs.push({ tag, data }),
    logError: () => {},
  });

  assert("evento legado e tratado como duplicado", outcome.status === "duplicate");
  assert("inbox legada nao duplicou", store.rows.length === 1);
  assert("outbox faltante foi criada", store.outbox.length === 1);
  assert("outbox reparada aponta para a inbox legada", store.outbox[0].inbox_id === "inbox-legado");

  const created = logs.find((l) => l.tag === "WEBHOOK_OUTBOX_CREATED");
  assert("reparo emite WEBHOOK_OUTBOX_CREATED", created != null);
  assert("reparo e sinalizado no log", created?.data.repaired === true);
}

{
  // Duplicado com outbox existente emite WEBHOOK_OUTBOX_DUPLICATE.
  const store = createStore();
  const logs = [];
  const { sql } = makeSql(store);
  const args = {
    sql,
    provider: "evolution",
    rawBody: JSON.stringify(evolutionPayload),
    payloadSizeBytes: 120,
    headers: new Headers(),
    log: (tag, data) => logs.push({ tag, data }),
    logError: () => {},
  };

  await ingestWebhookEvent(args);
  logs.length = 0;
  await ingestWebhookEvent(args);

  assert("duplicado emite WEBHOOK_OUTBOX_DUPLICATE", logs.some((l) => l.tag === "WEBHOOK_OUTBOX_DUPLICATE"));
  assert("duplicado nao emite WEBHOOK_OUTBOX_CREATED", !logs.some((l) => l.tag === "WEBHOOK_OUTBOX_CREATED"));
  const dup = logs.find((l) => l.tag === "WEBHOOK_OUTBOX_DUPLICATE");
  assert("log de outbox nao carrega payload", !JSON.stringify(dup).includes("pushName"));
}

{
  // Conflito sem linha visível (corrida real): não pode responder 200.
  const store = createStore();
  const invisible = {
    begin: async (fn) => {
      const tx = (strings) => {
        const text = strings.join("|");
        if (text.includes("INSERT INTO public.webhook_inbox")) return Promise.resolve([]);
        if (text.includes("FROM public.webhook_inbox")) return Promise.resolve([]);
        return Promise.resolve([]);
      };
      tx.unsafe = async () => [];
      return fn(tx);
    },
  };
  void store;

  const response = await ingestWebhookRequestToInbox({
    sql: invisible,
    provider: "evolution",
    request: makeRequest(evolutionPayload),
    ...silent,
  });
  assert("corrida sem linha visivel devolve 503", response.status === 503);
}

{
  // ensureOutboxForInbox isolado: cria uma vez, depois só localiza.
  const store = createStore();
  const { sql } = makeSql(store);
  const message = buildOutboxMessagePayload({
    inboxId: "inbox-x",
    provider: "meta",
    identifiers: {
      eventType: "messages",
      instanceName: "PNID-1",
      externalEventId: null,
      externalMessageId: "wamid.X",
      conversationKey: "5511",
    },
    receivedAt: new Date().toISOString(),
  });

  const first = await sql.begin((tx) =>
    ensureOutboxForInbox(tx, {
      inboxId: "inbox-x",
      exchangeName: "nexaboot.dev.webhooks",
      routingKey: "meta.messages",
      messagePayload: message,
    }),
  );
  const second = await sql.begin((tx) =>
    ensureOutboxForInbox(tx, {
      inboxId: "inbox-x",
      exchangeName: "nexaboot.dev.webhooks",
      routingKey: "meta.messages",
      messagePayload: message,
    }),
  );

  assert("ensureOutbox cria na primeira vez", first.created === true && first.outboxId != null);
  assert("ensureOutbox nao duplica", second.created === false);
  assert("ensureOutbox devolve o mesmo id", second.outboxId === first.outboxId);
  assert("apenas uma linha na outbox", store.outbox.length === 1);
}

// ---------------------------------------------------------------------------
// 6. RabbitMQ indisponível não afeta a persistência
// ---------------------------------------------------------------------------

{
  const inboxSource = readSource("src/lib/webhook-inbox.server.ts");
  assert(
    "ingestao nao importa a camada RabbitMQ",
    !inboxSource.includes("rabbitmq.server"),
  );
  const outboxSource = readSource("src/lib/webhook-outbox.server.ts");
  assert(
    "persistencia da outbox nao importa a camada RabbitMQ",
    !outboxSource.includes("rabbitmq.server"),
  );
  for (const rel of [
    "src/routes/api/public/webhooks/evolution.ts",
    "src/lib/meta-webhook.server.ts",
    "src/lib/webhook-ingress.server.ts",
  ]) {
    const source = readSource(rel);
    assert(`${rel} nao importa rabbitmq`, !source.includes("rabbitmq.server"));
    assert(`${rel} nao importa amqplib`, !source.includes("amqplib"));
  }
}

{
  // Sem broker configurado, a ingestão continua respondendo 200.
  const store = createStore();
  const { sql } = makeSql(store);
  const response = await ingestWebhookRequestToInbox({
    sql,
    provider: "evolution",
    request: makeRequest(evolutionPayload),
    env: { RABBITMQ_ENABLED: "false" },
    ...silent,
  });
  assert("broker desligado nao afeta o 200", response.status === 200);
  assert("evento preservado na outbox", store.outbox.length === 1 && store.outbox[0].status === "pending");
}

// ---------------------------------------------------------------------------
// Camada RabbitMQ
// ---------------------------------------------------------------------------

function createFakeAmqp(options = {}) {
  const events = { asserted: [], published: [], connects: 0, closed: false, connClosed: false };
  let confirmMode = options.confirm ?? "ok";

  const channel = {
    assertExchange: async (name, type, opts) => {
      events.asserted.push({ kind: "exchange", name, type, opts });
    },
    assertQueue: async (name, opts) => {
      events.asserted.push({ kind: "queue", name, opts });
    },
    bindQueue: async (queue, exchange, pattern) => {
      events.asserted.push({ kind: "bind", queue, exchange, pattern });
    },
    prefetch: (n) => {
      events.prefetch = n;
    },
    publish: (exchange, routingKey, content, opts, cb) => {
      events.published.push({ exchange, routingKey, content, opts });
      if (confirmMode === "ok") setTimeout(() => cb(null), 0);
      else if (confirmMode === "nack") setTimeout(() => cb(new Error("broker nacked")), 0);
      return true;
    },
    close: async () => {
      events.closed = true;
    },
    on: () => {},
  };

  const connection = {
    createConfirmChannel: async () => channel,
    close: async () => {
      events.connClosed = true;
    },
    on: () => {},
  };

  const connect = async (url, opts) => {
    events.connects += 1;
    events.lastUrl = url;
    events.lastTimeout = opts.timeout;
    if (options.failConnect) {
      throw new Error("connect ECONNREFUSED amqp://nexa:s3cr3t@rabbit.internal:5672");
    }
    return connection;
  };

  return { connect, events, setConfirmMode: (m) => (confirmMode = m) };
}

const baseRabbitConfig = {
  enabled: true,
  url: "amqp://nexa:s3cr3t@rabbit.internal:5672",
  exchange: "nexaboot.dev.webhooks",
  queue: "nexaboot.dev.webhook.queue",
  dlq: "nexaboot.dev.webhook.dlq",
  prefetch: 10,
  connectTimeoutMs: 7000,
  reconnectMinMs: 1000,
  reconnectMaxMs: 30_000,
};

{
  const config = readRabbitConfig({});
  assert("rabbit desabilitado por padrao", config.enabled === false);
  assert("url ausente vira null", config.url === null);
  assert("exchange default dev", config.exchange === "nexaboot.dev.webhooks");
  assert("queue default dev", config.queue === "nexaboot.dev.webhook.queue");
  assert("dlq default dev", config.dlq === "nexaboot.dev.webhook.dlq");
  assert("prefetch default", config.prefetch === 10);
  assert("connect timeout default", config.connectTimeoutMs === 10_000);
  assert("reconnect min default", config.reconnectMinMs === 1000);
  assert("reconnect max default", config.reconnectMaxMs === 30_000);
}

{
  const config = readRabbitConfig({
    RABBITMQ_ENABLED: "true",
    RABBITMQ_URL: "amqp://u:p@host",
    RABBITMQ_EXCHANGE: "nexaboot.stg.webhooks",
    RABBITMQ_WEBHOOK_QUEUE: "nexaboot.stg.queue",
    RABBITMQ_WEBHOOK_DLQ: "nexaboot.stg.dlq",
    RABBITMQ_PREFETCH: "25",
    RABBITMQ_CONNECT_TIMEOUT_MS: "4000",
    RABBITMQ_RECONNECT_MIN_MS: "500",
    RABBITMQ_RECONNECT_MAX_MS: "120000",
  });
  assert("rabbit habilitado por env", config.enabled === true);
  assert("nomes isolados por ambiente", config.exchange === "nexaboot.stg.webhooks");
  assert("prefetch customizado", config.prefetch === 25);
  assert("connect timeout customizado", config.connectTimeoutMs === 4000);
  assert("reconnect customizado", config.reconnectMinMs === 500 && config.reconnectMaxMs === 120_000);
}

{
  const config = readRabbitConfig({ RABBITMQ_RECONNECT_MIN_MS: "9000", RABBITMQ_RECONNECT_MAX_MS: "1000" });
  assert("reconnect max nunca menor que min", config.reconnectMaxMs === 9000);
}

{
  let threw = null;
  try {
    assertRabbitConfig({ ...baseRabbitConfig, url: null });
  } catch (e) {
    threw = e;
  }
  assert("enabled sem url falha cedo", threw != null && /RABBITMQ_URL/.test(threw.message));

  threw = null;
  try {
    assertRabbitConfig({ ...baseRabbitConfig, dlq: baseRabbitConfig.queue });
  } catch (e) {
    threw = e;
  }
  assert("queue igual a dlq falha cedo", threw != null);

  let ok = true;
  try {
    assertRabbitConfig({ ...baseRabbitConfig, enabled: false, url: null });
  } catch {
    ok = false;
  }
  assert("desabilitado nao exige configuracao", ok === true);
}

{
  const amqp = createFakeAmqp();
  const logs = [];
  const publisher = createRabbitPublisher({
    config: baseRabbitConfig,
    connect: amqp.connect,
    log: (tag, data) => logs.push({ tag, data }),
    logError: (tag, data) => logs.push({ tag, data }),
  });

  await publisher.publish({ routingKey: "evolution.messages.upsert", body: { a: 1 }, messageId: "m-1" });

  assert("conectou uma vez", amqp.events.connects === 1);
  assert("usou o connect timeout configurado", amqp.events.lastTimeout === 7000);

  const exchange = amqp.events.asserted.find((e) => e.kind === "exchange");
  assert("exchange e topic durable", exchange?.type === "topic" && exchange?.opts.durable === true);

  const queues = amqp.events.asserted.filter((e) => e.kind === "queue");
  assert("duas filas declaradas", queues.length === 2);
  assert("filas durable", queues.every((q) => q.opts.durable === true));
  const main = queues.find((q) => q.name === baseRabbitConfig.queue);
  assert(
    "fila principal aponta para a DLQ",
    main?.opts.arguments?.["x-dead-letter-routing-key"] === baseRabbitConfig.dlq,
  );

  const bind = amqp.events.asserted.find((e) => e.kind === "bind");
  assert("fila ligada a exchange", bind?.exchange === baseRabbitConfig.exchange);
  assert("prefetch aplicado", amqp.events.prefetch === 10);

  const published = amqp.events.published[0];
  assert("mensagem persistente", published.opts.persistent === true);
  assert("content type json", published.opts.contentType === "application/json");
  assert("messageId propagado", published.opts.messageId === "m-1");
  assert("routing key propagada", published.routingKey === "evolution.messages.upsert");
  assert("corpo serializado em json", JSON.parse(published.content.toString("utf8")).a === 1);

  await publisher.publish({ routingKey: "evolution.messages.upsert", body: { a: 2 } });
  assert("conexao e canal reutilizados", amqp.events.connects === 1);
  assert("duas mensagens publicadas", amqp.events.published.length === 2);

  assert("emitiu RABBITMQ_CONNECTED", logs.some((l) => l.tag === "RABBITMQ_CONNECTED"));
  const dump = JSON.stringify(logs);
  assert("nenhum log traz a URL do broker", !dump.includes("rabbit.internal"));
  assert("nenhum log traz a senha", !dump.includes("s3cr3t"));

  await publisher.close();
  assert("close fecha canal e conexao", amqp.events.closed && amqp.events.connClosed);
  assert("publisher fica desconectado", publisher.isConnected() === false);
}

{
  // 9. Publish só resolve depois do confirm do broker.
  const amqp = createFakeAmqp({ confirm: "never" });
  const publisher = createRabbitPublisher({
    config: baseRabbitConfig,
    connect: amqp.connect,
    ...{ log: () => {}, logError: () => {} },
  });

  let resolved = false;
  const promise = publisher.publish({ routingKey: "k", body: {} }).then(() => (resolved = true));
  await tick();
  await tick();
  assert("mensagem foi entregue ao canal", amqp.events.published.length === 1);
  assert("publish nao resolve sem confirm", resolved === false);

  await publisher.close();
  await tick();
  assert("publish pendente nunca vira sucesso sem confirm", resolved === false);
  void promise.catch(() => {});
}

{
  const amqp = createFakeAmqp({ confirm: "nack" });
  const publisher = createRabbitPublisher({
    config: baseRabbitConfig,
    connect: amqp.connect,
    log: () => {},
    logError: () => {},
  });

  let rejected = false;
  try {
    await publisher.publish({ routingKey: "k", body: {} });
  } catch {
    rejected = true;
  }
  assert("nack rejeita a publicacao", rejected === true);
  assert("nack derruba o canal para reconectar", publisher.isConnected() === false);
}

{
  // Broker fora: erro tipado + backoff, sem martelar a cada mensagem.
  const amqp = createFakeAmqp({ failConnect: true });
  const logs = [];
  let clock = 1_000_000;
  const publisher = createRabbitPublisher({
    config: baseRabbitConfig,
    connect: amqp.connect,
    log: (tag, data) => logs.push({ tag, data }),
    logError: (tag, data) => logs.push({ tag, data }),
    now: () => clock,
    random: () => 1,
  });

  let error = null;
  try {
    await publisher.publish({ routingKey: "k", body: {} });
  } catch (e) {
    error = e;
  }
  assert("falha de conexao vira RabbitUnavailableError", isRabbitUnavailable(error));
  assert("erro carrega o prazo do backoff", error.retryInMs === 1000);
  assert("emitiu RABBITMQ_RECONNECT_SCHEDULED", logs.some((l) => l.tag === "RABBITMQ_RECONNECT_SCHEDULED"));

  const connectsAfterFirst = amqp.events.connects;
  let second = null;
  try {
    await publisher.publish({ routingKey: "k", body: {} });
  } catch (e) {
    second = e;
  }
  assert("dentro do backoff falha sem nova tentativa", amqp.events.connects === connectsAfterFirst);
  assert("erro do backoff e identificavel", second.reason === "reconnect_backoff");

  clock += 5000;
  try {
    await publisher.publish({ routingKey: "k", body: {} });
  } catch {
    // continua indisponível
  }
  assert("depois do prazo tenta reconectar", amqp.events.connects === connectsAfterFirst + 1);
  assert("backoff cresce", publisher.getState().consecutiveFailures === 2);

  const dump = JSON.stringify(logs);
  assert("erro de conexao nao vaza credenciais", !dump.includes("s3cr3t") && !dump.includes("rabbit.internal"));
  assert("erro mascarado marca o host", dump.includes("amqp://[redacted]"));
}

{
  assert(
    "maskRabbitError remove url amqp",
    maskRabbitError(new Error("fail amqp://u:p@h:5672/vh")) === "fail amqp://[redacted]",
  );
  assert(
    "maskRabbitError remove dsn postgres",
    maskRabbitError(new Error("boom postgres://u:p@h/db")).includes("postgres://[redacted]"),
  );
  assert(
    "maskRabbitError remove senha solta",
    maskRabbitError(new Error("password=hunter2 invalido")).includes("password=[redacted]"),
  );
  assert("RabbitUnavailableError tem code", new RabbitUnavailableError("x", 1).code === "rabbitmq_unavailable");
}

// ---------------------------------------------------------------------------
// Repositório SQL: cláusulas obrigatórias
// ---------------------------------------------------------------------------

function createRecordingSql(responder = () => []) {
  const queries = [];
  const sql = (strings, ...values) => {
    const text = strings.join(" ? ");
    queries.push({ text, values });
    return Promise.resolve(responder(text, values));
  };
  return { sql, queries };
}

{
  // 7. Claim usa FOR UPDATE SKIP LOCKED.
  const { sql, queries } = createRecordingSql(() => [
    {
      id: "o-1",
      inbox_id: "i-1",
      exchange_name: "x",
      routing_key: "evolution.messages.upsert",
      message_payload: { inboxId: "i-1" },
      attempts: 1,
    },
  ]);
  const repo = createSqlOutboxRepository(sql);
  const rows = await repo.claimBatch({ batchSize: 25, leaseMs: 60_000, workerId: "w-1" });

  const claim = queries[0].text;
  assert("claim usa FOR UPDATE SKIP LOCKED", claim.includes("FOR UPDATE SKIP LOCKED"));
  assert("claim filtra pending e retry", claim.includes("status IN ('pending', 'retry')"));
  assert("claim respeita available_at", claim.includes("available_at <= now()"));
  assert("claim marca publishing", claim.includes("status = 'publishing'"));
  assert("claim incrementa attempts", claim.includes("attempts = o.attempts + 1"));
  assert("claim cria lease", claim.includes("lease_expires_at = now() + make_interval"));
  assert("claim passa batch, worker e lease", queries[0].values.join(",") === "25,w-1,60000");
  assert("claim mapeia colunas para camelCase", rows[0].inboxId === "i-1" && rows[0].routingKey === "evolution.messages.upsert");
}

{
  const { sql, queries } = createRecordingSql(() => [{ id: "o-1" }]);
  const repo = createSqlOutboxRepository(sql);

  await repo.markPublished({ id: "o-1", workerId: "w-1" });
  assert("markPublished exige status publishing", queries[0].text.includes("status = 'publishing'"));
  assert("markPublished exige o mesmo dono", queries[0].text.includes("locked_by = "));
  assert("markPublished grava published_at", queries[0].text.includes("published_at = now()"));

  await repo.markRetry({ id: "o-1", workerId: "w-1", error: "boom", delayMs: 4000 });
  assert("markRetry agenda com make_interval", queries[1].text.includes("make_interval"));
  assert("markRetry preserva o erro", queries[1].values.includes("boom"));

  await repo.markDeadLetter({ id: "o-1", workerId: "w-1", error: "fatal" });
  assert("markDeadLetter grava dead_letter", queries[2].text.includes("status = 'dead_letter'"));
  assert("markDeadLetter preserva last_error", queries[2].values.includes("fatal"));
  assert("markDeadLetter nao apaga registro", !queries[2].text.includes("DELETE"));

  await repo.recoverExpiredLeases();
  assert("recover procura lease vencido", queries[3].text.includes("lease_expires_at < now()"));
  assert("recover devolve para retry", queries[3].text.includes("status = 'retry'"));

  await repo.releaseClaims({ ids: ["o-1"], workerId: "w-1" });
  assert("release devolve a tentativa", queries[4].text.includes("attempts = GREATEST(0, attempts - 1)"));
  assert("release exige o mesmo dono", queries[4].text.includes("locked_by = "));
}

{
  const { sql } = createRecordingSql(() => []);
  const repo = createSqlOutboxRepository(sql);
  assert("markPublished sinaliza lease perdido", (await repo.markPublished({ id: "o", workerId: "w" })) === false);
  assert("releaseClaims sem ids nao consulta", (await repo.releaseClaims({ ids: [], workerId: "w" })) === 0);
}

// ---------------------------------------------------------------------------
// Motor de publicação (repositório em memória)
// ---------------------------------------------------------------------------

function createClock(start = 1_000_000) {
  return { t: start, now() { return this.t; }, advance(ms) { this.t += ms; } };
}

function createOutboxRows(count, overrides = {}) {
  return Array.from({ length: count }, (_, i) => ({
    id: `o-${i + 1}`,
    inbox_id: `i-${i + 1}`,
    exchange_name: "nexaboot.dev.webhooks",
    routing_key: "evolution.messages.upsert",
    message_payload: { schemaVersion: 1, inboxId: `i-${i + 1}` },
    status: "pending",
    attempts: 0,
    available_at: 0,
    locked_by: null,
    locked_at: null,
    lease_expires_at: null,
    published_at: null,
    last_error: null,
    ...overrides,
  }));
}

/** Simula a exclusividade que o FOR UPDATE SKIP LOCKED dá no PostgreSQL. */
function createMemoryRepo(rows, clock) {
  const find = (id) => rows.find((r) => r.id === id);
  const owns = (row, workerId) => row && row.status === "publishing" && row.locked_by === workerId;

  return {
    rows,
    async recoverExpiredLeases() {
      await Promise.resolve();
      const out = [];
      for (const r of rows) {
        if (r.status === "publishing" && r.lease_expires_at != null && r.lease_expires_at < clock.now()) {
          out.push({ id: r.id, attempts: r.attempts, lockedBy: r.locked_by });
          r.status = "retry";
          r.locked_by = null;
          r.locked_at = null;
          r.lease_expires_at = null;
          r.available_at = clock.now();
        }
      }
      return out;
    },
    async claimBatch({ batchSize, leaseMs, workerId }) {
      await Promise.resolve();
      const eligible = rows
        .filter((r) => (r.status === "pending" || r.status === "retry") && r.available_at <= clock.now())
        .sort((a, b) => a.available_at - b.available_at || a.id.localeCompare(b.id))
        .slice(0, batchSize);
      return eligible.map((r) => {
        r.status = "publishing";
        r.attempts += 1;
        r.locked_by = workerId;
        r.locked_at = clock.now();
        r.lease_expires_at = clock.now() + leaseMs;
        return {
          id: r.id,
          inboxId: r.inbox_id,
          exchangeName: r.exchange_name,
          routingKey: r.routing_key,
          messagePayload: r.message_payload,
          attempts: r.attempts,
        };
      });
    },
    async markPublished({ id, workerId }) {
      await Promise.resolve();
      const r = find(id);
      if (!owns(r, workerId)) return false;
      r.status = "published";
      r.published_at = clock.now();
      r.locked_by = null;
      r.lease_expires_at = null;
      r.last_error = null;
      return true;
    },
    async markRetry({ id, workerId, error, delayMs }) {
      await Promise.resolve();
      const r = find(id);
      if (!owns(r, workerId)) return false;
      r.status = "retry";
      r.available_at = clock.now() + delayMs;
      r.last_error = error;
      r.locked_by = null;
      r.lease_expires_at = null;
      return true;
    },
    async markDeadLetter({ id, workerId, error }) {
      await Promise.resolve();
      const r = find(id);
      if (!owns(r, workerId)) return false;
      r.status = "dead_letter";
      r.last_error = error;
      r.locked_by = null;
      r.lease_expires_at = null;
      return true;
    },
    async releaseClaims({ ids, workerId }) {
      await Promise.resolve();
      let n = 0;
      for (const id of ids) {
        const r = find(id);
        if (!owns(r, workerId)) continue;
        r.status = "retry";
        r.attempts = Math.max(0, r.attempts - 1);
        r.available_at = clock.now();
        r.locked_by = null;
        r.lease_expires_at = null;
        n += 1;
      }
      return n;
    },
  };
}

function createStubPublisher(behavior = () => Promise.resolve()) {
  const calls = [];
  return {
    calls,
    publisher: {
      publish: (req) => {
        calls.push(req);
        return behavior(req, calls.length);
      },
      close: async () => {},
      isConnected: () => true,
      getState: () => ({ connected: true, consecutiveFailures: 0, nextAttemptInMs: 0 }),
    },
  };
}

const testConfig = {
  maxAttempts: 3,
  baseRetryMs: 1000,
  maxRetryMs: 10_000,
  leaseMs: 30_000,
  batchSize: 10,
  pollIntervalMs: 100,
};

{
  const clock = createClock();
  const repo = createMemoryRepo(createOutboxRows(3), clock);
  const stub = createStubPublisher();
  const logs = [];

  const result = await processOutboxBatch({
    repo,
    publisher: stub.publisher,
    config: testConfig,
    workerId: "w-1",
    log: (tag, data) => logs.push({ tag, data }),
    logError: (tag, data) => logs.push({ tag, data }),
  });

  assert("tres registros reivindicados", result.claimed === 3);
  assert("tres registros publicados", result.published === 3);
  assert("nenhum retry", result.retried === 0 && result.deadLettered === 0);
  assert("todas as linhas viraram published", repo.rows.every((r) => r.status === "published"));
  assert("published_at gravado", repo.rows.every((r) => r.published_at != null));
  assert("lease liberado apos publicar", repo.rows.every((r) => r.locked_by === null));
  assert("mensagem enviada com messageId do registro", stub.calls[0].messageId === "o-1");
  assert("mensagem enviada com a exchange do registro", stub.calls[0].exchange === "nexaboot.dev.webhooks");

  for (const tag of [
    "WEBHOOK_OUTBOX_CLAIMED",
    "WEBHOOK_OUTBOX_PUBLISH_START",
    "WEBHOOK_OUTBOX_PUBLISHED",
  ]) {
    assert(`emitiu ${tag}`, logs.some((l) => l.tag === tag));
  }
}

{
  // 9. published só depois do confirm.
  const clock = createClock();
  const repo = createMemoryRepo(createOutboxRows(1), clock);
  let releaseConfirm;
  const stub = createStubPublisher(() => new Promise((resolve) => (releaseConfirm = resolve)));

  const running = processOutboxBatch({
    repo,
    publisher: stub.publisher,
    config: testConfig,
    workerId: "w-1",
    ...silent,
  });

  await tick();
  await tick();
  assert("antes do confirm continua publishing", repo.rows[0].status === "publishing");
  assert("antes do confirm nao tem published_at", repo.rows[0].published_at === null);

  releaseConfirm();
  const result = await running;
  assert("depois do confirm vira published", repo.rows[0].status === "published");
  assert("resultado contabiliza a publicacao", result.published === 1);
}

{
  // 10. Falha antes do confirm gera retry com backoff.
  const clock = createClock();
  const repo = createMemoryRepo(createOutboxRows(1), clock);
  const stub = createStubPublisher(() => Promise.reject(new Error("canal caiu password=hunter2")));
  const logs = [];

  const result = await processOutboxBatch({
    repo,
    publisher: stub.publisher,
    config: testConfig,
    workerId: "w-1",
    random: () => 1,
    log: () => {},
    logError: (tag, data) => logs.push({ tag, data }),
  });

  assert("falha gera retry", result.retried === 1 && result.published === 0);
  assert("linha volta para retry", repo.rows[0].status === "retry");
  assert("nunca virou published", repo.rows[0].published_at === null);
  assert("tentativa foi contabilizada", repo.rows[0].attempts === 1);
  assert("retry agendado no futuro", repo.rows[0].available_at === clock.now() + 1000);
  assert("erro preservado", repo.rows[0].last_error.includes("canal caiu"));
  assert("erro mascarado", repo.rows[0].last_error.includes("password=[redacted]"));
  assert("emitiu WEBHOOK_OUTBOX_PUBLISH_RETRY", logs.some((l) => l.tag === "WEBHOOK_OUTBOX_PUBLISH_RETRY"));
}

{
  // 13. Excesso de tentativas vira dead_letter e preserva tudo.
  const clock = createClock();
  const rows = createOutboxRows(1, { attempts: testConfig.maxAttempts - 1 });
  const repo = createMemoryRepo(rows, clock);
  const stub = createStubPublisher(() => Promise.reject(new Error("broker recusou")));
  const logs = [];

  const result = await processOutboxBatch({
    repo,
    publisher: stub.publisher,
    config: testConfig,
    workerId: "w-1",
    log: () => {},
    logError: (tag, data) => logs.push({ tag, data }),
  });

  assert("estourou o maximo de tentativas", result.deadLettered === 1 && result.retried === 0);
  assert("status vira dead_letter", repo.rows[0].status === "dead_letter");
  assert("registro nao foi apagado", repo.rows.length === 1);
  assert("payload preservado", repo.rows[0].message_payload.inboxId === "i-1");
  assert("last_error preservado", repo.rows[0].last_error.includes("broker recusou"));
  assert("emitiu WEBHOOK_OUTBOX_DEAD_LETTER", logs.some((l) => l.tag === "WEBHOOK_OUTBOX_DEAD_LETTER"));
  const dl = logs.find((l) => l.tag === "WEBHOOK_OUTBOX_DEAD_LETTER");
  assert("dead letter registra o limite", dl.data.maxAttempts === testConfig.maxAttempts);
}

{
  // 11. Lease expirado permite recuperação por outro worker.
  const clock = createClock();
  const rows = createOutboxRows(1, {
    status: "publishing",
    attempts: 1,
    locked_by: "w-morto",
    locked_at: clock.now() - 90_000,
    lease_expires_at: clock.now() - 30_000,
  });
  const repo = createMemoryRepo(rows, clock);
  const stub = createStubPublisher();
  const logs = [];

  const result = await processOutboxBatch({
    repo,
    publisher: stub.publisher,
    config: testConfig,
    workerId: "w-vivo",
    log: (tag, data) => logs.push({ tag, data }),
    logError: () => {},
  });

  assert("lease expirado recuperado", result.recovered === 1);
  assert("registro republicado pelo novo worker", result.published === 1);
  assert("tentativas acumulam apos recuperacao", repo.rows[0].attempts === 2);
  assert("emitiu WEBHOOK_OUTBOX_LEASE_RECOVERED", logs.some((l) => l.tag === "WEBHOOK_OUTBOX_LEASE_RECOVERED"));
  const rec = logs.find((l) => l.tag === "WEBHOOK_OUTBOX_LEASE_RECOVERED");
  assert("recuperacao registra o dono anterior", rec.data.previousOwner === "w-morto");
}

{
  // Lease ainda válido não é roubado.
  const clock = createClock();
  const rows = createOutboxRows(1, {
    status: "publishing",
    attempts: 1,
    locked_by: "w-outro",
    lease_expires_at: clock.now() + 30_000,
  });
  const repo = createMemoryRepo(rows, clock);
  const stub = createStubPublisher();

  const result = await processOutboxBatch({
    repo,
    publisher: stub.publisher,
    config: testConfig,
    workerId: "w-1",
    ...silent,
  });

  assert("lease valido nao e recuperado", result.recovered === 0 && result.claimed === 0);
  assert("registro continua com o dono original", repo.rows[0].locked_by === "w-outro");
}

{
  // Publicou mas perdeu o lease: não pode marcar published de outro dono.
  const clock = createClock();
  const rows = createOutboxRows(1);
  const repo = createMemoryRepo(rows, clock);
  const stub = createStubPublisher(async () => {
    rows[0].locked_by = "w-outro";
  });
  const logs = [];

  const result = await processOutboxBatch({
    repo,
    publisher: stub.publisher,
    config: testConfig,
    workerId: "w-1",
    log: () => {},
    logError: (tag, data) => logs.push({ tag, data }),
  });

  assert("lease perdido nao conta como publicado", result.published === 0);
  assert("registro nao vira published de outro dono", rows[0].status === "publishing");
  const lost = logs.find((l) => l.data?.reason === "lease_lost_after_publish");
  assert("lease perdido e registrado", lost != null);
}

{
  // 8. Dois publicadores concorrentes não publicam o mesmo registro.
  const clock = createClock();
  const repo = createMemoryRepo(createOutboxRows(6), clock);
  const stubA = createStubPublisher(() => new Promise((r) => setTimeout(r, 1)));
  const stubB = createStubPublisher(() => new Promise((r) => setTimeout(r, 1)));

  const [a, b] = await Promise.all([
    processOutboxBatch({
      repo,
      publisher: stubA.publisher,
      config: { ...testConfig, batchSize: 3 },
      workerId: "w-a",
      ...silent,
    }),
    processOutboxBatch({
      repo,
      publisher: stubB.publisher,
      config: { ...testConfig, batchSize: 3 },
      workerId: "w-b",
      ...silent,
    }),
  ]);

  const idsA = stubA.calls.map((c) => c.messageId);
  const idsB = stubB.calls.map((c) => c.messageId);
  const overlap = idsA.filter((id) => idsB.includes(id));

  assert("nenhum registro publicado pelos dois", overlap.length === 0);
  assert("todos os registros foram cobertos", idsA.length + idsB.length === 6);
  assert("cada replica publicou seu lote", a.published === 3 && b.published === 3);
  assert("nenhuma linha ficou pendente", repo.rows.every((r) => r.status === "published"));
  assert("cada linha tem exatamente uma tentativa", repo.rows.every((r) => r.attempts === 1));
}

{
  // 15. Restart não remove pending/retry: o próximo processo assume.
  const clock = createClock();
  const repo = createMemoryRepo(createOutboxRows(2), clock);
  const failing = createStubPublisher(() => Promise.reject(new Error("broker fora")));

  await processOutboxBatch({
    repo,
    publisher: failing.publisher,
    config: testConfig,
    workerId: "w-antigo",
    ...silent,
  });

  assert("registros sobrevivem a falha", repo.rows.length === 2);
  assert("registros ficam em retry", repo.rows.every((r) => r.status === "retry"));

  clock.advance(60_000);
  const working = createStubPublisher();
  const result = await processOutboxBatch({
    repo,
    publisher: working.publisher,
    config: testConfig,
    workerId: "w-novo",
    ...silent,
  });

  assert("novo processo reivindica os pendentes", result.claimed === 2);
  assert("novo processo publica os pendentes", result.published === 2);
  assert("nada foi perdido no restart", repo.rows.every((r) => r.status === "published"));
}

{
  // Broker indisponível: o resto do lote é devolvido sem queimar tentativa.
  const clock = createClock();
  const repo = createMemoryRepo(createOutboxRows(4), clock);
  const stub = createStubPublisher(() => Promise.reject(new RabbitUnavailableError("connect_failed", 1000)));

  const result = await processOutboxBatch({
    repo,
    publisher: stub.publisher,
    config: testConfig,
    workerId: "w-1",
    ...silent,
  });

  assert("broker fora e sinalizado", result.brokerUnavailable === true);
  assert("so o primeiro registro consome tentativa", result.retried === 1);
  assert("restante do lote foi devolvido", result.released === 3);
  assert("apenas uma publicacao foi tentada", stub.calls.length === 1);
  const released = repo.rows.filter((r) => r.id !== "o-1");
  assert("registros devolvidos ficam em retry", released.every((r) => r.status === "retry"));
  assert("registros devolvidos nao perdem tentativa", released.every((r) => r.attempts === 0));
  assert("nada foi apagado", repo.rows.length === 4);
}

{
  // 17. Graceful shutdown não abandona registro reservado.
  const clock = createClock();
  const repo = createMemoryRepo(createOutboxRows(3), clock);
  let stopping = false;
  const stub = createStubPublisher(async () => {
    stopping = true;
  });

  const result = await processOutboxBatch({
    repo,
    publisher: stub.publisher,
    config: testConfig,
    workerId: "w-1",
    shouldStop: () => stopping,
    ...silent,
  });

  assert("primeiro registro concluiu", result.published === 1);
  assert("apenas uma publicacao iniciada", stub.calls.length === 1);
  assert("restante devolvido no shutdown", result.released === 2);
  const remaining = repo.rows.filter((r) => r.id !== "o-1");
  assert("registros devolvidos voltam para retry", remaining.every((r) => r.status === "retry"));
  assert("tentativa devolvida no shutdown", remaining.every((r) => r.attempts === 0));
  assert("nenhum registro fica travado em publishing", repo.rows.every((r) => r.status !== "publishing"));
  assert("nenhum registro foi apagado", repo.rows.length === 3);
}

{
  // Shutdown antes do claim não reserva nada.
  const clock = createClock();
  const repo = createMemoryRepo(createOutboxRows(2), clock);
  const stub = createStubPublisher();

  const result = await processOutboxBatch({
    repo,
    publisher: stub.publisher,
    config: testConfig,
    workerId: "w-1",
    shouldStop: () => true,
    ...silent,
  });

  assert("shutdown imediato nao reivindica", result.claimed === 0);
  assert("shutdown imediato nao publica", stub.calls.length === 0);
  assert("registros continuam pending", repo.rows.every((r) => r.status === "pending"));
}

// ---------------------------------------------------------------------------
// 16. Loop do serviço publicador
// ---------------------------------------------------------------------------

{
  const sleeps = [];
  let repoCreated = false;
  let publisherCreated = false;
  const logs = [];

  const result = await runWebhookOutboxPublisherLoop({
    config: testConfig,
    rabbitConfig: { ...baseRabbitConfig, enabled: false },
    workerId: "w-parked",
    createRepository: () => {
      repoCreated = true;
      throw new Error("nao deveria abrir pool");
    },
    createPublisher: () => {
      publisherCreated = true;
      throw new Error("nao deveria conectar");
    },
    sleep: async (ms) => sleeps.push(ms),
    onSignals: false,
    maxIterations: 3,
    log: (tag, data) => logs.push({ tag, data }),
    logError: (tag, data) => logs.push({ tag, data }),
  });

  assert("flag desligada estaciona o publicador", result.parked === true);
  assert("estacionado sai com codigo 0", result.exitCode === 0);
  assert("estacionado nao abre pool", repoCreated === false);
  assert("estacionado nao conecta no broker", publisherCreated === false);
  assert("estacionado emite log dedicado", logs.some((l) => l.tag === "WEBHOOK_OUTBOX_PUBLISHER_PARKED"));
  const parkedLog = logs.find((l) => l.tag === "WEBHOOK_OUTBOX_PUBLISHER_PARKED");
  assert(
    "estacionado usa intervalo longo",
    parkedLog.data.pollIntervalMs === WEBHOOK_OUTBOX_PARKED_POLL_INTERVAL_MS &&
      WEBHOOK_OUTBOX_PARKED_POLL_INTERVAL_MS >= 60_000,
  );
}

{
  const clock = createClock();
  const repo = createMemoryRepo(createOutboxRows(2), clock);
  const stub = createStubPublisher();
  let closedPublisher = false;
  let closedResources = false;
  const logs = [];

  const result = await runWebhookOutboxPublisherLoop({
    config: testConfig,
    rabbitConfig: baseRabbitConfig,
    workerId: "w-loop",
    createRepository: () => repo,
    createPublisher: () => ({
      ...stub.publisher,
      close: async () => {
        closedPublisher = true;
      },
    }),
    closeResources: async () => {
      closedResources = true;
    },
    sleep: async () => {},
    onSignals: false,
    maxIterations: 1,
    log: (tag, data) => logs.push({ tag, data }),
    logError: (tag, data) => logs.push({ tag, data }),
  });

  assert("loop ativo nao fica estacionado", result.parked === false);
  assert("loop publicou o lote", repo.rows.every((r) => r.status === "published"));
  assert("loop fecha o publisher", closedPublisher === true);
  assert("loop fecha os recursos", closedResources === true);
  assert("loop registra inicio", logs.some((l) => l.tag === "WEBHOOK_OUTBOX_PUBLISHER_STARTED"));
  assert("loop registra parada", logs.some((l) => l.tag === "WEBHOOK_OUTBOX_PUBLISHER_STOPPED"));
  assert("loop sai com codigo 0", result.exitCode === 0);
}

{
  // Erro de banco não derruba o serviço.
  const brokenRepo = {
    recoverExpiredLeases: async () => {
      throw new Error("connection terminated postgres://u:p@h/db");
    },
    claimBatch: async () => [],
    markPublished: async () => true,
    markRetry: async () => true,
    markDeadLetter: async () => true,
    releaseClaims: async () => 0,
  };
  const logs = [];

  const result = await runWebhookOutboxPublisherLoop({
    config: testConfig,
    rabbitConfig: baseRabbitConfig,
    workerId: "w-db",
    createRepository: () => brokenRepo,
    createPublisher: () => createStubPublisher().publisher,
    sleep: async () => {},
    onSignals: false,
    maxIterations: 2,
    log: () => {},
    logError: (tag, data) => logs.push({ tag, data }),
  });

  assert("erro de banco nao derruba o loop", result.exitCode === 0);
  const err = logs.find((l) => l.data?.reason === "batch_error");
  assert("erro de banco e registrado", err != null);
  assert("erro de banco nao vaza dsn", !JSON.stringify(logs).includes("u:p@h"));
}

{
  // Configuração inválida com a flag ligada falha explicitamente.
  const result = await runWebhookOutboxPublisherLoop({
    config: testConfig,
    rabbitConfig: { ...baseRabbitConfig, url: null },
    workerId: "w-bad",
    createRepository: () => createMemoryRepo([], createClock()),
    createPublisher: () => createStubPublisher().publisher,
    sleep: async () => {},
    onSignals: false,
    maxIterations: 1,
    ...silent,
  });
  assert("config invalida sai com codigo 1", result.exitCode === 1);
}

// ---------------------------------------------------------------------------
// Migration e entrypoint
// ---------------------------------------------------------------------------

{
  const migration = readSource("docs/migrations/20260808_webhook_outbox.sql");

  for (const column of [
    "id UUID PRIMARY KEY",
    "inbox_id UUID NOT NULL",
    "exchange_name TEXT NOT NULL",
    "routing_key TEXT NOT NULL",
    "message_payload JSONB NOT NULL",
    "status TEXT NOT NULL DEFAULT 'pending'",
    "attempts INTEGER NOT NULL DEFAULT 0",
    "available_at TIMESTAMPTZ NOT NULL DEFAULT now()",
    "locked_at TIMESTAMPTZ",
    "locked_by TEXT",
    "lease_expires_at TIMESTAMPTZ",
    "published_at TIMESTAMPTZ",
    "last_error TEXT",
    "created_at TIMESTAMPTZ NOT NULL DEFAULT now()",
    "updated_at TIMESTAMPTZ NOT NULL DEFAULT now()",
  ]) {
    assert(`migration outbox declara ${column}`, migration.includes(column));
  }

  for (const status of ["pending", "publishing", "published", "retry", "dead_letter"]) {
    assert(`migration outbox aceita status ${status}`, migration.includes(`'${status}'`));
  }

  assert("migration cria a tabela", migration.includes("CREATE TABLE IF NOT EXISTS public.webhook_outbox"));
  assert("migration tem FK para a inbox", migration.includes("REFERENCES public.webhook_inbox (id)"));
  assert("FK nao apaga em cascata", migration.includes("ON DELETE RESTRICT") && !migration.includes("ON DELETE CASCADE"));
  assert("migration tem UNIQUE(inbox_id, routing_key)", migration.includes("(inbox_id, routing_key)"));
  assert("migration tem indice parcial de claim", migration.includes("WHERE status IN ('pending', 'retry')"));
  assert("migration tem indice de lease", migration.includes("WHERE status = 'publishing'"));
  assert("migration tem indice por inbox_id", migration.includes("idx_webhook_outbox_inbox"));
  assert("migration tem indice de status e created_at", migration.includes("(status, created_at DESC)"));
  assert("migration e transacional", migration.includes("BEGIN;") && migration.includes("COMMIT;"));
  assert(
    "migration nao apaga nada",
    !/DROP\s+TABLE|DELETE\s+FROM|TRUNCATE/i.test(migration.replace(/--.*$/gm, "")),
  );

  const rollback = readSource("docs/migrations/20260808_webhook_outbox_rollback.sql");
  assert("rollback derruba a outbox", rollback.includes("DROP TABLE IF EXISTS public.webhook_outbox"));
  assert(
    "rollback nao apaga a inbox",
    !rollback.replace(/--.*$/gm, "").includes("DROP TABLE IF EXISTS public.webhook_inbox"),
  );
}

{
  const pkg = JSON.parse(readSource("package.json"));
  assert(
    "package.json expoe webhook:outbox-publisher",
    pkg.scripts["webhook:outbox-publisher"] === "tsx scripts/webhook-outbox-publisher.ts",
  );
  assert("amqplib declarado como dependencia", typeof pkg.dependencies.amqplib === "string");

  const entry = readSource("scripts/webhook-outbox-publisher.ts");
  const entryCode = entry.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert("entrypoint nao importa src/server", !entryCode.includes("src/server"));
  assert("entrypoint nao sobe servidor web", !entryCode.includes("createServer"));
  assert("entrypoint usa o loop compartilhado", entry.includes("runWebhookOutboxPublisherLoop"));
  assert("entrypoint usa o pool dedicado da inbox", entry.includes("getWebhookInboxSql"));
  assert("entrypoint fecha o pool", entry.includes("closeWebhookInboxSql"));
  assert("entrypoint nao processa contato/conversa/mensagem", !/upsertContact|upsertConversation/.test(entry));
}

{
  const rabbit = readSource("src/lib/rabbitmq.server.ts");
  assert("driver carregado por import dinamico", rabbit.includes('await import(/* @vite-ignore */ specifier)'));
  assert("sem import estatico de amqplib", !/^import .*amqplib/m.test(rabbit));
  assert("exchange declarada durable", rabbit.includes('durable: true'));
  assert("mensagem persistente", rabbit.includes("persistent: true"));
  assert("url nunca vai para o log", !/log\([^)]*config\.url/.test(rabbit));

  const engine = readSource("src/lib/webhook-outbox-publisher.server.ts");
  assert("motor nunca publica sem confirm", engine.indexOf("publisher.publish") < engine.indexOf("markPublished"));
  assert("motor nao apaga registros", !/DELETE|repo\.delete/.test(engine));
}

// ---------------------------------------------------------------------------

if (failed > 0) {
  console.error(`\n${failed} webhook outbox test(s) failed.`);
  process.exit(1);
}
console.log("\nAll webhook outbox tests passed.");
