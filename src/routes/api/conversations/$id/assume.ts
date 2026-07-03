// POST /api/conversations/:id/assume — atribui a conversa ao usuário logado.
import { createFileRoute } from "@tanstack/react-router";
import { assumeConversation } from "@/lib/attendance.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/conversations/$id/assume")({
  server: {
    handlers: {
      POST: async ({ params }) => {
        if (!UUID_RE.test(params.id)) {
          return Response.json({ error: "invalid_id" }, { status: 400 });
        }

        const result = await assumeConversation(params.id);
        if (result instanceof Response) return result;

        return Response.json({ ok: true, ...result });
      },
    },
  },
});
