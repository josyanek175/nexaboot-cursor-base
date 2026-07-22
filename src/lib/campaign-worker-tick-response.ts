import type { WorkerTickResult } from "@/lib/campaign-worker.server";

export type CampaignWorkerTickHttpResponse = WorkerTickResult & {
  success: boolean;
  processed: number;
  sent: number;
  failed: number;
  reason?: string;
};

/** Normaliza resposta HTTP do tick preservando campos legados (ok, action, delayMs). */
export function mapCampaignWorkerTickResponse(
  result: WorkerTickResult,
): CampaignWorkerTickHttpResponse {
  const sent = result.action === "sent" ? 1 : 0;
  const failed = result.action === "failed" ? 1 : 0;
  const processed = sent + failed;

  if (result.action === "idle") {
    return {
      ...result,
      success: result.ok,
      processed: 0,
      sent: 0,
      failed: 0,
      reason: "nothing_to_process",
    };
  }

  if (result.action === "waiting_window" || result.action === "paused") {
    return {
      ...result,
      success: result.ok,
      processed: 0,
      sent: 0,
      failed: 0,
      reason: result.action,
    };
  }

  if (result.action === "completed") {
    return {
      ...result,
      success: result.ok,
      processed: 0,
      sent: 0,
      failed: 0,
      reason: "campaign_completed",
    };
  }

  return {
    ...result,
    success: result.ok,
    processed,
    sent,
    failed,
  };
}
