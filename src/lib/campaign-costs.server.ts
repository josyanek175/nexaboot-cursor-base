/**
 * Persistência de preços e agregação de disparos/custos por empresa.
 */
import { sql } from "@/lib/pg.server";
import type { PgSql } from "@/lib/pg-types";
import {
  DEFAULT_CAMPAIGN_COST_PRICES,
  estimateCostBrl,
  normalizeCampaignCostPrices,
  normalizeMetaCostCategory,
  resolveCostPeriod,
  unitPriceForCategory,
  type CampaignCostPeriodPreset,
  type CampaignCostPrices,
  type MetaCostCategory,
} from "@/lib/campaign-costs";

export type CampaignCostRow = {
  campaignId: string;
  campaignName: string;
  status: string;
  channelType: "meta" | "evolution" | string;
  channelName: string | null;
  category: MetaCostCategory | null;
  categoryLabel: string;
  sentCount: number;
  unitPriceBrl: number;
  estimatedCostBrl: number;
  firstSentAt: string | null;
  lastSentAt: string | null;
};

export type CampaignCostsSummary = {
  totalSent: number;
  metaSent: number;
  evolutionSent: number;
  estimatedCostBrl: number;
};

export type CampaignCostsPayload = {
  period: { from: string; to: string; preset: CampaignCostPeriodPreset };
  prices: CampaignCostPrices;
  summary: CampaignCostsSummary;
  campaigns: CampaignCostRow[];
};

let _costPricesReady: Promise<void> | null = null;

async function ensureCostPricesTable(db: PgSql): Promise<void> {
  if (_costPricesReady) return _costPricesReady;

  _costPricesReady = (async () => {
    try {
      await db.unsafe(`
        CREATE TABLE IF NOT EXISTS public.company_campaign_cost_prices (
          company_id UUID PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
          marketing_brl NUMERIC(12,4) NOT NULL DEFAULT 0.3217,
          utility_brl NUMERIC(12,4) NOT NULL DEFAULT 0.0350,
          authentication_brl NUMERIC(12,4) NOT NULL DEFAULT 0.0350,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL
        );
      `);
    } catch (e) {
      _costPricesReady = null;
      const msg = String((e as Error)?.message ?? e);
      if (/already exists/i.test(msg) || /duplicate key/i.test(msg) || /pg_type_typname/i.test(msg)) {
        return;
      }
      throw e;
    }
  })();

  return _costPricesReady;
}

export async function getCampaignCostPrices(
  companyId: string,
  db?: PgSql,
): Promise<CampaignCostPrices> {
  const s = db ?? sql();
  await ensureCostPricesTable(s);
  const rows = await s<
    {
      marketing_brl: string | number;
      utility_brl: string | number;
      authentication_brl: string | number;
    }[]
  >`
    SELECT marketing_brl, utility_brl, authentication_brl
    FROM public.company_campaign_cost_prices
    WHERE company_id = ${companyId}::uuid
    LIMIT 1
  `;
  if (!rows[0]) return { ...DEFAULT_CAMPAIGN_COST_PRICES };
  return normalizeCampaignCostPrices({
    marketingBrl: rows[0].marketing_brl,
    utilityBrl: rows[0].utility_brl,
    authenticationBrl: rows[0].authentication_brl,
  });
}

export async function saveCampaignCostPrices(
  companyId: string,
  userId: string | null,
  input: Partial<CampaignCostPrices>,
  db?: PgSql,
): Promise<CampaignCostPrices> {
  const s = db ?? sql();
  await ensureCostPricesTable(s);
  const current = await getCampaignCostPrices(companyId, s);
  const next = normalizeCampaignCostPrices({
    marketingBrl: input.marketingBrl ?? current.marketingBrl,
    utilityBrl: input.utilityBrl ?? current.utilityBrl,
    authenticationBrl: input.authenticationBrl ?? current.authenticationBrl,
  });

  await s`
    INSERT INTO public.company_campaign_cost_prices
      (company_id, marketing_brl, utility_brl, authentication_brl, updated_at, updated_by_user_id)
    VALUES (
      ${companyId}::uuid,
      ${next.marketingBrl},
      ${next.utilityBrl},
      ${next.authenticationBrl},
      now(),
      ${userId}::uuid
    )
    ON CONFLICT (company_id) DO UPDATE SET
      marketing_brl = EXCLUDED.marketing_brl,
      utility_brl = EXCLUDED.utility_brl,
      authentication_brl = EXCLUDED.authentication_brl,
      updated_at = now(),
      updated_by_user_id = EXCLUDED.updated_by_user_id
  `;

  return next;
}

