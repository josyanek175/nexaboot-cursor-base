import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureSchema } from "@/lib/pg.server";
import { getSessionUserId, clearSessionCookie } from "@/lib/session.server";

export const Route = createFileRoute("/api/auth/me")({
  server: {
    handlers: {
      GET: async () => {
        await ensureSchema();
        const uid = getSessionUserId();
        if (!uid) return Response.json({ user: null }, { status: 200 });
        const rows = await sql()`
          SELECT id, email, name, role, tenant_id, active
          FROM public.users
          WHERE id = ${uid}
          LIMIT 1
        `;
        const u = rows[0];
        if (!u || u.active === false) {
          clearSessionCookie();
          return Response.json({ user: null });
        }
        return Response.json({
          user: {
            id: u.id,
            email: u.email,
            name: u.name,
            role: u.role,
            tenant_id: u.tenant_id,
          },
        });
      },
      POST: async ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("action") === "logout") {
          clearSessionCookie();
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unknown_action" }, { status: 400 });
      },
    },
  },
});
