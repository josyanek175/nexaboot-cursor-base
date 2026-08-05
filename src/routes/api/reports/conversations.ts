// GET /api/reports/conversations — relatório paginado de mensagens (ADMIN_EMPRESA / GERENTE).
import { createFileRoute } from "@tanstack/react-router";

import {
  requireConversationReportActor,
  parseConversationReportFilters,
  parseReportCursor,
  listConversationReportPage,
  listReportChannels,
  countConversationReportRows,
  CONVERSATION_REPORT_PAGE_LIMIT,
  CONVERSATION_REPORT_PAGE_LIMIT_MAX,
  mapAttendanceStatusLabel,
} from "@/lib/conversation-reports.server";

export const Route = createFileRoute("/api/reports/conversations")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const actor = await requireConversationReportActor();
        if (actor instanceof Response) return actor;

        const url = new URL(request.url);
        // company_id da query/body/header é ignorado — isolamento só pela sessão.
        const parsed = parseConversationReportFilters(url.searchParams);
        if (!parsed.ok) {
          return Response.json(
            { error: parsed.error, message: parsed.message },
            { status: 400 },
          );
        }

        const limitRaw = Number(url.searchParams.get("limit") ?? CONVERSATION_REPORT_PAGE_LIMIT);
        const limit = Number.isFinite(limitRaw)
          ? Math.min(
              CONVERSATION_REPORT_PAGE_LIMIT_MAX,
              Math.max(1, Math.floor(limitRaw)),
            )
          : CONVERSATION_REPORT_PAGE_LIMIT;

        const cursor = parseReportCursor(url.searchParams);
        const includeMeta = (url.searchParams.get("include_meta") ?? "").toLowerCase() === "true";
        const includeTotal = (url.searchParams.get("include_total") ?? "").toLowerCase() === "true";

        try {
          const page = await listConversationReportPage({
            companyId: actor.companyId,
            filters: parsed.filters,
            cursor,
            limit,
          });

          let total: number | undefined;
          if (includeTotal && !cursor) {
            try {
              total = await countConversationReportRows(actor.companyId, parsed.filters);
            } catch {
              total = undefined;
            }
          }

          let channels: Array<{ id: string; name: string }> | undefined;
          if (includeMeta) {
            channels = await listReportChannels(actor.companyId);
          }

          return Response.json({
            rows: page.rows.map((r) => ({
              ...r,
              attendance_status_label: mapAttendanceStatusLabel(r.attendance_status),
            })),
            next_cursor: page.nextCursor,
            has_more: page.hasMore,
            filters: parsed.filters,
            ...(total != null ? { total } : {}),
            ...(channels ? { meta: { channels } } : {}),
          });
        } catch (e) {
          console.error("[CONVERSATION_REPORT_LIST_FAIL]", {
            companyId: actor.companyId,
            error: e instanceof Error ? e.message : String(e),
          });
          return Response.json(
            {
              error: "query_failed",
              message: "Não foi possível carregar o relatório. Tente novamente.",
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
