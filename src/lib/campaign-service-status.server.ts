/**
 * Serviço central de transições de campaign_service_status.
 * Única camada responsável por awaiting_reply, in_service, answered,
 * completed, not_interested e opt_out.
 */
import { sql } from "@/lib/pg.server";
import type { ResponseIntent } from "@/lib/campaign-response.server";

export type CampaignServiceStatus =
  | "awaiting_reply"
  | "in_service"
  | "answered"
  | "completed"
  | "not_interested"
  | "opt_out";

export const CAMPAIGN_SERVICE_STATUSES: CampaignServiceStatus[] = [
  "awaiting_reply",
  "in_service",
  "answered",
  "completed",
  "not_interested",
  "opt_out",
];

export function isCampaignServiceStatus(v: string | null | undefined): v is CampaignServiceStatus {
  return !!v && (CAMPAIGN_SERVICE_STATUSES as string[]).includes(v);
}

/** Fallback seguro na leitura para conversas antigas sem status. */
export function resolveCampaignServiceStatus(
  raw: string | null | undefined,
  conversationStatus: string | null | undefined,
  hasCampaign: boolean,
): CampaignServiceStatus | null {
  if (!hasCampaign) return null;
  if (isCampaignServiceStatus(raw)) return raw;
  if (conversationStatus === "finished") return "completed";
  return "awaiting_reply";
}

const HUMAN_MESSAGE_TYPES = new Set(["text", "image", "audio", "document", "video"]);

