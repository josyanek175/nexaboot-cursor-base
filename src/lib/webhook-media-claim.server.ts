/**
 * Claim/lease atômico de webhook_media_jobs.
 */

import type { PgSql, SqlExecutor } from "@/lib/pg-types";
import type { WebhookProvider } from "@/lib/webhook-inbox-core";

export type MediaJobRow = {
  id: string;
  inboxId: string;
  messageId: string;
  provider: string;
  channelId: string | null;
  instanceName: string | null;
  externalMessageId: string | null;
  mediaType: string | null;
  mimeType: string | null;
  fileName: string | null;
  mediaReference: Record<string, unknown>;
  status: string;
  attempts: number;
  storageKey: string | null;
  checksum: string | null;
  sizeBytes: number | null;
  createdAt: string | Date | null;
};

export type MediaClaimOutcome =
  | { outcome: "claimed"; row: MediaJobRow }
  | { outcome: "already_processed"; attempts: number; storageKey: string | null }
  | { outcome: "dead_letter"; attempts: number }
  | { outcome: "not_found" }
  | { outcome: "not_yet_available"; availableInMs: number }
  | { outcome: "lease_conflict"; lockedBy: string | null; leaseExpiresAt: string | null };

export type MediaClaimRepository = {
  claimBatch: (params: {
    batchSize: number;
    workerId: string;
    leaseMs: number;
  }) => Promise<MediaJobRow[]>;
  claimById: (params: {
    mediaJobId: string;
    workerId: string;
    leaseMs: number;
  }) => Promise<MediaClaimOutcome>;
  markProcessed: (params: {
    mediaJobId: string;
    workerId: string;
    storageKey: string;
    checksum: string;
    sizeBytes: number;
  }) => Promise<boolean>;
  markRetry: (params: {
    mediaJobId: string;
    workerId: string;
    error: string;
    delayMs: number;
  }) => Promise<boolean>;
  markDeadLetter: (params: {
    mediaJobId: string;
    workerId: string;
    error: string;
  }) => Promise<boolean>;
  countByStatus: () => Promise<{
    pending: number;
    processing: number;
    retry: number;
    deadLetter: number;
    processed: number;
    oldestPendingAgeMs: number | null;
  }>;
};

function mapRow(r: Record<string, unknown>): MediaJobRow {
  const ref = r.media_reference;
  return {
    id: String(r.id),
    inboxId: String(r.inbox_id),
    messageId: String(r.message_id),
    provider: String(r.provider),
    channelId: r.channel_id != null ? String(r.channel_id) : null,
    instanceName: r.instance_name != null ? String(r.instance_name) : null,
    externalMessageId: r.external_message_id != null ? String(r.external_message_id) : null,
    mediaType: r.media_type != null ? String(r.media_type) : null,
    mimeType: r.mime_type != null ? String(r.mime_type) : null,
    fileName: r.file_name != null ? String(r.file_name) : null,
    mediaReference:
      ref && typeof ref === "object" && !Array.isArray(ref)
        ? (ref as Record<string, unknown>)
        : {},
    status: String(r.status),
    attempts: Number(r.attempts ?? 0),
    storageKey: r.storage_key != null ? String(r.storage_key) : null,
    checksum: r.checksum != null ? String(r.checksum) : null,
    sizeBytes: r.size_bytes != null ? Number(r.size_bytes) : null,
    createdAt: (r.created_at as string | Date | null) ?? null,
  };
}

const CLAIM_RETURNING = `
  id, inbox_id, message_id, provider, channel_id, instance_name,
  external_message_id, media_type, mime_type, file_name, media_reference,
  status, attempts, storage_key, checksum, size_bytes, created_at
`;

