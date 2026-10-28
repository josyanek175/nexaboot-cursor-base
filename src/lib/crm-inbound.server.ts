// Upsert de contato/conversa/mensagem inbound — modelo compartilhado CRM.
// Usado pelo webhook Meta; Evolution mantém cópia local até refatoração futura.

import { getSql } from "@/lib/pg.server";
import { normalizePhoneForMatch } from "@/lib/phone";
import { validProfileName } from "@/lib/attendance-lifecycle";

export type CrmSql = {
  <T extends object[] = Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
};
function executor(injected?: CrmSql): CrmSql {
  return (injected ?? getSql()) as unknown as CrmSql;
}

/** Contato inbound (Evolution/Meta). fromMe=false para mensagens recebidas da Meta. */
export async function upsertInboundContact(params: {
  sql?: CrmSql;
  companyId: string;
  phone: string;
  externalJid: string;
  name?: string;
  fromMe?: boolean;
}): Promise<string> {
  const { companyId, phone, externalJid, fromMe = false } = params;
  const name = fromMe ? null : validProfileName(params.name);
  const s = executor(params.sql);
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
      VALUES (${companyId}::uuid, ${phone}, ${phoneMatch}, ${finalName}, ${nameSource}, ${externalJid}, 'individual')
      ON CONFLICT DO NOTHING RETURNING id
    `;
    if (inserted[0]) return inserted[0].id;
    const winner = await s<{ id: string }[]>`SELECT id FROM public.contacts
      WHERE company_id = ${companyId}::uuid AND phone_match = ${phoneMatch}
        AND status IS DISTINCT FROM 'merged' AND status IS DISTINCT FROM 'inativo' LIMIT 1`;
    if (winner[0]) return winner[0].id;
    throw new Error("contact_upsert_failed");
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

/** Meta starts a new automation cycle by reopening the existing conversation. */
export async function upsertInboundConversation(params: {
  sql?: CrmSql;
  companyId: string;
  channelId: string;
  contactId: string;
  initialUnread?: number;
  newCycle?: boolean;
  onCycleReopened?: () => void;
  echo?: boolean;
}): Promise<string> {
  if (!params.sql) {
    return getSql().begin(async (tx) =>
      upsertInboundConversation({ ...params, sql: tx as unknown as CrmSql }),
    ) as Promise<string>;
  }
  const { companyId, channelId, contactId } = params;
  const s = executor(params.sql);
  // Lock the contact: absent conversations cannot be protected by FOR UPDATE.
  await s`SELECT id FROM public.contacts WHERE id = ${contactId}::uuid
    AND company_id = ${companyId}::uuid FOR UPDATE`;
  const existing = await s<{ id: string; status: string | null }[]>`
    SELECT id, status FROM public.conversations
    WHERE company_id = ${companyId}::uuid AND whatsapp_channel_id = ${channelId}::uuid
      AND contact_id = ${contactId}::uuid
      AND status IS DISTINCT FROM 'merged' AND status IS DISTINCT FROM 'archived'
      AND (${!params.newCycle || !!params.echo} OR status IN ('open', 'waiting', 'finished', 'closed', 'resolved'))
    ORDER BY (status IN ('open', 'waiting')) DESC, last_message_at DESC NULLS LAST, created_at DESC
    LIMIT 1 FOR UPDATE
  `;
  if (existing[0]) {
    if (params.newCycle && !params.echo && ["finished", "closed", "resolved"].includes(existing[0].status ?? "")) {
      await s`UPDATE public.conversations SET status='open',updated_at=now()
        WHERE id=${existing[0].id}::uuid AND company_id=${companyId}::uuid`;
      const tables = await s<{ present: string | null }[]>`SELECT to_regclass('public.automation_sessions')::text AS present`;
      if (tables[0]?.present)
        await s`UPDATE public.automation_sessions
          SET status='ready',step_id=NULL,collected='{}'::jsonb,source='inbound',updated_at=now()
          WHERE conversation_id=${existing[0].id}::uuid AND company_id=${companyId}::uuid
            AND NOT EXISTS (SELECT 1 FROM public.conversation_assignments a
              WHERE a.conversation_id=${existing[0].id}::uuid AND a.active=true AND a.unassigned_at IS NULL)`;
      params.onCycleReopened?.();
    }
    if (!params.newCycle && !params.echo && existing[0].status !== "open") {
      await s`UPDATE public.conversations SET status = 'open', updated_at = now() WHERE id = ${existing[0].id}::uuid`;
    }
    return existing[0].id;
  }
  const inserted = await s<{ id: string }[]>`
    INSERT INTO public.conversations
      (company_id, contact_id, whatsapp_channel_id, status, unread_count, last_message_at)
    VALUES (${companyId}::uuid, ${contactId}::uuid, ${channelId}::uuid,
      ${params.echo ? "finished" : "open"}, ${params.echo ? 0 : (params.initialUnread ?? (params.newCycle ? 0 : 1))}, now()) ON CONFLICT DO NOTHING RETURNING id
  `;
  if (inserted[0]) return inserted[0].id;
  const winner = await s<{ id: string }[]>`SELECT id FROM public.conversations
    WHERE company_id = ${companyId}::uuid AND whatsapp_channel_id = ${channelId}::uuid
      AND contact_id = ${contactId}::uuid AND status IN ('open', 'waiting') LIMIT 1`;
  if (!winner[0]) throw new Error("conversation_upsert_failed");
  return winner[0].id;
}

export async function insertInboundTextMessage(params: {
  sql?: CrmSql;
  conversationId: string;
  externalMessageId: string;
  messageText: string;
  messageType?: "text" | "location";
  rawPayload: unknown;
}): Promise<string | null> {
  const { conversationId, externalMessageId, messageText, rawPayload } = params;
  const s = executor(params.sql);

  const inserted = await s<{ id: string }[]>`
    INSERT INTO public.messages (
      conversation_id, external_id, external_message_id, direction,
      message_type, message_text, from_me, raw_payload, status
    ) VALUES (
      ${conversationId}::uuid, ${externalMessageId}, ${externalMessageId}, 'in',
      ${params.messageType ?? 'text'}, ${messageText}, false, ${rawPayload}::jsonb, 'received'
    )
    ON CONFLICT (conversation_id, external_message_id) WHERE external_message_id IS NOT NULL
    DO NOTHING
    RETURNING id
  `;

  return inserted[0]?.id ?? null;
}

export async function insertInboundMediaMessage(params: {
  sql?: CrmSql;
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
  const s = executor(params.sql);

  const inserted = await s<{ id: string }[]>`
    INSERT INTO public.messages (
      conversation_id, external_id, external_message_id, direction,
      message_type, message_text, from_me, raw_payload, status,
      media_type, media_mimetype, mime_type, media_filename, media_caption,
      media_base64, media_error, media_url, media_size
    ) VALUES (
      ${conversationId}::uuid, ${externalMessageId}, ${externalMessageId}, 'in',
      ${mediaType}, ${messageText}, false, ${rawPayload}::jsonb, 'received',
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
  sql?: CrmSql;
  conversationId: string;
  lastMessageText: string;
}): Promise<void> {
  const { conversationId, lastMessageText } = params;
  const s = executor(params.sql);
  await s`
    UPDATE public.conversations
    SET last_message = ${lastMessageText},
        last_message_at = now(),
        unread_count = COALESCE(unread_count, 0) + 1,
        updated_at = now()
    WHERE id = ${conversationId}::uuid
  `;
}

