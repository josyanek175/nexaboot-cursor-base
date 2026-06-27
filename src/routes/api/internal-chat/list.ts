import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";

export const Route = createFileRoute("/api/internal-chat/list")({
  server: {
    handlers: {
      GET: async () => {
        await ensureSchema();
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
            (SELECT body FROM internal_messages m WHERE m.chat_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
            (SELECT created_at FROM internal_messages m WHERE m.chat_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_at,
            (SELECT COUNT(*) FROM internal_notifications n WHERE n.user_id = ${uid} AND n.chat_id = c.id AND n.read_at IS NULL)::int AS unread
          FROM internal_chats c
          JOIN internal_chat_members mem ON mem.chat_id = c.id
          WHERE mem.user_id = ${uid}
          ORDER BY last_message_at DESC NULLS LAST, c.created_at DESC
        `;

        return Response.json({ chats });
      },
    },
  },
});
