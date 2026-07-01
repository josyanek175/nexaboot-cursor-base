import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";
import { getCompanyPlanUsage } from "@/lib/subscription.server";
import { isPlatformRole } from "@/lib/platform-roles";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getActor() {
  const uid = getSessionUserId();
  if (!uid) return null;
  const rows = await sql()`
    SELECT id, email, name, role, tenant_id, company_id, active
    FROM public.users
    WHERE id = ${uid}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export const Route = createFileRoute("/api/companies/$id/subscription")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        await ensureCrmSchema();
        if (!UUID_RE.test(params.id)) {
          return Response.json({ error: "invalid_id" }, { status: 400 });
        }

        const actor = await getActor();
        if (!actor) return Response.json({ error: "unauthenticated" }, { status: 401 });

        const role = String(actor.role ?? "");
        const platform = isPlatformRole(role);
        const companyId = params.id;

        if (!platform) {
          if (!actor.company_id || String(actor.company_id) !== companyId) {
            return Response.json({ error: "forbidden" }, { status: 403 });
          }
        }

        const exists = await sql`
          SELECT id FROM public.companies WHERE id = ${companyId}::uuid LIMIT 1
        `;
        if (!exists[0]) {
          return Response.json({ error: "not_found" }, { status: 404 });
        }

        const data = await getCompanyPlanUsage(companyId);
        return Response.json(data);
      },
    },
  },
});
