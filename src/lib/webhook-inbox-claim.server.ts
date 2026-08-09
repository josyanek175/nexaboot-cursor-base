/**
 * Claim, lease e desfecho de um evento da `webhook_inbox`.
 *
 * O message-worker nunca confia no envelope do RabbitMQ: tudo que ele decide
 * vem daqui. Este módulo não importa a camada RabbitMQ nem lógica de domínio —
 * só transiciona o estado do evento.
 */

import type { PgSql, SqlExecutor } from "@/lib/pg-types";

/** Aceita a `TransactionSql` do postgres.js e os fakes dos testes. */
export type InboxTx = SqlExecutor;

export type InboxEventRow = {
  id: string;
  provider: string;
  eventType: string | null;
  companyId: string | null;
  channelId: string | null;
  instanceName: string | null;
  externalEventId: string | null;
  externalMessageId: string | null;
  conversationKey: string | null;
  payload: unknown;
  attempts: number;
  receivedAt: string | Date | null;
};

export type ClaimOutcome =
  /** Reservado por este worker; pode processar. */
  | { outcome: "claimed"; row: InboxEventRow }
  /** Já concluído por outra entrega. ACK sem reprocessar. */
  | { outcome: "already_processed"; attempts: number }
  /** Já descartado por excesso de falhas. ACK; reprocessar é decisão manual. */
  | { outcome: "dead_letter"; attempts: number }
  /** Referência aponta para evento que não existe. ACK; não há o que fazer. */
  | { outcome: "not_found" }
  /** Em retry, mas o backoff ainda não venceu. Devolver sem consumir tentativa. */
  | { outcome: "not_yet_available"; availableInMs: number }
  /** Outro worker está processando com lease válido. Devolver com atraso. */
  | {
      outcome: "lease_conflict";
      lockedBy: string | null;
      leaseExpiresAt: string | Date | null;
    };

export type InboxStatusCounts = {
  pending: number;
  queued: number;
  processing: number;
  retry: number;
  deadLetter: number;
  processed: number;
  oldestPendingAgeMs: number | null;
};

export type MediaJobStatusCounts = {
  pending: number;
  processing: number;
  retry: number;
  deadLetter: number;
};

export type InboxClaimRepository = {
  claim: (params: { inboxId: string; workerId: string; leaseMs: number }) => Promise<ClaimOutcome>;
  markRetry: (params: {
    inboxId: string;
    workerId: string;
    error: string;
    delayMs: number;
  }) => Promise<boolean>;
  markDeadLetter: (params: {
    inboxId: string;
    workerId: string;
    error: string;
  }) => Promise<boolean>;
  /** Devolve à fila sem consumir tentativa (usado no shutdown gracioso). */
  releaseClaim: (params: { inboxId: string; workerId: string }) => Promise<boolean>;
  countInboxByStatus: () => Promise<InboxStatusCounts>;
  countMediaJobsByStatus: () => Promise<MediaJobStatusCounts>;
};

type RawInboxRow = {
  id: string;
  provider: string;
  event_type: string | null;
  company_id: string | null;
  channel_id: string | null;
  instance_name: string | null;
  external_event_id: string | null;
  external_message_id: string | null;
  conversation_key: string | null;
  payload: unknown;
  attempts: number;
  received_at: string | Date | null;
};

function toInboxEventRow(raw: RawInboxRow): InboxEventRow {
  return {
    id: raw.id,
    provider: raw.provider,
    eventType: raw.event_type,
    companyId: raw.company_id,
    channelId: raw.channel_id,
    instanceName: raw.instance_name,
    externalEventId: raw.external_event_id,
    externalMessageId: raw.external_message_id,
    conversationKey: raw.conversation_key,
    payload: raw.payload,
    attempts: raw.attempts,
    receivedAt: raw.received_at,
  };
}

