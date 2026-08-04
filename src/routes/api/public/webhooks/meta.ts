// Webhook público Meta WhatsApp Cloud API.
// Handlers em meta-webhook.server.ts — sem exposição de tokens.

import { createFileRoute } from "@tanstack/react-router";
import { handleMetaWebhookGET, handleMetaWebhookPOST } from "@/lib/meta-webhook.server";
import { runWebhookWithConcurrencyLimit } from "@/lib/pg-pool-gate.server";

export { handleMetaWebhookGET, handleMetaWebhookPOST };

export const Route = createFileRoute("/api/public/webhooks/meta")({
  server: {
    handlers: {
      GET: async ({ request }) => handleMetaWebhookGET(request),
      POST: async ({ request }) =>
        runWebhookWithConcurrencyLimit("meta_public", () => handleMetaWebhookPOST(request)),
    },
  },
});
