/**
 * Núcleo puro da inbox durável de webhooks (ETAPA 1 — só ingestão).
 *
 * Sem acesso a banco e sem dependência de src/lib/pg.server: tudo aqui é
 * determinístico e testável isoladamente.
 */

import { createHash } from "node:crypto";

export type WebhookProvider = "evolution" | "meta";

// --------------------------------------------------------------------------
// Feature flags e limites
// --------------------------------------------------------------------------

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

/** Liga a ingestão durável. Default false (fluxo legado permanece intacto). */
export function isDurableWebhookInboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanEnv(env.WEBHOOK_DURABLE_INBOX_ENABLED);
}

/**
 * Liga o consumo dos eventos pendentes. Default false.
 * Na etapa 1 não existe worker; a flag apenas declara a intenção e é exposta
 * nos logs para conferência antes da etapa 2.
 */
export function isDurableWebhookInboxProcessingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseBooleanEnv(env.WEBHOOK_DURABLE_INBOX_PROCESSING_ENABLED);
}

/**
 * Teto do corpo aceito na ingestão.
 *
 * Dimensionado pelo maior payload legítimo dos provedores, não por conforto de
 * memória. A Evolution é configurada com base64:true, então o arquivo vem
 * embutido no JSON: o limite do WhatsApp para documento é 100 MB, que em
 * base64 vira ~134 MB, mais o envelope JSON. 160 MiB cobre isso com folga.
 *
 * O consumo de memória NÃO é controlado por este teto e sim pelo orçamento de
 * bytes simultâneos (WEBHOOK_INBOX_MEMORY_BUDGET_BYTES).
 */
export const WEBHOOK_INBOX_DEFAULT_MAX_PAYLOAD_BYTES = 160 * 1024 * 1024;

/**
 * Mídia grande em conexão lenta leva minutos. O corte por inatividade mata
 * conexão travada sem punir upload que está progredindo; o teto absoluto
 * existe só contra slow-loris.
 */
export const WEBHOOK_INBOX_DEFAULT_BODY_STALL_TIMEOUT_MS = 15_000;
export const WEBHOOK_INBOX_DEFAULT_BODY_TIMEOUT_MS = 120_000;

/** Bytes de corpo que podem estar em memória ao mesmo tempo. */
export const WEBHOOK_INBOX_DEFAULT_MEMORY_BUDGET_BYTES = 192 * 1024 * 1024;
export const WEBHOOK_INBOX_DEFAULT_MEMORY_ACQUIRE_TIMEOUT_MS = 10_000;

export const WEBHOOK_INBOX_RETRY_AFTER_SECONDS = 5;

export function readWebhookInboxMaxPayloadBytes(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInt(
    env.WEBHOOK_INBOX_MAX_PAYLOAD_BYTES,
    WEBHOOK_INBOX_DEFAULT_MAX_PAYLOAD_BYTES,
  );
}

/** Tempo máximo sem receber nenhum byte novo. */
export function readWebhookInboxBodyStallTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInt(
    env.WEBHOOK_INBOX_BODY_STALL_TIMEOUT_MS,
    WEBHOOK_INBOX_DEFAULT_BODY_STALL_TIMEOUT_MS,
  );
}

/** Teto absoluto da leitura do corpo, mesmo com progresso contínuo. */
export function readWebhookInboxBodyTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInt(
    env.WEBHOOK_INBOX_BODY_TIMEOUT_MS,
    WEBHOOK_INBOX_DEFAULT_BODY_TIMEOUT_MS,
  );
}

export function readWebhookInboxMemoryAcquireTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parsePositiveInt(
    env.WEBHOOK_INBOX_MEMORY_ACQUIRE_TIMEOUT_MS,
    WEBHOOK_INBOX_DEFAULT_MEMORY_ACQUIRE_TIMEOUT_MS,
  );
}

/**
 * Orçamento efetivo de memória.
 * Nunca menor que o teto de payload: assim um evento do tamanho máximo sempre
 * consegue entrar (sozinho), em vez de ficar esperando para sempre.
 */
export function resolveWebhookInboxMemoryBudgetBytes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = parsePositiveInt(
    env.WEBHOOK_INBOX_MEMORY_BUDGET_BYTES,
    WEBHOOK_INBOX_DEFAULT_MEMORY_BUDGET_BYTES,
  );
  return Math.max(configured, readWebhookInboxMaxPayloadBytes(env));
}

/**
 * Bytes a reservar antes de ler. Usa Content-Length quando disponível para não
 * bloquear o orçamento inteiro por causa de um webhook de texto.
 */
export function resolveReservationBytes(
  contentLengthHeader: string | null | undefined,
  maxBytes: number,
): number {
  const raw = (contentLengthHeader ?? "").trim();
  if (!raw) return maxBytes;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return maxBytes;
  return Math.min(maxBytes, Math.ceil(n));
}

// --------------------------------------------------------------------------
// Headers
// --------------------------------------------------------------------------