/**
 * Marca o evento como processado DENTRO da transação do processamento.
 *
 * Fica separado do repositório de propósito: `processed` precisa entrar no
 * mesmo COMMIT que o contato, a conversa e a mensagem. Marcar depois, numa
 * conexão própria, abriria a janela em que o estado do cliente já mudou mas o
 * evento ainda parece pendente.
 */
export async function markInboxProcessedTx(
  tx: InboxTx,
  params: { inboxId: string; workerId: string },
): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    UPDATE public.webhook_inbox
    SET status = 'processed',
        processed_at = now(),
        last_error = NULL,
        locked_at = NULL,
        locked_by = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = ${params.inboxId}::uuid
      AND status = 'processing'
      AND locked_by = ${params.workerId}
    RETURNING id
  `;
  return rows.length > 0;
}

export function createSqlInboxClaimRepository(sql: PgSql): InboxClaimRepository {
  return {
    async claim(params): Promise<ClaimOutcome> {
      // Claim atômico: um único UPDATE decide o vencedor. SKIP LOCKED faz a
      // réplica perdedora sair na hora em vez de esperar o lock da vencedora.
      //
      // Lease expirado é elegível de propósito: sem isso, um worker que morre
      // no meio do processamento deixa o evento preso para sempre.
      const claimed = await sql<RawInboxRow[]>`
        WITH target AS (
          SELECT id
          FROM public.webhook_inbox
          WHERE id = ${params.inboxId}::uuid
            AND (
              (status IN ('pending', 'queued', 'retry') AND available_at <= now())
              OR (
                status = 'processing'
                AND (lease_expires_at IS NULL OR lease_expires_at < now())
              )
            )
          FOR UPDATE SKIP LOCKED
        )
        UPDATE public.webhook_inbox i
        SET status = 'processing',
            attempts = i.attempts + 1,
            locked_at = now(),
            locked_by = ${params.workerId},
            lease_expires_at = now() + make_interval(secs => ${params.leaseMs} / 1000.0),
            updated_at = now()
        FROM target t
        WHERE i.id = t.id
        RETURNING i.id, i.provider, i.event_type, i.company_id, i.channel_id,
                  i.instance_name, i.external_event_id, i.external_message_id,
                  i.conversation_key, i.payload, i.attempts, i.received_at
      `;

      if (claimed[0]) return { outcome: "claimed", row: toInboxEventRow(claimed[0]) };

      // Não reservou: descobrir por quê, para escolher entre ACK e devolução.
      const current = await sql<
        {
          status: string;
          attempts: number;
          locked_by: string | null;
          lease_expires_at: string | Date | null;
          available_in_ms: string | number | null;
        }[]
      >`
        SELECT status, attempts, locked_by, lease_expires_at,
               EXTRACT(EPOCH FROM (available_at - now())) * 1000 AS available_in_ms
        FROM public.webhook_inbox
        WHERE id = ${params.inboxId}::uuid
        LIMIT 1
      `;

      const row = current[0];
      if (!row) return { outcome: "not_found" };
      if (row.status === "processed") {
        return { outcome: "already_processed", attempts: row.attempts };
      }
      if (row.status === "dead_letter") {
        return { outcome: "dead_letter", attempts: row.attempts };
      }
      // Redelivery antes do backoff vencer: devolver sem gastar tentativa.
      const availableInMs = Number(row.available_in_ms ?? 0);
      if (
        ["pending", "queued", "retry"].includes(row.status) &&
        Number.isFinite(availableInMs) &&
        availableInMs > 0
      ) {
        return { outcome: "not_yet_available", availableInMs: Math.ceil(availableInMs) };
      }
      return {
        outcome: "lease_conflict",
        lockedBy: row.locked_by,
        leaseExpiresAt: row.lease_expires_at,
      };
    },

    async markRetry(params): Promise<boolean> {
      // O guard por locked_by impede que um worker com lease vencido sobrescreva
      // o estado de quem assumiu o evento depois dele.
      const rows = await sql<{ id: string }[]>`
        UPDATE public.webhook_inbox
        SET status = 'retry',
            available_at = now() + make_interval(secs => ${params.delayMs} / 1000.0),
            last_error = ${params.error},
            locked_at = NULL,
            locked_by = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE id = ${params.inboxId}::uuid
          AND status = 'processing'
          AND locked_by = ${params.workerId}
        RETURNING id
      `;
      return rows.length > 0;
    },

    async markDeadLetter(params): Promise<boolean> {
      // O payload bruto permanece intacto: dead_letter é diagnóstico, não
      // descarte.
      const rows = await sql<{ id: string }[]>`
        UPDATE public.webhook_inbox
        SET status = 'dead_letter',
            last_error = ${params.error},
            locked_at = NULL,
            locked_by = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE id = ${params.inboxId}::uuid
          AND status = 'processing'
          AND locked_by = ${params.workerId}
        RETURNING id
      `;
      return rows.length > 0;
    },

    async releaseClaim(params): Promise<boolean> {
      const rows = await sql<{ id: string }[]>`
        UPDATE public.webhook_inbox
        SET status = 'retry',
            attempts = GREATEST(0, attempts - 1),
            available_at = now(),
            locked_at = NULL,
            locked_by = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE id = ${params.inboxId}::uuid
          AND status = 'processing'
          AND locked_by = ${params.workerId}
        RETURNING id
      `;
      return rows.length > 0;
    },

    async countInboxByStatus(): Promise<InboxStatusCounts> {
      const rows = await sql<
        {
          pending: string | number;
          queued: string | number;
          processing: string | number;
          retry: string | number;
          dead_letter: string | number;
          processed: string | number;
          oldest_pending_age_ms: string | number | null;
        }[]
      >`
        SELECT
          count(*) FILTER (WHERE status = 'pending')     AS pending,
          count(*) FILTER (WHERE status = 'queued')      AS queued,
          count(*) FILTER (WHERE status = 'processing')  AS processing,
          count(*) FILTER (WHERE status = 'retry')       AS retry,
          count(*) FILTER (WHERE status = 'dead_letter') AS dead_letter,
          count(*) FILTER (WHERE status = 'processed')   AS processed,
          EXTRACT(EPOCH FROM (now() - min(received_at)
            FILTER (WHERE status IN ('pending', 'queued', 'retry')))) * 1000
            AS oldest_pending_age_ms
        FROM public.webhook_inbox
      `;

      const row = rows[0];
      const toInt = (value: string | number | null | undefined) => Number(value ?? 0) || 0;
      return {
        pending: toInt(row?.pending),
        queued: toInt(row?.queued),
        processing: toInt(row?.processing),
        retry: toInt(row?.retry),
        deadLetter: toInt(row?.dead_letter),
        processed: toInt(row?.processed),
        oldestPendingAgeMs:
          row?.oldest_pending_age_ms == null ? null : Math.round(Number(row.oldest_pending_age_ms)),
      };
    },

    async countMediaJobsByStatus(): Promise<MediaJobStatusCounts> {
      const rows = await sql<
        {
          pending: string | number;
          processing: string | number;
          retry: string | number;
          dead_letter: string | number;
        }[]
      >`
        SELECT
          count(*) FILTER (WHERE status = 'pending')     AS pending,
          count(*) FILTER (WHERE status = 'processing')  AS processing,
          count(*) FILTER (WHERE status = 'retry')       AS retry,
          count(*) FILTER (WHERE status = 'dead_letter') AS dead_letter
        FROM public.webhook_media_jobs
      `;

      const row = rows[0];
      const toInt = (value: string | number | null | undefined) => Number(value ?? 0) || 0;
      return {
        pending: toInt(row?.pending),
        processing: toInt(row?.processing),
        retry: toInt(row?.retry),
        deadLetter: toInt(row?.dead_letter),
      };
    },
  };
}
