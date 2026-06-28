// POST /api/conversations/:id/read — zera o contador de não lidas da conversa.
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/conversations/$id/read")({
  server: {
    handlers: {
      POST: async ({ params }) => {
        await ensureCrmSchema();
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (!UUID_RE.test(params.id)) return Response.json({ error: "invalid_id" }, { status: 400 });

        const s = sql();
        await s`
          UPDATE public.conversations
          SET unread_count = 0, updated_at = now()
          WHERE id = ${params.id}::uuid
        `;
        return Response.json({ ok: true });
      },
    },
  },
});
