import { z } from "zod";
import { getSql } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";
import { getSessionUserId } from "@/lib/session.server";
import { requireConversationAccess } from "@/lib/channel-permissions.server";
import { sendConversationText } from "@/lib/message-send-router.server";
import { sendConversationDocument } from "@/lib/document-send.server";
import { getMessageMedia } from "@/lib/message-media-read.server";
import { sendInternalMessage } from "@/lib/internal-message-send.server";
import { createInternalChat } from "@/lib/internal-chat-create.server";
import { locationFromPayload, locationMessageText } from "@/lib/whatsapp-location";

const Target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("external"), conversationId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("internal"), chatId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("user"), userId: z.string().uuid() }).strict(),
]);
const Body = z.object({ messageId: z.string().uuid(), target: Target }).strict();
const fail = (message: string, status = 400) =>
  Response.json({ error: "forward_rejected", message }, { status });

/** O cliente informa somente origem/destino; conteúdo, arquivo e empresa vêm do servidor. */
export async function forwardMessage(request: Request): Promise<Response> {
  const company = await requireCompanyId();
  if (company instanceof Response) return company;
  const uid = getSessionUserId();
  if (!uid) return fail("Entre novamente para encaminhar mensagens.", 401);
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Selecione uma mensagem e um destinatário válido.");
  const { messageId, target } = parsed.data;
  const db = getSql();
  const rows = await db`
    SELECT m.id, m.conversation_id, m.message_type, m.message_text, m.raw_payload,
           m.media_filename, m.mime_type, m.media_mimetype, m.media_caption, m.direction
    FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id
    WHERE m.id=${messageId}::uuid AND c.company_id=${company}::uuid LIMIT 1
  `;
  const source = rows[0];
  if (!source) return fail("Mensagem não encontrada.", 404);
  const denied = await requireConversationAccess(company, source.conversation_id, uid);
  if (denied) return denied;
  const kind = String(source.message_type);
  if (
    !["text", "image", "document", "location"].includes(kind) ||
    !["in", "out"].includes(source.direction)
  )
    return fail("Este tipo de mensagem não pode ser encaminhado.");
  const location = locationFromPayload(source.raw_payload);
  if (kind === "location" && !location) return fail("A localização desta mensagem é inválida.");
  const text =
    location && kind === "location"
      ? locationMessageText(location)
      : String(source.message_text ?? "");
  const media = kind === "image" || kind === "document";
  if (!media && !text.trim()) return fail("Esta mensagem não possui conteúdo para encaminhar.");

  let chatId: string | null = target.kind === "internal" ? target.chatId : null;
  if (target.kind === "external") {
    if (target.conversationId === source.conversation_id)
      return fail("Escolha outra conversa para encaminhar.");
    const denied = await requireConversationAccess(company, target.conversationId, uid);
    if (denied) return denied;
  } else if (target.kind === "internal") {
    const members =
      await db`SELECT c.id FROM internal_chats c JOIN internal_chat_members mem ON mem.chat_id=c.id
      WHERE c.id=${target.chatId}::uuid AND c.company_id=${company}::uuid AND mem.user_id=${uid}::uuid
      AND COALESCE((to_jsonb(c)->>'active')::boolean,true)=true`;
    if (!members[0]) return fail("Você não participa deste grupo ou conversa interna.", 403);
  } else {
    // O serviço existente valida que o atendente está ativo e pertence à mesma empresa.
    const response = await createInternalChat(
      new Request("http://internal/api/internal-chat/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "direct", memberIds: [target.userId] }),
      }),
    );
    if (!response.ok) return response;
    chatId = (await response.json()).chat.id;
  }

  let file: File | null = null;
  if (media) {
    // Reutiliza a leitura protegida: base64/recuperação Meta, sem buscar URLs do cliente.
    const response = await getMessageMedia(messageId);
    if (!response.ok)
      return fail("Arquivo indisponível. Abra a mídia original e tente novamente.", 409);
    const limit = target.kind === "external" ? (kind === "image" ? 5 : 16) : 10;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > limit * 1024 * 1024)
      return fail(`O arquivo ultrapassa o limite de ${limit} MB para este encaminhamento.`, 413);
    const mime = response.headers.get("Content-Type")?.split(";")[0] || "application/octet-stream";
    const extensions: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "application/pdf": "pdf",
      "application/msword": "doc",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
      "application/vnd.ms-excel": "xls",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    };
    const name = source.media_filename || `arquivo.${extensions[mime] || "bin"}`;
    file = new File([buffer], name, { type: mime });
  }
  if (target.kind !== "external") {
    const form = new FormData();
    form.set("chatId", chatId!);
    form.set(
      "body",
      ["↪ Encaminhada do atendimento", media ? source.media_caption : text]
        .filter(Boolean)
        .join("\n"),
    );
    if (file) form.set("file", file);
    return sendInternalMessage(
      new Request("http://internal/api/internal-chat/send", { method: "POST", body: form }),
    );
  }
  const actors = await db`SELECT id,name FROM public.users WHERE id=${uid}::uuid AND active=true
    AND (company_id=${company}::uuid OR role IN ('TI','SUPER_ADMIN','ADMIN_GERAL')) LIMIT 1`;
  if (!actors[0]) return fail("Usuário sem permissão para enviar.", 403);
  const context = {
    companyId: company,
    conversationId: target.conversationId,
    sentByUserId: uid,
    sentByName: actors[0].name,
  };
  const result = file
    ? await sendConversationDocument({
        ...context,
        file,
        caption: source.media_caption,
        mediaType: kind,
      })
    : await sendConversationText({ ...context, text });
  if (!result.ok)
    return Response.json(
      { error: result.error, message: result.message ?? "Não foi possível encaminhar a mensagem." },
      { status: result.status },
    );
  // Auditoria no destino. Nunca altera a mensagem original.
  if (result.message.id)
    try {
      await db`UPDATE public.messages m SET raw_payload=COALESCE(m.raw_payload,'{}'::jsonb)||${JSON.stringify({ __nexaForward: { sourceMessageId: messageId, actorId: uid } })}::jsonb
    FROM public.conversations c WHERE m.id=${String(result.message.id)}::uuid AND m.conversation_id=c.id AND c.company_id=${company}::uuid`;
    } catch {
      console.error("[MESSAGE_FORWARD_AUDIT_FAILED]", { messageId });
    }
  return Response.json({ ok: true, message: result.message });
}
