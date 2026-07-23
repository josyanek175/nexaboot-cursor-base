/**
 * Seleção multi-campanha do worker — lógica pura (testável).
 * Uma campanha pausada/fora da janela não pode bloquear outras aptas no mesmo tick.
 */

import { MANUAL_PAUSED_STATUS } from "@/lib/campaign-manual-control";
import {
  isWithinSendWindow,
  nextAllowedSendAt,
  nextMessagePauseMs,
  shouldPauseUntilNextDay,
} from "@/lib/campaign-send-policy";
import {
  claimNextPendingContactSim,
  countContactsByStatus,
  makeSimContacts,
  reconcileInconsistentContactStatesSim,
  releaseOrphanProcessingContactsSim,
  type SimContact,
  type SimContactStatus,
} from "@/lib/campaign-worker-contact-state";

export type CampaignSkipReason =
  | "manual_paused"
  | "outside_window"
  | "before_schedule"
  | "no_pending"
  | "waiting_processing";

export type CampaignWindowConfig = {
  scheduleDate: string | null;
  windowStart: string | null;
  windowEnd: string | null;
};

export type WorkerCampaignStatus =
  | "running"
  | "paused"
  | "scheduled"
  | "completed"
  | "manual_paused";

export type MultiSimCampaign = {
  id: string;
  status: WorkerCampaignStatus;
  scheduleDate?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  contacts: SimContact[];
  /** Ordem de prioridade (menor = primeiro, como updated_at ASC). */
  order?: number;
};

export type MultiCampaignTickResult =
  | { action: "sent"; campaignId: string; contactId: string; delayMs: number }
  | { action: "completed"; campaignId: string; delayMs: number }
  | { action: "paused"; delayMs: number; wakeupCampaignIds: string[] }
  | { action: "idle"; delayMs: number; reason: string };

const MAX_WAKEUP_DELAY_MS = 60_000;

export function campaignStatusPriority(status: string): number {
  if (status === "running") return 0;
  if (status === "scheduled") return 1;
  return 2;
}

export function sortCampaignCandidates<T extends { status: string; order?: number }>(
  campaigns: T[],
): T[] {
  return [...campaigns].sort((a, b) => {
    const pa = campaignStatusPriority(a.status);
    const pb = campaignStatusPriority(b.status);
    if (pa !== pb) return pa - pb;
    return (a.order ?? 0) - (b.order ?? 0);
  });
}

export function getScheduleStart(
  scheduleDate: string | null | undefined,
  windowStart: string | null | undefined,
): Date | null {
  if (!scheduleDate) return null;
  const startMin = windowStart
    ? Number(windowStart.slice(0, 2)) * 60 + Number(windowStart.slice(3, 5))
    : 0;
  const [y, m, d] = scheduleDate.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, Math.floor(startMin / 60), startMin % 60, 0, 0);
}

export function isCampaignOutsideSendWindow(
  now: Date,
  window: CampaignWindowConfig,
): boolean {
  return (
    shouldPauseUntilNextDay(now, window.windowEnd) ||
    !isWithinSendWindow(now, window.windowStart, window.windowEnd)
  );
}

export function computeCampaignWakeupMs(
  now: Date,
  window: CampaignWindowConfig,
): number {
  const nextAt = nextAllowedSendAt(
    now,
    window.scheduleDate,
    window.windowStart,
    window.windowEnd,
  );
  const scheduleStart = getScheduleStart(window.scheduleDate, window.windowStart);
  if (scheduleStart && now < scheduleStart) {
    return Math.min(scheduleStart.getTime() - now.getTime(), MAX_WAKEUP_DELAY_MS);
  }
  return Math.min(
    Math.max(nextAt.getTime() - now.getTime(), 1_000),
    MAX_WAKEUP_DELAY_MS,
  );
}

export function evaluateCampaignSkipReason(
  campaign: {
    status: string;
    scheduleDate?: string | null;
    windowStart?: string | null;
    windowEnd?: string | null;
    pendingCount: number;
    processingCount: number;
  },
  now: Date,
): CampaignSkipReason | null {
  if (campaign.status === MANUAL_PAUSED_STATUS) {
    return "manual_paused";
  }

  const window: CampaignWindowConfig = {
    scheduleDate: campaign.scheduleDate ?? null,
    windowStart: campaign.windowStart ?? null,
    windowEnd: campaign.windowEnd ?? null,
  };

  const scheduleStart = getScheduleStart(window.scheduleDate, window.windowStart);
  if (scheduleStart && now < scheduleStart) {
    return "before_schedule";
  }

  if (isCampaignOutsideSendWindow(now, window)) {
    return "outside_window";
  }

  if (campaign.pendingCount + campaign.processingCount === 0) {
    return "no_pending";
  }

  if (campaign.pendingCount === 0 && campaign.processingCount > 0) {
    return "waiting_processing";
  }

  return null;
}

export function aggregateIdleTickDelay(wakeupDelaysMs: number[]): number | null {
  if (wakeupDelaysMs.length === 0) return null;
  return Math.min(...wakeupDelaysMs);
}

