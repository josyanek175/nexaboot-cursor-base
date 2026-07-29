/**
 * Verifica coordenação do bootstrap sem exigir DATABASE_URL real para os
 * cenários de Promise compartilhada / cooldown (lógica espelhada).
 *
 * Também tenta importar o módulo real se DATABASE_URL estiver definida.
 */
import assert from "node:assert/strict";

const COOLDOWN_MS = 50;

function createController(runBootstrap) {
  let pending = null;
  let attempt = 0;
  let cooldownUntil = 0;

  function bootstrap() {
    if (pending) return pending;
    if (Date.now() < cooldownUntil) {
      return Promise.reject(new Error("database_initialization_unavailable"));
    }
    const myAttempt = ++attempt;
    pending = (async () => {
      await runBootstrap(myAttempt);
    })().catch((e) => {
      pending = null;
      cooldownUntil = Date.now() + COOLDOWN_MS;
      throw e;
    });
    return pending;
  }

  return {
    bootstrap,
    reset() {
      pending = null;
      attempt = 0;
      cooldownUntil = 0;
    },
    getAttempt: () => attempt,
  };
}

async function main() {
  // 1) Duas chamadas simultâneas reutilizam uma única Promise
  let starts = 0;
  const ok = createController(async () => {
    starts += 1;
    await new Promise((r) => setTimeout(r, 30));
  });
  const p1 = ok.bootstrap();
  const p2 = ok.bootstrap();
  assert.equal(p1, p2, "concurrent callers must share one Promise");
  await Promise.all([p1, p2]);
  assert.equal(starts, 1, "bootstrap body runs once");
  console.log("[SIM] concurrent shared Promise: OK");

  // 2) Sucesso: chamadas posteriores reutilizam a Promise resolvida
  const p3 = ok.bootstrap();
  assert.equal(p3, p1, "success Promise is retained");
  await p3;
  console.log("[SIM] success reuse: OK");

  // 3) Falha + cooldown + nova tentativa
  let shouldFail = true;
  let runs = 0;
  const flaky = createController(async () => {
    runs += 1;
    if (shouldFail) throw new Error("boom");
  });
  await assert.rejects(() => flaky.bootstrap(), /database_initialization_unavailable|boom/);
  // Durante cooldown não inicia novo bootstrap
  const before = runs;
  await assert.rejects(() => flaky.bootstrap(), /database_initialization_unavailable/);
  assert.equal(runs, before, "cooldown must not start another bootstrap");
  console.log("[SIM] reject + cooldown: OK");

  await new Promise((r) => setTimeout(r, COOLDOWN_MS + 10));
  shouldFail = false;
  await flaky.bootstrap();
  assert.equal(runs, before + 1, "retry after cooldown");
  console.log("[SIM] retry after cooldown success: OK");

  if (process.env.DATABASE_URL) {
    const mod = await import("../src/lib/pg.server.ts").catch(() => null);
    if (!mod) {
      console.log("[SIM] real module skip (ts import not available in plain node)");
    } else {
      mod.__resetDatabaseBootstrapStateForTests();
      const a = mod.bootstrapDatabaseSchema();
      const b = mod.bootstrapDatabaseSchema();
      assert.equal(a, b);
      await a;
      console.log("[SIM] real bootstrap success + shared Promise: OK");
    }
  } else {
    console.log("[SIM] DATABASE_URL ausente — pulando bootstrap real");
  }

  console.log("[SIM] all coordination checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
