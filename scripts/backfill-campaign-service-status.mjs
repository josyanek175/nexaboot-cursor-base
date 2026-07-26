/**
 * Backfill idempotente de campaign_service_status — SOMENTE banco dev.
 * Uso: npx tsx scripts/backfill-campaign-service-status.mjs
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL não configurada");
  process.exit(1);
}

const lower = url.toLowerCase();
if (
  lower.includes("prod") ||
  lower.includes("production") ||
  process.env.NODE_ENV === "production"
) {
  console.error("ABORTADO: DATABASE_URL parece apontar para produção.");
  process.exit(1);
}

const sql = postgres(url, {
  ssl: url.includes("sslmode=require") || url.includes("supabase") || url.includes("neon") ? "require" : undefined,
  max: 3,
  prepare: false,
});

async function main() {
  console.log("[BACKFILL] Iniciando backfill campaign_service_status (dev)...");

  const counts = {};

  const optOut = await sql`
    UPDATE public.conversations
    SET campaign_service_status = 'opt_out', updated_at = now()
    WHERE campaign_reply_campaign_id IS NOT NULL
      AND (campaign_reply_intent = 'opt_out' OR campaign_service_status = 'opt_out')
      AND campaign_service_status IS DISTINCT FROM 'opt_out'
    RETURNING id
  `;
  counts.opt_out = optOut.length;

  const notInterested = await sql`
    UPDATE public.conversations
    SET campaign_service_status = 'not_interested', updated_at = now()
    WHERE campaign_reply_campaign_id IS NOT NULL
      AND campaign_reply_intent = 'not_interested'
      AND campaign_service_status IS DISTINCT FROM 'not_interested'
      AND campaign_service_status IS DISTINCT FROM 'opt_out'
    RETURNING id
  `;
  counts.not_interested = notInterested.length;

  const completed = await sql`
    UPDATE public.conversations
    SET campaign_service_status = 'completed', updated_at = now()
    WHERE campaign_reply_campaign_id IS NOT NULL
      AND status = 'finished'
      AND campaign_service_status IS DISTINCT FROM 'completed'
      AND campaign_service_status IS DISTINCT FROM 'opt_out'
    RETURNING id
  `;
  counts.completed = completed.length;

  const answered = await sql`
    UPDATE public.conversations c
    SET campaign_service_status = 'answered',
        campaign_last_human_reply_at = sub.last_human_at,
        updated_at = now()
    FROM (
      SELECT
        c2.id AS conversation_id,
        MAX(m.created_at) AS last_human_at
      FROM public.conversations c2
      JOIN public.messages m ON m.conversation_id = c2.id
      WHERE c2.campaign_reply_campaign_id IS NOT NULL
        AND m.direction = 'out'
        AND m.sent_by_user_id IS NOT NULL
        AND m.message_type IN ('text', 'image', 'audio', 'document', 'video')
        AND COALESCE(m.raw_payload->>'origin', '') <> 'CAMPANHA'
        AND m.message_type <> 'system'
        AND (
          c2.campaign_last_inbound_at IS NULL
          OR m.created_at > c2.campaign_last_inbound_at
        )
      GROUP BY c2.id
    ) sub
    WHERE c.id = sub.conversation_id
      AND c.campaign_service_status IS DISTINCT FROM 'answered'
      AND c.campaign_service_status IS DISTINCT FROM 'completed'
      AND c.campaign_service_status IS DISTINCT FROM 'opt_out'
    RETURNING c.id
  `;
  counts.answered = answered.length;

  const awaiting = await sql`
    UPDATE public.conversations c
    SET campaign_service_status = 'awaiting_reply',
        campaign_last_inbound_at = COALESCE(c.campaign_last_inbound_at, c.campaign_reply_at, c.last_message_at),
        updated_at = now()
    WHERE c.campaign_reply_campaign_id IS NOT NULL
      AND c.status IS DISTINCT FROM 'finished'
      AND c.campaign_service_status IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.messages m
        WHERE m.conversation_id = c.id
          AND m.direction = 'out'
          AND m.sent_by_user_id IS NOT NULL
          AND COALESCE(m.raw_payload->>'origin', '') <> 'CAMPANHA'
          AND m.message_type IN ('text', 'image', 'audio', 'document', 'video')
          AND (
            c.campaign_last_inbound_at IS NULL
            OR m.created_at > c.campaign_last_inbound_at
          )
      )
    RETURNING c.id
  `;
  counts.awaiting_reply = awaiting.length;

  console.log("[BACKFILL] Quantidade atualizada por status:");
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k}: ${v}`);
  }

  await sql.end();
  console.log("[BACKFILL] Concluído.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
