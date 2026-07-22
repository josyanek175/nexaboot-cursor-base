/**
 * Testes da resposta HTTP do tick de campanhas.
 * Uso: npx tsx scripts/test-campaign-worker-tick-response.mjs
 */
import { mapCampaignWorkerTickResponse } from "../src/lib/campaign-worker-tick-response.ts";

let failed = 0;

function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

const idle = mapCampaignWorkerTickResponse({
  ok: true,
  action: "idle",
  delayMs: 5000,
  message: "Nenhuma campanha devida",
});
assert("idle success", idle.success === true);
assert("idle processed 0", idle.processed === 0);
assert("idle reason", idle.reason === "nothing_to_process");
assert("idle preserves ok", idle.ok === true);
assert("idle preserves delayMs", idle.delayMs === 5000);

const sent = mapCampaignWorkerTickResponse({
  ok: true,
  action: "sent",
  delayMs: 200,
  campaignId: "camp-1",
  contactId: "contact-1",
});
assert("sent processed 1", sent.processed === 1);
assert("sent count 1", sent.sent === 1);
assert("sent failed 0", sent.failed === 0);
assert("sent campaignId", sent.campaignId === "camp-1");

console.log(
  failed === 0
    ? "\nAll campaign worker tick response tests passed."
    : `\n${failed} test(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
