/** Estado de contatos de campanha — lógica pura para testes do worker multi-tick. */

import {
  classifyCampaignSendError,
  DEFAULT_MAX_SEND_ATTEMPTS,
  DEFAULT_PROCESSING_STALE_MS,
  TRANSIENT_RETRY_DELAY_MS,
  type ClassifiedSendError,
} from "./campaign-worker-processing.ts";

export type SimContactStatus = "pending" | "processing" | "sent" | "failed" | "skipped";

export type SimContact = {
  id: string;
  status: SimContactStatus;
  provider_message_id: string | null;
  /** Momento da reserva processing (equivale a campaign_send_queue.locked_at). */
  processing_started_at_ms: number | null;
  locked_by: string | null;
  attempts: number;
  error_code: string | null;
  error_message: string | null;
  /** Simula envio Meta ainda em voo (worker A). */
  send_in_progress?: boolean;
};

export type SimCampaign = {
  id: string;
  status: "running" | "paused" | "completed" | "scheduled";
  contacts: SimContact[];
};

export function makeSimContacts(count: number): SimContact[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `c${i + 1}`,
    status: "pending" as const,
    provider_message_id: null,
    processing_started_at_ms: null,
    locked_by: null,
    attempts: 0,
    error_code: null,
    error_message: null,
  }));
}

export function claimNextPendingContactSim(
  contacts: SimContact[],
  workerId = "worker-a",
  nowMs = Date.now(),
): SimContact | null {
  const row = contacts.find(
    (c) =>
      c.status === "pending" &&
      (c.provider_message_id == null || c.provider_message_id.trim() === ""),
  );
  if (!row) return null;
  row.status = "processing";
  row.processing_started_at_ms = nowMs;
  row.locked_by = workerId;
  return row;
}

/** Libera reservas abandonadas (processing sem wamid) após staleMs. */
export function reconcileInconsistentContactStatesSim(contacts: SimContact[]): number {
  let reconciled = 0;
  for (const c of contacts) {
    if (!c.provider_message_id?.trim()) continue;
    if (c.status !== "pending" && c.status !== "processing") continue;
    c.status = "sent";
    c.processing_started_at_ms = null;
    c.locked_by = null;
    c.send_in_progress = false;
    c.error_code = null;
    c.error_message = null;
    reconciled += 1;
  }
  return reconciled;
}

/** processing sem wamid e sem lock registrado — reserva órfã após falha no upsert. */
export function releaseOrphanProcessingContactsSim(contacts: SimContact[]): number {
  let released = 0;
  for (const c of contacts) {
    if (c.status !== "processing") continue;
    if (c.provider_message_id?.trim()) continue;
    if (c.send_in_progress) continue;
    if (c.processing_started_at_ms != null) continue;
    c.status = "pending";
    c.processing_started_at_ms = null;
    c.locked_by = null;
    c.error_code = "orphan_processing_released";
    c.error_message = "Reserva órfã liberada — retentativa";
    released += 1;
  }
  return released;
}

export function releaseStaleProcessingContactsSim(
  contacts: SimContact[],
  nowMs: number,
  staleMs = DEFAULT_PROCESSING_STALE_MS,
): number {
  let released = 0;
  for (const c of contacts) {
    if (c.status !== "processing") continue;
    if (c.provider_message_id && c.provider_message_id.trim()) continue;
    if (c.send_in_progress) continue;
    if (c.processing_started_at_ms == null) continue;
    if (nowMs - c.processing_started_at_ms < staleMs) continue;
    c.status = "pending";
    c.processing_started_at_ms = null;
    c.locked_by = null;
    c.error_code = "stale_processing_released";
    c.error_message = "Reserva expirada — retentativa";
    released += 1;
  }
  return released;
}

