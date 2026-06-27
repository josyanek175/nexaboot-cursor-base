// Endpoint de DEBUG do usuário corrente — lê a sessão PostgreSQL real (cookie httpOnly).
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";

export const Route = createFileRoute("/api/debug/current-user")({
  server: {
    handlers: {
      GET: async () => {
        await ensureSchema();
        const auth_source = "postgres-cookie-session";
        const uid = getSessionUserId();
        if (!uid) {
          return Response.json({ auth_source, user: null, note: "Sem sessão ativa." });
        }
        const rows = await sql()`
          SELECT u.id, u.name, u.email, u.role, u.tenant_id, u.active,
                 t.name AS tenant_name
          FROM public.users u
          LEFT JOIN public.tenants t ON t.id = u.tenant_id
          WHERE u.id = ${uid}
          LIMIT 1
        `;
        if (!rows[0]) {
          return Response.json({ auth_source, user: null, error: "user_not_found" }, { status: 404 });
        }
        return Response.json({ auth_source, user: rows[0] });
      },
    },
  },
});
