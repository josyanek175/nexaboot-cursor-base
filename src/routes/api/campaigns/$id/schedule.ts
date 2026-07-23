// POST /api/campaigns/:id/schedule — agenda campanha (draft → scheduled).
import { createFileRoute } from "@tanstack/react-router";
import { ensureCampaignsSchema } from "@/lib/pg.server";
import { getCampaignActor, scheduleCampaign } from "@/lib/campaign.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/campaigns/$id/schedule")({
  server: {
    handlers: {
      POST: async ({ params }) => {
        await ensureCampaignsSchema();
        if (!UUID_RE.test(params.id)) {
          return Response.json({ error: "invalid_id" }, { status: 400 });
        }

        const ctx = await getCampaignActor("manage");
        if (ctx instanceof Response) return ctx;

        try {
          const campaign = await scheduleCampaign(ctx.companyId, params.id, ctx.userId);
          if (!campaign) return Response.json({ error: "not_found" }, { status: 404 });
          return Response.json({ ok: true, campaign });
        } catch (e) {
          const msg = (e as Error).message;
          const map: Record<string, number> = {
            not_schedulable: 409,
            missing_channel: 400,
            missing_message: 400,
            missing_meta_template: 400,
            invalid_meta_template: 400,
            meta_template_not_approved: 400,
            missing_schedule_date: 400,
            missing_window: 400,
            no_pending_contacts: 400,
            invalid_channel: 400,
          };
          if (msg.startsWith("missing_evolution_variable_mapping:")) {
            const variables = msg.slice("missing_evolution_variable_mapping:".length).split(",");
            return Response.json(
              { error: "missing_evolution_variable_mapping", variables },
              { status: 400 },
            );
          }
          if (msg.startsWith("unconfirmed_evolution_variable_mapping:")) {
            const variables = msg.slice("unconfirmed_evolution_variable_mapping:".length).split(",");
            return Response.json(
              { error: "unconfirmed_evolution_variable_mapping", variables },
              { status: 400 },
            );
          }
          if (map[msg]) {
            return Response.json({ error: msg }, { status: map[msg] });
          }
          console.error("[CAMPAIGN_SCHEDULE_FAIL]", e);
          return Response.json({ error: "schedule_failed" }, { status: 500 });
        }
      },
    },
  },
});
