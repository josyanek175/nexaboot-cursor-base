/**
 * Persistência da inbox durável de webhooks (ETAPA 1 — só ingestão).
 *
 * Regra central: o HTTP 200 só pode ser devolvido depois do COMMIT do INSERT
 * em public.webhook_inbox. Nada de contato, conversa, mensagem, mídia ou
 * campanha acontece aqui.
 *
 * O cliente SQL é injetado (mesmo padrão do campaign worker), então este
 * módulo é testável sem banco e não amarra o pool do web.
 */

import type { PgSql } from "@/lib/pg-types";
import {
  isWebhookInboxAcquireTimeout,
  readWebhookInboxStatementTimeoutMs,
  withWebhookInboxConnectionSlot,
} from "@/lib/pg-webhook-inbox.server";
import {
  createByteBudget,
  isWebhookInboxBudgetTimeout,
  type ByteBudget,
} from "@/lib/webhook-inbox-budget";
import {
  bodyReadFailureStatus,
  buildDeduplicationKey,
  extractWebhookIdentifiers,
  readRequestBodyWithLimit,
  readWebhookInboxBodyStallTimeoutMs,
  readWebhookInboxBodyTimeoutMs,
  readWebhookInboxMaxPayloadBytes,
  readWebhookInboxMemoryAcquireTimeoutMs,
  resolveReservationBytes,
  resolveWebhookInboxMemoryBudgetBytes,
  sanitizeWebhookHeaders,
  WEBHOOK_INBOX_RETRY_AFTER_SECONDS,
  type WebhookIdentifiers,
  type WebhookProvider,
} from "@/lib/webhook-inbox-core";
import {
  buildOutboxMessagePayload,
  buildOutboxRoutingKey,
  readWebhookOutboxExchange,
} from "@/lib/webhook-outbox-core";
import { ensureOutboxForInbox } from "@/lib/webhook-outbox.server";

/** `received_at` chega como Date do postgres.js e como string dos fakes. */
function toIsoString(value: string | Date | null): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

export type PersistWebhookEventResult = {
  status: "persisted" | "duplicate";
  inboxId: string | null;
  /** Estado da mensagem de saída correspondente, sempre confirmado no COMMIT. */
  outboxId: string | null;
  outboxCreated: boolean;
  persistenceMs: number;
};

export type PersistWebhookEventParams = {
  sql: PgSql;
  provider: WebhookProvider;
  eventType: string | null;
  companyId: string | null;
  channelId: string | null;
  instanceName: string | null;
  externalEventId: string | null;
  externalMessageId: string | null;
  deduplicationKey: string;
  conversationKey: string | null;
  /** Corpo bruto já validado como JSON. Inserido via `::jsonb`, sem re-serializar. */
  rawPayload: string;
  requestHeaders: Record<string, string | boolean>;
  /** Destino da mensagem de saída, gravada na mesma transação da inbox. */
  exchangeName: string;
  routingKey: string;
  statementTimeoutMs?: number;
  /**
   * Reserva de conexão. Default: semáforo do pool dedicado da inbox, que
   * estoura em vez de esperar para sempre por um slot.
   */
  acquireSlot?: <T>(fn: () => Promise<T>) => Promise<T>;
};

/**
 * Grava inbox + outbox na MESMA transação, com timeout de aquisição de conexão
 * e statement_timeout próprios. Resolve somente após o COMMIT dos dois
 * registros — nunca existe evento na inbox sem mensagem de saída registrada.
 */
