/**
 * Núcleo puro do media-worker — sem banco, sem RabbitMQ, sem IO de rede.
 *
 * Flags, configuração, classificação de erro, backoff e validação do envelope
 * de referência de mídia. Determinístico e testável em isolamento.
 */

function parseBooleanEnv(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
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

/** Liga o media-worker. Default false. */
export function isWebhookMediaWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanEnv(env.WEBHOOK_MEDIA_WORKER_ENABLED);
}

/**
 * Publicação/consumo opcional de referências de mídia no RabbitMQ.
 * O job em PostgreSQL continua sendo a fonte da verdade; Rabbit só acelera.
 */
export function isWebhookMediaRabbitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanEnv(env.WEBHOOK_MEDIA_RABBITMQ_ENABLED);
}

export const WEBHOOK_MEDIA_PARKED_POLL_INTERVAL_MS = 30_000;

export const WEBHOOK_MEDIA_DEFAULT_CONCURRENCY = 2;
export const WEBHOOK_MEDIA_DEFAULT_MAX_ATTEMPTS = 8;
export const WEBHOOK_MEDIA_DEFAULT_BASE_RETRY_MS = 2_000;
export const WEBHOOK_MEDIA_DEFAULT_MAX_RETRY_MS = 300_000;
export const WEBHOOK_MEDIA_DEFAULT_LEASE_MS = 180_000;
export const WEBHOOK_MEDIA_DEFAULT_BATCH_SIZE = 5;
export const WEBHOOK_MEDIA_DEFAULT_POLL_INTERVAL_MS = 2_000;
export const WEBHOOK_MEDIA_DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
export const WEBHOOK_MEDIA_DEFAULT_STALL_TIMEOUT_MS = 30_000;
/** Teto operacional default ≥ maior anexo legítimo documentado (Meta documento 100 MiB). */
export const WEBHOOK_MEDIA_DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Limites conhecidos dos provedores (referência operacional — não são CHECKs).
 * O default interno NÃO pode ser menor que o maior destes.
 */
export const PROVIDER_MEDIA_LIMITS = {
  meta: {
    imageBytes: 5 * 1024 * 1024,
    audioBytes: 16 * 1024 * 1024,
    videoBytes: 16 * 1024 * 1024,
    documentBytes: 100 * 1024 * 1024,
    maxKnownBytes: 100 * 1024 * 1024,
  },
  evolution: {
    // Evolution/WhatsApp multi-device: documentos grandes; trate 100 MiB como piso
    // operacional alinhado ao Meta. Instâncias podem aceitar mais — suba
    // WEBHOOK_MEDIA_MAX_BYTES sem perder o job (capacity = temporário).
    maxKnownBytes: 100 * 1024 * 1024,
    note: "getBase64FromMediaMessage devolve JSON/base64 (~4/3 do binário em disco)",
  },
} as const;
export const WEBHOOK_MEDIA_DEFAULT_PROGRESS_LOG_BYTES = 5 * 1024 * 1024;

export type WebhookMediaConfig = {
  concurrency: number;
  maxAttempts: number;
  baseRetryMs: number;
  maxRetryMs: number;
  leaseMs: number;
  batchSize: number;
  pollIntervalMs: number;
  downloadTimeoutMs: number;
  stallTimeoutMs: number;
  maxBytes: number;
  progressLogBytes: number;
};

