// Envio manual de texto outbound Meta WhatsApp Cloud API.

import { sql, ensureCrmSchema } from "@/lib/pg.server";
import {
  bumpConversationAfterOutboundMessage,
  insertOutboundTextMessage,
} from "@/lib/crm-outbound.server";
import { recordMetaChannelError, clearMetaChannelError } from "@/lib/meta-channels.server";
import { sanitizeMetaWebhookPayload } from "@/lib/meta-webhook-parse";
import { isValidE164Digits, normalizePhoneE164 } from "@/lib/phone";
import { resolveProviderForChannel } from "@/lib/whatsapp/whatsapp-provider-router.server";

export const META_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type MetaManualSendResult =
  | { ok: true; message: Record<string, unknown> }
  | { ok: false; status: number; error: string; message?: string };

export function isWithinMetaServiceWindow(
  lastInboundAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < META_SERVICE_WINDOW_MS;
}

export function friendlyMetaSendError(code: string | null, fallback?: string | null): string {
  const c = code ? Number(code) : NaN;
  if (c === 131047 || c === 131026) {
    return "Fora da janela de atendimento de 24 horas. Aguarde uma nova mensagem do contato ou use um template.";
  }
  if (c === 190 || c === 102 || c === 463) {
    return "Token Meta inválido ou expirado. Reconfigure o access token do canal.";
  }
  if (c === 100) {
    return "Parâmetros inválidos para envio Meta. Verifique o telefone do contato.";
  }
  if (c === 131030) {
    return "Este número não está registrado no WhatsApp.";
  }
  if (fallback?.trim()) return fallback.trim();
  return "Não foi possível enviar a mensagem pelo WhatsApp Meta.";
}

async function getLastInboundMessageAt(conversationId: string): Promise<Date | null> {
  const s = sql();
  const rows = await s<{ last_at: Date | string | null }[]>`
    SELECT MAX(created_at) AS last_at
    FROM public.messages
    WHERE conversation_id = ${conversationId}::uuid
      AND direction = 'in'
  `;
  const raw = rows[0]?.last_at;
  if (!raw) return null;
  return raw instanceof Date ? raw : new Date(String(raw));
}

/** Envia texto manual Meta para conversa existente (janela 24h). */
export async function sendMetaManualText(params: {
  companyId: string;
  conversationId: string;
  text: string;
  sentByUserId?: string | null;
  sentByName?: string | null;
}): Promise<MetaManualSendResult> {
  await ensureCrmSchema();
  const { companyId, conversationId, text, sentByUserId, sentByName } = params;
  const s = sql();

  const rows = await s<{
    id: string;
    company_id: string;
    whatsapp_channel_id: string;
    phone: string | null;
    external_jid: string | null;
    channel_type: string;
  }[]>`
    SELECT c.id, c.company_id, c.whatsapp_channel_id,
           ct.phone, ct.external_jid,
           ch.channel_type
    FROM public.conversations c
    JOIN public.contacts ct ON ct.id = c.contact_id
    JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
    WHERE c.id = ${conversationId}::uuid
      AND c.company_id = ${companyId}::uuid
    LIMIT 1
  `;
  const conv = rows[0];
  if (!conv) {
    return { ok: false, status: 404, error: "conversation_not_found" };
  }

  if (String(conv.channel_type).toLowerCase() !== "meta") {
    return { ok: false, status: 400, error: "not_meta_channel" };
  }

  const resolved = await resolveProviderForChannel(conv.whatsapp_channel_id, companyId);
  if (!resolved || resolved.channel.channelType !== "meta") {
    return { ok: false, status: 404, error: "channel_not_found" };
  }

  const channel = resolved.channel;
  if (String(channel.status).toUpperCase() !== "ACTIVE") {
    return {
      ok: false,
      status: 409,
      error: "channel_not_active",
      message: "Canal Meta não está ativo.",
    };
  }

  const phoneRaw = conv.phone || conv.external_jid || "";
  const phone = normalizePhoneE164(phoneRaw);
  if (!phone || !isValidE164Digits(phone)) {
    return { ok: false, status: 400, error: "invalid_recipient_phone" };
  }

  const lastInboundAt = await getLastInboundMessageAt(conversationId);
  if (!isWithinMetaServiceWindow(lastInboundAt)) {
    return {
      ok: false,
      status: 409,
      error: "service_window_closed",
      message: friendlyMetaSendError("131047"),
    };
  }

  const sendResult = await resolved.provider.sendText(channel, phone, text);
  if (!sendResult.ok) {
    const errorCode = sendResult.errorCode ?? sendResult.error ?? "meta_send_failed";
    const errorMessage = sendResult.errorMessage ?? sendResult.error ?? "meta_send_failed";
    await recordMetaChannelError(channel.id, companyId, errorCode, errorMessage);
    return {
      ok: false,
      status: 502,
      error: sendResult.error ?? "meta_send_failed",
      message: friendlyMetaSendError(errorCode, errorMessage),
    };
  }

  await clearMetaChannelError(channel.id, companyId);

  const rawPayload = sanitizeMetaWebhookPayload({
    messaging_product: "whatsapp",
    to: phone,
    type: "text",
    text: { preview_url: false, body: text },
    meta_message_id: sendResult.providerMessageId ?? null,
  }) as Record<string, unknown>;

  const inserted = await insertOutboundTextMessage({
    conversationId,
    messageText: text,
    externalMessageId: sendResult.providerMessageId ?? null,
    rawPayload,
    sentByUserId,
    sentByName,
    status: "sent",
  });

  if (!inserted) {
    return { ok: false, status: 500, error: "message_save_failed" };
  }

  await bumpConversationAfterOutboundMessage({ conversationId, lastMessageText: text });

  console.log("[META_OUTBOUND_SAVED]", {
    conversationId,
    messageId: inserted.id,
    externalMessageId: sendResult.providerMessageId ?? null,
    phoneNumberId: channel.phoneNumberId,
  });

  return {
    ok: true,
    message: {
      id: inserted.id,
      conversation_id: inserted.conversation_id,
      direction: inserted.direction,
      message_type: inserted.message_type,
      body: inserted.message_text,
      from_me: inserted.from_me,
      status: inserted.status,
      created_at: inserted.created_at,
      sent_by_user_id: inserted.sent_by_user_id,
      sent_by_name: inserted.sent_by_name,
      external_message_id: sendResult.providerMessageId ?? null,
    },
  };
}