export async function persistWebhookEvent(
  params: PersistWebhookEventParams,
): Promise<PersistWebhookEventResult> {
  const statementTimeoutMs = params.statementTimeoutMs ?? readWebhookInboxStatementTimeoutMs();
  const acquireSlot =
    params.acquireSlot ?? (<T>(fn: () => Promise<T>) => withWebhookInboxConnectionSlot(fn));
  const startedAt = Date.now();

  const result = await acquireSlot(async () => params.sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(statementTimeoutMs))}`);

    const inserted = await tx<{ id: string; received_at: string | Date }[]>`
      INSERT INTO public.webhook_inbox (
        provider, event_type, company_id, channel_id, instance_name,
        external_event_id, external_message_id, deduplication_key,
        payload, request_headers, status
      ) VALUES (
        ${params.provider},
        ${params.eventType},
        ${params.companyId}::uuid,
        ${params.channelId}::uuid,
        ${params.instanceName},
        ${params.externalEventId},
        ${params.externalMessageId},
        ${params.deduplicationKey},
        ${params.rawPayload}::jsonb,
        ${JSON.stringify(params.requestHeaders)}::jsonb,
        'pending'
      )
      ON CONFLICT (provider, deduplication_key) DO NOTHING
      RETURNING id, received_at
    `;

    let status: "persisted" | "duplicate" = "persisted";
    let inboxId = inserted[0]?.id ?? null;
    let receivedAt = inserted[0]?.received_at ?? null;

    if (!inboxId) {
      status = "duplicate";
      const existing = await tx<{ id: string; received_at: string | Date }[]>`
        SELECT id, received_at FROM public.webhook_inbox
        WHERE provider = ${params.provider}
          AND deduplication_key = ${params.deduplicationKey}
        LIMIT 1
      `;
      inboxId = existing[0]?.id ?? null;
      receivedAt = existing[0]?.received_at ?? null;
    }

    // Conflito sem linha visível: outra transação está inserindo o mesmo
    // evento e ainda não commitou. Não dá para garantir a outbox agora, então
    // a requisição falha e o provedor reenvia — nunca 200 sem estado durável.
    if (!inboxId) {
      throw new Error("inbox_row_not_visible");
    }

    const outbox = await ensureOutboxForInbox(tx, {
      inboxId,
      exchangeName: params.exchangeName,
      routingKey: params.routingKey,
      messagePayload: buildOutboxMessagePayload({
        inboxId,
        provider: params.provider,
        identifiers: {
          eventType: params.eventType,
          instanceName: params.instanceName,
          externalEventId: params.externalEventId,
          externalMessageId: params.externalMessageId,
          conversationKey: params.conversationKey,
        },
        companyId: params.companyId,
        channelId: params.channelId,
        receivedAt: toIsoString(receivedAt),
      }),
    });

    return { status, inboxId, outboxId: outbox.outboxId, outboxCreated: outbox.created };
  }));

  return { ...result, persistenceMs: Date.now() - startedAt };
}

// --------------------------------------------------------------------------
// Orquestração + observabilidade
// --------------------------------------------------------------------------

export type WebhookIngestOutcome =
  | {
      status: "persisted" | "duplicate";
      inboxId: string | null;
      outboxId: string | null;
      deduplicationKey: string;
      persistenceMs: number;
      identifiers: WebhookIdentifiers;
    }
  | {
      status: "invalid_json";
      error: string;
    }
  | {
      status: "failed";
      error: string;
      deduplicationKey: string | null;
      persistenceMs: number;
      identifiers: WebhookIdentifiers | null;
    };

type LogFn = (tag: string, data: Record<string, unknown>) => void;

function defaultLog(tag: string, data: Record<string, unknown>): void {
  console.log(`[${tag}]`, data);
}

function defaultLogError(tag: string, data: Record<string, unknown>): void {
  console.error(`[${tag}]`, data);
}

/** Mensagem de erro reduzida: nunca propaga corpo, token ou URL de banco. */
function maskPersistError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/postgres(ql)?:\/\/[^\s]+/gi, "[redacted-dsn]").slice(0, 300);
}

export type IngestWebhookEventParams = {
  sql: PgSql;
  provider: WebhookProvider;
  rawBody: string;
  payloadSizeBytes: number;
  headers: Headers | Record<string, string | string[] | undefined>;
  /** Ingestão não resolve canal/empresa; a etapa 2 preenche isso. */
  companyId?: string | null;
  channelId?: string | null;
  statementTimeoutMs?: number;
  acquireSlot?: <T>(fn: () => Promise<T>) => Promise<T>;
  env?: NodeJS.ProcessEnv;
  log?: LogFn;
  logError?: LogFn;
};

/**
 * Fluxo completo de ingestão: extrai identificadores, monta a chave estável,
 * persiste e emite os logs estruturados. Não lança — devolve o desfecho.
 */
export async function ingestWebhookEvent(
  params: IngestWebhookEventParams,
): Promise<WebhookIngestOutcome> {
  const log = params.log ?? defaultLog;
  const logError = params.logError ?? defaultLogError;

  let payload: unknown;
  try {
    payload = JSON.parse(params.rawBody);
  } catch {
    logError("WEBHOOK_INBOX_PERSIST_FAILED", {
      provider: params.provider,
      reason: "invalid_json",
      payloadSizeBytes: params.payloadSizeBytes,
    });
    return { status: "invalid_json", error: "invalid_json" };
  }

  const identifiers = extractWebhookIdentifiers(params.provider, payload);
  const deduplicationKey = buildDeduplicationKey({
    provider: params.provider,
    eventType: identifiers.eventType,
    instanceName: identifiers.instanceName,
    externalIds: identifiers.externalIds,
    rawBody: params.rawBody,
  });

  const routingKey = buildOutboxRoutingKey(params.provider, identifiers.eventType);
  const exchangeName = readWebhookOutboxExchange(params.env ?? process.env);

  const baseLog = {
    provider: params.provider,
    instanceName: identifiers.instanceName,
    channelId: params.channelId ?? null,
    eventType: identifiers.eventType,
    externalMessageId: identifiers.externalMessageId,
    payloadSizeBytes: params.payloadSizeBytes,
  };

  log("WEBHOOK_INBOX_RECEIVED", baseLog);

  const startedAt = Date.now();
  try {
    const result = await persistWebhookEvent({
      sql: params.sql,
      provider: params.provider,
      eventType: identifiers.eventType,
      companyId: params.companyId ?? null,
      channelId: params.channelId ?? null,
      instanceName: identifiers.instanceName,
      externalEventId: identifiers.externalEventId,
      externalMessageId: identifiers.externalMessageId,
      deduplicationKey,
      conversationKey: identifiers.conversationKey,
      rawPayload: params.rawBody,
      requestHeaders: sanitizeWebhookHeaders(params.headers),
      exchangeName,
      routingKey,
      statementTimeoutMs: params.statementTimeoutMs,
      acquireSlot: params.acquireSlot,
    });

    const tag = result.status === "persisted" ? "WEBHOOK_INBOX_PERSISTED" : "WEBHOOK_INBOX_DUPLICATE";
    log(tag, {
      inboxId: result.inboxId,
      ...baseLog,
      persistenceMs: result.persistenceMs,
    });

    // Confirmado no mesmo COMMIT da inbox. `repaired` é evento duplicado cuja
    // outbox faltava — típico de evento gravado antes desta etapa existir.
    log(result.outboxCreated ? "WEBHOOK_OUTBOX_CREATED" : "WEBHOOK_OUTBOX_DUPLICATE", {
      inboxId: result.inboxId,
      outboxId: result.outboxId,
      provider: params.provider,
      eventType: identifiers.eventType,
      exchange: exchangeName,
      routingKey,
      repaired: result.outboxCreated && result.status === "duplicate",
    });

    return {
      status: result.status,
      inboxId: result.inboxId,
      outboxId: result.outboxId,
      deduplicationKey,
      persistenceMs: result.persistenceMs,
      identifiers,
    };
  } catch (e) {
    const error = maskPersistError(e);
    const persistenceMs = Date.now() - startedAt;
    logError("WEBHOOK_INBOX_PERSIST_FAILED", {
      ...baseLog,
      persistenceMs,
      reason: isWebhookInboxAcquireTimeout(e) ? "pool_acquire_timeout" : "persist_error",
      error,
    });
    return { status: "failed", error, deduplicationKey, persistenceMs, identifiers };
  }
}

/** 503 padrão quando a persistência falha — nunca 200 sem COMMIT. */
export function webhookInboxUnavailableResponse(
  error = "webhook_inbox_unavailable",
): Response {
  return Response.json(
    { ok: false, error, retryable: true },
    { status: 503, headers: { "Retry-After": String(WEBHOOK_INBOX_RETRY_AFTER_SECONDS) } },
  );
}

// --------------------------------------------------------------------------
// Leitura do corpo com orçamento de memória
// --------------------------------------------------------------------------

let _budget: ByteBudget | null = null;

/** Orçamento global de bytes de corpo simultâneos deste processo. */
export function getWebhookInboxBudget(env: NodeJS.ProcessEnv = process.env): ByteBudget {
  const total = resolveWebhookInboxMemoryBudgetBytes(env);
  if (!_budget || _budget.totalBytes !== total) _budget = createByteBudget(total);
  return _budget;
}

/** Só testes. */
export function __resetWebhookInboxBudgetForTests(): void {
  _budget = null;
}

export type WebhookBodyReadOutcome =
  | { ok: true; text: string; sizeBytes: number; release: () => void }
  | { ok: false; response: Response };

/**
 * Reserva memória, lê o corpo e devolve o liberador da reserva.
 *
 * Nenhuma rejeição é silenciosa: excesso de tamanho e corte por tempo geram
 * log de erro dedicado com tamanho e limite aplicados. Falta de orçamento vira
 * 503 com Retry-After (o provedor reenvia), nunca descarte.
 */
export async function readWebhookBodyForInbox(
  request: Request,
  options: {
    provider: WebhookProvider;
    env?: NodeJS.ProcessEnv;
    budget?: ByteBudget;
    logError?: LogFn;
  },
): Promise<WebhookBodyReadOutcome> {
  const env = options.env ?? process.env;
  const logError = options.logError ?? defaultLogError;
  const budget = options.budget ?? getWebhookInboxBudget(env);
  const maxBytes = readWebhookInboxMaxPayloadBytes(env);

  const contentLength = request.headers.get("content-length");
  const declaredBytes = Number((contentLength ?? "").trim());

  // Corta antes de alocar qualquer byte quando o próprio cliente já declara
  // um corpo acima do teto.
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    logError("WEBHOOK_INBOX_PAYLOAD_REJECTED", {
      provider: options.provider,
      reason: "too_large",
      declaredBytes,
      maxPayloadBytes: maxBytes,
    });
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: "too_large", maxPayloadBytes: maxBytes },
        { status: 413 },
      ),
    };
  }

  const reservationBytes = resolveReservationBytes(contentLength, maxBytes);

  let release: () => void;
  try {
    release = await budget.acquire(
      reservationBytes,
      readWebhookInboxMemoryAcquireTimeoutMs(env),
    );
  } catch (e) {
    if (!isWebhookInboxBudgetTimeout(e)) throw e;
    logError("WEBHOOK_INBOX_THROTTLED", {
      provider: options.provider,
      reason: "memory_budget_timeout",
      reservationBytes,
      budgetBytes: budget.totalBytes,
      ...budget.metrics(),
    });
    return { ok: false, response: webhookInboxUnavailableResponse("webhook_inbox_busy") };
  }

  let body;
  try {
    body = await readRequestBodyWithLimit(request, {
      maxBytes: reservationBytes,
      stallTimeoutMs: readWebhookInboxBodyStallTimeoutMs(env),
      totalTimeoutMs: readWebhookInboxBodyTimeoutMs(env),
    });
  } catch (e) {
    release();
    throw e;
  }

  if (!body.ok) {
    release();
    logError("WEBHOOK_INBOX_PAYLOAD_REJECTED", {
      provider: options.provider,
      reason: body.reason,
      payloadSizeBytes: body.sizeBytes,
      maxPayloadBytes: maxBytes,
      reservationBytes,
    });
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: body.reason },
        { status: bodyReadFailureStatus(body.reason) },
      ),
    };
  }

  return { ok: true, text: body.text, sizeBytes: body.sizeBytes, release };
}

// --------------------------------------------------------------------------
// Pipeline HTTP compartilhado pelos provedores
// --------------------------------------------------------------------------

export type IngestWebhookRequestParams = {
  sql: PgSql;
  provider: WebhookProvider;
  request: Request;
  /** Corpo já lido (Meta precisa do bruto para conferir a assinatura). */
  rawBody?: string;
  payloadSizeBytes?: number;
  /** Libera a reserva de memória do corpo lido pelo chamador. */
  releaseBody?: () => void;
  acquireSlot?: <T>(fn: () => Promise<T>) => Promise<T>;
  budget?: ByteBudget;
  /** Resposta de sucesso do provedor. Só é montada depois do COMMIT. */
  okResponse?: (outcome: {
    status: "persisted" | "duplicate";
    inboxId: string | null;
  }) => Response;
  env?: NodeJS.ProcessEnv;
  log?: LogFn;
  logError?: LogFn;
};

function defaultOkResponse(outcome: {
  status: "persisted" | "duplicate";
  inboxId: string | null;
}): Response {
  return Response.json({
    ok: true,
    inboxId: outcome.inboxId,
    duplicate: outcome.status === "duplicate",
  });
}

/**
 * Lê o corpo (quando ainda não lido), persiste e traduz o desfecho em resposta.
 * Só devolve 2xx depois do COMMIT; qualquer falha de persistência vira 503.
 */
export async function ingestWebhookRequestToInbox(
  params: IngestWebhookRequestParams,
): Promise<Response> {
  const env = params.env ?? process.env;

  let rawBody = params.rawBody;
  let payloadSizeBytes = params.payloadSizeBytes ?? 0;
  let releaseBody = params.releaseBody ?? (() => undefined);

  if (rawBody === undefined) {
    const body = await readWebhookBodyForInbox(params.request, {
      provider: params.provider,
      env,
      budget: params.budget,
      logError: params.logError,
    });
    if (!body.ok) return body.response;

    rawBody = body.text;
    payloadSizeBytes = body.sizeBytes;
    releaseBody = body.release;
  }

  try {
    const outcome = await ingestWebhookEvent({
      sql: params.sql,
      provider: params.provider,
      rawBody,
      payloadSizeBytes,
      headers: params.request.headers,
      statementTimeoutMs: readWebhookInboxStatementTimeoutMs(env),
      acquireSlot: params.acquireSlot,
      env,
      log: params.log,
      logError: params.logError,
    });

    if (outcome.status === "invalid_json") {
      return Response.json({ ok: false, error: "invalid_payload" }, { status: 400 });
    }
    if (outcome.status === "failed") {
      return webhookInboxUnavailableResponse();
    }

    const buildOk = params.okResponse ?? defaultOkResponse;
    return buildOk({ status: outcome.status, inboxId: outcome.inboxId });
  } finally {
    // A reserva só cai depois do COMMIT: o pico de memória contabilizado
    // cobre toda a vida útil do corpo.
    releaseBody();
  }
}
