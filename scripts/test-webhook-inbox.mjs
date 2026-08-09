/**
 * Testes da inbox durável de webhooks — ETAPA 1 (ingestão).
 * Uso: npx tsx scripts/test-webhook-inbox.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  bodyReadFailureStatus,
  buildDeduplicationKey,
  DEDUPLICATION_KEY_MAX_LENGTH,
  extractEvolutionIdentifiers,
  extractMetaIdentifiers,
  isDurableWebhookInboxEnabled,
  isDurableWebhookInboxProcessingEnabled,
  readRequestBodyWithLimit,
  readWebhookInboxBodyStallTimeoutMs,
  readWebhookInboxBodyTimeoutMs,
  readWebhookInboxMaxPayloadBytes,
  readWebhookInboxMemoryAcquireTimeoutMs,
  resolveReservationBytes,
  resolveWebhookInboxMemoryBudgetBytes,
  sanitizeWebhookHeaders,
  WEBHOOK_INBOX_DEFAULT_BODY_STALL_TIMEOUT_MS,
  WEBHOOK_INBOX_DEFAULT_BODY_TIMEOUT_MS,
  WEBHOOK_INBOX_DEFAULT_MAX_PAYLOAD_BYTES,
  WEBHOOK_INBOX_DEFAULT_MEMORY_ACQUIRE_TIMEOUT_MS,
  WEBHOOK_INBOX_DEFAULT_MEMORY_BUDGET_BYTES,
} from "../src/lib/webhook-inbox-core.ts";
import {
  createByteBudget,
  isWebhookInboxBudgetTimeout,
} from "../src/lib/webhook-inbox-budget.ts";
import {
  __resetWebhookInboxPoolGateForTests,
  isWebhookInboxAcquireTimeout,
  readWebhookInboxAcquireTimeoutMs,
  readWebhookInboxConnectTimeoutSec,
  readWebhookInboxIdleTimeoutSec,
  readWebhookInboxPoolMax,
  readWebhookInboxStatementTimeoutMs,
  resolveWebhookInboxDatabaseUrl,
  WEBHOOK_INBOX_DEFAULT_ACQUIRE_TIMEOUT_MS,
  WEBHOOK_INBOX_DEFAULT_POOL_MAX,
  WEBHOOK_INBOX_DEFAULT_STATEMENT_TIMEOUT_MS,
  withWebhookInboxConnectionSlot,
} from "../src/lib/pg-webhook-inbox.server.ts";
import {
  getWebhookInboxBudget,
  ingestWebhookRequestToInbox,
  persistWebhookEvent,
  readWebhookBodyForInbox,
  __resetWebhookInboxBudgetForTests,
} from "../src/lib/webhook-inbox.server.ts";
import {
  __resetPoolGateForTests,
  getWebhookConcurrencyMax,
  withWebhookConcurrencyLimit,
} from "../src/lib/pg-pool-gate.server.ts";
import { runWebhookIngress } from "../src/lib/webhook-ingress.server.ts";

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

// ---------------------------------------------------------------------------
// Banco falso: guarda linhas fora do processo de teste, como o PostgreSQL faria
// ---------------------------------------------------------------------------

function createStore() {
  return { rows: [] };
}

function makeSql(store, options = {}) {
  const state = { unsafeCalls: [], commits: 0, committedAt: 0, insertValues: null };

  const tx = (strings, ...values) => {
    const text = strings.join("|");

    if (text.includes("INSERT INTO public.webhook_inbox")) {
      if (options.failOnInsert) return Promise.reject(new Error(options.failMessage ?? "db down"));
      state.insertValues = values;
      const [
        provider,
        eventType,
        companyId,
        channelId,
        instanceName,
        externalEventId,
        externalMessageId,
        deduplicationKey,
        payload,
        requestHeaders,
      ] = values;
      const exists = store.rows.find(
        (r) => r.provider === provider && r.deduplication_key === deduplicationKey,
      );
      if (exists) return Promise.resolve([]);
      const row = {
        id: `inbox-${store.rows.length + 1}`,
        provider,
        event_type: eventType,
        company_id: companyId,
        channel_id: channelId,
        instance_name: instanceName,
        external_event_id: externalEventId,
        external_message_id: externalMessageId,
        deduplication_key: deduplicationKey,
        payload,
        request_headers: requestHeaders,
        status: "pending",
      };
      store.rows.push(row);
      return Promise.resolve([{ id: row.id }]);
    }

    if (text.includes("SELECT id FROM public.webhook_inbox")) {
      const [provider, deduplicationKey] = values;
      const found = store.rows.find(
        (r) => r.provider === provider && r.deduplication_key === deduplicationKey,
      );
      return Promise.resolve(found ? [{ id: found.id }] : []);
    }

    return Promise.resolve([]);
  };

  tx.unsafe = (q) => {
    state.unsafeCalls.push(q);
    return Promise.resolve([]);
  };

  const sql = {
    begin: async (fn) => {
      if (options.failOnBegin) throw new Error(options.failMessage ?? "connection terminated");
      const result = await fn(tx);
      if (options.commitDelayMs) {
        await new Promise((r) => setTimeout(r, options.commitDelayMs));
      }
      state.commits += 1;
      state.committedAt = Date.now();
      return result;
    },
  };

  return { sql, state };
}

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
// Flags e limites
// ---------------------------------------------------------------------------

assert("flag ingestao default false", isDurableWebhookInboxEnabled({}) === false);
assert("flag ingestao true", isDurableWebhookInboxEnabled({ WEBHOOK_DURABLE_INBOX_ENABLED: "true" }) === true);
assert("flag ingestao 1", isDurableWebhookInboxEnabled({ WEBHOOK_DURABLE_INBOX_ENABLED: "1" }) === true);
assert("flag ingestao lixo vira false", isDurableWebhookInboxEnabled({ WEBHOOK_DURABLE_INBOX_ENABLED: "talvez" }) === false);
assert("flag processing default false", isDurableWebhookInboxProcessingEnabled({}) === false);
assert(
  "flag processing true",
  isDurableWebhookInboxProcessingEnabled({ WEBHOOK_DURABLE_INBOX_PROCESSING_ENABLED: "yes" }) === true,
);

assert("max payload default", readWebhookInboxMaxPayloadBytes({}) === WEBHOOK_INBOX_DEFAULT_MAX_PAYLOAD_BYTES);
assert("max payload custom", readWebhookInboxMaxPayloadBytes({ WEBHOOK_INBOX_MAX_PAYLOAD_BYTES: "2048" }) === 2048);
assert(
  "max payload invalido volta ao default",
  readWebhookInboxMaxPayloadBytes({ WEBHOOK_INBOX_MAX_PAYLOAD_BYTES: "-3" }) ===
    WEBHOOK_INBOX_DEFAULT_MAX_PAYLOAD_BYTES,
);

// O maior arquivo aceito pelo WhatsApp é documento de 100 MB; a Evolution
// manda em base64, o que multiplica por 4/3 e ainda leva envelope JSON.
const WHATSAPP_MAX_DOCUMENT_BYTES = 100 * 1000 * 1000;
const WHATSAPP_MAX_DOCUMENT_BASE64_BYTES = Math.ceil(WHATSAPP_MAX_DOCUMENT_BYTES / 3) * 4;
assert(
  "default cobre documento de 100 MB em base64",
  WEBHOOK_INBOX_DEFAULT_MAX_PAYLOAD_BYTES > WHATSAPP_MAX_DOCUMENT_BASE64_BYTES,
);
assert(
  "default cobre video de 16 MB em base64 com folga",
  WEBHOOK_INBOX_DEFAULT_MAX_PAYLOAD_BYTES > Math.ceil((16 * 1000 * 1000) / 3) * 4,
);
assert("default nao e mais 5 MiB", WEBHOOK_INBOX_DEFAULT_MAX_PAYLOAD_BYTES > 5 * 1024 * 1024);

assert(
  "body stall timeout default",
  readWebhookInboxBodyStallTimeoutMs({}) === WEBHOOK_INBOX_DEFAULT_BODY_STALL_TIMEOUT_MS,
);
assert("body timeout default", readWebhookInboxBodyTimeoutMs({}) === WEBHOOK_INBOX_DEFAULT_BODY_TIMEOUT_MS);
assert(
  "body timeout absoluto nao e mais 5s",
  WEBHOOK_INBOX_DEFAULT_BODY_TIMEOUT_MS > 5_000 &&
    WEBHOOK_INBOX_DEFAULT_BODY_STALL_TIMEOUT_MS > 5_000,
);
assert(
  "body stall custom",
  readWebhookInboxBodyStallTimeoutMs({ WEBHOOK_INBOX_BODY_STALL_TIMEOUT_MS: "777" }) === 777,
);

assert(
  "memory acquire timeout default",
  readWebhookInboxMemoryAcquireTimeoutMs({}) === WEBHOOK_INBOX_DEFAULT_MEMORY_ACQUIRE_TIMEOUT_MS,
);
assert(
  "budget default",
  resolveWebhookInboxMemoryBudgetBytes({}) === WEBHOOK_INBOX_DEFAULT_MEMORY_BUDGET_BYTES,
);
assert(
  "budget nunca menor que o teto de payload",
  resolveWebhookInboxMemoryBudgetBytes({
    WEBHOOK_INBOX_MEMORY_BUDGET_BYTES: "1024",
    WEBHOOK_INBOX_MAX_PAYLOAD_BYTES: "4096",
  }) === 4096,
);
assert(
  "budget custom acima do teto e respeitado",
  resolveWebhookInboxMemoryBudgetBytes({
    WEBHOOK_INBOX_MEMORY_BUDGET_BYTES: String(512 * 1024 * 1024),
  }) ===
    512 * 1024 * 1024,
);

assert("reserva sem content-length usa o teto", resolveReservationBytes(null, 1000) === 1000);
assert("reserva usa content-length quando menor", resolveReservationBytes("120", 1000) === 120);
assert("reserva nunca passa do teto", resolveReservationBytes("99999", 1000) === 1000);
assert("reserva ignora content-length invalido", resolveReservationBytes("abc", 1000) === 1000);

// ---------------------------------------------------------------------------
// Pool dedicado da inbox
// ---------------------------------------------------------------------------

assert("pool max default", readWebhookInboxPoolMax({}) === WEBHOOK_INBOX_DEFAULT_POOL_MAX);
assert("pool max custom", readWebhookInboxPoolMax({ WEBHOOK_INBOX_PG_POOL_MAX: "7" }) === 7);
assert(
  "pool max invalido volta ao default",
  readWebhookInboxPoolMax({ WEBHOOK_INBOX_PG_POOL_MAX: "0" }) === WEBHOOK_INBOX_DEFAULT_POOL_MAX,
);
assert("pool connect timeout default", readWebhookInboxConnectTimeoutSec({}) === 10);
assert("pool idle timeout default", readWebhookInboxIdleTimeoutSec({}) === 20);
assert(
  "acquire timeout default",
  readWebhookInboxAcquireTimeoutMs({}) === WEBHOOK_INBOX_DEFAULT_ACQUIRE_TIMEOUT_MS,
);
assert(
  "acquire timeout custom",
  readWebhookInboxAcquireTimeoutMs({ WEBHOOK_INBOX_PG_ACQUIRE_TIMEOUT_MS: "250" }) === 250,
);
assert(
  "statement timeout default",
  readWebhookInboxStatementTimeoutMs({}) === WEBHOOK_INBOX_DEFAULT_STATEMENT_TIMEOUT_MS,
);
assert(
  "statement timeout custom",
  readWebhookInboxStatementTimeoutMs({ WEBHOOK_INBOX_PG_STATEMENT_TIMEOUT_MS: "1234" }) === 1234,
);
assert(
  "statement timeout maior que o do web para caber payload grande",
  WEBHOOK_INBOX_DEFAULT_STATEMENT_TIMEOUT_MS >= 30_000,
);
assert(
  "url dedicada tem prioridade",
  resolveWebhookInboxDatabaseUrl({
    WEBHOOK_INBOX_DATABASE_URL: "postgres://inbox",
    DATABASE_URL: "postgres://web",
  }) === "postgres://inbox",
);
assert(
  "fallback para DATABASE_URL",
  resolveWebhookInboxDatabaseUrl({ DATABASE_URL: "postgres://web" }) === "postgres://web",
);
{
  let threw = false;
  try {
    resolveWebhookInboxDatabaseUrl({});
  } catch {
    threw = true;
  }
  assert("sem url configurada falha explicitamente", threw === true);
}

{
  __resetWebhookInboxPoolGateForTests();
  const opts = { max: 1, timeoutMs: 5_000, env: {} };
  let releaseFirst;
  const held = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = withWebhookInboxConnectionSlot(() => held, opts);
  let secondRan = false;
  const second = withWebhookInboxConnectionSlot(async () => {
    secondRan = true;
    return "ok";
  }, opts);

  await new Promise((r) => setTimeout(r, 10));
  assert("segundo pedido espera o slot", secondRan === false);
  releaseFirst("ok");
  await first;
  assert("segundo pedido roda apos liberar", (await second) === "ok" && secondRan === true);
}

{
  __resetWebhookInboxPoolGateForTests();
  const blocked = withWebhookInboxConnectionSlot(() => new Promise(() => {}), {
    max: 1,
    timeoutMs: 60_000,
    env: {},
  });
  void blocked;

  let error = null;
  try {
    await withWebhookInboxConnectionSlot(async () => "nunca", {
      max: 1,
      timeoutMs: 30,
      env: {},
    });
  } catch (e) {
    error = e;
  }
  assert("aquisicao de conexao estoura timeout", isWebhookInboxAcquireTimeout(error));
  assert("timeout de aquisicao tem codigo proprio", error?.code === "inbox_pool_acquire_timeout");
  __resetWebhookInboxPoolGateForTests();
}

{
  __resetWebhookInboxPoolGateForTests();
  // Slot preso não pode vazar: quem espera desiste e o slot volta ao liberar.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const first = withWebhookInboxConnectionSlot(() => held, { max: 1, timeoutMs: 5_000, env: {} });
  await withWebhookInboxConnectionSlot(async () => "x", { max: 1, timeoutMs: 20, env: {} }).catch(
    () => undefined,
  );
  release("done");
  await first;
  const after = await withWebhookInboxConnectionSlot(async () => "livre", {
    max: 1,
    timeoutMs: 20,
    env: {},
  });
  assert("slot volta ao pool depois do timeout do vizinho", after === "livre");
  __resetWebhookInboxPoolGateForTests();
}

// ---------------------------------------------------------------------------
// Orçamento de memória
// ---------------------------------------------------------------------------

{
  const budget = createByteBudget(100);
  const a = await budget.acquire(60, 1000);
  assert("orcamento desconta a reserva", budget.metrics().availableBytes === 40);

  let bDone = false;
  const b = budget.acquire(60, 1000).then((release) => {
    bDone = true;
    return release;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert("segunda reserva espera memoria livre", bDone === false);
  assert("espera aparece nas metricas", budget.metrics().waiting === 1);

  a();
  const releaseB = await b;
  assert("segunda reserva entra apos liberar", bDone === true);
  releaseB();
  assert("orcamento volta ao total", budget.metrics().availableBytes === 100);

  a();
  assert("liberar duas vezes nao infla o orcamento", budget.metrics().availableBytes === 100);
}

{
  const budget = createByteBudget(100);
  const held = await budget.acquire(100, 1000);
  let error = null;
  try {
    await budget.acquire(10, 30);
  } catch (e) {
    error = e;
  }
  assert("reserva sem memoria estoura timeout", isWebhookInboxBudgetTimeout(error));
  held();
}

{
  // Payload maior que o orçamento inteiro é admitido sozinho, nunca travado.
  const budget = createByteBudget(100);
  const release = await budget.acquire(1_000_000, 50);
  assert("payload gigante entra sozinho", budget.metrics().availableBytes === 0);
  release();
  assert("orcamento se recompoe apos o gigante", budget.metrics().availableBytes === 100);
}

{
  // FIFO: pedido grande na frente não é ultrapassado por pedidos pequenos.
  const budget = createByteBudget(100);
  const big = await budget.acquire(100, 1000);
  const order = [];
  const queuedBig = budget.acquire(80, 1000).then((r) => {
    order.push("big");
    return r;
  });
  const queuedSmall = budget.acquire(5, 1000).then((r) => {
    order.push("small");
    return r;
  });
  big();
  const rb = await queuedBig;
  rb();
  const rs = await queuedSmall;
  rs();
  assert("fila respeita ordem de chegada", order.join(",") === "big,small");
}

{
  __resetWebhookInboxBudgetForTests();
  const budget = getWebhookInboxBudget({});
  assert(
    "budget global usa o default",
    budget.totalBytes === WEBHOOK_INBOX_DEFAULT_MEMORY_BUDGET_BYTES,
  );
  assert("budget global e reaproveitado", getWebhookInboxBudget({}) === budget);
  __resetWebhookInboxBudgetForTests();
}

// ---------------------------------------------------------------------------
// Identificadores
// ---------------------------------------------------------------------------

{
  const ids = extractEvolutionIdentifiers(evolutionPayload);
  assert("evolution eventType", ids.eventType === "messages.upsert");
  assert("evolution instance", ids.instanceName === "nexa-01");
  assert("evolution externalMessageId", ids.externalMessageId === "WAMID-A");
  assert("evolution externalIds", ids.externalIds.join(",") === "WAMID-A");

  const batch = extractEvolutionIdentifiers({
    event: "messages.upsert",
    instance: "nexa-01",
    data: [{ key: { id: "A" } }, { key: { id: "B" } }],
  });
  assert("evolution lote coleta todos os ids", batch.externalIds.join(",") === "A,B");

  const semIds = extractEvolutionIdentifiers({ event: "connection.update", instance: "nexa-01", data: { state: "open" } });
  assert("evolution sem message id", semIds.externalIds.length === 0);
  assert("evolution connection eventType", semIds.eventType === "connection.update");
}

{
  const metaPayload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA-1",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "PNID-9" },
              messages: [{ id: "wamid.X", type: "text" }],
              statuses: [{ id: "wamid.X", status: "delivered" }],
            },
          },
        ],
      },
    ],
  };
  const ids = extractMetaIdentifiers(metaPayload);
  assert("meta instance = phone_number_id", ids.instanceName === "PNID-9");
  assert("meta externalEventId = entry.id", ids.externalEventId === "WABA-1");
  assert("meta eventType = field", ids.eventType === "messages");
  assert("meta externalMessageId", ids.externalMessageId === "wamid.X");
  assert("meta status entra com sufixo", ids.externalIds.includes("wamid.X#delivered"));
  assert("meta mensagem e status nao colidem", new Set(ids.externalIds).size === 2);
}

// ---------------------------------------------------------------------------
// deduplication_key
// ---------------------------------------------------------------------------

{
  const raw = JSON.stringify(evolutionPayload);
  const ids = extractEvolutionIdentifiers(evolutionPayload);
  const build = () =>
    buildDeduplicationKey({
      provider: "evolution",
      eventType: ids.eventType,
      instanceName: ids.instanceName,
      externalIds: ids.externalIds,
      rawBody: raw,
    });

  assert("dedup key estavel entre chamadas", build() === build());
  assert("dedup key contem provider", build().startsWith("evolution:"));

  const outro = buildDeduplicationKey({
    provider: "evolution",
    eventType: "messages.upsert",
    instanceName: "nexa-01",
    externalIds: ["WAMID-B"],
    rawBody: raw,
  });
  assert("mensagens diferentes nao colidem", build() !== outro);

  const outroEvento = buildDeduplicationKey({
    provider: "evolution",
    eventType: "messages.update",
    instanceName: "nexa-01",
    externalIds: ["WAMID-A"],
    rawBody: raw,
  });
  assert("eventos diferentes com mesmo id nao colidem", build() !== outroEvento);

  const outraInstancia = buildDeduplicationKey({
    provider: "evolution",
    eventType: "messages.upsert",
    instanceName: "nexa-02",
    externalIds: ["WAMID-A"],
    rawBody: raw,
  });
  assert("instancias diferentes nao colidem", build() !== outraInstancia);

  const semIds = buildDeduplicationKey({
    provider: "evolution",
    eventType: "connection.update",
    instanceName: "nexa-01",
    externalIds: [],
    rawBody: raw,
  });
  const semIdsOutroCorpo = buildDeduplicationKey({
    provider: "evolution",
    eventType: "connection.update",
    instanceName: "nexa-01",
    externalIds: [],
    rawBody: `${raw} `,
  });
  assert("sem ids usa hash do corpo", semIds.includes(":sha256:"));
  assert("corpos diferentes geram chaves diferentes", semIds !== semIdsOutroCorpo);

  const ordemA = buildDeduplicationKey({
    provider: "evolution",
    eventType: "messages.upsert",
    instanceName: "nexa-01",
    externalIds: ["B", "A"],
    rawBody: raw,
  });
  const ordemB = buildDeduplicationKey({
    provider: "evolution",
    eventType: "messages.upsert",
    instanceName: "nexa-01",
    externalIds: ["A", "B"],
    rawBody: raw,
  });
  assert("ordem dos ids nao muda a chave", ordemA === ordemB);

  const gigante = buildDeduplicationKey({
    provider: "evolution",
    eventType: "messages.upsert",
    instanceName: "nexa-01",
    externalIds: Array.from({ length: 200 }, (_, i) => `WAMID-${i}`),
    rawBody: raw,
  });
  assert("chave longa e comprimida", gigante.length <= DEDUPLICATION_KEY_MAX_LENGTH);
  assert("chave longa continua deterministica", gigante === buildDeduplicationKey({
    provider: "evolution",
    eventType: "messages.upsert",
    instanceName: "nexa-01",
    externalIds: Array.from({ length: 200 }, (_, i) => `WAMID-${i}`),
    rawBody: raw,
  }));
}

// ---------------------------------------------------------------------------
// Headers sensíveis
// ---------------------------------------------------------------------------

{
  const sanitized = sanitizeWebhookHeaders(
    new Headers({
      "content-type": "application/json",
      "user-agent": "evolution/2",
      apikey: "SUPER-SECRET-APIKEY",
      "x-webhook-secret": "SUPER-SECRET-TOKEN",
      authorization: "Bearer SUPER-SECRET-BEARER",
      "x-hub-signature-256": "sha256=deadbeef",
      cookie: "session=abc",
      "x-custom-desconhecido": "valor",
    }),
  );
  const dump = JSON.stringify(sanitized);

  assert("header seguro preservado", sanitized["content-type"] === "application/json");
  assert("user-agent preservado", sanitized["user-agent"] === "evolution/2");
  assert("apikey vira booleano", sanitized.has_apikey === true);
  assert("x-webhook-secret vira booleano", sanitized.has_x_webhook_secret === true);
  assert("authorization vira booleano", sanitized.has_authorization === true);
  assert("assinatura meta vira booleano", sanitized.has_x_hub_signature_256 === true);
  assert("cookie vira booleano", sanitized.has_cookie === true);
  assert("header fora da allowlist e descartado", sanitized["x-custom-desconhecido"] === undefined);
  assert("nenhum valor de segredo aparece", !/SUPER-SECRET|deadbeef|session=abc/.test(dump));
}

// ---------------------------------------------------------------------------
// Leitura do corpo: limite e timeout
// ---------------------------------------------------------------------------

const readOpts = (over = {}) => ({
  maxBytes: 1_000_000,
  stallTimeoutMs: 2000,
  totalTimeoutMs: 5000,
  ...over,
});

{
  const req = makeRequest(evolutionPayload);
  const result = await readRequestBodyWithLimit(req, readOpts());
  assert("body lido com sucesso", result.ok === true);
  assert("body preserva o json", result.ok && JSON.parse(result.text).instance === "nexa-01");
  assert("body reporta tamanho", result.ok && result.sizeBytes > 0);
}

{
  const req = makeRequest(evolutionPayload);
  const result = await readRequestBodyWithLimit(req, readOpts({ maxBytes: 10 }));
  assert("body grande e rejeitado", result.ok === false && result.reason === "too_large");
}

{
  let cancelled = false;
  const stalling = {
    headers: new Headers(),
    body: {
      getReader: () => ({
        read: () => new Promise(() => {}),
        cancel: async () => {
          cancelled = true;
        },
      }),
    },
    text: () => new Promise(() => {}),
  };
  const result = await readRequestBodyWithLimit(
    stalling,
    readOpts({ stallTimeoutMs: 40, totalTimeoutMs: 5000 }),
  );
  assert("body travado estoura por inatividade", result.ok === false && result.reason === "stall_timeout");
  assert("reader e cancelado no timeout", cancelled === true);
}

{
  // Upload lento porém contínuo não pode ser cortado pelo prazo de inatividade:
  // é exatamente o caso de mídia grande em base64.
  const chunk = Buffer.from("x".repeat(64));
  let sent = 0;
  const dripping = {
    headers: new Headers(),
    body: {
      getReader: () => ({
        read: () =>
          new Promise((resolve) => {
            setTimeout(() => {
              sent += 1;
              if (sent > 12) resolve({ done: true });
              else resolve({ done: false, value: new Uint8Array(chunk) });
            }, 15);
          }),
        cancel: async () => {},
      }),
    },
    text: () => new Promise(() => {}),
  };
  const result = await readRequestBodyWithLimit(
    dripping,
    readOpts({ stallTimeoutMs: 60, totalTimeoutMs: 5000 }),
  );
  assert("upload lento com progresso nao e cortado", result.ok === true);
  assert("upload lento entrega todos os bytes", result.ok && result.sizeBytes === 12 * 64);
}

{
  // Progresso constante ainda esbarra no teto absoluto (slow-loris).
  const dripping = {
    headers: new Headers(),
    body: {
      getReader: () => ({
        read: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ done: false, value: new Uint8Array([1]) }), 5);
          }),
        cancel: async () => {},
      }),
    },
    text: () => new Promise(() => {}),
  };
  const result = await readRequestBodyWithLimit(
    dripping,
    readOpts({ stallTimeoutMs: 1000, totalTimeoutMs: 60 }),
  );
  assert("teto absoluto corta upload eterno", result.ok === false && result.reason === "total_timeout");
  assert("timeout absoluto reporta bytes lidos", result.ok === false && result.sizeBytes > 0);
}

assert("too_large -> 413", bodyReadFailureStatus("too_large") === 413);
assert("stall_timeout -> 408", bodyReadFailureStatus("stall_timeout") === 408);
assert("total_timeout -> 408", bodyReadFailureStatus("total_timeout") === 408);
assert("read_error -> 400", bodyReadFailureStatus("read_error") === 400);

// ---------------------------------------------------------------------------
// Leitura sob reserva de memória
// ---------------------------------------------------------------------------

{
  __resetWebhookInboxBudgetForTests();
  const budget = createByteBudget(10_000);
  const out = await readWebhookBodyForInbox(makeRequest(evolutionPayload), {
    provider: "evolution",
    env: {},
    budget,
    logError: () => {},
  });
  assert("leitura com reserva devolve o corpo", out.ok === true);
  assert("reserva fica retida durante o uso", budget.metrics().availableBytes < 10_000);
  out.ok && out.release();
  assert("reserva e devolvida ao final", budget.metrics().availableBytes === 10_000);
}

{
  // Content-Length acima do teto: corta antes de alocar qualquer byte.
  const budget = createByteBudget(10_000);
  let readAttempted = false;
  const request = {
    headers: new Headers({ "content-type": "application/json", "content-length": "999999" }),
    body: {
      getReader: () => {
        readAttempted = true;
        return { read: () => Promise.resolve({ done: true }), cancel: async () => {} };
      },
    },
    text: async () => "{}",
  };
  const rejected = [];
  const out = await readWebhookBodyForInbox(request, {
    provider: "evolution",
    env: { WEBHOOK_INBOX_MAX_PAYLOAD_BYTES: "1000" },
    budget,
    logError: (tag, data) => rejected.push({ tag, data }),
  });
  assert("content-length acima do teto responde 413", out.ok === false && out.response.status === 413);
  assert("corpo nem chega a ser lido", readAttempted === false);
  assert("orcamento nao e tocado", budget.metrics().availableBytes === 10_000);
  assert(
    "rejeicao por tamanho e registrada, nunca silenciosa",
    rejected.some((r) => r.tag === "WEBHOOK_INBOX_PAYLOAD_REJECTED" && r.data.reason === "too_large"),
  );
  assert("log informa o limite aplicado", rejected[0].data.maxPayloadBytes === 1000);
}

{
  // Content-Length pequeno não pode bloquear o orçamento inteiro.
  const budget = createByteBudget(10_000);
  const body = JSON.stringify(evolutionPayload);
  const request = {
    headers: new Headers({
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body, "utf8")),
    }),
    body: null,
    text: async () => body,
  };
  let observedAvailable = null;
  const out = await readWebhookBodyForInbox(request, {
    provider: "evolution",
    env: {},
    budget,
    logError: () => {},
  });
  observedAvailable = budget.metrics().availableBytes;
  assert("leitura com content-length funciona", out.ok === true);
  assert(
    "reserva proporcional ao content-length",
    observedAvailable === 10_000 - Buffer.byteLength(body, "utf8"),
  );
  out.ok && out.release();
}

{
  // Sem orçamento disponível: 503 com Retry-After, nunca descarte.
  const budget = createByteBudget(100);
  const held = await budget.acquire(100, 1000);
  const logs = [];
  const out = await readWebhookBodyForInbox(makeRequest(evolutionPayload), {
    provider: "evolution",
    env: { WEBHOOK_INBOX_MEMORY_ACQUIRE_TIMEOUT_MS: "30" },
    budget,
    logError: (tag, data) => logs.push({ tag, data }),
  });
  assert("falta de memoria responde 503", out.ok === false && out.response.status === 503);
  assert(
    "503 por memoria traz Retry-After",
    out.ok === false && out.response.headers.get("Retry-After") === "5",
  );
  assert(
    "503 por memoria e marcado como retentavel",
    out.ok === false && (await out.response.json()).retryable === true,
  );
  assert(
    "throttling e registrado",
    logs.some((l) => l.tag === "WEBHOOK_INBOX_THROTTLED"),
  );
  held();
}

// ---------------------------------------------------------------------------
// Persistência
// ---------------------------------------------------------------------------

{
  const store = createStore();
  const { sql, state } = makeSql(store);

  const first = await persistWebhookEvent({
    sql,
    provider: "evolution",
    eventType: "messages.upsert",
    companyId: null,
    channelId: null,
    instanceName: "nexa-01",
    externalEventId: null,
    externalMessageId: "WAMID-A",
    deduplicationKey: "evolution:nexa-01:messages.upsert:WAMID-A",
    rawPayload: JSON.stringify(evolutionPayload),
    requestHeaders: { "content-type": "application/json" },
    statementTimeoutMs: 4321,
  });

  assert("evento novo e persistido", first.status === "persisted");
  assert("persistido devolve id", typeof first.inboxId === "string" && first.inboxId.length > 0);
  assert("persistido mede o tempo", typeof first.persistenceMs === "number" && first.persistenceMs >= 0);
  assert("uma linha gravada", store.rows.length === 1);
  assert("linha nasce pending", store.rows[0].status === "pending");
  assert(
    "statement_timeout aplicado na transacao",
    state.unsafeCalls.some((q) => q.includes("SET LOCAL statement_timeout = 4321")),
  );

  const second = await persistWebhookEvent({
    sql,
    provider: "evolution",
    eventType: "messages.upsert",
    companyId: null,
    channelId: null,
    instanceName: "nexa-01",
    externalEventId: null,
    externalMessageId: "WAMID-A",
    deduplicationKey: "evolution:nexa-01:messages.upsert:WAMID-A",
    rawPayload: JSON.stringify(evolutionPayload),
    requestHeaders: { "content-type": "application/json" },
  });

  assert("reentrega e duplicada", second.status === "duplicate");
  assert("duplicado nao cria segunda linha", store.rows.length === 1);
  assert("duplicado devolve o id existente", second.inboxId === first.inboxId);
}

// ---------------------------------------------------------------------------
// Pipeline HTTP
// ---------------------------------------------------------------------------

{
  const store = createStore();
  const { sql, state } = makeSql(store, { commitDelayMs: 25 });
  const observed = {};

  const response = await ingestWebhookRequestToInbox({
    sql,
    provider: "evolution",
    request: makeRequest(evolutionPayload, { apikey: "SEGREDO-NAO-PODE-VAZAR" }),
    ...silent,
    okResponse: (outcome) => {
      observed.commitsAtResponse = state.commits;
      observed.rowsAtResponse = store.rows.length;
      observed.status = outcome.status;
      return Response.json({ ok: true, inboxId: outcome.inboxId });
    },
  });

  assert("ingestao responde 200", response.status === 200);
  assert("commit ocorreu antes da resposta", observed.commitsAtResponse === 1);
  assert("linha ja existia quando respondeu", observed.rowsAtResponse === 1);
  assert("desfecho persisted", observed.status === "persisted");

  const row = store.rows[0];
  assert("payload permanece integral", row.payload === JSON.stringify(evolutionPayload));
  assert(
    "payload preserva campos aninhados",
    JSON.parse(row.payload).data.key.id === "WAMID-A" &&
      JSON.parse(row.payload).data.message.conversation === "ola",
  );
  assert("instance gravada", row.instance_name === "nexa-01");
  assert("external_message_id gravado", row.external_message_id === "WAMID-A");
  assert("company_id fica nulo na ingestao", row.company_id === null);
  assert("channel_id fica nulo na ingestao", row.channel_id === null);
  assert("headers sensiveis nao sao salvos", !row.request_headers.includes("SEGREDO-NAO-PODE-VAZAR"));
  assert("presenca de apikey registrada", JSON.parse(row.request_headers).has_apikey === true);

  // "Restart": novo cliente SQL, mesmo armazenamento — o já persistido continua lá.
  const restarted = makeSql(store, {});
  const again = await ingestWebhookRequestToInbox({
    sql: restarted.sql,
    provider: "evolution",
    request: makeRequest(evolutionPayload),
    ...silent,
  });
  assert("apos restart responde 200", again.status === 200);
  assert("apos restart evento e duplicado", (await again.json()).duplicate === true);
  assert("apos restart continua uma linha", store.rows.length === 1);
}

{
  const store = createStore();
  const { sql } = makeSql(store, { failOnBegin: true, failMessage: "connection terminated" });
  const response = await ingestWebhookRequestToInbox({
    sql,
    provider: "evolution",
    request: makeRequest(evolutionPayload),
    ...silent,
  });

  assert("falha de banco responde 503", response.status === 503);
  assert("503 traz Retry-After", response.headers.get("Retry-After") === "5");
  assert("503 marca retryable", (await response.json()).retryable === true);
  assert("falha nao grava linha", store.rows.length === 0);
}

{
  const store = createStore();
  const { sql } = makeSql(store, { failOnInsert: true });
  const response = await ingestWebhookRequestToInbox({
    sql,
    provider: "evolution",
    request: makeRequest(evolutionPayload),
    ...silent,
  });
  assert("falha no INSERT tambem responde 503", response.status === 503);
  assert("falha no INSERT nao deixa linha", store.rows.length === 0);
}

{
  const store = createStore();
  const { sql } = makeSql(store);
  const response = await ingestWebhookRequestToInbox({
    sql,
    provider: "evolution",
    request: makeRequest(evolutionPayload),
    env: { WEBHOOK_INBOX_MAX_PAYLOAD_BYTES: "20" },
    ...silent,
  });
  assert("payload acima do limite responde 413", response.status === 413);
  assert("payload acima do limite nao grava", store.rows.length === 0);
}

{
  const store = createStore();
  const { sql } = makeSql(store);
  const stalling = {
    headers: new Headers({ "content-type": "application/json" }),
    body: {
      getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }),
    },
    text: () => new Promise(() => {}),
  };
  const response = await ingestWebhookRequestToInbox({
    sql,
    provider: "evolution",
    request: stalling,
    env: { WEBHOOK_INBOX_BODY_TIMEOUT_MS: "40" },
    ...silent,
  });
  assert("timeout de leitura responde 408", response.status === 408);
  assert("timeout de leitura nao grava", store.rows.length === 0);
}

{
  const store = createStore();
  const { sql } = makeSql(store);
  const response = await ingestWebhookRequestToInbox({
    sql,
    provider: "evolution",
    request: makeRequest("{isso nao e json"),
    ...silent,
  });
  assert("json invalido responde 400", response.status === 400);
  assert("json invalido nao grava", store.rows.length === 0);
}

{
  // A reserva de memória tem que cair em todos os desfechos, senão o processo
  // trava sozinho depois de alguns eventos.
  const store = createStore();
  const budget = createByteBudget(50_000);
  const total = budget.totalBytes;

  const ok = await ingestWebhookRequestToInbox({
    sql: makeSql(store).sql,
    provider: "evolution",
    request: makeRequest(evolutionPayload),
    budget,
    ...silent,
  });
  assert("ingestao com reserva responde 200", ok.status === 200);
  assert("reserva liberada apos 200", budget.metrics().availableBytes === total);

  const failed = await ingestWebhookRequestToInbox({
    sql: makeSql(createStore(), { failOnInsert: true }).sql,
    provider: "evolution",
    request: makeRequest(evolutionPayload),
    budget,
    ...silent,
  });
  assert("ingestao com falha responde 503", failed.status === 503);
  assert("reserva liberada apos 503", budget.metrics().availableBytes === total);

  const tooLarge = await ingestWebhookRequestToInbox({
    sql: makeSql(createStore()).sql,
    provider: "evolution",
    request: makeRequest(evolutionPayload),
    budget,
    env: { WEBHOOK_INBOX_MAX_PAYLOAD_BYTES: "20" },
    ...silent,
  });
  assert("ingestao acima do teto responde 413", tooLarge.status === 413);
  assert("reserva liberada apos 413", budget.metrics().availableBytes === total);

  const invalid = await ingestWebhookRequestToInbox({
    sql: makeSql(createStore()).sql,
    provider: "evolution",
    request: makeRequest("{quebrado"),
    budget,
    ...silent,
  });
  assert("ingestao com json invalido responde 400", invalid.status === 400);
  assert("reserva liberada apos 400", budget.metrics().availableBytes === total);
}

{
  // Pool da inbox saturado: 503 retentável, nunca 200 sem COMMIT.
  const store = createStore();
  const { sql } = makeSql(store);
  const logs = [];
  const response = await ingestWebhookRequestToInbox({
    sql,
    provider: "evolution",
    request: makeRequest(evolutionPayload),
    acquireSlot: () => Promise.reject(new Error("inbox_pool_acquire_timeout")),
    log: () => {},
    logError: (tag, data) => logs.push({ tag, data }),
  });
  assert("timeout de conexao responde 503", response.status === 503);
  assert("timeout de conexao traz Retry-After", response.headers.get("Retry-After") === "5");
  assert("timeout de conexao nao grava", store.rows.length === 0);
  assert(
    "timeout de conexao aparece no log de falha",
    logs.some(
      (l) => l.tag === "WEBHOOK_INBOX_PERSIST_FAILED" && l.data.reason === "pool_acquire_timeout",
    ),
  );
}

{
  // A persistência precisa acontecer dentro do slot de conexão adquirido.
  const store = createStore();
  const { sql } = makeSql(store);
  const events = [];
  await persistWebhookEvent({
    sql,
    provider: "evolution",
    eventType: "messages.upsert",
    companyId: null,
    channelId: null,
    instanceName: "nexa-01",
    externalEventId: null,
    externalMessageId: "WAMID-SLOT",
    deduplicationKey: "evolution:slot",
    rawPayload: JSON.stringify(evolutionPayload),
    requestHeaders: {},
    acquireSlot: async (fn) => {
      events.push("acquire");
      const result = await fn();
      events.push("release");
      return result;
    },
  });
  assert("insert roda dentro do slot", events.join(",") === "acquire,release");
  assert("insert com slot grava a linha", store.rows.length === 1);
}

// ---------------------------------------------------------------------------
// O gate não pode barrar a ingestão
// ---------------------------------------------------------------------------

{
  __resetPoolGateForTests();
  const max = getWebhookConcurrencyMax();
  for (let i = 0; i < max; i += 1) {
    void withWebhookConcurrencyLimit("saturar", 60_000, () => new Promise(() => {}));
  }

  let called = false;
  const response = await runWebhookIngress(
    "evolution",
    async () => {
      called = true;
      return Response.json({ ok: true });
    },
    { WEBHOOK_DURABLE_INBOX_ENABLED: "true" },
  );

  assert("gate saturado nao impede a ingestao durável", called === true);
  assert("ingestao responde 200 com gate saturado", response.status === 200);
  __resetPoolGateForTests();
}

{
  __resetPoolGateForTests();
  let called = false;
  const response = await runWebhookIngress(
    "evolution",
    async () => {
      called = true;
      return Response.json({ ok: true });
    },
    {},
  );
  assert("com flag desligada o fluxo legado roda pelo gate", called === true && response.status === 200);
  __resetPoolGateForTests();
}

// ---------------------------------------------------------------------------
// Verificações estáticas
// ---------------------------------------------------------------------------

{
  const evolutionSrc = readSource("src/routes/api/public/webhooks/evolution.ts");
  const start = evolutionSrc.indexOf("export async function ingestEvolutionWebhookDurable");
  const end = evolutionSrc.indexOf("\n}", start);
  const ingestBody = evolutionSrc.slice(start, end);

  assert("ingestao evolution existe", start > 0);
  for (const heavy of [
    "upsertContact",
    "upsertConversation",
    "downloadMediaFromEvolution",
    "handleCampaignInboundReply",
    "handleMessagesUpsert",
    "INSERT INTO public.messages",
    "UPDATE public.conversations",
  ]) {
    assert(`ingestao evolution nao chama ${heavy}`, !ingestBody.includes(heavy));
  }
  assert("ingestao evolution valida o token antes", ingestBody.includes("checkWebhookAuth"));
  assert("ingestao evolution usa a inbox", ingestBody.includes("ingestWebhookRequestToInbox"));
  assert("ingestao evolution usa o pool dedicado", ingestBody.includes("getWebhookInboxSql()"));
  assert("ingestao evolution nao usa o pool do web", !ingestBody.includes("getSql()"));

  assert(
    "rota publica evolution usa runWebhookIngress",
    evolutionSrc.includes('runWebhookIngress("evolution_public"'),
  );
  assert(
    "rota publica evolution nao chama mais o gate direto",
    !evolutionSrc.includes("runWebhookWithConcurrencyLimit"),
  );
  assert(
    "roteador evolution respeita a flag",
    /isDurableWebhookInboxEnabled\(\)\)\s*return ingestEvolutionWebhookDurable/.test(evolutionSrc),
  );

  const evolutionRoute = readSource("src/routes/api/webhooks/evolution.ts");
  assert("rota oficial evolution usa runWebhookIngress", evolutionRoute.includes("runWebhookIngress"));
  assert(
    "rota oficial evolution nao chama mais o gate direto",
    !evolutionRoute.includes("runWebhookWithConcurrencyLimit"),
  );
}

{
  const metaSrc = readSource("src/lib/meta-webhook.server.ts");
  const start = metaSrc.indexOf("export async function ingestMetaWebhookDurable");
  const end = metaSrc.indexOf("export async function handleMetaWebhookRequest", start);
  const ingestBody = metaSrc.slice(start, end);

  assert("ingestao meta existe", start > 0 && end > start);
  assert("ingestao meta usa o pool dedicado", ingestBody.includes("getWebhookInboxSql()"));
  assert("ingestao meta nao usa o pool do web", !ingestBody.includes("getSql()"));
  assert("ingestao meta le o corpo sob reserva", ingestBody.includes("readWebhookBodyForInbox"));
  assert("ingestao meta devolve a reserva", ingestBody.includes("body.release()"));
  assert("ingestao meta confere assinatura", ingestBody.includes("validateMetaWebhookSignature"));
  assert("ingestao meta rejeita assinatura ausente", ingestBody.includes("missing_signature"));
  assert("ingestao meta rejeita assinatura invalida", ingestBody.includes("invalid_signature"));
  assert("ingestao meta preserva diagnosticos", ingestBody.includes("logMetaWebhookChanges"));
  assert("ingestao meta usa a inbox", ingestBody.includes("ingestWebhookRequestToInbox"));
  for (const heavy of ["persistMetaInboundMessages", "loadMetaChannelByPhoneNumberId", "touchChannelLastWebhookAt"]) {
    assert(`ingestao meta nao chama ${heavy}`, !ingestBody.includes(heavy));
  }
  assert("challenge GET preservado", metaSrc.includes("hub.challenge"));
  assert(
    "roteador meta respeita a flag",
    /isDurableWebhookInboxEnabled\(\)\)\s*return ingestMetaWebhookDurable/.test(metaSrc),
  );

  for (const rel of [
    "src/routes/api/webhooks/meta.ts",
    "src/routes/api/public/webhooks/meta.ts",
    "src/routes/api/webhooks/meta/whatsapp.ts",
  ]) {
    const src = readSource(rel);
    assert(`${rel} usa runWebhookIngress`, src.includes("runWebhookIngress"));
    assert(`${rel} nao chama mais o gate direto`, !src.includes("runWebhookWithConcurrencyLimit"));
  }
}

{
  const poolSrc = readSource("src/lib/pg-webhook-inbox.server.ts");
  assert("pool da inbox nao importa pg.server", !/from "@\/lib\/pg\.server"/.test(poolSrc));
  assert("pool da inbox nao importa o gate do web", !poolSrc.includes("pg-pool-gate.server"));
  assert("pool da inbox aplica statement_timeout", poolSrc.includes("statement_timeout"));
  assert("pool da inbox tem connect_timeout", poolSrc.includes("connect_timeout"));
  assert("pool da inbox nunca loga a URL", !/console\.log\([^)]*url/.test(poolSrc));
}

{
  const migration = readSource("docs/migrations/20260808_webhook_inbox.sql");
  for (const column of [
    "provider",
    "event_type",
    "company_id",
    "channel_id",
    "instance_name",
    "external_event_id",
    "external_message_id",
    "deduplication_key",
    "payload JSONB",
    "request_headers JSONB",
    "status",
    "attempts",
    "available_at",
    "locked_at",
    "locked_by",
    "lease_expires_at",
    "processed_at",
    "last_error",
    "received_at",
    "created_at",
    "updated_at",
  ]) {
    assert(`migration declara ${column}`, migration.includes(column));
  }
  assert(
    "migration restringe status",
    migration.includes("'pending', 'processing', 'retry', 'processed', 'dead_letter'"),
  );
  assert(
    "migration tem unique (provider, deduplication_key)",
    migration.includes("ux_webhook_inbox_provider_dedup") &&
      migration.includes("(provider, deduplication_key)"),
  );
  assert(
    "migration tem indice parcial de fila",
    migration.includes("WHERE status IN ('pending', 'retry')"),
  );
  for (const idx of [
    "idx_webhook_inbox_company",
    "idx_webhook_inbox_channel",
    "idx_webhook_inbox_received_at",
    "idx_webhook_inbox_external_message_id",
  ]) {
    assert(`migration tem ${idx}`, migration.includes(idx));
  }
  assert("migration e transacional", migration.includes("BEGIN;") && migration.includes("COMMIT;"));
  assert("migration nao apaga payload", !/DELETE FROM public\.webhook_inbox/i.test(migration));

  const rollback = readSource("docs/migrations/20260808_webhook_inbox_rollback.sql");
  assert("rollback existe e derruba a tabela", rollback.includes("DROP TABLE IF EXISTS public.webhook_inbox"));
}

console.log(
  failed === 0 ? "\nAll webhook inbox tests passed." : `\n${failed} test(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
