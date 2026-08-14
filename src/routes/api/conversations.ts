// GET /api/conversations — lista conversas com filtros server-side (incl. fila de campanhas).
import { createFileRoute } from "@tanstack/react-router";

import { requireCompanyId } from "@/lib/company.server";
import { getSessionUserId } from "@/lib/session.server";
import { getCurrentUserCompanyInfo } from "@/lib/company.server";
import {
  getCampaignQueueCounts,
  listConversationsForCompany,
  type ConversationListFilters,
} from "@/lib/conversations-query.server";
import { withApiTiming } from "@/lib/perf-diag.server";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(n)), MAX_LIMIT);
}

function parseFilters(url: URL): ConversationListFilters {
  const p = url.searchParams;
  return {
    campaignQueue: p.get("campaign_queue") === "true",
    campaignServiceStatus: p.get("campaign_service_status") ?? undefined,
    campaignId: p.get("campaign_id") ?? undefined,
    campaignColor: p.get("campaign_color") ?? undefined,
    channelType: p.get("channel_type") ?? undefined,
    assignedUserId: p.get("assigned_user_id") ?? undefined,
    campaignReplyIntent: p.get("campaign_reply_intent") ?? undefined,
    unreadOnly: p.get("unread_only") === "true",
    dateFrom: p.get("date_from") ?? undefined,
    dateTo: p.get("date_to") ?? undefined,
    countsOnly: p.get("counts") === "true",
  };
}

export const Route = createFileRoute("/api/conversations")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        let uid = await getSessionUserId();
        if (!uid) {
          const info = await getCurrentUserCompanyInfo();
          uid = info.userId;
        }
        const currentUserId = uid ?? "00000000-0000-0000-0000-000000000000";

        return withApiTiming(
          {
            route: "/api/conversations",
            method: "GET",
            companyId,
            userId: uid,
            bytesPerResultHint: 900,
          },
          async (perf) => {
            const url = new URL(request.url);
            const filters = parseFilters(url);
            const limit = parseLimit(url.searchParams.get("limit"));

            if (filters.countsOnly) {
              const counts = await perf.timedDb("campaign_queue_counts", () =>
                getCampaignQueueCounts(companyId),
              );
              perf.setResultCount(1);
              return Response.json({ counts });
            }

            const conversations = await perf.timedDb("list_conversations", () =>
              listConversationsForCompany({
                companyId,
                currentUserId,
                filters,
                limit,
              }),
            );
            perf.setResultCount(conversations.length);

            // COUNT só quando explicitamente pedido (evita dobrar carga no polling).
            const includeCounts = url.searchParams.get("include_counts") === "true";

            if (includeCounts) {
              const counts = await perf.timedDb("campaign_queue_counts", () =>
                getCampaignQueueCounts(companyId),
              );
              return Response.json({
                conversations,
                counts,
                limit,
                hasMore: conversations.length >= limit,
              });
            }

            return Response.json({
              conversations,
              limit,
              hasMore: conversations.length >= limit,
            });
          },
        );
      },
    },
  },
});
