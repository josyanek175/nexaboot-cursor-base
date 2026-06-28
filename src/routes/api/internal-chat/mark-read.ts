// Marca mensagens internas como lidas para o usuário logado.
// Body: { chatId?: uuid }
//   - com chatId: marca apenas as notificações daquele chat (valida membership)
//   - sem chatId: marca TODAS as notificações não lidas do usuário
// Retorna { count } = total restante de não lidas do usuário (para o badge).
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql, ensureSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";

const Body = z.object({
  chatId: z.string().uuid().optional(),
});

export const Route = createFileRoute("/api/internal-chat/mark-read")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await ensureSchema();
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });

        const json = await request.json().catch(() => ({}));
        const parsed = Body.safeParse(json ?? {});
        if (!parsed.success) {
          return Response.json({ error: "invalid_input" }, { status: 400 });
        }
        const chatId = parsed.data.chatId;
        const s = sql();

        if (chatId) {
          const member = await s`
            SELECT 1 FROM internal_chat_members WHERE chat_id = ${chatId} AND user_id = ${uid}
          `;
          if (!member.length) return Response.json({ error: "forbidden" }, { status: 403 });

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
        } else {
          await s`
            UPDATE internal_notifications
            SET read_at = now()
            WHERE user_id = ${uid} AND read_at IS NULL
          `;
        }

        const rows = await s`
          SELECT COUNT(*)::int AS count
          FROM internal_notifications
          WHERE user_id = ${uid} AND read_at IS NULL
        `;
        return Response.json({ count: rows[0]?.count ?? 0 });
      },
    },
  },
});
