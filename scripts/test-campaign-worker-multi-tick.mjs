/**
 * Simula vários ticks consecutivos (3 contatos) — lógica pura, sem DB.
 * Uso: npx tsx scripts/test-campaign-worker-multi-tick.mjs
 */
import {
  applyClassifiedContactError,
  claimNextPendingContactSim,
  DEFAULT_PROCESSING_STALE_MS,
  makeSimContacts,
  releaseStaleProcessingContactsSim,
  simulateConcurrentWorkersRecent,
  simulateStaleRecoveryAfterAbandonedClaim,
  simulateMultiTickRun,
  simulateWorkerTick,
  TRANSIENT_RETRY_DELAY_MS,
} from "../src/lib/campaign-worker-contact-state.ts";
import {
  classifyCampaignSendError,
  oldestProcessingAgeMs,
  readProcessingStaleMs,
} from "../src/lib/campaign-worker-processing.ts";

let failed = 0;

function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

// fluxo normal — 3 contatos, stale desabilitado (não depende de recuperação)
{
  const { sentIds, campaign, ticks } = simulateMultiTickRun({
    contactCount: 3,
    messagePauseMs: 50,
    staleMs: 0,
  });
  assert("normal three contacts sent", sentIds.length === 3);
  assert("normal unique sends", new Set(sentIds).size === 3);
  assert("normal campaign completed", campaign.status === "completed");
  assert("normal tick4 completed", ticks[3]?.action === "completed");
}

// processing recente NÃO é recuperado (< 120s)
{
  const contacts = makeSimContacts(1);
  claimNextPendingContactSim(contacts, "worker-a", 0);
  contacts[0].processing_started_at_ms = 0;
  const released = releaseStaleProcessingContactsSim(contacts, 60_000, DEFAULT_PROCESSING_STALE_MS);
  assert("recent processing not released", released === 0);
  assert("recent stays processing", contacts[0].status === "processing");
}

// processing antigo É recuperado (>= 120s)
{
  const contacts = makeSimContacts(1);
  claimNextPendingContactSim(contacts, "worker-a", 0);
  contacts[0].processing_started_at_ms = 0;
  const released = releaseStaleProcessingContactsSim(
    contacts,
    DEFAULT_PROCESSING_STALE_MS + 1,
    DEFAULT_PROCESSING_STALE_MS,
  );
  assert("stale processing released", released === 1);
  assert("stale back to pending", contacts[0].status === "pending");
}

// dois workers — B não claima nem recupera enquanto A envia
{
  const run = simulateConcurrentWorkersRecent();
  assert("worker B no claim during A send", run.workerBClaimWhileSending === null);
  assert("worker B no stale while A sending", run.workerBStaleWhileSending === 0);
  assert("A completes single send", run.sendCount === 1);
  assert("final status sent", run.finalStatus === "sent");
}

// reserva abandonada — após stale, B recupera e envia uma vez
{
  const run = simulateStaleRecoveryAfterAbandonedClaim();
  assert("abandoned claim released after stale", run.released === 1);
  assert("worker B claims after stale", run.workerBClaim?.id === "c1");
  assert("stale recovery single send", run.sendCount === 1);
  assert("stale recovery final sent", run.finalStatus === "sent");
}

// pending seguinte não bloqueado por processing recente em outro contato
{
  const campaign = {
    id: "camp-next",
    status: "running",
    contacts: [
      {
        id: "c1",
        status: "sent",
        provider_message_id: "w1",
        processing_started_at_ms: null,
        locked_by: null,
        attempts: 0,
        error_code: null,
        error_message: null,
      },
      {
        id: "c2",
        status: "processing",
        provider_message_id: null,
        processing_started_at_ms: 1_000,
        locked_by: "worker-a",
        attempts: 0,
        error_code: null,
        error_message: null,
      },
      {
        id: "c3",
        status: "pending",
        provider_message_id: null,
        processing_started_at_ms: null,
        locked_by: null,
        attempts: 0,
        error_code: null,
        error_message: null,
      },
    ],
  };
  const tick = simulateWorkerTick(campaign, { nowMs: 5_000, staleMs: 0, messagePauseMs: 10 });
  assert("c3 sends while c2 processing recent", tick.action === "sent" && tick.contactId === "c3");
}

// erro transitório → pending retry
{
  const contacts = makeSimContacts(1);
  claimNextPendingContactSim(contacts, "worker-a", 0);
  const outcome = applyClassifiedContactError(
    contacts[0],
    classifyCampaignSendError("meta_fetch_failed"),
  );
  assert("transient retry_pending", outcome === "retry_pending");
  assert("transient status pending", contacts[0].status === "pending");
  assert("transient attempts 1", contacts[0].attempts === 1);
}

// erro definitivo → failed
{
  const contacts = makeSimContacts(1);
  claimNextPendingContactSim(contacts, "worker-a", 0);
  const outcome = applyClassifiedContactError(
    contacts[0],
    classifyCampaignSendError("invalid_recipient_phone"),
  );
  assert("definitive failed", outcome === "failed");
  assert("definitive status failed", contacts[0].status === "failed");
}

// erro transitório excede max_attempts → failed
{
  const contacts = makeSimContacts(1);
  contacts[0].status = "processing";
  contacts[0].attempts = 2;
  const outcome = applyClassifiedContactError(
    contacts[0],
    classifyCampaignSendError("meta_fetch_failed"),
    3,
  );
  assert("transient max attempts failed", outcome === "failed");
}

// tick simulado com erro transitório retorna delay de retry
{
  const campaign = {
    id: "camp-retry",
    status: "running",
    contacts: makeSimContacts(1),
  };
  const tick = simulateWorkerTick(campaign, {
    sendError: "meta_fetch_failed",
  });
  assert("sim transient failed action", tick.action === "failed");
  assert("sim transient retry delay", tick.delayMs === TRANSIENT_RETRY_DELAY_MS);
}

// stale env default mínimo 120s
{
  assert("default stale ms", readProcessingStaleMs({}) === DEFAULT_PROCESSING_STALE_MS);
  assert(
    "invalid stale falls back",
    readProcessingStaleMs({ CAMPAIGN_PROCESSING_STALE_MS: "1000" }) === DEFAULT_PROCESSING_STALE_MS,
  );
  assert(
    "custom stale respected",
    readProcessingStaleMs({ CAMPAIGN_PROCESSING_STALE_MS: "180000" }) === 180_000,
  );
}

// oldest processing age helper
{
  const age = oldestProcessingAgeMs(
    [
      { status: "processing", processing_started_at_ms: 1_000 },
      { status: "processing", processing_started_at_ms: 500 },
    ],
    2_500,
  );
  assert("oldest age ms", age === 2_000);
}

// claim atômico — um contato por tick
{
  const contacts = makeSimContacts(2);
  const first = claimNextPendingContactSim(contacts);
  const second = claimNextPendingContactSim(contacts);
  assert("first claim a", first?.id === "c1");
  assert("second claim b", second?.id === "c2");
}

console.log(
  failed === 0
    ? "\nAll campaign worker multi-tick tests passed."
    : `\n${failed} test(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
