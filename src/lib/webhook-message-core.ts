/**
 * Núcleo puro do message-worker — sem banco, sem RabbitMQ, sem IO.
 *
 * Concentra o que precisa ser determinístico e testável em isolamento:
 * flags, configuração, validação do envelope, classificação de erro, backoff e
 * a chave de serialização por conversa.
 */

import { createHash } from "node:crypto";
import { isDurableWebhookInboxEnabled, type WebhookProvider } from "@/lib/webhook-inbox-core";

function parseBooleanEnv(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function parseBooleanEnvDefaultTrue(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return true;
  return !(v === "false" || v === "0" || v === "no");
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const v = (raw ?? "").trim();
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  return floored > 0 ? floored : fallback;
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

/** Liga o consumo do RabbitMQ pelo message-worker. Default false. */
export function isWebhookRabbitProcessingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanEnv(env.WEBHOOK_RABBITMQ_PROCESSING_ENABLED);
}

/** Liga o serviço publicador da outbox. Default false. */
export function isWebhookOutboxPublisherEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanEnv(env.WEBHOOK_OUTBOX_PUBLISHER_ENABLED);
}

/**
 * Kill-switch do processamento legado dentro da requisição HTTP.
 *
 * Default TRUE, ao contrário das outras flags. É o único jeito honesto: hoje
 * o processamento legado é o comportamento de produção, e uma variável ausente
 * não pode desligar o que já está no ar. As flags novas ligam coisas que ainda
 * não existem; esta descreve algo que já roda.
 */
export function isWebhookLegacyProcessingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanEnvDefaultTrue(env.WEBHOOK_LEGACY_PROCESSING_ENABLED);
}

/**
 * O legado só processa de fato quando a ingestão durável está desligada — é o
 * que a rota faz hoje. A flag acima é o segundo cadeado, não o primeiro.
 */
export function isLegacyProcessingActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return isWebhookLegacyProcessingEnabled(env) && !isDurableWebhookInboxEnabled(env);
}

export type WebhookConfigIssue = {
  code:
    | "legacy_and_worker_active"
    | "worker_without_durable_inbox"
    | "worker_without_publisher"
    | "ingest_without_processing";
  severity: "danger" | "warning";
  message: string;
};

/**
 * Detecta combinações de flags que duplicam ou engolem eventos.
 *
 * `danger` é processamento duplo: a mesma mensagem viraria dois registros para
 * o cliente. `warning` é backlog silencioso: nada se perde, mas nada anda.
 */
