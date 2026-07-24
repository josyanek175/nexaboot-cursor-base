// Orquestra envio de documento outbound (Meta ou Evolution) com persistência.

import { sql, ensureCrmSchema } from "@/lib/pg.server";
import {
  bumpConversationAfterOutboundMessage,
} from "@/lib/crm-outbound.server";
import {
  isWithinMetaServiceWindow,
  metaSendRejectionMessage,
} from "@/lib/meta-send-message.server";
import { recordMetaChannelError, clearMetaChannelError } from "@/lib/meta-channels.server";
import { sendEvolutionDocument } from "@/lib/evolution-document-send.server";
import { sendMetaDocument } from "@/lib/meta-document-send.server";
import {
  validateWhatsAppDocument,
  DocumentValidationError,
  mimeToExtension,
  type ValidatedWhatsAppDocument,
} from "@/lib/whatsapp-document-validation.server";
import {
  getProviderByKind,
  normalizeProviderKind,
  resolveProviderForChannel,
} from "@/lib/whatsapp/whatsapp-provider-router.server";
import { isValidE164Digits, normalizePhoneE164 } from "@/lib/phone";
import { metaWhatsAppProvider } from "@/lib/whatsapp/providers/meta-whatsapp-provider.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SendConversationDocumentResult =
  | { ok: true; provider: "meta" | "evolution"; message: Record<string, unknown> }
  | {
      ok: false;
      status: number;
      error: string;
      code?: string;
      message?: string;
      provider?: string;
      messageId?: string | null;
    };

