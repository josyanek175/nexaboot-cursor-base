/** Regras puras para controle manual de campanhas (UI + testes). */

export const MANUAL_PAUSED_STATUS = "manual_paused";

export function isCampaignManualStartAllowed(status: string): boolean {
  return (
    status === "draft" ||
    status === "scheduled" ||
    status === "paused" ||
    status === MANUAL_PAUSED_STATUS
  );
}

export function isCampaignManualPauseAllowed(status: string): boolean {
  return status === "running" || status === "scheduled";
}

export function isCampaignManualResumeAllowed(status: string): boolean {
  return status === "paused" || status === MANUAL_PAUSED_STATUS;
}

export function shouldShowManualStartButton(opts: {
  status: string;
  pendingCount: number;
  channelUnavailable: boolean;
  hasMetaTemplate: boolean;
  isMetaChannel: boolean;
  hasMessage: boolean;
}): boolean {
  if (!isCampaignManualStartAllowed(opts.status)) return false;
  if (opts.status === "completed" || opts.status === "running") return false;
  if (opts.pendingCount < 1) return false;
  if (opts.channelUnavailable) return false;
  if (opts.isMetaChannel && !opts.hasMetaTemplate) return false;
  if (!opts.isMetaChannel && !opts.hasMessage) return false;
  return true;
}