/** Echo do WhatsApp Business App. Grava como enviada, sem reenviar ao cliente. */
export async function insertWhatsappBusinessAppEcho(params: {
  sql?: CrmSql;
  conversationId: string;
  externalMessageId: string;
  messageType: string;
  messageText: string | null;
  rawPayload: unknown;
  persistSource?: boolean;
}): Promise<string | null> {
  const { conversationId, externalMessageId, messageType, messageText, rawPayload } = params;
  const s = executor(params.sql);
  const inserted =
    params.persistSource === false
      ? await s<{ id: string }[]>`
      INSERT INTO public.messages (
        conversation_id, external_id, external_message_id, direction,
        message_type, message_text, from_me, raw_payload, status
      ) VALUES (
        ${conversationId}::uuid, ${externalMessageId}, ${externalMessageId}, 'out',
        ${messageType}, ${messageText}, true, ${rawPayload}::jsonb, 'received'
      ) ON CONFLICT (conversation_id, external_message_id) WHERE external_message_id IS NOT NULL
      DO NOTHING RETURNING id
    `
      : await s<{ id: string }[]>`
    INSERT INTO public.messages (
      conversation_id, external_id, external_message_id, direction,
      message_type, message_text, from_me, raw_payload, status, message_source
    ) VALUES (
      ${conversationId}::uuid, ${externalMessageId}, ${externalMessageId}, 'out',
      ${messageType}, ${messageText}, true, ${rawPayload}::jsonb, 'received',
      'whatsapp_business_app'
    )
    ON CONFLICT (conversation_id, external_message_id) WHERE external_message_id IS NOT NULL
    DO NOTHING
    RETURNING id
  `;
  return inserted[0]?.id ?? null;
}

export async function bumpConversationAfterBusinessAppEcho(params: {
  sql?: CrmSql;
  conversationId: string;
  lastMessageText: string;
}): Promise<void> {
  const s = executor(params.sql);
  await s`
    UPDATE public.conversations
    SET last_message = ${params.lastMessageText},
        last_message_at = now(),
        updated_at = now()
    WHERE id = ${params.conversationId}::uuid
  `;
}
