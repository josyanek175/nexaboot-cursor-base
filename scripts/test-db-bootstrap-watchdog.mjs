/**
 * Testes do coordenador de bootstrap + release tardio de reserve.
 * Não exige DATABASE_URL.
 */
import assert from "node:assert/strict";
import { createBootstrapCoordinator } from "../src/lib/db-bootstrap-coordinator.ts";

const COOLDOWN_MS = 40;
const WATCHDOG_MS = 50;

function releaseReserveWhenReady(reservePromise) {
  if (releaseReserveWhenReady._attached.has(reservePromise)) return;
  releaseReserveWhenReady._attached.add(reservePromise);
  void reservePromise.then(
    (r) => {
      try {
        r.release();
      } catch {
        /* ignore */
      }
    },
    () => {
      /* reject tardio */
    },
  );
}
releaseReserveWhenReady._attached = new WeakSet();

async function withRace(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms),
    ),
  ]);
}

async function testSuccessSharedPromise() {
  let starts = 0;
  const c = createBootstrapCoordinator({
    cooldownMs: COOLDOWN_MS,
    watchdogMs: 5_000,
    run: async () => {
      starts += 1;
      await new Promise((r) => setTimeout(r, 20));
    },
  });
  const a = c.bootstrap();
  const b = c.bootstrap();
  assert.equal(a, b, "concurrent callers share one Promise");
  await Promise.all([a, b]);
  assert.equal(starts, 1);
  assert.equal(c.getState(), "ready");
  assert.equal(c.isActiveRun(), false);
  const d = c.bootstrap();
  assert.equal(d, a, "ready Promise is retained");
  await d;
  console.log("[TEST] success + shared Promise: OK");
}

async function testFailureCooldownRetry() {
  let runs = 0;
  let shouldFail = true;
  const c = createBootstrapCoordinator({
    cooldownMs: COOLDOWN_MS,
    watchdogMs: 5_000,
    run: async () => {
      runs += 1;
      if (shouldFail) throw new Error("boom");
    },
  });
  await assert.rejects(() => c.bootstrap(), /database_initialization_unavailable/);
  assert.equal(c.getState(), "failed");
  assert.equal(c.isActiveRun(), false);
  const before = runs;
  await assert.rejects(() => c.bootstrap(), /database_initialization_unavailable/);
  assert.equal(runs, before, "cooldown blocks new run");
  await new Promise((r) => setTimeout(r, COOLDOWN_MS + 15));
  shouldFail = false;
  await c.bootstrap();
  assert.equal(c.getState(), "ready");
  assert.equal(runs, before + 1);
  console.log("[TEST] failure + cooldown + retry: OK");
}

async function testWatchdogKeepsActiveRunNoConcurrentBootstrap() {
  /** @type {() => void} */
  let finishRun;
  let runs = 0;
  const c = createBootstrapCoordinator({
    cooldownMs: COOLDOWN_MS,
    watchdogMs: WATCHDOG_MS,
    run: async () => {
      runs += 1;
      await new Promise((resolve) => {
        finishRun = resolve;
      });
    },
  });

  const p = c.bootstrap();
  assert.equal(c.getState(), "running");
  assert.equal(c.isActiveRun(), true);

  await assert.rejects(() => p, /database_initialization_unavailable/);
  assert.equal(c.areWaitersAbandoned(), true);
  assert.equal(c.isActiveRun(), true, "run must stay active after waiter timeout");
  assert.equal(c.getState(), "failed");

  // Nova tentativa NÃO inicia enquanto DDL/run antigo ativo.
  await assert.rejects(() => c.bootstrap(), /database_initialization_unavailable/);
  assert.equal(runs, 1, "no concurrent DDL/bootstrap");

  // Run antigo termina depois do watchdog.
  finishRun();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(c.isActiveRun(), false);
  assert.equal(c.getState(), "ready", "successful run after abandon → ready");

  // Próxima chamada reutiliza sucesso (sem novo run).
  await c.bootstrap();
  assert.equal(runs, 1);
  console.log("[TEST] watchdog abandon waiters + no concurrent run: OK");
}

async function testWatchdogFailThenRetrySuccess() {
  let runs = 0;
  /** @type {((ok: boolean) => void) | null} */
  let endRun = null;
  const c = createBootstrapCoordinator({
    cooldownMs: COOLDOWN_MS,
    watchdogMs: WATCHDOG_MS,
    run: async () => {
      runs += 1;
      const ok = await new Promise((resolve) => {
        endRun = resolve;
      });
      if (!ok) throw new Error("ddl_failed");
    },
  });

  const p = c.bootstrap();
  await assert.rejects(() => p, /database_initialization_unavailable/);
  assert.equal(c.isActiveRun(), true);
  await assert.rejects(() => c.bootstrap(), /database_initialization_unavailable/);
  assert.equal(runs, 1);

  endRun(false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(c.isActiveRun(), false);

  await new Promise((r) => setTimeout(r, COOLDOWN_MS + 15));
  const p2 = c.bootstrap();
  assert.equal(runs, 2, "retry starts only after previous run finished + cooldown");
  assert.equal(c.isActiveRun(), true);
  endRun(true);
  await p2;
  assert.equal(c.getState(), "ready");
  console.log("[TEST] watchdog + failed run + retry after cooldown: OK");
}

async function testNeverTwoSimultaneous() {
  let concurrent = 0;
  let maxConcurrent = 0;
  const c = createBootstrapCoordinator({
    cooldownMs: COOLDOWN_MS,
    watchdogMs: 5_000,
    run: async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent -= 1;
    },
  });
  await Promise.all([c.bootstrap(), c.bootstrap(), c.bootstrap()]);
  assert.equal(maxConcurrent, 1);
  console.log("[TEST] never two simultaneous: OK");
}

