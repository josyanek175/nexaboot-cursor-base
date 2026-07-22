// Persistência de mensagens inbound Meta WhatsApp Cloud API.

import { ensureCampaignsSchema, ensureCrmSchema } from "@/lib/pg.server";
import { handleCampaignInboundReply } from "@/lib/campaign-response.server";
import {
  bumpConversationAfterInboundMessage,
  insertInboundTextMessage,
  upsertInboundContact,
  upsertInboundConversation,
} from "@/lib/crm-inbound.server";
import {
  extractMetaInboundTextMessages,
  resolveMetaInboundMessageText,
  unwrapMetaWebhookBody,
  type MetaInboundTextMessage,
} from "@/lib/meta-inbound-parse";
import { loadMetaChannelByPhoneNumberId } from "@/lib/whatsapp/whatsapp-provider-router.server";

export type { MetaInboundTextMessage } from "@/lib/meta-inbound-parse";
export {
  extractMetaInboundTextMessages,
  resolveMetaInboundMessageText,
  unwrapMetaWebhookBody,
} from "@/lib/meta-inbound-parse";

export type MetaInboundPersistResult = {
  processed: number;
  saved: number;
  skipped: number;
  errors: number;
};

/** Persiste mensagens inbound Meta em contacts/conversations/messages. */
export async function persistMetaInboundTextMessages(
  payload: unknown,
): Promise<MetaInboundPersistResult> {
  await ensureCrmSchema();

  const webhookBody = unwrapMetaWebhookBody(payload);
  const messages = extractMetaInboundTextMessages(webhookBody ?? payload);
  const result: MetaInboundPersistResult = {
    processed: messages.length,
    saved: 0,
    skipped: 0,
    errors: 0,
  };

  for (const msg of messages) {
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

  return result;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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
