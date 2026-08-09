/**
 * Snapshot de health do media-worker.
 *
 * No processo do worker: connected/active são booleanos reais.
 * No processo web: use getMediaWorkerHealthForWeb() — connected fica "unknown"
 * sem heartbeat fresco no PostgreSQL (nunca true só porque a flag está ligada).
 */

export type MediaWorkerConnectionState = boolean | "unknown";

export type MediaWorkerHealthSnapshot = {
  mediaWorkerEnabled: boolean;
  /** true/false no worker; no web preferir "unknown" sem heartbeat. */
  mediaWorkerConnected: MediaWorkerConnectionState;
  mediaWorkerActive: MediaWorkerConnectionState;
  mediaWorkerLastSeenAt: string | null;
  mediaPending: number | null;
  mediaProcessing: number | null;
  mediaRetry: number | null;
  mediaDeadLetter: number | null;
  mediaOldestPendingAgeMs: number | null;
  mediaDownloadedBytes: number;
  mediaProcessedCount: number;
  mediaFailedCount: number;
  /** Origem do snapshot: process | heartbeat | flag_only */
  mediaWorkerSource: "process" | "heartbeat" | "flag_only";
};

let latestHealth: MediaWorkerHealthSnapshot = {
  mediaWorkerEnabled: false,
  mediaWorkerConnected: "unknown",
  mediaWorkerActive: "unknown",
  mediaWorkerLastSeenAt: null,
  mediaPending: null,
  mediaProcessing: null,
  mediaRetry: null,
  mediaDeadLetter: null,
  mediaOldestPendingAgeMs: null,
  mediaDownloadedBytes: 0,
  mediaProcessedCount: 0,
  mediaFailedCount: 0,
  mediaWorkerSource: "flag_only",
};

export function getMediaWorkerHealthSnapshot(): MediaWorkerHealthSnapshot {
  return { ...latestHealth };
}

export function setMediaWorkerHealthSnapshot(
  next: Partial<MediaWorkerHealthSnapshot>,
): MediaWorkerHealthSnapshot {
  latestHealth = { ...latestHealth, ...next };
  return getMediaWorkerHealthSnapshot();
}

export function incrementMediaWorkerCounters(delta: {
  downloadedBytes?: number;
  processed?: number;
  failed?: number;
}): void {
  if (delta.downloadedBytes) {
    latestHealth.mediaDownloadedBytes += delta.downloadedBytes;
  }
  if (delta.processed) latestHealth.mediaProcessedCount += delta.processed;
  if (delta.failed) latestHealth.mediaFailedCount += delta.failed;
}

/**
 * Visão segura para o processo web: nunca inventa connected=true.
 */
export function mediaWorkerHealthFromFlagsOnly(enabled: boolean): MediaWorkerHealthSnapshot {
  return {
    mediaWorkerEnabled: enabled,
    mediaWorkerConnected: "unknown",
    mediaWorkerActive: "unknown",
    mediaWorkerLastSeenAt: null,
    mediaPending: null,
    mediaProcessing: null,
    mediaRetry: null,
    mediaDeadLetter: null,
    mediaOldestPendingAgeMs: null,
    mediaDownloadedBytes: 0,
    mediaProcessedCount: 0,
    mediaFailedCount: 0,
    mediaWorkerSource: "flag_only",
  };
}
