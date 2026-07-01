// Planos comerciais e assinaturas por empresa (server-only).
// Fase 1: leitura e exibição — sem bloqueio de login/canais.
import { sql, ensureCrmSchema } from "@/lib/pg.server";

export interface PlanRow {
  id: string;
  name: string;
  code: string;
  description: string | null;
  max_whatsapp_channels: number;
  max_users: number | null;
  max_messages_month: number | null;
  max_campaigns_month: number | null;
  allow_automations: boolean;
  allow_internal_chat: boolean;
  allow_api_access: boolean;
  active: boolean;
}

export interface ActiveSubscriptionRow {
  id: string;
  company_id: string;
  plan_id: string;
  status: string;
  started_at: string;
  ends_at: string | null;
  canceled_at: string | null;
}

export interface CompanyPlanUsage {
  company_id: string;
  subscription: ActiveSubscriptionRow | null;
  plan: PlanRow | null;
  usage: {
    whatsapp_channels: number;
  };
}

let _channelsHaveDeletedAt: boolean | null = null;

/** Detecta se whatsapp_channels.deleted_at existe (banco legado sem migração CRM completa). */
async function channelsHaveDeletedAtColumn(): Promise<boolean> {
  if (_channelsHaveDeletedAt !== null) return _channelsHaveDeletedAt;
  const rows = await sql`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'whatsapp_channels'
      AND column_name = 'deleted_at'
    LIMIT 1
  `;
  _channelsHaveDeletedAt = rows.length > 0;
  return _channelsHaveDeletedAt;
}

/** Subquery de contagem de canais por empresa (compatível com/sem deleted_at). */
async function channelCountSubquery() {
  const hasDeletedAt = await channelsHaveDeletedAtColumn();
  return hasDeletedAt
    ? sql`(
        SELECT COUNT(*)::int
        FROM public.whatsapp_channels ch
        WHERE ch.company_id = c.id AND ch.deleted_at IS NULL
      )`
    : sql`(
        SELECT COUNT(*)::int
        FROM public.whatsapp_channels ch
        WHERE ch.company_id = c.id
      )`;
}

/** Canais que ocupam slot do plano. Usa deleted_at quando a coluna existir. */
export async function countActiveWhatsAppChannels(companyId: string): Promise<number> {
  await ensureCrmSchema();
  const hasDeletedAt = await channelsHaveDeletedAtColumn();
  const rows = hasDeletedAt
    ? await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM public.whatsapp_channels
        WHERE company_id = ${companyId}::uuid
          AND deleted_at IS NULL
      `
    : await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM public.whatsapp_channels
        WHERE company_id = ${companyId}::uuid
      `;
  return Number(rows[0]?.count ?? 0);
}

/** Assinatura ativa mais recente da empresa, com dados do plano. */
export async function getActiveSubscription(
  companyId: string,
): Promise<{ subscription: ActiveSubscriptionRow; plan: PlanRow } | null> {
  await ensureCrmSchema();
  const rows = await sql<
    ActiveSubscriptionRow &
      PlanRow & { plan_pk: string }
  >`
    SELECT
      cs.id,
      cs.company_id,
      cs.plan_id,
      cs.status,
      cs.started_at,
      cs.ends_at,
      cs.canceled_at,
      p.id AS plan_pk,
      p.name,
      p.code,
      p.description,
      p.max_whatsapp_channels,
      p.max_users,
      p.max_messages_month,
      p.max_campaigns_month,
      p.allow_automations,
      p.allow_internal_chat,
      p.allow_api_access,
      p.active
    FROM public.company_subscriptions cs
    INNER JOIN public.plans p ON p.id = cs.plan_id
    WHERE cs.company_id = ${companyId}::uuid
      AND cs.status = 'active'
    ORDER BY cs.started_at DESC
    LIMIT 1
  `;
  const r = rows[0];
  if (!r) return null;

  const subscription: ActiveSubscriptionRow = {
    id: r.id,
    company_id: r.company_id,
    plan_id: r.plan_id,
    status: r.status,
    started_at: r.started_at,
    ends_at: r.ends_at,
    canceled_at: r.canceled_at,
  };
  const plan: PlanRow = {
    id: r.plan_pk,
    name: r.name,
    code: r.code,
    description: r.description,
    max_whatsapp_channels: r.max_whatsapp_channels,
    max_users: r.max_users,
    max_messages_month: r.max_messages_month,
    max_campaigns_month: r.max_campaigns_month,
    allow_automations: r.allow_automations,
    allow_internal_chat: r.allow_internal_chat,
    allow_api_access: r.allow_api_access,
    active: r.active,
  };
  return { subscription, plan };
}

/** Plano ativo + consumo de canais WhatsApp da empresa. */
export async function getCompanyPlanUsage(companyId: string): Promise<CompanyPlanUsage> {
  const [active, whatsapp_channels] = await Promise.all([
    getActiveSubscription(companyId),
    countActiveWhatsAppChannels(companyId),
  ]);
  return {
    company_id: companyId,
    subscription: active?.subscription ?? null,
    plan: active?.plan ?? null,
    usage: { whatsapp_channels },
  };
}

export interface CompanyListSubscriptionSummary {
  plan_name: string | null;
  plan_code: string | null;
  max_whatsapp_channels: number | null;
  subscription_status: string | null;
  whatsapp_channels_used: number;
}

/** Lista empresas com resumo de plano/uso (uma query). */
export async function listCompaniesWithPlanUsage(opts: {
  companyId?: string;
}): Promise<
  Array<{
    id: string;
    name: string;
    active: boolean;
    created_at: string;
    updated_at: string;
    plan_name: string | null;
    plan_code: string | null;
    max_whatsapp_channels: number | null;
    subscription_status: string | null;
    subscription_ends_at: string | null;
    whatsapp_channels_used: number;
  }>
> {
  await ensureCrmSchema();
  const filterId = opts.companyId ?? null;
  const channelCount = await channelCountSubquery();

  const rows = await sql`
    SELECT
      c.id,
      c.name,
      c.active,
      c.created_at,
      c.updated_at,
      p.name AS plan_name,
      p.code AS plan_code,
      p.max_whatsapp_channels,
      cs.status AS subscription_status,
      cs.ends_at AS subscription_ends_at,
      ${channelCount} AS whatsapp_channels_used
    FROM public.companies c
    LEFT JOIN LATERAL (
      SELECT cs2.status, cs2.ends_at, cs2.plan_id
      FROM public.company_subscriptions cs2
      WHERE cs2.company_id = c.id AND cs2.status = 'active'
      ORDER BY cs2.started_at DESC
      LIMIT 1
    ) cs ON true
    LEFT JOIN public.plans p ON p.id = cs.plan_id
    ${filterId ? sql`WHERE c.id = ${filterId}::uuid` : sql``}
    ORDER BY c.name ASC
  `;
  return rows as typeof rows & {
    id: string;
    name: string;
    active: boolean;
    created_at: string;
    updated_at: string;
    plan_name: string | null;
    plan_code: string | null;
    max_whatsapp_channels: number | null;
    subscription_status: string | null;
    subscription_ends_at: string | null;
    whatsapp_channels_used: number;
  }[];
}
