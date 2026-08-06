/**
 * Modo do worker de campanhas — default seguro: http (compatibilidade).
 */

export type CampaignWorkerMode = "http" | "direct" | "disabled";

export function parseCampaignWorkerMode(
  env: NodeJS.ProcessEnv = process.env,
): CampaignWorkerMode {
  const raw = (env.CAMPAIGN_WORKER_MODE ?? "").trim().toLowerCase();
  if (raw === "direct") return "direct";
  if (raw === "disabled") return "disabled";
  // Ausente ou qualquer outro valor → http (não desliga o worker legado).
  return "http";
}

export function isCampaignWorkerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env.CAMPAIGN_WORKER_ENABLED ?? "").trim().toLowerCase();
  if (!raw) return true; // default on for direct entrypoint checks can override
  return raw === "true" || raw === "1" || raw === "yes";
}

export function readCampaignWorkerConcurrency(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.CAMPAIGN_WORKER_CONCURRENCY?.trim();
  if (!raw) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.floor(n);
}

/** Respostas 503 da rota legada /api/campaigns/worker/tick. */
export function campaignWorkerModeHttpResponse(mode: CampaignWorkerMode): Response {
  if (mode === "direct") {
    return Response.json(
      {
        ok: false,
        code: "worker_mode_direct",
        message: "O processamento de campanhas está ativo no worker direto.",
      },
      { status: 503 },
    );
  }
  return Response.json(
    {
      ok: false,
      code: "worker_disabled",
      message: "O processamento de campanhas está desabilitado (CAMPAIGN_WORKER_MODE=disabled).",
    },
    { status: 503 },
  );
}
