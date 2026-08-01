/**
 * EXPLAIN ANALYZE (somente leitura) — consultas principais de atendimento.
 *
 * NÃO cria índice. NÃO altera dados.
 *
 * Uso:
 *   DATABASE_URL=postgres://... node scripts/explain-conversations-queries.mjs
 *
 * Opcional:
 *   EXPLAIN_COMPANY_ID=<uuid>
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL não configurada — EXPLAIN skipped");
  process.exit(0);
}

if (/prod(uction)?/i.test(url) && !/hml|homolog|staging|local/i.test(url) && process.env.ALLOW_PROD_EXPLAIN !== "1") {
  console.error("ABORTADO: URL parece produção. Defina ALLOW_PROD_EXPLAIN=1 para forçar (read-only).");
  process.exit(1);
}

const sql = postgres(url, {
  max: 1,
  prepare: false,
  ssl:
    url.includes("sslmode=require") || url.includes("supabase") || url.includes("neon")
      ? "require"
      : undefined,
});

async function explain(label, querySql) {
  console.log("\n==========", label, "==========");
  const rows = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${querySql}`);
  for (const r of rows) {
    const line = Object.values(r)[0];
    console.log(line);
  }
}

async function main() {
  const companyRow = process.env.EXPLAIN_COMPANY_ID
    ? [{ id: process.env.EXPLAIN_COMPANY_ID }]
    : await sql`SELECT id FROM public.companies WHERE active = true LIMIT 1`;
  const companyId = companyRow[0]?.id;
  if (!companyId) {
    console.log("Nenhuma company — skip EXPLAIN");
    return;
  }

  const convRow = await sql`
    SELECT id FROM public.conversations
    WHERE company_id = ${companyId}::uuid
    LIMIT 1
  `;
  const convId = convRow[0]?.id;

  console.log("[EXPLAIN_CONTEXT]", {
    companyId: String(companyId).slice(0, 8) + "…",
    hasConversation: !!convId,
  });

  // Lista padrão (ORDER BY last_message_at) — candidatos a índice composto.
  await explain(
    "list conversations by company_id ORDER BY last_message_at LIMIT 100",
    `
    SELECT c.id, c.last_message_at, c.unread_count
    FROM public.conversations c
    JOIN public.contacts ct ON ct.id = c.contact_id
    JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
    WHERE c.company_id = '${companyId}'::uuid
      AND c.status IS DISTINCT FROM 'merged'
      AND c.status IS DISTINCT FROM 'archived'
      AND ct.status IS DISTINCT FROM 'merged'
    ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
    LIMIT 100
    `,
  );

  // Simula índice hipotético (apenas planner) — NÃO cria.
  await explain(
    "hypothetical: SET enable_seqscan=off for same list (if index existed)",
    `
    SELECT c.id, c.last_message_at
    FROM public.conversations c
    WHERE c.company_id = '${companyId}'::uuid
      AND c.status IS DISTINCT FROM 'merged'
      AND c.status IS DISTINCT FROM 'archived'
    ORDER BY c.last_message_at DESC NULLS LAST
    LIMIT 100
    `,
  );

  if (convId) {
    await explain(
      "list messages LIMIT 100 (no raw_payload)",
      `
      SELECT m.id, m.created_at, m.message_text
      FROM public.messages m
      WHERE m.conversation_id = '${convId}'::uuid
      ORDER BY m.created_at DESC
      LIMIT 100
      `,
    );
  }

  // Índices existentes
  const idxs = await sql`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN ('conversations', 'messages', 'contacts')
    ORDER BY tablename, indexname
  `;
  console.log("\n========== existing indexes ==========");
  for (const i of idxs) {
    console.log(`${i.indexname}: ${i.indexdef}`);
  }

  console.log("\n========== proposed index (NOT APPLIED) ==========");
  console.log(
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_company_last_message",
  );
  console.log(
    "  ON public.conversations (company_id, last_message_at DESC NULLS LAST);",
  );
  console.log("Apply only after reviewing EXPLAIN output above.");
}

main()
  .catch((e) => {
    console.error("[EXPLAIN_FAIL]", e.message ?? e);
    process.exit(1);
  })
  .finally(async () => {
    await sql.end({ timeout: 5 });
  });
