// GET/POST /api/webhooks/meta/whatsapp — URL pública do webhook Meta WhatsApp Cloud API.
import { createFileRoute } from "@tanstack/react-router";
import { handleMetaWebhookGET, handleMetaWebhookPOST } from "@/lib/meta-webhook.server";

export const Route = createFileRoute("/api/webhooks/meta/whatsapp")({
  server: {
    handlers: {
      GET: async ({ request }) => handleMetaWebhookGET(request),
      POST: async ({ request }) => handleMetaWebhookPOST(request),
    },
  },
});
