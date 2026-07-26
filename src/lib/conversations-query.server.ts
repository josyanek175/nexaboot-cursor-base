/**
 * Consultas de conversas com filtros de fila de campanha (server-side).
 */
import { sql } from "@/lib/pg.server";
import { normalizeCampaignColor } from "@/lib/campaign-color.server";
import {
  resolveCampaignServiceStatus,
  type CampaignServiceStatus,
} from "@/lib/campaign-service-status.server";

export type ConversationListFilters = {
  campaignQueue?: boolean;
  campaignServiceStatus?: string;
  campaignId?: string;
  campaignColor?: string;
  channelType?: string;
  assignedUserId?: string;
  campaignReplyIntent?: string;
  unreadOnly?: boolean;
  dateFrom?: string;
  dateTo?: string;
  countsOnly?: boolean;
};

export type CampaignQueueCounts = {
  awaiting_reply: number;
  interested: number;
  in_service: number;
  answered: number;
  not_interested: number;
  opt_out: number;
  total: number;
};

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** Expressão SQL compartilhada: cor efetiva da campanha (JOIN + fallback payload outbound). */
const campaignColorExpr = sql`
  CASE
    WHEN c.campaign_reply_campaign_id IS NULL THEN NULL
    WHEN cp.color ~ '^#[0-9A-Fa-f]{6}$' THEN UPPER(cp.color)
    ELSE COALESCE(
      (
        SELECT UPPER(m.raw_payload->>'campaign_color')
        FROM public.messages m
        WHERE m.conversation_id = c.id
          AND m.direction = 'out'
          AND m.raw_payload->>'origin' = 'CAMPANHA'
          AND m.raw_payload->>'campaign_color' ~ '^#[0-9A-Fa-f]{6}$'
        ORDER BY m.created_at DESC
        LIMIT 1
      ),
      '#6B7280'
    )
  END
`;

export async function getCampaignQueueCounts(companyId: string): Promise<CampaignQueueCounts> {
  const s = sql();
  const rows = await s<
    {
      awaiting_reply: string;
      interested: string;
      in_service: string;
      answered: string;
      not_interested: string;
      opt_out: string;
      total: string;
    }[]
  >`
    SELECT
      COUNT(*) FILTER (
        WHERE campaign_service_status = 'awaiting_reply'
      )::text AS awaiting_reply,
      COUNT(*) FILTER (
        WHERE campaign_reply_intent = 'interested'
          AND campaign_service_status IN ('awaiting_reply', 'in_service', 'answered')
      )::text AS interested,
      COUNT(*) FILTER (
        WHERE campaign_service_status = 'in_service'
      )::text AS in_service,
      COUNT(*) FILTER (
        WHERE campaign_service_status = 'answered'
      )::text AS answered,
      COUNT(*) FILTER (
        WHERE campaign_service_status = 'not_interested'
      )::text AS not_interested,
      COUNT(*) FILTER (
        WHERE campaign_service_status = 'opt_out'
      )::text AS opt_out,
      COUNT(*)::text AS total
    FROM public.conversations c
    WHERE c.company_id = ${companyId}::uuid
      AND c.campaign_reply_campaign_id IS NOT NULL
      AND c.status IS DISTINCT FROM 'merged'
      AND c.status IS DISTINCT FROM 'archived'
  `;
  const r = rows[0];
  return {
    awaiting_reply: Number(r?.awaiting_reply ?? 0),
    interested: Number(r?.interested ?? 0),
    in_service: Number(r?.in_service ?? 0),
    answered: Number(r?.answered ?? 0),
    not_interested: Number(r?.not_interested ?? 0),
    opt_out: Number(r?.opt_out ?? 0),
    total: Number(r?.total ?? 0),
  };
}

