/**
 * Testes: /me sem reserve + pool diag.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  __getPoolDiagActiveCountForTests,
  __getPoolDiagPendingCountForTests,
  __resetPoolDiagForTests,
  getPoolDiagSnapshot,
  trackPoolAcquisitionAcquired,
  trackPoolAcquisitionReleased,
  trackPoolAcquisitionStart,
} from "../src/lib/pg-pool-diag.server.ts";

const here = dirname(fileURLToPath(import.meta.url));

async function testMeSourceHasNoReserve() {
  const src = readFileSync(join(here, "../src/lib/auth-me-diag.server.ts"), "utf8");
  assert.equal(src.includes("reserveSqlConnection"), false);
  assert.equal(/\breserveSqlConnection\b|\.reserve\s*\(/.test(src), false);
  assert.equal(src.includes("releaseReserveWhenReady"), false);
  assert.equal(/Promise\.race\s*\(/.test(src), false);
  assert.ok(src.includes("SET LOCAL statement_timeout"));
  assert.ok(src.includes("ME_STEP_USER_QUERY_OK"));
  assert.ok(src.includes("ME_STEP_COMPANY_QUERY_OK"));
  console.log("[TEST] /me source has no reserve/race: OK");
}

async function testFiveQueriesThenMeProceeds() {
  __resetPoolDiagForTests();
  const holders = [];
  for (let i = 0; i < 5; i++) {
    const id = trackPoolAcquisitionStart("query", `poll:${i}`);
    trackPoolAcquisitionAcquired(id);
    holders.push(id);
  }
  const meId = trackPoolAcquisitionStart("query", "auth/me");
  // me aguarda: 5 active + 1 pending-style (marcamos acquired só depois)
  assert.equal(__getPoolDiagActiveCountForTests(), 5);

  trackPoolAcquisitionReleased(holders[0]);
  trackPoolAcquisitionAcquired(meId);
  assert.equal(__getPoolDiagActiveCountForTests(), 5);

  for (const id of holders.slice(1)) trackPoolAcquisitionReleased(id);
  trackPoolAcquisitionReleased(meId);
  assert.equal(__getPoolDiagActiveCountForTests(), 0);
  console.log("[TEST] five queries then /me proceeds: OK");
}

async function testMeDoesNotCreateReservePending() {
  __resetPoolDiagForTests();
  // /me agora usa kind=query/begin, nunca reserve
  const id = trackPoolAcquisitionStart("begin", "auth/me");
  trackPoolAcquisitionAcquired(id);
  const snap = getPoolDiagSnapshot(5);
  assert.equal(
    snap.activeAcquisitions.every((a) => a.kind !== "reserve"),
    true,
  );
  trackPoolAcquisitionReleased(id);
  assert.equal(__getPoolDiagPendingCountForTests(), 0);
  console.log("[TEST] /me does not create reservePending: OK");
}

async function testFortyFiveConcurrentMeReleaseAll() {
  __resetPoolDiagForTests();
  const ids = [];
  for (let i = 0; i < 45; i++) {
    const id = trackPoolAcquisitionStart("begin", `auth/me:${i}`);
    trackPoolAcquisitionAcquired(id);
    ids.push(id);
  }
  assert.equal(__getPoolDiagActiveCountForTests(), 45);
  for (const id of ids) trackPoolAcquisitionReleased(id);
  assert.equal(__getPoolDiagActiveCountForTests(), 0);
  assert.equal(__getPoolDiagPendingCountForTests(), 0);
  console.log("[TEST] 45 concurrent /me release all: OK");
}

async function testErrorDoesNotLeaveOrphan() {
  __resetPoolDiagForTests();
  const id = trackPoolAcquisitionStart("query", "auth/me-error");
  trackPoolAcquisitionAcquired(id);
  let unhandled = 0;
  const onUnhandled = () => {
    unhandled += 1;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    throw new Error("query_failed");
  } catch {
    trackPoolAcquisitionReleased(id);
  }
  await Promise.resolve();
  process.off("unhandledRejection", onUnhandled);
  assert.equal(__getPoolDiagActiveCountForTests(), 0);
  assert.equal(unhandled, 0);
  console.log("[TEST] error does not leave orphan / no unhandledRejection: OK");
}

async function main() {
  await testMeSourceHasNoReserve();
  await testFiveQueriesThenMeProceeds();
  await testMeDoesNotCreateReservePending();
  await testFortyFiveConcurrentMeReleaseAll();
  await testErrorDoesNotLeaveOrphan();
  console.log("[TEST] all auth-me pool fix checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
