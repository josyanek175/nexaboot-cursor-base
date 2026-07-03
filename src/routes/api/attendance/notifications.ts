// GET  /api/attendance/notifications — notificações de atendimento do usuário logado.
// POST /api/attendance/notifications — marca como lidas (body: { ids?: uuid[], conversationId?: uuid, all?: bool }).
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql, ensureAttendanceSchema } from "@/lib/pg.server";
import { requireAttendanceActor } from "@/lib/attendance.server";

const MarkBody = z.object({
  ids: z.array(z.string().uuid()).optional(),
  conversationId: z.string().uuid().optional(),
  all: z.boolean().optional(),
});

export const Route = createFileRoute("/api/attendance/notifications")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await ensureAttendanceSchema();
        const actor = await requireAttendanceActor();
        if (actor instanceof Response) return actor;

        const unreadOnly =
          new URL(request.url).searchParams.get("unread") !== "0" &&
          new URL(request.url).searchParams.get("unread") !== "false";

        const s = sql();
        const notifications = unreadOnly
          ? await s`
              SELECT
                n.id, n.conversation_id, n.type, n.title, n.body,
                n.from_user_id, n.read_at, n.created_at,
                u.name AS from_user_name
              FROM public.attendance_notifications n
              LEFT JOIN public.users u ON u.id = n.from_user_id
              WHERE n.user_id = ${actor.userId}::uuid
                AND n.company_id = ${actor.companyId}::uuid
                AND n.read_at IS NULL
              ORDER BY n.created_at DESC
              LIMIT 50
            `
          : await s`
              SELECT
                n.id, n.conversation_id, n.type, n.title, n.body,
                n.from_user_id, n.read_at, n.created_at,
                u.name AS from_user_name
              FROM public.attendance_notifications n
              LEFT JOIN public.users u ON u.id = n.from_user_id
              WHERE n.user_id = ${actor.userId}::uuid
                AND n.company_id = ${actor.companyId}::uuid
              ORDER BY n.created_at DESC
              LIMIT 50
            `;

        return Response.json({
          notifications,
          unread_count: notifications.filter((n: { read_at: unknown }) => !n.read_at).length,
        });
      },

      POST: async ({ request }) => {
        await ensureAttendanceSchema();
        const actor = await requireAttendanceActor();
        if (actor instanceof Response) return actor;

        const json = await request.json().catch(() => null);
        const parsed = MarkBody.safeParse(json);
        if (!parsed.success) {
          return Response.json({ error: "invalid_input" }, { status: 400 });
        }

        const s = sql();
        const { ids, conversationId, all } = parsed.data;

        if (all) {
          await s`
            UPDATE public.attendance_notifications
            SET read_at = now()
            WHERE user_id = ${actor.userId}::uuid
              AND company_id = ${actor.companyId}::uuid
              AND read_at IS NULL
          `;
        } else if (conversationId) {
          await s`
            UPDATE public.attendance_notifications
            SET read_at = now()
            WHERE user_id = ${actor.userId}::uuid
              AND company_id = ${actor.companyId}::uuid
              AND conversation_id = ${conversationId}::uuid
              AND read_at IS NULL
          `;
        } else if (ids && ids.length > 0) {
          await s`
            UPDATE public.attendance_notifications
            SET read_at = now()
            WHERE user_id = ${actor.userId}::uuid
              AND company_id = ${actor.companyId}::uuid
              AND id = ANY(${ids}::uuid[])
              AND read_at IS NULL
          `;
        } else {
          return Response.json({ error: "invalid_input" }, { status: 400 });
        }

        return Response.json({ ok: true });
      },
    },
  },
});