export function readWebhookMediaConfig(env: NodeJS.ProcessEnv = process.env): WebhookMediaConfig {
  return {
    concurrency: parsePositiveInt(
      env.WEBHOOK_MEDIA_WORKER_CONCURRENCY,
      WEBHOOK_MEDIA_DEFAULT_CONCURRENCY,
    ),
    maxAttempts: parsePositiveInt(
      env.WEBHOOK_MEDIA_MAX_ATTEMPTS,
      WEBHOOK_MEDIA_DEFAULT_MAX_ATTEMPTS,
    ),
    baseRetryMs: parsePositiveInt(
      env.WEBHOOK_MEDIA_BASE_RETRY_MS,
      WEBHOOK_MEDIA_DEFAULT_BASE_RETRY_MS,
    ),
    maxRetryMs: parsePositiveInt(
      env.WEBHOOK_MEDIA_MAX_RETRY_MS,
      WEBHOOK_MEDIA_DEFAULT_MAX_RETRY_MS,
    ),
    leaseMs: parsePositiveInt(env.WEBHOOK_MEDIA_LEASE_MS, WEBHOOK_MEDIA_DEFAULT_LEASE_MS),
    batchSize: parsePositiveInt(env.WEBHOOK_MEDIA_BATCH_SIZE, WEBHOOK_MEDIA_DEFAULT_BATCH_SIZE),
    pollIntervalMs: parsePositiveInt(
      env.WEBHOOK_MEDIA_POLL_INTERVAL_MS,
      WEBHOOK_MEDIA_DEFAULT_POLL_INTERVAL_MS,
    ),
    downloadTimeoutMs: parsePositiveInt(
      env.WEBHOOK_MEDIA_DOWNLOAD_TIMEOUT_MS,
      WEBHOOK_MEDIA_DEFAULT_DOWNLOAD_TIMEOUT_MS,
    ),
    stallTimeoutMs: parsePositiveInt(
      env.WEBHOOK_MEDIA_STALL_TIMEOUT_MS,
      WEBHOOK_MEDIA_DEFAULT_STALL_TIMEOUT_MS,
    ),
    maxBytes: parsePositiveInt(env.WEBHOOK_MEDIA_MAX_BYTES, WEBHOOK_MEDIA_DEFAULT_MAX_BYTES),
    progressLogBytes: parsePositiveInt(
      env.WEBHOOK_MEDIA_PROGRESS_LOG_BYTES,
      WEBHOOK_MEDIA_DEFAULT_PROGRESS_LOG_BYTES,
    ),
  };
}

export const MEDIA_JOB_SCHEMA_VERSION = 1;

export type MediaJobEnvelope = {
  schemaVersion: number;
  mediaJobId: string;
  messageId?: string | null;
  provider?: string | null;
  receivedAt?: string | null;
};

export type ParseMediaEnvelopeResult =
  | { ok: true; envelope: MediaJobEnvelope }
  | { ok: false; reason: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseMediaJobEnvelope(raw: unknown): ParseMediaEnvelopeResult {
  let value: unknown = raw;
  if (typeof raw === "string" || Buffer.isBuffer(raw)) {
    try {
      value = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "not_an_object" };
  }
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion == null) return { ok: false, reason: "missing_schema_version" };
  if (Number(obj.schemaVersion) !== MEDIA_JOB_SCHEMA_VERSION) {
    return { ok: false, reason: "unsupported_schema_version" };
  }
  const mediaJobId = typeof obj.mediaJobId === "string" ? obj.mediaJobId.trim() : "";
  if (!mediaJobId) return { ok: false, reason: "missing_media_job_id" };
  if (!UUID_RE.test(mediaJobId)) return { ok: false, reason: "invalid_media_job_id" };
  return {
    ok: true,
    envelope: {
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      mediaJobId,
      messageId: typeof obj.messageId === "string" ? obj.messageId : null,
      provider: typeof obj.provider === "string" ? obj.provider : null,
      receivedAt: typeof obj.receivedAt === "string" ? obj.receivedAt : null,
    },
  };
}

export function computeMediaRetryDelayMs(
  attempts: number,
  config: Pick<WebhookMediaConfig, "baseRetryMs" | "maxRetryMs">,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(0, attempts - 1), 20);
  const ceiling = Math.min(config.maxRetryMs, config.baseRetryMs * 2 ** exponent);
  const jittered = Math.round(ceiling * (0.5 + random() * 0.5));
  return Math.min(config.maxRetryMs, Math.max(config.baseRetryMs, jittered));
}