/** Valor nunca é gravado; apenas a presença vira booleano. */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "apikey",
  "api-key",
  "x-api-key",
  "x-webhook-secret",
  "x-auth-token",
  "token",
  "x-hub-signature",
  "x-hub-signature-256",
]);

/** Allowlist: qualquer header fora desta lista é descartado. */
const STORABLE_HEADERS = new Set([
  "content-type",
  "content-length",
  "user-agent",
  "accept",
  "host",
  "x-forwarded-for",
  "x-real-ip",
  "x-request-id",
]);

const HEADER_VALUE_MAX_LENGTH = 300;

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function headerEntries(source: HeaderSource): Array<[string, string]> {
  if (typeof (source as Headers).forEach === "function" && !Array.isArray(source)) {
    const out: Array<[string, string]> = [];
    (source as Headers).forEach((value, key) => out.push([key, value]));
    return out;
  }
  return Object.entries(source as Record<string, string | string[] | undefined>)
    .filter(([, v]) => v != null)
    .map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)]);
}

/**
 * Reduz os headers ao mínimo auditável. Segredos viram `has_<nome>: true`,
 * nunca o valor.
 */
export function sanitizeWebhookHeaders(source: HeaderSource): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [rawKey, rawValue] of headerEntries(source)) {
    const key = rawKey.toLowerCase();
    if (SENSITIVE_HEADERS.has(key)) {
      out[`has_${key.replace(/-/g, "_")}`] = true;
      continue;
    }
    if (STORABLE_HEADERS.has(key)) {
      out[key] = String(rawValue).slice(0, HEADER_VALUE_MAX_LENGTH);
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Identificadores e chave de deduplicação
// --------------------------------------------------------------------------

export type WebhookIdentifiers = {
  eventType: string | null;
  instanceName: string | null;
  externalEventId: string | null;
  externalMessageId: string | null;
  externalIds: string[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Evolution: instância + event + key.id de cada mensagem do lote. */
export function extractEvolutionIdentifiers(payload: unknown): WebhookIdentifiers {
  const root = asRecord(payload);
  const data = root.data;
  const dataRecord = asRecord(Array.isArray(data) ? data[0] : data);

  const eventType = asNonEmptyString(root.event);
  const instanceName =
    asNonEmptyString(root.instance) ?? asNonEmptyString(dataRecord.instance) ?? null;

  const items = Array.isArray(data) ? data : data != null ? [data] : [];
  const externalIds: string[] = [];
  for (const item of items) {
    const id = asNonEmptyString(asRecord(asRecord(item).key).id);
    if (id) externalIds.push(id);
  }

  return {
    eventType,
    instanceName,
    externalEventId: null,
    externalMessageId: externalIds[0] ?? null,
    externalIds,
  };
}

/**
 * Meta: phone_number_id como instância, `field` como evento.
 * Status compartilham o id da mensagem, então entram na chave como
 * `<id>#<status>` para não colidirem entre si.
 */
export function extractMetaIdentifiers(payload: unknown): WebhookIdentifiers {
  const root = asRecord(payload);
  const entries = Array.isArray(root.entry) ? root.entry : [];

  const externalIds: string[] = [];
  const fields: string[] = [];
  let instanceName: string | null = null;
  let externalEventId: string | null = null;
  let firstMessageId: string | null = null;

  for (const rawEntry of entries) {
    const entry = asRecord(rawEntry);
    externalEventId = externalEventId ?? asNonEmptyString(entry.id);

    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const rawChange of changes) {
      const change = asRecord(rawChange);
      const field = asNonEmptyString(change.field);
      if (field) fields.push(field);

      const value = asRecord(change.value);
      instanceName = instanceName ?? asNonEmptyString(asRecord(value.metadata).phone_number_id);

      for (const rawMessage of Array.isArray(value.messages) ? value.messages : []) {
        const id = asNonEmptyString(asRecord(rawMessage).id);
        if (!id) continue;
        externalIds.push(id);
        firstMessageId = firstMessageId ?? id;
      }

      for (const rawStatus of Array.isArray(value.statuses) ? value.statuses : []) {
        const status = asRecord(rawStatus);
        const id = asNonEmptyString(status.id);
        if (!id) continue;
        externalIds.push(`${id}#${asNonEmptyString(status.status) ?? "unknown"}`);
        firstMessageId = firstMessageId ?? id;
      }
    }
  }

  return {
    eventType: fields.length > 0 ? Array.from(new Set(fields)).join(",") : null,
    instanceName,
    externalEventId,
    externalMessageId: firstMessageId,
    externalIds,
  };
}

export function extractWebhookIdentifiers(
  provider: WebhookProvider,
  payload: unknown,
): WebhookIdentifiers {
  return provider === "meta"
    ? extractMetaIdentifiers(payload)
    : extractEvolutionIdentifiers(payload);
}

export const DEDUPLICATION_KEY_MAX_LENGTH = 200;

/**
 * Chave estável de deduplicação.
 * Com ids externos, a chave é derivada deles (reentrega da Evolution/Meta cai
 * na mesma linha). Sem ids, cai no hash do corpo bruto.
 */
export function buildDeduplicationKey(params: {
  provider: WebhookProvider;
  eventType: string | null;
  instanceName: string | null;
  externalIds: string[];
  rawBody: string;
}): string {
  const scope = `${params.provider}:${params.instanceName ?? "-"}:${params.eventType ?? "-"}`;
  const ids = params.externalIds.filter((id) => !!id && id.trim() !== "").sort();
  const suffix = ids.length > 0 ? ids.join(",") : `sha256:${sha256Hex(params.rawBody)}`;
  const key = `${scope}:${suffix}`;
  if (key.length <= DEDUPLICATION_KEY_MAX_LENGTH) return key;
  return `${scope}:sha256:${sha256Hex(suffix)}`;
}

// --------------------------------------------------------------------------
// Leitura do corpo com limite de tamanho e timeout
// --------------------------------------------------------------------------

export type BodyReadFailureReason =
  | "too_large"
  | "stall_timeout"
  | "total_timeout"
  | "read_error";

export type BodyReadResult =
  | { ok: true; text: string; sizeBytes: number }
  | { ok: false; reason: BodyReadFailureReason; sizeBytes: number };

type ReadableRequest = {
  body?: { getReader?: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel: () => Promise<unknown> } } | null;
  text: () => Promise<string>;
};

type ReaderState = {
  reader?: { cancel: () => Promise<unknown> };
  sizeBytes: number;
  onProgress?: () => void;
  onStreamUnavailable?: () => void;
};

async function readBodyStream(
  request: ReadableRequest,
  maxBytes: number,
  state: ReaderState,
): Promise<BodyReadResult> {
  const stream = request.body ?? null;
  if (!stream || typeof stream.getReader !== "function") {
    // Sem stream não há como observar progresso: só o teto absoluto vale.
    state.onStreamUnavailable?.();
    try {
      const text = await request.text();
      const sizeBytes = Buffer.byteLength(text, "utf8");
      if (sizeBytes > maxBytes) return { ok: false, reason: "too_large", sizeBytes };
      return { ok: true, text, sizeBytes };
    } catch {
      return { ok: false, reason: "read_error", sizeBytes: 0 };
    }
  }

  const reader = stream.getReader();
  state.reader = reader;
  const chunks: Buffer[] = [];
  let sizeBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      sizeBytes += value.byteLength;
      state.sizeBytes = sizeBytes;
      if (sizeBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large", sizeBytes };
      }
      chunks.push(Buffer.from(value));
      state.onProgress?.();
    }
  } catch {
    return { ok: false, reason: "read_error", sizeBytes };
  }

  return { ok: true, text: Buffer.concat(chunks).toString("utf8"), sizeBytes };
}

