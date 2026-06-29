// POST /api/conversations/start — abre/prepara uma conversa real para um
// contato existente em um canal real, SEM enviar mensagem nem criar dados fake.
// Body: { contactId: uuid, channelId: uuid }
//
// Regras: exige usuário logado; contato e canal precisam pertencer à empresa
// do usuário; se já existir conversa para (contact_id, channel_id) retorna a
// existente; caso contrário cria uma conversa vazia ('open'). O envio da
// primeira mensagem continua sendo feito por POST /api/messages/send/evolution.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { getCurrentUserCompanyId } from "@/lib/company.server";

const Body = z.object({
  contactId: z.string().uuid(),
  channelId: z.string().uuid(),
});

export const Route = createFileRoute("/api/conversations/start")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await ensureCrmSchema();
        const companyId = await getCurrentUserCompanyId();
        if (!companyId) return Response.json({ error: "unauthorized" }, { status: 401 });

        const json = await request.json().catch(() => null);
        const parsed = Body.safeParse(json);
        if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
        const { contactId, channelId } = parsed.data;

        const s = sql();

        // Contato precisa pertencer à empresa do usuário.
        const contact = await s`
          SELECT id FROM public.contacts
          WHERE id = ${contactId}::uuid AND company_id = ${companyId}::uuid
          LIMIT 1
        `;
        if (!contact[0]) return Response.json({ error: "contact_not_found" }, { status: 404 });

        // Canal precisa pertencer à mesma empresa (e não estar removido).
        const channel = await s`
          SELECT id FROM public.whatsapp_channels
          WHERE id = ${channelId}::uuid AND company_id = ${companyId}::uuid
            AND deleted_at IS NULL
          LIMIT 1
        `;
        if (!channel[0]) return Response.json({ error: "channel_not_found" }, { status: 404 });

        // Já existe conversa para este contato + canal? Reaproveita.
        const existing = await s<{ id: string }[]>`
          SELECT id FROM public.conversations
          WHERE company_id = ${companyId}::uuid
            AND contact_id = ${contactId}::uuid
            AND whatsapp_channel_id = ${channelId}::uuid
            AND status IS DISTINCT FROM 'merged'
            AND status IS DISTINCT FROM 'archived'
          ORDER BY (status = 'open') DESC, last_message_at DESC NULLS LAST, created_at DESC
          LIMIT 1
        `;
        if (existing[0]) {
          return Response.json({ ok: true, created: false, conversationId: existing[0].id });
        }

        // Cria conversa vazia (sem mensagem fake, sem enviar WhatsApp).
        const inserted = await s<{ id: string }[]>`
          INSERT INTO public.conversations
            (company_id, contact_id, whatsapp_channel_id, status, unread_count, last_message_at)
          VALUES
            (${companyId}::uuid, ${contactId}::uuid, ${channelId}::uuid, 'open', 0, now())
          RETURNING id
        `;
        console.log("[CONVERSATION_STARTED]", { conversationId: inserted[0].id, contactId, channelId });
        return Response.json({ ok: true, created: true, conversationId: inserted[0].id });
      },
    },
  },
});
