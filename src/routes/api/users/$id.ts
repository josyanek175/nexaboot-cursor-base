import { createFileRoute } from "@tanstack/react-router";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { sql, ensureSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";
import { requireCompanyId } from "@/lib/company.server";

const ADMIN_ROLES = new Set(["ADMIN", "ADMIN_GERAL", "ADMIN_EMPRESA", "TI"]);

const UpdateBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().email().max(255).optional(),
  role: z.string().trim().min(1).max(40).optional(),
  active: z.boolean().optional(),
  password: z.string().min(6).max(200).optional().nullable(),
  avatar_url: z.string().trim().max(500).optional().nullable(),
});

async function getActor() {
  const uid = getSessionUserId();
  if (!uid) return null;
  const rows = await sql()`
    SELECT id, email, name, role, tenant_id, company_id
    FROM public.users WHERE id = ${uid}
  `;
  return rows[0] ?? null;
}

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export const Route = createFileRoute("/api/users/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        await ensureSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;
        const actor = await getActor();
        if (!actor) return Response.json({ error: "unauthenticated" }, { status: 401 });
        if (!ADMIN_ROLES.has(String(actor.role))) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        if (!isUuid(params.id)) return Response.json({ error: "invalid_id" }, { status: 400 });
        const rows = await sql()`
          SELECT id, tenant_id, company_id, name, email, role, active, avatar_url,
                 last_login_at, created_at, updated_at
          FROM public.users
          WHERE id = ${params.id} AND company_id = ${companyId}::uuid
        `;
        if (!rows[0]) return Response.json({ error: "not_found" }, { status: 404 });
        return Response.json({ user: rows[0] });
      },

      PUT: async ({ request, params }) => {
        await ensureSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;
        const actor = await getActor();
        if (!actor) return Response.json({ error: "unauthenticated" }, { status: 401 });
        if (!ADMIN_ROLES.has(String(actor.role))) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        if (!isUuid(params.id)) return Response.json({ error: "invalid_id" }, { status: 400 });

        const json = await request.json().catch(() => null);
        const parsed = UpdateBody.safeParse(json);
        if (!parsed.success) {
          return Response.json(
            { error: "invalid_input", detail: parsed.error.flatten() },
            { status: 400 },
          );
        }

        const target = await sql()`
          SELECT id FROM public.users
          WHERE id = ${params.id} AND company_id = ${companyId}::uuid
        `;
        if (!target[0]) return Response.json({ error: "not_found" }, { status: 404 });

        const d = parsed.data;
        const passwordHash =
          d.password && d.password.length > 0 ? await bcrypt.hash(d.password, 10) : null;
        const email = d.email ? d.email.toLowerCase() : null;

        try {
          const rows = await sql()`
            UPDATE public.users SET
              name          = COALESCE(${d.name ?? null}, name),
              email         = COALESCE(${email}, email),
              role          = COALESCE(${d.role ?? null}, role),
              active        = COALESCE(${d.active ?? null}, active),
              avatar_url    = COALESCE(${d.avatar_url ?? null}, avatar_url),
              password_hash = COALESCE(${passwordHash}, password_hash),
              updated_at    = now()
            WHERE id = ${params.id} AND company_id = ${companyId}::uuid
            RETURNING id, tenant_id, company_id, name, email, role, active, avatar_url,
                      last_login_at, created_at, updated_at
          `;
          return Response.json({ user: rows[0] });
        } catch (e) {
          const err = e as { code?: string; message?: string; detail?: string };
          console.error("[USERS_UPDATE_FAIL]", err);
          if (err.code === "23505") {
            return Response.json({ error: "email_already_exists" }, { status: 409 });
          }
          return Response.json(
            { error: "update_failed", detail: err.detail ?? err.message },
            { status: 500 },
          );
        }
      },

      DELETE: async ({ params }) => {
        await ensureSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;
        const actor = await getActor();
        if (!actor) return Response.json({ error: "unauthenticated" }, { status: 401 });
        if (!ADMIN_ROLES.has(String(actor.role))) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        if (!isUuid(params.id)) return Response.json({ error: "invalid_id" }, { status: 400 });
        if (params.id === String(actor.id)) {
          return Response.json({ error: "cannot_delete_self" }, { status: 400 });
        }
        const rows = await sql()`
          UPDATE public.users SET active = false, updated_at = now()
          WHERE id = ${params.id} AND company_id = ${companyId}::uuid
          RETURNING id, active
        `;
        if (!rows[0]) return Response.json({ error: "not_found" }, { status: 404 });
        return Response.json({ ok: true, user: rows[0] });
      },
    },
  },
});
