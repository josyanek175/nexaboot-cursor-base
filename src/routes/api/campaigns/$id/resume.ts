// POST /api/campaigns/:id/resume — retoma disparo pausado manualmente.
import { createFileRoute } from "@tanstack/react-router";

import { getCampaignActor, resumeCampaignManually } from "@/lib/campaign.server";
import { processCampaignWorkerTick } from "@/lib/campaign-worker.server";
import { mapCampaignWorkerTickResponse } from "@/lib/campaign-worker-tick-response";
import { parseCampaignWorkerMode } from "@/lib/campaign-worker-mode";
import { getSql } from "@/lib/pg.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/campaigns/$id/resume")({
  server: {
    handlers: {
      POST: async ({ params }) => {
        if (!UUID_RE.test(params.id)) {
          return Response.json({ error: "invalid_id" }, { status: 400 });
        }

        const ctx = await getCampaignActor("manage");
        if (ctx instanceof Response) return ctx;

        try {
          const campaign = await resumeCampaignManually(
            ctx.companyId,
            params.id,
            ctx.userId,
            ctx.actor,
          );

          const mode = parseCampaignWorkerMode();
          let tickResult = null;
          if (mode === "http") {
            try {
              tickResult = mapCampaignWorkerTickResponse(
                await processCampaignWorkerTick({ sql: getSql() }),
              );
            } catch (e) {
              console.error("[CAMPAIGN_MANUAL_RESUME_TICK_FAIL]", {
                campaignId: params.id,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }

          return Response.json({
            success: true,
            campaignId: campaign.id,
            status: campaign.status,
            message:
              mode === "disabled"
                ? "Disparo retomado (worker disabled — nenhum envio até reativar)"
                : mode === "direct"
                  ? "Disparo retomado (worker directo processará no próximo ciclo)"
                  : "Disparo retomado",
            campaign,
            workerMode: mode,
            tick: tickResult,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === "not_found") {
            return Response.json({ error: "not_found" }, { status: 404 });
          }
          if (msg === "forbidden_not_owner") {
            return Response.json(
              {
                error: "forbidden_not_owner",
                message: "Você só pode retomar campanhas que você criou.",
              },
              { status: 403 },
            );
          }
          if (msg === "invalid_status") {
            return Response.json(
              { error: "invalid_status", message: "Campanha não está pausada manualmente." },
              { status: 400 },
            );
          }
          console.error("[CAMPAIGN_RESUME_FAIL]", e);
          return Response.json({ error: "resume_failed" }, { status: 500 });
        }
      },
    },
  },
});
