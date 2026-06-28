// GET /api/evolution/channels/:id/status — consulta status na Evolution e
// atualiza o banco. Mapeia o estado da Evolution para o status do NexaBoot.
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";
import { hasEvoConfig, instanceState, mapEvoStatus } from "@/lib/evolution.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/evolution/channels/$id/status")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        await ensureCrmSchema();
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (!UUID_RE.test(params.id)) return Response.json({ error: "invalid_id" }, { status: 400 });

        const s = sql();
        const rows = await s<{ evolution_instance_name: string | null }[]>`
          SELECT evolution_instance_name FROM public.whatsapp_channels WHERE id = ${params.id}::uuid
        `;
        if (!rows[0]) return Response.json({ error: "not_found" }, { status: 404 });
        const instance = rows[0].evolution_instance_name;
        if (!instance) return Response.json({ error: "missing_instance" }, { status: 400 });
        if (!hasEvoConfig()) return Response.json({ error: "missing_evolution_config", status: "disconnected" });

        const st = await instanceState(instance);
        const mapped = st.ok ? mapEvoStatus(st.data?.instance?.state ?? st.data?.state) : "error";
        console.log("[EVOLUTION_STATUS]", { instance, mapped, ok: st.ok });

        await s`
          UPDATE public.whatsapp_channels
          SET status = ${mapped},
              last_connected_at = CASE WHEN ${mapped} = 'connected' THEN now() ELSE last_connected_at END,
              updated_at = now()
          WHERE id = ${params.id}::uuid
        `;
        return Response.json({ ok: st.ok, status: mapped });
      },
    },
  },
});
