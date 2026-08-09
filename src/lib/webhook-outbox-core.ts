/**
 * Núcleo puro da outbox transacional — sem banco, sem RabbitMQ, sem IO.
 *
 * Concentra o que precisa ser determinístico e testável em isolamento:
 * configuração, routing key, corpo da mensagem publicada e política de retry.
 */

import type { WebhookIdentifiers, WebhookProvider } from "@/lib/webhook-inbox-core";

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  return floored > 0 ? floored : fallback;
}

export const WEBHOOK_OUTBOX_DEFAULT_MAX_ATTEMPTS = 10;
export const WEBHOOK_OUTBOX_DEFAULT_BASE_RETRY_MS = 1_000;
export const WEBHOOK_OUTBOX_DEFAULT_MAX_RETRY_MS = 300_000;
export const WEBHOOK_OUTBOX_DEFAULT_LEASE_MS = 60_000;
export const WEBHOOK_OUTBOX_DEFAULT_BATCH_SIZE = 50;
export const WEBHOOK_OUTBOX_DEFAULT_POLL_INTERVAL_MS = 1_000;
/** Intervalo do loop quando RABBITMQ_ENABLED=false: estacionado, sem martelar. */
export const WEBHOOK_OUTBOX_PARKED_POLL_INTERVAL_MS = 60_000;

export type WebhookOutboxConfig = {
  maxAttempts: number;
  baseRetryMs: number;
  maxRetryMs: number;
  leaseMs: number;
  batchSize: number;
  pollIntervalMs: number;
};

export function readWebhookOutboxConfig(
  env: NodeJS.ProcessEnv = process.env,
): WebhookOutboxConfig {
  const baseRetryMs = parsePositiveInt(
    env.WEBHOOK_OUTBOX_BASE_RETRY_MS,
    WEBHOOK_OUTBOX_DEFAULT_BASE_RETRY_MS,
  );
  const maxRetryMs = parsePositiveInt(
    env.WEBHOOK_OUTBOX_MAX_RETRY_MS,
    WEBHOOK_OUTBOX_DEFAULT_MAX_RETRY_MS,
  );

  return {
    maxAttempts: parsePositiveInt(
      env.WEBHOOK_OUTBOX_MAX_ATTEMPTS,
      WEBHOOK_OUTBOX_DEFAULT_MAX_ATTEMPTS,
    ),
    baseRetryMs,
    // Teto abaixo da base seria configuração contraditória; a base vence.
    maxRetryMs: Math.max(baseRetryMs, maxRetryMs),
    leaseMs: parsePositiveInt(env.WEBHOOK_OUTBOX_LEASE_MS, WEBHOOK_OUTBOX_DEFAULT_LEASE_MS),
    batchSize: parsePositiveInt(
      env.WEBHOOK_OUTBOX_BATCH_SIZE,
      WEBHOOK_OUTBOX_DEFAULT_BATCH_SIZE,
    ),
    pollIntervalMs: parsePositiveInt(
      env.WEBHOOK_OUTBOX_POLL_INTERVAL_MS,
      WEBHOOK_OUTBOX_DEFAULT_POLL_INTERVAL_MS,
    ),
  };
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/**
 * Backoff exponencial com jitter completo.
 *
 * O jitter existe para não sincronizar réplicas: sem ele, uma queda do broker
 * faz todas as mensagens voltarem no mesmo instante e derrubarem o broker de
 * novo assim que ele sobe.
 */
export function computeOutboxRetryDelayMs(
  attempts: number,
  config: Pick<WebhookOutboxConfig, "baseRetryMs" | "maxRetryMs">,
  random: () => number = Math.random,
): number {
  const safeAttempts = Math.max(1, Math.floor(attempts));
  // 2^30 já estoura qualquer teto; limitar o expoente evita Infinity.
  const exponent = Math.min(safeAttempts - 1, 30);
  const ceiling = Math.min(config.maxRetryMs, config.baseRetryMs * 2 ** exponent);
  const jittered = Math.round(ceiling * random());
  return Math.min(config.maxRetryMs, Math.max(config.baseRetryMs, jittered));
}

export function shouldDeadLetter(
  attempts: number,
  config: Pick<WebhookOutboxConfig, "maxAttempts">,
): boolean {
  return attempts >= config.maxAttempts;
}

// ---------------------------------------------------------------------------
// Destino da mensagem
// ---------------------------------------------------------------------------

/**
 * Nome de DEV explícito. Ambientes diferentes PRECISAM de nomes diferentes:
 * publicar evento de DEV numa exchange de produção entrega mensagem de teste a
 * cliente real.
 */
export const RABBITMQ_DEFAULT_EXCHANGE = "nexaboot.dev.webhooks";

/**
 * Lido também na ingestão, para gravar `exchange_name` junto da mensagem.
 * Fica aqui (e não no módulo do broker) para o endpoint HTTP não depender da
 * camada RabbitMQ nem do driver.
 */
export function readWebhookOutboxExchange(env: NodeJS.ProcessEnv = process.env): string {
  return env.RABBITMQ_EXCHANGE?.trim() || RABBITMQ_DEFAULT_EXCHANGE;
}

// ---------------------------------------------------------------------------
// Routing key
// ---------------------------------------------------------------------------

export const OUTBOX_ROUTING_KEY_MAX_LENGTH = 200;

/**
 * Routing key AMQP no formato `<provider>.<evento>`.
 * Normaliza para minúsculas e troca qualquer caractere fora de [a-z0-9._-] por
 * `_`, porque o eventType vem do provedor e não é confiável como topic.
 */
export function buildOutboxRoutingKey(
  provider: WebhookProvider,
  eventType: string | null,
): string {
  const normalize = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "_")
      .replace(/^[._]+|[._]+$/g, "");

  const event = normalize(eventType ?? "") || "unknown";
  return `${normalize(provider) || "unknown"}.${event}`.slice(
    0,
    OUTBOX_ROUTING_KEY_MAX_LENGTH,
  );
}

