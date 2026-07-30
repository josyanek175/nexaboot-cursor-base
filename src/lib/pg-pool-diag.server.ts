/**
 * Diagnóstico do pool postgres.js (sem segredos).
 * Conta aquisições pending/active com origem resumida.
 */
import { randomUUID } from "node:crypto";

export type PoolAcquisitionKind = "reserve" | "query" | "begin";

export type PoolAcquisitionStatus = "pending" | "active" | "released";

export type PoolAcquisitionRecord = {
  acquisitionId: string;
  requestId: string | null;
  kind: PoolAcquisitionKind;
  origin: string;
  startedAt: number;
  acquiredAt: number | null;
  releasedAt: number | null;
  status: PoolAcquisitionStatus;
};

const MAX_KEPT_RELEASED = 20;
const activeOrPending = new Map<string, PoolAcquisitionRecord>();
const recentlyReleased: PoolAcquisitionRecord[] = [];

/** requestId opcional propagado por rotas de diagnóstico. */
let _currentRequestId: string | null = null;

export function setPoolDiagRequestId(requestId: string | null): void {
  _currentRequestId = requestId;
}

function summarizeStack(skip = 3): string {
  const stack = new Error().stack ?? "";
  const lines = stack
    .split("\n")
    .slice(skip)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at "))
    .filter((l) => !l.includes("pg-pool-diag") && !l.includes("node:"))
    .slice(0, 4)
    .map((l) =>
      l
        .replace(/^at\s+/, "")
        .replace(/\?.*?:/, ":")
        .replace(/\\/g, "/"),
    );
  return lines.join(" | ") || "unknown";
}

export function trackPoolAcquisitionStart(
  kind: PoolAcquisitionKind,
  origin?: string,
): string {
  const acquisitionId = randomUUID();
  const rec: PoolAcquisitionRecord = {
    acquisitionId,
    requestId: _currentRequestId,
    kind,
    origin: origin ?? summarizeStack(),
    startedAt: Date.now(),
    acquiredAt: null,
    releasedAt: null,
    status: "pending",
  };
  activeOrPending.set(acquisitionId, rec);
  return acquisitionId;
}

export function trackPoolAcquisitionAcquired(acquisitionId: string): void {
  const rec = activeOrPending.get(acquisitionId);
  if (!rec || rec.status === "released") return;
  rec.acquiredAt = Date.now();
  rec.status = "active";
}

export function trackPoolAcquisitionReleased(acquisitionId: string): void {
  const rec = activeOrPending.get(acquisitionId);
  if (!rec || rec.status === "released") return;
  rec.releasedAt = Date.now();
  rec.status = "released";
  activeOrPending.delete(acquisitionId);
  recentlyReleased.push(rec);
  while (recentlyReleased.length > MAX_KEPT_RELEASED) recentlyReleased.shift();
}

export function getPoolDiagSnapshot(poolMax: number): {
  poolMax: number;
  trackedActive: number;
  trackedPending: number;
  trackedInflight: number;
  activeAcquisitions: Array<{
    acquisitionId: string;
    kind: PoolAcquisitionKind;
    origin: string;
    requestId: string | null;
    status: PoolAcquisitionStatus;
    waitedMs: number | null;
    heldMs: number | null;
    ageMs: number;
  }>;
  processPid: number;
} {
  const now = Date.now();
  let trackedActive = 0;
  let trackedPending = 0;
  const activeAcquisitions = [];

  for (const rec of activeOrPending.values()) {
    if (rec.status === "pending") trackedPending += 1;
    if (rec.status === "active") trackedActive += 1;
    const waitedMs =
      rec.acquiredAt != null ? rec.acquiredAt - rec.startedAt : null;
    const heldMs =
      rec.acquiredAt != null
        ? (rec.releasedAt ?? now) - rec.acquiredAt
        : null;
    activeAcquisitions.push({
      acquisitionId: rec.acquisitionId,
      kind: rec.kind,
      origin: rec.origin,
      requestId: rec.requestId,
      status: rec.status,
      waitedMs,
      heldMs,
      ageMs: now - rec.startedAt,
    });
  }

  activeAcquisitions.sort((a, b) => b.ageMs - a.ageMs);

  return {
    poolMax,
    trackedActive,
    trackedPending,
    trackedInflight: trackedActive + trackedPending,
    activeAcquisitions,
    processPid: process.pid,
  };
}

/** Só para testes. */
export function __resetPoolDiagForTests(): void {
  activeOrPending.clear();
  recentlyReleased.length = 0;
  _currentRequestId = null;
}

export function __getPoolDiagPendingCountForTests(): number {
  let n = 0;
  for (const r of activeOrPending.values()) {
    if (r.status === "pending") n += 1;
  }
  return n;
}

export function __getPoolDiagActiveCountForTests(): number {
  let n = 0;
  for (const r of activeOrPending.values()) {
    if (r.status === "active") n += 1;
  }
  return n;
}
