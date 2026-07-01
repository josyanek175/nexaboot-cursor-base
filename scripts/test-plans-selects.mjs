/**
 * Testa schema + SELECTs de planos/assinaturas.
 * Uso: DATABASE_URL=postgres://... node scripts/test-plans-selects.mjs
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL não definida.");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

const PLAN_SEEDS = [
  { code: "BASICO_1", name: "Plano Básico 1", max_whatsapp_channels: 1 },
  { code: "BASICO_2", name: "Plano Básico 2", max_whatsapp_channels: 2 },
  { code: "PRATA", name: "Plano Prata", max_whatsapp_channels: 5 },
  { code: "GOLD", name: "Plano Gold", max_whatsapp_channels: 10 },
  { code: "DIAMANTE", name: "Plano Diamante", max_whatsapp_channels: 20 },
];

async function ensureMinimalSchema() {
  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.companies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS public.whatsapp_channels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
      name TEXT,
      channel_type TEXT NOT NULL DEFAULT 'evolution',
      evolution_instance_name TEXT,
      status TEXT NOT NULL DEFAULT 'disconnected',
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // plans + subscriptions (mesmo DDL da app)
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      description TEXT,
      max_whatsapp_channels INT NOT NULL,
      max_users INT,
      max_messages_month INT,
      max_campaigns_month INT,
      allow_automations BOOLEAN NOT NULL DEFAULT false,
      allow_internal_chat BOOLEAN NOT NULL DEFAULT true,
      allow_api_access BOOLEAN NOT NULL DEFAULT false,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS public.company_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      plan_id UUID NOT NULL REFERENCES public.plans(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ends_at TIMESTAMPTZ,
      canceled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS max_whatsapp_channels INT;
    ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS allow_api_access BOOLEAN NOT NULL DEFAULT false;
    CREATE UNIQUE INDEX IF NOT EXISTS company_subscriptions_one_active
      ON public.company_subscriptions (company_id) WHERE status = 'active';
  `);
  for (const p of PLAN_SEEDS) {
    await sql`
      INSERT INTO public.plans (name, code, description, max_whatsapp_channels, active)
      VALUES (${p.name}, ${p.code}, ${`Até ${p.max_whatsapp_channels} número(s) WhatsApp`}, ${p.max_whatsapp_channels}, true)
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, max_whatsapp_channels = EXCLUDED.max_whatsapp_channels
    `;
  }
}

async function main() {
  console.log("1) ensureMinimalSchema...");
  await ensureMinimalSchema();

  console.log("2) SELECT plans...");
  const plans = await sql`SELECT id, code, name, max_whatsapp_channels FROM public.plans ORDER BY max_whatsapp_channels`;
  console.log(plans);

  console.log("3) INSERT empresa de teste + canal...");
  const [co] = await sql`
    INSERT INTO public.companies (name) VALUES ('Teste Planos')
    RETURNING id
  `;
  const companyId = co.id;
  const [plan] = await sql`SELECT id FROM public.plans WHERE code = 'PRATA' LIMIT 1`;
  await sql`
    INSERT INTO public.company_subscriptions (company_id, plan_id, status)
    SELECT ${companyId}, ${plan.id}, 'active'
    WHERE NOT EXISTS (
      SELECT 1 FROM public.company_subscriptions cs
      WHERE cs.company_id = ${companyId} AND cs.status = 'active'
    )
  `;
  await sql`
    INSERT INTO public.whatsapp_channels (company_id, name, channel_type, evolution_instance_name)
    VALUES (${companyId}, 'Canal 1', 'evolution', 'test-instance-1')
  `;

  console.log("4) SELECT listCompaniesWithPlanUsage (all)...");
  const listAll = await sql`
    SELECT
      c.id, c.name, c.active,
      p.name AS plan_name, p.code AS plan_code, p.max_whatsapp_channels,
      cs.status AS subscription_status, cs.ends_at AS subscription_ends_at,
      (SELECT COUNT(*)::int FROM public.whatsapp_channels ch
       WHERE ch.company_id = c.id AND ch.deleted_at IS NULL) AS whatsapp_channels_used
    FROM public.companies c
    LEFT JOIN LATERAL (
      SELECT cs2.status, cs2.ends_at, cs2.plan_id
      FROM public.company_subscriptions cs2
      WHERE cs2.company_id = c.id AND cs2.status = 'active'
      ORDER BY cs2.started_at DESC LIMIT 1
    ) cs ON true
    LEFT JOIN public.plans p ON p.id = cs.plan_id
    WHERE (NULL::uuid IS NULL OR c.id = NULL::uuid)
    ORDER BY c.name ASC
  `;
  console.log(listAll);

  console.log("5) SELECT listCompaniesWithPlanUsage (filter)...");
  const listOne = await sql`
    SELECT c.id, c.name, p.name AS plan_name,
      (SELECT COUNT(*)::int FROM public.whatsapp_channels ch
       WHERE ch.company_id = c.id AND ch.deleted_at IS NULL) AS whatsapp_channels_used
    FROM public.companies c
    LEFT JOIN LATERAL (
      SELECT cs2.status, cs2.ends_at, cs2.plan_id
      FROM public.company_subscriptions cs2
      WHERE cs2.company_id = c.id AND cs2.status = 'active'
      ORDER BY cs2.started_at DESC LIMIT 1
    ) cs ON true
    LEFT JOIN public.plans p ON p.id = cs.plan_id
    WHERE c.id = ${companyId}::uuid
  `;
  console.log(listOne);

  console.log("6) SELECT getActiveSubscription...");
  const sub = await sql`
    SELECT cs.id, cs.company_id, cs.status, p.name, p.max_whatsapp_channels
    FROM public.company_subscriptions cs
    INNER JOIN public.plans p ON p.id = cs.plan_id
    WHERE cs.company_id = ${companyId}::uuid AND cs.status = 'active'
    LIMIT 1
  `;
  console.log(sub);

  console.log("7) information_schema columns...");
  const cols = await sql`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('plans', 'company_subscriptions', 'companies', 'whatsapp_channels')
    ORDER BY table_name, ordinal_position
  `;
  console.log(cols);

  console.log("\nOK — todos os SELECTs executaram sem erro.");
  await sql.end();
}

main().catch(async (e) => {
  console.error("FALHA:", e);
  await sql.end();
  process.exit(1);
});
