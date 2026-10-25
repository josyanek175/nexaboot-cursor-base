import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getSql } from "@/lib/pg.server";
import { requireOperationsAdmin } from "@/lib/company-operations.server";
const Patch = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  active: z.boolean(),
  memberIds: z.array(z.string().uuid()).min(1).max(100),
});
export const Route = createFileRoute("/api/internal-groups")({
  server: {
    handlers: {
      GET: async () => {
        const actor = await requireOperationsAdmin();
        if (actor instanceof Response) return actor;
        const groups = await getSql()`SELECT g.id,g.name,g.active,g.created_at,
      COALESCE((SELECT json_agg(m.user_id) FROM public.internal_chat_members m
        JOIN public.users u ON u.id=m.user_id AND u.active=true
        WHERE m.chat_id=g.id AND (u.company_id=g.company_id OR u.id=${actor.userId}::uuid)),'[]'::json) AS member_ids
      FROM public.internal_chats g WHERE g.company_id=${actor.companyId}::uuid AND g.type='group' ORDER BY g.name`;
        return Response.json({ groups });
      },
      PATCH: async ({ request }) => {
        const actor = await requireOperationsAdmin();
        if (actor instanceof Response) return actor;
        const parsed = Patch.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
        const d = parsed.data;
        return getSql().begin(async (tx) => {
          const groups =
            await tx`SELECT id FROM public.internal_chats WHERE id=${d.id}::uuid AND company_id=${actor.companyId}::uuid AND type='group' FOR UPDATE`;
          if (!groups[0]) return Response.json({ error: "not_found" }, { status: 404 });
          const ids = [...new Set(d.memberIds.filter((id) => id !== actor.userId))];
          const members = ids.length
            ? await tx`SELECT id FROM public.users WHERE id=ANY(${ids}::uuid[]) AND company_id=${actor.companyId}::uuid AND active=true FOR SHARE`
            : [];
          if (members.length !== ids.length)
            return Response.json({ error: "member_outside_company" }, { status: 403 });
          await tx`UPDATE public.internal_chats SET name=${d.name},active=${d.active} WHERE id=${d.id}::uuid AND company_id=${actor.companyId}::uuid`;
          await tx`DELETE FROM public.internal_chat_members WHERE chat_id=${d.id}::uuid`;
          for (const id of [...new Set([actor.userId, ...ids])])
            await tx`INSERT INTO public.internal_chat_members(chat_id,user_id) VALUES(${d.id}::uuid,${id}::uuid)`;
          return Response.json({ ok: true });
        });
      },
    },
  },
});
