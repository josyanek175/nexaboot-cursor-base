// POST /api/messages/send-template — envia HSM Meta (meta_message_templates + overlay opcional).
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireCompanyId } from "@/lib/company.server";
import { getSessionUserId } from "@/lib/session.server";
import { sql } from "@/lib/pg.server";
import { sendAttendanceWhatsappTemplate } from "@/lib/attendance-template.server";

const Body = z.object({
  conversationId: z.string().uuid(),
  metaTemplateId: z.string().uuid(),
  attendanceTemplateId: z.string().uuid().optional().nullable(),
  variableValues: z.record(z.string(), z.string()).default({}),
});

export const Route = createFileRoute("/api/messages/send-template")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const company = await requireCompanyId();
        if (company instanceof Response) return company;

        const json = await request.json().catch(() => null);
        const parsed = Body.safeParse(json);
        if (!parsed.success) {
          return Response.json(
            { error: "invalid_input", detail: parsed.error.flatten() },
            { status: 400 },
          );
        }

        const uid = getSessionUserId();
        const s = sql();
        const attendantRows = uid
          ? await s<{ id: string; name: string | null }[]>`
              SELECT id, name FROM public.users
              WHERE id = ${uid}::uuid AND company_id = ${company}::uuid
              LIMIT 1
            `
          : [];
        const attendant = attendantRows[0] ?? null;

        const result = await sendAttendanceWhatsappTemplate({
          companyId: company,
          conversationId: parsed.data.conversationId,
          metaTemplateId: parsed.data.metaTemplateId,
          attendanceTemplateId: parsed.data.attendanceTemplateId,
          variableValues: parsed.data.variableValues,
          sentByUserId: attendant?.id ?? uid,
          sentByName: attendant?.name ?? null,
        });

        if (!result.ok) {
          return Response.json(
            {
              error: result.error,
              message: result.message ?? result.error,
            },
            { status: result.status },
          );
        }

        return Response.json({
          ok: true,
          wamid: result.wamid,
          message: result.message,
        });
      },
    },
  },
});
