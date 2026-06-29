// Total de mensagens internas NÃO lidas do usuário logado (cookie de sessão).
// Fonte: internal_notifications (read_at IS NULL), restrito aos chats da MESMA
// empresa do usuário (isolamento oficial por company_id). O usuário só possui
// notificações de chats dos quais é membro — isso reforça o isolamento.
//
// Este endpoint é consultado em polling global pelo app-shell; por isso, quando
// o usuário não tem empresa válida (ex.: SUPER_ADMIN/TI sem empresa), retorna
// count=0 em vez de erro, para não poluir o badge.
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";
import { getCurrentUserCompanyInfo } from "@/lib/company.server";

export const Route = createFileRoute("/api/internal-chat/unread-count")({
  server: {
    handlers: {
      GET: async () => {
        await ensureSchema();
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });

        const info = await getCurrentUserCompanyInfo();
        if (!info.companyValid || !info.companyId) {
          return Response.json({ count: 0 });
        }

        const s = sql();
        const rows = await s`
          SELECT COUNT(*)::int AS count
          FROM internal_notifications n
          JOIN internal_chats c ON c.id = n.chat_id
          WHERE n.user_id = ${uid}
            AND n.read_at IS NULL
            AND c.company_id = ${info.companyId}::uuid
        `;
        return Response.json({ count: rows[0]?.count ?? 0 });
      },
    },
  },
});
