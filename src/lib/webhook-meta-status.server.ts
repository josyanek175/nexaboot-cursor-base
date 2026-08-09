/**
 * Processamento idempotente de status Meta (sent / delivered / read / failed).
 *
 * Progressão monotônica do status da mensagem outbound:
 *   pending → sent → delivered → read
 * `failed` mapeia para `error` e não regride um read já gravado.
 *
 * Se o status chegar antes da mensagem existir, lança erro temporário para a
 * inbox voltar a retry — nunca marca processed silenciosamente.
 */

import type { SqlExecutor } from "@/lib/pg-types";
import {
  PermanentWebhookProcessingError,
  TemporaryWebhookProcessingError,
} from "@/lib/webhook-message-core";

export type MetaDeliveryStatus = "sent" | "delivered" | "read" | "failed";

const KNOWN_STATUSES = new Set<string>(["sent", "delivered", "read", "failed"]);

/** Ordem de avanço. Maior = mais avançado. */
const STATUS_RANK: Record<string, number> = {
  pending: 0,
  received: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  // error/failed não entram na progressão normal
};

export type MetaStatusUpdate = {
  externalMessageId: string;
  status: MetaDeliveryStatus;
  timestamp: string | null;
  recipientId: string | null;
  /** Código/motivo sanitizados — sem tokens nem payload bruto. */
  errorCode: string | null;
  errorTitle: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Extrai status do envelope Meta. Ignora nós sem id/status. */
export function extractMetaStatusUpdates(payload: unknown): MetaStatusUpdate[] {
  const root = asRecord(payload);
  const body = Array.isArray(root.entry) ? root : asRecord(root.body);
  const entries = Array.isArray(body.entry) ? body.entry : [];
  const out: MetaStatusUpdate[] = [];

  for (const rawEntry of entries) {
    const entry = asRecord(rawEntry);
    for (const rawChange of Array.isArray(entry.changes) ? entry.changes : []) {
      const change = asRecord(rawChange);
      const value = asRecord(change.value);
      for (const rawStatus of Array.isArray(value.statuses) ? value.statuses : []) {
        const statusNode = asRecord(rawStatus);
        const externalMessageId = asString(statusNode.id);
        const statusRaw = asString(statusNode.status)?.toLowerCase() ?? null;
        if (!externalMessageId || !statusRaw) continue;

        const errors = Array.isArray(statusNode.errors) ? statusNode.errors : [];
        const firstError = asRecord(errors[0]);
        const errorCode =
          firstError.code != null ? String(firstError.code).slice(0, 64) : null;
        // title/message da Meta podem carregar texto do usuário — corta curto.
        const errorTitle = asString(firstError.title)?.slice(0, 200) ?? null;

        out.push({
          externalMessageId,
          status: statusRaw as MetaDeliveryStatus,
          timestamp: statusNode.timestamp != null ? String(statusNode.timestamp) : null,
          recipientId: asString(statusNode.recipient_id),
          errorCode,
          errorTitle,
        });
      }
    }
  }

  return out;
}

export function isKnownMetaDeliveryStatus(status: string): status is MetaDeliveryStatus {
  return KNOWN_STATUSES.has(status);
}

/**
 * Decide o novo status sem regredir.
 * Retorna null quando o UPDATE seria no-op (já no mesmo nível ou além).
 */
export function nextMessageStatus(
  current: string | null | undefined,
  incoming: MetaDeliveryStatus,
): string | null {
  if (incoming === "failed") {
    // Não regride um read/delivered já confirmado para o cliente.
    if (current === "read" || current === "delivered") return null;
    return "error";
  }

  const currentRank = STATUS_RANK[current ?? ""] ?? -1;
  const incomingRank = STATUS_RANK[incoming] ?? -1;
  if (incomingRank <= currentRank) return null;
  return incoming;
}

export type ApplyMetaStatusResult = {
  externalMessageId: string;
  outcome: "updated" | "noop" | "message_missing";
  previousStatus: string | null;
  newStatus: string | null;
};

/**
 * Aplica um status. Lança Temporary se a mensagem ainda não existe.
 */
export async function applyMetaStatusUpdate(
  sql: SqlExecutor,
  update: MetaStatusUpdate,
): Promise<ApplyMetaStatusResult> {
  if (!isKnownMetaDeliveryStatus(update.status)) {
    throw new PermanentWebhookProcessingError(
      "unknown_meta_status",
      `Status Meta desconhecido: ${update.status}`,
    );
  }

  const rows = await sql<{ id: string; status: string | null }[]>`
    SELECT id, status FROM public.messages
    WHERE external_message_id = ${update.externalMessageId}
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const message = rows[0];
  if (!message) {
    return {
      externalMessageId: update.externalMessageId,
      outcome: "message_missing",
      previousStatus: null,
      newStatus: null,
    };
  }

  const next = nextMessageStatus(message.status, update.status);
  if (!next) {
    return {
      externalMessageId: update.externalMessageId,
      outcome: "noop",
      previousStatus: message.status,
      newStatus: message.status,
    };
  }

  if (next === "error") {
    const safeError = JSON.stringify({
      source: "meta_status",
      code: update.errorCode,
      title: update.errorTitle,
    }).slice(0, 500);
    await sql`
      UPDATE public.messages
      SET status = 'error',
          media_error = COALESCE(media_error, ${safeError})
      WHERE id = ${message.id}::uuid
        AND status IS DISTINCT FROM 'read'
        AND status IS DISTINCT FROM 'delivered'
    `;
  } else {
    await sql`
      UPDATE public.messages
      SET status = ${next}
      WHERE id = ${message.id}::uuid
    `;
  }

  return {
    externalMessageId: update.externalMessageId,
    outcome: "updated",
    previousStatus: message.status,
    newStatus: next,
  };
}

export type ProcessMetaStatusesResult = {
  applied: number;
  noop: number;
  missing: string[];
};

/**
 * Processa todos os status de um evento. Se algum apontar para mensagem
 * inexistente, lança Temporary para a inbox ir a retry (status chegou cedo).
 * Status desconhecido lança Permanent.
 */
export async function processMetaStatusUpdates(params: {
  sql: SqlExecutor;
  payload: unknown;
  log?: (event: string, data?: Record<string, unknown>) => void;
}): Promise<ProcessMetaStatusesResult> {
  const log = params.log ?? ((e, d) => console.log(`[${e}]`, d ?? {}));
  const updates = extractMetaStatusUpdates(params.payload);

  if (updates.length === 0) {
    return { applied: 0, noop: 0, missing: [] };
  }

  // Valida desconhecidos antes de aplicar qualquer um.
  for (const update of updates) {
    if (!isKnownMetaDeliveryStatus(update.status)) {
      throw new PermanentWebhookProcessingError(
        "unknown_meta_status",
        `Status Meta desconhecido: ${String(update.status)}`,
      );
    }
  }

  let applied = 0;
  let noop = 0;
  const missing: string[] = [];

  for (const update of updates) {
    const result = await applyMetaStatusUpdate(params.sql, update);
    if (result.outcome === "updated") {
      applied += 1;
      log("META_STATUS_UPDATED", {
        externalMessageId: update.externalMessageId,
        from: result.previousStatus,
        to: result.newStatus,
      });
    } else if (result.outcome === "noop") {
      noop += 1;
      log("META_STATUS_NOOP", {
        externalMessageId: update.externalMessageId,
        status: update.status,
        current: result.previousStatus,
      });
    } else {
      missing.push(update.externalMessageId);
    }
  }

  if (missing.length > 0) {
    throw new TemporaryWebhookProcessingError(
      "status_before_message",
      `Status Meta chegou antes da mensagem: ${missing.slice(0, 5).join(",")}`,
    );
  }

  return { applied, noop, missing };
}

/**
 * Classifica o conteúdo de um payload Meta para o worker decidir o caminho.
 * Nunca retorna "vazio processável" para status ou campos desconhecidos.
 */
export function classifyMetaInboxPayload(payload: unknown): {
  hasMessages: boolean;
  hasStatuses: boolean;
  unknownFields: string[];
} {
  const root = asRecord(payload);
  const body = Array.isArray(root.entry) ? root : asRecord(root.body);
  const entries = Array.isArray(body.entry) ? body.entry : [];

  let hasMessages = false;
  let hasStatuses = false;
  const unknownFields: string[] = [];
  const known = new Set(["messages", "statuses"]);

  for (const rawEntry of entries) {
    const entry = asRecord(rawEntry);
    for (const rawChange of Array.isArray(entry.changes) ? entry.changes : []) {
      const change = asRecord(rawChange);
      const field = asString(change.field);
      const value = asRecord(change.value);
      if (Array.isArray(value.messages) && value.messages.length > 0) hasMessages = true;
      if (Array.isArray(value.statuses) && value.statuses.length > 0) hasStatuses = true;
      if (field && !known.has(field) && field !== "message_template_status_update") {
        unknownFields.push(field);
      }
    }
  }

  return { hasMessages, hasStatuses, unknownFields: Array.from(new Set(unknownFields)) };
}
