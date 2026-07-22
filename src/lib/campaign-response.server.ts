/**
 * Tratamento de respostas inbound a disparos de campanha.
 * Chamado pelo webhook Evolution após gravar a mensagem recebida.
 */
import { sql } from "@/lib/pg.server";
import { getPhoneVariants, normalizePhone, normalizePhoneForMatch } from "@/lib/phone";
import { insertCampaignEvent, syncCampaignContactCounters } from "@/lib/campaign.server";
import { MANUAL_PAUSED_STATUS } from "@/lib/campaign-manual-control";

export type ResponseIntent = "interested" | "not_interested" | "opt_out" | "unknown";

/** Respostas exatas de botões de template Meta (normalizadas). */
const TEMPLATE_BUTTON_INTENT: Record<string, ResponseIntent> = {
  "quero agendar": "interested",
  "tenho uma duvida": "interested",
  "me lembrar depois": "unknown",
};

const INTERESTED = [
  "sim",
  "ok",
  "quero",
  "tenho interesse",
  "pode chamar",
  "me chama",
  "vamos",
  "pode ser",
];

const NOT_INTERESTED = ["não", "nao", "agora não", "agora nao", "sem interesse", "não quero", "nao quero"];

const OPT_OUT = ["sair", "remover", "pare", "parar", "descadastrar", "não me mande", "nao me mande"];

