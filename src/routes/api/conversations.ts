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

        let uid = getSessionUserId();
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
            const filters = parseFilters(new URL(request.url));

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
              }),
            );
            perf.setResultCount(conversations.length);

            const includeCounts =
              filters.campaignQueue ||
              new URL(request.url).searchParams.get("include_counts") === "true";

            if (includeCounts) {
              const counts = await perf.timedDb("campaign_queue_counts", () =>
                getCampaignQueueCounts(companyId),
              );
              return Response.json({ conversations, counts });
            }

            return Response.json({ conversations });
          },
        );
      },
    },
  },
});
