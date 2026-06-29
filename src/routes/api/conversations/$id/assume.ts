// POST /api/conversations/:id/assume — placeholder da Fase 1.
// O schema atual não possui assigned_to; este endpoint apenas confirma a ação
// para não quebrar a UI. Atribuição real entra numa fase posterior.
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/conversations/$id/assume")({
  server: {
    handlers: {
      POST: async ({ params }) => {
        await ensureCrmSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;
        if (!UUID_RE.test(params.id)) return Response.json({ error: "invalid_id" }, { status: 400 });

        const s = sql();
        const owns = await s`
          SELECT 1 FROM public.conversations
          WHERE id = ${params.id}::uuid AND company_id = ${companyId}::uuid
          LIMIT 1
        `;
        if (!owns[0]) return Response.json({ error: "not_found" }, { status: 404 });

        // Atribuição real (assigned_to) entra numa fase posterior.
        return Response.json({ ok: true, note: "assume_noop_phase1" });
      },
    },
  },
});
