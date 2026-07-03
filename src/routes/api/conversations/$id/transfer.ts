// POST /api/conversations/:id/transfer — transfere a conversa para outro atendente.
// Body: { userId: uuid } ou { to_user_id: uuid }
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { transferConversation } from "@/lib/attendance.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Body = z.object({
  userId: z.string().uuid().optional(),
  to_user_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
});

export const Route = createFileRoute("/api/conversations/$id/transfer")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        if (!UUID_RE.test(params.id)) {
          return Response.json({ error: "invalid_id" }, { status: 400 });
        }

        const json = await request.json().catch(() => null);
        const parsed = Body.safeParse(json);
        if (!parsed.success) {
          return Response.json({ error: "invalid_input" }, { status: 400 });
        }

        const toUserId = parsed.data.userId ?? parsed.data.to_user_id ?? parsed.data.user_id;
        if (!toUserId) {
          return Response.json({ error: "invalid_input", message: "userId obrigatório" }, { status: 400 });
        }

        const result = await transferConversation(params.id, toUserId);
        if (result instanceof Response) return result;

        return Response.json({ ok: true, ...result });
      },
    },
  },
});
