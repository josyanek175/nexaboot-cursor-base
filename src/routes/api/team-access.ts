import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/pg.server";
import { TeamAction, requireTeamManager, saveTeamAction } from "@/lib/team-access.server";
import {
  checkOperationsSchema,
  operationsErrorResponse,
  operationsJson,
} from "@/lib/operations-readiness.server";
export const Route = createFileRoute("/api/team-access")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const actor = await requireTeamManager();
          if (actor instanceof Response) return actor;
          const unavailable = await checkOperationsSchema();
          if (unavailable) return unavailable;
          const db = getSql(),
            c = actor.companyId;
          const [users, channels, teams, members, grants] = await Promise.all([
            db`SELECT id,name FROM public.users WHERE company_id=${c}::uuid AND active=true ORDER BY name`,
            db`SELECT id,name FROM public.whatsapp_channels WHERE company_id=${c}::uuid AND active=true AND deleted_at IS NULL ORDER BY name`,
            db`SELECT id,name FROM public.company_teams WHERE company_id=${c}::uuid ORDER BY name`,
            db`SELECT team_id,user_id FROM public.company_team_members WHERE company_id=${c}::uuid`,
            db`SELECT id,channel_id,user_id,team_id FROM public.company_channel_grants WHERE company_id=${c}::uuid`,
          ]);
          return operationsJson({ users, channels, teams, members, grants });
        } catch (error) {
          return operationsErrorResponse(error, "team-access.GET");
        }
      },
      POST: async ({ request }) => {
        try {
          const actor = await requireTeamManager();
          if (actor instanceof Response) return actor;
          const parsed = TeamAction.safeParse(await request.json().catch(() => null));
          if (!parsed.success)
            return operationsJson(
              { error: "invalid_input", message: "Confira os dados informados." },
              400,
            );
          const unavailable = await checkOperationsSchema();
          if (unavailable) return unavailable;
          const response = await saveTeamAction(actor.companyId, parsed.data);
          response.headers.set("Cache-Control", "private, no-store");
          return response;
        } catch (error) {
          return operationsErrorResponse(error, "team-access.POST");
        }
      },
    },
  },
});
