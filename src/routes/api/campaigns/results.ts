import { createFileRoute } from "@tanstack/react-router";

import { getCampaignActor } from "@/lib/campaign.server";
import { ensureCampaignsSchema } from "@/lib/pg.server";
import { canViewCampaignCosts } from "@/lib/permissions";
import { getCampaignResultsReport } from "@/lib/campaign-results.server";

export const Route = createFileRoute("/api/campaigns/results")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const ctx = await getCampaignActor("view");
        if (ctx instanceof Response) return ctx;

        if (!canViewCampaignCosts(ctx.actor)) {
          return Response.json(
            {
              error: "forbidden",
              message: "Apenas gerente ou admin pode ver resultados de campanha.",
            },
            { status: 403 },
          );
        }

        try {
          await ensureCampaignsSchema();
          const url = new URL(request.url);
          const report = await getCampaignResultsReport(ctx.companyId, {
            preset: url.searchParams.get("preset"),
            from: url.searchParams.get("from"),
            to: url.searchParams.get("to"),
          });
          return Response.json(report);
        } catch (e) {
          const err = e as Error;
          console.error("[CAMPAIGN_RESULTS_GET_FAIL]", {
            message: err?.message,
            stack: err?.stack,
          });
          return Response.json(
            {
              error: "load_failed",
              message: "Não foi possível carregar os resultados de campanha.",
              detail: err?.message?.slice(0, 300) ?? null,
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
