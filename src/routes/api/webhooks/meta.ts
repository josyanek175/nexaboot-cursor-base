// GET/POST /api/webhooks/meta — URL oficial do webhook Meta WhatsApp Cloud API.
import { createFileRoute } from "@tanstack/react-router";
import { handleMetaWebhookGET, handleMetaWebhookRequest } from "@/lib/meta-webhook.server";
import { runWebhookIngress } from "@/lib/webhook-ingress.server";

export const Route = createFileRoute("/api/webhooks/meta")({
  server: {
    handlers: {
      GET: async ({ request }) => handleMetaWebhookGET(request),
      POST: async ({ request }) =>
        runWebhookIngress("meta", () => handleMetaWebhookRequest(request)),
    },
  },
});
