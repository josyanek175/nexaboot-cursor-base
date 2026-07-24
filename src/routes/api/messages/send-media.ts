// POST /api/messages/send-media — envia documento (multipart) roteando Meta ou Evolution.
// Campos: conversation_id, file, caption? (opcional), media_type=document, retry_message_id? (opcional)
import { createFileRoute } from "@tanstack/react-router";
import { requireCompanyId } from "@/lib/company.server";
import { sendConversationDocument } from "@/lib/document-send.server";
import { ensureCrmSchema, sql } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/messages/send-media")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await ensureCrmSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return Response.json({ error: "invalid_form", message: "Não foi possível enviar o documento" }, { status: 400 });
        }

        const conversationId = String(
          form.get("conversation_id") ?? form.get("conversationId") ?? "",
        );
        const caption = String(form.get("caption") ?? "");
        const mediaType = String(form.get("media_type") ?? form.get("mediaType") ?? "document");
        const retryMessageId = String(form.get("retry_message_id") ?? form.get("retryMessageId") ?? "") || null;
        const file = form.get("file");

        if (!UUID_RE.test(conversationId)) {
          return Response.json({ error: "invalid_conversation_id" }, { status: 400 });
        }
        if (!(file instanceof File) && !retryMessageId) {
          return Response.json({ error: "missing_file", message: "Não foi possível enviar o documento" }, { status: 400 });
        }

        const uid = getSessionUserId();
        const s = sql();
        const attendantRows = uid
          ? await s<{ id: string; name: string | null }[]>`
              SELECT id, name FROM public.users
              WHERE id = ${uid}::uuid AND company_id = ${companyId}::uuid
              LIMIT 1
            `
          : [];
        const attendant = attendantRows[0] ?? null;

        const result = await sendConversationDocument({
          companyId,
          conversationId,
          file: file instanceof File ? file : null,
          caption,
          mediaType,
          sentByUserId: attendant?.id ?? null,
          sentByName: attendant?.name ?? null,
          retryMessageId,
        });

        if (!result.ok) {
          return Response.json(
            {
              error: result.error,
              code: result.error,
              message: result.message ?? "Não foi possível enviar o documento",
              provider: result.provider,
              messageId: result.messageId ?? null,
            },
            { status: result.status },
          );
        }

        return Response.json({
          ok: true,
          provider: result.provider,
          message: result.message,
        });
      },
    },
  },
});
