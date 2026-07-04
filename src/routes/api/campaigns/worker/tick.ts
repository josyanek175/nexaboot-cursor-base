// POST /api/campaigns/worker/tick — processa um passo do worker de campanhas.
// Protegido por CAMPAIGN_WORKER_SECRET (header x-worker-secret).
// Em desenvolvimento, se o secret não estiver definido, permite sem auth.
import { createFileRoute } from "@tanstack/react-router";
import { processCampaignWorkerTick } from "@/lib/campaign-worker.server";

function authorizeWorker(request: Request): boolean {
  const secret = process.env.CAMPAIGN_WORKER_SECRET;
  if (!secret) {
    // Dev sem secret: libera. Produção deve definir CAMPAIGN_WORKER_SECRET.
    return process.env.NODE_ENV !== "production";
  }
  const header = request.headers.get("x-worker-secret");
  return header === secret;
}

export const Route = createFileRoute("/api/campaigns/worker/tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!authorizeWorker(request)) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        try {
          const result = await processCampaignWorkerTick();
          return Response.json(result);
        } catch (e) {
          console.error("[CAMPAIGN_WORKER_TICK_HTTP_FAIL]", e);
          return Response.json(
            {
              ok: false,
              action: "error",
              delayMs: 10_000,
              message: e instanceof Error ? e.message : String(e),
            },
            { status: 500 },
          );
        }
      },

      GET: async ({ request }) => {
        // Health / diagnóstico leve (mesmo auth).
        if (!authorizeWorker(request)) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        return Response.json({
          ok: true,
          service: "campaign-worker",
          hasEvolutionUrl: !!process.env.EVOLUTION_API_URL,
          hasEvolutionKey: !!process.env.EVOLUTION_API_KEY,
        });
      },
    },
  },
});
