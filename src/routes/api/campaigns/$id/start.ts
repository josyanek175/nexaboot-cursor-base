// POST /api/campaigns/:id/start — inicia disparo manual imediato.
import { createFileRoute } from "@tanstack/react-router";

import { getCampaignActor, startCampaignNow } from "@/lib/campaign.server";
import { processCampaignWorkerTick } from "@/lib/campaign-worker.server";
import { mapCampaignWorkerTickResponse } from "@/lib/campaign-worker-tick-response";
import { parseCampaignWorkerMode } from "@/lib/campaign-worker-mode";
import { getSql } from "@/lib/pg.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/campaigns/$id/start")({
  server: {
    handlers: {
      POST: async ({ params }) => {
        if (!UUID_RE.test(params.id)) {
          return Response.json({ error: "invalid_id" }, { status: 400 });
        }

        const ctx = await getCampaignActor("manage");
        if (ctx instanceof Response) return ctx;

        try {
          const result = await startCampaignNow(ctx.companyId, params.id, ctx.userId);
          const mode = parseCampaignWorkerMode();

          let tickResult = null;
          // Modo http: mantém tick imediato no processo web (compatibilidade).
          // Modo direct/disabled: só estado no banco — worker directo detecta no ciclo.
          if (mode === "http") {
            try {
              tickResult = mapCampaignWorkerTickResponse(
                await processCampaignWorkerTick({ sql: getSql() }),
              );
            } catch (e) {
              console.error("[CAMPAIGN_MANUAL_START_TICK_FAIL]", {
                campaignId: params.id,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }

          return Response.json({
            success: true,
            campaignId: result.campaign.id,
            status: result.campaign.status,
            message:
              mode === "disabled"
                ? "Disparo iniciado (worker disabled — nenhum envio até reativar)"
                : mode === "direct"
                  ? "Disparo iniciado (worker directo processará no próximo ciclo)"
                  : "Disparo iniciado",
            campaign: result.campaign,
            workerMode: mode,
            tick: tickResult,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === "not_found") {
            return Response.json({ error: "not_found" }, { status: 404 });
          }
          if (msg === "invalid_status") {
            return Response.json(
              { error: "invalid_status", message: "Campanha não pode ser iniciada neste status." },
              { status: 400 },
            );
          }
          console.error("[CAMPAIGN_START_FAIL]", e);
          return Response.json({ error: "start_failed" }, { status: 500 });
        }
      },
    },
  },
});
