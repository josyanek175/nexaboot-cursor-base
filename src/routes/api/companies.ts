import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";
import { listCompaniesWithPlanUsage } from "@/lib/subscription.server";
import { isPlatformRole } from "@/lib/platform-roles";

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

const CreateBody = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(120).optional().nullable(),
  active: z.boolean().optional().default(true),
});

export const Route = createFileRoute("/api/companies")({
  server: {
    handlers: {
      GET: async () => {
        await ensureCrmSchema();
        const actor = await getActor();
        if (!actor) return Response.json({ error: "unauthenticated" }, { status: 401 });

        const role = String(actor.role ?? "");

        // Plataforma: todas as empresas (ignora company_id do usuário / sidebar).
        if (isPlatformRole(role)) {
          const rows = await listCompaniesWithPlanUsage({});
          return Response.json({ companies: rows });
        }

        // Operacional: somente a empresa vinculada ao usuário.
        if (!actor.company_id) {
          return Response.json(
            {
              error: "no_company",
              message: "Usuário sem empresa vinculada. Contate o administrador.",
            },
            { status: 403 },
          );
        }

        const companyId = String(actor.company_id);
        const exists = await sql<{ id: string }[]>`
          SELECT id FROM public.companies WHERE id = ${companyId}::uuid LIMIT 1
        `;
        if (!exists[0]) {
          return Response.json(
            {
              error: "company_not_found",
              message:
                "Sua conta está vinculada a uma empresa inexistente ou removida. Contate o administrador.",
              company_id: companyId,
            },
            { status: 403 },
          );
        }

        const rows = await listCompaniesWithPlanUsage({ companyId });
        return Response.json({ companies: rows });
      },

      POST: async ({ request }) => {
        await ensureCrmSchema();
        const actor = await getActor();
        if (!actor) return Response.json({ error: "unauthenticated" }, { status: 401 });
        if (!isPlatformRole(String(actor.role))) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }

        const json = await request.json().catch(() => null);
        const parsed = CreateBody.safeParse(json);
        if (!parsed.success) {
          return Response.json(
            { error: "invalid_input", detail: parsed.error.flatten() },
            { status: 400 },
          );
        }

        try {
          const rows = await sql()`
            INSERT INTO public.companies (name, slug, active)
            VALUES (
              ${parsed.data.name},
              ${parsed.data.slug ?? null},
              ${parsed.data.active ?? true}
            )
            RETURNING id, name, slug, active, created_at, updated_at
          `;
          return Response.json({ company: rows[0] }, { status: 201 });
        } catch (e) {
          const err = e as { code?: string; message?: string; detail?: string };
          console.error("[COMPANIES_CREATE_FAIL]", err);
          if (err.code === "23505") {
            return Response.json({ error: "slug_already_exists" }, { status: 409 });
          }
          return Response.json(
            { error: "create_failed", detail: err.detail ?? err.message },
            { status: 500 },
          );
        }
      },
    },
  },
});
