// DELETE /api/evolution/channels/:id — soft delete do canal (active=false,
// deleted_at=now). Preserva o histórico de conversas/mensagens. Faz logout
// best-effort na Evolution.
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";
import { hasEvoConfig, logoutInstanceEvo } from "@/lib/evolution.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/evolution/channels/$id")({
  server: {
    handlers: {
      DELETE: async ({ params }) => {
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
        if (instance && hasEvoConfig()) {
          await logoutInstanceEvo(instance).catch(() => undefined);
        }
        await s`
          UPDATE public.whatsapp_channels
          SET active = false, deleted_at = now(), status = 'disconnected', updated_at = now()
          WHERE id = ${params.id}::uuid
        `;
        console.log("[EVOLUTION_CHANNEL_SOFT_DELETED]", { id: params.id, instance });
        return Response.json({ ok: true });
      },
    },
  },
});
