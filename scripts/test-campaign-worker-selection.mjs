/**
 * Testes de seleção multi-campanha — evita starvation por janela/pausa.
 * Uso: npx tsx scripts/test-campaign-worker-selection.mjs
 */
import {
  aggregateIdleTickDelay,
  evaluateCampaignSkipReason,
  makeMultiSimCampaign,
  MANUAL_PAUSED_STATUS,
  simulateMultiCampaignRun,
  simulateMultiCampaignWorkerTick,
  sortCampaignCandidates,
} from "../src/lib/campaign-worker-selection.ts";

let failed = 0;

function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

// Dentro da janela 08:00–18:00 (meio-dia local).
const noon = new Date(2026, 6, 23, 12, 0, 0, 0);
// Fora da janela (20:00 local).
const evening = new Date(2026, 6, 23, 20, 0, 0, 0);

// A fora da janela, B running com janela mais ampla e 2 pending → tick envia B
{
  const campaigns = [
    makeMultiSimCampaign("A", 1, {
      status: "paused",
      order: 0,
      windowStart: "08:00",
      windowEnd: "18:00",
    }),
    makeMultiSimCampaign("B", 2, {
      status: "running",
      order: 1,
      windowStart: "08:00",
      windowEnd: "22:00",
    }),
  ];

  const tick1 = simulateMultiCampaignWorkerTick(campaigns, { now: evening, messagePauseMs: 100 });
  assert("starvation tick1 sent B", tick1.action === "sent" && tick1.campaignId === "B");
  assert("starvation tick1 not paused", tick1.action !== "paused");
  assert("starvation tick1 delay from B", tick1.action === "sent" && tick1.delayMs === 100);
  assert("starvation A stays paused", campaigns[0].status === "paused");

  const tick2 = simulateMultiCampaignWorkerTick(campaigns, {
    now: new Date(evening.getTime() + 100),
    messagePauseMs: 100,
  });
  assert("starvation tick2 sent B again", tick2.action === "sent" && tick2.campaignId === "B");
  assert("starvation B two sends total", campaigns[1].contacts.filter((c) => c.status === "sent").length === 2);
}

// Duas campanhas fora da janela → paused com wakeup (sem envio)
{
  const campaigns = [
    makeMultiSimCampaign("A", 2, { status: "running", order: 0 }),
    makeMultiSimCampaign("B", 2, { status: "running", order: 1 }),
  ];
  const tick = simulateMultiCampaignWorkerTick(campaigns, { now: evening });
  assert("both outside window paused", tick.action === "paused");
  assert("both outside window delay capped", tick.action === "paused" && tick.delayMs <= 60_000);
  assert("both outside window no send", campaigns.every((c) => c.contacts.every((x) => x.status === "pending")));
}

// Completed antes de running → running ainda processada no mesmo tick
{
  const campaigns = [
    {
      ...makeMultiSimCampaign("A", 0, { status: "running", order: 0 }),
      contacts: [],
    },
    makeMultiSimCampaign("B", 2, { status: "running", order: 1 }),
  ];
  const tick = simulateMultiCampaignWorkerTick(campaigns, { now: noon, messagePauseMs: 50 });
  assert("completed then running sends B", tick.action === "sent" && tick.campaignId === "B");
  assert("A marked completed", campaigns[0].status === "completed");
}

// Sem pending antes de com pending → segunda processada
{
  const campaigns = [
    {
      ...makeMultiSimCampaign("A", 0, { status: "running", order: 0 }),
      contacts: [],
    },
    makeMultiSimCampaign("B", 3, { status: "running", order: 1 }),
  ];
  const { sentByCampaign } = simulateMultiCampaignRun({
    campaigns,
    now: noon,
    messagePauseMs: 50,
    maxTicks: 5,
  });
  assert("no pending skip then B sends", (sentByCampaign.B?.length ?? 0) === 3);
  assert("A completed in run", campaigns[0].status === "completed");
}

// manual_paused ignorada; running com pending envia
{
  const campaigns = [
    makeMultiSimCampaign("A", 2, { status: MANUAL_PAUSED_STATUS, order: 0 }),
    makeMultiSimCampaign("B", 1, { status: "running", order: 1 }),
  ];
  const skip = evaluateCampaignSkipReason(
    {
      status: MANUAL_PAUSED_STATUS,
      pendingCount: 2,
      processingCount: 0,
      windowStart: "08:00",
      windowEnd: "18:00",
    },
    noon,
  );
  assert("manual_paused skip reason", skip === "manual_paused");

  const tick = simulateMultiCampaignWorkerTick(campaigns, { now: noon, messagePauseMs: 80 });
  assert("manual_paused skipped B sends", tick.action === "sent" && tick.campaignId === "B");
  assert("manual_paused A untouched", campaigns[0].contacts.every((c) => c.status === "pending"));
}

// running tem prioridade sobre paused na ordenação
{
  const sorted = sortCampaignCandidates([
    { id: "paused", status: "paused", order: 0 },
    { id: "running", status: "running", order: 99 },
  ]);
  assert("running before paused", sorted[0]?.id === "running");
}

// aggregate wakeup usa o menor delay
{
  const delay = aggregateIdleTickDelay([60_000, 15_000, 45_000]);
  assert("aggregate min wakeup", delay === 15_000);
}

// running fora da janela listada antes → continua e envia a running dentro da janela
{
  const campaigns = [
    makeMultiSimCampaign("A", 1, {
      status: "running",
      order: 0,
      windowStart: "08:00",
      windowEnd: "18:00",
    }),
    makeMultiSimCampaign("B", 2, {
      status: "running",
      order: 1,
      windowStart: "08:00",
      windowEnd: "22:00",
    }),
  ];
  const tick = simulateMultiCampaignWorkerTick(campaigns, { now: evening, messagePauseMs: 120 });
  assert("outside first skipped B sent", tick.action === "sent" && tick.campaignId === "B");
  assert("outside first A paused", campaigns[0].status === "paused");
  assert("outside first no global pause", tick.action !== "paused");
}

console.log(
  failed === 0
    ? "\nAll campaign worker selection tests passed."
    : `\n${failed} test(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
