/**
 * Consultas de conversas com filtros de fila de campanha (server-side).
 */
import { sql } from "@/lib/pg.server";
import { normalizeCampaignColor } from "@/lib/campaign-color.server";
import { resolveConversationCampaignVisual } from "@/lib/conversation-campaign-visual";
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

const UUID_TEXT_RE = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/** Cor/nome/id visuais resolvidos (reply → último outbound). */
const resolvedCampaignColorExpr = sql`
  CASE
    WHEN c.campaign_reply_campaign_id IS NOT NULL THEN
      CASE
        WHEN cp.color ~ '^#[0-9A-Fa-f]{6}$' THEN UPPER(cp.color)
        ELSE '#6B7280'
      END
    WHEN ocp_any.id IS NOT NULL THEN
      CASE
        WHEN ocp.color ~ '^#[0-9A-Fa-f]{6}$' THEN UPPER(ocp.color)
        WHEN last_camp_out.payload_campaign_color ~ '^#[0-9A-Fa-f]{6}$'
          THEN UPPER(last_camp_out.payload_campaign_color)
        WHEN ocp_any.color ~ '^#[0-9A-Fa-f]{6}$' THEN UPPER(ocp_any.color)
        ELSE '#6B7280'
      END
    ELSE NULL
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
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 100);
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
      cp.name AS reply_joined_campaign_name,
      cp.color AS reply_joined_campaign_color,
      last_camp_out.payload_campaign_id AS outbound_payload_campaign_id,
      last_camp_out.payload_campaign_name AS outbound_payload_campaign_name,
      last_camp_out.payload_campaign_color AS outbound_payload_campaign_color,
      ocp_any.id AS outbound_company_campaign_id,
      ocp_any.name AS outbound_company_campaign_name,
      ocp_any.color AS outbound_company_campaign_color,
      (ocp_any.deleted_at IS NOT NULL) AS outbound_company_campaign_deleted,
      CASE
        WHEN c.campaign_reply_campaign_id IS NOT NULL THEN c.campaign_reply_campaign_id
        WHEN ocp_any.id IS NOT NULL THEN ocp_any.id
        ELSE NULL
      END AS resolved_campaign_id,
      CASE
        WHEN c.campaign_reply_campaign_id IS NOT NULL
          THEN COALESCE(cp.name, c.campaign_reply_campaign_name)
        WHEN ocp_any.id IS NOT NULL
          THEN COALESCE(ocp.name, ocp_any.name, last_camp_out.payload_campaign_name)
        ELSE NULL
      END AS resolved_campaign_name,
      ${resolvedCampaignColorExpr} AS resolved_campaign_color,
      CASE
        WHEN c.campaign_last_inbound_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (now() - c.campaign_last_inbound_at))::int
        ELSE NULL
      END AS waiting_duration_seconds
    FROM public.conversations c
    JOIN public.contacts ct ON ct.id = c.contact_id
    JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
    LEFT JOIN LATERAL (
      SELECT
        NULLIF(m.raw_payload->>'campaign_id', '') AS payload_campaign_id,
        NULLIF(m.raw_payload->>'campaign_name', '') AS payload_campaign_name,
        NULLIF(m.raw_payload->>'campaign_color', '') AS payload_campaign_color
      FROM public.messages m
      WHERE m.conversation_id = c.id
        AND m.direction = 'out'
        AND m.raw_payload->>'origin' = 'CAMPANHA'
      ORDER BY m.created_at DESC
      LIMIT 1
    ) last_camp_out ON true
    LEFT JOIN public.campaigns cp
      ON cp.id = c.campaign_reply_campaign_id
      AND cp.company_id = c.company_id
      AND cp.deleted_at IS NULL
    LEFT JOIN public.campaigns ocp_any
      ON c.campaign_reply_campaign_id IS NULL
      AND last_camp_out.payload_campaign_id ~ ${UUID_TEXT_RE}
      AND ocp_any.id = last_camp_out.payload_campaign_id::uuid
      AND ocp_any.company_id = c.company_id
    LEFT JOIN public.campaigns ocp
      ON ocp.id = ocp_any.id
      AND ocp.deleted_at IS NULL
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
      AND (${campaignColor}::text IS NULL OR ${resolvedCampaignColorExpr} = ${campaignColor})
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
    const hasCampaignReply = !!c.campaign_reply_campaign_id;
    const resolvedStatus = resolveCampaignServiceStatus(
      c.campaign_service_status as string | null,
      c.status as string | null,
      hasCampaignReply,
    );
    const visual = resolveConversationCampaignVisual({
      campaign_reply_campaign_id: c.campaign_reply_campaign_id as string | null,
      campaign_reply_campaign_name: c.campaign_reply_campaign_name as string | null,
      reply_joined_campaign_name: c.reply_joined_campaign_name as string | null,
      reply_joined_campaign_color: c.reply_joined_campaign_color as string | null,
      outbound_payload_campaign_id: c.outbound_payload_campaign_id as string | null,
      outbound_payload_campaign_name: c.outbound_payload_campaign_name as string | null,
      outbound_payload_campaign_color: c.outbound_payload_campaign_color as string | null,
      outbound_company_campaign_id: c.outbound_company_campaign_id as string | null,
      outbound_company_campaign_name: c.outbound_company_campaign_name as string | null,
      outbound_company_campaign_color: c.outbound_company_campaign_color as string | null,
      outbound_company_campaign_deleted: c.outbound_company_campaign_deleted as boolean | null,
    });

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
      resolved_campaign_id: visual.resolved_campaign_id,
      resolved_campaign_name: visual.resolved_campaign_name,
      resolved_campaign_color: visual.resolved_campaign_color,
      campaign_id: visual.resolved_campaign_id,
      campaign_name: visual.resolved_campaign_name,
      campaign_color: visual.resolved_campaign_color,
    };
  });
}

export { resolveConversationCampaignVisual };
