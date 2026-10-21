import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/pg.server";
import { onAutomationInbound } from "@/lib/automation-flow.server";

type Work = {
  id: string;
  company_id: string;
  channel_id: string;
  conversation_id: string;
  contact_id: string;
  state: { text?: string; isMedia?: boolean; restartCycle?: boolean };
};

/** Called only by the enabled durable worker, never by the web server. */
export async function recoverPendingAttendanceJobs(limit = 5): Promise<number> {
  const rows = await getSql()<{ conversation_id: string }[]>`
    SELECT conversation_id FROM public.messages
    WHERE direction='in' AND raw_payload->'__nexaFlow'->>'status' IN ('pending','retry','processing')
      AND COALESCE((raw_payload->'__nexaFlow'->>'availableAt')::timestamptz,now())<=now()
      AND (raw_payload->'__nexaFlow'->>'status'<>'processing'
        OR (raw_payload->'__nexaFlow'->>'leaseUntil')::timestamptz<now())
    GROUP BY conversation_id ORDER BY min(created_at),conversation_id LIMIT ${Math.max(1, Math.min(limit, 100))}
  `;
  let processed = 0;
  for (const row of rows) processed += await drainAttendanceJobs(row.conversation_id, 10);
  return processed;
}

/** Serializes flow execution using existing messages.raw_payload; no schema migration. */
export async function drainAttendanceJobs(conversationId: string, limit = 100): Promise<number> {
  let processed = 0;
  for (let i = 0; i < limit; i++) {
    const token = randomUUID();
    const rows = await getSql().begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"flow:" + conversationId}, 0))`;
      // FIFO: a running or delayed retry prevents overtaking within this attendance.
      const candidates = await tx<Work[]>`
        SELECT m.id, c.company_id, c.whatsapp_channel_id AS channel_id,
          m.conversation_id, c.contact_id, m.raw_payload->'__nexaFlow' AS state
        FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id
        WHERE m.conversation_id=${conversationId}::uuid AND m.direction='in'
          AND m.raw_payload->'__nexaFlow'->>'status' IN ('pending','retry','processing')
        ORDER BY m.created_at, m.id LIMIT 1 FOR UPDATE OF m
      `;
      const work = candidates[0];
      if (!work) return [];
      const claimed = await tx<{ id: string }[]>`
        UPDATE public.messages SET raw_payload=jsonb_set(raw_payload,'{__nexaFlow}',
          (raw_payload->'__nexaFlow') || jsonb_build_object('status','processing','token',${token}::text,
            'leaseUntil',now()+interval '2 minutes','attempts',COALESCE((raw_payload->'__nexaFlow'->>'attempts')::int,0)+1))
        WHERE id=${work.id}::uuid
          AND (COALESCE(raw_payload->'__nexaFlow'->>'status','') <> 'processing'
               OR (raw_payload->'__nexaFlow'->>'leaseUntil')::timestamptz < now())
          AND COALESCE((raw_payload->'__nexaFlow'->>'availableAt')::timestamptz,now()) <= now()
        RETURNING id
      `;
      return claimed[0] ? [work] : [];
    });
    const work = rows[0];
    if (!work) break;
    const heartbeat = setInterval(() => {
      void getSql()`UPDATE public.messages SET raw_payload=jsonb_set(raw_payload,'{__nexaFlow,leaseUntil}',to_jsonb(now()+interval '2 minutes'))
        WHERE id=${work.id}::uuid AND raw_payload->'__nexaFlow'->>'token'=${token}`.catch(() => {});
    }, 15000);
    heartbeat.unref();
    try {
      await onAutomationInbound({
        companyId: work.company_id,
        channelId: work.channel_id,
        conversationId: work.conversation_id,
        contactId: work.contact_id,
        inboundMessageId: work.id,
        processingToken: token,
        text: work.state.text ?? "",
        isMedia: work.state.isMedia,
        restartCycle: work.state.restartCycle,
        throwErrors: true,
      });
      await getSql()`UPDATE public.messages SET raw_payload=jsonb_set(raw_payload,'{__nexaFlow}',
        (raw_payload->'__nexaFlow') || jsonb_build_object('status','processed','processedAt',now()))
        WHERE id=${work.id}::uuid AND raw_payload->'__nexaFlow'->>'token'=${token}`;
      processed++;
    } catch {
      await getSql()`UPDATE public.messages SET raw_payload=jsonb_set(raw_payload,'{__nexaFlow}',
        (raw_payload->'__nexaFlow') || jsonb_build_object('status','retry','availableAt',now()+interval '10 seconds',
          'error','automation_processing_failed'))
        WHERE id=${work.id}::uuid AND raw_payload->'__nexaFlow'->>'token'=${token}`;
      break;
    } finally {
      clearInterval(heartbeat);
    }
  }
  return processed;
}
