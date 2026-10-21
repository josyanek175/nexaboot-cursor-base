/**
 * Testes da lógica de custos de campanha (fase 1).
 * Uso: npx tsx scripts/test-campaign-costs.mjs
 */
import {
  DEFAULT_CAMPAIGN_COST_PRICES,
  estimateCostBrl,
  normalizeCampaignCostPrices,
  normalizeMetaCostCategory,
  resolveCostPeriod,
  unitPriceForCategory,
} from "../src/lib/campaign-costs.ts";

let failed = 0;

function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

assert("default marketing", DEFAULT_CAMPAIGN_COST_PRICES.marketingBrl === 0.3217);
assert("cat marketing", normalizeMetaCostCategory("MARKETING") === "marketing");
assert("cat utility", normalizeMetaCostCategory("utility") === "utility");
assert("cat auth", normalizeMetaCostCategory("AUTHENTICATION") === "authentication");
assert("cat fallback", normalizeMetaCostCategory(null) === "marketing");

const prices = DEFAULT_CAMPAIGN_COST_PRICES;
assert(
  "unit meta marketing",
  unitPriceForCategory("marketing", prices, "meta") === prices.marketingBrl,
);
assert("unit evolution zero", unitPriceForCategory("marketing", prices, "evolution") === 0);
assert(
  "estimate",
  estimateCostBrl(100, 0.3217) === Math.round(100 * 0.3217 * 100) / 100,
);

const fixed = new Date("2026-10-05T15:00:00.000Z");
const today = resolveCostPeriod({ preset: "today", now: fixed });
assert("today same day", today.from === today.to);

const custom = resolveCostPeriod({
  preset: "custom",
  from: "2026-09-01",
  to: "2026-09-15",
  now: fixed,
});
assert("custom range", custom.from === "2026-09-01" && custom.to === "2026-09-15");

const swapped = resolveCostPeriod({
  from: "2026-09-20",
  to: "2026-09-10",
  now: fixed,
});
assert("swap dates", swapped.from === "2026-09-10" && swapped.to === "2026-09-20");

const norm = normalizeCampaignCostPrices({ marketingBrl: -1, utilityBrl: "x" });
assert("clamp negative", norm.marketingBrl === DEFAULT_CAMPAIGN_COST_PRICES.marketingBrl);

if (failed > 0) {
  console.error(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log("\nTodos os testes de custos passaram.");
