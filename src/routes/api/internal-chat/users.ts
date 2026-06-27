import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";

export const Route = createFileRoute("/api/internal-chat/users")({
  server: {
    handlers: {
      GET: async () => {
        await ensureSchema();
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
        const s = sql();
        const me = await s`SELECT tenant_id FROM users WHERE id = ${uid}`;
        if (!me.length) return Response.json({ error: "unauthorized" }, { status: 401 });
        const tenantId = me[0].tenant_id;
        const users = tenantId
          ? await s`SELECT id, name, email, role FROM users WHERE tenant_id = ${tenantId} ORDER BY name`
          : await s`SELECT id, name, email, role FROM users WHERE tenant_id IS NULL ORDER BY name`;
        return Response.json({ users });
      },
    },
  },
});
