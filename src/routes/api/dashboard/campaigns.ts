import { createFileRoute } from "@tanstack/react-router";
import { requireCompanyId } from "@/lib/company.server";
import { ensureCampaignsSchema } from "@/lib/pg.server";
import { getDashboardCampaigns } from "@/lib/dashboard-campaigns.server";

export const Route = createFileRoute("/api/dashboard/campaigns")({
  server: {
    handlers: {
      GET: async () => {
        const company = await requireCompanyId();
        if (company instanceof Response) return company;

        try {
          await ensureCampaignsSchema();
          const payload = await getDashboardCampaigns(company);
          return Response.json(payload);
        } catch (e) {
          console.error("[DASHBOARD_CAMPAIGNS_API_FAIL]", e);
          return Response.json({
            metrics: {
              periodDays: 30,
              messagesSent: 0,
              responsesReceived: 0,
              noResponse: 0,
              interested: 0,
              notInterested: 0,
              optOut: 0,
              sendErrors: 0,
            },
            recentCampaigns: [],
          });
        }
      },
    },
  },
});
