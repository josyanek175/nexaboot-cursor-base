import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ensureCrmSchema } from "@/lib/pg.server";
import { getCampaignActor, listCampaigns, createCampaign } from "@/lib/campaign.server";

const CreateBody = z.object({
  name: z.string().trim().min(1).max(200),
  message_text: z.string().trim().max(4000).optional().nullable(),
  whatsapp_channel_id: z.string().uuid().optional().nullable(),
  send_interval_ms: z.number().int().min(1000).max(600000).optional(),
});

export const Route = createFileRoute("/api/campaigns")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await ensureCrmSchema();
        const ctx = await getCampaignActor("view");
        if (ctx instanceof Response) return ctx;

        const status = new URL(request.url).searchParams.get("status") ?? undefined;
        const campaigns = await listCampaigns(ctx.companyId, status || undefined);
        return Response.json({ campaigns });
      },

      POST: async ({ request }) => {
        await ensureCrmSchema();
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

        try {
          const campaign = await createCampaign(ctx.companyId, ctx.userId, parsed.data);
          return Response.json({ campaign }, { status: 201 });
        } catch (e) {
          const msg = (e as Error).message;
          if (msg === "invalid_channel") {
            return Response.json({ error: "invalid_channel" }, { status: 400 });
          }
          console.error("[CAMPAIGNS_CREATE_FAIL]", e);
          return Response.json({ error: "create_failed" }, { status: 500 });
        }
      },
    },
  },
});
