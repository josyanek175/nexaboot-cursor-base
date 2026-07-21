// POST /api/meta/channels/:id/templates/sync — sincroniza templates aprovados da Meta.
import { createFileRoute } from "@tanstack/react-router";
import { ensureCrmSchema, ensureCampaignsSchema } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";
import { META_CHANNEL_UUID_RE } from "@/lib/meta-channels.server";
import { syncMetaTemplatesForChannel } from "@/lib/meta-message-templates.server";

export const Route = createFileRoute("/api/meta/channels/$id/templates/sync")({
  server: {
    handlers: {
      POST: async ({ params }) => {
        await ensureCrmSchema();
        await ensureCampaignsSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        if (!META_CHANNEL_UUID_RE.test(params.id)) {
          return Response.json({ error: "invalid_id" }, { status: 400 });
        }

        const result = await syncMetaTemplatesForChannel(companyId, params.id);
        if (!result.ok) {
          return Response.json(
            { error: result.error },
            { status: result.status ?? 400 },
          );
        }

        return Response.json({
          ok: true,
          synced: result.synced,
          approved: result.approved,
          deactivated: result.deactivated,
        });
      },
    },
  },
});
