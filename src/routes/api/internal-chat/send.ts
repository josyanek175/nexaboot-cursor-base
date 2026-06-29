// Envio de mensagem na Comunicação Interna.
// Aceita JSON (texto puro) OU multipart/form-data (texto, arquivo, ou ambos).
// Arquivos são gravados em disco/volume (ver internal-upload.server.ts); o banco
// guarda apenas metadados + caminho. Notificações são criadas para os demais membros.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql, ensureSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";
import { requireCompanyId } from "@/lib/company.server";
import { saveInternalAttachment, UploadError, type SavedAttachment } from "@/lib/internal-upload.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JsonBody = z.object({
  chatId: z.string().uuid(),
  body: z.string().min(1).max(4000),
});

export const Route = createFileRoute("/api/internal-chat/send")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await ensureSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });

        const contentType = request.headers.get("content-type") || "";
        let chatId = "";
        let body = "";
        let file: File | null = null;

        if (contentType.includes("multipart/form-data")) {
          let form: FormData;
          try {
            form = await request.formData();
          } catch {
            return Response.json({ error: "invalid_form" }, { status: 400 });
          }
          chatId = String(form.get("chatId") ?? "");
          body = String(form.get("body") ?? "").trim();
          const f = form.get("file");
          if (f && f instanceof File && f.size > 0) file = f;
          if (!UUID_RE.test(chatId)) {
            return Response.json({ error: "invalid_input" }, { status: 400 });
          }
          if (body.length > 4000) {
            return Response.json({ error: "body_too_long" }, { status: 400 });
          }
          if (!body && !file) {
            return Response.json({ error: "empty_message" }, { status: 400 });
          }
        } else {
          const json = await request.json().catch(() => null);
          const parsed = JsonBody.safeParse(json);
          if (!parsed.success) {
            return Response.json({ error: "invalid_input" }, { status: 400 });
          }
          chatId = parsed.data.chatId;
          body = parsed.data.body;
        }

        const s = sql();
        // Membership + chat da MESMA empresa do usuário logado.
        const member = await s`
          SELECT 1
          FROM internal_chat_members mem
          JOIN internal_chats c ON c.id = mem.chat_id
          WHERE mem.chat_id = ${chatId} AND mem.user_id = ${uid}
            AND c.company_id = ${companyId}::uuid
        `;
        if (!member.length) return Response.json({ error: "forbidden" }, { status: 403 });

        // Grava o arquivo em disco SOMENTE após validar a permissão no chat.
        let att: SavedAttachment | null = null;
        if (file) {
          try {
            att = await saveInternalAttachment(file);
          } catch (e) {
            if (e instanceof UploadError) {
              return Response.json({ error: e.code, message: e.message }, { status: e.status });
            }
            console.error("[INTERNAL_UPLOAD_FAIL]", e);
            return Response.json({ error: "upload_failed" }, { status: 500 });
          }
        }

        const inserted = await s`
          INSERT INTO internal_messages
            (chat_id, sender_id, body,
             attachment_path, attachment_mime_type, attachment_filename,
             attachment_original_name, attachment_size, attachment_type)
          VALUES
            (${chatId}, ${uid}, ${body},
             ${att?.path ?? null}, ${att?.mimeType ?? null}, ${att?.filename ?? null},
             ${att?.originalName ?? null}, ${att?.size ?? null}, ${att?.type ?? null})
          RETURNING id, chat_id, sender_id, body, created_at,
                    attachment_mime_type, attachment_original_name,
                    attachment_size, attachment_type
        `;
        const msg = inserted[0];

        // Notificações para os demais membros (também quando a mensagem é só anexo).
        await s`
          INSERT INTO internal_notifications (user_id, chat_id, message_id)
          SELECT user_id, ${chatId}, ${msg.id}
          FROM internal_chat_members
          WHERE chat_id = ${chatId} AND user_id <> ${uid}
        `;
        return Response.json({ message: msg });
      },
    },
  },
});
