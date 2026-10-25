import { createFileRoute } from "@tanstack/react-router";
import { sql, getSql } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";
import { getCompanyPlanUsage } from "@/lib/subscription.server";
import { isPlatformRole } from "@/lib/platform-roles";
import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getActor() {
  const uid = getSessionUserId();
  if (!uid) return null;
  const rows = await sql()`
    SELECT id, email, name, role, tenant_id, company_id, active
    FROM public.users
    WHERE id = ${uid}::uuid AND active = true
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export const Route = createFileRoute("/api/companies/$id/subscription")({
  server: {
    handlers: {
      PUT: async ({ request, params }) => {
        const actor = await getActor();
        if (!actor) return Response.json({ error: "unauthenticated" }, { status: 401 });
        if (!isPlatformRole(String(actor.role)))
          return Response.json({ error: "forbidden" }, { status: 403 });
        if (!UUID_RE.test(params.id)) return Response.json({ error: "invalid_id" }, { status: 400 });
        const parsed = z.object({ plan_id: z.string().uuid() }).safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
        const result = await getSql().begin(async (tx) => {
          const companies = await tx`SELECT id FROM public.companies WHERE id=${params.id}::uuid FOR UPDATE`;
          if (!companies[0]) return Response.json({ error: "not_found" }, { status: 404 });
          const plans = await tx`SELECT id FROM public.plans WHERE id=${parsed.data.plan_id}::uuid AND active=true`;
          if (!plans[0]) return Response.json({ error: "plan_not_found" }, { status: 400 });
          await tx`UPDATE public.company_subscriptions SET status='canceled',canceled_at=now(),updated_at=now()
            WHERE company_id=${params.id}::uuid AND status='active'`;
          await tx`INSERT INTO public.company_subscriptions (company_id,plan_id,status)
            VALUES (${params.id}::uuid,${parsed.data.plan_id}::uuid,'active')`;
          return Response.json({ ok: true });
        });
        return result;
      },
      GET: async ({ params }) => {
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
