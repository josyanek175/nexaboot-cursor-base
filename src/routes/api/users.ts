import { createFileRoute } from "@tanstack/react-router";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { sql, ensureSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";
import { requireCompanyId } from "@/lib/company.server";

const ADMIN_ROLES = new Set(["ADMIN", "ADMIN_GERAL", "ADMIN_EMPRESA", "TI"]);

const CreateBody = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(255),
  password: z.string().min(6).max(200),
  role: z.string().trim().min(1).max(40).default("USER"),
  active: z.boolean().optional().default(true),
  // tenant_id é aceito por compatibilidade, mas o ISOLAMENTO é por company_id.
  tenant_id: z.string().trim().min(1).max(64).optional(),
  avatar_url: z.string().trim().max(500).optional().nullable(),
});

async function getActor() {
  const uid = getSessionUserId();
  if (!uid) return null;
  const rows = await sql()`
    SELECT id, email, name, role, tenant_id, company_id, active
    FROM public.users WHERE id = ${uid}
  `;
  return rows[0] ?? null;
}

export const Route = createFileRoute("/api/users")({
  server: {
    handlers: {
      GET: async () => {
        await ensureSchema();
        // Isolamento oficial por company_id: sem empresa válida => 403.
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;
        const actor = await getActor();
        if (!actor) return Response.json({ error: "unauthenticated" }, { status: 401 });
        if (!ADMIN_ROLES.has(String(actor.role))) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        const rows = await sql()`
          SELECT id, tenant_id, company_id, name, email, role, active, avatar_url,
                 last_login_at, created_at, updated_at
          FROM public.users
          WHERE company_id = ${companyId}::uuid
          ORDER BY created_at DESC
        `;
        return Response.json({ users: rows });
      },

      POST: async ({ request }) => {
        await ensureSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;
        const actor = await getActor();
        if (!actor) return Response.json({ error: "unauthenticated" }, { status: 401 });
        if (!ADMIN_ROLES.has(String(actor.role))) {
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

        const email = parsed.data.email.toLowerCase();
        // Empresa do novo usuário é SEMPRE a do administrador logado.
        // Nunca cria usuário operacional sem empresa, nunca em outra empresa.
        const tenantId = String(actor.tenant_id ?? "default");

        try {
          const exists = await sql()`
            SELECT id FROM public.users
            WHERE company_id = ${companyId}::uuid AND lower(email) = ${email}
          `;
          if (exists.length) {
            return Response.json({ error: "email_already_exists" }, { status: 409 });
          }

          const hash = await bcrypt.hash(parsed.data.password, 10);
          const rows = await sql()`
            INSERT INTO public.users
              (tenant_id, company_id, name, email, password_hash, role, active, avatar_url)
            VALUES (
              ${tenantId}, ${companyId}::uuid, ${parsed.data.name}, ${email}, ${hash},
              ${parsed.data.role}, ${parsed.data.active ?? true},
              ${parsed.data.avatar_url ?? null}
            )
            RETURNING id, tenant_id, company_id, name, email, role, active, avatar_url,
                      last_login_at, created_at, updated_at
          `;
          return Response.json({ user: rows[0] }, { status: 201 });
        } catch (e) {
          const err = e as { code?: string; message?: string; detail?: string };
          console.error("[USERS_CREATE_FAIL]", err);
          if (err.code === "23505") {
            return Response.json({ error: "email_already_exists" }, { status: 409 });
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
