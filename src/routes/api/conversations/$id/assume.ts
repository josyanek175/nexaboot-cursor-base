// POST /api/conversations/:id/assume — placeholder da Fase 1.
// O schema atual não possui assigned_to; este endpoint apenas confirma a ação
// para não quebrar a UI. Atribuição real entra numa fase posterior.
import { createFileRoute } from "@tanstack/react-router";
import { getSessionUserId } from "@/lib/session.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/conversations/$id/assume")({
  server: {
    handlers: {
      POST: async ({ params }) => {
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (!UUID_RE.test(params.id)) return Response.json({ error: "invalid_id" }, { status: 400 });
        return Response.json({ ok: true, note: "assume_noop_phase1" });
      },
    },
  },
});
