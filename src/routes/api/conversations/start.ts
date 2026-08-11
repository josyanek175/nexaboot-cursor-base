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
import { sql } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";

const Body = z.object({
  contactId: z.string().uuid(),
  channelId: z.string().uuid(),
});

type ConversationStartRow = {
  id: string;
  contact_id: string;
  whatsapp_channel_id: string;
  status: string;
  last_message_at: string | null;
  unread_count: number | null;
};

function startSuccessPayload(row: ConversationStartRow, created: boolean) {
  return {
    ok: true as const,
    created,
    conversationId: row.id,
    contactId: row.contact_id,
    channelId: row.whatsapp_channel_id,
    status: row.status,
    lastMessageAt: row.last_message_at,
    unreadCount: row.unread_count ?? 0,
  };
}

export const Route = createFileRoute("/api/conversations/start")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

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
        // Política de status/ORDER BY inalterada — só amplia colunas retornadas.
        const existing = await s<ConversationStartRow[]>`
          SELECT id, contact_id, whatsapp_channel_id, status, last_message_at, unread_count
          FROM public.conversations
          WHERE company_id = ${companyId}::uuid
            AND contact_id = ${contactId}::uuid
            AND whatsapp_channel_id = ${channelId}::uuid
            AND status IS DISTINCT FROM 'merged'
            AND status IS DISTINCT FROM 'archived'
          ORDER BY (status = 'open') DESC, last_message_at DESC NULLS LAST, created_at DESC
          LIMIT 1
        `;
        if (existing[0]) {
          return Response.json(startSuccessPayload(existing[0], false));
        }

        // Cria conversa vazia (sem mensagem fake, sem enviar WhatsApp).
        const inserted = await s<ConversationStartRow[]>`
          INSERT INTO public.conversations
            (company_id, contact_id, whatsapp_channel_id, status, unread_count, last_message_at)
          VALUES
            (${companyId}::uuid, ${contactId}::uuid, ${channelId}::uuid, 'open', 0, now())
          RETURNING id, contact_id, whatsapp_channel_id, status, last_message_at, unread_count
        `;
        console.log("[CONVERSATION_STARTED]", {
          conversationId: inserted[0].id,
          contactId: inserted[0].contact_id,
          channelId: inserted[0].whatsapp_channel_id,
        });
        return Response.json(startSuccessPayload(inserted[0], true));
      },
    },
  },
});
