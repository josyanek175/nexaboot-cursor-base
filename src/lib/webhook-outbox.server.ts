/**
 * Outbox transacional: escrita na transação de ingestão e repositório do
 * publicador.
 *
 * Este módulo NÃO importa a camada RabbitMQ de propósito — ele entra no grafo
 * do endpoint HTTP, que não pode depender do broker nem do driver. O motor de
 * publicação vive em `webhook-outbox-publisher.server.ts`.
 */

import type { PgSql } from "@/lib/pg-types";
import type { OutboxMessagePayload } from "@/lib/webhook-outbox-core";

// ---------------------------------------------------------------------------
// Escrita dentro da transação de ingestão
// ---------------------------------------------------------------------------

/**
 * Cliente restrito ao que a transação de ingestão usa. Aceita tanto a
 * `TransactionSql` do postgres.js quanto os fakes dos testes.
 */
// Os parâmetros aceitos pelo postgres.js são um union enorme; `any` mantém o
// tipo utilizável tanto pela TransactionSql real quanto pelos fakes de teste.
export type OutboxTx = <T extends readonly unknown[] = unknown[]>(
  strings: TemplateStringsArray,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...values: any[]
) => Promise<T>;

export type EnsureOutboxResult = {
  outboxId: string | null;
  created: boolean;
};

/**
 * Garante a mensagem da outbox correspondente a um evento da inbox.
 *
 * Roda SEMPRE dentro da transação da ingestão, inclusive em evento duplicado:
 * é isso que repara uma inbox que ficou sem outbox (por exemplo se a etapa 1
 * já tinha gravado o evento antes desta migration existir).
 */
