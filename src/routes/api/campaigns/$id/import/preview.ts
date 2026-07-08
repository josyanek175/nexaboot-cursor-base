import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ensureCampaignsSchema } from "@/lib/pg.server";
import { getCampaignActor, getCampaignById } from "@/lib/campaign.server";
import { previewCampaignImport } from "@/lib/campaign-import.server";

const Body = z.object({
  rows: z.array(z.record(z.unknown())).min(1).max(10_000),
});

export const Route = createFileRoute("/api/campaigns/$id/import/preview")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        await ensureCampaignsSchema();
        const ctx = await getCampaignActor("manage");
        if (ctx instanceof Response) return ctx;

        const campaign = await getCampaignById(ctx.companyId, params.id);
        if (!campaign) return Response.json({ error: "not_found" }, { status: 404 });
        if (campaign.status !== "draft") {
          return Response.json({ error: "not_draft" }, { status: 409 });
        }

        const json = await request.json().catch(() => null);
        const parsed = Body.safeParse(json);
        if (!parsed.success) {
          return Response.json(
            { error: "invalid_input", detail: parsed.error.flatten() },
            { status: 400 },
          );
        }

        const preview = await previewCampaignImport({
          companyId: ctx.companyId,
          campaignId: params.id,
          rows: parsed.data.rows,
        });
        if (!preview) return Response.json({ error: "not_found" }, { status: 404 });

        return Response.json({ preview });
      },
    },
  },
});