function categoryLabel(
  channelType: string,
  category: MetaCostCategory | null,
): string {
  if (String(channelType).toLowerCase() !== "meta") return "—";
  if (category === "utility") return "Utilidade";
  if (category === "authentication") return "Autenticação";
  return "Marketing";
}

export async function getCampaignCostsReport(
  companyId: string,
  opts?: {
    preset?: string | null;
    from?: string | null;
    to?: string | null;
    db?: PgSql;
  },
): Promise<CampaignCostsPayload> {
  const s = opts?.db ?? sql();
  const period = resolveCostPeriod({
    preset: opts?.preset,
    from: opts?.from,
    to: opts?.to,
  });
  const prices = await getCampaignCostPrices(companyId, s);

  // Intervalo inclusivo em America/Sao_Paulo: [from 00:00, to+1 00:00).
  const rows = await s<
    {
      campaign_id: string;
      campaign_name: string;
      status: string;
      channel_type: string | null;
      channel_name: string | null;
      template_category: string | null;
      sent_count: number;
      first_sent_at: Date | string | null;
      last_sent_at: Date | string | null;
    }[]
  >`
    SELECT
      c.id AS campaign_id,
      c.name AS campaign_name,
      c.status,
      lower(COALESCE(wc.channel_type, CASE
        WHEN c.message_type = 'meta_template' OR c.meta_template_name IS NOT NULL THEN 'meta'
        ELSE 'evolution'
      END)) AS channel_type,
      wc.name AS channel_name,
      (
        SELECT mmt.category
        FROM public.meta_message_templates mmt
        WHERE mmt.company_id = c.company_id
          AND mmt.template_name = c.meta_template_name
          AND (
            c.meta_language_code IS NULL
            OR mmt.language_code = c.meta_language_code
          )
        ORDER BY mmt.updated_at DESC NULLS LAST
        LIMIT 1
      ) AS template_category,
      COUNT(*)::int AS sent_count,
      MIN(cc.sent_at) AS first_sent_at,
      MAX(cc.sent_at) AS last_sent_at
    FROM public.campaign_contacts cc
    INNER JOIN public.campaigns c
      ON c.id = cc.campaign_id
     AND c.company_id = cc.company_id
    LEFT JOIN public.whatsapp_channels wc
      ON wc.id = c.whatsapp_channel_id
    WHERE cc.company_id = ${companyId}::uuid
      AND cc.status = 'sent'
      AND cc.sent_at IS NOT NULL
      AND c.deleted_at IS NULL
      AND cc.sent_at >= (${period.from}::date AT TIME ZONE 'America/Sao_Paulo')
      AND cc.sent_at < ((${period.to}::date + 1) AT TIME ZONE 'America/Sao_Paulo')
    GROUP BY
      c.id, c.name, c.status, c.message_type, c.meta_template_name, c.meta_language_code,
      c.company_id, wc.channel_type, wc.name
    HAVING COUNT(*) > 0
    ORDER BY MAX(cc.sent_at) DESC NULLS LAST
  `;

  const campaigns: CampaignCostRow[] = [];
  let totalSent = 0;
  let metaSent = 0;
  let evolutionSent = 0;
  let estimatedCostBrl = 0;

  for (const r of rows) {
    const channelType = String(r.channel_type ?? "evolution").toLowerCase();
    const isMeta = channelType === "meta";
    const category = isMeta ? normalizeMetaCostCategory(r.template_category) : null;
    const sentCount = Number(r.sent_count ?? 0) || 0;
    const unitPriceBrl = unitPriceForCategory(category, prices, channelType);
    const cost = estimateCostBrl(sentCount, unitPriceBrl);

    totalSent += sentCount;
    if (isMeta) metaSent += sentCount;
    else evolutionSent += sentCount;
    estimatedCostBrl += cost;

    campaigns.push({
      campaignId: r.campaign_id,
      campaignName: r.campaign_name,
      status: r.status,
      channelType: isMeta ? "meta" : "evolution",
      channelName: r.channel_name,
      category,
      categoryLabel: categoryLabel(channelType, category),
      sentCount,
      unitPriceBrl,
      estimatedCostBrl: cost,
      firstSentAt: r.first_sent_at
        ? new Date(r.first_sent_at).toISOString()
        : null,
      lastSentAt: r.last_sent_at ? new Date(r.last_sent_at).toISOString() : null,
    });
  }

  return {
    period,
    prices,
    summary: {
      totalSent,
      metaSent,
      evolutionSent,
      estimatedCostBrl: Math.round(estimatedCostBrl * 100) / 100,
    },
    campaigns,
  };
}
