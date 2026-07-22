// POST /api/campaigns/:id/pause — pausa manual do disparo.
import { createFileRoute } from "@tanstack/react-router";
import { ensureCampaignsSchema } from "@/lib/pg.server";
import { getCampaignActor, pauseCampaignManually } from "@/lib/campaign.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/campaigns/$id/pause")({
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
          const campaign = await pauseCampaignManually(ctx.companyId, params.id, ctx.userId);
          return Response.json({
            success: true,
            campaignId: campaign.id,
            status: campaign.status,
            message: "Disparo pausado",
            campaign,
          });
        } catch (e) {
          const msg = (e as Error).message;
          const map: Record<string, number> = {
            not_found: 404,
            not_pausable: 409,
          };
          if (map[msg]) {
            return Response.json({ success: false, error: msg }, { status: map[msg] });
          }
          console.error("[CAMPAIGN_MANUAL_PAUSE_FAIL]", e);
          return Response.json({ success: false, error: "pause_failed" }, { status: 500 });
        }
      },
    },
  },
});