/** Simula um tick global percorrendo candidatas até enviar 1 contato ou esgotar opções. */
export function simulateMultiCampaignWorkerTick(
  campaigns: MultiSimCampaign[],
  opts?: {
    now?: Date;
    messagePauseMs?: number;
  },
): MultiCampaignTickResult {
  const now = opts?.now ?? new Date();
  const messagePauseMs = opts?.messagePauseMs ?? nextMessagePauseMs();
  const sorted = sortCampaignCandidates(campaigns);
  const wakeupDelays: number[] = [];
  const wakeupCampaignIds: string[] = [];
  let lastCompletedId: string | null = null;

  for (const campaign of sorted) {
    if (campaign.status === "completed") continue;

    reconcileInconsistentContactStatesSim(campaign.contacts);
    releaseOrphanProcessingContactsSim(campaign.contacts);

    const pendingCount = countContactsByStatus(campaign.contacts, ["pending"]);
    const processingCount = countContactsByStatus(campaign.contacts, ["processing"]);
    const skip = evaluateCampaignSkipReason(
      {
        status: campaign.status,
        scheduleDate: campaign.scheduleDate,
        windowStart: campaign.windowStart,
        windowEnd: campaign.windowEnd,
        pendingCount,
        processingCount,
      },
      now,
    );

    if (skip === "before_schedule" || skip === "outside_window") {
      wakeupDelays.push(
        computeCampaignWakeupMs(now, {
          scheduleDate: campaign.scheduleDate ?? null,
          windowStart: campaign.windowStart ?? null,
          windowEnd: campaign.windowEnd ?? null,
        }),
      );
      wakeupCampaignIds.push(campaign.id);
      if (skip === "outside_window" && campaign.status === "running") {
        campaign.status = "paused";
      }
      continue;
    }

    if (skip === "manual_paused" || skip === "waiting_processing") {
      continue;
    }

    if (skip === "no_pending") {
      campaign.status = "completed";
      lastCompletedId = campaign.id;
      continue;
    }

    if (campaign.status === "scheduled" || campaign.status === "paused") {
      campaign.status = "running";
    }

    const contact = claimNextPendingContactSim(campaign.contacts, "worker-a", now.getTime());
    if (!contact) {
      if (pendingCount + processingCount > 0) continue;
      campaign.status = "completed";
      lastCompletedId = campaign.id;
      continue;
    }

    contact.status = "sent";
    contact.provider_message_id = `wamid.${campaign.id}.${contact.id}`;
    contact.processing_started_at_ms = null;
    contact.locked_by = null;

    return {
      action: "sent",
      campaignId: campaign.id,
      contactId: contact.id,
      delayMs: messagePauseMs,
    };
  }

  const idleDelay = aggregateIdleTickDelay(wakeupDelays);
  if (idleDelay != null) {
    return {
      action: "paused",
      delayMs: idleDelay,
      wakeupCampaignIds,
    };
  }

  if (lastCompletedId) {
    return { action: "completed", campaignId: lastCompletedId, delayMs: 1_000 };
  }

  return { action: "idle", delayMs: 5_000, reason: "no_runnable_campaign" };
}

/** Executa vários ticks consecutivos em cenário multi-campanha. */
export function simulateMultiCampaignRun(opts: {
  campaigns: MultiSimCampaign[];
  maxTicks?: number;
  now?: Date;
  messagePauseMs?: number;
}): {
  ticks: MultiCampaignTickResult[];
  sentByCampaign: Record<string, string[]>;
} {
  const ticks: MultiCampaignTickResult[] = [];
  const sentByCampaign: Record<string, string[]> = {};
  const maxTicks = opts.maxTicks ?? 20;
  let now = opts.now ?? new Date();

  for (let i = 0; i < maxTicks; i += 1) {
    const tick = simulateMultiCampaignWorkerTick(opts.campaigns, {
      now,
      messagePauseMs: opts.messagePauseMs ?? 100,
    });
    ticks.push(tick);

    if (tick.action === "sent") {
      if (!sentByCampaign[tick.campaignId]) sentByCampaign[tick.campaignId] = [];
      sentByCampaign[tick.campaignId].push(tick.contactId);
      now = new Date(now.getTime() + tick.delayMs);
      continue;
    }

    if (tick.action === "completed") {
      now = new Date(now.getTime() + tick.delayMs);
      continue;
    }

    if (tick.action === "paused") {
      break;
    }

    break;
  }

  return { ticks, sentByCampaign };
}

export function makeMultiSimCampaign(
  id: string,
  contactCount: number,
  opts?: Partial<Omit<MultiSimCampaign, "id" | "contacts">>,
): MultiSimCampaign {
  return {
    id,
    status: opts?.status ?? "running",
    scheduleDate: opts?.scheduleDate ?? null,
    windowStart: opts?.windowStart ?? "08:00",
    windowEnd: opts?.windowEnd ?? "18:00",
    order: opts?.order,
    contacts: opts?.contacts ?? makeSimContacts(contactCount),
  };
}

export { MANUAL_PAUSED_STATUS, type SimContactStatus };
