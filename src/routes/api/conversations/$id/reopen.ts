// POST /api/conversations/:id/reopen — reabre atendimento (persiste no backend).
import { createFileRoute } from "@tanstack/react-router";
import { reopenConversation } from "@/lib/attendance.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/conversations/$id/reopen")({
  server: {
    handlers: {
      POST: async ({ params }) => {
        if (!UUID_RE.test(params.id)) {
          return Response.json({ error: "invalid_id" }, { status: 400 });
        }
        const result = await reopenConversation(params.id);
        if (result instanceof Response) return result;
        return Response.json(result);
      },
    },
  },
});
