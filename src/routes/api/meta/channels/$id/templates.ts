// GET  /api/meta/channels/:id/templates — lista templates Meta do canal (sem token).
// POST /api/meta/channels/:id/templates/sync — sincroniza com Graph API.
import { createFileRoute } from "@tanstack/react-router";
import { ensureCrmSchema, ensureCampaignsSchema } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";
import { META_CHANNEL_UUID_RE } from "@/lib/meta-channels.server";
import {
  listMetaTemplatesForChannel,
} from "@/lib/meta-message-templates.server";

export const Route = createFileRoute("/api/meta/channels/$id/templates")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        await ensureCrmSchema();
        await ensureCampaignsSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        if (!META_CHANNEL_UUID_RE.test(params.id)) {
          return Response.json({ error: "invalid_id" }, { status: 400 });
        }

        const approvedOnly =
          new URL(request.url).searchParams.get("approved") !== "0";

        const templates = await listMetaTemplatesForChannel(companyId, params.id, {
          approvedOnly,
        });

        return Response.json({ templates });
      },
    },
  },
});
