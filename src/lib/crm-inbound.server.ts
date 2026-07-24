// Upsert de contato/conversa/mensagem inbound — modelo compartilhado CRM.
// Usado pelo webhook Meta; Evolution mantém cópia local até refatoração futura.

import { sql } from "@/lib/pg.server";
import { normalizePhoneForMatch } from "@/lib/phone";

/** Contato inbound (Evolution/Meta). fromMe=false para mensagens recebidas da Meta. */
export async function upsertInboundContact(params: {
  companyId: string;
  phone: string;
  externalJid: string;
  name?: string;
  fromMe?: boolean;
}): Promise<string> {
  const { companyId, phone, externalJid, name, fromMe = false } = params;
  const s = sql();
  const phoneMatch = normalizePhoneForMatch(phone);

  const existing = await s<
    { id: string; name: string | null; name_source: string | null; status: string | null }[]
  >`
    SELECT id, name, name_source, status FROM public.contacts
    WHERE company_id = ${companyId}::uuid AND phone_match = ${phoneMatch}
    ORDER BY (status IS DISTINCT FROM 'merged' AND status IS DISTINCT FROM 'inativo') DESC,
             created_at ASC
    LIMIT 1
  `;

  if (existing[0]) {
    const c = existing[0];
    const cur = c.name;
    const isManual = c.name_source === "manual";
    const isPlaceholder = !cur || cur.trim() === "" || cur === phone;
    if (!fromMe && name && name.trim() && !isManual && isPlaceholder) {
      await s`
        UPDATE public.contacts
        SET name = ${name}, name_source = 'whatsapp', updated_at = now()
        WHERE id = ${c.id}::uuid
      `;
    }
    if (c.status === "inativo") {
      await s`UPDATE public.contacts SET status = 'ativo', updated_at = now() WHERE id = ${c.id}::uuid`;
      console.log("[CONTACT_REACTIVATED]", { id: c.id, phone });
    }
    return c.id;
  }

  const finalName = fromMe ? phone : name && name.trim() ? name : phone;
  const nameSource = !fromMe && name && name.trim() ? "whatsapp" : "auto";

  try {
    const inserted = await s<{ id: string }[]>`
      INSERT INTO public.contacts
        (company_id, phone, phone_match, name, name_source, external_jid, contact_type)
      VALUES
        (${companyId}::uuid, ${phone}, ${phoneMatch}, ${finalName}, ${nameSource}, ${externalJid}, 'individual')
      RETURNING id
    `;
    return inserted[0].id;
  } catch (e) {
    const again = await s<{ id: string }[]>`
      SELECT id FROM public.contacts
      WHERE company_id = ${companyId}::uuid AND phone_match = ${phoneMatch}
      ORDER BY (status IS DISTINCT FROM 'merged' AND status IS DISTINCT FROM 'inativo') DESC,
               created_at ASC
      LIMIT 1
    `;
    if (again[0]) return again[0].id;
    throw e;
  }
}

export async function upsertInboundConversation(params: {
  companyId: string;
  channelId: string;
  contactId: string;
}): Promise<string> {
  const { companyId, channelId, contactId } = params;
  const s = sql();

  const existing = await s<{ id: string; status: string | null }[]>`
    SELECT id, status FROM public.conversations
    WHERE company_id = ${companyId}::uuid
      AND whatsapp_channel_id = ${channelId}::uuid
      AND contact_id = ${contactId}::uuid
      AND status IS DISTINCT FROM 'merged'
      AND status IS DISTINCT FROM 'archived'
    ORDER BY (status = 'open') DESC, last_message_at DESC NULLS LAST, created_at DESC
    LIMIT 1
  `;

  if (existing[0]) {
    if (existing[0].status !== "open") {
      await s`UPDATE public.conversations SET status = 'open', updated_at = now() WHERE id = ${existing[0].id}::uuid`;
    }
    return existing[0].id;
  }

  const inserted = await s<{ id: string }[]>`
    INSERT INTO public.conversations
      (company_id, contact_id, whatsapp_channel_id, status, unread_count, last_message_at)
    VALUES
      (${companyId}::uuid, ${contactId}::uuid, ${channelId}::uuid, 'open', 1, now())
    RETURNING id
  `;
  return inserted[0].id;
}

export async function insertInboundTextMessage(params: {
  conversationId: string;
  externalMessageId: string;
  messageText: string;
  rawPayload: unknown;
}): Promise<string | null> {
  const { conversationId, externalMessageId, messageText, rawPayload } = params;
  const s = sql();

  const inserted = await s<{ id: string }[]>`
    INSERT INTO public.messages (
      conversation_id, external_id, external_message_id, direction,
      message_type, message_text, from_me, raw_payload, status
    ) VALUES (
      ${conversationId}::uuid, ${externalMessageId}, ${externalMessageId}, 'in',
      'text', ${messageText}, false, ${JSON.stringify(rawPayload)}::jsonb, 'received'
    )
    ON CONFLICT (conversation_id, external_message_id) WHERE external_message_id IS NOT NULL
    DO NOTHING
    RETURNING id
  `;

  return inserted[0]?.id ?? null;
}

export async function insertInboundMediaMessage(params: {
  conversationId: string;
  externalMessageId: string;
  mediaType: string;
  messageText: string | null;
  caption: string | null;
  mimeType: string | null;
  filename: string | null;
  mediaBase64: string | null;
  mediaError: string | null;
  mediaSize: number | null;
  rawPayload: unknown;
}): Promise<string | null> {
  const {
    conversationId,
    externalMessageId,
    mediaType,
    messageText,
    caption,
    mimeType,
    filename,
    mediaBase64,
    mediaError,
    mediaSize,
    rawPayload,
  } = params;
  const s = sql();

  const inserted = await s<{ id: string }[]>`
    INSERT INTO public.messages (
      conversation_id, external_id, external_message_id, direction,
      message_type, message_text, from_me, raw_payload, status,
      media_type, media_mimetype, mime_type, media_filename, media_caption,
      media_base64, media_error, media_url, media_size
    ) VALUES (
      ${conversationId}::uuid, ${externalMessageId}, ${externalMessageId}, 'in',
      ${mediaType}, ${messageText}, false, ${JSON.stringify(rawPayload)}::jsonb, 'received',
      ${mediaType}, ${mimeType}, ${mimeType}, ${filename}, ${caption},
      ${mediaBase64}, ${mediaError}, ${null}, ${mediaSize}
    )
    ON CONFLICT (conversation_id, external_message_id) WHERE external_message_id IS NOT NULL
    DO NOTHING
    RETURNING id
  `;

  const messageId = inserted[0]?.id ?? null;
  if (messageId && mediaBase64) {
    const mediaUrl = `/api/messages/${messageId}/media`;
    await s`UPDATE public.messages SET media_url = ${mediaUrl} WHERE id = ${messageId}::uuid`;
  }

  return messageId;
}

export async function bumpConversationAfterInboundMessage(params: {
  conversationId: string;
  lastMessageText: string;
}): Promise<void> {
  const { conversationId, lastMessageText } = params;
  const s = sql();
  await s`
    UPDATE public.conversations
    SET last_message = ${lastMessageText},
        last_message_at = now(),
        unread_count = COALESCE(unread_count, 0) + 1,
        updated_at = now()
    WHERE id = ${conversationId}::uuid
  `;
}
