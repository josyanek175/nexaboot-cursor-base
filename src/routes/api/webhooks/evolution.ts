// POST /api/webhooks/evolution — URL OFICIAL do webhook da Evolution.
// A validação obrigatória do EVOLUTION_WEBHOOK_SECRET (token via ?token=,
// header x-webhook-secret ou header apikey) é feita dentro de
// handleEvolutionWebhookRequest, então nenhum caminho ingere sem token válido.
import { createFileRoute } from "@tanstack/react-router";
import { handleEvolutionWebhookRequest } from "@/routes/api/public/webhooks/evolution";
import { runWebhookIngress } from "@/lib/webhook-ingress.server";

export const Route = createFileRoute("/api/webhooks/evolution")({
  server: {
    handlers: {
      GET: async () => Response.json({ ok: true, service: "evolution-webhook" }),
      POST: async ({ request }) =>
        runWebhookIngress("evolution", () => handleEvolutionWebhookRequest(request)),
    },
  },
});
