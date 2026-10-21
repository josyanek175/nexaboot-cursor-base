import { createFileRoute } from "@tanstack/react-router";

import { getCampaignActor } from "@/lib/campaign.server";
import { ensureCampaignsSchema } from "@/lib/pg.server";
import {
  getCampaignDispatchWindowSettings,
  listBlockedDispatchContacts,
} from "@/lib/campaign-dispatch-window.server";

export const Route = createFileRoute("/api/campaigns/dispatch-blocks")({
  server: {
    handlers: {
      GET: async () => {
        const ctx = await getCampaignActor("view");
        if (ctx instanceof Response) return ctx;

        try {
          // Sequencial: evita corrida de CREATE TABLE e garante schema de campanhas.
          await ensureCampaignsSchema();
          const settings = await getCampaignDispatchWindowSettings(ctx.companyId);
          const blocked = await listBlockedDispatchContacts(ctx.companyId, { settings });
          return Response.json({
            blocked,
            settings: {
              firstWindowDays: settings.firstWindowDays,
              secondWindowDays: settings.secondWindowDays,
              thirdWindowDays: settings.thirdWindowDays,
            },
          });
        } catch (e) {
          const err = e as Error;
          console.error("[CAMPAIGN_DISPATCH_BLOCKS_GET_FAIL]", {
            message: err?.message,
            stack: err?.stack,
          });
          return Response.json(
            {
              error: "load_failed",
              message: "Não foi possível carregar os bloqueados da janela de disparo.",
              detail: err?.message?.slice(0, 300) ?? null,
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
