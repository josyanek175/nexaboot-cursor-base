// POST /api/campaigns/:id/resume — retoma disparo pausado manualmente.
import { createFileRoute } from "@tanstack/react-router";
import { ensureCampaignsSchema } from "@/lib/pg.server";
import { getCampaignActor, resumeCampaignManually } from "@/lib/campaign.server";
import { processCampaignWorkerTick } from "@/lib/campaign-worker.server";
import { mapCampaignWorkerTickResponse } from "@/lib/campaign-worker-tick-response";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/campaigns/$id/resume")({
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
          const campaign = await resumeCampaignManually(ctx.companyId, params.id, ctx.userId);

          let tickResult = null;
          try {
            tickResult = mapCampaignWorkerTickResponse(await processCampaignWorkerTick());
          } catch (e) {
            console.error("[CAMPAIGN_MANUAL_RESUME_TICK_FAIL]", {
              campaignId: params.id,
              error: e instanceof Error ? e.message : String(e),
            });
          }

          return Response.json({
            success: true,
            campaignId: campaign.id,
            status: campaign.status,
            message: "Disparo retomado",
            campaign,
            tick: tickResult,
          });
        } catch (e) {
          const msg = (e as Error).message;
          const map: Record<string, number> = {
            not_found: 404,
            not_resumable: 409,
          };
          if (map[msg]) {
            return Response.json({ success: false, error: msg }, { status: map[msg] });
          }
          console.error("[CAMPAIGN_MANUAL_RESUME_FAIL]", e);
          return Response.json({ success: false, error: "resume_failed" }, { status: 500 });
        }
      },
    },
  },
});
