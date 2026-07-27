/**
 * Resolução da campanha visual para a lista lateral do Atendimento.
 * Prioridade: resposta de campanha (reply) → último outbound CAMPANHA.
 */
import {
  DEFAULT_CAMPAIGN_COLOR,
  isValidCampaignColor,
  normalizeCampaignColor,
} from "@/lib/campaign-color";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ConversationCampaignVisualInput = {
  campaign_reply_campaign_id?: string | null;
  campaign_reply_campaign_name?: string | null;
  /** Nome da campanha via JOIN (reply). */
  reply_joined_campaign_name?: string | null;
  /** Cor da campanha via JOIN ativo (reply). */
  reply_joined_campaign_color?: string | null;
  /** Último outbound: campaign_id no raw_payload. */
  outbound_payload_campaign_id?: string | null;
  outbound_payload_campaign_name?: string | null;
  outbound_payload_campaign_color?: string | null;
  /** Campanha do outbound validada por company_id (pode estar excluída). */
  outbound_company_campaign_id?: string | null;
  outbound_company_campaign_name?: string | null;
  outbound_company_campaign_color?: string | null;
  outbound_company_campaign_deleted?: boolean | null;
};

export type ConversationCampaignVisual = {
  resolved_campaign_id: string | null;
  resolved_campaign_name: string | null;
  resolved_campaign_color: string | null;
};

function validUuid(value: string | null | undefined): string | null {
  if (!value || !UUID_RE.test(value)) return null;
  return value;
}

function pickColor(
  ...candidates: (string | null | undefined)[]
): string | null {
  for (const candidate of candidates) {
    if (isValidCampaignColor(candidate)) return normalizeCampaignColor(candidate);
  }
  return null;
}

/** Resolve id/nome/cor exibidos na lista lateral. */
export function resolveConversationCampaignVisual(
  input: ConversationCampaignVisualInput,
): ConversationCampaignVisual {
  const replyId = validUuid(input.campaign_reply_campaign_id);
  if (replyId) {
    const name =
      input.reply_joined_campaign_name?.trim() ||
      input.campaign_reply_campaign_name?.trim() ||
      null;
    const color =
      pickColor(input.reply_joined_campaign_color) ?? DEFAULT_CAMPAIGN_COLOR;
    return {
      resolved_campaign_id: replyId,
      resolved_campaign_name: name,
      resolved_campaign_color: color,
    };
  }

  const payloadId = validUuid(input.outbound_payload_campaign_id);
  const companyId = validUuid(input.outbound_company_campaign_id);

  // Cross-tenant: só confia no outbound se a campanha pertence ao mesmo company.
  if (!payloadId || !companyId || payloadId !== companyId) {
    return {
      resolved_campaign_id: null,
      resolved_campaign_name: null,
      resolved_campaign_color: null,
    };
  }

  const name =
    input.outbound_company_campaign_name?.trim() ||
    input.outbound_payload_campaign_name?.trim() ||
    null;

  const color =
    pickColor(
      input.outbound_company_campaign_deleted
        ? undefined
        : input.outbound_company_campaign_color,
      input.outbound_payload_campaign_color,
      input.outbound_company_campaign_color,
    ) ?? DEFAULT_CAMPAIGN_COLOR;

  return {
    resolved_campaign_id: companyId,
    resolved_campaign_name: name,
    resolved_campaign_color: color,
  };
}
