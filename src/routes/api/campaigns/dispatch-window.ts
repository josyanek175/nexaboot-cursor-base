import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { getCampaignActor } from "@/lib/campaign.server";
import { ensureCampaignsSchema } from "@/lib/pg.server";
import { canConfigureCampaignDispatchWindow } from "@/lib/permissions";
import {
  getCampaignDispatchWindowSettings,
  saveCampaignDispatchWindowSettings,
} from "@/lib/campaign-dispatch-window.server";

const PutBody = z.object({
  firstWindowDays: z.number().int().min(1).max(365),
  secondWindowDays: z.number().int().min(1).max(365),
  thirdWindowDays: z.number().int().min(1).max(365),
});

export const Route = createFileRoute("/api/campaigns/dispatch-window")({
  server: {
    handlers: {
      GET: async () => {
        const ctx = await getCampaignActor("view");
        if (ctx instanceof Response) return ctx;

        try {
          await ensureCampaignsSchema();
          const settings = await getCampaignDispatchWindowSettings(ctx.companyId);
          return Response.json({
            settings: {
              firstWindowDays: settings.firstWindowDays,
              secondWindowDays: settings.secondWindowDays,
              thirdWindowDays: settings.thirdWindowDays,
            },
            canConfigure: canConfigureCampaignDispatchWindow(ctx.actor),
          });
        } catch (e) {
          const err = e as Error;
          console.error("[CAMPAIGN_DISPATCH_WINDOW_GET_FAIL]", {
            message: err?.message,
            stack: err?.stack,
          });
          return Response.json(
            {
              error: "load_failed",
              message: "Não foi possível carregar a configuração da janela.",
              detail: err?.message?.slice(0, 300) ?? null,
            },
            { status: 500 },
          );
        }
      },

      PUT: async ({ request }) => {
        const ctx = await getCampaignActor("manage");
        if (ctx instanceof Response) return ctx;

        if (!canConfigureCampaignDispatchWindow(ctx.actor)) {
          return Response.json(
            {
              error: "forbidden",
              message: "Apenas gerente ou admin pode configurar a janela de disparo.",
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
          const settings = await saveCampaignDispatchWindowSettings(
            ctx.companyId,
            ctx.userId,
            parsed.data,
          );
          return Response.json({
            settings: {
              firstWindowDays: settings.firstWindowDays,
              secondWindowDays: settings.secondWindowDays,
              thirdWindowDays: settings.thirdWindowDays,
            },
          });
        } catch (e) {
          const err = e as Error;
          console.error("[CAMPAIGN_DISPATCH_WINDOW_PUT_FAIL]", {
            message: err?.message,
            stack: err?.stack,
          });
          return Response.json(
            {
              error: "save_failed",
              message: "Não foi possível salvar a configuração da janela.",
              detail: err?.message?.slice(0, 300) ?? null,
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
