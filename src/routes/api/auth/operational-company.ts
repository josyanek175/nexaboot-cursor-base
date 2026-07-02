import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";
import { isPlatformRole } from "@/lib/platform-roles";
import {
  buildOperationalCompanySetCookie,
  buildOperationalCompanyClearCookie,
} from "@/lib/operational-company.server";
import { getCurrentUserCompanyInfo } from "@/lib/company.server";

async function getActorRole(uid: string): Promise<string | null> {
  const rows = await sql<{ role: string }[]>`
    SELECT role FROM public.users WHERE id = ${uid}::uuid AND active = true LIMIT 1
  `;
  return rows[0]?.role ?? null;
}

export const Route = createFileRoute("/api/auth/operational-company")({
  server: {
    handlers: {
      /** Lista empresas reais ativas (plataforma) + empresa operacional atual. */
      GET: async () => {
        await ensureCrmSchema();
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthenticated" }, { status: 401 });

        const role = await getActorRole(uid);
        if (!role || !isPlatformRole(role)) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }

        const companies = await sql<{ id: string; name: string; active: boolean }[]>`
          SELECT id, name, active
          FROM public.companies
          WHERE active = true
          ORDER BY name ASC
        `;

        const current = await getCurrentUserCompanyInfo();
        return Response.json({
          companies,
          operational_company_id: current.companyId,
          operational_company_name: current.companyName,
        });
      },

      POST: async ({ request }) => {
        await ensureCrmSchema();
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthenticated" }, { status: 401 });

        const role = await getActorRole(uid);
        if (!role || !isPlatformRole(role)) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }

        const json = await request.json().catch(() => null);
        const parsed = z.object({ company_id: z.string().uuid() }).safeParse(json);
        if (!parsed.success) {
          return Response.json({ error: "invalid_input" }, { status: 400 });
        }

        const company = await sql<{ id: string; name: string }[]>`
          SELECT id, name FROM public.companies
          WHERE id = ${parsed.data.company_id}::uuid AND active = true
          LIMIT 1
        `;
        if (!company[0]) {
          return Response.json({ error: "company_not_found" }, { status: 404 });
        }

        const setCookie = buildOperationalCompanySetCookie(uid, company[0].id);
        return Response.json(
          {
            company_id: company[0].id,
            company_name: company[0].name,
            company_valid: true,
          },
          { headers: { "Set-Cookie": setCookie } },
        );
      },

      DELETE: async () => {
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthenticated" }, { status: 401 });

        const role = await getActorRole(uid);
        if (!role || !isPlatformRole(role)) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }

        return Response.json(
          { ok: true },
          { headers: { "Set-Cookie": buildOperationalCompanyClearCookie() } },
        );
      },
    },
  },
});
