import { createFileRoute } from "@tanstack/react-router";
import { ensureCampaignsSchema } from "@/lib/pg.server";
import { getCampaignActor } from "@/lib/campaign.server";
import { deactivateCampaignTemplate } from "@/lib/campaign-template.server";

export const Route = createFileRoute("/api/campaigns/templates/$id")({
  server: {
    handlers: {
      DELETE: async ({ params }) => {
        await ensureCampaignsSchema();
        const ctx = await getCampaignActor("manage");
        if (ctx instanceof Response) return ctx;

        const ok = await deactivateCampaignTemplate(ctx.companyId, params.id);
        if (!ok) return Response.json({ error: "not_found" }, { status: 404 });
        return Response.json({ ok: true });
      },
    },
  },
});
