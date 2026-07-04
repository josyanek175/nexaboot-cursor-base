import { createFileRoute } from "@tanstack/react-router";
import { requireCompanyId } from "@/lib/company.server";
import { getDashboardCampaigns } from "@/lib/dashboard-campaigns.server";

export const Route = createFileRoute("/api/dashboard/campaigns")({
  server: {
    handlers: {
      GET: async () => {
        const company = await requireCompanyId();
        if (company instanceof Response) return company;

        const payload = await getDashboardCampaigns(company);
        return Response.json(payload);
      },
    },
  },
});
