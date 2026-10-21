// Rota oficial usada pela Evolution: POST /webhook/evolution
// Reaproveita o handler PostgreSQL definido em /api/public/webhooks/evolution.
import { createFileRoute } from "@tanstack/react-router";
import { handleEvolutionWebhookPOST } from "@/routes/api/public/webhooks/evolution";

export const Route = createFileRoute("/webhook/evolution")({
  server: {
    handlers: {
      GET: async () =>
        new Response(
          JSON.stringify({ ok: true, service: "evolution-webhook-pg" }),
          { headers: { "Content-Type": "application/json" } },
        ),
      POST: async ({ request }) => handleEvolutionWebhookPOST(request),
    },
  },
});
