/**
 * Snapshot de health do message-worker — módulo mínimo, sem IO.
 *
 * Fica separado do loop de propósito: o /api/health do web pode ler o estado
 * sem puxar amqplib nem a lógica de consumo para o grafo do servidor.
 */

export type MessageWorkerHealthSnapshot = {
  messageWorkerEnabled: boolean;
  messageWorkerConnected: boolean;
  messageWorkerActive: boolean;
  inboxPending: number | null;
  inboxQueued: number | null;
  inboxProcessing: number | null;
  inboxRetry: number | null;
  inboxDeadLetter: number | null;
  inboxOldestPendingAgeMs: number | null;
  mediaPending: number | null;
  mediaRetry: number | null;
  mediaDeadLetter: number | null;
};

let latestHealth: MessageWorkerHealthSnapshot = {
  messageWorkerEnabled: false,
  messageWorkerConnected: false,
  messageWorkerActive: false,
  inboxPending: null,
  inboxQueued: null,
  inboxProcessing: null,
  inboxRetry: null,
  inboxDeadLetter: null,
  inboxOldestPendingAgeMs: null,
  mediaPending: null,
  mediaRetry: null,
  mediaDeadLetter: null,
};

export function getMessageWorkerHealthSnapshot(): MessageWorkerHealthSnapshot {
  return { ...latestHealth };
}

export function setMessageWorkerHealthSnapshot(
  next: Partial<MessageWorkerHealthSnapshot>,
): MessageWorkerHealthSnapshot {
  latestHealth = { ...latestHealth, ...next };
  return getMessageWorkerHealthSnapshot();
}