export function createSqlMediaClaimRepository(sql: PgSql): MediaClaimRepository {
  return {
    async claimBatch(params) {
      const rows = await sql<Record<string, unknown>[]>`
        WITH claimed AS (
          SELECT id
          FROM public.webhook_media_jobs
          WHERE (
              status IN ('pending', 'retry')
              AND available_at <= now()
            )
            OR (
              status = 'processing'
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at < now()
            )
          ORDER BY available_at NULLS FIRST, id
          LIMIT ${params.batchSize}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE public.webhook_media_jobs j
        SET status = 'processing',
            attempts = attempts + 1,
            locked_at = now(),
            locked_by = ${params.workerId},
            lease_expires_at = now() + make_interval(secs => ${params.leaseMs} / 1000.0),
            updated_at = now()
        FROM claimed c
        WHERE j.id = c.id
        RETURNING j.id, j.inbox_id, j.message_id, j.provider, j.channel_id, j.instance_name,
          j.external_message_id, j.media_type, j.mime_type, j.file_name, j.media_reference,
          j.status, j.attempts, j.storage_key, j.checksum, j.size_bytes, j.created_at
      `;
      return rows.map(mapRow);
    },

    async claimById(params) {
      const claimed = await sql<Record<string, unknown>[]>`
        UPDATE public.webhook_media_jobs
        SET status = 'processing',
            attempts = attempts + 1,
            locked_at = now(),
            locked_by = ${params.workerId},
            lease_expires_at = now() + make_interval(secs => ${params.leaseMs} / 1000.0),
            updated_at = now()
        WHERE id = ${params.mediaJobId}::uuid
          AND (
            (status IN ('pending', 'retry') AND available_at <= now())
            OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
          )
        RETURNING id, inbox_id, message_id, provider, channel_id, instance_name,
          external_message_id, media_type, mime_type, file_name, media_reference,
          status, attempts, storage_key, checksum, size_bytes, created_at
      `;
      if (claimed[0]) return { outcome: "claimed", row: mapRow(claimed[0]) };

      const rows = await sql<
        {
          status: string;
          attempts: number;
          locked_by: string | null;
          lease_expires_at: string | null;
          storage_key: string | null;
          available_in_ms: number | null;
        }[]
      >`
        SELECT status, attempts, locked_by, lease_expires_at, storage_key,
          CASE
            WHEN available_at > now() THEN EXTRACT(EPOCH FROM (available_at - now())) * 1000
            ELSE 0
          END AS available_in_ms
        FROM public.webhook_media_jobs
        WHERE id = ${params.mediaJobId}::uuid
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return { outcome: "not_found" };
      if (row.status === "processed") {
        return {
          outcome: "already_processed",
          attempts: row.attempts,
          storageKey: row.storage_key,
        };
      }
      if (row.status === "dead_letter") {
        return { outcome: "dead_letter", attempts: row.attempts };
      }
      if (row.status === "retry" && (row.available_in_ms ?? 0) > 0) {
        return {
          outcome: "not_yet_available",
          availableInMs: Math.ceil(Number(row.available_in_ms ?? 0)),
        };
      }
      return {
        outcome: "lease_conflict",
        lockedBy: row.locked_by,
        leaseExpiresAt: row.lease_expires_at,
      };
    },

    async markProcessed(params) {
      const rows = await sql<{ id: string }[]>`
        UPDATE public.webhook_media_jobs
        SET status = 'processed',
            storage_key = ${params.storageKey},
            checksum = ${params.checksum},
            size_bytes = ${params.sizeBytes},
            processed_at = now(),
            last_error = NULL,
            locked_at = NULL,
            locked_by = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE id = ${params.mediaJobId}::uuid
          AND locked_by = ${params.workerId}
          AND status = 'processing'
        RETURNING id
      `;
      return rows.length > 0;
    },

    async markRetry(params) {
      const rows = await sql<{ id: string }[]>`
        UPDATE public.webhook_media_jobs
        SET status = 'retry',
            available_at = now() + make_interval(secs => ${params.delayMs} / 1000.0),
            last_error = ${params.error},
            locked_at = NULL,
            locked_by = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE id = ${params.mediaJobId}::uuid
          AND locked_by = ${params.workerId}
          AND status = 'processing'
        RETURNING id
      `;
      return rows.length > 0;
    },

    async markDeadLetter(params) {
      const rows = await sql<{ id: string }[]>`
        UPDATE public.webhook_media_jobs
        SET status = 'dead_letter',
            last_error = ${params.error},
            locked_at = NULL,
            locked_by = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE id = ${params.mediaJobId}::uuid
          AND locked_by = ${params.workerId}
          AND status = 'processing'
        RETURNING id
      `;
      return rows.length > 0;
    },

    async countByStatus() {
      const rows = await sql<
        {
          pending: number;
          processing: number;
          retry: number;
          dead_letter: number;
          processed: number;
          oldest_pending_age_ms: number | null;
        }[]
      >`
        SELECT
          count(*) FILTER (WHERE status = 'pending')::int AS pending,
          count(*) FILTER (WHERE status = 'processing')::int AS processing,
          count(*) FILTER (WHERE status = 'retry')::int AS retry,
          count(*) FILTER (WHERE status = 'dead_letter')::int AS dead_letter,
          count(*) FILTER (WHERE status = 'processed')::int AS processed,
          EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (
            WHERE status IN ('pending', 'retry')
          ))) * 1000 AS oldest_pending_age_ms
        FROM public.webhook_media_jobs
      `;
      const r = rows[0];
      return {
        pending: r?.pending ?? 0,
        processing: r?.processing ?? 0,
        retry: r?.retry ?? 0,
        deadLetter: r?.dead_letter ?? 0,
        processed: r?.processed ?? 0,
        oldestPendingAgeMs:
          r?.oldest_pending_age_ms != null ? Math.round(Number(r.oldest_pending_age_ms)) : null,
      };
    },
  };
}

export type MediaMessageUpdate = {
  messageId: string;
  mediaStatus: string;
  mediaUrl: string | null;
  storageKey: string | null;
  mimeType: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  checksum: string | null;
  mediaError: string | null;
};

/** Atualiza a mensagem sem apagar o registro. Preferir TX curta fora do download. */
export async function updateMessageMediaState(
  sql: SqlExecutor,
  params: MediaMessageUpdate,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE public.messages
    SET media_status = ${params.mediaStatus},
        media_url = COALESCE(${params.mediaUrl}, media_url),
        storage_key = COALESCE(${params.storageKey}, storage_key),
        mime_type = COALESCE(${params.mimeType}, mime_type),
        media_mimetype = COALESCE(${params.mimeType}, media_mimetype),
        media_filename = COALESCE(${params.fileName}, media_filename),
        media_size = COALESCE(${params.sizeBytes}, media_size),
        media_checksum = COALESCE(${params.checksum}, media_checksum),
        media_error = ${params.mediaError}
    WHERE id = ${params.messageId}::uuid
    RETURNING id
  `;
  return rows.length > 0;
}

