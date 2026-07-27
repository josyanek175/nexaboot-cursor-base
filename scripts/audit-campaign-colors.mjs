/**
 * Auditoria de cor de campanha no banco dev.
 * Uso: DATABASE_URL=postgres://... npx tsx scripts/audit-campaign-colors.mjs
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL não configurada.");
  process.exit(1);
}
if (/prod|production/i.test(url) && !process.env.ALLOW_PROD_AUDIT) {
  console.error("ABORTADO: DATABASE_URL parece produção. Defina ALLOW_PROD_AUDIT=1 para forçar.");
  process.exit(1);
}

const sql = postgres(url, {
  ssl:
    url.includes("sslmode=require") || url.includes("supabase") || url.includes("neon")
      ? "require"
      : undefined,
  max: 3,
  prepare: false,
});

function pickCampaign(row) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    deleted_at: row.deleted_at ?? null,
  };
}

try {
  const colorCol = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'campaigns' AND column_name = 'color'
  `;
  console.log("=== SCHEMA ===");
  console.log(JSON.stringify({ campaigns_color_column: colorCol.length === 1 }, null, 2));

  const conversations = await sql`
    SELECT
      c.id AS conversation_id,
      c.company_id,
      c.campaign_reply_campaign_id,
      c.campaign_reply_campaign_name,
      cp.id AS joined_campaign_id,
      cp.name AS joined_campaign_name,
      cp.color AS joined_campaign_color,
      cp.deleted_at
    FROM public.conversations c
    LEFT JOIN public.campaigns cp
      ON cp.id = c.campaign_reply_campaign_id
     AND cp.company_id = c.company_id
     AND cp.deleted_at IS NULL
    WHERE c.campaign_reply_campaign_id IS NOT NULL
    ORDER BY c.last_message_at DESC NULLS LAST
    LIMIT 20
  `;
  console.log("\n=== CONVERSATIONS (campaign-linked) ===");
  console.log(JSON.stringify(conversations, null, 2));

  const campaigns = await sql`
    SELECT id, company_id, name, color, deleted_at, created_at
    FROM public.campaigns
    ORDER BY created_at DESC
    LIMIT 20
  `;
  console.log("\n=== CAMPAIGNS (recent) ===");
  console.log(JSON.stringify(campaigns.map(pickCampaign), null, 2));

  const targets = await sql`
    SELECT id, company_id, name, color, deleted_at, created_at
    FROM public.campaigns
    WHERE name ILIKE '%tester%'
       OR name ILIKE 'teste%'
       OR name ILIKE '%teste dev campanha%'
    ORDER BY created_at DESC
  `;
  console.log("\n=== TARGET CAMPAIGNS (tester / teste / Teste DEV Campanha) ===");
  console.log(JSON.stringify(targets.map(pickCampaign), null, 2));

  if (targets.length > 0) {
    const sampleCompanyId = targets[0].company_id;
    const apiSample = await sql`
      SELECT
        c.id,
        c.campaign_reply_campaign_id AS campaign_id,
        COALESCE(cp.name, c.campaign_reply_campaign_name) AS campaign_name,
        CASE
          WHEN c.campaign_reply_campaign_id IS NOT NULL
           AND cp.color ~ '^#[0-9A-Fa-f]{6}$'
          THEN UPPER(cp.color)
          WHEN c.campaign_reply_campaign_id IS NOT NULL
          THEN '#6B7280'
          ELSE NULL
        END AS campaign_color
      FROM public.conversations c
      LEFT JOIN public.campaigns cp
        ON cp.id = c.campaign_reply_campaign_id
       AND cp.company_id = c.company_id
       AND cp.deleted_at IS NULL
      WHERE c.company_id = ${sampleCompanyId}::uuid
        AND c.campaign_reply_campaign_id IS NOT NULL
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT 3
    `;
    console.log("\n=== API-SHAPED SAMPLE ===");
    console.log(JSON.stringify(apiSample, null, 2));
  }
} finally {
  await sql.end();
}
