import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";
import { requireCompanyId } from "@/lib/company.server";

export const Route = createFileRoute("/api/internal-chat/messages")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await ensureSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
        const url = new URL(request.url);
        const chatId = url.searchParams.get("chatId");
        if (!chatId) return Response.json({ error: "missing_chatId" }, { status: 400 });
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

        const messages = await s`
          SELECT m.id, m.chat_id, m.sender_id, m.body, m.created_at,
                 m.attachment_mime_type, m.attachment_original_name,
                 m.attachment_size, m.attachment_type,
                 u.name AS sender_name
          FROM internal_messages m
          JOIN users u ON u.id = m.sender_id
          WHERE m.chat_id = ${chatId}
          ORDER BY m.created_at ASC
          LIMIT 500
        `;
        // marca notificações como lidas
        await s`
          UPDATE internal_notifications
          SET read_at = now()
          WHERE user_id = ${uid} AND chat_id = ${chatId} AND read_at IS NULL
        `;
        await s`
          UPDATE internal_chat_members
          SET last_read_at = now()
          WHERE chat_id = ${chatId} AND user_id = ${uid}
        `;
        return Response.json({ messages });
      },
    },
  },
});
