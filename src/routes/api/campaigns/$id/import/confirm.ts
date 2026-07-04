import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ensureCampaignsSchema } from "@/lib/pg.server";
import { getCampaignActor } from "@/lib/campaign.server";
import { confirmCampaignImport } from "@/lib/campaign-import.server";

const Body = z.object({
  rows: z.array(z.record(z.unknown())).min(1).max(10_000),
  row_indices: z.array(z.number().int().min(0)).min(1).max(10_000),
});

export const Route = createFileRoute("/api/campaigns/$id/import/confirm")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        await ensureCampaignsSchema();
        const ctx = await getCampaignActor("manage");
        if (ctx instanceof Response) return ctx;

        const json = await request.json().catch(() => null);
        const parsed = Body.safeParse(json);
        if (!parsed.success) {
          return Response.json(
            { error: "invalid_input", detail: parsed.error.flatten() },
            { status: 400 },
          );
        }

        try {
          const result = await confirmCampaignImport({
            companyId: ctx.companyId,
            campaignId: params.id,
            userId: ctx.userId,
            rows: parsed.data.rows,
            rowIndices: parsed.data.row_indices,
          });
          if (!result) return Response.json({ error: "not_found" }, { status: 404 });
          return Response.json(result);
        } catch (e) {
          const msg = (e as Error).message;
          if (msg === "not_draft") {
            return Response.json({ error: "not_draft" }, { status: 409 });
          }
          console.error("[CAMPAIGNS_IMPORT_CONFIRM_FAIL]", e);
          return Response.json({ error: "import_failed" }, { status: 500 });
        }
      },
    },
  },
});
