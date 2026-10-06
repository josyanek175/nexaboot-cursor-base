import { createFileRoute } from "@tanstack/react-router";

import { getCampaignActor } from "@/lib/campaign.server";
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
          const [blocked, settings] = await Promise.all([
            listBlockedDispatchContacts(ctx.companyId),
            getCampaignDispatchWindowSettings(ctx.companyId),
          ]);
          return Response.json({
            blocked,
            settings: {
              firstWindowDays: settings.firstWindowDays,
              secondWindowDays: settings.secondWindowDays,
              thirdWindowDays: settings.thirdWindowDays,
            },
          });
        } catch (e) {
          console.error("[CAMPAIGN_DISPATCH_BLOCKS_GET_FAIL]", e);
          return Response.json({ error: "load_failed" }, { status: 500 });
        }
      },
    },
  },
});
