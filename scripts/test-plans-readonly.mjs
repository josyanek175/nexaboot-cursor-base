/** SELECTs read-only — sem DDL. Uso: DATABASE_URL=... node scripts/test-plans-readonly.mjs */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL não definida.");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

try {
  const [conn] = await sql`
    SELECT current_database() AS db, current_user AS usr,
           inet_server_addr()::text AS host
  `;
  console.log("CONEXAO:", conn);

  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('plans', 'company_subscriptions', 'companies', 'whatsapp_channels')
    ORDER BY table_name
  `;
  console.log("TABELAS:", tables.map((t) => t.table_name));

  const cols = await sql`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('plans', 'company_subscriptions')
    ORDER BY table_name, ordinal_position
  `;
  console.log("\nCOLUNAS:");
  for (const c of cols) console.log(`  ${c.table_name}.${c.column_name} (${c.data_type})`);

  const expectedPlans = [
    "id", "name", "code", "description", "max_whatsapp_channels",
    "max_users", "max_messages_month", "max_campaigns_month",
    "allow_automations", "allow_internal_chat", "allow_api_access",
    "active", "created_at", "updated_at",
  ];
  const expectedSubs = [
    "id", "company_id", "plan_id", "status", "started_at",
    "ends_at", "canceled_at", "created_at", "updated_at",
  ];
  const planCols = cols.filter((c) => c.table_name === "plans").map((c) => c.column_name);
  const subCols = cols.filter((c) => c.table_name === "company_subscriptions").map((c) => c.column_name);
  const missingPlans = expectedPlans.filter((c) => !planCols.includes(c));
  const missingSubs = expectedSubs.filter((c) => !subCols.includes(c));
  console.log("\nFALTANDO plans:", missingPlans.length ? missingPlans : "(nenhum)");
  console.log("FALTANDO company_subscriptions:", missingSubs.length ? missingSubs : "(nenhum)");

  if (tables.some((t) => t.table_name === "plans")) {
    const plans = await sql`
      SELECT id, code, name, max_whatsapp_channels, active
      FROM public.plans
      ORDER BY max_whatsapp_channels ASC
    `;
    console.log("\nPLANOS (" + plans.length + "):", plans);
  } else {
    console.log("\nPLANOS: tabela public.plans NAO EXISTE (precisa deploy ensurePlansSchema)");
  }

  const channelCols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='whatsapp_channels'
  `;
  const chHasDeletedAt = channelCols.some((c) => c.column_name === "deleted_at");
  const channelCountExpr = chHasDeletedAt
    ? `(SELECT COUNT(*)::int FROM public.whatsapp_channels ch WHERE ch.company_id = c.id AND ch.deleted_at IS NULL)`
    : `(SELECT COUNT(*)::int FROM public.whatsapp_channels ch WHERE ch.company_id = c.id)`;

  const companies = await sql.unsafe(`
    SELECT
      c.id,
      c.name,
      p.name AS plan_name,
      p.code AS plan_code,
      p.max_whatsapp_channels,
      cs.status AS subscription_status,
      ${channelCountExpr} AS whatsapp_channels_used
    FROM public.companies c
    LEFT JOIN LATERAL (
      SELECT cs2.status, cs2.ends_at, cs2.plan_id
      FROM public.company_subscriptions cs2
      WHERE cs2.company_id = c.id AND cs2.status = 'active'
      ORDER BY cs2.started_at DESC
      LIMIT 1
    ) cs ON true
    LEFT JOIN public.plans p ON p.id = cs.plan_id
    ORDER BY c.name ASC
  `);
  console.log("\nEMPRESAS + PLANO/USO (deleted_at=" + chHasDeletedAt + "):", companies);

  const subs = await sql`
    SELECT cs.id, c.name AS empresa, p.code AS plano, cs.status
    FROM public.company_subscriptions cs
    JOIN public.companies c ON c.id = cs.company_id
    JOIN public.plans p ON p.id = cs.plan_id
    ORDER BY c.name
    LIMIT 20
  `.catch((e) => ({ error: e.message }));
  if (subs.error) console.log("\nASSINATURAS ERRO:", subs.error);
  else console.log("\nASSINATURAS:", subs);

  console.log("\nOK — SELECTs read-only concluídos.");
} catch (e) {
  console.error("FALHA:", e.message);
  if (e.code) console.error("code:", e.code);
  process.exit(1);
} finally {
  await sql.end();
}
