// DELETE /api/meta/channels/:id/token — remove token cifrado para recadastro.
import { createFileRoute } from "@tanstack/react-router";
import { ensureCrmSchema } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";
import {
  META_CHANNEL_UUID_RE,
  buildMetaChannelPublic,
  clearMetaChannelToken,
  getMetaChannelRowForCompany,
} from "@/lib/meta-channels.server";

export const Route = createFileRoute("/api/meta/channels/$id/token")({
  server: {
    handlers: {
      DELETE: async ({ params }) => {
        await ensureCrmSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        if (!META_CHANNEL_UUID_RE.test(params.id)) {
          return Response.json({ error: "invalid_id" }, { status: 400 });
        }

        const existing = await getMetaChannelRowForCompany(params.id, companyId);
        if (!existing) {
          return Response.json({ error: "not_found" }, { status: 404 });
        }

        const clearError = await clearMetaChannelToken(params.id, companyId, "api_delete");
        if (clearError) return clearError;

        const row = await getMetaChannelRowForCompany(params.id, companyId);
        if (!row) {
          return Response.json({ error: "not_found" }, { status: 404 });
        }

        const channel = await buildMetaChannelPublic(row);
        return Response.json({ ok: true, cleared: true, channel });
      },
    },
  },
});
