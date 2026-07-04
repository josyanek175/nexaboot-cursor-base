// GET /api/conversations — lista conversas reais do banco principal.
// Retorna campos consumidos pela tela de Atendimento (contato, telefone,
// última mensagem, horário, unread, canal/instância, responsável).
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureCrmSchema, ensureAttendanceSchema } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";
import { getSessionUserId } from "@/lib/session.server";
import { getCurrentUserCompanyInfo } from "@/lib/company.server";

export const Route = createFileRoute("/api/conversations")({
  server: {
    handlers: {
      GET: async () => {
        await ensureCrmSchema();
        await ensureAttendanceSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        let uid = getSessionUserId();
        if (!uid) {
          const info = await getCurrentUserCompanyInfo();
          uid = info.userId;
        }
        // UUID sentinela quando sem sessão (is_mine sempre false).
        const currentUserId = uid ?? "00000000-0000-0000-0000-000000000000";

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
            ch.evolution_instance_name,
            a.user_id AS assigned_user_id,
            au.name   AS assigned_user_name,
            au.email  AS assigned_user_email,
            a.assigned_at,
            CASE
              WHEN a.user_id IS NOT NULL AND a.user_id = ${currentUserId}::uuid THEN true
              ELSE false
            END AS is_mine,
            c.campaign_reply_campaign_id,
            c.campaign_reply_campaign_name,
            c.campaign_reply_text,
            c.campaign_reply_intent,
            c.campaign_reply_at
          FROM public.conversations c
          JOIN public.contacts ct ON ct.id = c.contact_id
          JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
          LEFT JOIN public.conversation_assignments a
            ON a.conversation_id = c.id
            AND a.active = true
            AND a.unassigned_at IS NULL
          LEFT JOIN public.users au ON au.id = a.user_id
          WHERE c.company_id = ${companyId}::uuid
            AND c.status IS DISTINCT FROM 'merged'
            AND c.status IS DISTINCT FROM 'archived'
            AND ct.status IS DISTINCT FROM 'merged'
          ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
          LIMIT 500
        `;
        return Response.json({ conversations });
      },
    },
  },
});