export async function loadMediaJobContext(
  sql: SqlExecutor,
  params: { messageId: string; inboxId: string; channelId: string | null },
): Promise<{
  messageExists: boolean;
  companyId: string | null;
  phoneNumberId: string | null;
  inboxPayload: unknown;
}> {
  const messages = await sql<{ id: string; company_id: string | null }[]>`
    SELECT m.id, c.company_id
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    WHERE m.id = ${params.messageId}::uuid
    LIMIT 1
  `;
  const inbox = await sql<{ payload: unknown }[]>`
    SELECT payload FROM public.webhook_inbox
    WHERE id = ${params.inboxId}::uuid
    LIMIT 1
  `;
  let phoneNumberId: string | null = null;
  if (params.channelId) {
    const channels = await sql<{ phone_number_id: string | null }[]>`
      SELECT phone_number_id FROM public.whatsapp_channels
      WHERE id = ${params.channelId}::uuid
      LIMIT 1
    `;
    phoneNumberId = channels[0]?.phone_number_id ?? null;
  }
  return {
    messageExists: Boolean(messages[0]),
    companyId: messages[0]?.company_id ?? null,
    phoneNumberId,
    inboxPayload: inbox[0]?.payload ?? null,
  };
}

export function isSupportedMediaProvider(provider: string): provider is WebhookProvider {
  return provider === "evolution" || provider === "meta";
}
