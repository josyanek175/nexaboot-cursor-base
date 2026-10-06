/**
 * Testes das métricas de Resultados e Tempo de espera.
 * Uso: npx tsx scripts/test-campaign-results-wait.mjs
 */
import {
  averageSeconds,
  formatDurationSeconds,
  ratePercent,
} from "../src/lib/campaign-metrics.ts";

let failed = 0;
function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

assert("rate 0 when no sends", ratePercent(5, 0) === 0);
assert("rate 50%", ratePercent(50, 100) === 50);
assert("rate 12.5%", ratePercent(1, 8) === 12.5);
assert("rate rounds 1 decimal", ratePercent(1, 3) === 33.3);

assert("avg null empty", averageSeconds(100, 0) === null);
assert("avg 90s", averageSeconds(180, 2) === 90);

assert("fmt null", formatDurationSeconds(null) === "—");
assert("fmt seconds", formatDurationSeconds(9) === "9s");
assert("fmt minutes", formatDurationSeconds(125) === "2 min 05s");
assert("fmt hours", formatDurationSeconds(3661) === "1h 01min");

if (failed > 0) {
  console.error(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log("\nTodos os testes de resultados/espera passaram.");
