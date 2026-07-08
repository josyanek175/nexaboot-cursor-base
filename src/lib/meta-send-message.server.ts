// Envio manual de texto outbound Meta WhatsApp Cloud API.

import { sql, ensureCrmSchema } from "@/lib/pg.server";
import {
  bumpConversationAfterOutboundMessage,
  insertOutboundTextMessage,
} from "@/lib/crm-outbound.server";
import { recordMetaChannelError, clearMetaChannelError } from "@/lib/meta-channels.server";
import { sanitizeMetaWebhookPayload } from "@/lib/meta-webhook-parse";
import { isValidE164Digits, normalizePhoneE164 } from "@/lib/phone";
import type { WhatsAppChannelRecord } from "@/lib/whatsapp/providers/whatsapp-provider.types";
import {
  loadMetaAccessToken,
  metaWhatsAppProvider,
} from "@/lib/whatsapp/providers/meta-whatsapp-provider.server";
import { resolveProviderForChannel } from "@/lib/whatsapp/whatsapp-provider-router.server";

export const META_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type MetaSendRejectReason =
  | "channel_not_active"
  | "invalid_recipient_phone"
  | "service_window_closed"
  | "missing_token"
  | "missing_phone_number_id"
  | "unknown";

export type MetaManualSendResult =
  | { ok: true; message: Record<string, unknown> }
  | { ok: false; status: number; error: string; message?: string };

export function metaSendRejectionMessage(reason: MetaSendRejectReason | string): string {
  switch (reason) {
    case "channel_not_active":
      return "Canal Meta inativo.";
    case "invalid_recipient_phone":
      return "Telefone do contato inválido.";
    case "service_window_closed":
      return "Fora da janela de atendimento de 24 horas. Aguarde o cliente enviar uma mensagem ou use um template aprovado.";
    case "missing_token":
      return "Token Meta não configurado.";
    case "missing_phone_number_id":
      return "Phone Number ID Meta não configurado.";
    default:
      return "Não foi possível enviar a mensagem pelo WhatsApp Meta.";
  }
}

export function isWithinMetaServiceWindow(
  lastInboundAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < META_SERVICE_WINDOW_MS;
}

export function computeWindowAgeHours(lastInboundAt: Date | null, now: Date = new Date()): number | null {
  if (!lastInboundAt) return null;
  return Math.round(((now.getTime() - lastInboundAt.getTime()) / (60 * 60 * 1000)) * 100) / 100;
}

export function friendlyMetaSendError(code: string | null, fallback?: string | null): string {
  const c = code ? Number(code) : NaN;
  if (c === 131047 || c === 131026) {
    return metaSendRejectionMessage("service_window_closed");
  }
  if (c === 190 || c === 102 || c === 463) {
    return "Token Meta inválido ou expirado. Reconfigure o access token do canal.";
  }
  if (c === 100) {
    return metaSendRejectionMessage("invalid_recipient_phone");
  }
  if (c === 131030) {
    return "Este número não está registrado no WhatsApp.";
  }
  if (fallback?.trim()) return fallback.trim();
  return "Não foi possível enviar a mensagem pelo WhatsApp Meta.";
}

type MetaSendRejectContext = {
  reason: MetaSendRejectReason;
  status: number;
  error: string;
  conversationId: string;
  companyId: string;
  channelId?: string | null;
  contactId?: string | null;
  phone?: string | null;
  phoneNumberId?: string | null;
  channelStatus?: string | null;
  tokenStatus?: string | null;
  lastInboundAt?: Date | null;
  text?: string;
};

