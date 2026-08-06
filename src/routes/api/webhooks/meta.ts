// GET/POST /api/webhooks/meta — URL oficial do webhook Meta WhatsApp Cloud API.
import { createFileRoute } from "@tanstack/react-router";
import { handleMetaWebhookGET, handleMetaWebhookPOST } from "@/lib/meta-webhook.server";
import { runWebhookWithConcurrencyLimit } from "@/lib/pg-pool-gate.server";

export const Route = createFileRoute("/api/webhooks/meta")({
  server: {
    handlers: {
      GET: async ({ request }) => handleMetaWebhookGET(request),
      POST: async ({ request }) =>
        runWebhookWithConcurrencyLimit("meta", () => handleMetaWebhookPOST(request)),
    },
  },
});
