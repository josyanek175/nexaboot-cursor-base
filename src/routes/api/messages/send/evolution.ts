// POST /api/messages/send/evolution — envia texto pela Evolution e salva no banco.
// Body: { conversationId: uuid, text: string }
// Resolve a instância/telefone pela própria conversa; trata 401/403 da API.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";
import { getSessionUserId } from "@/lib/session.server";

const Body = z.object({
  conversationId: z.string().uuid(),
  text: z.string().min(1).max(4000),
});

export const Route = createFileRoute("/api/messages/send/evolution")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await ensureCrmSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        const json = await request.json().catch(() => null);
        const parsed = Body.safeParse(json);
        if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
        const { conversationId, text } = parsed.data;

        const s = sql();

        // Autoria: usuário logado, restrito à mesma empresa (nunca outra).
        const uid = getSessionUserId();
        const attendantRows = uid
          ? await s<{ id: string; name: string | null }[]>`
              SELECT id, name FROM public.users
              WHERE id = ${uid}::uuid AND company_id = ${companyId}::uuid
              LIMIT 1
            `
          : [];
        const attendant = attendantRows[0] ?? null;
        const rows = await s<{
          id: string;
          company_id: string;
          whatsapp_channel_id: string;
          phone: string | null;
          external_jid: string | null;
          evolution_instance_name: string | null;
        }[]>`
          SELECT c.id, c.company_id, c.whatsapp_channel_id,
                 ct.phone, ct.external_jid,
                 ch.evolution_instance_name
          FROM public.conversations c
          JOIN public.contacts ct ON ct.id = c.contact_id
          JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
          WHERE c.id = ${conversationId}::uuid
            AND c.company_id = ${companyId}::uuid
          LIMIT 1
        `;
        const conv = rows[0];
        if (!conv) return Response.json({ error: "conversation_not_found" }, { status: 404 });

        const apiUrl = process.env.EVOLUTION_API_URL;
        const apiKey = process.env.EVOLUTION_API_KEY;
        const instance = conv.evolution_instance_name || process.env.EVOLUTION_INSTANCE_NAME;
        if (!apiUrl || !apiKey || !instance) {
          return Response.json({ error: "missing_evolution_config" }, { status: 500 });
        }
        const number = String(conv.phone || conv.external_jid || "").replace(/\D/g, "");
        if (!number) return Response.json({ error: "missing_number" }, { status: 400 });

        console.log("[EVOLUTION_SEND]", { conversationId, instance, number });

        let providerId: string | null = null;
        try {
          const res = await fetch(
            `${apiUrl.replace(/\/+$/, "")}/message/sendText/${encodeURIComponent(instance)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", apikey: apiKey },
              body: JSON.stringify({ number, text }),
            },
          );
          const body = await res.text().catch(() => "");
          if (!res.ok) {
            console.error("[EVOLUTION_ERROR]", { status: res.status, body: body.slice(0, 500) });
            const code =
              res.status === 401 || res.status === 403
                ? "unauthorized_check_api_key"
                : "evolution_http_error";
            return Response.json({ error: code, status: res.status, body: body.slice(0, 500) }, { status: 502 });
          }
          try { providerId = JSON.parse(body)?.key?.id ?? null; } catch { /* ignore */ }
        } catch (e) {
          console.error("[EVOLUTION_ERROR]", e);
          return Response.json(
            { error: "evolution_unreachable", message: e instanceof Error ? e.message : String(e) },
            { status: 502 },
          );
        }

        const inserted = await s`
          INSERT INTO public.messages
            (conversation_id, external_id, external_message_id, direction,
             message_type, message_text, from_me, status,
             sent_by_user_id, sent_by_name)
          VALUES
            (${conversationId}::uuid, ${providerId}, ${providerId}, 'out',
             'text', ${text}, true, 'sent',
             ${attendant?.id ?? null}, ${attendant?.name ?? null})
          RETURNING id, conversation_id, direction, message_type,
                    message_text AS body, from_me, status, created_at,
                    sent_by_user_id, sent_by_name
        `;
        await s`
          UPDATE public.conversations
          SET last_message = ${text}, last_message_at = now(), updated_at = now()
          WHERE id = ${conversationId}::uuid
        `;
        console.log("[EVOLUTION_MESSAGE_SAVED]", { conversationId, out: true, messageId: inserted[0]?.id });
        return Response.json({ ok: true, message: inserted[0] });
      },
    },
  },
});
