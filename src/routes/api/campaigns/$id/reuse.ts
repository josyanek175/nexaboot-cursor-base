import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ensureCampaignsSchema } from "@/lib/pg.server";
import { getCampaignActor, createCampaignFromSource } from "@/lib/campaign.server";

const Body = z.object({
  name: z.string().trim().min(1).max(200).optional(),
});

export const Route = createFileRoute("/api/campaigns/$id/reuse")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        await ensureCampaignsSchema();
        const ctx = await getCampaignActor("manage");
        if (ctx instanceof Response) return ctx;

        const json = await request.json().catch(() => ({}));
        const parsed = Body.safeParse(json);
        if (!parsed.success) {
          return Response.json(
            { error: "invalid_input", detail: parsed.error.flatten() },
            { status: 400 },
          );
        }

        const campaign = await createCampaignFromSource(
          ctx.companyId,
          ctx.userId,
          params.id,
          { name: parsed.data.name },
        );
        if (!campaign) return Response.json({ error: "not_found" }, { status: 404 });

        return Response.json({ campaign }, { status: 201 });
      },
    },
  },
});
