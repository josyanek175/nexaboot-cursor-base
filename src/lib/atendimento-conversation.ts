/**
 * Transformação e helpers da lista de conversas no Atendimento (client-safe).
 */
import { normalizeCampaignColor, DEFAULT_CAMPAIGN_COLOR } from "@/lib/campaign-color";

export type ConversationStatus = "open" | "waiting" | "finished";

export type AtendimentoConversation = {
  id: string;
  tenantId: string;
  channelId: string;
  contactId: string;
  status: ConversationStatus;
  unreadCount: number;
  assignedTo?: string | null;
  assignedUserName?: string | null;
  isMine?: boolean;
  lastMessageAt: string;
  tags: string[];
  campaignReplyCampaignId?: string | null;
  campaignReplyCampaignName?: string | null;
  campaignReplyText?: string | null;
  campaignReplyIntent?: string | null;
  campaignColor?: string | null;
  campaignServiceStatus?: string | null;
  campaignLastInboundAt?: string | null;
  waitingDurationSeconds?: number;
  resolvedCampaignId?: string | null;
  resolvedCampaignName?: string | null;
  resolvedCampaignColor?: string | null;
};

export function mapApiStatus(s: unknown): ConversationStatus {
  if (s === "waiting" || s === "pending") return "waiting";
  if (s === "closed" || s === "finished" || s === "resolved") return "finished";
  return "open";
}

/** Mapeia payload da API → conversa local sem perder campos resolvidos. */
export function transformApiConversation(
  c: Record<string, unknown>,
  tenantId: string,
): AtendimentoConversation {
  const assignedTo = (c.assigned_user_id as string | null | undefined) ?? null;
  const assignedName =
    (c.assigned_user_name as string | null | undefined) ??
    (c.assignedUserName as string | null | undefined) ??
    (c.assigned_user_email as string | null | undefined) ??
    null;

  const replyCampaignId =
    (c.campaign_reply_campaign_id as string | null | undefined) ?? null;

  const resolvedId =
    (c.resolved_campaign_id as string | null | undefined) ??
    (c.resolvedCampaignId as string | null | undefined) ??
    (c.campaign_id as string | null | undefined) ??
    null;

  const resolvedName =
    (c.resolved_campaign_name as string | null | undefined) ??
    (c.resolvedCampaignName as string | null | undefined) ??
    (c.campaign_name as string | null | undefined) ??
    null;

  const rawResolvedColor =
    (c.resolved_campaign_color as string | null | undefined) ??
    (c.resolvedCampaignColor as string | null | undefined) ??
    (c.campaign_color as string | null | undefined) ??
    null;

  const resolvedColor = resolvedId
    ? normalizeCampaignColor(rawResolvedColor ?? DEFAULT_CAMPAIGN_COLOR)
    : null;

  const apiCampaignColor =
    (c.campaign_color as string | null | undefined) ??
    (c.campaignColor as string | null | undefined) ??
    null;

  return {
    id: String(c.id ?? ""),
    tenantId,
    channelId: String(c.whatsapp_channel_id ?? ""),
    contactId: String(c.contact_id ?? ""),
    status: mapApiStatus(c.status),
    unreadCount: typeof c.unread_count === "number" ? c.unread_count : 0,
    assignedTo,
    assignedUserName: assignedTo ? assignedName : null,
    isMine: c.is_mine === true,
    lastMessageAt: String(c.last_message_at ?? new Date().toISOString()),
    tags: [],
    campaignReplyCampaignId: replyCampaignId,
    campaignReplyCampaignName:
      (c.campaign_reply_campaign_name as string | null | undefined) ?? null,
    campaignReplyText: (c.campaign_reply_text as string | null | undefined) ?? null,
    campaignReplyIntent: (c.campaign_reply_intent as string | null | undefined) ?? null,
    campaignColor: replyCampaignId
      ? normalizeCampaignColor(apiCampaignColor ?? DEFAULT_CAMPAIGN_COLOR)
      : null,
    campaignServiceStatus:
      (c.campaign_service_status as string | null | undefined) ?? null,
    campaignLastInboundAt:
      (c.campaign_last_inbound_at as string | null | undefined) ?? null,
    waitingDurationSeconds:
      typeof c.waiting_duration_seconds === "number"
        ? c.waiting_duration_seconds
        : undefined,
    resolvedCampaignId: resolvedId,
    resolvedCampaignName: resolvedName,
    resolvedCampaignColor: resolvedColor,
  };
}

export type ConversationRowCampaign = {
  campaignId: string | null;
  campaignName: string | null;
  campaignColor: string | null;
  hasCampaignVisual: boolean;
  hasCampaignQueue: boolean;
};

/** Campanha visual da linha lateral (reply → resolved → legacy). */
export function resolveConversationRowCampaign(
  conv: Pick<
    AtendimentoConversation,
    | "resolvedCampaignId"
    | "resolvedCampaignName"
    | "resolvedCampaignColor"
    | "campaignReplyCampaignId"
    | "campaignReplyCampaignName"
    | "campaignColor"
    | "campaignServiceStatus"
  >,
): ConversationRowCampaign {
  const campaignId =
    conv.resolvedCampaignId ?? conv.campaignReplyCampaignId ?? null;

  const campaignName =
    conv.resolvedCampaignName ?? conv.campaignReplyCampaignName ?? null;

  const campaignColor = campaignId
    ? normalizeCampaignColor(
        conv.resolvedCampaignColor ?? conv.campaignColor ?? DEFAULT_CAMPAIGN_COLOR,
      )
    : null;

  return {
    campaignId,
    campaignName,
    campaignColor,
    hasCampaignVisual: !!campaignId,
    hasCampaignQueue: !!campaignId || !!conv.campaignServiceStatus,
  };
}

export function campaignStatusLabel(status?: string | null): string {
  switch (status) {
    case "awaiting_reply":
      return "Não respondida";
    case "in_service":
      return "Em atendimento";
    case "answered":
      return "Respondida";
    case "completed":
      return "Finalizada";
    case "not_interested":
      return "Sem interesse";
    case "opt_out":
      return "Opt-out";
    default:
      return "Campanha";
  }
}

/** Status da fila com fallback seguro quando in_service sem atendente. */
export function campaignServiceStatusDisplay(
  conv: Pick<AtendimentoConversation, "campaignServiceStatus" | "assignedUserName">,
): string {
  const status = conv.campaignServiceStatus;
  if (status === "in_service") {
    const assignedName = conv.assignedUserName ?? null;
    return assignedName ? `Em atendimento por ${assignedName}` : "Em atendimento";
  }
  return campaignStatusLabel(status);
}

/** Filtro client-side por cor — nunca lança exceção. */
export function matchesCampaignColorFilter(
  conversation: Pick<AtendimentoConversation, "resolvedCampaignColor">,
  selectedCampaignColor: string | null | undefined,
): boolean {
  const normalizedSelectedColor = selectedCampaignColor
    ? normalizeCampaignColor(selectedCampaignColor)
    : null;
  if (!normalizedSelectedColor) return true;

  const conversationColor = conversation.resolvedCampaignColor
    ? normalizeCampaignColor(conversation.resolvedCampaignColor)
    : null;

  if (!conversationColor) return false;
  return conversationColor === normalizedSelectedColor;
}
