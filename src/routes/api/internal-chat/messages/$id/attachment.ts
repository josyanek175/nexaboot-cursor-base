// Download/visualização protegida de anexo da Comunicação Interna.
// GET /api/internal-chat/messages/:id/attachment
// Regras de segurança:
//   - exige sessão válida
//   - exige que o usuário seja participante do chat da mensagem
//   - busca attachment_path no banco (nunca aceita caminho vindo do cliente)
//   - lê do volume com proteção contra path traversal
//   - inline para imagem/PDF; attachment (download) para documentos
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";
import { requireCompanyId } from "@/lib/company.server";
import { readAttachment } from "@/lib/internal-upload.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function contentDisposition(type: string | null, mime: string | null, originalName: string | null) {
  const name = (originalName || "arquivo").replace(/["\\\r\n]/g, "");
  const inline = type === "image" || mime === "application/pdf";
  const dispo = inline ? "inline" : "attachment";
  const encoded = encodeURIComponent(name);
  return `${dispo}; filename="${name}"; filename*=UTF-8''${encoded}`;
}

export const Route = createFileRoute("/api/internal-chat/messages/$id/attachment")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        await ensureSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });

        const messageId = params.id;
        if (!UUID_RE.test(messageId)) {
          return Response.json({ error: "invalid_id" }, { status: 400 });
        }

        const s = sql();
        // Mensagem + participação do usuário + chat da MESMA empresa (autorização).
        const rows = await s`
          SELECT m.attachment_path, m.attachment_mime_type,
                 m.attachment_original_name, m.attachment_type,
                 mem.user_id AS member_id
          FROM internal_messages m
          JOIN internal_chats c ON c.id = m.chat_id AND c.company_id = ${companyId}::uuid
          LEFT JOIN internal_chat_members mem
            ON mem.chat_id = m.chat_id AND mem.user_id = ${uid}
          WHERE m.id = ${messageId}
          LIMIT 1
        `;
        const row = rows[0];
        if (!row) return Response.json({ error: "not_found" }, { status: 404 });
        if (!row.member_id) return Response.json({ error: "forbidden" }, { status: 403 });
        if (!row.attachment_path) return Response.json({ error: "no_attachment" }, { status: 404 });

        const buffer = await readAttachment(row.attachment_path);
        if (!buffer) return Response.json({ error: "file_missing" }, { status: 404 });

        const mime = row.attachment_mime_type || "application/octet-stream";
        return new Response(new Uint8Array(buffer), {
          status: 200,
          headers: {
            "Content-Type": mime,
            "Content-Length": String(buffer.length),
            "Cache-Control": "private, max-age=86400",
            "Content-Disposition": contentDisposition(
              row.attachment_type,
              row.attachment_mime_type,
              row.attachment_original_name,
            ),
          },
        });
      },
    },
  },
});
