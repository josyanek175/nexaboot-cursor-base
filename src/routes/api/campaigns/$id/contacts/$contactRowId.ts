import { createFileRoute } from "@tanstack/react-router";
import { ensureCrmSchema } from "@/lib/pg.server";
import { getCampaignActor, removeCampaignContact } from "@/lib/campaign.server";

export const Route = createFileRoute("/api/campaigns/$id/contacts/$contactRowId")({
  server: {
    handlers: {
      DELETE: async ({ params }) => {
        await ensureCrmSchema();
        const ctx = await getCampaignActor("manage");
        if (ctx instanceof Response) return ctx;

        try {
          const ok = await removeCampaignContact(
            ctx.companyId,
            params.id,
            params.contactRowId,
            ctx.userId,
          );
          if (!ok) return Response.json({ error: "not_found" }, { status: 404 });
          return Response.json({ ok: true });
        } catch (e) {
          const msg = (e as Error).message;
          if (msg === "not_draft") {
            return Response.json({ error: "not_draft" }, { status: 409 });
          }
          console.error("[CAMPAIGNS_CONTACTS_DELETE_FAIL]", e);
          return Response.json({ error: "delete_failed" }, { status: 500 });
        }
      },
    },
  },
});
