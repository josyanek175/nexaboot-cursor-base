// POST /api/meta/messages/send-text — envio manual de texto via Meta Cloud API.
// Body: { conversationId | conversation_id: uuid, text: string }
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireCompanyId } from "@/lib/company.server";
import { sendMetaManualText } from "@/lib/meta-send-message.server";
import { ensureCrmSchema, sql } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";

const Body = z
  .object({
    conversationId: z.string().uuid().optional(),
    conversation_id: z.string().uuid().optional(),
    text: z.string().min(1).max(4096),
  })
  .refine((data) => !!data.conversationId || !!data.conversation_id, {
    message: "missing_conversation_id",
  });

export const Route = createFileRoute("/api/meta/messages/send-text")({
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

        const conversationId = parsed.data.conversationId ?? parsed.data.conversation_id!;
        const { text } = parsed.data;

        console.log("[SEND_MESSAGE_REQUEST_RECEIVED]", { conversationId, companyId, route: "meta/send-text" });

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

        const result = await sendMetaManualText({
          companyId,
          conversationId,
          text,
          sentByUserId: attendant?.id ?? null,
          sentByName: attendant?.name ?? null,
        });

        if (!result.ok) {
          return Response.json(
            { error: result.error, message: result.message ?? undefined },
            { status: result.status },
          );
        }

        return Response.json({ ok: true, message: result.message });
      },
    },
  },
});
