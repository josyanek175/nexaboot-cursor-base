// Total de mensagens internas NÃO lidas do usuário logado (cookie de sessão).
// Fonte: internal_notifications (read_at IS NULL). Mensagens próprias nunca
// geram notificação para o próprio autor (ver send.ts), e o usuário só possui
// notificações de chats dos quais é membro — isso garante o isolamento.
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";

export const Route = createFileRoute("/api/internal-chat/unread-count")({
  server: {
    handlers: {
      GET: async () => {
        await ensureSchema();
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
        const s = sql();
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