function normalizeReply(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyCampaignResponse(text: string | null | undefined): ResponseIntent {
  const t = normalizeReply(text ?? "");
  if (!t) return "unknown";

  const templateIntent = TEMPLATE_BUTTON_INTENT[t];
  if (templateIntent) return templateIntent;

  // Opt-out tem prioridade.
  for (const p of OPT_OUT) {
    const n = normalizeReply(p);
    if (t === n || t.includes(n)) return "opt_out";
  }
  for (const p of NOT_INTERESTED) {
    const n = normalizeReply(p);
    if (t === n || t.startsWith(n + " ") || t === n) return "not_interested";
  }
  for (const p of INTERESTED) {
    const n = normalizeReply(p);
    if (t === n || t.includes(n)) return "interested";
  }
  return "unknown";
}

export async function isPhoneInOptOutList(companyId: string, phone: string): Promise<boolean> {
  const s = sql();
  const variants = getPhoneVariants(phone);
  const phoneMatch = normalizePhoneForMatch(phone);
  const rows = await s<{ id: string }[]>`
    SELECT id FROM public.opt_out_contacts
    WHERE company_id = ${companyId}::uuid
      AND (
        phone = ANY(${variants}::text[])
        OR phone_match = ${phoneMatch}
      )
    LIMIT 1
  `;
  return !!rows[0];
}

async function registerOptOut(opts: {
  companyId: string;
  phone: string;
  campaignId: string;
  campaignContactId: string;
}): Promise<void> {
  const s = sql();
  const phone = normalizePhone(opts.phone);
  const phoneMatch = normalizePhoneForMatch(phone);
  await s`
    INSERT INTO public.opt_out_contacts
      (company_id, phone, phone_match, source, campaign_id, campaign_contact_id)
    VALUES (
      ${opts.companyId}::uuid,
      ${phone},
      ${phoneMatch},
      'campaign_reply',
      ${opts.campaignId}::uuid,
      ${opts.campaignContactId}::uuid
    )
    ON CONFLICT (company_id, phone) DO UPDATE SET
      phone_match = EXCLUDED.phone_match,
      campaign_id = EXCLUDED.campaign_id,
      campaign_contact_id = EXCLUDED.campaign_contact_id,
      created_at = now()
  `;
}

/**
 * Se o telefone respondeu a um disparo recente de campanha, marca como responded
 * e anota a conversa para o atendimento.
 */
export async function handleCampaignInboundReply(opts: {
  companyId: string;
  channelId: string;
  conversationId: string;
  phone: string;
  responseText: string | null;
  inboundMessageId?: string | null;
}): Promise<{
  matched: boolean;
  campaignId?: string;
  campaignName?: string;
  intent?: ResponseIntent;
} | null> {
  if (!opts.responseText?.trim()) return { matched: false };

  const s = sql();
  const variants = getPhoneVariants(opts.phone);
  if (variants.length === 0) return { matched: false };

  const rows = await s<
    {
      id: string;
      campaign_id: string;
      campaign_name: string;
      phone: string;
    }[]
  >`
    SELECT
      cc.id,
      cc.campaign_id,
      c.name AS campaign_name,
      cc.phone
    FROM public.campaign_contacts cc
    JOIN public.campaigns c ON c.id = cc.campaign_id
    WHERE cc.company_id = ${opts.companyId}::uuid
      AND cc.phone = ANY(${variants}::text[])
      AND cc.status = 'sent'
      AND cc.sent_at IS NOT NULL
      AND c.deleted_at IS NULL
      AND c.status IN ('running', 'paused', ${MANUAL_PAUSED_STATUS}, 'completed')
      AND (
        c.whatsapp_channel_id IS NULL
        OR c.whatsapp_channel_id = ${opts.channelId}::uuid
      )
    ORDER BY cc.sent_at DESC
    LIMIT 1
  `;

  const hit = rows[0];
  if (!hit) return { matched: false };

  const intent = classifyCampaignResponse(opts.responseText);
  const text = opts.responseText.slice(0, 4000);

  const updated = await s<{ id: string }[]>`
    UPDATE public.campaign_contacts
    SET status = 'responded',
        responded_at = now(),
        response_text = ${text},
        response_intent = ${intent}
    WHERE id = ${hit.id}::uuid
      AND company_id = ${opts.companyId}::uuid
      AND status = 'sent'
      AND responded_at IS NULL
    RETURNING id
  `;

  if (!updated[0]) {
    console.log("[CAMPAIGN_RESPONSE_ALREADY_HANDLED]", {
      campaignId: hit.campaign_id,
      contactRowId: hit.id,
      inboundMessageId: opts.inboundMessageId ?? null,
      conversationId: opts.conversationId,
    });
    return {
      matched: true,
      campaignId: hit.campaign_id,
      campaignName: hit.campaign_name,
      intent,
    };
  }

  await syncCampaignContactCounters(hit.campaign_id, opts.companyId);

  await insertCampaignEvent(
    opts.companyId,
    hit.campaign_id,
    "campaign.response_received",
    null,
    { intent, response_text: text, phone: hit.phone },
    hit.id,
  );

  if (intent === "interested") {
    await insertCampaignEvent(
      opts.companyId,
      hit.campaign_id,
      "campaign.response_interested",
      null,
      { response_text: text, phone: hit.phone },
      hit.id,
    );
  }

  if (intent === "opt_out") {
    await registerOptOut({
      companyId: opts.companyId,
      phone: hit.phone,
      campaignId: hit.campaign_id,
      campaignContactId: hit.id,
    });
    await insertCampaignEvent(
      opts.companyId,
      hit.campaign_id,
      "campaign.response_opt_out",
      null,
      { response_text: text, phone: hit.phone },
      hit.id,
    );
    console.log("[CAMPAIGN_RESPONSE_OPT_OUT]", {
      campaignId: hit.campaign_id,
      phone: hit.phone,
    });
  }

  // Marca a conversa para o atendimento (interessado / unknown / not_interested).
  // Opt-out também fica visível, mas com indicação de origem.
  await s`
    UPDATE public.conversations
    SET campaign_reply_campaign_id = ${hit.campaign_id}::uuid,
        campaign_reply_campaign_name = ${hit.campaign_name},
        campaign_reply_text = ${text},
        campaign_reply_intent = ${intent},
        campaign_reply_at = now(),
        updated_at = now()
    WHERE id = ${opts.conversationId}::uuid
      AND company_id = ${opts.companyId}::uuid
  `;

  console.log("[CAMPAIGN_RESPONSE_MATCHED]", {
    campaignId: hit.campaign_id,
    contactRowId: hit.id,
    intent,
    conversationId: opts.conversationId,
    inboundMessageId: opts.inboundMessageId ?? null,
  });

  return {
    matched: true,
    campaignId: hit.campaign_id,
    campaignName: hit.campaign_name,
    intent,
  };
}
