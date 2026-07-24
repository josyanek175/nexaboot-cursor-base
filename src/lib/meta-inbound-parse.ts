// Extract de mensagens inbound Meta (texto, botão, interactive) — sem dependências de servidor.

import { sanitizeMetaWebhookPayload } from "./meta-webhook-parse.ts";
import { isValidE164Digits, normalizePhoneE164 } from "./phone.ts";

export type MetaInboundMessageType = "text" | "button" | "interactive";

export type MetaInboundMediaType = "image" | "audio" | "video" | "document" | "sticker";

export const META_INBOUND_MEDIA_TYPES: MetaInboundMediaType[] = [
  "image",
  "audio",
  "video",
  "document",
  "sticker",
];

export type MetaInboundMediaMessage = {
  phoneNumberId: string;
  externalMessageId: string;
  phone: string;
  contactName: string | null;
  mediaType: MetaInboundMediaType;
  mediaId: string;
  caption: string | null;
  filename: string | null;
  mimeHint: string | null;
  rawPayload: Record<string, unknown>;
};

export type MetaInboundTextMessage = {
  phoneNumberId: string;
  externalMessageId: string;
  phone: string;
  contactName: string | null;
  textBody: string;
  messageType: MetaInboundMessageType;
  rawPayload: Record<string, unknown>;
};

export type MetaInboundReplyResolution = {
  text: string;
  usedFallback: boolean;
  buttonText: string | null;
  buttonPayload: string | null;
  interactiveType: string | null;
  replyId: string | null;
  replyTitle: string | null;
};

const BUTTON_REPLY_FALLBACK = "[Resposta de botão]";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Normaliza o corpo do webhook Meta.
 * Aceita payload direto ({ entry[] }) ou wrapper de auditoria ({ body: { entry[] } }).
 */
export function unwrapMetaWebhookBody(payload: unknown): Record<string, unknown> | null {
  const root = asRecord(payload);
  if (!root) return null;

  if (Array.isArray(root.entry)) {
    return root;
  }

  const body = asRecord(root.body);
  if (body && Array.isArray(body.entry)) {
    return body;
  }

  return root;
}

function contactNameByWaId(contacts: unknown[], phone: string): string | null {
  for (const contact of contacts) {
    const rec = asRecord(contact);
    if (!rec) continue;
    const waRaw = readString(rec.wa_id);
    if (!waRaw) continue;
    const waE164 = normalizePhoneE164(waRaw);
    if (waE164 === phone) {
      const profile = asRecord(rec.profile);
      return readString(profile?.name);
    }
  }
  return null;
}

/** Extrai texto de mensagens inbound Meta (text, button, interactive). */
export function resolveMetaInboundMessageText(
  messageRec: Record<string, unknown>,
): MetaInboundReplyResolution | null {
  const type = readString(messageRec.type);
  if (!type) return null;

  if (type === "text") {
    const textNode = asRecord(messageRec.text);
    const body = readString(textNode?.body);
    if (!body) return null;
    return {
      text: body,
      usedFallback: false,
      buttonText: null,
      buttonPayload: null,
      interactiveType: null,
      replyId: null,
      replyTitle: null,
    };
  }

  if (type === "button") {
    const button = asRecord(messageRec.button);
    const buttonText = readString(button?.text);
    const buttonPayload = readString(button?.payload);
    const resolved = buttonText ?? buttonPayload;
    if (!resolved) {
      return {
        text: BUTTON_REPLY_FALLBACK,
        usedFallback: true,
        buttonText,
        buttonPayload,
        interactiveType: null,
        replyId: null,
        replyTitle: null,
      };
    }
    return {
      text: resolved,
      usedFallback: false,
      buttonText,
      buttonPayload,
      interactiveType: null,
      replyId: null,
      replyTitle: null,
    };
  }

  if (type === "interactive") {
    const interactive = asRecord(messageRec.interactive);
    const interactiveType = readString(interactive?.type);
    if (interactiveType === "button_reply") {
      const buttonReply = asRecord(interactive?.button_reply);
      const replyTitle = readString(buttonReply?.title);
      const replyId = readString(buttonReply?.id);
      const resolved = replyTitle ?? replyId;
      if (!resolved) {
        return {
          text: BUTTON_REPLY_FALLBACK,
          usedFallback: true,
          buttonText: null,
          buttonPayload: null,
          interactiveType,
          replyId,
          replyTitle,
        };
      }
      return {
        text: resolved,
        usedFallback: false,
        buttonText: null,
        buttonPayload: null,
        interactiveType,
        replyId,
        replyTitle,
      };
    }

    if (interactiveType === "list_reply") {
      const listReply = asRecord(interactive?.list_reply);
      const replyTitle = readString(listReply?.title);
      const replyId = readString(listReply?.id);
      const resolved = replyTitle ?? replyId;
      if (!resolved) {
        return {
          text: BUTTON_REPLY_FALLBACK,
          usedFallback: true,
          buttonText: null,
          buttonPayload: null,
          interactiveType,
          replyId,
          replyTitle,
        };
      }
      return {
        text: resolved,
        usedFallback: false,
        buttonText: null,
        buttonPayload: null,
        interactiveType,
        replyId,
        replyTitle,
      };
    }

    return null;
  }

  return null;
}