export function detectWebhookConfigIssues(
  env: NodeJS.ProcessEnv = process.env,
): WebhookConfigIssue[] {
  const durableInbox = isDurableWebhookInboxEnabled(env);
  const publisher = isWebhookOutboxPublisherEnabled(env);
  const rabbitProcessing = isWebhookRabbitProcessingEnabled(env);
  const legacyActive = isLegacyProcessingActive(env);

  const issues: WebhookConfigIssue[] = [];

  if (legacyActive && rabbitProcessing) {
    issues.push({
      code: "legacy_and_worker_active",
      severity: "danger",
      message:
        "Processamento legado e message-worker ativos ao mesmo tempo: o mesmo evento pode virar duas mensagens. Ligue WEBHOOK_DURABLE_INBOX_ENABLED (que desvia a rota para a ingestão) antes de ligar o worker.",
    });
  }

  if (rabbitProcessing && !durableInbox) {
    issues.push({
      code: "worker_without_durable_inbox",
      severity: "danger",
      message:
        "WEBHOOK_RABBITMQ_PROCESSING_ENABLED=true com WEBHOOK_DURABLE_INBOX_ENABLED=false: nada é gravado na inbox, então o worker consome referências que não existem.",
    });
  }

  if (rabbitProcessing && !publisher) {
    issues.push({
      code: "worker_without_publisher",
      severity: "warning",
      message:
        "Worker ligado sem WEBHOOK_OUTBOX_PUBLISHER_ENABLED: a fila só recebe mensagens se outra réplica estiver publicando.",
    });
  }

  if (durableInbox && !rabbitProcessing) {
    issues.push({
      code: "ingest_without_processing",
      severity: "warning",
      message:
        "Ingestão durável ligada sem message-worker: os eventos são preservados na inbox, mas não viram contato/conversa/mensagem.",
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

export const WEBHOOK_MESSAGE_DEFAULT_MAX_ATTEMPTS = 8;
export const WEBHOOK_MESSAGE_DEFAULT_BASE_RETRY_MS = 2_000;
export const WEBHOOK_MESSAGE_DEFAULT_MAX_RETRY_MS = 300_000;
export const WEBHOOK_MESSAGE_DEFAULT_LEASE_MS = 120_000;
export const WEBHOOK_MESSAGE_DEFAULT_PREFETCH = 8;
/** Intervalo do loop estacionado: vivo para o orquestrador, sem martelar nada. */
export const WEBHOOK_MESSAGE_PARKED_POLL_INTERVAL_MS = 60_000;
/**
 * Espera antes de devolver à fila um evento cujo lease ainda pertence a outro
 * worker. Sem isso o NACK volta instantaneamente e vira laço apertado.
 */
export const WEBHOOK_MESSAGE_DEFAULT_LEASE_CONFLICT_DELAY_MS = 5_000;

export type WebhookMessageConfig = {
  maxAttempts: number;
  baseRetryMs: number;
  maxRetryMs: number;
  leaseMs: number;
  prefetch: number;
  leaseConflictDelayMs: number;
};

export function readWebhookMessageConfig(
  env: NodeJS.ProcessEnv = process.env,
): WebhookMessageConfig {
  const baseRetryMs = parsePositiveInt(
    env.WEBHOOK_MESSAGE_BASE_RETRY_MS,
    WEBHOOK_MESSAGE_DEFAULT_BASE_RETRY_MS,
  );
  const maxRetryMs = parsePositiveInt(
    env.WEBHOOK_MESSAGE_MAX_RETRY_MS,
    WEBHOOK_MESSAGE_DEFAULT_MAX_RETRY_MS,
  );

  return {
    maxAttempts: parsePositiveInt(
      env.WEBHOOK_MESSAGE_MAX_ATTEMPTS,
      WEBHOOK_MESSAGE_DEFAULT_MAX_ATTEMPTS,
    ),
    baseRetryMs,
    // Teto abaixo da base seria configuração contraditória; a base vence.
    maxRetryMs: Math.max(baseRetryMs, maxRetryMs),
    leaseMs: parsePositiveInt(env.WEBHOOK_MESSAGE_LEASE_MS, WEBHOOK_MESSAGE_DEFAULT_LEASE_MS),
    prefetch: parsePositiveInt(env.WEBHOOK_MESSAGE_PREFETCH, WEBHOOK_MESSAGE_DEFAULT_PREFETCH),
    leaseConflictDelayMs: parsePositiveInt(
      env.WEBHOOK_MESSAGE_LEASE_CONFLICT_DELAY_MS,
      WEBHOOK_MESSAGE_DEFAULT_LEASE_CONFLICT_DELAY_MS,
    ),
  };
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/**
 * Backoff exponencial com jitter completo. O jitter evita que uma queda de
 * dependência sincronize todas as réplicas no mesmo instante de retorno.
 */
export function computeMessageRetryDelayMs(
  attempts: number,
  config: Pick<WebhookMessageConfig, "baseRetryMs" | "maxRetryMs">,
  random: () => number = Math.random,
): number {
  const safeAttempts = Math.max(1, Math.floor(attempts));
  const exponent = Math.min(safeAttempts - 1, 30);
  const ceiling = Math.min(config.maxRetryMs, config.baseRetryMs * 2 ** exponent);
  const jittered = Math.round(ceiling * random());
  return Math.min(config.maxRetryMs, Math.max(config.baseRetryMs, jittered));
}

export function shouldDeadLetterMessage(
  attempts: number,
  config: Pick<WebhookMessageConfig, "maxAttempts">,
): boolean {
  return attempts >= config.maxAttempts;
}

// ---------------------------------------------------------------------------
// Classificação de erro
// ---------------------------------------------------------------------------

export type ProcessingErrorKind = "temporary" | "permanent";

/** Erro que retentar não resolve: o evento vai direto para dead_letter. */
export class PermanentWebhookProcessingError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "PermanentWebhookProcessingError";
    this.code = code;
  }
}

/** Erro que provavelmente passa: o evento volta para retry com backoff. */
export class TemporaryWebhookProcessingError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "TemporaryWebhookProcessingError";
    this.code = code;
  }
}

/** SQLSTATE que indicam indisponibilidade momentânea, não payload ruim. */
const TEMPORARY_SQL_STATES = new Set([
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08007", // transaction_resolution_unknown
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "53300", // too_many_connections
  "53400", // configuration_limit_exceeded
  "55P03", // lock_not_available
  "57014", // query_canceled (statement_timeout)
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

const TEMPORARY_SYSCALL_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "CONNECT_TIMEOUT",
]);

const TEMPORARY_MESSAGE_PATTERN =
  /timeout|timed out|temporarily|temporariamente|unavailable|indispon|connection|conexão|conexao|deadlock|too many clients|server closed|socket hang up/i;

/**
 * Classifica o erro para decidir entre retry e dead_letter.
 *
 * O default é `temporary` de propósito. Um bug não classificado não pode
 * descartar a mensagem de um cliente na primeira tentativa; se for mesmo
 * insistente, o teto de tentativas leva ao dead_letter de qualquer forma.
 */
export function classifyProcessingError(error: unknown): ProcessingErrorKind {
  if (error instanceof PermanentWebhookProcessingError) return "permanent";
  if (error instanceof TemporaryWebhookProcessingError) return "temporary";

  const candidate = error as { code?: unknown; name?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  if (TEMPORARY_SQL_STATES.has(code)) return "temporary";
  if (TEMPORARY_SYSCALL_CODES.has(code)) return "temporary";

  // SQLSTATE 22xxx/23xxx são dado inválido e violação de constraint: insistir
  // com o mesmo payload dá exatamente o mesmo erro.
  if (/^(22|23|42)/.test(code)) return "permanent";

  if (candidate?.name === "AbortError") return "temporary";

  const message = typeof candidate?.message === "string" ? candidate.message : "";
  if (TEMPORARY_MESSAGE_PATTERN.test(message)) return "temporary";

  return "temporary";
}

/** Mensagem curta e sem payload para gravar em `last_error`. */
export const LAST_ERROR_MAX_LENGTH = 500;

export function describeProcessingError(error: unknown): string {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === "string" && candidate.code ? `${candidate.code}: ` : "";
  const message =
    typeof candidate?.message === "string" && candidate.message
      ? candidate.message
      : String(error ?? "unknown_error");
  return `${code}${message}`.slice(0, LAST_ERROR_MAX_LENGTH);
}

// ---------------------------------------------------------------------------
// Envelope publicado pela outbox
// ---------------------------------------------------------------------------

export const SUPPORTED_ENVELOPE_SCHEMA_VERSIONS = new Set([1]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type InboxEnvelope = {
  schemaVersion: number;
  inboxId: string;
  /**
   * Campos abaixo são dicas para log e roteamento. O worker NUNCA decide nada
   * com base neles: provider, empresa, canal e conversa são relidos da inbox.
   */
  provider: string | null;
  eventType: string | null;
  conversationKey: string | null;
  receivedAt: string | null;
};

export type EnvelopeParseFailure =
  | "invalid_json"
  | "not_an_object"
  | "missing_schema_version"
  | "unsupported_schema_version"
  | "missing_inbox_id"
  | "invalid_inbox_id";

export type EnvelopeParseResult =
  | { ok: true; envelope: InboxEnvelope }
  | { ok: false; reason: EnvelopeParseFailure };

/**
 * Valida a referência recebida do RabbitMQ.
 *
 * Só schemaVersion e inboxId são exigidos; é o contrato mínimo para achar o
 * evento verdadeiro. Envelope inválido é permanente por natureza — reentregar
 * o mesmo bytes produz o mesmo resultado.
 */
export function parseInboxEnvelope(raw: unknown): EnvelopeParseResult {
  let value: unknown = raw;

  if (typeof raw === "string" || raw instanceof Uint8Array) {
    const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "not_an_object" };
  }

  const record = value as Record<string, unknown>;

  if (record.schemaVersion == null) return { ok: false, reason: "missing_schema_version" };
  const schemaVersion = Number(record.schemaVersion);
  if (!SUPPORTED_ENVELOPE_SCHEMA_VERSIONS.has(schemaVersion)) {
    return { ok: false, reason: "unsupported_schema_version" };
  }

  const inboxId = typeof record.inboxId === "string" ? record.inboxId.trim() : "";
  if (!inboxId) return { ok: false, reason: "missing_inbox_id" };
  if (!UUID_PATTERN.test(inboxId)) return { ok: false, reason: "invalid_inbox_id" };

  const asStringOrNull = (input: unknown) =>
    typeof input === "string" && input.trim() !== "" ? input : null;

  return {
    ok: true,
    envelope: {
      schemaVersion,
      inboxId,
      provider: asStringOrNull(record.provider),
      eventType: asStringOrNull(record.eventType),
      conversationKey: asStringOrNull(record.conversationKey),
      receivedAt: asStringOrNull(record.receivedAt),
    },
  };
}

/** Atraso entre a chegada do evento e o início do processamento. */
export function computeQueueLagMs(
  receivedAt: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!receivedAt) return null;
  const parsed = Date.parse(receivedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, now - parsed);
}

// ---------------------------------------------------------------------------
// Serialização por conversa
// ---------------------------------------------------------------------------

export const PROVIDERS: ReadonlySet<string> = new Set<WebhookProvider>(["evolution", "meta"]);

export function isSupportedProvider(value: unknown): value is WebhookProvider {
  return typeof value === "string" && PROVIDERS.has(value);
}

/**
 * Chave de `pg_advisory_xact_lock` para uma conversa.
 *
 * 60 bits do sha256 — cabe folgado em bigint com sinal e mantém a colisão
 * irrelevante. Colidir só custaria serializar duas conversas sem necessidade,
 * nunca corromper dado.
 *
 * Retorna null quando não há conversa (connection.update, por exemplo): esses
 * eventos não disputam a mesma linha e não precisam de fila.
 */
export function conversationAdvisoryLockKey(
  companyId: string | null | undefined,
  conversationKey: string | null | undefined,
): string | null {
  const key = (conversationKey ?? "").trim();
  if (!key) return null;
  const scope = `${(companyId ?? "").trim()}:${key}`;
  const hex = createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 15);
  return BigInt(`0x${hex}`).toString();
}
