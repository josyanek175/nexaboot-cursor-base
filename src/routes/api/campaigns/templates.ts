import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ensureCampaignsSchema } from "@/lib/pg.server";
import { getCampaignActor } from "@/lib/campaign.server";
import {
  listCampaignTemplates,
  createCampaignTemplate,
} from "@/lib/campaign-template.server";

const CreateBody = z.object({
  name: z.string().trim().min(1).max(200),
  message_body: z.string().trim().min(1).max(4000),
});

export const Route = createFileRoute("/api/campaigns/templates")({
  server: {
    handlers: {
      GET: async () => {
        await ensureCampaignsSchema();
        const ctx = await getCampaignActor("view");
        if (ctx instanceof Response) return ctx;

        try {
          const templates = await listCampaignTemplates(ctx.companyId);
          return Response.json({ templates });
        } catch (e) {
          console.error("[CAMPAIGNS_TEMPLATES_LIST_FAIL]", e);
          return Response.json({ templates: [] });
        }
      },

      POST: async ({ request }) => {
        await ensureCampaignsSchema();
        const ctx = await getCampaignActor("manage");
        if (ctx instanceof Response) return ctx;

        const json = await request.json().catch(() => null);
        const parsed = CreateBody.safeParse(json);
        if (!parsed.success) {
          return Response.json(
            { error: "invalid_input", detail: parsed.error.flatten() },
            { status: 400 },
          );
        }

        const template = await createCampaignTemplate(ctx.companyId, ctx.userId, parsed.data);
        return Response.json({ template }, { status: 201 });
      },
    },
  },
});
