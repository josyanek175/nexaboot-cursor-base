// GET /api/reports/conversations/export.csv — CSV streaming (mesmos filtros da tela).
import { createFileRoute } from "@tanstack/react-router";

import {
  requireConversationReportActor,
  parseConversationReportFilters,
  startConversationReportExport,
} from "@/lib/conversation-reports.server";

export const Route = createFileRoute("/api/reports/conversations/export.csv")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const actor = await requireConversationReportActor();
        if (actor instanceof Response) return actor;

        const url = new URL(request.url);
        // company_id externo é ignorado — sessão apenas.
        const parsed = parseConversationReportFilters(url.searchParams);
        if (!parsed.ok) {
          return Response.json(
            { error: parsed.error, message: parsed.message },
            { status: 400 },
          );
        }

        try {
          const result = await startConversationReportExport({
            companyId: actor.companyId,
            userId: actor.userId,
            role: actor.role,
            filters: parsed.filters,
            signal: request.signal,
          });

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
          console.error("[CONVERSATION_REPORT_EXPORT_FAIL]", {
            companyId: actor.companyId,
            error: e instanceof Error ? e.message : String(e),
          });
          return Response.json(
            {
              error: "export_failed",
              message: "Não foi possível gerar o CSV. Tente novamente.",
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
