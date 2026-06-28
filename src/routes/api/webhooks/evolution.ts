// POST /api/webhooks/evolution — webhook protegido por EVOLUTION_WEBHOOK_SECRET.
// Reaproveita a ingestão já existente (handleEvolutionWebhookPOST), que grava no
// banco principal (nexaboot-postgres) com schema company_id.
// Token aceito via ?token= , header x-webhook-secret ou header apikey.
import { createFileRoute } from "@tanstack/react-router";
import { handleEvolutionWebhookPOST } from "@/routes/api/public/webhooks/evolution";

function tokenOf(request: Request): string {
  const url = new URL(request.url);
  return (
    url.searchParams.get("token") ||
    request.headers.get("x-webhook-secret") ||
    request.headers.get("apikey") ||
    ""
  );
}

export const Route = createFileRoute("/api/webhooks/evolution")({
  server: {
    handlers: {
      GET: async () => Response.json({ ok: true, service: "evolution-webhook" }),
      POST: async ({ request }) => {
        const expected = process.env.EVOLUTION_WEBHOOK_SECRET;
        if (!expected) {
          console.error("[EVOLUTION_ERROR]", "EVOLUTION_WEBHOOK_SECRET não configurado");
          return Response.json({ error: "webhook_secret_not_configured" }, { status: 503 });
        }
        if (tokenOf(request) !== expected) {
          console.warn("[EVOLUTION_WEBHOOK_RECEIVED]", { rejected: "invalid_token" });
          return Response.json({ error: "invalid_token" }, { status: 401 });
        }
        console.log("[EVOLUTION_WEBHOOK_RECEIVED]");
        // ensureCrmSchema é chamado dentro de handleEvolutionWebhookPOST.
        return handleEvolutionWebhookPOST(request);
      },
    },
  },
});
