import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/pg.server";
import { TeamAction, requireTeamManager, saveTeamAction } from "@/lib/team-access.server";
export const Route = createFileRoute("/api/team-access")({
  server: {
    handlers: {
      GET: async () => {
        const actor = await requireTeamManager();
        if (actor instanceof Response) return actor;
        const db = getSql(),
          c = actor.companyId;
        const [users, channels, teams, members, grants] = await Promise.all([
          db`SELECT id,name FROM public.users WHERE company_id=${c}::uuid AND active=true ORDER BY name`,
          db`SELECT id,name FROM public.whatsapp_channels WHERE company_id=${c}::uuid AND active=true AND deleted_at IS NULL ORDER BY name`,
          db`SELECT id,name FROM public.company_teams WHERE company_id=${c}::uuid ORDER BY name`,
          db`SELECT team_id,user_id FROM public.company_team_members WHERE company_id=${c}::uuid`,
          db`SELECT id,channel_id,user_id,team_id FROM public.company_channel_grants WHERE company_id=${c}::uuid`,
        ]);
        return Response.json({ users, channels, teams, members, grants });
      },
      POST: async ({ request }) => {
        const actor = await requireTeamManager();
        if (actor instanceof Response) return actor;
        const parsed = TeamAction.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
        try {
          return await saveTeamAction(actor.companyId, parsed.data);
        } catch (error) {
          if ((error as { code?: string }).code === "23505")
            return Response.json({ error: "duplicate_name" }, { status: 409 });
          throw error;
        }
      },
    },
  },
});