export async function ensureOutboxForInbox(
  tx: OutboxTx,
  params: {
    inboxId: string;
    exchangeName: string;
    routingKey: string;
    messagePayload: OutboxMessagePayload;
  },
): Promise<EnsureOutboxResult> {
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO public.webhook_outbox (
      inbox_id, exchange_name, routing_key, message_payload, status
    ) VALUES (
      ${params.inboxId}::uuid,
      ${params.exchangeName},
      ${params.routingKey},
      ${params.messagePayload}::jsonb,
      'pending'
    )
    ON CONFLICT (inbox_id, routing_key) DO NOTHING
    RETURNING id
  `;

  if (inserted[0]) return { outboxId: inserted[0].id, created: true };

  const existing = await tx<{ id: string }[]>`
    SELECT id FROM public.webhook_outbox
    WHERE inbox_id = ${params.inboxId}::uuid
      AND routing_key = ${params.routingKey}
    LIMIT 1
  `;
  return { outboxId: existing[0]?.id ?? null, created: false };
}

// ---------------------------------------------------------------------------
// Repositório do publicador
// ---------------------------------------------------------------------------

export type OutboxClaimedRow = {
  id: string;
  inboxId: string;
  exchangeName: string;
  routingKey: string;
  messagePayload: unknown;
  attempts: number;
};

export type OutboxRecoveredRow = {
  id: string;
  attempts: number;
  lockedBy: string | null;
};

export type OutboxRepository = {
  recoverExpiredLeases: () => Promise<OutboxRecoveredRow[]>;
  claimBatch: (params: {
    batchSize: number;
    leaseMs: number;
    workerId: string;
  }) => Promise<OutboxClaimedRow[]>;
  markPublished: (params: { id: string; workerId: string }) => Promise<boolean>;
  markRetry: (params: {
    id: string;
    workerId: string;
    error: string;
    delayMs: number;
  }) => Promise<boolean>;
  markDeadLetter: (params: { id: string; workerId: string; error: string }) => Promise<boolean>;
  /** Devolve à fila registros reservados que não chegaram a ser publicados. */
  releaseClaims: (params: { ids: string[]; workerId: string }) => Promise<number>;
};

type RawClaimedRow = {
  id: string;
  inbox_id: string;
  exchange_name: string;
  routing_key: string;
  message_payload: unknown;
  attempts: number;
};

export function createSqlOutboxRepository(sql: PgSql): OutboxRepository {
  return {
    async recoverExpiredLeases(): Promise<OutboxRecoveredRow[]> {
      const rows = await sql<{ id: string; attempts: number; locked_by: string | null }[]>`
        UPDATE public.webhook_outbox
        SET status = 'retry',
            locked_at = NULL,
            locked_by = NULL,
            lease_expires_at = NULL,
            available_at = now(),
            updated_at = now()
        WHERE status = 'publishing'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < now()
        RETURNING id, attempts, locked_by
      `;
      return rows.map((r) => ({ id: r.id, attempts: r.attempts, lockedBy: r.locked_by }));
    },

    async claimBatch(params): Promise<OutboxClaimedRow[]> {
      // SKIP LOCKED é o que permite várias réplicas: cada uma pega um conjunto
      // disjunto de linhas em vez de esperar o lock da outra.
      const rows = await sql<RawClaimedRow[]>`
        WITH claimed AS (
          SELECT id
          FROM public.webhook_outbox
          WHERE status IN ('pending', 'retry')
            AND available_at <= now()
          ORDER BY available_at, id
          LIMIT ${params.batchSize}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE public.webhook_outbox o
        SET status = 'publishing',
            attempts = o.attempts + 1,
            locked_at = now(),
            locked_by = ${params.workerId},
            lease_expires_at = now() + make_interval(secs => ${params.leaseMs} / 1000.0),
            updated_at = now()
        FROM claimed c
        WHERE o.id = c.id
        RETURNING o.id, o.inbox_id, o.exchange_name, o.routing_key, o.message_payload, o.attempts
      `;

      return rows.map((r) => ({
        id: r.id,
        inboxId: r.inbox_id,
        exchangeName: r.exchange_name,
        routingKey: r.routing_key,
        messagePayload: r.message_payload,
        attempts: r.attempts,
      }));
    },

    async markPublished(params): Promise<boolean> {
      // O guard por locked_by impede que um worker cujo lease já expirou
      // sobrescreva o estado de quem assumiu a linha depois.
      const rows = await sql<{ id: string }[]>`
        UPDATE public.webhook_outbox
        SET status = 'published',
            published_at = now(),
            last_error = NULL,
            locked_at = NULL,
            locked_by = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE id = ${params.id}::uuid
          AND status = 'publishing'
          AND locked_by = ${params.workerId}
        RETURNING id
      `;
      return rows.length > 0;
    },

    async markRetry(params): Promise<boolean> {
      const rows = await sql<{ id: string }[]>`
        UPDATE public.webhook_outbox
        SET status = 'retry',
            available_at = now() + make_interval(secs => ${params.delayMs} / 1000.0),
            last_error = ${params.error},
            locked_at = NULL,
            locked_by = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE id = ${params.id}::uuid
          AND status = 'publishing'
          AND locked_by = ${params.workerId}
        RETURNING id
      `;
      return rows.length > 0;
    },

    async markDeadLetter(params): Promise<boolean> {
      // Registro preservado: payload, tentativas e último erro continuam lá
      // para reprocessamento manual.
      const rows = await sql<{ id: string }[]>`
        UPDATE public.webhook_outbox
        SET status = 'dead_letter',
            last_error = ${params.error},
            locked_at = NULL,
            locked_by = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE id = ${params.id}::uuid
          AND status = 'publishing'
          AND locked_by = ${params.workerId}
        RETURNING id
      `;
      return rows.length > 0;
    },

    async releaseClaims(params): Promise<number> {
      if (params.ids.length === 0) return 0;
      // A tentativa é devolvida: a linha foi reservada mas nunca publicada.
      const rows = await sql<{ id: string }[]>`
        UPDATE public.webhook_outbox
        SET status = 'retry',
            attempts = GREATEST(0, attempts - 1),
            available_at = now(),
            locked_at = NULL,
            locked_by = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE id = ANY(${params.ids}::uuid[])
          AND status = 'publishing'
          AND locked_by = ${params.workerId}
        RETURNING id
      `;
      return rows.length;
    },
  };
}
