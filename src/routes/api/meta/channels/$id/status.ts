// GET /api/meta/channels/:id/status — consulta Graph API e status operacional (sem token).
import { createFileRoute } from "@tanstack/react-router";
import { ensureCrmSchema } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";
import { fetchMetaChannelLiveStatus } from "@/lib/meta-channel-status.server";
import {
  META_CHANNEL_UUID_RE,
  buildMetaChannelStatusPublic,
  getMetaChannelRowForCompany,
} from "@/lib/meta-channels.server";
import { loadChannelForCompany } from "@/lib/whatsapp/whatsapp-provider-router.server";

export const Route = createFileRoute("/api/meta/channels/$id/status")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        await ensureCrmSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        if (!META_CHANNEL_UUID_RE.test(params.id)) {
          return Response.json({ error: "invalid_id" }, { status: 400 });
        }

        const row = await getMetaChannelRowForCompany(params.id, companyId);
        if (!row) {
          return Response.json({ error: "not_found" }, { status: 404 });
        }

        const channel = await loadChannelForCompany(params.id, companyId);
        if (!channel || channel.channelType !== "meta") {
          return Response.json({ error: "not_meta_channel" }, { status: 400 });
        }

        const live = await fetchMetaChannelLiveStatus(channel);
        const base = await buildMetaChannelStatusPublic(row);

        return Response.json({
          ok: live.ok,
          ...base,
          graph: live.graphData ?? null,
          wabaPhoneNumbers: live.wabaPhoneNumbers ?? null,
          metaError: live.metaError ?? null,
        });
      },
    },
  },
});