export async function listConversationsForCompany(opts: {
  companyId: string;
  currentUserId: string;
  filters: ConversationListFilters;
  limit?: number;
}) {
  const s = sql();
  const f = opts.filters;
  const limit = opts.limit ?? 500;
  const campaignQueue = f.campaignQueue === true;

  const campaignServiceStatus =
    f.campaignServiceStatus && f.campaignServiceStatus !== "interested"
      ? f.campaignServiceStatus
      : null;

  const campaignId = f.campaignId && isUuid(f.campaignId) ? f.campaignId : null;
  const campaignColor = f.campaignColor ? normalizeCampaignColor(f.campaignColor) : null;
  const channelType = f.channelType?.trim() || null;
  const assignedUserId =
    f.assignedUserId && f.assignedUserId !== "unassigned" && isUuid(f.assignedUserId)
      ? f.assignedUserId
      : null;
  const unassignedOnly = f.assignedUserId === "unassigned";
  const campaignReplyIntent = f.campaignReplyIntent?.trim() || null;
  const unreadOnly = f.unreadOnly === true;
  const dateFrom = f.dateFrom?.trim() || null;
  const dateTo = f.dateTo?.trim() || null;

  const interestedFilter = f.campaignServiceStatus === "interested";

  const orderClause = campaignQueue
    ? sql`
        ORDER BY
          c.campaign_last_inbound_at ASC NULLS LAST,
          CASE WHEN c.campaign_reply_intent = 'interested' THEN 0 ELSE 1 END,
          CASE WHEN a.user_id IS NULL THEN 0 ELSE 1 END,
          c.unread_count DESC,
          c.campaign_last_inbound_at ASC NULLS LAST
      `
    : sql`ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC`;

  const rows = await s<
    Record<string, unknown>[]
  >`
    SELECT
      c.id,
      c.status,
      c.unread_count,
      c.last_message,
      c.last_message_at,
      c.company_id,
      c.contact_id,
      c.whatsapp_channel_id,
      ct.name  AS contact_name,
      ct.phone AS phone,
      ct.external_jid,
      ct.contact_type,
      ch.name  AS channel_name,
      ch.channel_type,
      ch.evolution_instance_name,
      a.user_id AS assigned_user_id,
      au.name   AS assigned_user_name,
      au.email  AS assigned_user_email,
      a.assigned_at,
      CASE
        WHEN a.user_id IS NOT NULL AND a.user_id = ${opts.currentUserId}::uuid THEN true
        ELSE false
      END AS is_mine,
      c.campaign_reply_campaign_id,
      c.campaign_reply_campaign_name,
      c.campaign_reply_text,
      c.campaign_reply_intent,
      c.campaign_reply_at,
      c.campaign_service_status,
      c.campaign_last_inbound_at,
      c.campaign_last_human_reply_at,
      cp.id AS campaign_id,
      COALESCE(cp.name, c.campaign_reply_campaign_name) AS campaign_name,
      ${campaignColorExpr} AS campaign_color,
      CASE
        WHEN c.campaign_last_inbound_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (now() - c.campaign_last_inbound_at))::int
        ELSE NULL
      END AS waiting_duration_seconds
    FROM public.conversations c
    JOIN public.contacts ct ON ct.id = c.contact_id
    JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
    LEFT JOIN public.campaigns cp
      ON cp.id = c.campaign_reply_campaign_id
      AND cp.company_id = c.company_id
      AND cp.deleted_at IS NULL
    LEFT JOIN public.conversation_assignments a
      ON a.conversation_id = c.id
      AND a.active = true
      AND a.unassigned_at IS NULL
    LEFT JOIN public.users au ON au.id = a.user_id
    WHERE c.company_id = ${opts.companyId}::uuid
      AND c.status IS DISTINCT FROM 'merged'
      AND c.status IS DISTINCT FROM 'archived'
      AND ct.status IS DISTINCT FROM 'merged'
      AND (${campaignQueue}::boolean = false OR c.campaign_reply_campaign_id IS NOT NULL)
      AND (${campaignServiceStatus}::text IS NULL OR c.campaign_service_status = ${campaignServiceStatus})
      AND (${interestedFilter}::boolean = false OR c.campaign_reply_intent = 'interested')
      AND (${campaignId}::uuid IS NULL OR c.campaign_reply_campaign_id = ${campaignId}::uuid)
      AND (${campaignColor}::text IS NULL OR ${campaignColorExpr} = ${campaignColor})
      AND (${channelType}::text IS NULL OR lower(ch.channel_type) = lower(${channelType}))
      AND (${assignedUserId}::uuid IS NULL OR a.user_id = ${assignedUserId}::uuid)
      AND (${unassignedOnly}::boolean = false OR a.user_id IS NULL)
      AND (${campaignReplyIntent}::text IS NULL OR c.campaign_reply_intent = ${campaignReplyIntent})
      AND (${unreadOnly}::boolean = false OR COALESCE(c.unread_count, 0) > 0)
      AND (${dateFrom}::date IS NULL OR c.last_message_at::date >= ${dateFrom}::date)
      AND (${dateTo}::date IS NULL OR c.last_message_at::date <= ${dateTo}::date)
    ${orderClause}
    LIMIT ${limit}
  `;

  return rows.map((c) => {
    const hasCampaign = !!c.campaign_reply_campaign_id;
    const resolvedStatus = resolveCampaignServiceStatus(
      c.campaign_service_status as string | null,
      c.status as string | null,
      hasCampaign,
    );
    const rawColor = c.campaign_color as string | null | undefined;
    const campaignColor = hasCampaign
      ? normalizeCampaignColor(rawColor ?? undefined)
      : null;
    return {
      id: c.id,
      status: c.status,
      unread_count: c.unread_count,
      last_message: c.last_message,
      last_message_at: c.last_message_at,
      company_id: c.company_id,
      contact_id: c.contact_id,
      whatsapp_channel_id: c.whatsapp_channel_id,
      contact_name: c.contact_name,
      phone: c.phone,
      external_jid: c.external_jid,
      contact_type: c.contact_type,
      channel_name: c.channel_name,
      channel_type: c.channel_type,
      evolution_instance_name: c.evolution_instance_name,
      assigned_user_id: c.assigned_user_id,
      assigned_user_name: c.assigned_user_name,
      assigned_user_email: c.assigned_user_email,
      assigned_at: c.assigned_at,
      is_mine: c.is_mine,
      campaign_reply_campaign_id: c.campaign_reply_campaign_id,
      campaign_reply_campaign_name: c.campaign_reply_campaign_name,
      campaign_reply_text: c.campaign_reply_text,
      campaign_reply_intent: c.campaign_reply_intent,
      campaign_reply_at: c.campaign_reply_at,
      campaign_service_status: resolvedStatus,
      campaign_last_inbound_at: c.campaign_last_inbound_at,
      campaign_last_human_reply_at: c.campaign_last_human_reply_at,
      waiting_duration_seconds: c.waiting_duration_seconds,
      campaign_id: hasCampaign ? c.campaign_id ?? c.campaign_reply_campaign_id : null,
      campaign_name: hasCampaign
        ? (c.campaign_name as string | null) ?? c.campaign_reply_campaign_name
        : null,
      campaign_color: campaignColor,
    };
  });
}
