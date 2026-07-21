import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ensureCrmSchema } from "@/lib/pg.server";
import {
  getCampaignActor,
  getCampaignDetail,
  updateCampaign,
  deleteCampaign,
} from "@/lib/campaign.server";

const TimeStr = z
  .string()
  .regex(/^\d{1,2}:\d{2}(:\d{2})?$/, "Horário inválido (use HH:MM)")
  .optional()
  .nullable();

const PatchBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  message_text: z.string().trim().max(4000).optional().nullable(),
  whatsapp_channel_id: z.string().uuid().optional().nullable(),
  schedule_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida (use AAAA-MM-DD)")
    .optional()
    .nullable(),
  window_start_time: TimeStr,
  window_end_time: TimeStr,
  message_type: z.enum(["text", "meta_template"]).optional(),
  meta_template_id: z.string().trim().max(120).optional().nullable(),
  meta_template_name: z.string().trim().max(200).optional().nullable(),
  meta_language_code: z.string().trim().max(20).optional().nullable(),
  meta_variable_mappings: z.record(z.string(), z.string()).optional().nullable(),
});

export const Route = createFileRoute("/api/campaigns/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        await ensureCrmSchema();
        const ctx = await getCampaignActor("view");
        if (ctx instanceof Response) return ctx;

        const campaign = await getCampaignDetail(ctx.companyId, params.id);
        if (!campaign) return Response.json({ error: "not_found" }, { status: 404 });
        return Response.json({ campaign });
      },

      PATCH: async ({ params, request }) => {
        await ensureCrmSchema();
        const ctx = await getCampaignActor("manage");
        if (ctx instanceof Response) return ctx;

        const json = await request.json().catch(() => null);
        const parsed = PatchBody.safeParse(json);
        if (!parsed.success) {
          return Response.json(
            { error: "invalid_input", detail: parsed.error.flatten() },
            { status: 400 },
          );
        }

        try {
          const campaign = await updateCampaign(ctx.companyId, params.id, ctx.userId, parsed.data);
          if (!campaign) return Response.json({ error: "not_found" }, { status: 404 });
          return Response.json({ campaign });
        } catch (e) {
          const msg = (e as Error).message;
          if (msg === "not_draft") {
            return Response.json({ error: "not_draft" }, { status: 409 });
          }
          if (msg === "invalid_channel") {
            return Response.json({ error: "invalid_channel" }, { status: 400 });
          }
          if (msg === "invalid_window") {
            return Response.json({ error: "invalid_window" }, { status: 400 });
          }
          if (
            msg === "missing_meta_template" ||
            msg === "invalid_meta_template" ||
            msg === "meta_template_not_approved"
          ) {
            return Response.json({ error: msg }, { status: 400 });
          }
          console.error("[CAMPAIGNS_PATCH_FAIL]", e);
          return Response.json({ error: "update_failed" }, { status: 500 });
        }
      },

      DELETE: async ({ params }) => {
        await ensureCrmSchema();
        const ctx = await getCampaignActor("delete");
        if (ctx instanceof Response) return ctx;

        try {
          const ok = await deleteCampaign(ctx.companyId, params.id, ctx.userId);
          if (!ok) return Response.json({ error: "not_found" }, { status: 404 });
          return Response.json({ ok: true });
        } catch (e) {
          const msg = (e as Error).message;
          if (msg === "not_draft") {
            return Response.json({ error: "not_draft" }, { status: 409 });
          }
          console.error("[CAMPAIGNS_DELETE_FAIL]", e);
          return Response.json({ error: "delete_failed" }, { status: 500 });
        }
      },
    },
  },
});
