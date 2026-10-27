import { createFileRoute } from "@tanstack/react-router";
import { getSessionUserId } from "@/lib/session.server";
import { requireCompanyId } from "@/lib/company.server";

import { getDashboardCampaigns } from "@/lib/dashboard-campaigns.server";

export const Route = createFileRoute("/api/dashboard/campaigns")({
  server: {
    handlers: {
      GET: async () => {
        const company = await requireCompanyId();
        if (company instanceof Response) return company;

        try {
          const payload = await getDashboardCampaigns(company, getSessionUserId());
          return Response.json(payload, { headers: { "Cache-Control": "private, no-store" } });
        } catch (e) {
          console.error("[DASHBOARD_CAMPAIGNS_API_FAIL]", {
            code: e && typeof e === "object" && "code" in e ? String(e.code) : "unknown",
          });
          return Response.json(
            {
              error: "dashboard_unavailable",
              message: "Não foi possível validar os dados do dashboard. Tente novamente.",
            },
            { status: 503, headers: { "Cache-Control": "private, no-store" } },
          );
        }
      },
    },
  },
});
