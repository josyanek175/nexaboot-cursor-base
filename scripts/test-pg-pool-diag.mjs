/**
 * Testes do diagnóstico de pool / starvation (sem DATABASE_URL).
 */
import assert from "node:assert/strict";
import {
  __getPoolDiagActiveCountForTests,
  __getPoolDiagPendingCountForTests,
  __resetPoolDiagForTests,
  getPoolDiagSnapshot,
  trackPoolAcquisitionAcquired,
  trackPoolAcquisitionReleased,
  trackPoolAcquisitionStart,
} from "../src/lib/pg-pool-diag.server.ts";

async function testFiveReservesBlockSixth() {
  __resetPoolDiagForTests();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = trackPoolAcquisitionStart("reserve", `route-${i}`);
    trackPoolAcquisitionAcquired(id);
    ids.push(id);
  }
  assert.equal(__getPoolDiagActiveCountForTests(), 5);

  const pendingId = trackPoolAcquisitionStart("reserve", "route-sixth");
  assert.equal(__getPoolDiagPendingCountForTests(), 1);
  assert.equal(__getPoolDiagActiveCountForTests(), 5);

  // Libera uma → sexta pode adquirir
  trackPoolAcquisitionReleased(ids[0]);
  trackPoolAcquisitionAcquired(pendingId);
  assert.equal(__getPoolDiagPendingCountForTests(), 0);
  assert.equal(__getPoolDiagActiveCountForTests(), 5);

  for (const id of ids.slice(1)) trackPoolAcquisitionReleased(id);
  trackPoolAcquisitionReleased(pendingId);
  assert.equal(__getPoolDiagActiveCountForTests(), 0);
  console.log("[TEST] five reserves block sixth until release: OK");
}

async function testLateTimeoutReleaseOnce() {
  __resetPoolDiagForTests();
  const id = trackPoolAcquisitionStart("reserve", "me-timeout");
  // Timeout do waiter (ainda pending)
  assert.equal(__getPoolDiagPendingCountForTests(), 1);

  // Aquisição tardia após timeout
  trackPoolAcquisitionAcquired(id);
  assert.equal(__getPoolDiagActiveCountForTests(), 1);

  // release exatamente uma vez
  trackPoolAcquisitionReleased(id);
  trackPoolAcquisitionReleased(id);
  assert.equal(__getPoolDiagActiveCountForTests(), 0);
  console.log("[TEST] late timeout then single release: OK");
}

async function testBeginWithoutFinallyLeak() {
  __resetPoolDiagForTests();
  const id = trackPoolAcquisitionStart("begin", "tx-no-finally");
  trackPoolAcquisitionAcquired(id);
  assert.equal(__getPoolDiagActiveCountForTests(), 1);
  // Sem release = leak visível no snapshot
  const snap = getPoolDiagSnapshot(5);
  assert.equal(snap.trackedActive, 1);
  assert.ok(snap.activeAcquisitions.some((a) => a.kind === "begin"));
  trackPoolAcquisitionReleased(id);
  console.log("[TEST] begin without finally visible as leak: OK");
}

async function testWorkerHoldingConnection() {
  __resetPoolDiagForTests();
  const workerIds = [];
  for (let i = 0; i < 3; i++) {
    const id = trackPoolAcquisitionStart("query", `campaign-worker:${i}`);
    trackPoolAcquisitionAcquired(id);
    workerIds.push(id);
  }
  const mePending = trackPoolAcquisitionStart("reserve", "auth/me");
  const snap = getPoolDiagSnapshot(5);
  assert.equal(snap.trackedActive, 3);
  assert.equal(snap.trackedPending, 1);
  assert.ok(snap.activeAcquisitions.some((a) => a.origin.includes("campaign-worker")));
  assert.ok(snap.activeAcquisitions.some((a) => a.origin.includes("auth/me")));

  for (const id of workerIds) trackPoolAcquisitionReleased(id);
  trackPoolAcquisitionAcquired(mePending);
  trackPoolAcquisitionReleased(mePending);
  console.log("[TEST] worker holding slots + me pending: OK");
}

async function testReleaseAfterErrorAbort() {
  __resetPoolDiagForTests();
  const id = trackPoolAcquisitionStart("query", "route-error");
  trackPoolAcquisitionAcquired(id);
  try {
    throw new Error("boom");
  } catch {
    trackPoolAcquisitionReleased(id);
  }
  assert.equal(__getPoolDiagActiveCountForTests(), 0);
  console.log("[TEST] release after error/abort: OK");
}

async function testReservedOpenZeroWhilePendingExplained() {
  __resetPoolDiagForTests();
  // Simula: 5 queries no pool (não passam por reservedOpen counter)
  for (let i = 0; i < 5; i++) {
    const id = trackPoolAcquisitionStart("query", `poll:${i}`);
    trackPoolAcquisitionAcquired(id);
  }
  // /me reserve ainda pending — reservedOpen seria 0 no código antigo
  const meId = trackPoolAcquisitionStart("reserve", "auth/me");
  const snap = getPoolDiagSnapshot(5);
  assert.equal(snap.trackedActive, 5);
  assert.equal(snap.trackedPending, 1);
  assert.equal(snap.activeAcquisitions.find((a) => a.status === "pending")?.kind, "reserve");
  trackPoolAcquisitionReleased(meId);
  console.log("[TEST] reservedOpen=0 while reserve pending explained: OK");
}

async function main() {
  await testFiveReservesBlockSixth();
  await testLateTimeoutReleaseOnce();
  await testBeginWithoutFinallyLeak();
  await testWorkerHoldingConnection();
  await testReleaseAfterErrorAbort();
  await testReservedOpenZeroWhilePendingExplained();
  console.log("[TEST] all pool diag checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