function sanitizeMediaError(error: string): string {
  return error.replace(/Bearer\s+\S+/gi, "[redacted]").slice(0, 500);
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

async function insertPendingDocumentMessage(params: {
  conversationId: string;
  caption: string | null;
  doc: ValidatedWhatsAppDocument;
  sentByUserId?: string | null;
  sentByName?: string | null;
}): Promise<string | null> {
  const { conversationId, caption, doc, sentByUserId, sentByName } = params;
  const base64 = doc.buffer.toString("base64");
  const s = sql();

  const inserted = await s<{ id: string }[]>`
    INSERT INTO public.messages
      (conversation_id, direction, message_type, message_text, from_me, status,
       media_type, media_mimetype, mime_type, media_filename, media_size,
       media_caption, media_base64,
       sent_by_user_id, sent_by_name)
    VALUES
      (${conversationId}::uuid, 'out', 'document',
       ${caption || doc.fileName}, true, 'pending',
       'document', ${doc.mimeType}, ${doc.mimeType}, ${doc.fileName}, ${doc.size},
       ${caption || null}, ${base64},
       ${sentByUserId ?? null}::uuid, ${sentByName ?? null})
    RETURNING id
  `;
  const messageId = inserted[0]?.id ?? null;
  if (messageId) {
    await s`UPDATE public.messages SET media_url = ${`/api/messages/${messageId}/media`} WHERE id = ${messageId}::uuid`;
  }
  return messageId;
}

async function resetPendingDocumentMessage(params: {
  messageId: string;
  conversationId: string;
  companyId: string;
  caption: string | null;
  doc: ValidatedWhatsAppDocument;
}): Promise<boolean> {
  const { messageId, conversationId, companyId, caption, doc } = params;
  const base64 = doc.buffer.toString("base64");
  const s = sql();

  const rows = await s<{ id: string }[]>`
    SELECT m.id
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    WHERE m.id = ${messageId}::uuid
      AND m.conversation_id = ${conversationId}::uuid
      AND c.company_id = ${companyId}::uuid
      AND m.direction = 'out'
      AND m.message_type = 'document'
      AND m.status = 'error'
    LIMIT 1
  `;
  if (!rows[0]) return false;

  await s`
    UPDATE public.messages
    SET status = 'pending',
        message_text = ${caption || doc.fileName},
        mime_type = ${doc.mimeType},
        media_mimetype = ${doc.mimeType},
        media_filename = ${doc.fileName},
        media_size = ${doc.size},
        media_caption = ${caption || null},
        media_base64 = ${base64},
        media_error = NULL,
        external_id = NULL,
        external_message_id = NULL,
        raw_payload = NULL
    WHERE id = ${messageId}::uuid
  `;
  return true;
}

async function markDocumentSent(params: {
  messageId: string;
  providerMessageId: string | null;
  rawPayload?: Record<string, unknown> | null;
}): Promise<void> {
  const { messageId, providerMessageId, rawPayload = null } = params;
  const s = sql();
  await s`
    UPDATE public.messages
    SET status = 'sent',
        external_id = ${providerMessageId},
        external_message_id = ${providerMessageId},
        raw_payload = ${rawPayload != null ? JSON.stringify(rawPayload) : null}::jsonb,
        media_error = NULL
    WHERE id = ${messageId}::uuid
  `;
}

async function markDocumentFailed(params: {
  messageId: string;
  mediaError: string;
}): Promise<void> {
  const { messageId, mediaError } = params;
  const s = sql();
  await s`
    UPDATE public.messages
    SET status = 'error',
        media_error = ${sanitizeMediaError(mediaError)}
    WHERE id = ${messageId}::uuid
  `;
}

async function loadDocumentMessageRow(
  messageId: string,
  companyId: string,
): Promise<Record<string, unknown> | null> {
  const s = sql();
  const rows = await s<Record<string, unknown>[]>`
    SELECT m.id, m.conversation_id, m.direction, m.message_type,
           m.message_text AS body, m.from_me, m.status, m.created_at,
           m.sent_by_user_id, m.sent_by_name, m.media_url, m.media_filename,
           m.mime_type, m.media_size, m.media_caption, m.external_message_id
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    WHERE m.id = ${messageId}::uuid
      AND c.company_id = ${companyId}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Envia documento para conversa existente, roteando Meta ou Evolution. */
export async function sendConversationDocument(params: {
  companyId: string;
  conversationId: string;
  file?: File | null;
  caption?: string | null;
  mediaType?: string;
  sentByUserId?: string | null;
  sentByName?: string | null;
  retryMessageId?: string | null;
  fetchFn?: typeof fetch;
}): Promise<SendConversationDocumentResult> {
  const {
    companyId,
    conversationId,
    file,
    caption: rawCaption,
    mediaType = "document",
    sentByUserId,
    sentByName,
    retryMessageId,
    fetchFn = fetch,
  } = params;

  const caption = String(rawCaption ?? "").slice(0, 1024) || null;

  console.log("[DOCUMENT_SEND_REQUEST]", {
    companyId,
    conversationId,
    mediaType,
    retryMessageId: retryMessageId ?? null,
    filename: file?.name?.slice(0, 80) ?? null,
    size: file?.size ?? null,
  });

  if (mediaType !== "document") {
    return { ok: false, status: 400, error: "unsupported_media_type", message: "Formato de arquivo não permitido" };
  }

  if (retryMessageId && !UUID_RE.test(retryMessageId)) {
    return { ok: false, status: 400, error: "invalid_retry_message_id" };
  }

  if (!file && !retryMessageId) {
    return { ok: false, status: 400, error: "missing_file", message: "Não foi possível enviar o documento" };
  }

  let doc: ValidatedWhatsAppDocument;

  if (file) {
    try {
      doc = await validateWhatsAppDocument(file);
    } catch (e) {
      if (e instanceof DocumentValidationError) {
        return {
          ok: false,
          status: e.status,
          error: e.code,
          message: e.userMessage,
        };
      }
      throw e;
    }
  } else {
    await ensureCrmSchema();
    const s = sql();
    const existing = await s<
      {
        id: string;
        media_base64: string | null;
        mime_type: string | null;
        media_filename: string | null;
        media_size: number | null;
        media_caption: string | null;
      }[]
    >`
      SELECT m.id, m.media_base64, m.mime_type, m.media_filename, m.media_size, m.media_caption
      FROM public.messages m
      JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = ${retryMessageId!}::uuid
        AND m.conversation_id = ${conversationId}::uuid
        AND c.company_id = ${companyId}::uuid
        AND m.direction = 'out'
        AND m.message_type = 'document'
        AND m.status = 'error'
      LIMIT 1
    `;
    const row = existing[0];
    if (!row?.media_base64) {
      return {
        ok: false,
        status: 409,
        error: "retry_not_allowed",
        message: "Não foi possível enviar o documento",
      };
    }
    const buffer = Buffer.from(row.media_base64, "base64");
    const mimeType = row.mime_type || "application/octet-stream";
    doc = {
      buffer,
      mimeType,
      extension: (mimeToExtension(mimeType) ?? "pdf") as ValidatedWhatsAppDocument["extension"],
      fileName: row.media_filename || "arquivo",
      size: row.media_size ?? buffer.length,
    };
  }

  console.log("[DOCUMENT_VALIDATION_OK]", {
    companyId,
    conversationId,
    mimeType: doc.mimeType,
    fileName: doc.fileName,
    size: doc.size,
  });

  await ensureCrmSchema();
  const s = sql();

  const rows = await s<{
    id: string;
    company_id: string;
    whatsapp_channel_id: string;
    channel_type: string;
    channel_status: string | null;
    evolution_instance_name: string | null;
    phone: string | null;
    external_jid: string | null;
    phone_number_id: string | null;
  }[]>`
    SELECT c.id, c.company_id, c.whatsapp_channel_id,
           ch.channel_type, ch.status AS channel_status,
           ch.evolution_instance_name, ch.phone_number_id,
           ct.phone, ct.external_jid
    FROM public.conversations c
    JOIN public.contacts ct ON ct.id = c.contact_id
    JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
    WHERE c.id = ${conversationId}::uuid
      AND c.company_id = ${companyId}::uuid
    LIMIT 1
  `;
  const conv = rows[0];
  if (!conv) {
    return { ok: false, status: 404, error: "conversation_not_found", message: "Não foi possível enviar o documento" };
  }

  const providerKind = normalizeProviderKind(conv.channel_type) ?? "evolution";
  console.log("[DOCUMENT_PROVIDER_SELECTED]", {
    companyId,
    channelId: conv.whatsapp_channel_id,
    conversationId,
    provider: providerKind,
  });

  getProviderByKind(providerKind);

  let messageId: string | null = null;
  if (retryMessageId) {
    const reset = await resetPendingDocumentMessage({
      messageId: retryMessageId,
      conversationId,
      companyId,
      caption,
      doc,
    });
    if (!reset) {
      return {
        ok: false,
        status: 409,
        error: "retry_not_allowed",
        message: "Não foi possível enviar o documento",
      };
    }
    messageId = retryMessageId;
  } else {
    messageId = await insertPendingDocumentMessage({
      conversationId,
      caption,
      doc,
      sentByUserId,
      sentByName,
    });
  }

  if (!messageId) {
    return { ok: false, status: 500, error: "message_save_failed", message: "Não foi possível enviar o documento" };
  }

  const base64 = doc.buffer.toString("base64");
  const lastMessagePreview = caption || `[documento: ${doc.fileName}]`;

  if (providerKind === "meta") {
    const resolved = await resolveProviderForChannel(conv.whatsapp_channel_id, companyId);
    if (!resolved || resolved.channel.channelType !== "meta") {
      await markDocumentFailed({ messageId, mediaError: "channel_not_found" });
      return {
        ok: false,
        status: 404,
        error: "channel_not_found",
        message: "Não foi possível enviar o documento",
        provider: "meta",
        messageId,
      };
    }

    const channel = resolved.channel;
    if (String(channel.status).toUpperCase() !== "ACTIVE") {
      await markDocumentFailed({ messageId, mediaError: "channel_not_active" });
      return {
        ok: false,
        status: 409,
        error: "channel_not_active",
        message: metaSendRejectionMessage("channel_not_active"),
        provider: "meta",
        messageId,
      };
    }

    if (!channel.phoneNumberId?.trim()) {
      await markDocumentFailed({ messageId, mediaError: "missing_phone_number_id" });
      return {
        ok: false,
        status: 409,
        error: "missing_phone_number_id",
        message: metaSendRejectionMessage("missing_phone_number_id"),
        provider: "meta",
        messageId,
      };
    }

    const hasToken = await metaWhatsAppProvider.hasAccessToken(channel.id, companyId);
    if (!hasToken) {
      await markDocumentFailed({ messageId, mediaError: "missing_token" });
      return {
        ok: false,
        status: 409,
        error: "missing_token",
        message: metaSendRejectionMessage("missing_token"),
        provider: "meta",
        messageId,
      };
    }

    const phoneRaw = conv.phone || conv.external_jid || "";
    const phone = normalizePhoneE164(phoneRaw);
    if (!phone || !isValidE164Digits(phone)) {
      await markDocumentFailed({ messageId, mediaError: "invalid_recipient_phone" });
      return {
        ok: false,
        status: 400,
        error: "invalid_recipient_phone",
        message: metaSendRejectionMessage("invalid_recipient_phone"),
        provider: "meta",
        messageId,
      };
    }

    const lastInboundAt = await getLastInboundMessageAt(conversationId);
    if (!isWithinMetaServiceWindow(lastInboundAt)) {
      await markDocumentFailed({ messageId, mediaError: "service_window_closed" });
      return {
        ok: false,
        status: 409,
        error: "service_window_closed",
        message: metaSendRejectionMessage("service_window_closed"),
        provider: "meta",
        messageId,
      };
    }

    const sendResult = await sendMetaDocument(
      {
        channelId: channel.id,
        companyId,
        phoneNumberId: channel.phoneNumberId,
        toPhone: phone,
        buffer: doc.buffer,
        mimeType: doc.mimeType,
        fileName: doc.fileName,
        caption,
      },
      fetchFn,
    );

    if (!sendResult.ok) {
      await recordMetaChannelError(
        channel.id,
        companyId,
        sendResult.errorCode ?? sendResult.error,
        sendResult.error,
      );
      await markDocumentFailed({ messageId, mediaError: sendResult.error });
      return {
        ok: false,
        status: sendResult.httpStatus && sendResult.httpStatus >= 400 ? sendResult.httpStatus : 502,
        error: sendResult.error,
        message: sendResult.userMessage,
        provider: "meta",
        messageId,
      };
    }

    await clearMetaChannelError(channel.id, companyId);
    await markDocumentSent({
      messageId,
      providerMessageId: sendResult.providerMessageId,
      rawPayload: sendResult.rawPayload,
    });
    await bumpConversationAfterOutboundMessage({ conversationId, lastMessageText: lastMessagePreview });

    console.log("[DOCUMENT_MESSAGE_SAVED]", {
      companyId,
      channelId: conv.whatsapp_channel_id,
      conversationId,
      messageId,
      provider: "meta",
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      size: doc.size,
      status: "sent",
    });

    const row = await loadDocumentMessageRow(messageId, companyId);
    return {
      ok: true,
      provider: "meta",
      message: row ?? { id: messageId, status: "sent" },
    };
  }

  // Evolution
  const apiUrl = process.env.EVOLUTION_API_URL;
  const apiKey = process.env.EVOLUTION_API_KEY;
  const instance = conv.evolution_instance_name || process.env.EVOLUTION_INSTANCE_NAME;
  if (!apiUrl || !apiKey || !instance) {
    await markDocumentFailed({ messageId, mediaError: "missing_evolution_config" });
    return {
      ok: false,
      status: 500,
      error: "missing_evolution_config",
      message: "Não foi possível enviar o documento",
      provider: "evolution",
      messageId,
    };
  }
  if ((conv.channel_status ?? "").toLowerCase() !== "connected") {
    await markDocumentFailed({ messageId, mediaError: "channel_not_active" });
    return {
      ok: false,
      status: 409,
      error: "channel_not_active",
      message: "Não foi possível enviar o documento",
      provider: "evolution",
      messageId,
    };
  }

  const number = String(conv.phone || conv.external_jid || "").replace(/\D/g, "");
  if (!number) {
    await markDocumentFailed({ messageId, mediaError: "missing_number" });
    return {
      ok: false,
      status: 400,
      error: "missing_number",
      message: "Não foi possível enviar o documento",
      provider: "evolution",
      messageId,
    };
  }

  const evoResult = await sendEvolutionDocument(
    {
      apiUrl,
      apiKey,
      instance,
      number,
      base64,
      mimeType: doc.mimeType,
      fileName: doc.fileName,
      caption,
    },
    fetchFn,
  );

  if (!evoResult.ok) {
    await markDocumentFailed({ messageId, mediaError: evoResult.error });
    return {
      ok: false,
      status: evoResult.httpStatus && evoResult.httpStatus >= 400 ? evoResult.httpStatus : 502,
      error: "evolution_send_failed",
      message: evoResult.userMessage,
      provider: "evolution",
      messageId,
    };
  }

  await markDocumentSent({
    messageId,
    providerMessageId: evoResult.providerMessageId,
    rawPayload: {
      mediatype: "document",
      mimetype: doc.mimeType,
      fileName: doc.fileName,
      provider: "evolution",
    },
  });
  await bumpConversationAfterOutboundMessage({ conversationId, lastMessageText: lastMessagePreview });

  console.log("[DOCUMENT_MESSAGE_SAVED]", {
    companyId,
    channelId: conv.whatsapp_channel_id,
    conversationId,
    messageId,
    provider: "evolution",
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    size: doc.size,
    status: "sent",
  });

  const row = await loadDocumentMessageRow(messageId, companyId);
  return {
    ok: true,
    provider: "evolution",
    message: row ?? { id: messageId, status: "sent" },
  };
}
