/**
 * Testes das regras de controle manual de campanhas.
 * Uso: npx tsx scripts/test-campaign-manual-start.mjs
 */
import {
  isCampaignManualPauseAllowed,
  isCampaignManualResumeAllowed,
  isCampaignManualStartAllowed,
  MANUAL_PAUSED_STATUS,
  shouldShowManualStartButton,
} from "../src/lib/campaign-manual-control.ts";

let failed = 0;

function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

assert("draft start allowed", isCampaignManualStartAllowed("draft"));
assert("scheduled start allowed", isCampaignManualStartAllowed("scheduled"));
assert("paused start allowed", isCampaignManualStartAllowed("paused"));
assert("manual_paused start allowed", isCampaignManualStartAllowed(MANUAL_PAUSED_STATUS));
assert("running start blocked", !isCampaignManualStartAllowed("running"));
assert("completed start blocked", !isCampaignManualStartAllowed("completed"));

assert("running pause allowed", isCampaignManualPauseAllowed("running"));
assert("scheduled pause allowed", isCampaignManualPauseAllowed("scheduled"));
assert("draft pause blocked", !isCampaignManualPauseAllowed("draft"));

assert("paused resume allowed", isCampaignManualResumeAllowed("paused"));
assert("manual_paused resume allowed", isCampaignManualResumeAllowed(MANUAL_PAUSED_STATUS));
assert("running resume blocked", !isCampaignManualResumeAllowed("running"));

assert(
  "show start with pending",
  shouldShowManualStartButton({
    status: "scheduled",
    pendingCount: 3,
    channelUnavailable: false,
    hasMetaTemplate: true,
    isMetaChannel: true,
    hasMessage: false,
  }),
);

assert(
  "hide start without pending",
  !shouldShowManualStartButton({
    status: "scheduled",
    pendingCount: 0,
    channelUnavailable: false,
    hasMetaTemplate: true,
    isMetaChannel: true,
    hasMessage: false,
  }),
);

assert(
  "hide start when completed",
  !shouldShowManualStartButton({
    status: "completed",
    pendingCount: 5,
    channelUnavailable: false,
    hasMetaTemplate: true,
    isMetaChannel: true,
    hasMessage: false,
  }),
);

assert(
  "hide start meta without template",
  !shouldShowManualStartButton({
    status: "draft",
    pendingCount: 2,
    channelUnavailable: false,
    hasMetaTemplate: false,
    isMetaChannel: true,
    hasMessage: false,
  }),
);

assert(
  "hide start inactive channel",
  !shouldShowManualStartButton({
    status: "draft",
    pendingCount: 2,
    channelUnavailable: true,
    hasMetaTemplate: true,
    isMetaChannel: true,
    hasMessage: false,
  }),
);

console.log(
  failed === 0
    ? "\nAll campaign manual control tests passed."
    : `\n${failed} test(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
