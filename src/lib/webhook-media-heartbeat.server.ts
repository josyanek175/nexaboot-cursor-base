/**
 * Heartbeat do media-worker em PostgreSQL — permite ao /api/health do web
 * distinguir "flag ligada" de "processo realmente ativo".
 *
 * Sem a tabela (migration não aplicada) ou sem linha recente → connected=unknown.
 */

import type { PgSql } from "@/lib/pg-types";

export type MediaWorkerHeartbeatRow = {
  workerId: string;
  connected: boolean;
  active: boolean;
  lastSeenAt: string;
  ageMs: number;
};

const STALE_MS = 90_000;

export async function upsertMediaWorkerHeartbeat(
  sql: PgSql,
  params: {
    workerId: string;
    connected: boolean;
    active: boolean;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await sql`
    INSERT INTO public.webhook_worker_heartbeats (
      worker_kind, worker_id, connected, active, last_seen_at, details, updated_at
    ) VALUES (
      'media',
      ${params.workerId},
      ${params.connected},
      ${params.active},
      now(),
      ${JSON.stringify(params.details ?? {})}::jsonb,
      now()
    )
    ON CONFLICT (worker_kind) DO UPDATE SET
      worker_id = EXCLUDED.worker_id,
      connected = EXCLUDED.connected,
      active = EXCLUDED.active,
      last_seen_at = now(),
      details = EXCLUDED.details,
      updated_at = now()
  `;
}

export async function readMediaWorkerHeartbeat(
  sql: PgSql,
  nowMs: number = Date.now(),
): Promise<MediaWorkerHeartbeatRow | null> {
  const rows = await sql<
    {
      worker_id: string;
      connected: boolean;
      active: boolean;
      last_seen_at: string | Date;
    }[]
  >`
    SELECT worker_id, connected, active, last_seen_at
    FROM public.webhook_worker_heartbeats
    WHERE worker_kind = 'media'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const last =
    row.last_seen_at instanceof Date
      ? row.last_seen_at.getTime()
      : Date.parse(String(row.last_seen_at));
  if (!Number.isFinite(last)) return null;
  return {
    workerId: row.worker_id,
    connected: row.connected === true,
    active: row.active === true,
    lastSeenAt: new Date(last).toISOString(),
    ageMs: Math.max(0, nowMs - last),
  };
}

export function isHeartbeatFresh(row: MediaWorkerHeartbeatRow | null, staleMs = STALE_MS): boolean {
  return row != null && row.ageMs <= staleMs;
}
