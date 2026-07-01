import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";
import { ensureUserCompanySchema } from "@/lib/company.server";
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
  active: z.boolean().optional().default(true),
  plan_id: z.string().uuid(),
  admin: z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(255),
    password: z.string().min(6).max(200),
  }),
});

export const Route = createFileRoute("/api/companies")({
  server: {
    handlers: {
      GET: async () => {
        await ensureCrmSchema();
        const actor = await getActor();
        if (!actor) return Response.json({ error: "unauthenticated" }, { status: 401 });

        const role = String(actor.role ?? "");

        if (isPlatformRole(role)) {
          const rows = await listCompaniesWithPlanUsage({});
          return Response.json({ companies: rows });
        }

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
        await ensureUserCompanySchema();
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

        const { name, active, plan_id, admin } = parsed.data;
        const email = admin.email.toLowerCase();

        const plan = await sql<{ id: string }[]>`
          SELECT id FROM public.plans WHERE id = ${plan_id}::uuid AND active = true LIMIT 1
        `;
        if (!plan[0]) {
          return Response.json({ error: "plan_not_found" }, { status: 400 });
        }

        const emailTaken = await sql`
          SELECT id FROM public.users WHERE lower(email) = ${email} LIMIT 1
        `;
        if (emailTaken[0]) {
          return Response.json({ error: "email_already_exists" }, { status: 409 });
        }

        const tenantId = String(actor.tenant_id ?? "default");
        const hash = await bcrypt.hash(admin.password, 10);

        try {
          const result = await sql.begin(async (tx) => {
            const companies = await tx<{ id: string; name: string; active: boolean; created_at: string; updated_at: string }[]>`
              INSERT INTO public.companies (name, active)
              VALUES (${name}, ${active ?? true})
              RETURNING id, name, active, created_at, updated_at
            `;
            const company = companies[0];

            await tx`
              INSERT INTO public.company_subscriptions (company_id, plan_id, status)
              VALUES (${company.id}::uuid, ${plan_id}::uuid, 'active')
            `;

            const users = await tx<{ id: string }[]>`
              INSERT INTO public.users
                (email, password_hash, name, role, tenant_id, company_id, active)
              VALUES (
                ${email}, ${hash}, ${admin.name}, 'ADMIN_EMPRESA',
                ${tenantId}, ${company.id}::uuid, true
              )
              RETURNING id
            `;

            return { company, admin_user_id: users[0]?.id };
          });

          return Response.json(
            {
              company: result.company,
              admin_user_id: result.admin_user_id,
              plan_id,
            },
            { status: 201 },
          );
        } catch (e) {
          const err = e as { code?: string; message?: string; detail?: string };
          console.error("[COMPANIES_CREATE_FAIL]", err);
          return Response.json(
            { error: "create_failed", detail: err.detail ?? err.message },
            { status: 500 },
          );
        }
      },
    },
  },
});
