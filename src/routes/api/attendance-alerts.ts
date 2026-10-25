import { createFileRoute } from "@tanstack/react-router";
import { requireCompanyId, getCurrentUserCompanyInfo } from "@/lib/company.server";
import { isPlatformRole } from "@/lib/platform-roles";
import { getAttendanceAlerts } from "@/lib/company-operations.server";
export const Route = createFileRoute("/api/attendance-alerts")({
  server: {
    handlers: {
      GET: async () => {
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const actor = await getCurrentUserCompanyInfo();
        if (!actor.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
        const manager =
          isPlatformRole(actor.role) ||
          ["ADMIN_EMPRESA", "GERENTE", "SUPERVISOR"].includes(actor.role ?? "");
        return Response.json({ alerts: await getAttendanceAlerts(company, actor.userId, manager) });
      },
    },
  },
});
