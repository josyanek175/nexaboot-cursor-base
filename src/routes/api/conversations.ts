// GET /api/conversations — lista conversas reais do banco principal.
// Retorna campos consumidos pela tela de Atendimento (contato, telefone,
// última mensagem, horário, unread, canal/instância).
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";

export const Route = createFileRoute("/api/conversations")({
  server: {
    handlers: {
      GET: async () => {
        await ensureCrmSchema();
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });

        const s = sql();
        const conversations = await s`
          SELECT
            c.id,
            c.status,
            c.unread_count,
            c.last_message,
            c.last_message_at,
            c.company_id,
            c.contact_id,
            c.whatsapp_channel_id,
            ct.name  AS contact_name,
            ct.phone AS phone,
            ct.external_jid,
            ct.contact_type,
            ch.name  AS channel_name,
            ch.channel_type,
            ch.evolution_instance_name
          FROM public.conversations c
          JOIN public.contacts ct ON ct.id = c.contact_id
          JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
          ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
          LIMIT 500
        `;
        return Response.json({ conversations });
      },
    },
  },
});
