import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ensureCampaignsSchema } from "@/lib/pg.server";
import { getCampaignActor, listCampaigns, createCampaign } from "@/lib/campaign.server";

const CAMPAIGNS_AUTH_VERSION = "campaigns-auth-v5";

const TimeStr = z
  .string()
  .regex(/^\d{1,2}:\d{2}(:\d{2})?$/, "Horário inválido (use HH:MM)")
  .optional()
  .nullable();

const CreateBody = z.object({
  name: z.string().trim().min(1).max(200),
  message_text: z.string().trim().max(4000).optional().nullable(),
  whatsapp_channel_id: z.string().uuid().optional().nullable(),
  schedule_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida (use AAAA-MM-DD)")
    .optional()
    .nullable(),
  window_start_time: TimeStr,
  window_end_time: TimeStr,
});

export const Route = createFileRoute("/api/campaigns")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          await ensureCampaignsSchema();
          const ctx = await getCampaignActor("view");
          if (ctx instanceof Response) return ctx;

          const status = new URL(request.url).searchParams.get("status") ?? undefined;
          const campaigns = await listCampaigns(ctx.companyId, status || undefined);
          return Response.json({ campaigns: campaigns ?? [] });
        } catch (e) {
          const err = e as Error;
          console.error("[CAMPAIGNS_GET_FAIL]", {
            stage: "listCampaigns",
            authVersion: CAMPAIGNS_AUTH_VERSION,
            message: err.message,
            stack: err.stack,
          });
          return Response.json({ error: "list_failed" }, { status: 500 });
        }
      },

      POST: async ({ request }) => {
        try {
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

          try {
            const campaign = await createCampaign(ctx.companyId, ctx.userId, parsed.data);
            return Response.json({ campaign }, { status: 201 });
          } catch (e) {
            const msg = (e as Error).message;
            if (msg === "invalid_channel") {
              return Response.json({ error: "invalid_channel" }, { status: 400 });
            }
            if (msg === "invalid_window") {
              return Response.json({ error: "invalid_window" }, { status: 400 });
            }
            console.error("[CAMPAIGNS_CREATE_FAIL]", e);
            return Response.json({ error: "create_failed" }, { status: 500 });
          }
        } catch (e) {
          const err = e as Error;
          console.error("[CAMPAIGNS_POST_FAIL]", {
            stage: "createCampaign",
            authVersion: CAMPAIGNS_AUTH_VERSION,
            message: err.message,
            stack: err.stack,
          });
          return Response.json({ error: "create_failed" }, { status: 500 });
        }
      },
    },
  },
});
