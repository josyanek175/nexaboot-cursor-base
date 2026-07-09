// Parse e sanitização do payload Meta WhatsApp Cloud API (sem dependências de servidor).

import {
  formatPhoneDisplay,
  isValidE164Digits,
  normalizePhoneE164,
} from "./phone.ts";

export type MetaParsedPhoneField = {
  raw: string;
  e164: string;
  display: string;
  valid: boolean;
};

export type MetaWebhookParsedChange = {
  phone_number_id: string | null;
  display_phone_number: MetaParsedPhoneField | null;
  contacts: Array<{ wa_id: MetaParsedPhoneField; name: string | null }>;
  messages: Array<{
    from: MetaParsedPhoneField;
    id: string | null;
    type: string | null;
  }>;
};

const SENSITIVE_PAYLOAD_KEYS = new Set([
  "access_token",
  "authorization",
  "token",
  "api_key",
  "apikey",
  "secret",
  "password",
  "webhook_verify_token",
  "access_token_ciphertext",
]);

/** Sanitiza payload antes de persistir em meta_webhook_event_logs. */
export function sanitizeMetaWebhookPayload(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetaWebhookPayload(item, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_PAYLOAD_KEYS.has(key.toLowerCase())) {
      out[key] = "[redacted]";
    } else {
      out[key] = sanitizeMetaWebhookPayload(nested, depth + 1);
    }
  }
  return out;
}

function unwrapPayloadRoot(payload: unknown): Record<string, unknown> | null {
  const root = asRecord(payload);
  if (!root) return null;
  if (Array.isArray(root.entry)) return root;
  const body = asRecord(root.body);
  if (body && Array.isArray(body.entry)) return body;
  return root;
}

export type MetaWebhookChangeSummary = {
  field: string | null;
  phoneNumberId: string | null;
  messageCount: number;
  statusCount: number;
  messageIds: string[];
  statusIds: string[];
};

/** Resume cada change do payload (messages, statuses, etc.). */
export function extractMetaWebhookChanges(payload: unknown): MetaWebhookChangeSummary[] {
  const root = unwrapPayloadRoot(payload);
  if (!root) return [];

  const summaries: MetaWebhookChangeSummary[] = [];

  for (const entry of asArray(root.entry)) {
    const entryRec = asRecord(entry);
    if (!entryRec) continue;

    for (const change of asArray(entryRec.changes)) {
      const changeRec = asRecord(change);
      if (!changeRec) continue;

      const value = asRecord(changeRec.value);
      const metadata = value ? asRecord(value.metadata) : null;
      const phoneNumberId = metadata ? readString(metadata.phone_number_id) : null;
      const field = readString(changeRec.field);

      const messageIds: string[] = [];
      for (const message of asArray(value?.messages)) {
        const id = readString(asRecord(message)?.id);
        if (id) messageIds.push(id);
      }

      const statusIds: string[] = [];
      for (const status of asArray(value?.statuses)) {
        const id = readString(asRecord(status)?.id);
        if (id) statusIds.push(id);
      }

      summaries.push({
        field,
        phoneNumberId,
        messageCount: messageIds.length,
        statusCount: statusIds.length,
        messageIds,
        statusIds,
      });
    }
  }

  return summaries;
}

/** Extrai phone_number_id(s) do payload padrão da Meta Cloud API. */
export function extractMetaPhoneNumberIds(payload: unknown): string[] {
  const ids = new Set<string>();
  const root = unwrapPayloadRoot(payload);
  if (!root) return [];

  for (const entry of asArray(root.entry)) {
    const entryRec = asRecord(entry);
    if (!entryRec) continue;

    for (const change of asArray(entryRec.changes)) {
      const changeRec = asRecord(change);
      if (!changeRec) continue;
      const value = asRecord(changeRec.value);
      if (!value) continue;
      const metadata = asRecord(value.metadata);
      if (!metadata) continue;
      const phoneNumberId = readString(metadata.phone_number_id);
      if (phoneNumberId) ids.add(phoneNumberId);
    }
  }

  return [...ids];
}

/** Extrai tipos de evento (fields) do payload Meta. */
export function extractMetaEventTypes(payload: unknown): string[] {
  const types = new Set<string>();
  const root = unwrapPayloadRoot(payload);
  if (!root) return [];

  const objectType = readString(root.object);
  if (objectType) types.add(objectType);

  for (const entry of asArray(root.entry)) {
    const entryRec = asRecord(entry);
    if (!entryRec) continue;

    for (const change of asArray(entryRec.changes)) {
      const changeRec = asRecord(change);
      if (!changeRec) continue;
      const field = readString(changeRec.field);
      if (field) types.add(field);
    }
  }

  return [...types];
}

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

/** Normaliza um campo de telefone Meta (wa_id, from, display_phone_number). */
export function parseMetaPhoneField(raw: unknown): MetaParsedPhoneField | null {
  const text = readString(raw);
  if (!text) return null;

  const e164 = normalizePhoneE164(text);
  if (!e164) return null;

  return {
    raw: text,
    e164,
    display: formatPhoneDisplay(e164) || text,
    valid: isValidE164Digits(e164),
  };
}

/** Extrai e normaliza telefones de cada change do payload Meta Cloud API. */
export function parseMetaWebhookPhones(payload: unknown): MetaWebhookParsedChange[] {
  const parsed: MetaWebhookParsedChange[] = [];
  const root = unwrapPayloadRoot(payload);
  if (!root) return parsed;

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
      const displayPhoneNumber = parseMetaPhoneField(metadata?.display_phone_number);

      const contacts: MetaWebhookParsedChange["contacts"] = [];
      for (const contact of asArray(value.contacts)) {
        const contactRec = asRecord(contact);
        if (!contactRec) continue;
        const waId = parseMetaPhoneField(contactRec.wa_id);
        if (!waId) continue;
        const profile = asRecord(contactRec.profile);
        contacts.push({
          wa_id: waId,
          name: readString(profile?.name),
        });
      }

      const messages: MetaWebhookParsedChange["messages"] = [];
      for (const message of asArray(value.messages)) {
        const messageRec = asRecord(message);
        if (!messageRec) continue;
        const from = parseMetaPhoneField(messageRec.from);
        if (!from) continue;
        messages.push({
          from,
          id: readString(messageRec.id),
          type: readString(messageRec.type),
        });
      }

      parsed.push({
        phone_number_id: phoneNumberId,
        display_phone_number: displayPhoneNumber,
        contacts,
        messages,
      });
    }
  }

  return parsed;
}

/** Payload de auditoria: body sanitizado + telefones parseados (sem tokens/headers). */
export function buildMetaWebhookAuditPayload(
  payload: unknown,
  parsedPhones: MetaWebhookParsedChange[],
): Record<string, unknown> {
  return {
    body: sanitizeMetaWebhookPayload(payload),
    parsed_phones: parsedPhones,
  };
}
