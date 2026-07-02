import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ensureCrmSchema } from "@/lib/pg.server";
import {
  getCampaignActor,
  getCampaignById,
  listCampaignContacts,
  addCampaignContacts,
} from "@/lib/campaign.server";

const AddBody = z.object({
  contact_ids: z.array(z.string().uuid()).min(1).max(500),
});

export const Route = createFileRoute("/api/campaigns/$id/contacts")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        await ensureCrmSchema();
        const ctx = await getCampaignActor("view");
        if (ctx instanceof Response) return ctx;

        const campaign = await getCampaignById(ctx.companyId, params.id);
        if (!campaign) return Response.json({ error: "not_found" }, { status: 404 });

        const url = new URL(request.url);
        const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
        const limit = Math.min(
          100,
          Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50),
        );

        const result = await listCampaignContacts(ctx.companyId, params.id, page, limit);
        return Response.json({
          contacts: result.contacts,
          total: result.total,
          page,
          limit,
        });
      },

      POST: async ({ params, request }) => {
        await ensureCrmSchema();
        const ctx = await getCampaignActor("manage");
        if (ctx instanceof Response) return ctx;

        const campaign = await getCampaignById(ctx.companyId, params.id);
        if (!campaign) return Response.json({ error: "not_found" }, { status: 404 });

        const json = await request.json().catch(() => null);
        const parsed = AddBody.safeParse(json);
        if (!parsed.success) {
          return Response.json(
            { error: "invalid_input", detail: parsed.error.flatten() },
            { status: 400 },
          );
        }

        try {
          const result = await addCampaignContacts(
            ctx.companyId,
            params.id,
            ctx.userId,
            parsed.data.contact_ids,
          );
          return Response.json(result);
        } catch (e) {
          const msg = (e as Error).message;
          if (msg === "not_draft") {
            return Response.json({ error: "not_draft" }, { status: 409 });
          }
          if (msg === "not_found") {
            return Response.json({ error: "not_found" }, { status: 404 });
          }
          console.error("[CAMPAIGNS_CONTACTS_ADD_FAIL]", e);
          return Response.json({ error: "add_failed" }, { status: 500 });
        }
      },
    },
  },
});
