/**
 * Simula vários ticks consecutivos (3 contatos) — lógica pura, sem DB.
 * Uso: npx tsx scripts/test-campaign-worker-multi-tick.mjs
 */
import {
  claimNextPendingContactSim,
  releaseStaleProcessingContactsSim,
  simulateMultiTickRun,
  simulateWorkerTick,
} from "../src/lib/campaign-worker-contact-state.ts";

let failed = 0;

function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

// 3 contatos — 3 ticks enviam 3 contatos
{
  const { sentIds, campaign } = simulateMultiTickRun({
    contactCount: 3,
    messagePauseMs: 50,
  });
  assert("three contacts sent", sentIds.length === 3);
  assert("unique sends", new Set(sentIds).size === 3);
  assert("campaign completed", campaign.status === "completed");
  assert("order c1", sentIds[0] === "c1");
  assert("order c3", sentIds[2] === "c3");
}

// contato preso em processing bloqueia quando é o único restante
{
  const campaign = {
    id: "camp-stuck",
    status: "running",
    contacts: [
      { id: "c1", status: "sent", provider_message_id: "w1", updated_at_ms: 0 },
      { id: "c2", status: "processing", provider_message_id: null, updated_at_ms: 0 },
    ],
  };

  const blocked = simulateWorkerTick(campaign, { staleMs: 0 });
  assert("stuck processing blocks", blocked.action === "idle");
  assert("blocked reason", blocked.reason === "processing_blocked");

  releaseStaleProcessingContactsSim(campaign.contacts, 60_000, 1);
  assert("stale release frees c2", campaign.contacts[1].status === "pending");

  const next = simulateWorkerTick(campaign, { messagePauseMs: 10 });
  assert("after release sends c2", next.action === "sent" && next.contactId === "c2");
}

// pending seguinte não é bloqueado por processing em outro contato
{
  const campaign = {
    id: "camp-next",
    status: "running",
    contacts: [
      { id: "c1", status: "sent", provider_message_id: "w1", updated_at_ms: 0 },
      { id: "c2", status: "processing", provider_message_id: null, updated_at_ms: 0 },
      { id: "c3", status: "pending", provider_message_id: null, updated_at_ms: 0 },
    ],
  };
  const tick = simulateWorkerTick(campaign, { staleMs: 0, messagePauseMs: 10 });
  assert("pending c3 sends while c2 processing", tick.action === "sent" && tick.contactId === "c3");
}

// claim atômico — um contato por tick
{
  const contacts = [
    { id: "a", status: "pending", provider_message_id: null, updated_at_ms: 0 },
    { id: "b", status: "pending", provider_message_id: null, updated_at_ms: 0 },
  ];
  const first = claimNextPendingContactSim(contacts);
  const second = claimNextPendingContactSim(contacts);
  assert("first claim", first?.id === "a");
  assert("second claim different", second?.id === "b");
  assert("no duplicate claim", first?.id !== second?.id);
}

// pausa simulada entre ticks (delayMs respeitado na simulação)
{
  const { ticks } = simulateMultiTickRun({ contactCount: 2, messagePauseMs: 4_000 });
  assert("two ticks for two contacts", ticks.filter((t) => t.action === "sent").length === 2);
  assert("delay between sends", ticks[0].action === "sent" && ticks[0].delayMs === 4_000);
}

console.log(
  failed === 0
    ? "\nAll campaign worker multi-tick tests passed."
    : `\n${failed} test(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
