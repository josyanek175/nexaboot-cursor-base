// GET /api/internal-chat/users — usuários disponíveis para conversar no chat
// interno. Isolamento oficial por company_id: lista apenas usuários da MESMA
// empresa do usuário logado. Sem empresa válida => 403 (inclui SUPER_ADMIN/TI
// sem empresa, pois o chat interno é operacional).
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureSchema } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";

export const Route = createFileRoute("/api/internal-chat/users")({
  server: {
    handlers: {
      GET: async () => {
        await ensureSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        const s = sql();
        const users = await s`
          SELECT id, name, email, role
          FROM public.users
          WHERE company_id = ${companyId}::uuid
            AND COALESCE(active, true) = true
          ORDER BY name
        `;
        return Response.json({ users });
      },
    },
  },
});
