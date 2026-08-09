// Webhook público Meta WhatsApp Cloud API.
// Handlers em meta-webhook.server.ts — sem exposição de tokens.

import { createFileRoute } from "@tanstack/react-router";
import {
  handleMetaWebhookGET,
  handleMetaWebhookPOST,
  handleMetaWebhookRequest,
} from "@/lib/meta-webhook.server";
import { runWebhookIngress } from "@/lib/webhook-ingress.server";

export { handleMetaWebhookGET, handleMetaWebhookPOST };

export const Route = createFileRoute("/api/public/webhooks/meta")({
  server: {
    handlers: {
      GET: async ({ request }) => handleMetaWebhookGET(request),
      POST: async ({ request }) =>
        runWebhookIngress("meta_public", () => handleMetaWebhookRequest(request)),
    },
  },
});
