/**
 * Testes: gate de pool, esgotamento, timeout de aquisição e consulta travada.
 * Uso: npx tsx scripts/test-pool-me-resilience.mjs
 * Não exige DATABASE_URL.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  __getPoolGateInUseForTests,
  __getPoolGateWaitingForTests,
  __resetPoolGateForTests,
  acquirePoolGateSlot,
  getPoolGateMax,
  getPoolGateMetrics,
  getWebhookConcurrencyMax,
  isPoolAcquireTimeout,
  PoolAcquireTimeoutError,
  releasePoolGateSlot,
  withPoolGateSlot,
  withWebhookConcurrencyLimit,
} from "../src/lib/pg-pool-gate.server.ts";
import {
  AuthContextTimeoutError,
  ME_POOL_ACQUIRE_TIMEOUT_MS,
  ME_DB_STEP_TIMEOUT_MS,
  authContextTimeoutResponse,
  isAuthContextTimeout,
} from "../src/lib/auth-me-diag.server.ts";

const here = dirname(fileURLToPath(import.meta.url));

function check(label, condition) {
  assert.ok(condition, label);
  console.log(`OK   ${label}`);
}

async function testPoolExhaustedTimesOut() {
  __resetPoolGateForTests();
  const max = getPoolGateMax();
  const holders = [];
  for (let i = 0; i < max; i++) {
    await acquirePoolGateSlot(`hold:${i}`, 1000);
    holders.push(i);
  }
  check("pool cheio", __getPoolGateInUseForTests() === max);

  const t0 = Date.now();
  let err = null;
  try {
    await acquirePoolGateSlot("me-waiter", 80);
  } catch (e) {
    err = e;
  }
  const waited = Date.now() - t0;
  check("timeout de aquisição", isPoolAcquireTimeout(err));
  check("esperou ~timeout", waited >= 70 && waited < 2000);
  check("ainda waiting 0 após timeout", __getPoolGateWaitingForTests() === 0);

  for (const _ of holders) releasePoolGateSlot();
  check("liberou tudo", __getPoolGateInUseForTests() === 0);
  console.log("[TEST] pool exhausted times out: OK");
}

async function testReleaseUnblocksWaiter() {
  __resetPoolGateForTests();
  const max = getPoolGateMax();
  for (let i = 0; i < max; i++) await acquirePoolGateSlot(`h:${i}`, 1000);

  let acquired = false;
  const pending = withPoolGateSlot("waiter", 2000, async () => {
    acquired = true;
    return "ok";
  });

  await new Promise((r) => setTimeout(r, 30));
  check("alguém esperando", __getPoolGateWaitingForTests() === 1);
  releasePoolGateSlot();
  const result = await pending;
  check("waiter desbloqueado", result === "ok" && acquired);

  while (__getPoolGateInUseForTests() > 0) releasePoolGateSlot();
  console.log("[TEST] release unblocks waiter: OK");
}

async function testStuckQueryMapsTo503() {
  const err = new AuthContextTimeoutError("company_query", {
    connectionWaitMs: null,
    queryMs: 5000,
  });
  check("isAuthContextTimeout", isAuthContextTimeout(err));
  const res = authContextTimeoutResponse();
  check("status 503", res.status === 503);
  const body = await res.json();
  check("body auth_context_timeout", body.error === "auth_context_timeout");
  console.log("[TEST] stuck query maps to 503: OK");
}

async function testPoolAcquireMapsToAuthTimeout() {
  const e = new PoolAcquireTimeoutError("auth_me_company", 3000);
  check("pool acquire timeout detectável", isPoolAcquireTimeout(e));
  // auth-me wrappea em AuthContextTimeoutError — contrato do step
  const wrapped = new AuthContextTimeoutError("auth_me_company_pool_wait", {
    connectionWaitMs: e.waitedMs,
    queryMs: null,
  });
  check("step pool_wait", wrapped.step.includes("pool_wait"));
  console.log("[TEST] pool acquire maps to auth timeout step: OK");
}

async function testWebhookConcurrencyCap() {
  __resetPoolGateForTests();
  const max = getWebhookConcurrencyMax();
  const holders = [];
  for (let i = 0; i < max; i++) {
    holders.push(
      withWebhookConcurrencyLimit(`wh:${i}`, 1000, async () => {
        await new Promise((r) => setTimeout(r, 100));
        return i;
      }),
    );
  }
  await new Promise((r) => setTimeout(r, 20));
  const m = getPoolGateMetrics();
  check("webhook no teto", m.webhookActive === max);

  let busy = null;
  try {
    await withWebhookConcurrencyLimit("overflow", 50, async () => "nope");
  } catch (e) {
    busy = e;
  }
  check("webhook overflow timeout", isPoolAcquireTimeout(busy));
  await Promise.all(holders);
  console.log("[TEST] webhook concurrency cap: OK");
}

async function testFinallyReleasesOnThrow() {
  __resetPoolGateForTests();
  try {
    await withPoolGateSlot("boom", 1000, async () => {
      throw new Error("query_stuck_sim");
    });
  } catch {
    /* expected */
  }
  check("finally liberou após throw", __getPoolGateInUseForTests() === 0);
  console.log("[TEST] finally releases on throw: OK");
}

async function testSourceContracts() {
  const meSrc = readFileSync(join(here, "../src/lib/auth-me-diag.server.ts"), "utf8");
  check("me usa gate (não Promise.race)", !/Promise\.race\s*\(/.test(meSrc));
  check("me usa withPoolGateSlot", meSrc.includes("withPoolGateSlot"));
  check("me tem statement_timeout", meSrc.includes("SET LOCAL statement_timeout"));
  check("me acquire timeout constante", meSrc.includes("ME_POOL_ACQUIRE_TIMEOUT_MS"));

  const healthSrc = readFileSync(join(here, "../src/routes/api/health.ts"), "utf8");
  check("health chama probeDatabaseReadiness", healthSrc.includes("probeDatabaseReadiness"));
  check("health pode 503 se !ready", healthSrc.includes("status: ready ? 200 : 503"));

  const pgSrc = readFileSync(join(here, "../src/lib/pg.server.ts"), "utf8");
  check("pg connect_timeout configurado", pgSrc.includes("connect_timeout:"));
  check("pg idle_timeout configurado", pgSrc.includes("idle_timeout:"));
  check("probe SELECT 1", pgSrc.includes("SELECT 1 AS ok"));

  check("ME timeouts sensatos", ME_POOL_ACQUIRE_TIMEOUT_MS === 3000 && ME_DB_STEP_TIMEOUT_MS === 5000);
  console.log("[TEST] source contracts: OK");
}

async function main() {
  await testPoolExhaustedTimesOut();
  await testReleaseUnblocksWaiter();
  await testStuckQueryMapsTo503();
  await testPoolAcquireMapsToAuthTimeout();
  await testWebhookConcurrencyCap();
  await testFinallyReleasesOnThrow();
  await testSourceContracts();
  console.log("\nTodos os checks de resiliência de pool passaram.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
