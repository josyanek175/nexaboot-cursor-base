// POST /api/messages/send — envia texto roteando Meta ou Evolution pelo canal da conversa.
// Body: { conversationId: uuid, text: string }
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireCompanyId } from "@/lib/company.server";
import { sendConversationText } from "@/lib/message-send-router.server";
import { ensureCrmSchema, sql } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";

const Body = z.object({
  conversationId: z.string().uuid(),
  text: z.string().min(1).max(4096),
});

export const Route = createFileRoute("/api/messages/send")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await ensureCrmSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        const json = await request.json().catch(() => null);
        const parsed = Body.safeParse(json);
        if (!parsed.success) {
          return Response.json({ error: "invalid_input" }, { status: 400 });
        }

        const { conversationId, text } = parsed.data;

        const uid = getSessionUserId();
        const s = sql();
        const attendantRows = uid
          ? await s<{ id: string; name: string | null }[]>`
              SELECT id, name FROM public.users
              WHERE id = ${uid}::uuid AND company_id = ${companyId}::uuid
              LIMIT 1
            `
          : [];
        const attendant = attendantRows[0] ?? null;

        const result = await sendConversationText({
          companyId,
          conversationId,
          text,
          sentByUserId: attendant?.id ?? null,
          sentByName: attendant?.name ?? null,
        });

        if (!result.ok) {
          return Response.json(
            {
              error: result.error,
              message: result.message ?? undefined,
              provider: result.provider ?? undefined,
            },
            { status: result.status },
          );
        }

        return Response.json({ ok: true, provider: result.provider, message: result.message });
      },
    },
  },
});
