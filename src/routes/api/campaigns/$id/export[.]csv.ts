// GET /api/campaigns/:id/export.csv — exportação CSV de destinatários (streaming).
import { createFileRoute } from "@tanstack/react-router";

import { getCampaignActor } from "@/lib/campaign.server";
import {
  parseCampaignExportFilters,
  startCampaignRecipientsExport,
} from "@/lib/campaign-export.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/campaigns/$id/export.csv")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        if (!UUID_RE.test(params.id)) {
          return Response.json({ error: "invalid_id" }, { status: 400 });
        }

        const ctx = await getCampaignActor("view");
        if (ctx instanceof Response) return ctx;

        const url = new URL(request.url);
        const parsed = parseCampaignExportFilters(url.searchParams);
        if (!parsed.ok) {
          return Response.json({ error: parsed.error }, { status: 400 });
        }

        try {
          const result = await startCampaignRecipientsExport({
            companyId: ctx.companyId,
            campaignId: params.id,
            userId: ctx.userId,
            filters: parsed.filters,
          });

          if ("error" in result) {
            return Response.json({ error: "not_found" }, { status: 404 });
          }

          const asciiName = result.filename.replace(/[^\x20-\x7E]/g, "_");
          return new Response(result.stream, {
            status: 200,
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
              "Cache-Control": "no-store",
              "X-Export-Expected-Count": String(result.expectedCount),
            },
          });
        } catch (e) {
          console.error("[CAMPAIGN_EXPORT_FAIL]", e);
          return Response.json({ error: "export_failed" }, { status: 500 });
        }
      },
    },
  },
});
