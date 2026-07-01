import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";
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

const PatchBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  slug: z.string().trim().min(1).max(120).optional().nullable(),
  active: z.boolean().optional(),
});

export const Route = createFileRoute("/api/companies/$id")({
  server: {
    handlers: {
      PATCH: async ({ params, request }) => {
        await ensureCrmSchema();
        const actor = await getActor();
        if (!actor) return Response.json({ error: "unauthenticated" }, { status: 401 });

        const companyId = params.id;
        const role = String(actor.role ?? "");
        const platform = isPlatformRole(role);

        if (!platform) {
          if (role !== "ADMIN_EMPRESA" || String(actor.company_id) !== companyId) {
            return Response.json({ error: "forbidden" }, { status: 403 });
          }
        }

        const json = await request.json().catch(() => null);
        const parsed = PatchBody.safeParse(json);
        if (!parsed.success) {
          return Response.json(
            { error: "invalid_input", detail: parsed.error.flatten() },
            { status: 400 },
          );
        }

        if (!platform) {
          if (parsed.data.active !== undefined || parsed.data.slug !== undefined) {
            return Response.json({ error: "forbidden" }, { status: 403 });
          }
          if (!parsed.data.name) {
            return Response.json({ error: "invalid_input" }, { status: 400 });
          }
        }

        const existing = await sql<{
          id: string;
          name: string;
          slug: string | null;
          active: boolean;
        }[]>`
          SELECT id, name, slug, active
          FROM public.companies
          WHERE id = ${companyId}::uuid
          LIMIT 1
        `;
        if (!existing[0]) {
          return Response.json({ error: "not_found" }, { status: 404 });
        }

        const cur = existing[0];
        const nextName = parsed.data.name ?? cur.name;
        const nextSlug = parsed.data.slug !== undefined ? parsed.data.slug : cur.slug;
        const nextActive = parsed.data.active !== undefined ? parsed.data.active : cur.active;

        try {
          const rows = await sql()`
            UPDATE public.companies
            SET name = ${nextName},
                slug = ${nextSlug},
                active = ${nextActive},
                updated_at = now()
            WHERE id = ${companyId}::uuid
            RETURNING id, name, slug, active, created_at, updated_at
          `;
          return Response.json({ company: rows[0] });
        } catch (e) {
          const err = e as { code?: string; message?: string; detail?: string };
          console.error("[COMPANIES_PATCH_FAIL]", err);
          if (err.code === "23505") {
            return Response.json({ error: "slug_already_exists" }, { status: 409 });
          }
          return Response.json(
            { error: "update_failed", detail: err.detail ?? err.message },
            { status: 500 },
          );
        }
      },
    },
  },
});
