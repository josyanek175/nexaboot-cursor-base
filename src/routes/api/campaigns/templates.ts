import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ensureCampaignsSchema } from "@/lib/pg.server";
import { getCampaignActor } from "@/lib/campaign.server";
import {
  listCampaignTemplates,
  createCampaignTemplate,
} from "@/lib/campaign-template.server";

const ResponseOptionSchema = z.object({
  n: z.number().int().positive(),
  label: z.string().trim().min(1).max(200),
  intent: z.enum(["interested", "not_interested", "opt_out", "unknown"]),
});

const CreateBody = z.object({
  name: z.string().trim().min(1).max(200),
  message_body: z.string().trim().min(1).max(4000),
  description: z.string().trim().max(500).optional(),
  footer: z.string().trim().max(500).optional(),
  response_options: z.array(ResponseOptionSchema).optional(),
  channel_type: z.enum(["evolution", "meta", "both"]).optional(),
});

export const Route = createFileRoute("/api/campaigns/templates")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await ensureCampaignsSchema();
        const ctx = await getCampaignActor("view");
        if (ctx instanceof Response) return ctx;

        const url = new URL(request.url);
        const includeInactive = url.searchParams.get("includeInactive") === "1";

        try {
          const templates = await listCampaignTemplates(ctx.companyId, { includeInactive });
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