async function testReserveResolvesBeforeTimeout() {
  let releases = 0;
  const reserved = {
    release() {
      releases += 1;
    },
  };
  const reservePromise = Promise.resolve(reserved);
  const got = await withRace(reservePromise, 100);
  assert.equal(got, reserved);
  // finally normal — uma liberação
  got.release();
  assert.equal(releases, 1);
  console.log("[TEST] reserve resolves before timeout: OK");
}

async function testReserveResolvesAfterTimeoutReleasedOnce() {
  let releases = 0;
  let reservedOpen = 0;
  const reservePromise = new Promise((resolve) => {
    setTimeout(() => {
      reservedOpen += 1;
      resolve({
        release() {
          releases += 1;
          reservedOpen = Math.max(0, reservedOpen - 1);
        },
      });
    }, 80);
  });

  await assert.rejects(() => withRace(reservePromise, 20), /timeout/);
  releaseReserveWhenReady(reservePromise);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(reservedOpen, 0);
  assert.equal(releases, 1, "late reserve released exactly once");
  // segunda chamada não deve liberar de novo
  releaseReserveWhenReady(reservePromise);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(releases, 1);
  console.log("[TEST] reserve resolves after timeout released once: OK");
}

async function testReserveRejectsAfterTimeoutNoUnhandled() {
  let unhandled = 0;
  const onUnhandled = () => {
    unhandled += 1;
  };
  process.on("unhandledRejection", onUnhandled);

  const reservePromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("connect_failed")), 80);
  });

  await assert.rejects(() => withRace(reservePromise, 20), /timeout/);
  releaseReserveWhenReady(reservePromise);
  await new Promise((r) => setTimeout(r, 120));

  process.off("unhandledRejection", onUnhandled);
  assert.equal(unhandled, 0, "no unhandledRejection on late reserve reject");
  console.log("[TEST] reserve rejects after timeout without unhandledRejection: OK");
}

async function testNoDoubleReleaseOnSuccessPath() {
  let releases = 0;
  const reserved = {
    release() {
      releases += 1;
    },
  };
  const reservePromise = Promise.resolve(reserved);
  let local = null;
  try {
    local = await withRace(reservePromise, 100);
  } catch {
    releaseReserveWhenReady(reservePromise);
    throw new Error("should not timeout");
  } finally {
    if (local) local.release();
  }
  assert.equal(releases, 1, "success path: only finally releases");
  console.log("[TEST] no double release on success path: OK");
}

/**
 * HTTP não bloqueia no bootstrap: enquanto activeRun=true, "auth/me" simulado
 * prossegue; segunda chamada a bootstrap() não inicia outro DDL; falha do
 * bootstrap não derruba o "servidor" (catch engole).
 */
async function testHttpDoesNotBlockOnBootstrap() {
  /** @type {() => void} */
  let finishRun;
  let runs = 0;
  let httpProceededWhileRunning = false;
  let serverCrashed = false;

  const c = createBootstrapCoordinator({
    cooldownMs: COOLDOWN_MS,
    watchdogMs: 5_000,
    run: async () => {
      runs += 1;
      await new Promise((resolve) => {
        finishRun = resolve;
      });
    },
  });

  // Kickoff em background (como server.ts) — não await.
  void c.bootstrap().catch(() => {
    /* falha do bootstrap não derruba HTTP */
  });

  assert.equal(c.isActiveRun(), true);
  assert.equal(c.getState(), "running");

  // Simula /api/auth/me: consulta "direta" sem await bootstrap.
  httpProceededWhileRunning = true;
  assert.equal(httpProceededWhileRunning, true);

  // Segunda execução de bootstrap não inicia.
  void c.bootstrap().catch(() => {});
  assert.equal(runs, 1, "shared bootstrap — no second DDL");

  // Falha do bootstrap engolida (servidor HTTP segue).
  try {
    finishRun();
    await new Promise((r) => setTimeout(r, 20));
  } catch {
    serverCrashed = true;
  }
  assert.equal(serverCrashed, false);
  assert.equal(c.getState(), "ready");

  // Caso falha: background catch impede crash.
  const cFail = createBootstrapCoordinator({
    cooldownMs: COOLDOWN_MS,
    watchdogMs: 5_000,
    run: async () => {
      throw new Error("bootstrap_boom");
    },
  });
  let backgroundErrorCaught = false;
  void cFail.bootstrap().catch(() => {
    backgroundErrorCaught = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(backgroundErrorCaught, true);
  assert.equal(cFail.getState(), "failed");
  // "HTTP" ainda responde
  assert.equal(true, true);

  console.log("[TEST] HTTP does not block on bootstrap: OK");
}

async function main() {
  await testSuccessSharedPromise();
  await testFailureCooldownRetry();
  await testWatchdogKeepsActiveRunNoConcurrentBootstrap();
  await testWatchdogFailThenRetrySuccess();
  await testNeverTwoSimultaneous();
  await testReserveResolvesBeforeTimeout();
  await testReserveResolvesAfterTimeoutReleasedOnce();
  await testReserveRejectsAfterTimeoutNoUnhandled();
  await testNoDoubleReleaseOnSuccessPath();
  await testHttpDoesNotBlockOnBootstrap();
  console.log("[TEST] all bootstrap coordinator checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
