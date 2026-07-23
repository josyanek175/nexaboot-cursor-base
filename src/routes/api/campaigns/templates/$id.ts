import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ensureCampaignsSchema } from "@/lib/pg.server";
import { getCampaignActor } from "@/lib/campaign.server";
import {
  listCampaignTemplates,
  createCampaignTemplate,
  getCampaignTemplate,
  updateCampaignTemplate,
  deactivateCampaignTemplate,
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

const UpdateBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  message_body: z.string().trim().min(1).max(4000).optional(),
  description: z.string().trim().max(500).optional(),
  footer: z.string().trim().max(500).optional(),
  response_options: z.array(ResponseOptionSchema).optional(),
  channel_type: z.enum(["evolution", "meta", "both"]).optional(),
  active: z.boolean().optional(),
});

export const Route = createFileRoute("/api/campaigns/templates/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        await ensureCampaignsSchema();
        const ctx = await getCampaignActor("view");
        if (ctx instanceof Response) return ctx;

        const template = await getCampaignTemplate(ctx.companyId, params.id, {
          includeInactive: true,
        });
        if (!template) return Response.json({ error: "not_found" }, { status: 404 });
        return Response.json({ template });
      },

      PATCH: async ({ params, request }) => {
        await ensureCampaignsSchema();
        const ctx = await getCampaignActor("manage");
        if (ctx instanceof Response) return ctx;

        const json = await request.json().catch(() => null);
        const parsed = UpdateBody.safeParse(json);
        if (!parsed.success) {
          return Response.json(
            { error: "invalid_input", detail: parsed.error.flatten() },
            { status: 400 },
          );
        }

        const template = await updateCampaignTemplate(ctx.companyId, params.id, parsed.data);
        if (!template) return Response.json({ error: "not_found" }, { status: 404 });
        return Response.json({ template });
      },

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
