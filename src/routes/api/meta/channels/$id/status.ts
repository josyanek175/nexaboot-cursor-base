// GET /api/meta/channels/:id/status — status operacional do canal Meta (sem token).
import { createFileRoute } from "@tanstack/react-router";
import { ensureCrmSchema } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";
import {
  META_CHANNEL_UUID_RE,
  buildMetaChannelStatusPublic,
  getMetaChannelRowForCompany,
} from "@/lib/meta-channels.server";

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

        const status = await buildMetaChannelStatusPublic(row);
        return Response.json({ ok: true, ...status });
      },
    },
  },
});
