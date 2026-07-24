// Persistência de mensagens inbound Meta WhatsApp Cloud API (texto + mídia).

import { ensureCampaignsSchema, ensureCrmSchema } from "@/lib/pg.server";
import { handleCampaignInboundReply } from "@/lib/campaign-response.server";
import {
  bumpConversationAfterInboundMessage,
  insertInboundMediaMessage,
  insertInboundTextMessage,
  upsertInboundContact,
  upsertInboundConversation,
} from "@/lib/crm-inbound.server";
import {
  extractMetaInboundMediaMessages,
  extractMetaInboundTextMessages,
  metaInboundMediaPreviewLabel,
  resolveMetaInboundMessageText,
  unwrapMetaWebhookBody,
  type MetaInboundMediaMessage,
  type MetaInboundTextMessage,
} from "@/lib/meta-inbound-parse";
import { downloadMetaMedia } from "@/lib/meta-media-download.server";
import { loadMetaChannelByPhoneNumberId } from "@/lib/whatsapp/whatsapp-provider-router.server";

export type { MetaInboundTextMessage, MetaInboundMediaMessage } from "@/lib/meta-inbound-parse";
export {
  extractMetaInboundMediaMessages,
  extractMetaInboundTextMessages,
  metaInboundMediaPreviewLabel,
  resolveMetaInboundMessageText,
  unwrapMetaWebhookBody,
} from "@/lib/meta-inbound-parse";

