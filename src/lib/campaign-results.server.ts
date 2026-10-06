/**
 * Resultados de campanha: disparos, interagiram e interessados no período.
 */
import { sql } from "@/lib/pg.server";
import type { PgSql } from "@/lib/pg-types";
import { resolveCostPeriod, type CampaignCostPeriodPreset } from "@/lib/campaign-costs";
import { ratePercent } from "@/lib/campaign-metrics";

export type CampaignResultsRow = {
  campaignId: string;
  campaignName: string;
  status: string;
  sentCount: number;
  interactedCount: number;
  interestedCount: number;
  interactRate: number;
  interestedRate: number;
  lastSentAt: string | null;
};

export type CampaignResultsSummary = {
  sentCount: number;
  interactedCount: number;
  interestedCount: number;
  interactRate: number;
  interestedRate: number;
};

export type CampaignResultsPayload = {
  period: { from: string; to: string; preset: CampaignCostPeriodPreset };
  summary: CampaignResultsSummary;
  campaigns: CampaignResultsRow[];
};

export async function getCampaignResultsReport(
  companyId: string,
  opts?: {
    preset?: string | null;
    from?: string | null;
    to?: string | null;
    db?: PgSql;
  },
): Promise<CampaignResultsPayload> {
  const s = opts?.db ?? sql();
  const period = resolveCostPeriod({
    preset: opts?.preset,
    from: opts?.from,
    to: opts?.to,
  });

  const rows = await s<
    {
      campaign_id: string;
      campaign_name: string;
      status: string;
      sent_count: number;
      interacted_count: number;
      interested_count: number;
      last_sent_at: Date | string | null;
    }[]
  >`
    SELECT
      c.id AS campaign_id,
      c.name AS campaign_name,
      c.status,
      COUNT(*)::int AS sent_count,
      COUNT(*) FILTER (WHERE cc.responded_at IS NOT NULL)::int AS interacted_count,
      COUNT(*) FILTER (
        WHERE cc.response_intent = 'interested' AND cc.responded_at IS NOT NULL
      )::int AS interested_count,
      MAX(cc.sent_at) AS last_sent_at
    FROM public.campaigns c
    INNER JOIN public.campaign_contacts cc
      ON cc.campaign_id = c.id
     AND cc.company_id = c.company_id
    WHERE c.company_id = ${companyId}::uuid
      AND c.deleted_at IS NULL
      -- Inclui 'responded': após resposta o status deixa de ser 'sent'.
      AND cc.sent_at IS NOT NULL
      AND cc.status IN ('sent', 'responded')
      AND cc.sent_at >= (${period.from}::date AT TIME ZONE 'America/Sao_Paulo')
      AND cc.sent_at < ((${period.to}::date + 1) AT TIME ZONE 'America/Sao_Paulo')
    GROUP BY c.id, c.name, c.status
    ORDER BY MAX(cc.sent_at) DESC NULLS LAST
  `;

  const campaigns: CampaignResultsRow[] = rows.map((r) => {
    const sentCount = Number(r.sent_count ?? 0) || 0;
    const interactedCount = Number(r.interacted_count ?? 0) || 0;
    const interestedCount = Number(r.interested_count ?? 0) || 0;
    return {
      campaignId: r.campaign_id,
      campaignName: r.campaign_name,
      status: r.status,
      sentCount,
      interactedCount,
      interestedCount,
      interactRate: ratePercent(interactedCount, sentCount),
      interestedRate: ratePercent(interestedCount, sentCount),
      lastSentAt: r.last_sent_at ? new Date(r.last_sent_at).toISOString() : null,
    };
  });

  const sentCount = campaigns.reduce((acc, r) => acc + r.sentCount, 0);
  const interactedCount = campaigns.reduce((acc, r) => acc + r.interactedCount, 0);
  const interestedCount = campaigns.reduce((acc, r) => acc + r.interestedCount, 0);

  return {
    period,
    summary: {
      sentCount,
      interactedCount,
      interestedCount,
      interactRate: ratePercent(interactedCount, sentCount),
      interestedRate: ratePercent(interestedCount, sentCount),
    },
    campaigns,
  };
}
