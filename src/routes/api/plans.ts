import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";
import { isPlatformRole } from "@/lib/platform-roles";

export const Route = createFileRoute("/api/plans")({
  server: {
    handlers: {
      GET: async () => {
        await ensureCrmSchema();
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthenticated" }, { status: 401 });

        const actor = await sql<{ role: string }[]>`
          SELECT role FROM public.users WHERE id = ${uid}::uuid LIMIT 1
        `;
        if (!actor[0]) return Response.json({ error: "unauthenticated" }, { status: 401 });
        if (!isPlatformRole(String(actor[0].role))) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }

        const plans = await sql`
          SELECT id, code, name, max_whatsapp_channels, active
          FROM public.plans
          WHERE active = true
          ORDER BY max_whatsapp_channels ASC
        `;
        return Response.json({ plans });
      },
    },
  },
});