// ---------------------------------------------------------------------------
// Corpo da mensagem publicada
// ---------------------------------------------------------------------------

export const OUTBOX_MESSAGE_SCHEMA_VERSION = 1;

export type OutboxMessagePayload = {
  schemaVersion: number;
  inboxId: string;
  provider: WebhookProvider;
  eventType: string | null;
  companyId: string | null;
  channelId: string | null;
  instanceName: string | null;
  externalEventId: string | null;
  externalMessageId: string | null;
  conversationKey: string | null;
  receivedAt: string;
};

/**
 * Mensagem enxuta: só referências e metadados.
 *
 * O payload bruto (que pode ter mais de 100 MB de mídia em base64) fica só na
 * inbox; o worker da etapa 3 carrega por `inboxId`. Isso mantém a fila leve e
 * evita que o mesmo binário viva em três lugares ao mesmo tempo.
 */
export function buildOutboxMessagePayload(params: {
  inboxId: string;
  provider: WebhookProvider;
  identifiers: Pick<
    WebhookIdentifiers,
    "eventType" | "instanceName" | "externalEventId" | "externalMessageId" | "conversationKey"
  >;
  companyId?: string | null;
  channelId?: string | null;
  receivedAt: string;
}): OutboxMessagePayload {
  return {
    schemaVersion: OUTBOX_MESSAGE_SCHEMA_VERSION,
    inboxId: params.inboxId,
    provider: params.provider,
    eventType: params.identifiers.eventType,
    companyId: params.companyId ?? null,
    channelId: params.channelId ?? null,
    instanceName: params.identifiers.instanceName,
    externalEventId: params.identifiers.externalEventId,
    externalMessageId: params.identifiers.externalMessageId,
    conversationKey: params.identifiers.conversationKey,
    receivedAt: params.receivedAt,
  };
}
