/** Estado de contatos de campanha — lógica pura para testes do worker multi-tick. */

export type SimContactStatus = "pending" | "processing" | "sent" | "failed" | "skipped";

export type SimContact = {
  id: string;
  status: SimContactStatus;
  provider_message_id: string | null;
  updated_at_ms: number;
};

export type SimCampaign = {
  id: string;
  status: "running" | "paused" | "completed" | "scheduled";
  contacts: SimContact[];
};

export function claimNextPendingContactSim(contacts: SimContact[]): SimContact | null {
  const row = contacts.find(
    (c) =>
      c.status === "pending" &&
      (c.provider_message_id == null || c.provider_message_id.trim() === ""),
  );
  if (!row) return null;
  row.status = "processing";
  row.updated_at_ms = Date.now();
  return row;
}

/** Libera reservas abandonadas (processing sem wamid). */
export function releaseStaleProcessingContactsSim(
  contacts: SimContact[],
  nowMs: number,
  staleMs = 30_000,
): number {
  let released = 0;
  for (const c of contacts) {
    if (c.status !== "processing") continue;
    if (c.provider_message_id && c.provider_message_id.trim()) continue;
    if (nowMs - c.updated_at_ms < staleMs) continue;
    c.status = "pending";
    c.updated_at_ms = nowMs;
    released += 1;
  }
  return released;
}

export function countContactsByStatus(
  contacts: SimContact[],
  statuses: SimContactStatus[],
): number {
  return contacts.filter((c) => statuses.includes(c.status)).length;
}

export function shouldCompleteCampaignSim(contacts: SimContact[]): boolean {
  return countContactsByStatus(contacts, ["pending", "processing"]) === 0;
}

export type SimTickResult =
  | { action: "sent"; contactId: string; delayMs: number }
  | { action: "idle"; delayMs: number; reason: string }
  | { action: "completed"; delayMs: number };

/**
 * Simula um tick: reserva 1 pending, envia, aplica pausa segura entre mensagens.
 * Contatos em processing abandonado (> staleMs) voltam a pending antes do claim.
 */
export function simulateWorkerTick(
  campaign: SimCampaign,
  opts?: {
    nowMs?: number;
    staleMs?: number;
    messagePauseMs?: number;
    abandonCurrentProcessing?: boolean;
  },
): SimTickResult {
  const nowMs = opts?.nowMs ?? Date.now();
  const staleMs = opts?.staleMs ?? 0;
  const messagePauseMs = opts?.messagePauseMs ?? 100;

  if (campaign.status === "completed") {
    return { action: "idle", delayMs: 5_000, reason: "campaign_completed" };
  }

  if (staleMs > 0) {
    releaseStaleProcessingContactsSim(campaign.contacts, nowMs, staleMs);
  }

  if (opts?.abandonCurrentProcessing) {
    for (const c of campaign.contacts) {
      if (c.status === "processing" && !c.provider_message_id?.trim()) {
        c.status = "pending";
      }
    }
  }

  let contact = claimNextPendingContactSim(campaign.contacts);
  if (!contact) {
    const pendingLeft = countContactsByStatus(campaign.contacts, ["pending", "processing"]);
    if (pendingLeft > 0) {
      return { action: "idle", delayMs: 2_000, reason: "processing_blocked" };
    }
    campaign.status = "completed";
    return { action: "completed", delayMs: 1_000 };
  }

  contact.status = "sent";
  contact.provider_message_id = `wamid.${contact.id}`;
  contact.updated_at_ms = nowMs;

  return { action: "sent", contactId: contact.id, delayMs: messagePauseMs };
}

/** Executa vários ticks consecutivos respeitando delayMs simulado. */
export function simulateMultiTickRun(opts: {
  contactCount: number;
  maxTicks?: number;
  staleMs?: number;
  messagePauseMs?: number;
}): {
  campaign: SimCampaign;
  ticks: SimTickResult[];
  sentIds: string[];
} {
  const campaign: SimCampaign = {
    id: "camp-sim",
    status: "running",
    contacts: Array.from({ length: opts.contactCount }, (_, i) => ({
      id: `c${i + 1}`,
      status: "pending" as const,
      provider_message_id: null,
      updated_at_ms: 0,
    })),
  };

  const ticks: SimTickResult[] = [];
  const sentIds: string[] = [];
  const maxTicks = opts.maxTicks ?? opts.contactCount + 5;
  let nowMs = 0;

  for (let i = 0; i < maxTicks; i += 1) {
    const result = simulateWorkerTick(campaign, {
      nowMs,
      staleMs: opts.staleMs ?? 0,
      messagePauseMs: opts.messagePauseMs ?? 100,
    });
    ticks.push(result);
    if (result.action === "sent") {
      sentIds.push(result.contactId);
      nowMs += result.delayMs;
      continue;
    }
    if (result.action === "completed") break;
    if (result.action === "idle" && result.reason === "processing_blocked") {
      nowMs += result.delayMs;
      continue;
    }
    break;
  }

  return { campaign, ticks, sentIds };
}
