import { normalizePhoneForMatch } from "@/lib/phone";
import { getSql } from "@/lib/pg.server";
import {
  upsertInboundContact,
  upsertInboundConversation,
  insertInboundTextMessage,
  insertInboundMediaMessage,
  insertWhatsappBusinessAppEcho,
  bumpConversationAfterInboundMessage,
  bumpConversationAfterBusinessAppEcho,
  type CrmSql,
} from "@/lib/crm-inbound.server";

type MessageInput = {
  companyId: string;
  channelId: string;
  phone: string;
  profileName?: string | null;
  externalMessageId: string;
  text: string;
  rawPayload: unknown;
  echo?: boolean;
  messageType?: string;
  media?: Omit<
    Parameters<typeof insertInboundMediaMessage>[0],
    "sql" | "conversationId" | "externalMessageId"
  >;
};
/** Commit contact + cycle + message + automation work before any external send. */
export async function commitMetaAttendanceMessage(input: MessageInput) {
  return getSql().begin(async (transaction) =>
    persistMetaAttendanceMessage(transaction as unknown as CrmSql, input),
  );
}
export async function persistMetaAttendanceMessage(tx: CrmSql, input: MessageInput) {
  // One lock even when the contact does not exist yet. Scope includes the tenant.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${input.companyId + ":" + normalizePhoneForMatch(input.phone)}, 0))`;
  const contactId = await upsertInboundContact({
    sql: tx,
    companyId: input.companyId,
    phone: input.phone,
    externalJid: input.phone,
    fromMe: !!input.echo,
  });
  // Cross-cycle dedup: checking only (conversation_id, wamid) can reopen on replay.
  const duplicate = await tx<{ conversation_id: string }[]>`
    SELECT m.conversation_id FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    WHERE c.company_id = ${input.companyId}::uuid
      AND c.whatsapp_channel_id = ${input.channelId}::uuid
      AND m.external_message_id = ${input.externalMessageId} LIMIT 1
  `;
  if (duplicate[0])
    return { contactId, conversationId: duplicate[0].conversation_id, messageId: null };
  let restartCycle = false;
  const conversationId = await upsertInboundConversation({
    sql: tx,
    companyId: input.companyId,
    channelId: input.channelId,
    contactId,
    newCycle: true,
    onLegacyCycleReused: () => {
      restartCycle = true;
    },
    echo: input.echo,
  });
  const sourceColumns = input.echo
    ? await tx<{ present: boolean }[]>`SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'message_source'
      ) AS present`
    : [];
  const storedPayload = {
    ...(input.rawPayload as Record<string, unknown>),
    ...(!input.echo
      ? {
          __nexaFlow: {
            status: "pending",
            isMedia: !!input.media,
            restartCycle,
            text: input.media ? (input.media.caption ?? "") : input.text,
          },
        }
      : {}),
  };
  const messageId = input.echo
    ? await insertWhatsappBusinessAppEcho({
        sql: tx,
        conversationId,
        externalMessageId: input.externalMessageId,
        messageType: input.messageType ?? "text",
        messageText: input.text,
        rawPayload: {
          ...storedPayload,
          message_source: "whatsapp_business_app",
        },
        persistSource: sourceColumns[0]?.present ?? false,
      })
    : input.media
      ? await insertInboundMediaMessage({
          ...input.media,
          rawPayload: storedPayload,
          sql: tx,
          conversationId,
          externalMessageId: input.externalMessageId,
        })
      : await insertInboundTextMessage({
          sql: tx,
          conversationId,
          externalMessageId: input.externalMessageId,
          messageText: input.text,
          rawPayload: storedPayload,
        });
  if (!messageId) return { contactId, conversationId, messageId: null };
  if (input.echo) {
    await bumpConversationAfterBusinessAppEcho({
      sql: tx,
      conversationId,
      lastMessageText: input.text,
    });
  } else {
    await bumpConversationAfterInboundMessage({
      sql: tx,
      conversationId,
      lastMessageText: input.text,
    });
  }
  return { contactId, conversationId, messageId };
}
