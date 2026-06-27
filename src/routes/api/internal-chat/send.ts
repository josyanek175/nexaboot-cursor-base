import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql, ensureSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";

const Body = z.object({
  chatId: z.string().uuid(),
  body: z.string().min(1).max(4000),
});

export const Route = createFileRoute("/api/internal-chat/send")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await ensureSchema();
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
        const json = await request.json().catch(() => null);
        const parsed = Body.safeParse(json);
        if (!parsed.success) {
          return Response.json({ error: "invalid_input" }, { status: 400 });
        }
        const { chatId, body } = parsed.data;
        const s = sql();
        const member = await s`
          SELECT 1 FROM internal_chat_members WHERE chat_id = ${chatId} AND user_id = ${uid}
        `;
        if (!member.length) return Response.json({ error: "forbidden" }, { status: 403 });

        const inserted = await s`
          INSERT INTO internal_messages (chat_id, sender_id, body)
          VALUES (${chatId}, ${uid}, ${body})
          RETURNING id, chat_id, sender_id, body, created_at
        `;
        const msg = inserted[0];

        // cria notificações para os demais membros
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
