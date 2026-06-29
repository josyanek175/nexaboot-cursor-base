// POST /api/evolution/channels/:id/disconnect — faz logout da instância na
// Evolution e marca o canal como desconectado. Não remove histórico.
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";
import { hasEvoConfig, logoutInstanceEvo } from "@/lib/evolution.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/evolution/channels/$id/disconnect")({
  server: {
    handlers: {
      POST: async ({ params }) => {
        await ensureCrmSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;
        if (!UUID_RE.test(params.id)) return Response.json({ error: "invalid_id" }, { status: 400 });

        const s = sql();
        const rows = await s<{ evolution_instance_name: string | null }[]>`
          SELECT evolution_instance_name FROM public.whatsapp_channels
          WHERE id = ${params.id}::uuid AND company_id = ${companyId}::uuid
        `;
        if (!rows[0]) return Response.json({ error: "not_found" }, { status: 404 });
        const instance = rows[0].evolution_instance_name;

        let evolutionOk = false;
        if (instance && hasEvoConfig()) {
          const r = await logoutInstanceEvo(instance);
          evolutionOk = r.ok;
        }
        await s`UPDATE public.whatsapp_channels SET status = 'disconnected', updated_at = now() WHERE id = ${params.id}::uuid`;
        return Response.json({ ok: true, evolutionOk });
      },
    },
  },
});