export function countUnclaimablePendingSim(contacts: SimContact[]): number {
  return contacts.filter(
    (c) =>
      c.status === "pending" &&
      !!c.provider_message_id?.trim(),
  ).length;
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

export function applyClassifiedContactError(
  contact: SimContact,
  classified: ClassifiedSendError,
  maxAttempts = DEFAULT_MAX_SEND_ATTEMPTS,
): "failed" | "retry_pending" {
  contact.attempts += 1;
  contact.error_code = classified.code;
  contact.error_message = classified.message;
  contact.processing_started_at_ms = null;
  contact.locked_by = null;
  contact.send_in_progress = false;

  if (classified.kind === "transient" && contact.attempts < maxAttempts) {
    contact.status = "pending";
    return "retry_pending";
  }
  contact.status = "failed";
  return "failed";
}

export type SimTickResult =
  | { action: "sent"; contactId: string; delayMs: number }
  | { action: "failed"; contactId: string; delayMs: number; reason: string }
  | { action: "idle"; delayMs: number; reason: string }
  | { action: "completed"; delayMs: number };

/**
 * Simula um tick: stale opcional, reserva 1 pending, envia.
 * staleMs undefined/0 = stale desabilitado (fluxo normal).
 */
export function simulateWorkerTick(
  campaign: SimCampaign,
  opts?: {
    nowMs?: number;
    staleMs?: number;
    messagePauseMs?: number;
    workerId?: string;
    sendError?: string;
  },
): SimTickResult {
  const nowMs = opts?.nowMs ?? Date.now();
  const staleMs = opts?.staleMs ?? 0;
  const messagePauseMs = opts?.messagePauseMs ?? 100;
  const workerId = opts?.workerId ?? "worker-a";

  if (campaign.status === "completed") {
    return { action: "idle", delayMs: 5_000, reason: "campaign_completed" };
  }

  reconcileInconsistentContactStatesSim(campaign.contacts);

  if (staleMs >= DEFAULT_PROCESSING_STALE_MS) {
    releaseStaleProcessingContactsSim(campaign.contacts, nowMs, staleMs);
  }
  releaseOrphanProcessingContactsSim(campaign.contacts);

  let contact = claimNextPendingContactSim(campaign.contacts, workerId, nowMs);
  if (!contact) {
    const pendingLeft = countContactsByStatus(campaign.contacts, ["pending", "processing"]);
    if (pendingLeft > 0) {
      return { action: "idle", delayMs: 2_000, reason: "processing_blocked" };
    }
    campaign.status = "completed";
    return { action: "completed", delayMs: 1_000 };
  }

  if (opts?.sendError) {
    const outcome = applyClassifiedContactError(contact, classifyCampaignSendError(opts.sendError));
    return {
      action: "failed",
      contactId: contact.id,
      delayMs: outcome === "retry_pending" ? TRANSIENT_RETRY_DELAY_MS : 500,
      reason: opts.sendError,
    };
  }

  contact.status = "sent";
  contact.provider_message_id = `wamid.${contact.id}`;
  contact.processing_started_at_ms = null;
  contact.locked_by = null;
  contact.send_in_progress = false;
  contact.error_code = null;
  contact.error_message = null;

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
    contacts: makeSimContacts(opts.contactCount),
  };

  const ticks: SimTickResult[] = [];
  const sentIds: string[] = [];
  const maxTicks = opts.maxTicks ?? opts.contactCount + 5;
  let nowMs = 0;
  const staleMs = opts.staleMs ?? 0;

  for (let i = 0; i < maxTicks; i += 1) {
    const result = simulateWorkerTick(campaign, {
      nowMs,
      staleMs,
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
    if (result.action === "failed") {
      nowMs += result.delayMs;
      continue;
    }
    break;
  }

  return { campaign, ticks, sentIds };
}

/** Worker A reservou e envio Meta ainda em voo; worker B não deve recuperar nem reenviar. */
export function simulateConcurrentWorkersRecent(): {
  workerBClaimWhileSending: SimContact | null;
  workerBStaleWhileSending: number;
  finalStatus: SimContactStatus;
  sendCount: number;
} {
  const contact: SimContact = {
    id: "c1",
    status: "pending",
    provider_message_id: null,
    processing_started_at_ms: null,
    locked_by: null,
    attempts: 0,
    error_code: null,
    error_message: null,
  };

  const workerA = claimNextPendingContactSim([contact], "worker-a", 0);
  if (workerA) workerA.send_in_progress = true;

  const workerBClaimWhileSending = claimNextPendingContactSim([contact], "worker-b", 30_000);
  const workerBStaleWhileSending = releaseStaleProcessingContactsSim(
    [contact],
    30_000,
    DEFAULT_PROCESSING_STALE_MS,
  );

  if (workerA) {
    workerA.send_in_progress = false;
    workerA.status = "sent";
    workerA.provider_message_id = "wamid.c1";
    workerA.processing_started_at_ms = null;
    workerA.locked_by = null;
  }

  return {
    workerBClaimWhileSending,
    workerBStaleWhileSending,
    finalStatus: contact.status,
    sendCount: contact.provider_message_id ? 1 : 0,
  };
}

/** Após stale timeout com reserva abandonada, worker B recupera e envia uma vez. */
export function simulateStaleRecoveryAfterAbandonedClaim(): {
  released: number;
  workerBClaim: SimContact | null;
  sendCount: number;
  finalStatus: SimContactStatus;
} {
  const contact: SimContact = {
    id: "c1",
    status: "pending",
    provider_message_id: null,
    processing_started_at_ms: null,
    locked_by: null,
    attempts: 0,
    error_code: null,
    error_message: null,
  };

  claimNextPendingContactSim([contact], "worker-a", 0);
  contact.send_in_progress = false;

  const nowMs = DEFAULT_PROCESSING_STALE_MS + 5_000;
  const released = releaseStaleProcessingContactsSim([contact], nowMs, DEFAULT_PROCESSING_STALE_MS);
  const workerBClaim = claimNextPendingContactSim([contact], "worker-b", nowMs);
  if (workerBClaim) {
    workerBClaim.status = "sent";
    workerBClaim.provider_message_id = "wamid.c1";
    workerBClaim.processing_started_at_ms = null;
    workerBClaim.locked_by = null;
  }

  return {
    released,
    workerBClaim,
    sendCount: contact.provider_message_id ? 1 : 0,
    finalStatus: contact.status,
  };
}

/** @deprecated use simulateConcurrentWorkersRecent */
export function simulateConcurrentWorkers(opts?: {
  staleMs?: number;
  advanceMs?: number;
}): ReturnType<typeof simulateConcurrentWorkersRecent> {
  return simulateConcurrentWorkersRecent();
}

export { DEFAULT_PROCESSING_STALE_MS, DEFAULT_MAX_SEND_ATTEMPTS, TRANSIENT_RETRY_DELAY_MS };
