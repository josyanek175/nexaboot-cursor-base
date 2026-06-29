// GET /api/attendants — atendentes reais para a tela de Atendimento.
//
// Diferente de /api/users (gestão de usuários, admin-only): este endpoint é
// usado pela fila de Atendimento para popular filtro/atribuição/transferência,
// então NÃO exige perfil de admin — basta estar logado COM empresa válida.
//
// Isolamento ESTRITO por company_id (decisão oficial): retorna apenas usuários
// ativos da MESMA empresa do usuário logado. Nunca expõe usuários de outra
// empresa e nunca retorna senha/hash. Sem empresa válida => 403.
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureSchema } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";

export const Route = createFileRoute("/api/attendants")({
  server: {
    handlers: {
      GET: async () => {
        await ensureSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        const s = sql();
        const attendants = await s`
          SELECT id, name, email, role, active, avatar_url
          FROM public.users
          WHERE company_id = ${companyId}::uuid
            AND COALESCE(active, true) = true
          ORDER BY name ASC NULLS LAST, email ASC
        `;
        return Response.json({ attendants });
      },
    },
  },
});
