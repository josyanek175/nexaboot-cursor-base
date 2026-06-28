// POST /api/conversations/:id/read — zera o contador de não lidas da conversa.
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { getCurrentUserCompanyId } from "@/lib/company.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/conversations/$id/read")({
  server: {
    handlers: {
      POST: async ({ params }) => {
        await ensureCrmSchema();
        const companyId = await getCurrentUserCompanyId();
        if (!companyId) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (!UUID_RE.test(params.id)) return Response.json({ error: "invalid_id" }, { status: 400 });

        const s = sql();
        const updated = await s`
          UPDATE public.conversations
          SET unread_count = 0, updated_at = now()
          WHERE id = ${params.id}::uuid AND company_id = ${companyId}::uuid
          RETURNING id
        `;
        if (!updated[0]) return Response.json({ error: "not_found" }, { status: 404 });
        return Response.json({ ok: true });
      },
    },
  },
});
