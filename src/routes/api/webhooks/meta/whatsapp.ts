// GET/POST /api/webhooks/meta/whatsapp — URL pública do webhook Meta WhatsApp Cloud API.
import { createFileRoute } from "@tanstack/react-router";
import { handleMetaWebhookGET, handleMetaWebhookPOST } from "@/lib/meta-webhook.server";

export const Route = createFileRoute("/api/webhooks/meta/whatsapp")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        console.log("[META_ROUTE_GET_HIT]", {
          path: url.pathname,
          mode: url.searchParams.get("hub.mode"),
          hasChallenge: !!url.searchParams.get("hub.challenge"),
          hasVerifyToken: !!url.searchParams.get("hub.verify_token"),
        });
        return handleMetaWebhookGET(request);
      },
      POST: async ({ request }) => {
        const url = new URL(request.url);
        console.log("[META_ROUTE_POST_HIT]", {
          path: url.pathname,
          contentLength: request.headers.get("content-length"),
          hasSignature: !!request.headers.get("x-hub-signature-256"),
          contentType: request.headers.get("content-type"),
        });
        return handleMetaWebhookPOST(request);
      },
    },
  },
});
