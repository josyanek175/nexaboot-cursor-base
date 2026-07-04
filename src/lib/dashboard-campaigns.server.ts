// Indicadores consolidados de campanhas para o dashboard (últimos 30 dias).
import { sql } from "@/lib/pg.server";

export const DASHBOARD_CAMPAIGNS_DAYS = 30;

export type DashboardCampaignMetrics = {
  periodDays: number;
  messagesSent: number;
  responsesReceived: number;
  noResponse: number;
  interested: number;
  notInterested: number;
  optOut: number;
  sendErrors: number;
};

export type DashboardRecentCampaign = {
  id: string;
  name: string;
  status: string;
  totalSent: number;
  totalResponded: number;
  totalInterested: number;
  totalNoResponse: number;
  totalOptOut: number;
  createdAt: string;
};

export type DashboardCampaignsPayload = {
  metrics: DashboardCampaignMetrics;
  recentCampaigns: DashboardRecentCampaign[];
};

const EMPTY_METRICS: DashboardCampaignMetrics = {
  periodDays: DASHBOARD_CAMPAIGNS_DAYS,
  messagesSent: 0,
  responsesReceived: 0,
  noResponse: 0,
  interested: 0,
  notInterested: 0,
  optOut: 0,
  sendErrors: 0,
};

function toInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function getDashboardCampaigns(companyId: string): Promise<DashboardCampaignsPayload> {
  const db = sql();

  const since = new Date();
  since.setDate(since.getDate() - DASHBOARD_CAMPAIGNS_DAYS);

  try {
    const metricRows = await db<{
      messages_sent: number;
      responses_received: number;
      no_response: number;
      interested: number;
      not_interested: number;
      opt_out: number;
      send_errors: number;
    }[]>`
      SELECT
        COUNT(*) FILTER (
          WHERE cc.sent_at IS NOT NULL AND cc.sent_at >= ${since}
        )::int AS messages_sent,
        COUNT(*) FILTER (
          WHERE cc.responded_at IS NOT NULL AND cc.responded_at >= ${since}
        )::int AS responses_received,
        COUNT(*) FILTER (
          WHERE cc.sent_at IS NOT NULL
            AND cc.responded_at IS NULL
            AND cc.sent_at >= ${since}
        )::int AS no_response,
        COUNT(*) FILTER (
          WHERE cc.response_intent = 'interested'
            AND cc.responded_at IS NOT NULL
            AND cc.responded_at >= ${since}
        )::int AS interested,
        COUNT(*) FILTER (
          WHERE cc.response_intent = 'not_interested'
            AND cc.responded_at IS NOT NULL
            AND cc.responded_at >= ${since}
        )::int AS not_interested,
        COUNT(*) FILTER (
          WHERE cc.response_intent = 'opt_out'
            AND cc.responded_at IS NOT NULL
            AND cc.responded_at >= ${since}
        )::int AS opt_out,
        COUNT(*) FILTER (
          WHERE cc.status = 'failed'
            AND COALESCE(cc.sent_at, cc.created_at) >= ${since}
        )::int AS send_errors
      FROM public.campaign_contacts cc
      WHERE cc.company_id = ${companyId}::uuid
    `;

    const row = metricRows[0];
    const metrics: DashboardCampaignMetrics = {
      periodDays: DASHBOARD_CAMPAIGNS_DAYS,
      messagesSent: toInt(row?.messages_sent),
      responsesReceived: toInt(row?.responses_received),
      noResponse: toInt(row?.no_response),
      interested: toInt(row?.interested),
      notInterested: toInt(row?.not_interested),
      optOut: toInt(row?.opt_out),
      sendErrors: toInt(row?.send_errors),
    };

    const recentRows = await db<{
      id: string;
      name: string;
      status: string;
      created_at: string;
      total_sent: number;
      total_responded: number;
      total_interested: number;
      total_no_response: number;
      total_opt_out: number;
    }[]>`
      SELECT
        c.id,
        c.name,
        c.status,
        c.created_at,
        COUNT(*) FILTER (WHERE cc.sent_at IS NOT NULL)::int AS total_sent,
        COUNT(*) FILTER (WHERE cc.responded_at IS NOT NULL)::int AS total_responded,
        COUNT(*) FILTER (WHERE cc.response_intent = 'interested')::int AS total_interested,
        COUNT(*) FILTER (
          WHERE cc.sent_at IS NOT NULL AND cc.responded_at IS NULL
        )::int AS total_no_response,
        COUNT(*) FILTER (WHERE cc.response_intent = 'opt_out')::int AS total_opt_out
      FROM public.campaigns c
      LEFT JOIN public.campaign_contacts cc
        ON cc.campaign_id = c.id
        AND cc.company_id = c.company_id
      WHERE c.company_id = ${companyId}::uuid
        AND c.deleted_at IS NULL
      GROUP BY c.id, c.name, c.status, c.created_at
      ORDER BY c.created_at DESC
      LIMIT 5
    `;

    const recentCampaigns: DashboardRecentCampaign[] = (recentRows ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      totalSent: toInt(c.total_sent),
      totalResponded: toInt(c.total_responded),
      totalInterested: toInt(c.total_interested),
      totalNoResponse: toInt(c.total_no_response),
      totalOptOut: toInt(c.total_opt_out),
      createdAt: c.created_at,
    }));

    return { metrics, recentCampaigns };
  } catch (e) {
    const err = e as Error;
    console.error("[DASHBOARD_CAMPAIGNS_FAIL]", {
      companyId,
      message: err.message,
      stack: err.stack,
    });
    return { metrics: { ...EMPTY_METRICS }, recentCampaigns: [] };
  }
}
