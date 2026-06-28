// POST /api/webhooks/evolution — URL OFICIAL do webhook da Evolution.
// A validação obrigatória do EVOLUTION_WEBHOOK_SECRET (token via ?token=,
// header x-webhook-secret ou header apikey) é feita dentro de
// handleEvolutionWebhookPOST, então nenhum caminho ingere sem token válido.
import { createFileRoute } from "@tanstack/react-router";
import { handleEvolutionWebhookPOST } from "@/routes/api/public/webhooks/evolution";

export const Route = createFileRoute("/api/webhooks/evolution")({
  server: {
    handlers: {
      GET: async () => Response.json({ ok: true, service: "evolution-webhook" }),
      POST: async ({ request }) => handleEvolutionWebhookPOST(request),
    },
  },
});