export type MetaInboundPersistResult = {
  processed: number;
  saved: number;
  skipped: number;
  errors: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function enrichRawPayload(
  rawPayload: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return { ...rawPayload, ...extra };
}

/** Persiste mensagens inbound Meta em contacts/conversations/messages. */
export async function persistMetaInboundMessages(
  payload: unknown,
): Promise<MetaInboundPersistResult> {
  await ensureCrmSchema();

  const webhookBody = unwrapMetaWebhookBody(payload);
  const body = webhookBody ?? payload;
  const textMessages = extractMetaInboundTextMessages(body);
  const mediaMessages = extractMetaInboundMediaMessages(body);

  const result: MetaInboundPersistResult = {
    processed: textMessages.length + mediaMessages.length,
    saved: 0,
    skipped: 0,
    errors: 0,
  };

  for (const msg of textMessages) {
    try {
      const saved = await persistOneMetaInboundTextMessage(msg);
      if (saved) result.saved += 1;
      else result.skipped += 1;
    } catch (e) {
      result.errors += 1;
      console.error("[META_INBOUND_PERSIST_FAIL]", {
        externalMessageId: msg.externalMessageId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  for (const msg of mediaMessages) {
    try {
      const saved = await persistOneMetaInboundMediaMessage(msg);
      if (saved) result.saved += 1;
      else result.skipped += 1;
    } catch (e) {
      result.errors += 1;
      console.error("[META_INBOUND_PERSIST_FAIL]", {
        externalMessageId: msg.externalMessageId,
        mediaType: msg.mediaType,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return result;
}

/** @deprecated Use persistMetaInboundMessages */
export async function persistMetaInboundTextMessages(
  payload: unknown,
): Promise<MetaInboundPersistResult> {
  return persistMetaInboundMessages(payload);
}

async function persistOneMetaInboundTextMessage(msg: MetaInboundTextMessage): Promise<boolean> {
  const channel = await loadMetaChannelByPhoneNumberId(msg.phoneNumberId);
  if (!channel?.companyId?.trim() || channel.companyId === "null") {
    console.log("[META_INBOUND_SKIPPED]", {
      reason: "channel_not_found",
      phoneNumberId: msg.phoneNumberId,
    });
    console.log("[META_WEBHOOK_CHANNEL_NOT_FOUND]", {
      phoneNumberId: msg.phoneNumberId,
      stage: "persist",
    });
    return false;
  }

  const messageRec = asRecord(msg.rawPayload.message);
  const resolution = messageRec ? resolveMetaInboundMessageText(messageRec) : null;

  const contactId = await upsertInboundContact({
    companyId: channel.companyId,
    phone: msg.phone,
    externalJid: msg.phone,
    name: msg.contactName ?? undefined,
    fromMe: false,
  });

  const conversationId = await upsertInboundConversation({
    companyId: channel.companyId,
    channelId: channel.id,
    contactId,
  });

  const messageId = await insertInboundTextMessage({
    conversationId,
    externalMessageId: msg.externalMessageId,
    messageText: msg.textBody,
    rawPayload: msg.rawPayload,
  });

  if (!messageId) {
    console.log("[META_INBOUND_DEDUP]", {
      externalMessageId: msg.externalMessageId,
      conversationId,
    });
    return false;
  }

  await bumpConversationAfterInboundMessage({
    conversationId,
    lastMessageText: msg.textBody,
  });

  let campaignId: string | undefined;
  try {
    await ensureCampaignsSchema();
    const campaignMatch = await handleCampaignInboundReply({
      companyId: channel.companyId,
      channelId: channel.id,
      conversationId,
      phone: msg.phone,
      responseText: msg.textBody,
      inboundMessageId: msg.externalMessageId,
    });
    campaignId = campaignMatch?.campaignId;
  } catch (e) {
    console.error("[CAMPAIGN_RESPONSE_HOOK_FAIL]", {
      externalMessageId: msg.externalMessageId,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  if (resolution?.usedFallback) {
    console.log("[META_WEBHOOK_REPLY_WITHOUT_TEXT]", {
      messageId: msg.externalMessageId,
      phoneNumberId: msg.phoneNumberId,
      from: msg.phone,
      messageType: msg.messageType,
      resolvedText: resolution.text,
      channelId: channel.id,
      companyId: channel.companyId,
      conversationId,
      campaignId: campaignId ?? null,
    });
  } else if (msg.messageType === "button" && resolution) {
    console.log("[META_WEBHOOK_BUTTON_REPLY]", {
      messageId: msg.externalMessageId,
      phoneNumberId: msg.phoneNumberId,
      from: msg.phone,
      buttonText: resolution.buttonText,
      buttonPayload: resolution.buttonPayload,
      resolvedText: resolution.text,
      channelId: channel.id,
      companyId: channel.companyId,
      conversationId,
      campaignId: campaignId ?? null,
    });
  } else if (msg.messageType === "interactive" && resolution) {
    console.log("[META_WEBHOOK_INTERACTIVE_REPLY]", {
      messageId: msg.externalMessageId,
      phoneNumberId: msg.phoneNumberId,
      from: msg.phone,
      interactiveType: resolution.interactiveType,
      replyId: resolution.replyId,
      replyTitle: resolution.replyTitle,
      resolvedText: resolution.text,
      channelId: channel.id,
      companyId: channel.companyId,
      conversationId,
      campaignId: campaignId ?? null,
    });
  }

  console.log("[META_INBOUND_MESSAGE_SAVED]", {
    messageId,
    conversationId,
    contactId,
    phone: msg.phone,
    externalMessageId: msg.externalMessageId,
    messageType: msg.messageType,
    textBody: msg.textBody,
  });
  console.log("[META_WEBHOOK_PERSISTED]", {
    messageId,
    conversationId,
    contactId,
    phone: msg.phone,
    phoneNumberId: msg.phoneNumberId,
    externalMessageId: msg.externalMessageId,
    messageType: msg.messageType,
  });
  return true;
}

async function persistOneMetaInboundMediaMessage(msg: MetaInboundMediaMessage): Promise<boolean> {
  const channel = await loadMetaChannelByPhoneNumberId(msg.phoneNumberId);
  if (!channel?.companyId?.trim() || channel.companyId === "null") {
    console.log("[META_INBOUND_SKIPPED]", {
      reason: "channel_not_found",
      phoneNumberId: msg.phoneNumberId,
      mediaType: msg.mediaType,
    });
    return false;
  }

  const contactId = await upsertInboundContact({
    companyId: channel.companyId,
    phone: msg.phone,
    externalJid: msg.phone,
    name: msg.contactName ?? undefined,
    fromMe: false,
  });

  const conversationId = await upsertInboundConversation({
    companyId: channel.companyId,
    channelId: channel.id,
    contactId,
  });

  const previewLabel = metaInboundMediaPreviewLabel(msg.mediaType);
  const messageText = msg.caption?.trim() || previewLabel;

  const download = await downloadMetaMedia({
    channelId: channel.id,
    companyId: channel.companyId,
    phoneNumberId: msg.phoneNumberId,
    mediaId: msg.mediaId,
    messageId: msg.externalMessageId,
    mediaType: msg.mediaType,
    mimeHint: msg.mimeHint,
    filenameHint: msg.filename,
  });

  const mimeType = download.ok
    ? download.mimeType
    : msg.mimeHint ?? (msg.mediaType === "audio" ? "audio/ogg" : null);
  const filename = download.ok ? download.filename ?? msg.filename : msg.filename;
  const mediaBase64 = download.ok ? download.base64 : null;
  const mediaError = download.ok ? null : download.error;
  const mediaSize = download.ok ? download.fileSize : null;

  const rawPayload = enrichRawPayload(msg.rawPayload, {
    meta_media_id: msg.mediaId,
    meta_media_type: msg.mediaType,
    media_status: download.ok ? "ready" : "failed",
  });

  const messageId = await insertInboundMediaMessage({
    conversationId,
    externalMessageId: msg.externalMessageId,
    mediaType: msg.mediaType,
    messageText,
    caption: msg.caption,
    mimeType,
    filename,
    mediaBase64,
    mediaError,
    mediaSize,
    rawPayload,
  });

  if (!messageId) {
    console.log("[META_INBOUND_DEDUP]", {
      externalMessageId: msg.externalMessageId,
      conversationId,
      mediaType: msg.mediaType,
    });
    return false;
  }

  await bumpConversationAfterInboundMessage({
    conversationId,
    lastMessageText: messageText,
  });

  try {
    await ensureCampaignsSchema();
    await handleCampaignInboundReply({
      companyId: channel.companyId,
      channelId: channel.id,
      conversationId,
      phone: msg.phone,
      responseText: msg.caption ?? "",
      inboundMessageId: msg.externalMessageId,
    });
  } catch (e) {
    console.error("[CAMPAIGN_RESPONSE_HOOK_FAIL]", {
      externalMessageId: msg.externalMessageId,
      mediaType: msg.mediaType,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  console.log("[META_MEDIA_MESSAGE_SAVED]", {
    channelId: channel.id,
    companyId: channel.companyId,
    mediaId: msg.mediaId,
    messageId: msg.externalMessageId,
    mediaType: msg.mediaType,
    mimeType,
    size: mediaSize,
    mediaStatus: download.ok ? "ready" : "failed",
    internalMessageId: messageId,
    conversationId,
  });

  return true;
}
