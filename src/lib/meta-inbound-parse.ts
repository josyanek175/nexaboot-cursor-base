// Extract de mensagens texto inbound Meta (sem dependências de servidor).

import { sanitizeMetaWebhookPayload } from "./meta-webhook-parse.ts";
import { isValidE164Digits, normalizePhoneE164 } from "./phone.ts";

export type MetaInboundTextMessage = {
  phoneNumberId: string;
  externalMessageId: string;
  phone: string;
  contactName: string | null;
  textBody: string;
  rawPayload: Record<string, unknown>;
};

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

/** Extrai mensagens texto inbound do payload Meta (field=messages). */
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
        if (readString(messageRec.type) !== "text") continue;

        const textNode = asRecord(messageRec.text);
        const textBody = readString(textNode?.body);
        if (!textBody) continue;

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
          textBody,
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
