import { createFileRoute } from "@tanstack/react-router";

import { requireAttendanceActor, canTransferAny } from "@/lib/attendance.server";
import { canViewCampaignCosts, actingUserFromAuth } from "@/lib/permissions";
import { getAttendanceWaitReport } from "@/lib/attendance-wait.server";

export const Route = createFileRoute("/api/dashboard/wait")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const actor = await requireAttendanceActor();
        if (actor instanceof Response) return actor;

        if (!canTransferAny(actor.role)) {
          return Response.json(
            {
              error: "forbidden",
              message: "Apenas gerente ou admin pode ver o tempo de espera.",
            },
            { status: 403 },
          );
        }

        const permActor = actingUserFromAuth({
          id: actor.userId,
          role: actor.role as string,
          tenantId: actor.companyId,
        });
        if (!canViewCampaignCosts(permActor)) {
          return Response.json(
            {
              error: "forbidden",
              message: "Apenas gerente ou admin pode ver o tempo de espera.",
            },
            { status: 403 },
          );
        }

        try {
          const url = new URL(request.url);
          const report = await getAttendanceWaitReport(actor.companyId, {
            preset: url.searchParams.get("preset"),
            from: url.searchParams.get("from"),
            to: url.searchParams.get("to"),
          });
          return Response.json(report);
        } catch (e) {
          const err = e as Error;
          console.error("[DASHBOARD_WAIT_GET_FAIL]", {
            message: err?.message,
            stack: err?.stack,
          });
          return Response.json(
            {
              error: "load_failed",
              message: "Não foi possível carregar o tempo de espera.",
              detail: err?.message?.slice(0, 300) ?? null,
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
