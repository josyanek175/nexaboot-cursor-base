/**
 * Testes determinísticos da janela de campanha em America/Sao_Paulo.
 * Uso: npx tsx scripts/test-campaign-send-window-timezone.mjs
 *
 * Independente do TZ do host (simula instantes UTC explícitos).
 */
import {
  CAMPAIGN_TIME_ZONE,
  campaignMinutesSinceMidnight,
  getCampaignScheduleStart,
  getCampaignZonedParts,
  isWithinSendWindow,
  nextAllowedSendAt,
  shouldPauseUntilNextDay,
} from "../src/lib/campaign-send-policy.ts";
import {
  evaluateCampaignSkipReason,
  getScheduleStart,
  isCampaignOutsideSendWindow,
  makeMultiSimCampaign,
  simulateMultiCampaignWorkerTick,
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

assert("CAMPAIGN_TIME_ZONE", CAMPAIGN_TIME_ZONE === "America/Sao_Paulo");

const WINDOW_START = "09:00";
const WINDOW_END = "18:00";

/** Matriz obrigatória (janela 09:00–18:00 SP; fim exclusivo). */
const matrix = [
  { utc: "2026-08-12T09:00:00.000Z", brt: "06:00", expect: false },
  { utc: "2026-08-12T11:59:00.000Z", brt: "08:59", expect: false },
  { utc: "2026-08-12T12:00:00.000Z", brt: "09:00", expect: true },
  { utc: "2026-08-12T20:59:00.000Z", brt: "17:59", expect: true },
  { utc: "2026-08-12T21:00:00.000Z", brt: "18:00", expect: false },
  { utc: "2026-08-12T21:01:00.000Z", brt: "18:01", expect: false },
];

for (const row of matrix) {
  const now = new Date(row.utc);
  const parts = getCampaignZonedParts(now);
  const brt = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  assert(`zoned ${row.utc} → ${row.brt}`, brt === row.brt);
  assert(
    `within ${row.brt} → ${row.expect ? "PERMITIR" : "BLOQUEAR"}`,
    isWithinSendWindow(now, WINDOW_START, WINDOW_END) === row.expect,
  );
  assert(
    `outside helper ${row.brt}`,
    isCampaignOutsideSendWindow(now, {
      scheduleDate: null,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    }) === !row.expect,
  );
  assert(
    `pauseUntilNextDay ${row.brt}`,
    shouldPauseUntilNextDay(now, WINDOW_END) === (campaignMinutesSinceMidnight(now) >= 18 * 60),
  );
}

// Janela atravessando meia-noite: 22:00–06:00 SP
{
  const insideLate = new Date("2026-08-12T02:00:00.000Z"); // 23:00 SP
  const insideEarly = new Date("2026-08-12T07:00:00.000Z"); // 04:00 SP
  const outside = new Date("2026-08-12T15:00:00.000Z"); // 12:00 SP
  assert("overnight 23:00 within", isWithinSendWindow(insideLate, "22:00", "06:00") === true);
  assert("overnight 04:00 within", isWithinSendWindow(insideEarly, "22:00", "06:00") === true);
  assert("overnight 12:00 outside", isWithinSendWindow(outside, "22:00", "06:00") === false);
}

// schedule_date + window_start interpretados em SP
{
  const start = getScheduleStart("2026-08-12", "09:00");
  const start2 = getCampaignScheduleStart("2026-08-12", "09:00");
  assert("getScheduleStart delegates", start?.getTime() === start2?.getTime());
  assert("schedule start UTC ms", start?.toISOString() === "2026-08-12T12:00:00.000Z");

  const before = new Date("2026-08-12T11:59:00.000Z"); // 08:59 SP same day
  assert("before scheduleStart", before < start);

  const skip = evaluateCampaignSkipReason(
    {
      status: "scheduled",
      scheduleDate: "2026-08-12",
      windowStart: "09:00",
      windowEnd: "18:00",
      pendingCount: 1,
      processingCount: 0,
    },
    before,
  );
  assert("skip before_schedule at 08:59 on schedule day", skip === "before_schedule");

  const atOpen = new Date("2026-08-12T12:00:00.000Z");
  const skipOpen = evaluateCampaignSkipReason(
    {
      status: "scheduled",
      scheduleDate: "2026-08-12",
      windowStart: "09:00",
      windowEnd: "18:00",
      pendingCount: 1,
      processingCount: 0,
    },
    atOpen,
  );
  assert("no skip at 09:00 schedule day", skipOpen === null);
}

// nextAllowedSendAt
{
  const beforeOpen = new Date("2026-08-12T11:00:00.000Z"); // 08:00 SP
  const next = nextAllowedSendAt(beforeOpen, null, "09:00", "18:00");
  assert("nextAllowed before open → 09:00Z+3", next.toISOString() === "2026-08-12T12:00:00.000Z");

  const afterClose = new Date("2026-08-12T21:30:00.000Z"); // 18:30 SP
  const nextDay = nextAllowedSendAt(afterClose, null, "09:00", "18:00");
  assert("nextAllowed after close → next day 09:00 SP", nextDay.toISOString() === "2026-08-13T12:00:00.000Z");

  const withSchedule = nextAllowedSendAt(
    new Date("2026-08-10T15:00:00.000Z"),
    "2026-08-12",
    "09:00",
    "18:00",
  );
  assert(
    "nextAllowed respects future schedule_date",
    withSchedule.toISOString() === "2026-08-12T12:00:00.000Z",
  );
}

// running fora da janela → pausa; nenhum claim/envio
// (schedule_date no passado: senão 06:00 no dia agendado cai em before_schedule)
{
  const early = new Date("2026-08-12T09:00:00.000Z"); // 06:00 SP
  const campaigns = [
    makeMultiSimCampaign("A", 3, {
      status: "running",
      order: 0,
      windowStart: "09:00",
      windowEnd: "18:00",
      scheduleDate: "2026-08-01",
    }),
  ];
  const tick = simulateMultiCampaignWorkerTick(campaigns, { now: early, messagePauseMs: 50 });
  assert("06:00 tick action paused", tick.action === "paused");
  assert("06:00 campaign paused status", campaigns[0].status === "paused");
  assert(
    "06:00 no contacts claimed/sent",
    campaigns[0].contacts.every((c) => c.status === "pending"),
  );

  const skip = evaluateCampaignSkipReason(
    {
      status: "running",
      scheduleDate: "2026-08-01",
      windowStart: "09:00",
      windowEnd: "18:00",
      pendingCount: 3,
      processingCount: 0,
    },
    early,
  );
  assert("06:00 skip outside_window", skip === "outside_window");
}

// Dentro da janela → envia
{
  const open = new Date("2026-08-12T12:00:00.000Z"); // 09:00 SP
  const campaigns = [
    makeMultiSimCampaign("A", 1, {
      status: "running",
      order: 0,
      windowStart: "09:00",
      windowEnd: "18:00",
      scheduleDate: "2026-08-12",
    }),
  ];
  const tick = simulateMultiCampaignWorkerTick(campaigns, { now: open, messagePauseMs: 50 });
  assert("09:00 tick sent", tick.action === "sent" && tick.campaignId === "A");
  assert("09:00 one contact sent", campaigns[0].contacts.filter((c) => c.status === "sent").length === 1);
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll campaign send-window timezone tests passed");
