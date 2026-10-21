/**
 * Republicador de retry da inbox.
 *
 * Quando o message-worker falha temporariamente, ele grava `retry` +
 * `available_at` e dá ACK na entrega atual — sem segurar slot de prefetch.
 * Este dispatcher encontra linhas prontas e republica a referência no
 * RabbitMQ, marcando a inbox como `queued`.
 */

import type { PgSql } from "@/lib/pg-types";
import type { RabbitPublisher } from "@/lib/rabbitmq.server";
import { buildOutboxRoutingKey, OUTBOX_MESSAGE_SCHEMA_VERSION } from "@/lib/webhook-outbox-core";
import type { WebhookProvider } from "@/lib/webhook-inbox-core";

type LogFn = (event: string, data?: Record<string, unknown>) => void;

export type InboxRetryClaimed = {
  id: string;
  provider: string;
  eventType: string | null;
  conversationKey: string | null;
  receivedAt: string | Date | null;
  attempts: number;
};

export type InboxRetryRepository = {
  claimReadyRetries: (params: {
    batchSize: number;
    workerId: string;
    leaseMs: number;
  }) => Promise<InboxRetryClaimed[]>;
  markQueuedAfterPublish: (params: { id: string; workerId: string }) => Promise<boolean>;
  releaseRetryClaim: (params: { id: string; workerId: string }) => Promise<boolean>;
};

export function createSqlInboxRetryRepository(sql: PgSql): InboxRetryRepository {
  return {
    async claimReadyRetries(params) {
      const rows = await sql<
        {
          id: string;
          provider: string;
          event_type: string | null;
          conversation_key: string | null;
          received_at: string | Date | null;
          attempts: number;
        }[]
      >`
        WITH claimed AS (
          SELECT id
          FROM public.webhook_inbox
          WHERE status = 'retry'
            AND available_at <= now()
          ORDER BY available_at, id
          LIMIT ${params.batchSize}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE public.webhook_inbox i
        SET status = 'queued',
            locked_at = now(),
            locked_by = ${params.workerId},
            lease_expires_at = now() + make_interval(secs => ${params.leaseMs} / 1000.0),
            updated_at = now()
        FROM claimed c
        WHERE i.id = c.id
        RETURNING i.id, i.provider, i.event_type, i.conversation_key, i.received_at, i.attempts
      `;
      return rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        eventType: r.event_type,
        conversationKey: r.conversation_key,
        receivedAt: r.received_at,
        attempts: r.attempts,
      }));
    },

    async markQueuedAfterPublish(params) {
      // Já está queued; só limpa o lease do dispatcher.
      const rows = await sql<{ id: string }[]>`
        UPDATE public.webhook_inbox
        SET locked_at = NULL,
            locked_by = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE id = ${params.id}::uuid
          AND status = 'queued'
          AND locked_by = ${params.workerId}
        RETURNING id
      `;
      return rows.length > 0;
    },

    async releaseRetryClaim(params) {
      const rows = await sql<{ id: string }[]>`
        UPDATE public.webhook_inbox
        SET status = 'retry',
            available_at = now(),
            locked_at = NULL,
            locked_by = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE id = ${params.id}::uuid
          AND status = 'queued'
          AND locked_by = ${params.workerId}
        RETURNING id
      `;
      return rows.length > 0;
    },
  };
}

export async function processInboxRetryBatch(params: {
  repo: InboxRetryRepository;
  publisher: RabbitPublisher;
  workerId: string;
  batchSize?: number;
  leaseMs?: number;
  log?: LogFn;
  logError?: LogFn;
}): Promise<{ claimed: number; published: number; released: number }> {
  const log = params.log ?? ((e, d) => console.log(`[${e}]`, d ?? {}));
  const logError = params.logError ?? ((e, d) => console.error(`[${e}]`, d ?? {}));
  const batchSize = params.batchSize ?? 20;
  const leaseMs = params.leaseMs ?? 60_000;

  const claimed = await params.repo.claimReadyRetries({
    batchSize,
    workerId: params.workerId,
    leaseMs,
  });

  let published = 0;
  let released = 0;

  for (const row of claimed) {
    try {
      const receivedAt =
        row.receivedAt instanceof Date
          ? row.receivedAt.toISOString()
          : (row.receivedAt ?? new Date().toISOString());

      await params.publisher.publish({
        routingKey: buildOutboxRoutingKey(
          row.provider as WebhookProvider,
          row.eventType,
        ),
        body: {
          schemaVersion: OUTBOX_MESSAGE_SCHEMA_VERSION,
          inboxId: row.id,
          provider: row.provider,
          eventType: row.eventType,
          conversationKey: row.conversationKey,
          receivedAt,
        },
        messageId: row.id,
      });
      await params.repo.markQueuedAfterPublish({
        id: row.id,
        workerId: params.workerId,
      });
      published += 1;
      log("WEBHOOK_INBOX_RETRY_REPUBLISHED", {
        inboxId: row.id,
        attempts: row.attempts,
      });
    } catch (e) {
      await params.repo.releaseRetryClaim({
        id: row.id,
        workerId: params.workerId,
      });
      released += 1;
      logError("WEBHOOK_INBOX_RETRY_REPUBLISH_FAILED", {
        inboxId: row.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { claimed: claimed.length, published, released };
}
