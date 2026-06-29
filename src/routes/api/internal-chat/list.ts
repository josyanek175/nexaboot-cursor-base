import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";
import { requireCompanyId } from "@/lib/company.server";

export const Route = createFileRoute("/api/internal-chat/list")({
  server: {
    handlers: {
      GET: async () => {
        await ensureSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
        const s = sql();
        const chats = await s`
          SELECT c.id, c.type, c.created_at,
            CASE
              WHEN c.type = 'direct' THEN COALESCE((
                SELECT u.name FROM internal_chat_members mm
                JOIN users u ON u.id = mm.user_id
                WHERE mm.chat_id = c.id AND mm.user_id <> ${uid}
                LIMIT 1
              ), c.name)
              ELSE c.name
            END AS name,
            (SELECT CASE
                      WHEN m.body <> '' THEN m.body
                      WHEN m.attachment_type = 'image' THEN '📷 Imagem'
                      WHEN m.attachment_type IS NOT NULL THEN '📎 Anexo'
                      ELSE m.body
                    END
               FROM internal_messages m WHERE m.chat_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
            (SELECT created_at FROM internal_messages m WHERE m.chat_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_at,
            (SELECT COUNT(*) FROM internal_notifications n WHERE n.user_id = ${uid} AND n.chat_id = c.id AND n.read_at IS NULL)::int AS unread
          FROM internal_chats c
          JOIN internal_chat_members mem ON mem.chat_id = c.id
          WHERE mem.user_id = ${uid}
            AND c.company_id = ${companyId}::uuid
          ORDER BY last_message_at DESC NULLS LAST, c.created_at DESC
        `;

        return Response.json({ chats });
      },
    },
  },
});