function rejectMetaSend(ctx: MetaSendRejectContext): MetaManualSendResult {
  console.log("[META_SEND_REJECTED]", {
    reason: ctx.reason,
    conversationId: ctx.conversationId,
    channelId: ctx.channelId ?? null,
    companyId: ctx.companyId,
    contactId: ctx.contactId ?? null,
    phone: ctx.phone ?? null,
    phoneNumberId: ctx.phoneNumberId ?? null,
    channelStatus: ctx.channelStatus ?? null,
    tokenStatus: ctx.tokenStatus ?? null,
    lastInboundAt: ctx.lastInboundAt?.toISOString() ?? null,
    windowAgeHours: computeWindowAgeHours(ctx.lastInboundAt ?? null),
    messagePreview: ctx.text ? ctx.text.slice(0, 80) : null,
  });

  return {
    ok: false,
    status: ctx.status,
    error: ctx.error,
    message: metaSendRejectionMessage(ctx.reason),
  };
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

function channelRejectContext(
  channel: WhatsAppChannelRecord,
  base: Pick<MetaSendRejectContext, "conversationId" | "companyId" | "contactId" | "phone" | "text">,
): Pick<
  MetaSendRejectContext,
  "channelId" | "phoneNumberId" | "channelStatus" | "tokenStatus" | "conversationId" | "companyId" | "contactId" | "phone" | "text"
> {
  return {
    ...base,
    channelId: channel.id,
    phoneNumberId: channel.phoneNumberId,
    channelStatus: channel.status,
    tokenStatus: channel.tokenStatus,
  };
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
    contact_id: string;
    whatsapp_channel_id: string;
    phone: string | null;
    external_jid: string | null;
    channel_type: string;
  }[]>`
    SELECT c.id, c.company_id, c.contact_id, c.whatsapp_channel_id,
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
    return rejectMetaSend({
      reason: "unknown",
      status: 404,
      error: "conversation_not_found",
      conversationId,
      companyId,
      text,
    });
  }

  const baseCtx = {
    conversationId,
    companyId,
    contactId: conv.contact_id,
    text,
  };

  if (String(conv.channel_type).toLowerCase() !== "meta") {
    return rejectMetaSend({
      reason: "unknown",
      status: 400,
      error: "not_meta_channel",
      channelId: conv.whatsapp_channel_id,
      phone: conv.phone ?? conv.external_jid,
      ...baseCtx,
    });
  }

  const resolved = await resolveProviderForChannel(conv.whatsapp_channel_id, companyId);
  if (!resolved || resolved.channel.channelType !== "meta") {
    return rejectMetaSend({
      reason: "unknown",
      status: 404,
      error: "channel_not_found",
      channelId: conv.whatsapp_channel_id,
      phone: conv.phone ?? conv.external_jid,
      ...baseCtx,
    });
  }

  const channel = resolved.channel;
  const channelCtx = channelRejectContext(channel, {
    ...baseCtx,
    phone: conv.phone ?? conv.external_jid,
  });

  if (String(channel.status).toUpperCase() !== "ACTIVE") {
    return rejectMetaSend({
      reason: "channel_not_active",
      status: 409,
      error: "channel_not_active",
      ...channelCtx,
    });
  }

  if (!channel.phoneNumberId?.trim()) {
    return rejectMetaSend({
      reason: "missing_phone_number_id",
      status: 409,
      error: "missing_phone_number_id",
      ...channelCtx,
    });
  }

  const hasToken = await metaWhatsAppProvider.hasAccessToken(channel.id, companyId);
  const decryptedToken = hasToken ? await loadMetaAccessToken(channel.id, companyId) : null;
  if (!hasToken || !decryptedToken || channel.tokenStatus === "missing") {
    return rejectMetaSend({
      reason: "missing_token",
      status: 409,
      error: "missing_token",
      ...channelCtx,
    });
  }

  const phoneRaw = conv.phone || conv.external_jid || "";
  const phone = normalizePhoneE164(phoneRaw);
  if (!phone || !isValidE164Digits(phone)) {
    return rejectMetaSend({
      reason: "invalid_recipient_phone",
      status: 400,
      error: "invalid_recipient_phone",
      ...channelCtx,
      phone: phoneRaw || null,
    });
  }

  const lastInboundAt = await getLastInboundMessageAt(conversationId);
  if (!isWithinMetaServiceWindow(lastInboundAt)) {
    return rejectMetaSend({
      reason: "service_window_closed",
      status: 409,
      error: "service_window_closed",
      ...channelCtx,
      phone,
      lastInboundAt,
    });
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
    return rejectMetaSend({
      reason: "unknown",
      status: 500,
      error: "message_save_failed",
      ...channelCtx,
      phone,
      lastInboundAt,
    });
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
