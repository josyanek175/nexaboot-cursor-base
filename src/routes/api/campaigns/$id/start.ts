// POST /api/campaigns/:id/start — inicia disparo manual imediato.
import { createFileRoute } from "@tanstack/react-router";
import { ensureCampaignsSchema } from "@/lib/pg.server";
import { getCampaignActor, startCampaignNow } from "@/lib/campaign.server";
import { processCampaignWorkerTick } from "@/lib/campaign-worker.server";
import { mapCampaignWorkerTickResponse } from "@/lib/campaign-worker-tick-response";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/campaigns/$id/start")({
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
          const result = await startCampaignNow(ctx.companyId, params.id, ctx.userId);

          let tickResult = null;
          try {
            tickResult = mapCampaignWorkerTickResponse(await processCampaignWorkerTick());
          } catch (e) {
            console.error("[CAMPAIGN_MANUAL_START_TICK_FAIL]", {
              campaignId: params.id,
              error: e instanceof Error ? e.message : String(e),
            });
          }

          return Response.json({
            success: true,
            campaignId: result.campaign.id,
            status: result.campaign.status,
            message: "Disparo iniciado",
            campaign: result.campaign,
            tick: tickResult,
          });
        } catch (e) {
          const msg = (e as Error).message;
          const map: Record<string, number> = {
            not_found: 404,
            not_startable: 409,
            already_running: 409,
            already_completed: 409,
            missing_channel: 400,
            missing_message: 400,
            missing_meta_template: 400,
            invalid_meta_template: 400,
            meta_template_not_approved: 400,
            missing_window: 400,
            no_pending_contacts: 400,
            invalid_channel: 400,
          };
          if (msg.startsWith("missing_evolution_variable_mapping:")) {
            const variables = msg.slice("missing_evolution_variable_mapping:".length).split(",");
            return Response.json(
              { success: false, error: "missing_evolution_variable_mapping", variables },
              { status: 400 },
            );
          }
          if (msg.startsWith("unconfirmed_evolution_variable_mapping:")) {
            const variables = msg.slice("unconfirmed_evolution_variable_mapping:".length).split(",");
            return Response.json(
              { success: false, error: "unconfirmed_evolution_variable_mapping", variables },
              { status: 400 },
            );
          }
          if (map[msg]) {
            return Response.json({ success: false, error: msg }, { status: map[msg] });
          }
          console.error("[CAMPAIGN_MANUAL_START_FAIL]", e);
          return Response.json({ success: false, error: "start_failed" }, { status: 500 });
        }
      },
    },
  },
});