/**
 * Lê o corpo respeitando o teto de bytes e dois prazos distintos:
 * inatividade (nenhum byte novo) e duração total. Upload grande que continua
 * progredindo não é interrompido; conexão travada é. Nunca fica pendurado: em
 * qualquer corte o reader é cancelado.
 */
export async function readRequestBodyWithLimit(
  request: ReadableRequest,
  options: { maxBytes: number; stallTimeoutMs: number; totalTimeoutMs: number },
): Promise<BodyReadResult> {
  const totalTimeoutMs = Math.max(1, options.totalTimeoutMs);
  // Inatividade nunca é maior que o teto absoluto.
  const stallTimeoutMs = Math.min(Math.max(1, options.stallTimeoutMs), totalTimeoutMs);

  const state: ReaderState = { sizeBytes: 0 };
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  const timeout = new Promise<BodyReadResult>((resolve) => {
    const fail = (reason: BodyReadFailureReason) => {
      if (settled) return;
      settled = true;
      void state.reader?.cancel().catch(() => undefined);
      resolve({ ok: false, reason, sizeBytes: state.sizeBytes });
    };

    const armStall = () => {
      if (settled) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => fail("stall_timeout"), stallTimeoutMs);
    };

    state.onProgress = armStall;
    state.onStreamUnavailable = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = undefined;
    };
    armStall();
    totalTimer = setTimeout(() => fail("total_timeout"), totalTimeoutMs);
  });

  const read = readBodyStream(request, options.maxBytes, state).then((result) => {
    settled = true;
    return result;
  });

  try {
    return await Promise.race([read, timeout]);
  } finally {
    settled = true;
    if (stallTimer) clearTimeout(stallTimer);
    if (totalTimer) clearTimeout(totalTimer);
  }
}

/** Status HTTP para cada falha de leitura do corpo. */
export function bodyReadFailureStatus(reason: BodyReadFailureReason): number {
  if (reason === "too_large") return 413;
  if (reason === "stall_timeout" || reason === "total_timeout") return 408;
  return 400;
}