/** Extrai mensagens inbound Meta persistíveis (text, button, interactive). */
export function extractMetaInboundTextMessages(payload: unknown): MetaInboundTextMessage[] {
  const out: MetaInboundTextMessage[] = [];
  const root = unwrapMetaWebhookBody(payload);
  if (!root) return out;

  for (const entry of asArray(root.entry)) {
    const entryRec = asRecord(entry);
    if (!entryRec) continue;

    for (const change of asArray(entryRec.changes)) {
      const changeRec = asRecord(change);
      if (!changeRec) continue;

      const value = asRecord(changeRec.value);
      if (!value) continue;

      const metadata = asRecord(value.metadata);
      const phoneNumberId = readString(metadata?.phone_number_id);
      if (!phoneNumberId) continue;

      const contacts = asArray(value.contacts);

      for (const message of asArray(value.messages)) {
        const messageRec = asRecord(message);
        if (!messageRec) continue;

        const messageType = readString(messageRec.type);
        if (messageType !== "text" && messageType !== "button" && messageType !== "interactive") {
          continue;
        }

        const resolution = resolveMetaInboundMessageText(messageRec);
        if (!resolution) continue;

        const externalMessageId = readString(messageRec.id);
        if (!externalMessageId) continue;

        const fromRaw = readString(messageRec.from);
        const phone = fromRaw ? normalizePhoneE164(fromRaw) : "";
        if (!phone || !isValidE164Digits(phone)) continue;

        const contactName = contactNameByWaId(contacts, phone);

        out.push({
          phoneNumberId,
          externalMessageId,
          phone,
          contactName,
          textBody: resolution.text,
          messageType: messageType as MetaInboundMessageType,
          rawPayload: sanitizeMetaWebhookPayload({
            metadata,
            contacts,
            message: messageRec,
          }) as Record<string, unknown>,
        });
      }
    }
  }

  return out;
}

function isMetaInboundMediaType(value: string | null): value is MetaInboundMediaType {
  return !!value && (META_INBOUND_MEDIA_TYPES as string[]).includes(value);
}

function readMediaNode(messageRec: Record<string, unknown>, mediaType: MetaInboundMediaType) {
  return asRecord(messageRec[mediaType]);
}

/** Extrai mensagens inbound Meta com mídia (image, audio, video, document, sticker). */
export function extractMetaInboundMediaMessages(payload: unknown): MetaInboundMediaMessage[] {
  const out: MetaInboundMediaMessage[] = [];
  const root = unwrapMetaWebhookBody(payload);
  if (!root) return out;

  for (const entry of asArray(root.entry)) {
    const entryRec = asRecord(entry);
    if (!entryRec) continue;

    for (const change of asArray(entryRec.changes)) {
      const changeRec = asRecord(change);
      if (!changeRec) continue;

      const value = asRecord(changeRec.value);
      if (!value) continue;

      const metadata = asRecord(value.metadata);
      const phoneNumberId = readString(metadata?.phone_number_id);
      if (!phoneNumberId) continue;

      const contacts = asArray(value.contacts);

      for (const message of asArray(value.messages)) {
        const messageRec = asRecord(message);
        if (!messageRec) continue;

        const messageType = readString(messageRec.type);
        if (!isMetaInboundMediaType(messageType)) continue;

        const mediaNode = readMediaNode(messageRec, messageType);
        const mediaId = readString(mediaNode?.id);
        if (!mediaId) continue;

        const externalMessageId = readString(messageRec.id);
        if (!externalMessageId) continue;

        const fromRaw = readString(messageRec.from);
        const phone = fromRaw ? normalizePhoneE164(fromRaw) : "";
        if (!phone || !isValidE164Digits(phone)) continue;

        const contactName = contactNameByWaId(contacts, phone);
        const caption = readString(mediaNode?.caption);
        const filename =
          messageType === "document" ? readString(mediaNode?.filename) : null;
        const mimeHint = readString(mediaNode?.mime_type);

        out.push({
          phoneNumberId,
          externalMessageId,
          phone,
          contactName,
          mediaType: messageType,
          mediaId,
          caption,
          filename,
          mimeHint,
          rawPayload: sanitizeMetaWebhookPayload({
            metadata,
            contacts,
            message: messageRec,
          }) as Record<string, unknown>,
        });
      }
    }
  }

  return out;
}

/** Placeholder curto para preview da conversa (inbound mídia). */
export function metaInboundMediaPreviewLabel(mediaType: MetaInboundMediaType): string {
  switch (mediaType) {
    case "image":
      return "[imagem]";
    case "audio":
      return "[áudio]";
    case "video":
      return "[vídeo]";
    case "document":
      return "[documento]";
    case "sticker":
      return "[sticker]";
    default:
      return "[mídia]";
  }
}