export function isHumanOutboundMessage(row: {
  direction: string | null;
  sent_by_user_id: string | null;
  message_type: string | null;
  raw_payload: unknown;
}): boolean {
  const dir = String(row.direction ?? "").toLowerCase();
  if (dir !== "out") return false;
  if (!row.sent_by_user_id) return false;
  const mt = String(row.message_type ?? "").toLowerCase();
  if (mt === "system") return false;
  if (!HUMAN_MESSAGE_TYPES.has(mt)) return false;
  let payload: Record<string, unknown> | null = null;
  if (row.raw_payload && typeof row.raw_payload === "object" && !Array.isArray(row.raw_payload)) {
    payload = row.raw_payload as Record<string, unknown>;
  } else if (typeof row.raw_payload === "string") {
    try {
      payload = JSON.parse(row.raw_payload) as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  if (payload?.origin === "CAMPANHA") return false;
  return true;
}

/** Inbound de campanha — reabre fila e atualiza timestamps. */
export async function onCampaignInbound(opts: {
  companyId: string;
  conversationId: string;
  campaignId: string;
  campaignName: string;
  intent: ResponseIntent;
  responseText: string | null;
  inboundAt?: Date;
}): Promise<void> {
  const s = sql();
  const inboundAt = opts.inboundAt ?? new Date();
  const text = opts.responseText?.slice(0, 4000) ?? null;

  let serviceStatus: CampaignServiceStatus = "awaiting_reply";
  if (opts.intent === "opt_out") serviceStatus = "opt_out";
  else if (opts.intent === "not_interested") serviceStatus = "not_interested";

  await s`
    UPDATE public.conversations
    SET campaign_reply_campaign_id = ${opts.campaignId}::uuid,
        campaign_reply_campaign_name = ${opts.campaignName},
        campaign_reply_text = COALESCE(${text}, campaign_reply_text),
        campaign_reply_intent = ${opts.intent},
        campaign_reply_at = ${inboundAt},
        campaign_service_status = ${serviceStatus},
        campaign_last_inbound_at = ${inboundAt},
        campaign_last_human_reply_at = CASE
          WHEN ${serviceStatus} = 'awaiting_reply'
            AND campaign_last_human_reply_at IS NOT NULL
            AND campaign_last_human_reply_at < ${inboundAt}
          THEN NULL
          ELSE campaign_last_human_reply_at
        END,
        updated_at = now()
    WHERE id = ${opts.conversationId}::uuid
      AND company_id = ${opts.companyId}::uuid
  `;
}

/** Assumir conversa — mantém na fila como in_service. */
export async function onCampaignAssume(opts: {
  companyId: string;
  conversationId: string;
  /** Client da transação aberta (ex.: assumeConversation). Evita self-lock no pool. */
  db?: ReturnType<typeof sql>;
}): Promise<void> {
  const s = opts.db ?? sql();
  await s`
    UPDATE public.conversations
    SET campaign_service_status = CASE
          WHEN campaign_reply_campaign_id IS NOT NULL THEN 'in_service'
          ELSE campaign_service_status
        END,
        updated_at = now()
    WHERE id = ${opts.conversationId}::uuid
      AND company_id = ${opts.companyId}::uuid
      AND campaign_reply_campaign_id IS NOT NULL
  `;
}

/** Resposta humana do atendente após último inbound de campanha. */
export async function onHumanReply(opts: {
  companyId: string;
  conversationId: string;
  messageId: string;
  sentAt: Date;
}): Promise<boolean> {
  const s = sql();
  const rows = await s<
    {
      campaign_reply_campaign_id: string | null;
      campaign_last_inbound_at: Date | null;
      campaign_service_status: string | null;
    }[]
  >`
    SELECT campaign_reply_campaign_id, campaign_last_inbound_at, campaign_service_status
    FROM public.conversations
    WHERE id = ${opts.conversationId}::uuid
      AND company_id = ${opts.companyId}::uuid
    LIMIT 1
  `;
  const conv = rows[0];
  if (!conv?.campaign_reply_campaign_id) return false;

  const msgRows = await s<
    {
      direction: string;
      sent_by_user_id: string | null;
      message_type: string | null;
      raw_payload: unknown;
      created_at: Date;
    }[]
  >`
    SELECT direction, sent_by_user_id, message_type, raw_payload, created_at
    FROM public.messages
    WHERE id = ${opts.messageId}::uuid
    LIMIT 1
  `;
  const msg = msgRows[0];
  if (!msg || !isHumanOutboundMessage(msg)) return false;

  if (conv.campaign_last_inbound_at && msg.created_at <= conv.campaign_last_inbound_at) {
    return false;
  }

  await s`
    UPDATE public.conversations
    SET campaign_service_status = 'answered',
        campaign_last_human_reply_at = ${opts.sentAt},
        updated_at = now()
    WHERE id = ${opts.conversationId}::uuid
      AND company_id = ${opts.companyId}::uuid
      AND campaign_reply_campaign_id IS NOT NULL
  `;
  return true;
}

/** Finalizar atendimento — persiste finished + completed. */
export async function onCampaignFinish(opts: {
  companyId: string;
  conversationId: string;
}): Promise<void> {
  const s = sql();
  await s`
    UPDATE public.conversations
    SET status = 'finished',
        campaign_service_status = CASE
          WHEN campaign_reply_campaign_id IS NOT NULL THEN 'completed'
          ELSE campaign_service_status
        END,
        updated_at = now()
    WHERE id = ${opts.conversationId}::uuid
      AND company_id = ${opts.companyId}::uuid
  `;
}

/** Reabrir — deriva status conforme último inbound vs resposta humana. */
export function deriveReopenCampaignStatus(opts: {
  campaignLastInboundAt: Date | null;
  campaignLastHumanReplyAt: Date | null;
  hasActiveAssignment: boolean;
}): Promise<CampaignServiceStatus> {
  if (opts.hasActiveAssignment) return "in_service";
  const inbound = opts.campaignLastInboundAt?.getTime() ?? 0;
  const human = opts.campaignLastHumanReplyAt?.getTime() ?? 0;
  if (human > inbound) return "answered";
  return "awaiting_reply";
}

export async function onCampaignReopen(opts: {
  companyId: string;
  conversationId: string;
}): Promise<{ status: string; campaign_service_status: CampaignServiceStatus | null }> {
  const s = sql();
  const rows = await s<
    {
      campaign_reply_campaign_id: string | null;
      campaign_last_inbound_at: Date | null;
      campaign_last_human_reply_at: Date | null;
    }[]
  >`
    SELECT campaign_reply_campaign_id, campaign_last_inbound_at, campaign_last_human_reply_at
    FROM public.conversations
    WHERE id = ${opts.conversationId}::uuid
      AND company_id = ${opts.companyId}::uuid
    LIMIT 1
  `;
  const conv = rows[0];
  if (!conv) throw new Error("not_found");

  const assignRows = await s<{ user_id: string }[]>`
    SELECT user_id FROM public.conversation_assignments
    WHERE conversation_id = ${opts.conversationId}::uuid
      AND active = true
      AND unassigned_at IS NULL
    LIMIT 1
  `;
  const hasAssignment = !!assignRows[0];

  let campaignStatus: CampaignServiceStatus | null = null;
  if (conv.campaign_reply_campaign_id) {
    campaignStatus = deriveReopenCampaignStatus({
      campaignLastInboundAt: conv.campaign_last_inbound_at
        ? new Date(conv.campaign_last_inbound_at)
        : null,
      campaignLastHumanReplyAt: conv.campaign_last_human_reply_at
        ? new Date(conv.campaign_last_human_reply_at)
        : null,
      hasActiveAssignment: hasAssignment,
    });
  }

  await s`
    UPDATE public.conversations
    SET status = 'open',
        campaign_service_status = COALESCE(${campaignStatus}, campaign_service_status),
        updated_at = now()
    WHERE id = ${opts.conversationId}::uuid
      AND company_id = ${opts.companyId}::uuid
  `;

  return { status: "open", campaign_service_status: campaignStatus };
}

export async function markCampaignNotInterested(opts: {
  companyId: string;
  conversationId: string;
}): Promise<void> {
  const s = sql();
  await s`
    UPDATE public.conversations
    SET campaign_service_status = 'not_interested',
        updated_at = now()
    WHERE id = ${opts.conversationId}::uuid
      AND company_id = ${opts.companyId}::uuid
      AND campaign_reply_campaign_id IS NOT NULL
  `;
}

export async function markCampaignOptOut(opts: {
  companyId: string;
  conversationId: string;
}): Promise<void> {
  const s = sql();
  await s`
    UPDATE public.conversations
    SET campaign_service_status = 'opt_out',
        updated_at = now()
    WHERE id = ${opts.conversationId}::uuid
      AND company_id = ${opts.companyId}::uuid
      AND campaign_reply_campaign_id IS NOT NULL
  `;
}

/** Verifica se mensagem outbound humana qualifica e aplica answered. */
export async function tryApplyHumanReplyFromMessage(opts: {
  companyId: string;
  conversationId: string;
  messageId: string;
}): Promise<boolean> {
  const s = sql();
  const msgRows = await s<
    {
      direction: string;
      sent_by_user_id: string | null;
      message_type: string | null;
      raw_payload: unknown;
      created_at: Date;
    }[]
  >`
    SELECT direction, sent_by_user_id, message_type, raw_payload, created_at
    FROM public.messages
    WHERE id = ${opts.messageId}::uuid
    LIMIT 1
  `;
  const msg = msgRows[0];
  if (!msg || !isHumanOutboundMessage(msg)) return false;
  return onHumanReply({
    companyId: opts.companyId,
    conversationId: opts.conversationId,
    messageId: opts.messageId,
    sentAt: new Date(msg.created_at),
  });
}
