// GET /api/attendants — atendentes reais para a tela de Atendimento.
//
// Diferente de /api/users (gestão de usuários, admin-only): este endpoint é
// usado pela fila de Atendimento para popular filtro/atribuição/transferência,
// então NÃO exige perfil de admin — basta estar logado. Escopo restrito ao
// tenant do usuário logado (nunca expõe usuários de outra empresa/tenant) e
// nunca retorna senha/hash.
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";

export const Route = createFileRoute("/api/attendants")({
  server: {
    handlers: {
      GET: async () => {
        await ensureSchema();
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthenticated" }, { status: 401 });

        const s = sql();
        const me = await s<{ tenant_id: string | null }[]>`
          SELECT tenant_id FROM public.users WHERE id = ${uid} LIMIT 1
        `;
        if (!me[0]) return Response.json({ error: "unauthenticated" }, { status: 401 });

        const attendants = await s`
          SELECT id, name, email, role, active, avatar_url
          FROM public.users
          WHERE tenant_id = ${me[0].tenant_id}
            AND COALESCE(active, true) = true
          ORDER BY name ASC NULLS LAST, email ASC
        `;
        return Response.json({ attendants });
      },
    },
  },
});