export function shouldDeadLetterMedia(
  attempts: number,
  config: Pick<WebhookMediaConfig, "maxAttempts">,
): boolean {
  return attempts >= config.maxAttempts;
}

export function computeQueueLagMs(receivedAt: string | null | undefined, nowMs: number): number | null {
  if (!receivedAt) return null;
  const t = Date.parse(receivedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, nowMs - t);
}

export function buildStableMediaStorageKey(params: {
  companyId: string | null;
  channelId: string | null;
  externalMessageId: string | null;
  mediaType: string | null;
  messageId: string;
}): string {
  const company = (params.companyId ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 36);
  const channel = (params.channelId ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 36);
  const external = (params.externalMessageId ?? params.messageId)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
  const type = (params.mediaType ?? "bin").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  return `webhooks/${company}/${channel}/${external}-${type}`;
}

export function sanitizeMediaFileName(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = name.replace(/[/\\]/g, "_").replace(/[^\w.\- ()\[\]]+/g, "_").trim();
  if (!base || base === "." || base === "..") return null;
  return base.slice(0, 180);
}

export function maskSensitiveMediaText(raw: string): string {
  return raw
    .replace(/amqps?:\/\/[^\s'"]+/gi, "amqp://[redacted]")
    .replace(/postgres(ql)?:\/\/[^\s'"]+/gi, "postgres://[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1[redacted]")
    .replace(/(apikey["']?\s*[:=]\s*["']?)[^"',\s]+/gi, "$1[redacted]")
    .replace(/([?&](access_token|token|signature)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/gi, "data:[redacted];base64,[redacted]")
    .replace(/\b[A-Za-z0-9+/]{80,}={0,2}\b/g, "[base64-redacted]")
    .slice(0, 500);
}

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

export class PermanentMediaProcessingError extends Error {
  readonly kind = "permanent" as const;
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PermanentMediaProcessingError";
    this.code = code;
  }
}

export class TemporaryMediaProcessingError extends Error {
  readonly kind = "temporary" as const;
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TemporaryMediaProcessingError";
    this.code = code;
  }
}

export type MediaErrorKind = "temporary" | "permanent";

export function classifyMediaProcessingError(error: unknown): MediaErrorKind {
  if (error instanceof PermanentMediaProcessingError) return "permanent";
  if (error instanceof TemporaryMediaProcessingError) return "temporary";
  if (error && typeof error === "object" && "kind" in error) {
    const kind = (error as { kind?: unknown }).kind;
    if (kind === "permanent") return "permanent";
    if (kind === "temporary") return "temporary";
  }
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (
    msg.includes("timeout") ||
    msg.includes("aborted") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("429") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("network") ||
    msg.includes("temporar") ||
    msg.includes("storage_unavailable") ||
    msg.includes("token_unavailable") ||
    msg.includes("internal_capacity_exceeded") ||
    msg.includes("capacity")
  ) {
    return "temporary";
  }
  return "temporary";
}

export function describeMediaProcessingError(error: unknown): string {
  if (error instanceof PermanentMediaProcessingError || error instanceof TemporaryMediaProcessingError) {
    return maskSensitiveMediaText(`${error.code}:${error.message}`);
  }
  if (error instanceof Error) return maskSensitiveMediaText(`${error.name}:${error.message}`);
  return maskSensitiveMediaText(String(error));
}

/** Status de mídia na mensagem (coluna TEXT, sem CHECK no banco). */
export type MessageMediaStatus =
  | "pending"
  | "processing"
  | "available"
  | "retry"
  | "failed";

export const MESSAGE_MEDIA_STATUS = {
  pending: "pending",
  processing: "processing",
  available: "available",
  retry: "retry",
  failed: "failed",
} as const satisfies Record<MessageMediaStatus, MessageMediaStatus>;
