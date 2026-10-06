/**
 * Tempo de espera pelo atendente (toda a operação da empresa).
 * Histórico: 1ª atribuição − último inbound antes de assumir.
 * Fila atual: sem responsável, última mensagem do cliente.
 */
import { sql } from "@/lib/pg.server";
import type { PgSql } from "@/lib/pg-types";
import { resolveCostPeriod, type CampaignCostPeriodPreset } from "@/lib/campaign-costs";
import { averageSeconds } from "@/lib/campaign-metrics";

export type AttendanceWaitQueueRow = {
  conversationId: string;
  contactName: string | null;
  phone: string | null;
  waitingSeconds: number;
  lastInboundAt: string;
};

export type AttendanceWaitAgentRow = {
  userId: string;
  userName: string | null;
  assumedCount: number;
  avgWaitSeconds: number | null;
};

export type AttendanceWaitSummary = {
  assumedCount: number;
  avgWaitSeconds: number | null;
  medianWaitSeconds: number | null;
  waitingNowCount: number;
};

export type AttendanceWaitPayload = {
  period: { from: string; to: string; preset: CampaignCostPeriodPreset };
  summary: AttendanceWaitSummary;
  queue: AttendanceWaitQueueRow[];
  agents: AttendanceWaitAgentRow[];
};

export async function getAttendanceWaitReport(
  companyId: string,
  opts?: {
    preset?: string | null;
    from?: string | null;
    to?: string | null;
    db?: PgSql;
  },
): Promise<AttendanceWaitPayload> {
  const s = opts?.db ?? sql();
  const period = resolveCostPeriod({
    preset: opts?.preset,
    from: opts?.from,
    to: opts?.to,
  });

  const assumed = await s<
    {
      wait_seconds: number;
      user_id: string | null;
      user_name: string | null;
    }[]
  >`
    WITH first_assign AS (
      SELECT
        a.conversation_id,
        MIN(a.assigned_at) AS assigned_at
      FROM public.conversation_assignments a
      INNER JOIN public.conversations c ON c.id = a.conversation_id
      WHERE c.company_id = ${companyId}::uuid
        AND c.status IS DISTINCT FROM 'merged'
        AND a.assigned_at >= (${period.from}::date AT TIME ZONE 'America/Sao_Paulo')
        AND a.assigned_at < ((${period.to}::date + 1) AT TIME ZONE 'America/Sao_Paulo')
      GROUP BY a.conversation_id
    )
    SELECT
      GREATEST(
        0,
        EXTRACT(
          EPOCH FROM (
            fa.assigned_at
            - COALESCE(
                (
                  SELECT MAX(m.created_at)
                  FROM public.messages m
                  WHERE m.conversation_id = fa.conversation_id
                    AND COALESCE(m.message_type, '') IS DISTINCT FROM 'system'
                    AND (
                      m.direction IN ('in', 'inbound')
                      OR m.from_me = false
                    )
                    AND m.created_at <= fa.assigned_at
                ),
                c.created_at
              )
          )
        )
      )::int AS wait_seconds,
      a.user_id,
      u.name AS user_name
    FROM first_assign fa
    INNER JOIN public.conversations c ON c.id = fa.conversation_id
    INNER JOIN LATERAL (
      SELECT a.user_id
      FROM public.conversation_assignments a
      WHERE a.conversation_id = fa.conversation_id
        AND a.assigned_at = fa.assigned_at
      ORDER BY a.id
      LIMIT 1
    ) a ON true
    LEFT JOIN public.users u ON u.id = a.user_id
  `;

  const waits = assumed
    .map((r) => Number(r.wait_seconds ?? 0))
    .filter((n) => Number.isFinite(n) && n >= 0);
  const assumedCount = waits.length;
  const totalWait = waits.reduce((acc, n) => acc + n, 0);
  const sorted = [...waits].sort((a, b) => a - b);
  const medianWaitSeconds =
    assumedCount === 0
      ? null
      : assumedCount % 2 === 1
        ? sorted[Math.floor(assumedCount / 2)]
        : Math.round(
            (sorted[assumedCount / 2 - 1] + sorted[assumedCount / 2]) / 2,
          );

  const byAgent = new Map<
    string,
    { userName: string | null; total: number; count: number }
  >();
  for (const r of assumed) {
    const uid = r.user_id;
    if (!uid) continue;
    const prev = byAgent.get(uid) ?? {
      userName: r.user_name,
      total: 0,
      count: 0,
    };
    prev.total += Number(r.wait_seconds ?? 0) || 0;
    prev.count += 1;
    prev.userName = r.user_name ?? prev.userName;
    byAgent.set(uid, prev);
  }

  const agents: AttendanceWaitAgentRow[] = [...byAgent.entries()]
    .map(([userId, v]) => ({
      userId,
      userName: v.userName,
      assumedCount: v.count,
      avgWaitSeconds: averageSeconds(v.total, v.count),
    }))
    .sort((a, b) => b.assumedCount - a.assumedCount);

  const queueRows = await s<
    {
      conversation_id: string;
      contact_name: string | null;
      phone: string | null;
      last_inbound_at: Date | string;
      waiting_seconds: number;
    }[]
  >`
    SELECT
      c.id AS conversation_id,
      ct.name AS contact_name,
      ct.phone,
      lm.created_at AS last_inbound_at,
      EXTRACT(EPOCH FROM (now() - lm.created_at))::int AS waiting_seconds
    FROM public.conversations c
    INNER JOIN public.contacts ct ON ct.id = c.contact_id
    LEFT JOIN public.conversation_assignments a
      ON a.conversation_id = c.id
     AND a.active = true
     AND a.unassigned_at IS NULL
    INNER JOIN LATERAL (
      SELECT m.created_at, m.direction, m.from_me
      FROM public.messages m
      WHERE m.conversation_id = c.id
        AND COALESCE(m.message_type, '') IS DISTINCT FROM 'system'
        AND COALESCE(m.direction, '') IS DISTINCT FROM 'system'
      ORDER BY m.created_at DESC
      LIMIT 1
    ) lm ON true
    WHERE c.company_id = ${companyId}::uuid
      AND c.status IS DISTINCT FROM 'merged'
      AND c.status IS DISTINCT FROM 'archived'
      AND c.status IS DISTINCT FROM 'finished'
      AND c.status IS DISTINCT FROM 'closed'
      AND c.status IS DISTINCT FROM 'resolved'
      AND a.id IS NULL
      AND (
        lm.direction IN ('in', 'inbound')
        OR lm.from_me = false
      )
    ORDER BY lm.created_at ASC
    LIMIT 50
  `;

  const queue: AttendanceWaitQueueRow[] = queueRows.map((r) => ({
    conversationId: r.conversation_id,
    contactName: r.contact_name,
    phone: r.phone,
    waitingSeconds: Math.max(0, Number(r.waiting_seconds ?? 0) || 0),
    lastInboundAt: new Date(r.last_inbound_at).toISOString(),
  }));

  return {
    period,
    summary: {
      assumedCount,
      avgWaitSeconds: averageSeconds(totalWait, assumedCount),
      medianWaitSeconds,
      waitingNowCount: queue.length,
    },
    queue,
    agents,
  };
}
