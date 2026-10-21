import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { getCampaignActor } from "@/lib/campaign.server";
import { ensureCampaignsSchema } from "@/lib/pg.server";
import {
  canConfigureCampaignCosts,
  canViewCampaignCosts,
} from "@/lib/permissions";
import {
  getCampaignCostsReport,
  saveCampaignCostPrices,
} from "@/lib/campaign-costs.server";

const PutBody = z.object({
  marketingBrl: z.number().min(0).max(9999),
  utilityBrl: z.number().min(0).max(9999),
  authenticationBrl: z.number().min(0).max(9999),
});

export const Route = createFileRoute("/api/campaigns/costs")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const ctx = await getCampaignActor("view");
        if (ctx instanceof Response) return ctx;

        if (!canViewCampaignCosts(ctx.actor)) {
          return Response.json(
            {
              error: "forbidden",
              message: "Apenas gerente ou admin pode ver custos de campanha.",
            },
            { status: 403 },
          );
        }

        try {
          await ensureCampaignsSchema();
          const url = new URL(request.url);
          const report = await getCampaignCostsReport(ctx.companyId, {
            preset: url.searchParams.get("preset"),
            from: url.searchParams.get("from"),
            to: url.searchParams.get("to"),
          });
          return Response.json({
            ...report,
            canConfigure: canConfigureCampaignCosts(ctx.actor),
          });
        } catch (e) {
          const err = e as Error;
          console.error("[CAMPAIGN_COSTS_GET_FAIL]", {
            message: err?.message,
            stack: err?.stack,
          });
          return Response.json(
            {
              error: "load_failed",
              message: "Não foi possível carregar os custos de campanha.",
              detail: err?.message?.slice(0, 300) ?? null,
            },
            { status: 500 },
          );
        }
      },

      PUT: async ({ request }) => {
        const ctx = await getCampaignActor("manage");
        if (ctx instanceof Response) return ctx;

        if (!canConfigureCampaignCosts(ctx.actor)) {
          return Response.json(
            {
              error: "forbidden",
              message: "Apenas gerente ou admin pode configurar preços.",
            },
            { status: 403 },
          );
        }

        const json = await request.json().catch(() => null);
        const parsed = PutBody.safeParse(json);
        if (!parsed.success) {
          return Response.json(
            { error: "invalid_input", detail: parsed.error.flatten() },
            { status: 400 },
          );
        }

        try {
          await ensureCampaignsSchema();
          const prices = await saveCampaignCostPrices(
            ctx.companyId,
            ctx.userId,
            parsed.data,
          );
          return Response.json({ prices });
        } catch (e) {
          const err = e as Error;
          console.error("[CAMPAIGN_COSTS_PUT_FAIL]", {
            message: err?.message,
            stack: err?.stack,
          });
          return Response.json(
            {
              error: "save_failed",
              message: "Não foi possível salvar os preços.",
              detail: err?.message?.slice(0, 300) ?? null,
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
