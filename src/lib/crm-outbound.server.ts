// Persistência de mensagens texto outbound — modelo compartilhado CRM.

import { sql } from "@/lib/pg.server";

export async function insertOutboundTextMessage(params: {
  conversationId: string;
  messageText: string;
  externalMessageId?: string | null;
  rawPayload?: unknown;
  sentByUserId?: string | null;
  sentByName?: string | null;
  status?: "sent" | "queued";
}): Promise<{
  id: string;
  conversation_id: string;
  direction: string;
  message_type: string;
  message_text: string;
  from_me: boolean;
  status: string;
  created_at: string;
  sent_by_user_id: string | null;
  sent_by_name: string | null;
} | null> {
  const {
    conversationId,
    messageText,
    externalMessageId = null,
    rawPayload = null,
    sentByUserId = null,
    sentByName = null,
    status = "sent",
  } = params;
  const s = sql();

  const inserted = await s<
    {
      id: string;
      conversation_id: string;
      direction: string;
      message_type: string;
      message_text: string;
      from_me: boolean;
      status: string;
      created_at: string;
      sent_by_user_id: string | null;
      sent_by_name: string | null;
    }[]
  >`
    INSERT INTO public.messages (
      conversation_id, external_id, external_message_id, direction,
      message_type, message_text, from_me, raw_payload, status,
      sent_by_user_id, sent_by_name
    ) VALUES (
      ${conversationId}::uuid, ${externalMessageId}, ${externalMessageId}, 'out',
      'text', ${messageText}, true,
      ${rawPayload != null ? JSON.stringify(rawPayload) : null}::jsonb,
      ${status},
      ${sentByUserId}::uuid, ${sentByName}
    )
    RETURNING id, conversation_id, direction, message_type,
              message_text, from_me, status, created_at,
              sent_by_user_id, sent_by_name
  `;

  return inserted[0] ?? null;
}

export async function bumpConversationAfterOutboundMessage(params: {
  conversationId: string;
  lastMessageText: string;
}): Promise<void> {
  const { conversationId, lastMessageText } = params;
  const s = sql();
  await s`
    UPDATE public.conversations
    SET last_message = ${lastMessageText},
        last_message_at = now(),
        updated_at = now()
    WHERE id = ${conversationId}::uuid
  `;
}
