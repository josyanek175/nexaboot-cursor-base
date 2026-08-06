/**
 * Tratamento de respostas inbound a disparos de campanha.
 * Chamado pelos webhooks Meta/Evolution após gravar a mensagem recebida.
 */
import { sql } from "@/lib/pg.server";
import type { PgSql } from "@/lib/pg-types";
import { getPhoneVariants, normalizePhone, normalizePhoneForMatch } from "@/lib/phone";
import { insertCampaignEvent, syncCampaignContactCounters } from "@/lib/campaign.server";
import { MANUAL_PAUSED_STATUS } from "@/lib/campaign-manual-control";
import { normalizeCampaignColor } from "@/lib/campaign-color.server";
import {
  markCampaignOptOut,
  onCampaignInbound,
} from "@/lib/campaign-service-status.server";

export type ResponseIntent = "interested" | "not_interested" | "opt_out" | "unknown";

/** Respostas exatas de botões de template Meta (normalizadas). */
const TEMPLATE_BUTTON_INTENT: Record<string, ResponseIntent> = {
  "quero agendar": "interested",
  "tenho uma duvida": "interested",
  "tenho uma dúvida": "interested",
  "me lembrar depois": "unknown",
};

/** Respostas numéricas padrão (Evolution — opções numeradas). */
const NUMERIC_RESPONSE_INTENT: Record<string, ResponseIntent> = {
  "1": "interested",
  "2": "unknown",
  "3": "interested",
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

const OPT_OUT = [
  "sair",
  "remover",
  "pare",
  "parar",
  "cancelar",
  "descadastrar",
  "não me mande",
  "nao me mande",
];

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

  const numericIntent = NUMERIC_RESPONSE_INTENT[t];
  if (numericIntent) return numericIntent;

  const templateIntent = TEMPLATE_BUTTON_INTENT[t];
  if (templateIntent) return templateIntent;

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

export async function isPhoneInOptOutList(
  companyId: string,
  phone: string,
  db?: PgSql,
): Promise<boolean> {
  const s = db ?? sql();
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

type CampaignAssociation = {
  campaignId: string;
  campaignName: string;
  campaignColor: string;
  campaignContactId: string | null;
  phone: string;
  source: "contact" | "message" | "payload";
};

async function findCampaignContactAssociation(opts: {
  companyId: string;
  channelId: string;
  phone: string;
}): Promise<CampaignAssociation | null> {
  const s = sql();
  const variants = getPhoneVariants(opts.phone);
  if (variants.length === 0) return null;

  const rows = await s<
    {
      id: string;
      campaign_id: string;
      campaign_name: string;
      campaign_color: string | null;
      phone: string;
    }[]
  >`
    SELECT
      cc.id,
      cc.campaign_id,
      c.name AS campaign_name,
      c.color AS campaign_color,
      cc.phone
    FROM public.campaign_contacts cc
    JOIN public.campaigns c ON c.id = cc.campaign_id AND c.company_id = cc.company_id
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
  if (!hit) return null;
  return {
    campaignId: hit.campaign_id,
    campaignName: hit.campaign_name,
    campaignColor: normalizeCampaignColor(hit.campaign_color),
    campaignContactId: hit.id,
    phone: hit.phone,
    source: "contact",
  };
}

function parsePayloadCampaignId(raw: unknown): string | null {
  if (!raw) return null;
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  }
  const id = obj?.campaign_id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

async function findCampaignFromOutboundMessage(opts: {
  companyId: string;
  conversationId: string;
  inboundMessageId?: string | null;
}): Promise<CampaignAssociation | null> {
  const s = sql();
  let inboundCreatedAt: Date | null = null;
  if (opts.inboundMessageId) {
    const inboundRows = await s<{ created_at: Date }[]>`
      SELECT created_at FROM public.messages
      WHERE conversation_id = ${opts.conversationId}::uuid
        AND (external_message_id = ${opts.inboundMessageId} OR external_id = ${opts.inboundMessageId})
      ORDER BY created_at DESC
      LIMIT 1
    `;
    inboundCreatedAt = inboundRows[0]?.created_at ? new Date(inboundRows[0].created_at) : null;
  }

  const msgRows = await s<
    {
      raw_payload: unknown;
      created_at: Date;
    }[]
  >`
    SELECT m.raw_payload, m.created_at
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    WHERE m.conversation_id = ${opts.conversationId}::uuid
      AND c.company_id = ${opts.companyId}::uuid
      AND m.direction = 'out'
      AND (
        ${inboundCreatedAt}::timestamptz IS NULL
        OR m.created_at < ${inboundCreatedAt}::timestamptz
      )
      AND (
        m.raw_payload->>'origin' = 'CAMPANHA'
      )
    ORDER BY m.created_at DESC
    LIMIT 1
  `;

  const msg = msgRows[0];
  if (!msg) return null;

  let payload: Record<string, unknown> | null = null;
  if (msg.raw_payload && typeof msg.raw_payload === "object" && !Array.isArray(msg.raw_payload)) {
    payload = msg.raw_payload as Record<string, unknown>;
  } else if (typeof msg.raw_payload === "string") {
    try {
      payload = JSON.parse(msg.raw_payload) as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  if (payload?.origin !== "CAMPANHA") return null;

  const campaignId = typeof payload.campaign_id === "string" ? payload.campaign_id : null;
  if (!campaignId) return null;

  const campRows = await s<
    {
      id: string;
      name: string;
      color: string | null;
    }[]
  >`
    SELECT id, name, color FROM public.campaigns
    WHERE id = ${campaignId}::uuid
      AND company_id = ${opts.companyId}::uuid
      AND deleted_at IS NULL
    LIMIT 1
  `;
  const camp = campRows[0];
  if (!camp) return null;

  const contactId =
    typeof payload.campaign_contact_id === "string" ? payload.campaign_contact_id : null;

  return {
    campaignId: camp.id,
    campaignName: camp.name,
    campaignColor: normalizeCampaignColor(camp.color),
    campaignContactId: contactId,
    phone: "",
    source: "message",
  };
}

async function resolveCampaignAssociation(opts: {
  companyId: string;
  channelId: string;
  conversationId: string;
  phone: string;
  inboundMessageId?: string | null;
}): Promise<CampaignAssociation | null> {
  const byContact = await findCampaignContactAssociation(opts);
  if (byContact) return byContact;

  const byMessage = await findCampaignFromOutboundMessage({
    companyId: opts.companyId,
    conversationId: opts.conversationId,
    inboundMessageId: opts.inboundMessageId,
  });
  if (byMessage) return byMessage;

  return null;
}

/**
 * Processa inbound relacionado a campanha (texto ou mídia).
 * Nova resposta do cliente reabre a fila mesmo com responded_at preenchido.
 */
export async function handleCampaignInboundReply(opts: {
  companyId: string;
  channelId: string;
  conversationId: string;
  phone: string;
  responseText: string | null;
  inboundMessageId?: string | null;
  /** Quando true, processa mesmo sem texto (mídia sem caption). */
  allowEmptyText?: boolean;
}): Promise<{
  matched: boolean;
  campaignId?: string;
  campaignName?: string;
  campaignColor?: string;
  intent?: ResponseIntent;
} | null> {
  const hasText = !!opts.responseText?.trim();
  if (!hasText && !opts.allowEmptyText) return { matched: false };

  const association = await resolveCampaignAssociation(opts);
  if (!association) return { matched: false };

  const intent = classifyCampaignResponse(opts.responseText);
  const text = hasText ? opts.responseText!.slice(0, 4000) : null;

  if (association.campaignContactId && association.source === "contact") {
    const updated = await sql<{ id: string }[]>`
      UPDATE public.campaign_contacts
      SET status = 'responded',
          responded_at = COALESCE(responded_at, now()),
          response_text = COALESCE(${text}, response_text),
          response_intent = ${intent}
      WHERE id = ${association.campaignContactId}::uuid
        AND company_id = ${opts.companyId}::uuid
        AND status IN ('sent', 'responded')
      RETURNING id
    `;

    if (updated[0]) {
      await syncCampaignContactCounters(association.campaignId, opts.companyId);
      await insertCampaignEvent(
        opts.companyId,
        association.campaignId,
        "campaign.response_received",
        null,
        { intent, response_text: text, phone: association.phone },
        association.campaignContactId,
      );

      if (intent === "interested") {
        await insertCampaignEvent(
          opts.companyId,
          association.campaignId,
          "campaign.response_interested",
          null,
          { response_text: text, phone: association.phone },
          association.campaignContactId,
        );
      }

      if (intent === "opt_out") {
        await registerOptOut({
          companyId: opts.companyId,
          phone: association.phone,
          campaignId: association.campaignId,
          campaignContactId: association.campaignContactId,
        });
        await insertCampaignEvent(
          opts.companyId,
          association.campaignId,
          "campaign.response_opt_out",
          null,
          { response_text: text, phone: association.phone },
          association.campaignContactId,
        );
      }
    }
  }

  await onCampaignInbound({
    companyId: opts.companyId,
    conversationId: opts.conversationId,
    campaignId: association.campaignId,
    campaignName: association.campaignName,
    intent,
    responseText: text,
  });

  if (intent === "opt_out") {
    await markCampaignOptOut({
      companyId: opts.companyId,
      conversationId: opts.conversationId,
    });
  }

  console.log("[CAMPAIGN_RESPONSE_MATCHED]", {
    campaignId: association.campaignId,
    source: association.source,
    intent,
    conversationId: opts.conversationId,
    inboundMessageId: opts.inboundMessageId ?? null,
  });

  return {
    matched: true,
    campaignId: association.campaignId,
    campaignName: association.campaignName,
    campaignColor: association.campaignColor,
    intent,
  };
}
